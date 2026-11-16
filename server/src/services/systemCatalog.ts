import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join, basename, extname } from 'path';
import { DATA_DIR } from './dataDir.js';
import { writeJsonAtomic } from './atomicJson.js';
import * as graphify from './graphifyAdapter.js';
import * as designKnowledge from './designKnowledge.js';
import * as taskStore from './taskStore.js';

const run = promisify(execFile);

/**
 * System catalog: "Projeto → Sistemas → Sistema".
 *
 * A system is a semantic entity of the game (e.g. "Humus"), not a folder, a class, a DK record or a
 * Graphify community. What is persisted is ONLY what cannot be recovered from the sources:
 *   - the stable id and name,
 *   - the responsibility text and who wrote it (`origin`),
 *   - the human classification (`status`) and its provenance,
 *   - the anchors that say what the system is about (terms, files, DK decision ids),
 *   - a snapshot of the last resolved members, so a reference that disappears is flagged, not forgotten.
 * Members, symbols, relations, decisions, tasks and the Git revision are derived on demand from their own
 * sources (git, Graphify, dk.py, taskStore). Nothing here watches, polls or re-indexes.
 *
 * Authority: facts come from `git` / Graphify EXTRACTED edges / DK; groupings and INFERRED relations are
 * hypotheses; `confirmed` is a person's decision. An agent can only propose.
 */

export type Origin = 'discovery' | 'agent' | 'user';
export type Status = 'proposed' | 'confirmed' | 'dismissed' | 'merged';

export interface Anchors { terms: string[]; files: string[]; decisions: string[] }
interface Suggestion { at: string; origin: Origin; summary?: string; anchors: Anchors }
interface Vanished { key: string; since: string }

export interface StoredSystem {
  id: string;
  name: string;
  summary: string;
  responsibilities: string[];
  status: Status;
  origin: Origin;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  confirmedVia?: 'ui-request';
  mergedInto?: string;
  mergedFrom?: string[];
  anchors: Anchors;
  related: string[];                 // declared related system ids
  suggestions?: Suggestion[];        // proposals made against a confirmed system (never applied silently)
  seen?: { at: string; keys: string[] };
  vanished?: Vanished[];
}
interface Store { version: 1; systems: StoredSystem[] }

// ---- persistence --------------------------------------------------------------------------------

const safe = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');
const storePath = (projectId: string) => join(DATA_DIR, 'systems', `${safe(projectId)}.json`);
const storeCache = new Map<string, { store: Store; mtime: number }>();
let chain: Promise<unknown> = Promise.resolve();
const locked = <T,>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
};

async function readStore(projectId: string): Promise<Store> {
  // mtime check: another process (a second server, a script) may have written the file
  let mtime = 0;
  try { mtime = (await fs.stat(storePath(projectId))).mtimeMs; } catch { /* first use */ }
  const hit = storeCache.get(projectId);
  if (hit && hit.mtime === mtime) return hit.store;
  let store: Store = { version: 1, systems: [] };
  try {
    const data = JSON.parse(await fs.readFile(storePath(projectId), 'utf-8'));
    if (Array.isArray(data.systems)) store = { version: 1, systems: data.systems };
  } catch { /* first use */ }
  storeCache.set(projectId, { store, mtime });
  return store;
}

async function mutate<T>(projectId: string, fn: (s: Store) => T): Promise<T> {
  return locked(async () => {
    const store = await readStore(projectId);
    const out = fn(store);
    await fs.mkdir(join(DATA_DIR, 'systems'), { recursive: true });
    await writeJsonAtomic(storePath(projectId), store);
    try { storeCache.set(projectId, { store, mtime: (await fs.stat(storePath(projectId))).mtimeMs }); } catch { /* ignore */ }
    viewCache.clear();
    return out;
  });
}

export const resetCaches = () => { storeCache.clear(); viewCache.clear(); memoCache.clear(); };

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const uniq = (xs: string[]) => [...new Set(xs.map(x => x.trim()).filter(Boolean))];
const now = () => new Date().toISOString();
const posix = (p: string) => p.replace(/\\/g, '/');

// ---- git / file helpers -------------------------------------------------------------------------

const GODOT_GLOBS = ['*.gd', '*.tscn', '*.tres'];
const GODOT_RE = /\.(gd|tscn|tres)$/i;

async function git(root: string, args: string[], allowFail = false): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', root, ...args], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
    return stdout;
  } catch (e: any) {
    if (allowFail && typeof e.stdout === 'string') return e.stdout;
    return null;
  }
}

const skipped = (p: string) => p.split('/').some(seg => graphify.STAGE_SKIP_DIRS.has(seg));

async function walkFs(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) { if (!graphify.STAGE_SKIP_DIRS.has(e.name)) await walk(abs); }
      else if (GODOT_RE.test(e.name)) out.push(posix(abs.slice(root.length + 1)));
    }
  };
  await walk(root);
  return out;
}

/** Godot files of a checkout, uncommitted and untracked ones included. */
async function listFiles(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '-co', '--exclude-standard', '--', ...GODOT_GLOBS]);
  const files = out === null ? await walkFs(root) : out.split(/\r?\n/).filter(Boolean).map(posix);
  // tracked-but-deleted files are still in the index: they are not in this checkout
  const deleted = new Set(((await git(root, ['ls-files', '-d', '--', ...GODOT_GLOBS])) ?? '').split(/\r?\n/).filter(Boolean).map(posix));
  return [...new Set(files)].filter(f => !skipped(f) && !deleted.has(f));
}

/** Per-file count of lines mentioning any term (case-insensitive substring). */
async function mentions(root: string, files: string[], terms: string[]): Promise<Map<string, number>> {
  const res = new Map<string, number>();
  if (!terms.length) return res;
  const out = await git(root, ['grep', '-i', '-c', '-F', '-I', '--untracked', ...terms.flatMap(t => ['-e', t]), '--', ...GODOT_GLOBS], true);
  if (out !== null && (out.length > 0 || (await git(root, ['rev-parse', '--git-dir'])) !== null)) {
    for (const line of out.split(/\r?\n/)) {
      const m = /^(.*):(\d+)$/.exec(line);
      if (m && !skipped(posix(m[1]))) res.set(posix(m[1]), Number(m[2]));
    }
    return res;
  }
  // not a git checkout: read the files
  const needles = terms.map(t => t.toLowerCase());
  await Promise.all(files.map(async f => {
    try {
      const text = (await fs.readFile(join(root, f), 'utf8')).toLowerCase();
      const n = text.split(/\r?\n/).filter(l => needles.some(t => l.includes(t))).length;
      if (n) res.set(f, n);
    } catch { /* gone */ }
  }));
  return res;
}

export interface CheckoutInfo {
  root: string; isCanonical: boolean; branch?: string; head?: string;
  uncommitted: number; integration: string;
}

async function checkoutInfo(project: { path: string }, root: string): Promise<{ info: CheckoutInfo; dirtyFiles: Set<string> }> {
  const isCanonical = designKnowledge.norm(root) === designKnowledge.norm(project.path);
  const [branch, head, status] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), git(root, ['rev-parse', '--short', 'HEAD']), git(root, ['status', '--porcelain']),
  ]);
  const dirtyFiles = new Set<string>();
  for (const l of (status ?? '').split(/\r?\n/).filter(Boolean)) {
    const p = l.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '');
    dirtyFiles.add(posix(p));
  }
  let integration = 'unknown';
  if (head === null) integration = 'not a git checkout';
  else if (isCanonical) integration = 'integrated checkout';
  else {
    const canon = (await git(project.path, ['rev-parse', 'HEAD']))?.trim();
    if (canon) {
      const ancestor = (await git(root, ['merge-base', '--is-ancestor', 'HEAD', canon])) !== null;
      if (ancestor) integration = 'HEAD is contained in the integrated checkout';
      else {
        const ahead = (await git(root, ['rev-list', '--count', `${canon}..HEAD`]))?.trim();
        integration = `NOT integrated: ${ahead ?? '?'} commit(s) not in the integrated checkout`;
      }
    }
  }
  return { info: { root, isCanonical, branch: branch?.trim(), head: head?.trim(), uncommitted: dirtyFiles.size, integration }, dirtyFiles };
}

// ---- derived view -------------------------------------------------------------------------------

export type Why = { kind: 'anchor' | 'dk' | 'name' | 'mention'; detail: string };
export interface Member {
  path: string; role: 'code' | 'scene' | 'resource' | 'test';
  why: Why[]; score: number;
  confidence: 'declared' | 'extracted';       // declared = a person/agent/DK named it; extracted = found by name or text
  uncommitted: boolean; changedSinceAnalysis: boolean;
  state: 'ok' | 'moved';
  movedFrom?: string;
  symbols: { id: string; label: string; kind: string; line: number }[];
}
export interface Neighbor { path: string; edges: number; confidence: string; relation: string; via: string }

const roleOf = (p: string): Member['role'] =>
  /(^|\/)(tests?|test_[^/]*|[^/]*_test)(\/|\.|$)/i.test(p) || /(^|\/)tests?\//i.test(p) ? 'test'
    : p.endsWith('.tscn') ? 'scene' : p.endsWith('.tres') ? 'resource' : 'code';

const nameMatches = (path: string, terms: string[]) => {
  const low = posix(path).toLowerCase().replace(/[_\-]/g, '');
  return terms.find(t => low.includes(t.toLowerCase().replace(/[\s_\-]/g, '')));
};

const fileIndex = new WeakMap<graphify.Graph, Map<string, graphify.GNode[]>>();
function nodesByFile(g: graphify.Graph) {
  let idx = fileIndex.get(g);
  if (!idx) {
    idx = new Map();
    for (const n of g.nodes.values()) if (n.file) (idx.get(n.file) ?? idx.set(n.file, []).get(n.file)!).push(n);
    fileIndex.set(g, idx);
  }
  return idx;
}

export interface DecisionView {
  id: string; title: string; claim: string;
  decisionState: string; approval: any; evidenceStatus: string; implementation: string;
  conflictsWith: string[]; relevance: 'declared' | 'term' | 'touches-member';
  evidence: { type: string; ref: string; freshness?: string; detail?: string; note?: string; excerpt: string[] }[];
  files: string[]; tests: string[];
}

export interface SystemView {
  id: string; name: string; summary: string; responsibilities: string[];
  status: Status; origin: Origin; confirmedAt?: string; confirmedVia?: string;
  anchors: Anchors; mergedInto?: string; mergedFrom?: string[]; suggestions: Suggestion[];
  checkout: CheckoutInfo;
  members: Member[]; weakerMembers: number;
  neighbors: Neighbor[];
  design: { available: boolean; reason?: string; decisions: DecisionView[]; conflicts: [string, string][] };
  tasks: { id: string; number?: number; title: string; status: string; matchedBy: string }[];
  related: { id: string; name: string; shared: string[]; declared: boolean }[];
  maintenance: {
    graph: { built: boolean; builtAt?: number; describesCheckout: string; installed?: boolean };
    changedMembers: string[]; needsReanalysis: boolean;
    vanished: Vanished[]; unresolvedAnchors: { path: string; state: 'gone' }[];
    graphAgainstCheckout: string;
  };
  limitations: string[];
}

const viewCache = new Map<string, { at: number; value: SystemView }>();
const VIEW_TTL = 4000;

/** Short-lived memo with in-flight dedupe: systems of one checkout share a single git listing/status. */
const memoCache = new Map<string, { at: number; p: Promise<unknown> }>();
function memo<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = memoCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p as Promise<T>;
  const p = fn();
  memoCache.set(key, { at: Date.now(), p });
  p.catch(() => memoCache.delete(key));
  return p;
}
const MEMBER_CAP = 60;

interface Project { id: string; path: string; name?: string }

export async function listStored(projectId: string, includeClosed = false) {
  const s = await readStore(projectId);
  return s.systems.filter(x => includeClosed || (x.status !== 'dismissed' && x.status !== 'merged'));
}

export async function getStored(projectId: string, id: string) {
  const s = await readStore(projectId);
  return s.systems.find(x => x.id === id) ?? null;
}

/** Everything about one system, derived from the examined checkout. */
export async function resolveSystem(project: Project, id: string, worktree?: string): Promise<SystemView | { error: string }> {
  const sys = await getStored(project.id, id);
  if (!sys) return { error: `System ${id} not found` };
  const root = await designKnowledge.resolveRoot(project, worktree);
  if (typeof root !== 'string') return { error: root.error };
  const key = `${project.id}|${root}|${id}`;
  const hit = viewCache.get(key);
  if (hit && Date.now() - hit.at < VIEW_TTL) return hit.value;

  const [{ info, dirtyFiles }, files] = await Promise.all([
    memo(`info|${root}`, VIEW_TTL, () => checkoutInfo(project, root)),
    memo(`files|${root}`, VIEW_TTL, () => listFiles(root)),
  ]);
  const fileSet = new Set(files);
  const terms = sys.anchors.terms;
  const g = await graphify.loadGraph(project.id).catch(() => null);
  const startedAt = g ? await graphify.buildStartedAt(project.id) : null;

  // ---- design decisions (DK) ----
  const dkRes: any[] = [];
  let dkAvailable = false, dkReason: string | undefined;
  for (const q of uniq([...terms, ...sys.anchors.decisions])) {
    const r: any = await designKnowledge.contextForQuery(project, q, worktree);
    if (r.available) { dkAvailable = true; dkRes.push(...(r.decisions ?? [])); }
    else dkReason = r.reason;
  }
  const byId = new Map<string, any>();
  for (const d of dkRes) byId.set(d.id, d);

  // ---- members ----
  const cand = new Map<string, { why: Why[]; score: number; declared: boolean; moved?: string }>();
  const add = (path: string, why: Why, score: number, declared: boolean, movedFrom?: string) => {
    const e = cand.get(path) ?? { why: [], score: 0, declared: false };
    e.why.push(why); e.score += score; e.declared = e.declared || declared;
    if (movedFrom) e.moved = movedFrom;
    cand.set(path, e);
  };
  const unresolved: { path: string; state: 'gone' }[] = [];
  for (const a of sys.anchors.files) {
    const p = posix(a);
    if (fileSet.has(p)) add(p, { kind: 'anchor', detail: 'named by the system' }, 100, true);
    else {
      const moved = files.filter(f => basename(f) === basename(p));
      if (moved.length === 1) add(moved[0], { kind: 'anchor', detail: `named by the system (moved from ${p})` }, 100, true, p);
      else unresolved.push({ path: p, state: 'gone' });
    }
  }
  const declaredOrTerm = (d: any) => sys.anchors.decisions.includes(d.id) ||
    terms.some(t => `${d.title} ${d.claim} ${(d.scope ?? []).join(' ')}`.toLowerCase().includes(t.toLowerCase()));
  for (const d of byId.values()) if (declaredOrTerm(d)) {
    for (const f of [...(d.files ?? []), ...(d.tests ?? [])]) if (fileSet.has(f.path)) add(f.path, { kind: 'dk', detail: `${d.id}${f.role ? ` — ${f.role}` : ''}` }, 60, true);
  }
  for (const f of files) {
    const t = nameMatches(f, terms);
    if (t) add(f, { kind: 'name', detail: `path contains "${t}"` }, 40, false);
  }
  const counts = await mentions(root, files, terms);
  for (const [f, n] of counts) {
    if (!fileSet.has(f)) continue;
    if (n >= 3 || cand.has(f)) add(f, { kind: 'mention', detail: `${n} line${n > 1 ? 's' : ''} mention the system's terms` }, Math.min(n, 30), false);
  }

  // decisions that merely touch a strong member
  const strong = new Set([...cand].filter(([, v]) => v.declared || v.why.some(w => w.kind === 'name')).map(([p]) => p));
  const decisions: DecisionView[] = [];
  for (const d of byId.values()) {
    const direct = declaredOrTerm(d);
    const touches = !direct && (d.files ?? []).some((f: any) => strong.has(f.path));
    if (!direct && !touches) continue;
    decisions.push({
      id: d.id, title: d.title, claim: d.claim, decisionState: d.decision_state, approval: d.approval,
      evidenceStatus: d.evidence_status, implementation: d.implementation, conflictsWith: d.conflicts_with ?? [],
      relevance: sys.anchors.decisions.includes(d.id) ? 'declared' : direct ? 'term' : 'touches-member',
      evidence: (d.evidence ?? []).filter((e: any) => !e.candidate_only).map((e: any) => ({
        type: e.type, ref: e.path ? `${e.path} (was ${e.ref})` : e.ref, freshness: e.freshness, detail: e.detail, note: e.note,
        excerpt: (e.excerpt ?? []).filter((x: any) => String(x.text).trim()).slice(0, 4).map((x: any) => `L${x.line}: ${x.text}`),
      })),
      files: (d.files ?? []).map((f: any) => f.path), tests: (d.tests ?? []).map((t: any) => t.path),
    });
  }
  const ids = new Set(decisions.map(d => d.id));
  const conflicts: [string, string][] = [];
  for (const d of decisions) for (const o of d.conflictsWith) if (ids.has(o) && d.id < o) conflicts.push([d.id, o]);

  // ---- rank + symbols ----
  const idx = g ? nodesByFile(g) : null;
  const ranked = [...cand].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  const members: Member[] = [];
  for (const [path, v] of ranked.slice(0, MEMBER_CAP)) {
    let changed = false;
    if (startedAt && info.isCanonical) { try { changed = (await fs.stat(join(root, path))).mtimeMs > startedAt; } catch { /* gone */ } }
    const syms = (idx?.get(path) ?? []).filter(n => n.kind === 'func' || n.kind === 'signal' || n.kind === 'class');
    const hit = (s: graphify.GNode) => terms.some(t => s.label.toLowerCase().includes(t.toLowerCase()));
    members.push({
      path, role: roleOf(path), why: v.why, score: v.score,
      confidence: v.declared ? 'declared' : 'extracted',
      uncommitted: dirtyFiles.has(path), changedSinceAnalysis: changed,
      state: v.moved ? 'moved' : 'ok', movedFrom: v.moved,
      symbols: [...syms].sort((a, b) => Number(hit(b)) - Number(hit(a)) || a.line - b.line).slice(0, 14)
        .map(s => ({ id: s.id, label: s.label, kind: s.kind, line: s.line })),
    });
  }

  // ---- possible participants: Graphify neighbours of the strong members, never merged into membership ----
  const neighbors: Neighbor[] = [];
  if (g && idx) {
    const memberPaths = new Set(members.map(m => m.path));
    const acc = new Map<string, Neighbor>();
    for (const m of members.filter(x => x.role === 'code' && (x.confidence === 'declared' || x.why.some(w => w.kind === 'name')))) {
      for (const n of idx.get(m.path) ?? []) {
        for (const side of [g.out.get(n.id) ?? [], g.inn.get(n.id) ?? []]) {
          for (const e of side) {
            if (e.relation === 'contains' || e.relation === 'method') continue;
            const other = g.nodes.get(e.from === n.id ? e.to : e.from);
            if (!other?.file || memberPaths.has(other.file) || skipped(other.file) || !fileSet.has(other.file)) continue;
            const cur = acc.get(other.file);
            const conf = e.confidence === 'EXTRACTED' || cur?.confidence === 'EXTRACTED' ? 'EXTRACTED' : String(e.confidence);
            acc.set(other.file, { path: other.file, edges: (cur?.edges ?? 0) + e.count, confidence: conf, relation: cur?.relation ?? e.relation, via: cur?.via ?? m.path });
          }
        }
      }
    }
    neighbors.push(...[...acc.values()].sort((a, b) => Number(b.confidence === 'EXTRACTED') - Number(a.confidence === 'EXTRACTED') || b.edges - a.edges).slice(0, 14));
  }

  // ---- tasks: only a verifiable link (a member file named in the task text) ----
  const tasks: SystemView['tasks'] = [];
  try {
    const stems = members.filter(m => m.role === 'code').map(m => ({ p: m.path, b: basename(m.path) }));
    const list = (await taskStore.getTasks(project.id)).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    for (const t of list) {
      const text = `${t.title}\n${t.description}\n${t.prompt ?? ''}\n${t.resolution ?? ''}`;
      const hitFile = stems.find(s => text.includes(s.p) || text.includes(s.b));
      if (hitFile) tasks.push({ id: t.id, number: (t as any).number, title: t.title, status: t.status, matchedBy: `mentions ${hitFile.b}` });
      if (tasks.length >= 12) break;
    }
  } catch { /* tasks are optional */ }

  // ---- related systems: shared members, plus declared ----
  const related: SystemView['related'] = [];
  const mine = new Set(members.map(m => m.path));
  for (const o of await listStored(project.id)) {
    if (o.id === id) continue;
    const otherFiles = new Set(o.anchors.files.map(posix));
    const shared = [...mine].filter(p => otherFiles.has(p) || (o.anchors.terms.length > 0 && !!nameMatches(p, o.anchors.terms)));
    const declared = sys.related.includes(o.id) || o.related.includes(id);
    if (shared.length || declared) related.push({ id: o.id, name: o.name, shared: shared.slice(0, 6), declared });
  }

  // ---- maintenance: vanished references (canonical checkout only, so a worktree never rewrites history) ----
  const keys = new Set<string>();
  for (const m of members) { keys.add(`file:${m.path}`); if (g) for (const s of m.symbols) keys.add(`sym:${m.path}#${s.label}`); }
  let vanished = sys.vanished ?? [];
  if (info.isCanonical && files.length > 0) {
    const prev = sys.seen?.keys ?? [];
    const carry = g ? [] : prev.filter(k => k.startsWith('sym:'));
    const nextKeys = [...keys, ...carry];
    const gone = prev.filter(k => !nextKeys.includes(k) && !(k.startsWith('sym:') && !g));
    const merged = new Map(vanished.filter(v => !keys.has(v.key)).map(v => [v.key, v]));
    for (const k of gone) if (!merged.has(k)) merged.set(k, { key: k, since: now() });
    const nextVanished = [...merged.values()];
    const changedSeen = nextKeys.length !== prev.length || nextKeys.some(k => !prev.includes(k)) || nextVanished.length !== vanished.length;
    vanished = nextVanished;
    if (changedSeen && sys.status !== 'dismissed') {
      await mutate(project.id, s => {
        const t = s.systems.find(x => x.id === id);
        if (t) { t.seen = { at: now(), keys: nextKeys }; t.vanished = nextVanished; }
      });
    }
  }

  const changedMembers = members.filter(m => m.changedSinceAnalysis).map(m => m.path);
  const limitations: string[] = [];
  if (!g) limitations.push('Graphify has not analyzed this project: no symbols or call relations are shown.');
  else {
    if (!info.isCanonical) limitations.push('The Graphify graph describes the integrated checkout, not this worktree: symbols and relations may not match the files examined here. Membership by name/text and Git state are read from this worktree.');
    if (changedMembers.length) limitations.push(`${changedMembers.length} member file(s) changed after the last analysis; symbols and relations for them may be out of date.`);
    limitations.push('INFERRED relations are name-based guesses; calls through autoloads, instances or signal connections across files are often missing, so absence in the graph is not proof of absence.');
  }
  if (!dkAvailable) limitations.push(`Design decisions are not indexed for this project${dkReason ? ` (${dkReason})` : ''}.`);
  if (decisions.length) limitations.push('Test references are static: the catalog does not run tests, so no test result is shown.');
  if (weaker(cand, members.length)) limitations.push(`${weaker(cand, members.length)} weaker member(s) not listed.`);
  if (sys.status === 'proposed') limitations.push('This system is a proposal: grouping and responsibility text have not been confirmed by a person.');
  if (unresolved.length) limitations.push(`${unresolved.length} file anchor(s) no longer exist in this checkout.`);

  const value: SystemView = {
    id: sys.id, name: sys.name, summary: sys.summary, responsibilities: sys.responsibilities,
    status: sys.status, origin: sys.origin, confirmedAt: sys.confirmedAt, confirmedVia: sys.confirmedVia,
    anchors: sys.anchors, mergedInto: sys.mergedInto, mergedFrom: sys.mergedFrom, suggestions: sys.suggestions ?? [],
    checkout: info, members, weakerMembers: weaker(cand, members.length), neighbors,
    design: { available: dkAvailable, reason: dkAvailable ? undefined : dkReason, decisions, conflicts },
    tasks, related,
    maintenance: {
      graph: { built: !!g, builtAt: g?.builtAt, describesCheckout: 'integrated checkout', installed: !!graphify.graphifyPython() },
      changedMembers, needsReanalysis: changedMembers.length > 0, vanished, unresolvedAnchors: unresolved,
      graphAgainstCheckout: info.isCanonical ? 'same checkout' : 'different checkout (worktree)',
    },
    limitations,
  };
  viewCache.set(key, { at: Date.now(), value });
  return value;
}
const weaker = (cand: Map<string, unknown>, shown: number) => Math.max(0, cand.size - shown);

export interface SystemSummary {
  id: string; name: string; summary: string; status: Status; origin: Origin;
  files: number; decisions: number; conflicts: number; flags: string[];
}

/** Catalog rows. Resolves each system (cached) so counts are real, not stored. */
export async function catalog(project: Project, worktree?: string) {
  const stored = await listStored(project.id);
  const rows: SystemSummary[] = [];
  const views: (SystemView | { error: string })[] = new Array(stored.length);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < stored.length) { const i = next++; views[i] = await resolveSystem(project, stored[i].id, worktree); }
  }));
  for (let i = 0; i < stored.length; i++) {
    const s = stored[i]; const v = views[i];
    if ('error' in v) continue;
    const flags: string[] = [];
    if (v.maintenance.needsReanalysis) flags.push('stale graph');
    if (v.maintenance.vanished.length) flags.push(`${v.maintenance.vanished.length} vanished`);
    if (v.design.conflicts.length) flags.push('conflict');
    if (v.maintenance.unresolvedAnchors.length) flags.push('missing files');
    rows.push({
      id: s.id, name: s.name, summary: s.summary, status: s.status, origin: s.origin,
      files: v.members.length + v.weakerMembers, decisions: v.design.decisions.length, conflicts: v.design.conflicts.length, flags,
    });
  }
  const root = await designKnowledge.resolveRoot(project, worktree);
  const checkout = typeof root === "string" ? (await memo(`info|${root}`, VIEW_TTL, () => checkoutInfo(project, root))).info : null;
  const order = { confirmed: 0, proposed: 1, dismissed: 2, merged: 3 } as const;
  rows.sort((a, b) => order[a.status] - order[b.status] || b.files - a.files);
  return { systems: rows, checkout, dismissed: (await listStored(project.id, true)).filter(s => s.status === 'dismissed').length };
}

// ---- discovery ----------------------------------------------------------------------------------

// Words that name a *kind of file* or a layer, not a topic of the game. Language-level, not project-level.
const STOP = new Set(['test', 'tests', 'smoke', 'capture', 'main', 'base', 'util', 'utils', 'helper', 'helpers', 'manager', 'params',
  'rules', 'config', 'configs', 'data', 'scene', 'screen', 'panel', 'node', 'item', 'items', 'view', 'controller', 'coordinator',
  'adapter', 'observer', 'state', 'game', 'resource', 'resources', 'script', 'handler', 'service', 'builder', 'factory', 'presenter',
  'visual', 'visuals', 'level', 'type', 'types', 'default', 'settings', 'system', 'systems', 'example', 'profile', 'fixture',
  'fixtures', 'report', 'label', 'text', 'icon', 'icons', 'brief', 'world', 'catalog', 'definition', 'stats', 'bridge', 'feedback',
  'runtime', 'common', 'shared', 'extra', 'template', 'proto', 'prototype', 'debug', 'tool', 'tools', 'player', 'input', 'ui']);

const tokens = (path: string) =>
  (basename(path, extname(path)).match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []).map(t => t.toLowerCase()).filter(t => t.length >= 4 && !STOP.has(t));

const titleCase = (t: string) => t[0].toUpperCase() + t.slice(1);

export interface Candidate { term: string; files: string[] }

/** Topic words shared by several files' names: pure structure, no project knowledge. */
export async function candidateTerms(root: string): Promise<Candidate[]> {
  const files = await listFiles(root);
  const byToken = new Map<string, Set<string>>();
  for (const f of files) for (const t of new Set(tokens(f))) (byToken.get(t) ?? byToken.set(t, new Set()).get(t)!).add(f);
  const cands = [...byToken].map(([term, set]) => ({ term, files: [...set] }))
    .filter(c => c.files.length >= 3 && c.files.some(f => roleOf(f) !== 'test'))
    .sort((a, b) => b.files.length - a.files.length);
  const kept: Candidate[] = [];
  for (const c of cands) {
    const dupe = kept.some(k => c.files.filter(f => k.files.includes(f)).length >= 0.8 * c.files.length);
    if (!dupe) kept.push(c);
    if (kept.length >= 20) break;
  }
  return kept;
}

/** Adds candidates as `proposed`. Idempotent: an existing system (any status) that owns the term is left alone. */
export async function discover(project: Project, worktree?: string) {
  const root = await designKnowledge.resolveRoot(project, worktree);
  if (typeof root !== 'string') return { error: root.error };
  const cands = await candidateTerms(root);
  return mutate(project.id, store => {
    let added = 0;
    for (const c of cands) {
      const owned = store.systems.some(s => s.anchors.terms.some(t => t.toLowerCase() === c.term) || s.id === `sys-${c.term}`);
      if (owned) continue;
      store.systems.push({
        id: `sys-${c.term}`, name: titleCase(c.term), status: 'proposed', origin: 'discovery',
        summary: `Candidate: ${c.files.length} files whose names share "${c.term}". Responsibility not described yet.`,
        responsibilities: [], createdAt: now(), updatedAt: now(), anchors: { terms: [c.term], files: [], decisions: [] }, related: [],
      });
      added++;
    }
    return { added, candidates: cands.length };
  });
}

// ---- proposals and review -----------------------------------------------------------------------

export interface ProposalInput {
  name: string; summary?: string; responsibilities?: string[];
  terms?: string[]; files?: string[]; decisions?: string[]; related?: string[];
}

/**
 * Agents and discovery land here. A confirmed system is never rewritten by a proposal: the proposal is kept
 * as a suggestion for a person to look at. A system that already owns one of the terms is extended instead
 * of duplicated.
 */
export function propose(projectId: string, input: ProposalInput, origin: Origin) {
  return mutate(projectId, store => {
    const terms = uniq(input.terms ?? []), files = uniq((input.files ?? []).map(posix)), decisions = uniq(input.decisions ?? []);
    const wanted = slug(input.name);
    const existing = store.systems.find(s => s.status !== 'dismissed' && s.status !== 'merged' &&
      (s.id === `sys-${wanted}` || s.anchors.terms.some(t => terms.some(x => x.toLowerCase() === t.toLowerCase()))));
    if (existing) {
      if (existing.status === 'confirmed' && origin !== 'user') {
        (existing.suggestions ??= []).push({ at: now(), origin, summary: input.summary, anchors: { terms, files, decisions } });
        existing.updatedAt = now();
        return { id: existing.id, outcome: 'suggestion-recorded' as const };
      }
      existing.anchors = { terms: uniq([...existing.anchors.terms, ...terms]), files: uniq([...existing.anchors.files, ...files]), decisions: uniq([...existing.anchors.decisions, ...decisions]) };
      if (input.summary) existing.summary = input.summary;
      if (input.responsibilities?.length) existing.responsibilities = input.responsibilities;
      existing.related = uniq([...existing.related, ...(input.related ?? [])]);
      if (existing.origin === 'discovery' && origin !== 'discovery') existing.origin = origin;
      existing.updatedAt = now();
      return { id: existing.id, outcome: 'extended' as const };
    }
    const id = `sys-${wanted || 'system'}`;
    store.systems.push({
      id: store.systems.some(s => s.id === id) ? `${id}-${Date.now().toString(36)}` : id,
      name: input.name.trim(), summary: input.summary ?? '', responsibilities: input.responsibilities ?? [],
      status: 'proposed', origin, createdAt: now(), updatedAt: now(),
      anchors: { terms, files, decisions }, related: uniq(input.related ?? []),
    });
    return { id: store.systems[store.systems.length - 1].id, outcome: 'created' as const };
  });
}

export type Edit = Partial<Pick<StoredSystem, 'name' | 'summary' | 'responsibilities'>> & {
  status?: 'confirmed' | 'proposed' | 'dismissed'; anchors?: Partial<Anchors>; related?: string[]; ackVanished?: boolean; clearSuggestions?: boolean;
};

/** Human review. The route only lets this through from the app's own UI. */
export function review(projectId: string, id: string, edit: Edit) {
  return mutate(projectId, store => {
    const s = store.systems.find(x => x.id === id);
    if (!s) return null;
    if (edit.name !== undefined) s.name = edit.name.trim() || s.name;
    if (edit.summary !== undefined) s.summary = edit.summary;
    if (edit.responsibilities) s.responsibilities = edit.responsibilities.map(x => x.trim()).filter(Boolean);
    if (edit.anchors) s.anchors = {
      terms: uniq(edit.anchors.terms ?? s.anchors.terms), files: uniq((edit.anchors.files ?? s.anchors.files).map(posix)),
      decisions: uniq(edit.anchors.decisions ?? s.anchors.decisions),
    };
    if (edit.related) s.related = uniq(edit.related);
    if (edit.status) {
      s.status = edit.status;
      if (edit.status === 'confirmed') { s.confirmedAt = now(); s.confirmedVia = 'ui-request'; } else delete s.confirmedAt;
    }
    if (edit.ackVanished) s.vanished = [];
    if (edit.clearSuggestions) s.suggestions = [];
    s.updatedAt = now();
    return s;
  });
}

/** Fold `from` into `into`. The old id stays as a redirect so links and agent notes do not break. */
export function merge(projectId: string, into: string, from: string[]) {
  return mutate(projectId, store => {
    const target = store.systems.find(s => s.id === into);
    if (!target) return null;
    for (const id of from) {
      const src = store.systems.find(s => s.id === id && s.id !== into);
      if (!src) continue;
      target.anchors = { terms: uniq([...target.anchors.terms, ...src.anchors.terms]), files: uniq([...target.anchors.files, ...src.anchors.files]), decisions: uniq([...target.anchors.decisions, ...src.anchors.decisions]) };
      target.responsibilities = uniq([...target.responsibilities, ...src.responsibilities]);
      target.mergedFrom = uniq([...(target.mergedFrom ?? []), src.id, ...(src.mergedFrom ?? [])]);
      src.status = 'merged'; src.mergedInto = target.id; src.updatedAt = now();
    }
    target.updatedAt = now();
    return target;
  });
}

/** Take some anchors out of a system into a new proposed one. */
export function split(projectId: string, id: string, input: { name: string; terms?: string[]; files?: string[] }) {
  return mutate(projectId, store => {
    const src = store.systems.find(s => s.id === id);
    if (!src) return null;
    const terms = uniq(input.terms ?? []), files = uniq((input.files ?? []).map(posix));
    src.anchors.terms = src.anchors.terms.filter(t => !terms.includes(t));
    src.anchors.files = src.anchors.files.filter(f => !files.includes(f));
    const base = `sys-${slug(input.name) || 'split'}`;
    const nid = store.systems.some(s => s.id === base) ? `${base}-${Date.now().toString(36)}` : base;
    store.systems.push({
      id: nid, name: input.name.trim(), summary: '', responsibilities: [], status: 'proposed', origin: 'user',
      createdAt: now(), updatedAt: now(), anchors: { terms, files, decisions: [] }, related: [src.id],
    });
    src.updatedAt = now();
    return { id: nid };
  });
}

// ---- agent context ------------------------------------------------------------------------------

/** Compact brief for Claude/Codex: identity, revision, top members, decisions and what is NOT known. */
export function brief(v: SystemView, goal?: string): string {
  const L: string[] = [];
  const c = v.checkout;
  L.push(`# System: ${v.name} (${v.id})`);
  L.push(`Status: ${v.status} (${v.origin}${v.confirmedAt ? `, confirmed ${v.confirmedAt.slice(0, 10)} via this installation` : ''}). ${v.status !== 'confirmed' ? 'The grouping and the text below are NOT confirmed by a person.' : ''}`);
  if (v.summary) L.push(`Responsibility: ${v.summary}`);
  if (v.responsibilities.length) L.push(...v.responsibilities.map(r => `- ${r}`));
  L.push('', `## Checkout examined`, `Root: ${c.root}`, `Branch: ${c.branch ?? '?'}  HEAD: ${c.head ?? '?'}  Uncommitted files: ${c.uncommitted}`,
    `${c.isCanonical ? 'This is the integrated checkout.' : 'This is a WORKTREE, not integrated code.'} ${c.integration}.`);
  L.push('', `## Members (${v.members.length}${v.weakerMembers ? ` of ${v.members.length + v.weakerMembers}` : ''}; most relevant first)`);
  for (const m of v.members.slice(0, 18)) {
    const syms = m.symbols.slice(0, 4).map(s => `${s.label}:${s.line}`).join(', ');
    const flags = [m.confidence, m.uncommitted ? 'uncommitted' : '', m.changedSinceAnalysis ? 'changed since graph' : '', m.state === 'moved' ? `moved from ${m.movedFrom}` : ''].filter(Boolean).join(', ');
    L.push(`- ${m.path} [${m.role}; ${flags}]${syms ? ` — ${syms}` : ''}`);
  }
  if (v.neighbors.length) {
    L.push('', '## Possible participants (Graphify neighbours, NOT members)');
    for (const n of v.neighbors.slice(0, 8)) L.push(`- ${n.path} — ${n.relation} ×${n.edges}, ${n.confidence}${n.confidence !== 'EXTRACTED' ? ' (name-based guess)' : ''}`);
  }
  L.push('', '## Design decisions (DK)');
  if (!v.design.available) L.push(`Not indexed${v.design.reason ? `: ${v.design.reason}` : ''}.`);
  else if (!v.design.decisions.length) L.push('None found for this system.');
  for (const d of v.design.decisions) {
    L.push(`- ${d.id} "${d.title}" — decision: ${d.decisionState}, approval: ${d.approval?.state ?? 'unknown'} (${d.approval?.source ?? 'none'}), evidence: ${d.evidenceStatus}, implementation: ${d.implementation}${d.relevance === 'touches-member' ? ' (touches a member file only)' : ''}`);
    L.push(`  claim: ${d.claim}`);
  }
  for (const [a, b] of v.design.conflicts) L.push(`UNRESOLVED CONFLICT: ${a} vs ${b}. Do not pick a side; ask the owner.`);
  L.push('', '## Limitations');
  L.push(...v.limitations.map(l => `- ${l}`));
  if (v.maintenance.vanished.length) L.push(`- References that disappeared since an earlier resolution: ${v.maintenance.vanished.slice(0, 8).map(x => x.key).join('; ')}`);
  L.push('', `More detail: MCP get_system {projectId, systemId: "${v.id}"}, get_design_context for a file or topic, Graphify Explorer for relations.`);
  if (goal) L.push('', `## Request`, goal);
  return L.join('\n');
}
