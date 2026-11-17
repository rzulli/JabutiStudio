import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join, basename, extname, dirname, relative, isAbsolute } from 'path';
import { randomUUID, createHash } from 'crypto';
import { DATA_DIR } from './dataDir.js';
import { writeJsonAtomic } from './atomicJson.js';
import * as graphify from './graphifyAdapter.js';
import * as designKnowledge from './designKnowledge.js';
import * as designCore from './designCore.js';
import * as designDecisions from './designDecisions.js';
import * as taskStore from './taskStore.js';
import * as sem from './systemSemantics.js';
import { portableSchema, portableSystem } from './systemPortable.js';

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
interface Suggestion { at: string; origin: Origin; summary?: string; anchors: Anchors; areas?: number; relations?: number; payload?: { areas: StoredArea[]; relations: StoredRelation[] } }

/**
 * A responsibility inside a system (subsystem / mechanic / entity). Persisted only because it is a semantic
 * judgement; its files, symbols and verification state are derived on every read. `anchors.files` entries may be
 * `path` or `path#symbol`. Evidence = a pointer plus text the code must still contain (see verifyEvidence).
 */
export type AreaKind = 'subsystem' | 'mechanic' | 'entity';
export interface StoredArea {
  id: string; name: string; kind: AreaKind; summary: string;
  status: 'proposed' | 'confirmed'; origin: Origin;
  anchors: { files: string[]; terms: string[] };
  evidence: sem.EvidenceRef[];
  /** texts of the system's responsibilities this component carries out */
  responsibilities?: string[];
  /** designed but not built yet: no files or evidence are expected, and their absence is not a gap */
  planned?: boolean;
}
/**
 * A gameplay relation. Endpoints: `self` | `area:<id>` | `sys:<systemId>[/<areaId>]` | `ent:<label>`.
 * It is NEVER derived from calls/imports: someone points at the code that demonstrates it.
 */
export interface StoredRelation {
  id: string; kind: sem.RelationKind; from: string; to: string; note?: string;
  status: 'proposed' | 'confirmed'; origin: Origin; evidence: sem.EvidenceRef[];
}
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
  kind?: 'system' | 'subsystem' | 'mechanic' | 'entity';
  planned?: boolean;
  areas?: StoredArea[];
  relations?: StoredRelation[];
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
  let raw: string | null = null;
  try { raw = await fs.readFile(storePath(projectId), 'utf-8'); }
  catch (e: any) { if (e.code !== 'ENOENT') throw new Error(`The local system catalog could not be read (${e.code ?? e.message}). Nothing was changed.`); }
  // Only a missing file means "no systems yet". A file that exists but cannot be understood is an error: answering
  // "empty" would hide the systems and the next write would overwrite them.
  if (raw !== null) {
    let data: any;
    try { data = JSON.parse(raw); } catch { throw new Error(`The local system catalog is not valid JSON (${storePath(projectId)}). Nothing was changed; restore or repair the file.`); }
    if (!data || !Array.isArray(data.systems)) throw new Error(`The local system catalog has an unexpected shape (${storePath(projectId)}). Nothing was changed.`);
    store = { version: 1, systems: data.systems };
  }
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
designCore.onDecisionsChanged(() => { viewCache.clear(); memoCache.clear(); });

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
  /** The branch exists but has no commit yet; `head` is undefined and Git revisions cannot be read. */
  unborn?: boolean;
  uncommitted: number; integration: string;
}

async function checkoutInfo(project: { path: string }, root: string): Promise<{ info: CheckoutInfo; dirtyFiles: Set<string> }> {
  const isCanonical = designKnowledge.norm(root) === designKnowledge.norm(project.path);
  const unborn = await isUnborn(root);
  const [branchRaw, head, status] = await Promise.all([
    unborn ? git(root, ['symbolic-ref', '--short', 'HEAD']) : git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['rev-parse', '--short', 'HEAD']), git(root, ['status', '--porcelain']),
  ]);
  const branch = branchRaw;
  const dirtyFiles = new Set<string>();
  for (const l of (status ?? '').split(/\r?\n/).filter(Boolean)) {
    const p = l.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '');
    dirtyFiles.add(posix(p));
  }
  let integration = 'unknown';
  if (unborn) integration = 'no commits yet';
  else if (head === null) integration = 'not a git checkout';
  else {
    // The reference is the repository's MAIN worktree, not project.path: a worktree registered as a project is not integrated.
    const main = await designDecisions.mainCheckout(root);
    const canon = main?.head;
    if (main && designKnowledge.norm(main.root) === designKnowledge.norm(root)) integration = 'integrated checkout';
    else if (canon) {
      const ancestor = (await git(root, ['merge-base', '--is-ancestor', 'HEAD', canon])) !== null;
      if (ancestor) integration = 'HEAD is contained in the integrated checkout';
      else {
        const ahead = (await git(root, ['rev-list', '--count', `${canon}..HEAD`]))?.trim();
        integration = `NOT integrated: ${ahead ?? '?'} commit(s) not in the integrated checkout`;
      }
    }
  }
  return { info: { root, isCanonical, branch: branch?.trim(), head: head?.trim(), unborn, uncommitted: dirtyFiles.size, integration }, dirtyFiles };
}

// ---- derived view -------------------------------------------------------------------------------

export type Why = { kind: 'anchor' | 'dk' | 'name' | 'mention'; detail: string };
export interface Member {
  path: string; role: 'code' | 'scene' | 'resource' | 'test';
  why: Why[]; score: number;
  confidence: 'declared' | 'extracted';       // declared = a person/agent/DK named it; extracted = found by name or text
  tier: sem.Tier; facet: sem.Facet; areas: string[];
  uncommitted: boolean; changedSinceAnalysis: boolean;
  state: 'ok' | 'moved';
  movedFrom?: string;
  symbols: { id: string; label: string; kind: string; line: number }[];
}
export interface Neighbor {
  path: string; edges: number; confidence: string; relation: string; via: string;
  relations: Record<string, number>; extractedEdges: number; inferredEdges: number;
}

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
  conflictsWith: string[]; relevance: 'declared' | 'term' | 'touches-member'; origin?: string; provenance?: any;
  evidence: { type: string; ref: string; freshness?: string; detail?: string; note?: string; excerpt: string[] }[];
  files: string[]; tests: string[];
}

export interface AreaView {
  id: string; name: string; kind: AreaKind | 'facet'; summary: string; status: 'proposed' | 'confirmed' | 'inferred'; origin: Origin | 'derived';
  /** inferred = grouped from file names/paths, not a judgement about design */
  inferred: boolean; basis: sem.Basis; evidence: sem.ResolvedEvidence[];
  files: { path: string; tier: sem.Tier; facet: sem.Facet; line?: number; uncommitted: boolean }[];
  fileCount: number; testCount: number; families: sem.Family[];
  /** what the person stored (editable); absent for inferred groups */
  anchors?: { files: string[]; terms: string[] };
  responsibilities?: string[]; planned?: boolean;
}
export interface EndpointView { ref: string; label: string; type: 'self' | 'area' | 'system' | 'entity'; systemId?: string; areaId?: string; known: boolean }
export interface RelationView {
  id: string; kind: sem.RelationKind; label: string; from: EndpointView; to: EndpointView; note?: string;
  status: 'proposed' | 'confirmed'; origin: Origin; basis: sem.Basis; evidence: sem.ResolvedEvidence[];
  direction: 'internal' | 'outgoing' | 'incoming'; storedIn: string; examinedHead?: string;
}
export interface TechnicalLink { toSystem?: string; toName: string; files: string[]; relations: Record<string, number>; edges: number; extracted: number; inferred: number }

export interface SystemView {
  id: string; name: string; summary: string; responsibilities: string[];
  kind: 'system' | 'subsystem' | 'mechanic' | 'entity'; planned: boolean;
  areas: AreaView[]; relations: RelationView[]; technical: TechnicalLink[];
  comparisons: sem.Comparison[];
  families: sem.Family[]; testGroups: { dir: string; count: number; paths: string[] }[];
  overlaps: { id: string; name: string; shared: number; ratio: number }[];
  tierCounts: Record<sem.Tier, number>;
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

/** Explicit service operations; opening a project never reads or writes this file. */
/** A repository whose current branch has no commit yet (`git init` and nothing else). Not the same as "not a repo". */
export async function isUnborn(root: string): Promise<boolean> {
  if ((await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim()) return false;
  return (await git(root, ['symbolic-ref', '-q', 'HEAD'])) !== null;
}

export const UNBORN_MESSAGE = 'This repository has no commits yet. The portable file is tied to the repository history, so it can be published or recovered only after the first commit.';
export class UnbornRepoError extends Error { code = 'UNBORN'; constructor() { super(UNBORN_MESSAGE); } }

export async function portableGitRoot(root: string): Promise<string[]> {
  if (await isUnborn(root)) throw new UnbornRepoError();
  const roots = await git(root, ['rev-list', '--max-parents=0', 'HEAD']);
  const shallow = await git(root, ['rev-parse', '--is-shallow-repository']);
  if (!roots?.trim() || shallow?.trim() !== 'false') throw new Error('Portable catalog requires a complete Git history');
  return roots.trim().split(/\r?\n/).sort();
}

export const portablePath = (root: string) => join(root, 'jabutistudio.systems.json');

async function checkLocalStore(projectId: string): Promise<void> {
  try {
    const local = JSON.parse(await fs.readFile(storePath(projectId), 'utf8'));
    if (local.version !== 1 || !Array.isArray(local.systems) || local.systems.some((s: any) => !s || typeof s.id !== 'string') ||
        new Set(local.systems.map((s: any) => s.id)).size !== local.systems.length) throw new Error('Invalid local system catalog');
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
}

export async function checkPortablePaths(root: string, systems: StoredSystem[]): Promise<void> {
  const realRoot = await fs.realpath(root);
  const paths: string[] = [];
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') {
      for (const [key, value] of Object.entries(v)) {
        if (key === 'files' && Array.isArray(value)) paths.push(...value);
        else if (key === 'path' && typeof value === 'string') paths.push(value);
        else collect(value);
      }
    }
  };
  collect(systems);
  for (const ref of paths) {
    let candidate = join(realRoot, ref.split('#')[0]);
    while (true) {
      try {
        const resolved = await fs.realpath(candidate);
        const rel = relative(realRoot, resolved);
        if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel))
          throw new Error(`Reference escapes checkout: ${ref}`);
        break;
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        candidate = dirname(candidate);
      }
    }
  }
}

export async function exportPortable(project: Project, opts: { systemIds?: string[] } = {}): Promise<void> {
  await checkLocalStore(project.id);
  const want = opts.systemIds ? new Set(opts.systemIds) : null;
  if (want && !want.size) throw new Error('Choose at least one system to publish');
  const systems = (await listStored(project.id, true)).filter(s => !want || want.has(s.id)).map(portableSystem)
    // a partial export must not point at systems that are not in the file
    .map(s => want ? { ...s, related: s.related.filter(r => want.has(r)), mergedFrom: s.mergedFrom?.filter(r => want.has(r)) } : s);
  const document = portableSchema.parse({ version: 1, gitRoots: await portableGitRoot(project.path), systems });
  await checkPortablePaths(project.path, document.systems);
  const file = portablePath(project.path);
  try {
    await fs.lstat(file);
    throw new Error('Portable catalog already exists; refusing to overwrite it');
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  const temp = join(project.path, `.jabutistudio-${randomUUID()}.tmp`);
  try {
    await writeJsonAtomic(temp, document);
    await fs.link(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
    await fs.rm(`${temp}.tmp`, { force: true });
  }
}

export type ImportKind = 'new' | 'identical' | 'changed' | 'duplicate';
/**
 * How one portable system relates to what this installation already has. Shared by the import and by its preview,
 * so what the person reviews is exactly what the import accepts or refuses.
 *   changed = same id, different content;  duplicate = different id, same name or terms as an open system.
 */
export function classifyPortableImport(stored: StoredSystem[], s: ReturnType<typeof portableSystem>): { kind: ImportKind; against?: string } {
  const current = stored.find(x => x.id === s.id);
  if (current) return { kind: JSON.stringify(portableSystem(current)) === JSON.stringify(s) ? 'identical' : 'changed', against: current.id };
  const dup = stored.find(x => x.status !== 'dismissed' && x.status !== 'merged' &&
    (x.name.toLowerCase() === s.name.toLowerCase() || x.anchors.terms.some(t => s.anchors.terms.some(u => t.toLowerCase() === u.toLowerCase()))));
  return dup ? { kind: 'duplicate', against: dup.id } : { kind: 'new' };
}

export async function importPortable(project: Project, opts: { expectedSha256?: string } = {}): Promise<{ added: number; conflicts: string[] }> {
  const file = portablePath(project.path);
  if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Portable catalog cannot be a symlink');
  const raw = await fs.readFile(file);
  if (opts.expectedSha256 && createHash('sha256').update(raw).digest('hex') !== opts.expectedSha256)
    throw new Error('Portable catalog changed since the preview; review it again before importing');
  const document = portableSchema.parse(JSON.parse(raw.toString('utf8')));
  if (JSON.stringify(document.gitRoots) !== JSON.stringify(await portableGitRoot(project.path))) throw new Error('Portable catalog belongs to a different Git history');
  await checkPortablePaths(project.path, document.systems);
  return locked(async () => {
    // Unlike normal first-use reads, an invalid existing catalog must never be replaced.
    await checkLocalStore(project.id);
    const store = await readStore(project.id);
    const conflicts = document.systems.filter(s => {
      const k = classifyPortableImport(store.systems, s).kind;
      return k === 'changed' || k === 'duplicate';
    }).map(s => s.id);
    if (conflicts.length) return { added: 0, conflicts };
    const added = document.systems.filter(s => !store.systems.some(x => x.id === s.id));
    if (added.length) {
      const next: Store = { version: 1, systems: [...store.systems, ...added] };
      await fs.mkdir(join(DATA_DIR, 'systems'), { recursive: true });
      await writeJsonAtomic(storePath(project.id), next);
      storeCache.set(project.id, { store: next, mtime: (await fs.stat(storePath(project.id))).mtimeMs });
      viewCache.clear();
    }
    return { added: added.length, conflicts: [] };
  });
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
  const renames = await memo(`renames|${root}`, VIEW_TTL, async () => {
    const parts = ((await git(root, ['diff', '--name-status', '-z', '-M', 'HEAD'])) ?? '').split('\0');
    const found = new Map<string, string>();
    for (let i = 0; i < parts.length - 1;) {
      const status = parts[i++];
      const from = parts[i++];
      if (status.startsWith('R') || status.startsWith('C')) {
        const to = parts[i++];
        if (status.startsWith('R')) found.set(posix(from), posix(to));
      }
    }
    return found;
  });
  const terms = sys.anchors.terms;
  const g = await graphify.loadGraph(project.id).catch(() => null);
  const startedAt = g ? await graphify.buildStartedAt(project.id) : null;

  // ---- design decisions (DK) ----
  const dkRes: any[] = [];
  let dkAvailable = false, dkReason: string | undefined;
  {
    const r = await designCore.forSystem(project, { id: sys.id, anchors: { terms: uniq(terms), decisions: sys.anchors.decisions } }, worktree);
    dkAvailable = r.available; dkReason = r.reason; dkRes.push(...r.decisions);
  }
  const byId = new Map<string, any>();
  for (const d of dkRes) byId.set(d.id, d);

  // ---- members ----
  const stored = await listStored(project.id);
  const areasStored = sys.areas ?? [];
  const cand = new Map<string, { why: Why[]; score: number; declared: boolean; moved?: string }>();
  const add = (path: string, why: Why, score: number, declared: boolean, movedFrom?: string) => {
    const e = cand.get(path) ?? { why: [], score: 0, declared: false };
    e.why.push(why); e.score += score; e.declared = e.declared || declared;
    if (movedFrom) e.moved = movedFrom;
    cand.set(path, e);
  };
  /** An anchored path in THIS checkout: itself, or the single file with the same base name (renamed/moved). */
  const resolvePath = (p: string): { path: string; movedFrom?: string } | null => {
    if (fileSet.has(p)) return { path: p };
    const renamed = renames.get(p);
    if (renamed && fileSet.has(renamed)) return { path: renamed, movedFrom: p };
    const moved = files.filter(f => basename(f) === basename(p));
    return moved.length === 1 ? { path: moved[0], movedFrom: p } : null;
  };
  const unresolved: { path: string; state: 'gone' }[] = [];
  for (const a of sys.anchors.files) {
    const p = posix(a);
    const r = resolvePath(p);
    if (r) add(r.path, { kind: 'anchor', detail: r.movedFrom ? `named by the system (moved from ${p})` : 'named by the system' }, 100, true, r.movedFrom);
    else unresolved.push({ path: p, state: 'gone' });
  }
  const areaAnchorPaths = new Map<string, { path: string; line?: number }[]>();
  for (const area of areasStored) {
    const list: { path: string; line?: number }[] = [];
    for (const raw of area.anchors.files) {
      const [pp, symbol] = posix(raw).split('#');
      const r = resolvePath(pp);
      if (!r) { unresolved.push({ path: pp, state: 'gone' }); continue; }
      add(r.path, { kind: 'anchor', detail: `anchor of "${area.name}"${r.movedFrom ? ` (moved from ${pp})` : ''}` }, 90, true, r.movedFrom);
      list.push({ path: r.path, line: await locate(root, r.path, symbol) });
    }
    areaAnchorPaths.set(area.id, list);
  }
  const declaredOrTerm = (d: any) => sys.anchors.decisions.includes(d.id) || (d.systems ?? []).includes(sys.id) ||
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
    if (n >= 3 || cand.has(f)) add(f, { kind: 'mention', detail: `${n} line${n > 1 ? 's' : ''} mention the system's terms` }, Math.min(n, 12), false);
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
      origin: d.source, provenance: d.provenance,
      relevance: sys.anchors.decisions.includes(d.id) || (d.systems ?? []).includes(sys.id) ? 'declared' : direct ? 'term' : 'touches-member',
      evidence: (d.evidence ?? []).filter((e: any) => !e.candidate_only).map((e: any) => ({
        type: e.type, ref: e.path ? `${e.path} (was ${e.ref})` : e.ref, freshness: e.freshness, detail: e.detail, note: e.note,
        excerpt: (e.excerpt ?? []).filter((x: any) => String(x.text).trim()).slice(0, 10).map((x: any) => `L${x.line}: ${x.text}`),
      })),
      files: (d.files ?? []).map((f: any) => f.path), tests: (d.tests ?? []).map((t: any) => t.path),
    });
  }
  const ids = new Set(decisions.map(d => d.id));
  const conflicts: [string, string][] = [];
  for (const d of decisions) for (const o of d.conflictsWith) if (ids.has(o) && d.id < o) conflicts.push([d.id, o]);
  // conflicts form groups (A~B, B~C → one comparison of three), each compared side by side
  const comparisons: sem.Comparison[] = [];
  {
    const parent = new Map<string, string>();
    const find = (x: string): string => (parent.get(x) === undefined || parent.get(x) === x) ? x : find(parent.get(x)!);
    for (const [a, b] of conflicts) parent.set(find(a), find(b));
    const groups = new Map<string, string[]>();
    for (const [a, b] of conflicts) for (const x of [a, b]) { const r = find(x); const gr = groups.get(r) ?? groups.set(r, []).get(r)!; if (!gr.includes(x)) gr.push(x); }
    for (const gr of groups.values()) comparisons.push(sem.compareDecisions(gr.sort().map(did => decisions.find(d => d.id === did)!)));
  }

  // ---- tiers, facets, families ----
  const tierOf = (path: string, v: { why: Why[]; declared: boolean }): sem.Tier => {
    const role = roleOf(path);
    if (role === 'test') return 'test';
    if (v.declared) return 'core';                                           // a person/agent/DK pointed at it
    if (v.why.some(w => w.kind === 'name') && role !== 'resource') return 'participant';   // its name says so
    return 'candidate';                                                      // text mention / generated data only
  };
  const tierRank: Record<sem.Tier, number> = { core: 0, participant: 1, candidate: 2, test: 3, historical: 4, related: 5 };
  const tiered = [...cand].map(([path, v]) => ({ path, v, tier: tierOf(path, v) }));
  const tierCounts: Record<sem.Tier, number> = { core: 0, participant: 0, related: 0, candidate: 0, test: 0, historical: 0 };
  for (const t of tiered) tierCounts[t.tier]++;
  const { families } = sem.familiesOf(tiered.filter(t => roleOf(t.path) === 'resource' && t.tier !== 'core').map(t => t.path));
  const inFamily = new Set(families.flatMap(f => f.paths));
  const tGroups = sem.testGroups(tiered.filter(t => t.tier === 'test').map(t => t.path));
  const listable = tiered.filter(t => !inFamily.has(t.path))
    .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.v.score - a.v.score || a.path.localeCompare(b.path));
  const shown = [...listable.filter(t => t.tier !== 'test').slice(0, MEMBER_CAP), ...listable.filter(t => t.tier === 'test').slice(0, 12)];

  const areaOfFile = new Map<string, string[]>();
  for (const [aid, list] of areaAnchorPaths) for (const f of list) (areaOfFile.get(f.path) ?? areaOfFile.set(f.path, []).get(f.path)!).push(aid);

  // ---- symbols ----
  const idx = g ? nodesByFile(g) : null;
  const members: Member[] = [];
  for (const { path, v, tier } of shown) {
    let changed = false;
    if (startedAt && info.isCanonical) { try { changed = (await fs.stat(join(root, path))).mtimeMs > startedAt; } catch { /* gone */ } }
    const syms = (idx?.get(path) ?? []).filter(n => n.kind === 'func' || n.kind === 'signal' || n.kind === 'class');
    const hit = (s: graphify.GNode) => terms.some(t => s.label.toLowerCase().includes(t.toLowerCase()));
    members.push({
      path, role: roleOf(path), why: v.why, score: v.score, tier, facet: sem.facetOf(path), areas: areaOfFile.get(path) ?? [],
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
    for (const m of members.filter(x => x.role === 'code' && (x.tier === 'core' || x.tier === 'participant'))) {
      for (const n of idx.get(m.path) ?? []) {
        for (const side of [g.out.get(n.id) ?? [], g.inn.get(n.id) ?? []]) {
          for (const e of side) {
            if (e.relation === 'contains' || e.relation === 'method') continue;
            const other = g.nodes.get(e.from === n.id ? e.to : e.from);
            if (!other?.file || memberPaths.has(other.file) || skipped(other.file) || !fileSet.has(other.file)) continue;
            const cur = acc.get(other.file);
            const extracted = e.confidence === 'EXTRACTED';
            const conf = extracted || cur?.confidence === 'EXTRACTED' ? 'EXTRACTED' : String(e.confidence);
            const relations = { ...(cur?.relations ?? {}) }; relations[e.relation] = (relations[e.relation] ?? 0) + e.count;
            acc.set(other.file, {
              path: other.file, edges: (cur?.edges ?? 0) + e.count, confidence: conf, relation: cur?.relation ?? e.relation, via: cur?.via ?? m.path,
              relations, extractedEdges: (cur?.extractedEdges ?? 0) + (extracted ? e.count : 0), inferredEdges: (cur?.inferredEdges ?? 0) + (extracted ? 0 : e.count),
            });
          }
        }
      }
    }
    neighbors.push(...[...acc.values()].sort((a, b) => Number(b.confidence === 'EXTRACTED') - Number(a.confidence === 'EXTRACTED') || b.edges - a.edges).slice(0, 24));
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

  // ---- areas: stored responsibilities (verified now) or, failing that, an inferred split by facet ----
  const areaViews: AreaView[] = [];
  const codeLike = (p: string) => roleOf(p) === 'code' || roleOf(p) === 'scene';
  for (const a of areasStored) {
    const pinned = areaAnchorPaths.get(a.id) ?? [];
    const pinnedSet = new Set(pinned.map(f => f.path));
    const byTerm = a.anchors.terms.length
      ? files.filter(f => codeLike(f) && !pinnedSet.has(f) && roleOf(f) !== 'test' && !!nameMatches(f, a.anchors.terms))
      : [];
    const fl: AreaView['files'] = [
      ...pinned.map(f => ({ path: f.path, tier: 'core' as sem.Tier, facet: sem.facetOf(f.path), line: f.line, uncommitted: dirtyFiles.has(f.path) })),
      ...byTerm.slice(0, 10).map(f => ({ path: f, tier: 'participant' as sem.Tier, facet: sem.facetOf(f), uncommitted: dirtyFiles.has(f) })),
    ];
    const ev = await Promise.all(a.evidence.map(e => sem.verifyEvidence(root, files, e, renames)));
    areaViews.push({
      id: a.id, name: a.name, kind: a.kind, summary: a.summary, status: a.status, origin: a.origin, inferred: false,
      basis: sem.basisOf(ev), evidence: ev, files: fl.filter(f => !sem.isTestPath(f.path)).slice(0, 14),
      fileCount: pinned.length + byTerm.length,
      testCount: a.anchors.terms.length ? files.filter(f => roleOf(f) === 'test' && !!nameMatches(f, a.anchors.terms)).length : 0,
      families: [], anchors: { files: [...a.anchors.files], terms: [...a.anchors.terms] },
      responsibilities: [...(a.responsibilities ?? [])], planned: !!a.planned,
    });
  }
  if (!areasStored.length) {
    const groupsBy = new Map<sem.Facet, Member[]>();
    for (const m of members) {
      if (m.tier !== 'core' && m.tier !== 'participant') continue;
      (groupsBy.get(m.facet) ?? groupsBy.set(m.facet, []).get(m.facet)!).push(m);
    }
    const order: sem.Facet[] = ['logic', 'purchase', 'requirement', 'effect', 'data', 'ui', 'telemetry', 'other'];
    for (const f of order) {
      const ms = groupsBy.get(f) ?? [];
      const fam = f === 'data' ? families : [];
      if (!ms.length && !fam.length) continue;
      areaViews.push({
        id: `facet:${f}`, name: sem.FACET_LABEL[f], kind: 'facet', status: 'inferred', origin: 'derived', inferred: true, basis: 'candidate', evidence: [],
        summary: 'Grouped by what the files are named and where they live. Not a design responsibility until someone describes it.',
        files: ms.slice(0, 14).map(m => ({ path: m.path, tier: m.tier, facet: m.facet, uncommitted: m.uncommitted })),
        fileCount: ms.length + fam.reduce((n, x) => n + x.count, 0), testCount: 0, families: fam,
      });
    }
  }

  // ---- relations: only what someone documented with code evidence, re-verified against THIS checkout ----
  const allStored = await listStored(project.id, true);
  const endpoint = (ref: string, owner: StoredSystem): EndpointView => {
    if (ref === 'self') return { ref, label: owner.name, type: 'self', systemId: owner.id, known: true };
    if (ref.startsWith('area:')) { const aid = ref.slice(5); const a = owner.areas?.find(x => x.id === aid); return { ref, label: a?.name ?? aid, type: 'area', systemId: owner.id, areaId: aid, known: !!a }; }
    if (ref.startsWith('sys:')) {
      const [sid, aid] = ref.slice(4).split('/'); const o = allStored.find(x => x.id === sid); const a = o?.areas?.find(x => x.id === aid);
      return { ref, label: o ? (a ? `${o.name} · ${a.name}` : o.name) : sid, type: 'system', systemId: o?.status === 'merged' && o.mergedInto ? o.mergedInto : sid, areaId: aid, known: !!o && (!aid || !!a) };
    }
    return { ref, label: ref.replace(/^ent:/, ''), type: 'entity', known: true };
  };
  const relViews: RelationView[] = [];
  const relPairs: { r: StoredRelation; owner: StoredSystem; incoming: boolean }[] = [
    ...(sys.relations ?? []).map(r => ({ r, owner: sys, incoming: false })),
    ...allStored.filter(o => o.id !== sys.id && o.status !== 'dismissed').flatMap(o => (o.relations ?? [])
      .filter(r => r.to === `sys:${sys.id}` || r.to.startsWith(`sys:${sys.id}/`)).map(r => ({ r, owner: o, incoming: true }))),
  ];
  for (const { r, owner, incoming } of relPairs) {
    const ev = await Promise.all(r.evidence.map(e => sem.verifyEvidence(root, files, e, renames)));
    const from = endpoint(r.from, owner), to = endpoint(r.to, owner);
    const internal = !incoming && from.systemId === sys.id && to.systemId === sys.id;
    relViews.push({
      id: `${owner.id}:${r.id}`, kind: r.kind, label: sem.RELATION_LABEL[r.kind], from, to, note: r.note, status: r.status, origin: r.origin,
      basis: sem.basisOf(ev), evidence: ev, direction: incoming ? 'incoming' : internal ? 'internal' : 'outgoing', storedIn: owner.id, examinedHead: info.head,
    });
  }

  // ---- technical links: Graphify edges grouped by the system that owns the other file (NOT gameplay facts) ----
  const technical: TechnicalLink[] = [];
  {
    const others = allStored.filter(o => o.id !== sys.id && o.status !== 'dismissed' && o.status !== 'merged');
    const ownerOf = (f: string) => others.find(o => o.anchors.files.map(posix).includes(f) || (o.areas ?? []).some(a => a.anchors.files.some(x => posix(x).split('#')[0] === f)) ||
      (o.anchors.terms.length > 0 && !!nameMatches(f, o.anchors.terms)));
    const by = new Map<string, TechnicalLink>();
    for (const n of neighbors) {
      const o = ownerOf(n.path); if (!o) continue;
      const t = by.get(o.id) ?? by.set(o.id, { toSystem: o.id, toName: o.name, files: [], relations: {}, edges: 0, extracted: 0, inferred: 0 }).get(o.id)!;
      t.files.push(n.path); t.edges += n.edges; t.extracted += n.extractedEdges; t.inferred += n.inferredEdges;
      for (const [k, c] of Object.entries(n.relations)) t.relations[k] = (t.relations[k] ?? 0) + c;
    }
    technical.push(...[...by.values()].sort((a, b) => b.extracted - a.extracted || b.edges - a.edges));
  }

  // ---- related systems: shared members, plus declared (technical overlap, not gameplay) ----
  const related: SystemView['related'] = [];
  const mine = new Set(members.filter(m => m.tier === 'core' || m.tier === 'participant').map(m => m.path));
  for (const o of stored) {
    if (o.id === id) continue;
    const otherFiles = new Set([...o.anchors.files, ...(o.areas ?? []).flatMap(a => a.anchors.files.map(x => x.split('#')[0]))].map(posix));
    const shared = [...mine].filter(p => otherFiles.has(p) || (o.anchors.terms.length > 0 && !!nameMatches(p, o.anchors.terms)));
    const declared = sys.related.includes(o.id) || o.related.includes(id);
    if (shared.length || declared) related.push({ id: o.id, name: o.name, shared: shared.slice(0, 6), declared });
  }

  // ---- overlap with other candidates (redundant groupings such as two names for one thing) ----
  const overlaps: SystemView['overlaps'] = [];
  const myLex = await lexicalSet(root, files, sys);
  if (myLex.size >= 5) {
    for (const o of stored) {
      if (o.id === id) continue;
      const theirs = await lexicalSet(root, files, o);
      if (theirs.size < 5) continue;
      const shared = [...myLex].filter(p => theirs.has(p)).length;
      const ratio = shared / Math.min(myLex.size, theirs.size);
      if (ratio >= 0.5) overlaps.push({ id: o.id, name: o.name, shared, ratio: Math.round(ratio * 100) / 100 });
    }
    overlaps.sort((a, b) => b.ratio - a.ratio);
  }

  // ---- maintenance: vanished references (canonical checkout only, so a worktree never rewrites history) ----
  const keys = new Set<string>();
  for (const m of members) { keys.add(`file:${m.path}`); if (g) for (const s of m.symbols) keys.add(`sym:${m.path}#${s.label}`); }
  let vanished = sys.vanished ?? [];
  if (info.isCanonical && files.length > 0) {
    const prev = sys.seen?.keys ?? [];
    const fileSet = new Set(files);
    // A reference is gone when the thing itself is gone, NOT when it merely stopped being listed (the member
    // list is capped and tiered, so dropping out of it says nothing). A symbol is judged against the graph
    // only while one exists for its file.
    const isGone = (k: string): boolean => {
      if (k.startsWith('file:')) return !fileSet.has(k.slice(5));
      if (!k.startsWith('sym:')) return false;
      const hash = k.indexOf('#'); const path = k.slice(4, hash); const label = k.slice(hash + 1);
      if (!fileSet.has(path)) return true;
      if (!g) return false;
      const nodes = nodesByFile(g).get(path);
      return !!nodes && nodes.length > 0 && !nodes.some(n => n.label === label);
    };
    const nextKeys = [...new Set([...keys, ...prev.filter(k => !isGone(k))])];
    const gone = prev.filter(isGone);
    const merged = new Map(vanished.filter(v => !keys.has(v.key) && isGone(v.key)).map(v => [v.key, v]));
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
  if (!g) limitations.push('Graphify has not analyzed this project: no symbols or technical relations are shown.');
  else {
    if (!info.isCanonical) limitations.push('The Graphify graph describes the integrated checkout, not this worktree: symbols and technical relations may not match the files examined here. Membership by name/text, evidence and Git state are read from this worktree.');
    if (changedMembers.length) limitations.push(`${changedMembers.length} member file(s) changed after the last analysis; symbols and technical relations for them may be out of date.`);
    limitations.push('INFERRED relations are name-based guesses; calls through autoloads, instances or signal connections across files are often missing, so absence in the graph is not proof of absence.');
  }
  if (!dkAvailable) limitations.push(`Design decisions are not indexed for this project${dkReason ? ` (${dkReason})` : ''}.`);
  if (decisions.length) limitations.push('Test references are static: the catalog does not run tests, so no test result is shown.');
  const weakerCount = Math.max(0, tiered.length - shown.length - inFamily.size);
  if (weakerCount) limitations.push(`${weakerCount} weaker member(s) not listed.`);
  if (sys.status === 'proposed') limitations.push('This system is a proposal: grouping and responsibility text have not been confirmed by a person.');
  if (!areasStored.length) limitations.push('No responsibilities were described for this system: the areas shown are inferred from file names and paths only.');
  if (!relViews.length) limitations.push('No gameplay relations are documented. Technical links come from the code graph and are not gameplay facts.');
  if (unresolved.length) limitations.push(`${unresolved.length} file anchor(s) no longer exist in this checkout.`);
  if (relViews.some(r => r.basis === 'stale')) limitations.push('Some documented relations have evidence that no longer holds in this checkout.');

  const value: SystemView = {
    id: sys.id, name: sys.name, summary: sys.summary, responsibilities: sys.responsibilities,
    kind: sys.kind ?? 'system', planned: !!sys.planned, areas: areaViews, relations: relViews, technical, comparisons,
    families, testGroups: tGroups, overlaps, tierCounts,
    status: sys.status, origin: sys.origin, confirmedAt: sys.confirmedAt, confirmedVia: sys.confirmedVia,
    anchors: sys.anchors, mergedInto: sys.mergedInto, mergedFrom: sys.mergedFrom, suggestions: sys.suggestions ?? [],
    checkout: info, members, weakerMembers: weakerCount, neighbors,
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

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Line of `func|signal|const|var|class symbol` in a file, so an area can point at a symbol. */
async function locate(root: string, path: string, symbol?: string): Promise<number | undefined> {
  if (!symbol) return undefined;
  try {
    const i = (await fs.readFile(join(root, path), 'utf8')).split(/\r?\n/).findIndex(l => new RegExp(`\\b(func|signal|const|var|class)\\s+${esc(symbol)}\\b`).test(l));
    return i >= 0 ? i + 1 : undefined;
  } catch { return undefined; }
}

/** Code and scene files a system claims by name, text (3+ lines) or anchor. No DK, no tests, no generated resources. */
function lexicalSet(root: string, files: string[], s: StoredSystem): Promise<Set<string>> {
  return memo(`lex|${root}|${s.id}|${s.anchors.terms.join(',')}|${s.anchors.files.join(',')}`, VIEW_TTL, async () => {
    const out = new Set<string>();
    const ok = (f: string) => roleOf(f) === 'code' || roleOf(f) === 'scene';
    for (const f of files) if (ok(f) && nameMatches(f, s.anchors.terms)) out.add(f);
    for (const a of s.anchors.files) if (files.includes(posix(a))) out.add(posix(a));
    for (const [f, n] of await mentions(root, files, s.anchors.terms)) if (n >= 3 && ok(f) && files.includes(f)) out.add(f);
    return out;
  });
}

export interface SystemSummary {
  id: string; name: string; summary: string; status: Status; origin: Origin;
  kind: sem.ThingKind; planned: boolean; createdAt: string;
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
  // A system that cannot be resolved is reported, never dropped: a failed load must not look like "no systems".
  const loadErrors: { id: string; name: string; error: string }[] = [];
  for (let i = 0; i < stored.length; i++) {
    const s = stored[i]; const v = views[i];
    if ('error' in v) { loadErrors.push({ id: s.id, name: s.name, error: v.error }); continue; }
    const flags: string[] = [];
    if (v.maintenance.needsReanalysis) flags.push('stale graph');
    if (v.maintenance.vanished.length) flags.push(`${v.maintenance.vanished.length} vanished`);
    if (v.design.conflicts.length) flags.push('conflict');
    if (v.maintenance.unresolvedAnchors.length) flags.push('missing files');
    rows.push({
      id: s.id, name: s.name, summary: s.summary, status: s.status, origin: s.origin, kind: s.kind ?? 'system', planned: !!s.planned, createdAt: s.createdAt,
      files: v.members.length + v.weakerMembers, decisions: v.design.decisions.length, conflicts: v.design.conflicts.length, flags,
    });
  }
  const root = await designKnowledge.resolveRoot(project, worktree);
  const checkout = typeof root === "string" ? (await memo(`info|${root}`, VIEW_TTL, () => checkoutInfo(project, root))).info : null;
  const order = { confirmed: 0, proposed: 1, dismissed: 2, merged: 3 } as const;
  rows.sort((a, b) => order[a.status] - order[b.status] || b.files - a.files);
  return { systems: rows, loadErrors, checkout, dismissed: (await listStored(project.id, true)).filter(s => s.status === 'dismissed').length };
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

/** What a candidate really weighs: code/scene files, plus one per generated-resource family (200 `.tres` are one thing). */
const effectiveSize = (list: string[]) => {
  const nt = list.filter(f => roleOf(f) !== 'test');
  const res = nt.filter(f => roleOf(f) === 'resource');
  const fam = sem.familiesOf(res);
  return nt.length - res.length + fam.families.length + fam.rest.length;
};

/** Topic words shared by several files' names: pure structure, no project knowledge. */
export async function candidateTerms(root: string): Promise<Candidate[]> {
  const files = await listFiles(root);
  const byToken = new Map<string, Set<string>>();
  for (const f of files) for (const t of new Set(tokens(f))) (byToken.get(t) ?? byToken.set(t, new Set()).get(t)!).add(f);
  // a topic needs 3+ real things, not 3 test captures or 3 generated resources
  const cands = [...byToken].map(([term, set]) => ({ term, files: [...set], size: effectiveSize([...set]) }))
    .filter(c => c.size >= 3)
    .sort((a, b) => b.size - a.size);
  const kept: (Candidate & { size: number })[] = [];
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
        summary: `Candidate: ${effectiveSize(c.files)} code/scene files or resource families whose names share "${c.term}" (${c.files.filter(f => roleOf(f) === 'test').length} tests apart). Responsibility not described yet.`,
        responsibilities: [], createdAt: now(), updatedAt: now(), anchors: { terms: [c.term], files: [], decisions: [] }, related: [],
      });
      added++;
    }
    return { added, candidates: cands.length };
  });
}

// ---- proposals and review -----------------------------------------------------------------------

export interface AreaInput { id?: string; name: string; kind?: AreaKind; summary?: string; files?: string[]; terms?: string[]; evidence?: sem.EvidenceRef[]; responsibilities?: string[]; planned?: boolean }
export interface RelationInput { id?: string; kind: string; from: string; to: string; note?: string; evidence?: sem.EvidenceRef[] }
export interface ProposalInput {
  name: string; summary?: string; responsibilities?: string[];
  terms?: string[]; files?: string[]; decisions?: string[]; related?: string[];
  kind?: StoredSystem['kind']; areas?: AreaInput[]; relations?: RelationInput[]; planned?: boolean;
  /** a person starting a new system: never fold it into an existing one that shares a term */
  createOnly?: boolean;
}

const cleanEv = (xs?: sem.EvidenceRef[]) => (xs ?? []).filter(e => e && typeof e.path === 'string' && e.path.trim())
  .map(e => ({ path: posix(e.path.trim()), ...(e.needle ? { needle: e.needle } : {}), ...(e.note ? { note: e.note } : {}) }));
const evKey = (e: sem.EvidenceRef) => `${e.path}|${e.needle ?? ''}`;
const unionEv = (a: sem.EvidenceRef[], b: sem.EvidenceRef[]) => { const m = new Map(a.map(e => [evKey(e), e])); for (const e of b) m.set(evKey(e), e); return [...m.values()]; };

const toAreas = (xs: AreaInput[] | undefined, origin: Origin): StoredArea[] => (xs ?? []).filter(a => a?.name?.trim()).map(a => ({
  id: a.id?.trim() || slug(a.name), name: a.name.trim(), kind: a.kind ?? 'subsystem', summary: a.summary ?? '', status: 'proposed' as const, origin,
  anchors: { files: uniq((a.files ?? []).map(posix)), terms: uniq(a.terms ?? []) }, evidence: cleanEv(a.evidence),
  ...(a.responsibilities?.length ? { responsibilities: uniq(a.responsibilities.map(x => x.trim()).filter(Boolean)) } : {}), ...(a.planned ? { planned: true } : {}),
}));
const relId = (r: { kind: string; from: string; to: string }) => slug(`${r.from}-${r.kind}-${r.to}`);
const toRelations = (xs: RelationInput[] | undefined, origin: Origin): StoredRelation[] =>
  (xs ?? []).filter(r => r && (sem.RELATION_KINDS as readonly string[]).includes(r.kind) && r.from?.trim() && r.to?.trim()).map(r => ({
    id: r.id?.trim() || relId(r), kind: r.kind as sem.RelationKind, from: r.from.trim(), to: r.to.trim(), note: r.note,
    status: 'proposed' as const, origin, evidence: cleanEv(r.evidence),
  }));

/** Extends areas/relations without ever overwriting a confirmed one with something an agent wrote. */
function mergeAreas(target: StoredSystem, areas: StoredArea[], relations: StoredRelation[], origin: Origin) {
  let skipped = 0;
  for (const a of areas) {
    const cur = (target.areas ??= []).find(x => x.id === a.id);
    if (!cur) { target.areas.push(a); continue; }
    if (cur.status === 'confirmed' && origin !== 'user') { skipped++; continue; }
    cur.summary = a.summary || cur.summary; cur.kind = a.kind;
    cur.anchors = { files: uniq([...cur.anchors.files, ...a.anchors.files]), terms: uniq([...cur.anchors.terms, ...a.anchors.terms]) };
    cur.evidence = unionEv(cur.evidence, a.evidence);
  }
  for (const r of relations) {
    const cur = (target.relations ??= []).find(x => x.id === r.id);
    if (!cur) { target.relations.push(r); continue; }
    if (cur.status === 'confirmed' && origin !== 'user') { skipped++; continue; }
    cur.note = r.note ?? cur.note; cur.evidence = unionEv(cur.evidence, r.evidence);
  }
  return skipped;
}

/** The kind of thing a relation endpoint points at, from the stored catalog. Undefined when unknown (not blocked). */
function thingKindOf(owner: StoredSystem, ref: string, all: StoredSystem[]): sem.ThingKind | undefined {
  if (ref === 'self') return owner.kind ?? 'system';
  if (ref.startsWith('area:')) return owner.areas?.find(a => a.id === ref.slice(5))?.kind;
  if (ref.startsWith('ent:')) return 'entity';
  if (ref.startsWith('sys:')) {
    const [sid, aid] = ref.slice(4).split('/'); const o = all.find(x => x.id === sid);
    if (!o) return undefined;
    return aid ? o.areas?.find(a => a.id === aid)?.kind : (o.kind ?? 'system');
  }
  return undefined;
}
function problemOf(owner: StoredSystem, r: { kind: string; from: string; to: string }, all: StoredSystem[]) {
  if (r.from === r.to) return 'A relation cannot connect something to itself.';
  return sem.relationProblem(r.kind as sem.RelationKind, thingKindOf(owner, r.from, all), thingKindOf(owner, r.to, all));
}

/**
 * Agents and discovery land here. A confirmed system is never rewritten by a proposal: the proposal is kept
 * as a suggestion for a person to look at. A system that already owns one of the terms is extended instead
 * of duplicated.
 */
export function propose(projectId: string, input: ProposalInput, origin: Origin) {
  return mutate(projectId, store => {
    const terms = uniq(input.terms ?? []), files = uniq((input.files ?? []).map(posix)), decisions = uniq(input.decisions ?? []);
    const areas = toAreas(input.areas, origin), relations = toRelations(input.relations, origin);
    const wanted = slug(input.name);
    const existing = input.createOnly ? undefined : store.systems.find(s => s.status !== 'dismissed' && s.status !== 'merged' &&
      (s.id === `sys-${wanted}` || s.anchors.terms.some(t => terms.some(x => x.toLowerCase() === t.toLowerCase()))));
    if (existing) {
      if (existing.status === 'confirmed' && origin !== 'user') {
        (existing.suggestions ??= []).push({
          at: now(), origin, summary: input.summary, anchors: { terms, files, decisions },
          areas: areas.length, relations: relations.length, payload: { areas, relations },
        });
        existing.updatedAt = now();
        return { id: existing.id, outcome: 'suggestion-recorded' as const };
      }
      existing.anchors = { terms: uniq([...existing.anchors.terms, ...terms]), files: uniq([...existing.anchors.files, ...files]), decisions: uniq([...existing.anchors.decisions, ...decisions]) };
      if (input.summary) existing.summary = input.summary;
      if (input.responsibilities?.length) existing.responsibilities = input.responsibilities;
      existing.related = uniq([...existing.related, ...(input.related ?? [])]);
      if (input.kind) existing.kind = input.kind;
      const ok = relations.filter(r => !problemOf({ ...existing, areas: [...(existing.areas ?? []), ...areas] }, r, store.systems));
      mergeAreas(existing, areas, ok, origin);
      if (existing.origin === 'discovery' && origin !== 'discovery') existing.origin = origin;
      existing.updatedAt = now();
      return { id: existing.id, outcome: 'extended' as const };
    }
    const id = `sys-${wanted || 'system'}`;
    const created: StoredSystem = {
      id: store.systems.some(s => s.id === id) ? `${id}-${Date.now().toString(36)}` : id,
      name: input.name.trim(), summary: input.summary ?? '', responsibilities: input.responsibilities ?? [],
      status: 'proposed', origin, createdAt: now(), updatedAt: now(),
      anchors: { terms, files, decisions }, related: uniq(input.related ?? []),
      ...(input.kind ? { kind: input.kind } : {}), ...(input.planned ? { planned: true } : {}), areas, relations: [],
    };
    created.relations = relations.filter(r => !problemOf(created, r, store.systems));
    store.systems.push(created);
    return { id: created.id, outcome: 'created' as const };
  });
}

export type Edit = Partial<Pick<StoredSystem, 'name' | 'summary' | 'responsibilities' | 'kind'>> & {
  status?: 'confirmed' | 'proposed' | 'dismissed'; anchors?: Partial<Anchors>; related?: string[]; ackVanished?: boolean; clearSuggestions?: boolean;
  /** a person's decisions about responsibilities and gameplay relations */
  confirm?: { areas?: string[]; relations?: string[] };
  remove?: { areas?: string[]; relations?: string[] };
  upsertArea?: AreaInput; upsertRelation?: RelationInput;
  planned?: boolean;
  /** a person's edit of one relation: the old one is replaced (it may change meaning, so it goes back to proposal); the id follows the new content */
  replaceRelation?: { id: string; relation: RelationInput };
  /** a person's edit of one responsibility: replaces name, kind, summary and anchors (status is kept); creates it when new */
  setArea?: AreaInput;
  /** index into `suggestions`: discard that agent proposal without applying it */
  dropSuggestion?: number;
  /** index into `suggestions`: apply that agent proposal (as proposed, not confirmed) and drop it */
  adoptSuggestion?: number;
};

/** Human review. The route only lets this through from the app's own UI. */
export function review(projectId: string, id: string, edit: Edit) {
  return mutate(projectId, store => {
    const s = store.systems.find(x => x.id === id);
    if (!s) return null;
    // the view prefixes relation ids with their owner (`owner:id`); accept both forms
    const rid = (x: string) => (x.startsWith(`${s.id}:`) ? x.slice(s.id.length + 1) : x);
    // validate BEFORE touching anything: the cached store object must never be left half-edited by a refused change
    {
      const extra = edit.setArea?.name?.trim() ? toAreas([edit.setArea], 'user') : [];
      const probe: StoredSystem = { ...s, kind: edit.kind ?? s.kind, areas: [...(s.areas ?? []).filter(a => !extra.some(e => e.id === a.id)), ...extra] };
      for (const input of [edit.upsertRelation, edit.replaceRelation?.relation]) {
        if (!input) continue;
        const [r] = toRelations([{ ...input, id: undefined }], 'user');
        if (!r) throw new Error('This relation is incomplete or its kind is unknown.');
        const p = problemOf(probe, r, store.systems); if (p) throw new Error(p);
      }
      if (edit.replaceRelation && !(s.relations ?? []).some(x => x.id === rid(edit.replaceRelation!.id))) throw new Error('The relation to edit no longer exists.');
    }
    if (edit.name !== undefined) s.name = edit.name.trim() || s.name;
    if (edit.summary !== undefined) s.summary = edit.summary;
    if (edit.kind) s.kind = edit.kind;
    if (edit.responsibilities) s.responsibilities = edit.responsibilities.map(x => x.trim()).filter(Boolean);
    if (edit.anchors) s.anchors = {
      terms: uniq(edit.anchors.terms ?? s.anchors.terms), files: uniq((edit.anchors.files ?? s.anchors.files).map(posix)),
      decisions: uniq(edit.anchors.decisions ?? s.anchors.decisions),
    };
    if (edit.related) s.related = uniq(edit.related);
    if (edit.planned !== undefined) { if (edit.planned) s.planned = true; else delete s.planned; }
    if (edit.status) {
      s.status = edit.status;
      if (edit.status === 'confirmed') { s.confirmedAt = now(); s.confirmedVia = 'ui-request'; } else delete s.confirmedAt;
    }
    if (edit.setArea?.name?.trim()) {
      const [next] = toAreas([edit.setArea], 'user');
      const cur = (s.areas ??= []).find(x => x.id === next.id);
      if (cur) {
        // a confirmed classification that someone then rewrote is no longer what was accepted
        if (cur.status === 'confirmed' && JSON.stringify([cur.name, cur.kind, cur.summary, cur.anchors, cur.evidence]) !== JSON.stringify([next.name, next.kind, next.summary, next.anchors, next.evidence])) cur.status = 'proposed';
        cur.name = next.name; cur.kind = next.kind; cur.summary = next.summary; cur.anchors = next.anchors; cur.evidence = next.evidence;
        if (next.responsibilities) cur.responsibilities = next.responsibilities; else delete cur.responsibilities;
        if (next.planned) cur.planned = true; else delete cur.planned;
      }
      else s.areas.push(next);
    }
    if (edit.dropSuggestion !== undefined && s.suggestions) s.suggestions = s.suggestions.filter((_, i) => i !== edit.dropSuggestion);
    if (edit.upsertArea) mergeAreas(s, toAreas([edit.upsertArea], 'user'), [], 'user');
    if (edit.upsertRelation) {
      const [r] = toRelations([edit.upsertRelation], 'user');
      if (!r) throw new Error('This relation is incomplete or its kind is unknown.');
      const p = problemOf(s, r, store.systems); if (p) throw new Error(p);
      mergeAreas(s, [], [r], 'user');
    }
    if (edit.replaceRelation) {
      const [r] = toRelations([{ ...edit.replaceRelation.relation, id: undefined }], 'user');
      if (!r) throw new Error('This relation is incomplete or its kind is unknown.');
      const p = problemOf(s, r, store.systems); if (p) throw new Error(p);
      const i = (s.relations ?? []).findIndex(x => x.id === rid(edit.replaceRelation!.id));
      if (i < 0) throw new Error('The relation to edit no longer exists.');
      const old = s.relations![i];
      // Any change to what was confirmed (direction, note or evidence) returns it to proposed: the editor says so, and a
      // confirmation of the old text must not silently cover the new one. An identical rewrite keeps the status.
      const same = old.kind === r.kind && old.from === r.from && old.to === r.to
        && (old.note ?? '') === (r.note ?? '') && JSON.stringify(old.evidence ?? []) === JSON.stringify(r.evidence ?? []);
      s.relations![i] = { ...r, status: same ? old.status : 'proposed', evidence: r.evidence };
    }
    for (const aid of edit.confirm?.areas ?? []) { const a = s.areas?.find(x => x.id === aid); if (a) a.status = 'confirmed'; }
    for (const id of edit.confirm?.relations ?? []) { const r = s.relations?.find(x => x.id === rid(id)); if (r) r.status = 'confirmed'; }
    if (edit.remove?.areas?.length) s.areas = (s.areas ?? []).filter(a => !edit.remove!.areas!.includes(a.id));
    if (edit.remove?.relations?.length) s.relations = (s.relations ?? []).filter(r => !edit.remove!.relations!.map(rid).includes(r.id));
    if (edit.adoptSuggestion !== undefined) {
      const sg = s.suggestions?.[edit.adoptSuggestion];
      if (sg) {
        s.anchors = { terms: uniq([...s.anchors.terms, ...sg.anchors.terms]), files: uniq([...s.anchors.files, ...sg.anchors.files]), decisions: uniq([...s.anchors.decisions, ...sg.anchors.decisions]) };
        mergeAreas(s, sg.payload?.areas ?? [], sg.payload?.relations ?? [], 'user');
        s.suggestions = s.suggestions!.filter((_, i) => i !== edit.adoptSuggestion);
      }
    }
    if (edit.ackVanished) s.vanished = [];
    if (edit.clearSuggestions) s.suggestions = [];
    s.updatedAt = now();
    return s;
  });
}

/** Fold `from` into `into`. The old id stays as a redirect so links and agent notes do not break. Areas and relations survive. */
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
      const rename = new Map<string, string>();
      for (const a of src.areas ?? []) {
        let aid = a.id;
        if (target.areas?.some(x => x.id === aid)) { aid = `${a.id}-${slug(src.name)}`; rename.set(a.id, aid); }
        (target.areas ??= []).push({ ...a, id: aid });
      }
      const fix = (ref: string) => ref.startsWith('area:') && rename.has(ref.slice(5)) ? `area:${rename.get(ref.slice(5))}` : ref;
      for (const r of src.relations ?? []) (target.relations ??= []).push({ ...r, id: target.relations?.some(x => x.id === r.id) ? `${r.id}-${slug(src.name)}` : r.id, from: r.from === 'self' ? 'self' : fix(r.from), to: fix(r.to) });
      src.status = 'merged'; src.mergedInto = target.id; src.updatedAt = now();
    }
    target.updatedAt = now();
    return target;
  });
}

/** Take some anchors out of a system into a new proposed one. A responsibility moves with them when ALL of its anchors moved. */
export function split(projectId: string, id: string, input: { name: string; terms?: string[]; files?: string[] }) {
  return mutate(projectId, store => {
    const src = store.systems.find(s => s.id === id);
    if (!src) return null;
    const terms = uniq(input.terms ?? []), files = uniq((input.files ?? []).map(posix));
    src.anchors.terms = src.anchors.terms.filter(t => !terms.includes(t));
    src.anchors.files = src.anchors.files.filter(f => !files.includes(f));
    const moves = (a: StoredArea) => {
      const fs_ = a.anchors.files.map(f => posix(f).split('#')[0]);
      const all = fs_.length > 0 && fs_.every(f => files.includes(f));
      const allT = fs_.length === 0 && a.anchors.terms.length > 0 && a.anchors.terms.every(t => terms.includes(t));
      return all || allT;
    };
    const movedAreas = (src.areas ?? []).filter(moves);
    src.areas = (src.areas ?? []).filter(a => !movedAreas.includes(a));
    const base = `sys-${slug(input.name) || 'split'}`;
    const nid = store.systems.some(s => s.id === base) ? `${base}-${Date.now().toString(36)}` : base;
    const movedIds = new Set(movedAreas.map(a => a.id));
    const mine = (r: StoredRelation) => r.from.startsWith('area:') && movedIds.has(r.from.slice(5));
    const movedRels = (src.relations ?? []).filter(mine);
    src.relations = (src.relations ?? []).filter(r => !mine(r));
    store.systems.push({
      id: nid, name: input.name.trim(), summary: '', responsibilities: [], status: 'proposed', origin: 'user',
      createdAt: now(), updatedAt: now(), anchors: { terms, files, decisions: [] }, related: [src.id],
      ...(movedAreas.length ? { areas: movedAreas } : {}), ...(movedRels.length ? { relations: movedRels } : {}),
    });
    src.updatedAt = now();
    return { id: nid };
  });
}

// ---- agent context ------------------------------------------------------------------------------

/**
 * Compact brief for Claude/Codex. Three kinds of statement are kept apart on purpose, so the agent never
 * promotes a guess: FACTS (git, verified evidence, DK as recorded), HYPOTHESES (inferred groupings, name-based
 * graph edges, candidate files) and DECISIONS (what a person confirmed, and what nobody has decided).
 * With `areaId` the brief narrows to one responsibility; everything else collapses to counts.
 */
export function brief(v: SystemView, goal?: string, areaId?: string): string {
  const L: string[] = [];
  const c = v.checkout;
  const area = areaId ? v.areas.find(a => a.id === areaId) : undefined;
  const ev = (e: sem.ResolvedEvidence) => `${e.resolvedPath ?? e.path}${e.line ? `:${e.line}` : ''} [${e.state}]${e.note ? ` — ${e.note}` : ''}`;
  L.push(`# System: ${v.name} (${v.id}) — ${v.kind}`);
  L.push(`Classification: ${v.status} (${v.origin}${v.confirmedAt ? `, confirmed ${v.confirmedAt.slice(0, 10)} on this installation` : ''}).${v.status !== 'confirmed' ? ' The grouping and the text below are NOT confirmed by a person.' : ''}`);
  if (v.summary) L.push(`Responsibility (${v.status === 'confirmed' ? 'confirmed text' : 'unconfirmed text'}): ${v.summary}`);
  if (area) L.push('', `## Selected responsibility: ${area.name} (${area.id})`, `${area.kind}, ${area.status}, evidence basis: ${area.basis}${area.inferred ? ' (INFERRED from file names, not a design judgement)' : ''}`, area.summary);
  L.push('', '## Checkout examined', `Root: ${c.root}`, `Branch: ${c.branch ?? '?'}  HEAD: ${c.head ?? '?'}  Uncommitted files: ${c.uncommitted}`,
    `${c.isCanonical ? 'This is the project checkout (not a worktree).' : 'This is a WORKTREE.'} Integration: ${c.integration}.`);

  L.push('', '## FACTS (verified now in this checkout, or recorded in git/DK)');
  L.push('Evidence matching verifies the cited text only; it does not prove a gameplay relation or approve a proposal.');
  L.push('', '## PROPOSED OR CONFIRMED CLASSIFICATIONS (review status separately from evidence)');
  const showAreas = area ? [area] : v.areas.filter(a => !a.inferred);
  if (showAreas.length) {
    L.push('Responsibilities:');
    for (const a of showAreas) {
      L.push(`- ${a.name} (${a.id}; ${a.kind}; ${a.status}; basis: ${a.basis}) — ${a.summary || 'no description'}`);
      for (const f of a.files.filter(x => x.tier === 'core').slice(0, area ? 10 : 3)) L.push(`    core: ${f.path}${f.line ? `:${f.line}` : ''}${f.uncommitted ? ' (uncommitted)' : ''}`);
      for (const e of a.evidence.slice(0, area ? 6 : 2)) L.push(`    evidence: ${ev(e)}`);
    }
  }
  const rels = area ? v.relations.filter(r => r.from.areaId === area.id || r.to.areaId === area.id) : v.relations;
  if (rels.length) {
    L.push('Gameplay relations (the basis checks cited text, not the truth of the relation):');
    for (const r of rels.slice(0, area ? 12 : 10)) {
      L.push(`- ${r.from.label} ${r.label} ${r.to.label} [${r.status}, basis ${r.basis}, ${r.direction}] ${r.evidence.slice(0, 2).map(ev).join('; ')}`);
    }
  }
  if (!area) {
    L.push('', '## FACTS: files located in this checkout');
    const core = v.members.filter(m => m.tier === 'core' && m.role !== 'test').slice(0, 12);
    L.push(`Core implementation (${v.tierCounts.core} core, ${v.tierCounts.participant} participants, ${v.tierCounts.test} tests, ${v.tierCounts.candidate} candidates):`);
    for (const m of core) {
      const syms = m.symbols.slice(0, 3).map(s => `${s.label}:${s.line}`).join(', ');
      L.push(`- ${m.path} [${m.facet}${m.uncommitted ? ', uncommitted' : ''}${m.changedSinceAnalysis ? ', changed since graph' : ''}${m.state === 'moved' ? `, moved from ${m.movedFrom}` : ''}]${syms ? ` — ${syms}` : ''}`);
    }
  }

  L.push('', '## DESIGN DECISIONS (Design Knowledge, as recorded — freshness is not approval)');
  if (!v.design.available) L.push(`Not indexed${v.design.reason ? `: ${v.design.reason}` : ''}.`);
  else if (!v.design.decisions.length) L.push("None recorded for this system.");
  for (const d of v.design.decisions.filter(x => x.relevance !== 'touches-member').slice(0, 8)) {
    L.push(`- ${d.id} "${d.title}"${d.origin === 'native' ? ' [proposal in the project file]' : ''} — decision: ${d.decisionState}; approval: ${d.approval?.state ?? 'unknown'} (${d.approval?.source ?? 'none'}); evidence: ${d.evidenceStatus}; implementation: ${d.implementation}`);
  }
  for (const k of v.comparisons) {
    L.push(`UNRESOLVED CONFLICT (${k.decisions.join(' vs ')}): do not pick a side; ask the owner.`);
    for (const col of k.columns) {
      L.push(`  ${k.numeric ? `Value ${col.key}` : col.key}: claimed by ${col.claimedBy.map(x => x.id).join(', ') || '—'}; ${col.implemented ? 'observed in code' : col.inTests ? 'appears in tests (a fixture or assertion, not proof the game does it)' : 'only declared'}`);
      for (const r of col.rows.slice(0, 4)) L.push(`    - ${r.label}: ${r.ref}${r.unit ? ` (unit stated in source: ${r.unit})` : ''}`);
    }
  }

  L.push('', '## HYPOTHESES (not facts: check in the code before relying on them)');
  if (v.areas.some(a => a.inferred)) L.push(`- Areas are inferred from file names/paths: ${v.areas.filter(a => a.inferred).map(a => `${a.name} (${a.fileCount})`).join(', ')}.`);
  for (const t of v.technical.slice(0, 6)) L.push(`- Technical link (code graph, NOT gameplay): ${v.name} ↔ ${t.toName} — ${Object.entries(t.relations).map(([k, n]) => `${k}×${n}`).join(', ')}; ${t.extracted} extracted / ${t.inferred} name-based guesses.`);
  const nb = v.neighbors.slice(0, area ? 4 : 6);
  if (nb.length) L.push(`- Technical neighbours: ${nb.map(n => `${n.path} (${n.relation}×${n.edges}, ${n.confidence === 'EXTRACTED' ? 'extracted' : 'name-based guess'})`).join('; ')}`);
  if (v.overlaps.length) L.push(`- Possibly the same thing as: ${v.overlaps.map(o => `${o.name} (${Math.round(o.ratio * 100)}% of files shared)`).join(', ')}.`);
  if (v.families.length) L.push(`- Generated resources (not individual members): ${v.families.slice(0, 3).map(f => `${f.label} ×${f.count}`).join(', ')}.`);
  for (const sg of v.suggestions) L.push(`- Pending agent suggestion (${sg.origin}, ${sg.at.slice(0, 10)}): ${sg.summary ?? ''}`);

  L.push('', '## LIMITATIONS');
  L.push(...v.limitations.map(l => `- ${l}`));
  if (v.maintenance.vanished.length) L.push(`- References that disappeared since an earlier resolution: ${v.maintenance.vanished.slice(0, 6).map(x => x.key).join('; ')}`);
  L.push('', `Go deeper with: MCP get_system {projectId, systemId: "${v.id}"}, get_design_context {file|query}, the Graphify Explorer. Tests were not run.`);
  if (goal) L.push('', '## Request', goal);
  return L.join('\n');
}
