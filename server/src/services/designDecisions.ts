import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { join, posix, relative, isAbsolute } from 'path';
import { z } from 'zod';
import { writeJsonAtomic } from './atomicJson.js';

/**
 * Native Design Knowledge store (R1-B1). One small versioned file in the game repository,
 * `jabutistudio.decisions.json`, so the knowledge travels with Git and needs no Python, no
 * `docs/design_knowledge/` and no engine inside the game. It holds claims and evidence only.
 *
 *  - Approval is NEVER stored here: `attested_local` lives in `data/design-approvals/` (see designKnowledge.ts).
 *  - Systems are referenced by id; the system catalog stays the owner of systems. No decision text is copied
 *    into `jabutistudio.systems.json`.
 *  - Freshness is derived on every read from the examined checkout (or revision); nothing derived is saved.
 */

const run = promisify(execFile);
export const DECISIONS_FILE = 'jabutistudio.decisions.json';

export const EVIDENCE_TYPES = ['code', 'test', 'document_claim', 'data', 'human_decision', 'runtime', 'playtest'] as const;
export type Freshness = 'CURRENT' | 'MOVED' | 'CHANGED' | 'AMBIGUOUS' | 'STALE' | 'GONE' | 'UNKNOWN';

const text = z.string().min(1).max(4000);
const safeRel = (p: string) => !!p && !p.includes('\\') && !p.startsWith('/') && !/^[a-z]:/i.test(p)
  && p.split('/').every(part => !!part && part !== '.' && part !== '..');
const relPath = z.string().max(500).refine(safeRel, 'Expected a relative checkout path');
const evidence = z.object({
  type: z.enum(EVIDENCE_TYPES), path: relPath, startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(), needle: z.string().min(1).max(500).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), note: z.string().max(1000).optional(),
  // Carried over from a legacy record (R1-B2). `candidateOnly` marks impact listings that do not support the claim.
  candidateOnly: z.boolean().optional(), relation: z.string().max(40).optional(),
  approvalScope: z.string().max(1000).optional(), approvedRule: z.string().max(1000).optional(),
}).strict();
const idRef = z.string().min(1).max(120);
const sha64 = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * What a migrated legacy record (dk.py) carried that the native shape has no field for. Stored verbatim so the
 * historic state is never reinterpreted: `decisionState`/`approvalState` are the record's own words, NOT an
 * approval (approval only ever comes from the local attestation ledger).
 */
export const legacyBlock = z.object({
  sourceRecord: relPath, sourceRecordSha256: sha64, createdAtKnown: z.boolean(),
  decisionState: z.string().max(40), approvalState: z.string().max(40), implementationState: z.string().max(40),
  implementationSources: z.array(z.object({ path: relPath, sha256: sha64 }).strict()),
  files: z.array(z.object({ path: relPath, role: z.string().max(1000) }).strict()),
  tests: z.array(relPath), qps: z.array(relPath), tags: z.array(z.string().max(120)),
}).strict();
export type LegacyBlock = z.infer<typeof legacyBlock>;
export const decisionSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{2,100}$/), title: text, claim: text,
  scope: z.array(z.string().max(120)), systems: z.array(idRef), files: z.array(relPath),
  evidence: z.array(evidence), conflictsWith: z.array(idRef), supersedes: z.array(idRef),
  origin: z.enum(['agent', 'user', 'legacy']), status: z.enum(['proposed', 'withdrawn']),
  createdAt: z.string(), updatedAt: z.string(), legacy: legacyBlock.optional(),
}).strict()
  .refine(d => d.evidence.length > 0 || d.origin === 'legacy', { message: 'At least one piece of evidence is required' })
  .refine(d => (d.origin === 'legacy') === !!d.legacy, { message: 'Only legacy-origin decisions carry a legacy block, and they must' });
export const decisionsSchema = z.object({
  version: z.literal(1), gitRoots: z.array(z.string().regex(/^[a-f0-9]{40,64}$/)).min(1), decisions: z.array(decisionSchema),
}).strict().superRefine((doc, ctx) => {
  if (new Set(doc.decisions.map(d => d.id)).size !== doc.decisions.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate decision ID' });
  // Operational paths never belong in portable knowledge, not even inside free text.
  const scan = (v: unknown): void => {
    if (typeof v === 'string' && /(?:^|[\s"'=(])(?:[a-z]:[\\/]|\\\\)/i.test(v)) ctx.addIssue({ code: 'custom', message: 'Absolute path in decisions file' });
    else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') Object.values(v).forEach(scan);
  };
  scan(doc.decisions);
});
export type NativeDecision = z.infer<typeof decisionSchema>;
export type NativeEvidence = z.infer<typeof evidence>;
export type DecisionsDoc = z.infer<typeof decisionsSchema>;

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

async function git(root: string, args: string[], buffer = false): Promise<any> {
  try { return (await run('git', ['-C', root, ...args], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8' })).stdout; }
  catch { return null; }
}

export const gitHead = async (root: string): Promise<string | null> => (await git(root, ['rev-parse', '--short', 'HEAD']))?.trim() || null;
/**
 * The repository's MAIN worktree (first entry of `git worktree list`): the integration reference. A worktree that was
 * registered as a project is NOT the integration checkout, so project.path cannot stand for it.
 */
export async function mainCheckout(root: string): Promise<{ root: string; head: string } | null> {
  const out = await git(root, ['worktree', 'list', '--porcelain']);
  const m = typeof out === 'string' ? /^worktree (.+)$/m.exec(out) : null;
  if (!m) return null;
  const main = m[1].trim();
  const head = (await git(main, ['rev-parse', 'HEAD']))?.trim();
  return head ? { root: main, head } : null;
}

/**
 * Where the decisions file stands in the examined checkout: 'local' (untracked or edited), 'committed' (tracked and
 * clean, but its last commit is not in the main checkout's branch), 'integrated' (that commit IS an ancestor of the main
 * checkout's HEAD), 'revision' (read from a commit). Replaces dk.py's per-record integration, which hard-coded one game's branch.
 */
export async function fileIntegration(root: string, _isCanonical: boolean, revision?: string): Promise<'local' | 'committed' | 'integrated' | 'revision' | 'unknown'> {
  if (revision) return 'revision';
  if ((await git(root, ['ls-files', '--error-unmatch', '--', DECISIONS_FILE])) === null) return 'local';
  const status = await git(root, ['status', '--porcelain', '--', DECISIONS_FILE]);
  if (status === null) return 'unknown';
  if (status.trim()) return 'local';
  const last = (await git(root, ['log', '-1', '--format=%H', '--', DECISIONS_FILE]))?.trim();
  const main = await mainCheckout(root);
  if (!last || !main) return 'unknown';
  return (await git(root, ['merge-base', '--is-ancestor', last, main.head])) !== null ? 'integrated' : 'committed';
}
export const gitBranch = async (root: string): Promise<string | null> => (await git(root, ['branch', '--show-current']))?.trim() || null;

/** First commits of the history: an id that stops a decisions file from one game being read in another. */
export async function historyRoots(root: string): Promise<string[]> {
  const roots = await git(root, ['rev-list', '--max-parents=0', 'HEAD']);
  const shallow = await git(root, ['rev-parse', '--is-shallow-repository']);
  if (!roots?.trim() || shallow?.trim() !== 'false') throw new Error('Decisions require a complete Git history');
  return roots.trim().split(/\r?\n/).sort();
}

export interface ReadResult {
  state: 'absent' | 'present' | 'invalid' | 'incompatible';
  reason?: string; sha256?: string; doc?: DecisionsDoc; revision?: string;
}

/** Read the decisions file of an examined checkout (working tree) or of a revision (git show, working tree ignored). */
export async function readDecisions(root: string, revision?: string): Promise<ReadResult> {
  let raw: Buffer | null = null;
  if (revision) {
    if (!/^[\w][\w./~^@{}-]*$/.test(revision)) return { state: 'invalid', reason: 'Invalid revision' };
    if (!(await git(root, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]))?.trim()) return { state: 'invalid', reason: `Unknown revision ${revision}` };
    raw = await git(root, ['show', `${revision}:${DECISIONS_FILE}`], true);
  } else {
    try {
      const file = join(root, DECISIONS_FILE);
      if ((await fs.lstat(file)).isSymbolicLink()) return { state: 'invalid', reason: 'Decisions file is a symlink' };
      raw = await fs.readFile(file);
    } catch (e: any) { if (e.code !== 'ENOENT') return { state: 'invalid', reason: String(e.message) }; }
  }
  if (!raw) return { state: 'absent' };
  try {
    const doc = decisionsSchema.parse(JSON.parse(raw.toString('utf8')));
    if (JSON.stringify(doc.gitRoots) !== JSON.stringify(await historyRoots(root)))
      return { state: 'incompatible', reason: 'Decisions belong to a different Git history', sha256: sha256(raw) };
    return { state: 'present', doc, sha256: sha256(raw), revision };
  } catch (e: any) {
    return { state: 'invalid', reason: String(e?.issues?.[0]?.message ?? e?.message ?? e).slice(0, 300), sha256: sha256(raw) };
  }
}

// ---- evidence ------------------------------------------------------------------------------------

export interface ResolvedEvidence extends NativeEvidence {
  ref: string; freshness: Freshness; detail: string; resolvedPath?: string; excerpt: { line: number; text: string }[];
  external?: { source: string; key: string; status: string; origin?: string };
}

/** Reads a checkout file without ever leaving the checkout (symlinks resolved), or a blob of a revision. */
export function makeReader(root: string, revision?: string, external?: (ev: NativeEvidence) => Promise<{ freshness: Freshness; detail: string; external: ResolvedEvidence['external']; excerpt: { line: number; text: string }[] }>) {
  let realRoot: string | undefined;
  const read = async (path: string): Promise<string | null> => {
    if (!safeRel(path)) return null;
    if (revision) { const b = await git(root, ['show', `${revision}:${path}`], true); return b ? (b as Buffer).toString('utf8') : null; }
    try {
      realRoot ??= await fs.realpath(root);
      const real = await fs.realpath(join(root, path));
      const rel = relative(realRoot, real);
      if (rel.startsWith('..') || isAbsolute(rel)) return null;
      const st = await fs.stat(real);
      return st.isFile() && st.size < 8 * 1024 * 1024 ? await fs.readFile(real, 'utf8') : null;
    } catch { return null; }
  };
  const list = async (): Promise<string[]> => {
    const out = revision ? await git(root, ['ls-tree', '-r', '--name-only', revision]) : await git(root, ['ls-files', '--cached', '--others', '--exclude-standard']);
    return out ? String(out).split(/\r?\n/).filter(Boolean) : [];
  };
  /** The committed version of `path` whose fingerprint is `expected` (LF or CRLF checkout), from the history of the examined ref. */
  const baseline = async (path: string, expected: string): Promise<string | null> => {
    if (!safeRel(path)) return null;
    const log = await git(root, ['log', '--format=%H', '-n', '80', ...(revision ? [revision] : []), '--', path]);
    for (const commit of String(log ?? '').split(/\s+/).filter(Boolean)) {
      const blob = await git(root, ['show', `${commit}:${path}`], true) as Buffer | null;
      if (!blob) continue;
      const crlf = Buffer.from(blob.toString('latin1').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'latin1');
      for (const v of [blob, crlf]) if (sha256(v) === expected) return v.toString('utf8');
    }
    return null;
  };
  return { read, list, baseline, external };
}
export type Reader = ReturnType<typeof makeReader>;

const excerptOf = (content: string, ev: NativeEvidence) => {
  const lines = content.split(/\r?\n/);
  let start = ev.startLine, end = ev.endLine ?? ev.startLine;
  if (!start && ev.needle) { const i = lines.findIndex(l => l.includes(ev.needle!)); if (i >= 0) { start = i + 1; end = i + 1; } }
  if (!start) return [];
  end = Math.min(Math.max(end ?? start, start), start + 5);
  return lines.slice(start - 1, end).map((t, i) => ({ line: start! + i, text: t.slice(0, 240) }));
};

/** Whitespace-insensitive units: blank lines and indentation are not evidence (same rule as the legacy dk.py). */
const normLines = (lines: string[]) => lines.map(l => l.trim()).filter(Boolean);

/**
 * Line-scoped fingerprint (legacy evidence: whole-file sha256 + cited lines, no needle). When the file differs,
 * find the recorded version in Git history and look for its cited block in the current file.
 */
async function locate(reader: Reader, ev: NativeEvidence, path: string, content: string): Promise<{ state: Freshness; detail: string; lines?: [number, number] }> {
  const first = ev.startLine!, last = ev.endLine ?? first;
  const baseline = await reader.baseline(path, ev.sha256!);
  if (baseline === null) return { state: 'STALE', detail: 'file changed and the recorded version is not in git history; cannot localize the cited lines' };
  const block = normLines(baseline.split(/\r?\n/).slice(first - 1, last));
  if (!block.length) return { state: 'UNKNOWN', detail: 'cited block was blank in the recorded version' };
  const indexed = content.split(/\r?\n/).map((t, i) => [i + 1, t.trim()] as const).filter(([, t]) => t);
  const hits: number[] = [];
  for (let k = 0; k + block.length <= indexed.length; k++) if (block.every((b, j) => indexed[k + j][1] === b)) hits.push(k);
  if (!hits.length) return { state: 'CHANGED', detail: 'the cited text no longer appears in the file' };
  if (hits.length > 1) return { state: 'AMBIGUOUS', detail: `the cited text appears ${hits.length} times` };
  const start = indexed[hits[0]][0], end = indexed[hits[0] + block.length - 1][0];
  if (start === first && end === last) return { state: 'CURRENT', detail: 'file edited elsewhere; cited lines unchanged', lines: [start, end] };
  return { state: 'MOVED', detail: `cited text moved from L${first}-L${last} to L${start}-L${end}`, lines: [start, end] };
}

export async function resolveEvidence(reader: Reader, ev: NativeEvidence): Promise<ResolvedEvidence> {
  const ref = ev.path + (ev.startLine ? `#L${ev.startLine}${ev.endLine && ev.endLine !== ev.startLine ? `-L${ev.endLine}` : ''}` : '');
  const base = { ...ev, ref, excerpt: [] as { line: number; text: string }[] };
  // A reference outside the checkout (e.g. `@economy_csv:row`, legacy): the native engine cannot read it, and says so.
  if (ev.path.startsWith('@')) {
    if (!reader.external) return { ...base, freshness: 'UNKNOWN', detail: 'external source: not verifiable here (a revision does not carry external files); nothing was verified', external: { source: ev.path.slice(1).split(':')[0], key: ev.path.split(':').slice(1).join(':'), status: 'unsupported' } };
    return { ...base, ...(await reader.external(ev)) };
  }
  let content = await reader.read(ev.path);
  let resolvedPath: string | undefined, moved = false;
  if (content === null) {
    // A move or rename: same extension elsewhere with the registered fingerprint, or (alone) the registered text.
    const name = posix.basename(ev.path), ext = posix.extname(ev.path);
    const cands = (await reader.list()).filter(p => p !== ev.path && posix.extname(p) === ext)
      .sort((x, y) => Number(posix.basename(y) === name) - Number(posix.basename(x) === name)).slice(0, 300);
    const byHash: string[] = [], byText: string[] = [];
    for (const cand of cands) {
      const c = await reader.read(cand);
      if (c === null) continue;
      if (ev.sha256 && sha256(c) === ev.sha256) byHash.push(cand);
      else if (ev.needle && c.includes(ev.needle)) byText.push(cand);
    }
    const found = byHash.length ? byHash : byText;
    if (found.length > 1) return { ...base, freshness: 'AMBIGUOUS', detail: `could now be ${found.slice(0, 3).join(', ')}` };
    if (found.length === 1) { content = await reader.read(found[0]); resolvedPath = found[0]; moved = true; }
    if (content === null) return { ...base, freshness: 'GONE', detail: 'file no longer exists' };
  }
  const excerpt = excerptOf(content, ev);
  const same = ev.sha256 ? sha256(content) === ev.sha256 : undefined;
  const needleOk = ev.needle ? content.includes(ev.needle) : undefined;
  let freshness: Freshness, detail: string;
  if (same === false && !ev.needle && ev.startLine) {
    const found = await locate(reader, ev, resolvedPath ?? ev.path, content);
    const ex = found.lines ? excerptOf(content, { ...ev, startLine: found.lines[0], endLine: found.lines[1] }) : [];
    return { ...base, freshness: moved && found.state === 'CURRENT' ? 'MOVED' : found.state, detail: found.detail + (moved ? `; file moved to ${resolvedPath}` : ''), resolvedPath, excerpt: ex };
  }
  if (needleOk === false) { freshness = 'STALE'; detail = 'the registered text is no longer in the file'; }
  else if (moved) { freshness = 'MOVED'; detail = `now at ${resolvedPath}`; }
  else if (same === false) { freshness = 'CHANGED'; detail = needleOk ? 'file changed; registered text still present' : 'file changed since registered'; }
  else if (same === true || needleOk === true) { freshness = 'CURRENT'; detail = same ? 'fingerprint matches' : 'registered text present'; }
  else { freshness = 'UNKNOWN'; detail = 'evidence has neither fingerprint nor text to verify'; }
  return { ...base, freshness, detail, resolvedPath, excerpt };
}

const SEVERITY: Freshness[] = ['GONE', 'STALE', 'AMBIGUOUS', 'CHANGED', 'MOVED', 'UNKNOWN', 'CURRENT'];
export const worstFreshness = (items: { freshness: Freshness }[]): Freshness =>
  items.length ? SEVERITY.find(s => items.some(i => i.freshness === s)) ?? 'UNKNOWN' : 'UNKNOWN';

// ---- writing -------------------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();
export const withLock = <T,>(fn: () => Promise<T>): Promise<T> => { const next = chain.then(fn, fn); chain = next.catch(() => undefined); return next; };

export interface ProposalInput {
  title: string; claim: string; scope?: string[]; systems?: string[]; files?: string[];
  evidence: { type: (typeof EVIDENCE_TYPES)[number]; path: string; startLine?: number; endLine?: number; needle?: string; note?: string }[];
  conflictsWith?: string[]; supersedes?: string[]; origin: 'agent' | 'user';
}

const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'decision';

/**
 * Append a proposal to the canonical checkout's file. A proposal is only ever `proposed`: there is no way to
 * write an approval through here. Every evidence file must exist in the checkout and every needle must be
 * found; the fingerprint is taken now so later drift is detectable.
 */
export async function addProposal(root: string, input: ProposalInput, knownIds: (id: string) => boolean | Promise<boolean>) {
  if (!input.title?.trim() || !input.claim?.trim()) return { ok: false as const, error: 'title and claim are required' };
  if (!input.evidence?.length) return { ok: false as const, error: 'At least one piece of evidence is required' };
  const reader = makeReader(root);
  const evs: NativeEvidence[] = [];
  for (const e of input.evidence) {
    if (!safeRel(e.path)) return { ok: false as const, error: `Invalid evidence path: ${e.path}` };
    const content = await reader.read(e.path);
    if (content === null) return { ok: false as const, error: `Evidence file not found in the checkout: ${e.path}` };
    if (e.needle && !content.includes(e.needle)) return { ok: false as const, error: `Text not found in ${e.path}: "${e.needle.slice(0, 60)}"` };
    if (e.startLine && e.startLine > content.split(/\r?\n/).length) return { ok: false as const, error: `Line ${e.startLine} is past the end of ${e.path}` };
    evs.push({ ...e, sha256: sha256(content) });
  }
  for (const f of input.files ?? []) if (!safeRel(f)) return { ok: false as const, error: `Invalid file path: ${f}` };
  return withLock(async () => {
    const cur = await readDecisions(root);
    if (cur.state === 'invalid' || cur.state === 'incompatible') return { ok: false as const, error: `Existing decisions file is ${cur.state}: ${cur.reason}` };
    let roots: string[];
    try { roots = await historyRoots(root); } catch (e: any) { return { ok: false as const, error: e.message }; }
    const doc: DecisionsDoc = cur.doc ?? { version: 1, gitRoots: roots, decisions: [] };
    for (const ref of [...(input.conflictsWith ?? []), ...(input.supersedes ?? [])])
      if (!doc.decisions.some(d => d.id === ref) && !(await knownIds(ref))) return { ok: false as const, error: `Unknown decision referenced: ${ref}` };
    const now = new Date().toISOString();
    const id = `dec-${slug(input.title)}-${sha256(input.claim + now).slice(0, 6)}`;
    const entry: NativeDecision = {
      id, title: input.title.trim(), claim: input.claim.trim(), scope: input.scope ?? [], systems: input.systems ?? [],
      files: [...new Set([...(input.files ?? []), ...evs.filter(e => e.type === 'code' || e.type === 'test').map(e => e.path)])],
      evidence: evs, conflictsWith: input.conflictsWith ?? [], supersedes: input.supersedes ?? [], origin: input.origin, status: 'proposed',
      createdAt: now, updatedAt: now,
    };
    const next = decisionsSchema.safeParse({ ...doc, decisions: [...doc.decisions, entry] });
    if (!next.success) return { ok: false as const, error: next.error.issues[0]?.message ?? 'Invalid decision' };
    await writeJsonAtomic(join(root, DECISIONS_FILE), next.data);
    return { ok: true as const, decision: entry };
  });
}

/** Save the human-selected supersession links without deleting any decision or rewriting its claim. */
export async function addSupersedes(root: string, decisionId: string, targets: string[], expectedClaimSha256: string) {
  return withLock(async () => {
    const cur = await readDecisions(root);
    if (cur.state !== 'present' || !cur.doc) return { ok: false as const, error: 'Native decisions are not readable' };
    const decision = cur.doc.decisions.find(d => d.id === decisionId);
    if (!decision) return { ok: false as const, error: `Decision ${decisionId} is not in the native decisions file` };
    if (sha256(decision.claim) !== expectedClaimSha256) return { ok: false as const, error: 'Decision text changed; reload the review before recording supersessions', code: 'claim-changed' as const };
    const ids = [...new Set(targets)];
    if (ids.includes(decisionId)) return { ok: false as const, error: 'A decision cannot supersede itself' };
    const unknown = ids.find(id => !cur.doc!.decisions.some(d => d.id === id));
    if (unknown) return { ok: false as const, error: `Decision ${unknown} is not in the native decisions file` };
    decision.supersedes = ids;
    decision.updatedAt = new Date().toISOString();
    const next = decisionsSchema.safeParse(cur.doc);
    if (!next.success) return { ok: false as const, error: next.error.issues[0]?.message ?? 'Invalid decision' };
    await writeJsonAtomic(join(root, DECISIONS_FILE), next.data);
    return { ok: true as const, decision };
  });
}
