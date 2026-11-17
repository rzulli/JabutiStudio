import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { z } from 'zod';
import { writeJsonAtomic } from './atomicJson.js';
import * as designKnowledge from './designKnowledge.js';
import * as catalog from './systemCatalog.js';
import { portableSchema, portableSystem } from './systemPortable.js';
import type { EvidenceState } from './systemSemantics.js';

/**
 * R1-A2: per-checkout reconciliation of design knowledge.
 *
 *   published in the examined revision (git)  +  local, unpublished work (data/systems/{id}.json)
 *   +  evidence re-verified in THAT checkout
 *
 * Reconciling is read-only: nothing here writes to the catalog, the repository or the portable file, and no side
 * is ever chosen silently. The only write is `updatePortable`, explicit and guarded by the content hash the
 * caller last saw. Independent of DK (dk.py) and of Graphify: it only needs git and the portable contract.
 */

const run = promisify(execFile);
type Portable = z.infer<typeof portableSchema>['systems'][number];

export type KnowledgeState =
  | 'published'             // identical to what the examined revision publishes
  | 'local-change'          // local work (or an uncommitted edit of the file) on top of the published value
  | 'diverged'              // both sides changed; neither is preferred
  | 'unpublished-proposal'  // a proposal that exists only locally
  | 'unavailable';          // this revision publishes no usable knowledge for it

export type FileState =
  | 'present'               // committed in the revision
  | 'modified'              // committed, but the working-tree file differs
  | 'untracked'             // only in the working tree, not in the revision
  | 'absent'                // not in this revision at all
  | 'invalid'               // exists but fails the contract / is a symlink
  | 'incompatible';         // belongs to a different Git history

export interface FieldChange { field: string; published: unknown; local: unknown }
export interface EvidenceCheck { owner: string; path: string; needle?: string; state: EvidenceState }
export interface ReconciledSystem {
  id: string; name: string; state: KnowledgeState;
  published: Portable | null;          // value in the examined revision
  workingFile: Portable | null;        // value in the uncommitted file, when it differs from the revision
  local: Portable | null;              // value in the local catalog
  changes: FieldChange[];              // published -> local, updatedAt excluded
  fileChanges: FieldChange[];          // published -> working file
  evidence: EvidenceCheck[];
  evidenceStale: boolean;
}
export interface Reconciliation {
  project: string;
  checkout: { root: string; isCanonical: boolean; branch?: string; head?: string; dirty: boolean | null };
  revision: { requested: string; commit: string; examinedWorkingTree: boolean };
  file: { state: FileState; reason?: string; revisionSha256?: string; workingSha256?: string; expectedSha256?: string;
    /** Worktrees only: how this checkout's committed file compares with the main checkout's HEAD. */
    integration?: 'same' | 'differs' | 'absent-in-main' };
  systems: ReconciledSystem[];
  limitations: string[];
}

async function git(root: string, args: string[]): Promise<string | null> {
  try { return (await run('git', ['-C', root, ...args], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })).stdout; }
  catch { return null; }
}
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const FILE = 'jabutistudio.systems.json';

/** `git show` on a blob keeps bytes; read as buffer so the hash matches the file on disk. */
async function showBlob(root: string, rev: string, path: string): Promise<Buffer | null> {
  try {
    const { stdout } = await run('git', ['-C', root, 'show', `${rev}:${path}`], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
    return stdout as unknown as Buffer;
  } catch { return null; }
}

async function parseDoc(root: string, raw: Buffer): Promise<{ doc?: Portable[]; state?: FileState; reason?: string }> {
  try {
    const doc = portableSchema.parse(JSON.parse(raw.toString('utf8')));
    if (JSON.stringify(doc.gitRoots) !== JSON.stringify(await catalog.portableGitRoot(root)))
      return { state: 'incompatible', reason: 'Portable catalog belongs to a different Git history' };
    await catalog.checkPortablePaths(root, doc.systems as any);
    return { doc: doc.systems };
  } catch (e: any) { return { state: 'invalid', reason: String(e?.message ?? e).slice(0, 300) }; }
}

async function readWorking(root: string): Promise<{ raw?: Buffer; symlink?: boolean }> {
  const file = join(root, FILE);
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) return { symlink: true };
    return { raw: await fs.readFile(file) };
  } catch (e: any) { if (e.code === 'ENOENT') return {}; throw e; }
}

const strip = (s: Portable) => { const { updatedAt: _u, ...rest } = s as any; return rest as Record<string, unknown>; };
function diff(a: Portable, b: Portable): FieldChange[] {
  const x = strip(a), y = strip(b);
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()
    .filter(k => JSON.stringify(x[k]) !== JSON.stringify(y[k])).map(field => ({ field, published: x[field], local: y[field] }));
}

async function checkEvidence(read: (p: string) => Promise<string | null>, s: Portable): Promise<EvidenceCheck[]> {
  const items: { owner: string; path: string; needle?: string }[] = [];
  for (const f of s.anchors.files) items.push({ owner: 'anchor', path: f.split('#')[0] });
  for (const a of s.areas ?? []) {
    for (const f of a.anchors.files) items.push({ owner: `area:${a.id}`, path: f.split('#')[0] });
    for (const e of a.evidence) items.push({ owner: `area:${a.id}`, path: e.path.split('#')[0], needle: e.needle });
  }
  for (const r of s.relations ?? []) for (const e of r.evidence) items.push({ owner: `relation:${r.id}`, path: e.path.split('#')[0], needle: e.needle });
  const cache = new Map<string, string | null>();
  const out: EvidenceCheck[] = [];
  for (const it of items) {
    if (!cache.has(it.path)) cache.set(it.path, await read(it.path));
    const text = cache.get(it.path)!;
    const state: EvidenceState = text === null ? 'missing' : !it.needle ? 'file-only' : text.includes(it.needle) ? 'verified' : 'stale';
    out.push({ ...it, state });
  }
  return out;
}

/** Compose published knowledge (git) + local catalog + evidence of the examined checkout. Read-only. */
export async function reconcile(project: { id: string; path: string }, opts: { worktree?: string; revision?: string } = {}): Promise<Reconciliation | { error: string }> {
  const root = await designKnowledge.resolveRoot(project, opts.worktree);
  if (typeof root !== 'string') return { error: root.error };
  const requested = opts.revision ?? 'HEAD';
  if (!/^[\w][\w./~^@{}-]*$/.test(requested)) return { error: 'Invalid revision' };
  const commit = (await git(root, ['rev-parse', '--verify', '--quiet', `${requested}^{commit}`]))?.trim();
  if (!commit) return { error: `Revision not found: ${requested}` };
  const explicitRevision = opts.revision !== undefined;
  const limitations: string[] = [];

  const isCanonical = designKnowledge.norm(root) === designKnowledge.norm(project.path);
  const [branch, head, status] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), git(root, ['rev-parse', '--short', 'HEAD']), git(root, ['status', '--porcelain']),
  ]);
  const dirty = status === null ? null : status.trim().length > 0;

  // published knowledge in the examined revision
  const committed = await showBlob(root, commit, FILE);
  let published: Portable[] | null = null;
  let fileState: FileState = 'absent'; let reason: string | undefined;
  if (committed) {
    const parsed = await parseDoc(root, committed);
    if (parsed.doc) { published = parsed.doc; fileState = 'present'; } else { fileState = parsed.state!; reason = parsed.reason; }
  }
  // uncommitted edits of the file only exist for the checkout itself, never for an explicit older revision
  let working: Portable[] | null = null; let workingSha: string | undefined;
  if (!explicitRevision) {
    const w = await readWorking(root);
    if (w.symlink) { fileState = 'invalid'; reason = 'Portable catalog cannot be a symlink'; }
    else if (w.raw) {
      workingSha = sha(w.raw);
      if (!committed || sha(committed) !== workingSha) {
        const parsed = await parseDoc(root, w.raw);
        if (parsed.doc) { working = parsed.doc; if (fileState === 'absent') fileState = 'untracked'; else if (fileState === 'present') fileState = 'modified'; }
        else { fileState = parsed.state!; reason = parsed.reason; }
      }
    }
  }
  if (explicitRevision) limitations.push('Explicit revision: uncommitted edits and the working tree file were not consulted; evidence is read from that revision.');
  if (!isCanonical) limitations.push('Graphify describes the canonical checkout only; it is not used as evidence for this worktree.');
  limitations.push('The local catalog is not versioned: it is shown as local work, never as published knowledge.');
  limitations.push('Local attestations are unverified and are never published as approval.');

  let locals: { id: string; sys: Portable | null }[] = [];
  for (const s of await catalog.listStored(project.id, true)) {
    try { locals.push({ id: s.id, sys: portableSystem(s) }); } catch { locals.push({ id: s.id, sys: null }); }
  }
  const read = async (p: string): Promise<string | null> => {
    if (explicitRevision) { const b = await showBlob(root, commit, p); return b ? b.toString('utf8') : null; }
    try { return await fs.readFile(join(root, p), 'utf8'); } catch { return null; }
  };

  const P = new Map((published ?? []).map(s => [s.id, s]));
  const F = new Map((working ?? []).map(s => [s.id, s]));
  const L = new Map(locals.map(l => [l.id, l.sys]));
  const ids = [...new Set([...P.keys(), ...F.keys(), ...L.keys()])];
  const systems: ReconciledSystem[] = [];
  for (const id of ids) {
    const p = P.get(id) ?? null, f = F.get(id) ?? null, l = L.get(id) ?? null;
    const same = (a: Portable, b: Portable) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));
    let state: KnowledgeState;
    if (L.has(id) && l === null) state = 'diverged';           // unreadable local record: do not guess
    else if (l && l.status === 'proposed' && !p && !f) state = 'unpublished-proposal';
    else if (!p && !f) state = published === null && !working ? 'unavailable' : 'local-change';
    else if (p && !f && (!l || same(p, l))) state = 'published';
    else if (p && l && !same(p, l) && !(f && same(f, l))) {
      // local differs from the revision: a newer local value is a local change, otherwise nobody is the base
      state = f ? 'diverged' : l.updatedAt > p.updatedAt ? 'local-change' : 'diverged';
    } else state = 'local-change';                              // file edit (or local value equal to it) over the revision
    if (state === 'local-change' && f && l && !same(f, l)) state = 'diverged';
    const basis = l ?? f ?? p;
    systems.push({
      id, name: (l ?? f ?? p)!.name, state, published: p, workingFile: f && !(p && same(p, f)) ? f : null, local: l,
      changes: p && l ? diff(p, l) : [], fileChanges: p && f ? diff(p, f) : [],
      evidence: [], evidenceStale: false,
    });
    const sys = systems[systems.length - 1];
    if (basis) {
      sys.evidence = await checkEvidence(read, basis);
      sys.evidenceStale = sys.evidence.some(e => e.state === 'stale' || e.state === 'missing');
    }
  }
  let integration: Reconciliation['file']['integration'];
  if (!isCanonical) {
    const main = await showBlob(project.path, 'HEAD', FILE);
    integration = !main ? 'absent-in-main' : committed && sha(main) === sha(committed) ? 'same' : 'differs';
  }
  return {
    project: project.id,
    checkout: { root, isCanonical, branch: branch?.trim(), head: head?.trim(), dirty },
    revision: { requested, commit, examinedWorkingTree: !explicitRevision },
    file: { state: fileState, reason, revisionSha256: committed ? sha(committed) : undefined, workingSha256: workingSha,
      expectedSha256: workingSha ?? (committed ? sha(committed) : undefined), integration },
    systems, limitations,
  };
}

// ---- explicit, guarded update of the existing portable file ---------------------------------------------

export type UpdateAction = 'add' | 'update' | 'unchanged' | 'needs-choice';
/** Single source of truth for what an update does to each system; the preview and the write both use it. */
function planUpdate(file: Portable[], stored: catalog.StoredSystem[], take: Set<string>) {
  return stored.map(s => {
    const next = portableSystem(s);
    const cur = file.find(x => x.id === s.id);
    let action: UpdateAction;
    if (!cur) action = 'add';
    else if (JSON.stringify(cur) === JSON.stringify(next)) action = 'unchanged';
    else if (next.updatedAt > cur.updatedAt || take.has(s.id)) action = 'update';
    else action = 'needs-choice';
    return { id: s.id, name: next.name, action, next, current: cur ?? null, changes: cur ? diff(cur, next) : [] };
  });
}

let publishChain: Promise<unknown> = Promise.resolve();
const serialized = <T,>(fn: () => Promise<T>): Promise<T> => { const n = publishChain.then(fn, fn); publishChain = n.catch(() => undefined); return n; };

export interface UpdateOptions {
  /** sha256 of the working-tree file as the caller last saw it (Reconciliation.file.expectedSha256). Required. */
  expectedSha256: string;
  /** Restrict the update to these system ids; default is every locally known system. */
  systemIds?: string[];
  /** Systems whose file value is newer or different and may be replaced by the local value. */
  takeLocal?: string[];
  /** updatedAt of each local system as the preview showed it; a different value means it changed since. */
  expectedLocal?: Record<string, string>;
}

/**
 * Replace/append local systems into the EXISTING portable file. Never creates it (use exportPortable), never
 * changes a status (a proposal stays a proposal), and refuses when the file changed since the caller looked,
 * or when a system's file value is not an ancestor of the local one and was not named in `takeLocal`.
 * The write is tmp + rename, so a failure leaves the previous content untouched.
 */
export async function updatePortable(project: { id: string; path: string }, opts: UpdateOptions): Promise<{ updated: string[]; unchanged: string[]; sha256: string }> {
  if (!/^[a-f0-9]{64}$/.test(opts.expectedSha256 ?? '')) throw new Error('expectedSha256 is required');
  return serialized(async () => {
    const file = catalog.portablePath(project.path);
    const current = async () => {
      if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Portable catalog cannot be a symlink');
      return fs.readFile(file);
    };
    const raw = await current();
    if (sha(raw) !== opts.expectedSha256) throw new Error('Portable catalog changed since it was read; reconcile again before updating');
    const doc = portableSchema.parse(JSON.parse(raw.toString('utf8')));
    if (JSON.stringify(doc.gitRoots) !== JSON.stringify(await catalog.portableGitRoot(project.path))) throw new Error('Portable catalog belongs to a different Git history');

    const stored = (await catalog.listStored(project.id, true)).filter(s => !opts.systemIds || new Set(opts.systemIds).has(s.id));
    for (const x of stored) {
      const seen = opts.expectedLocal?.[x.id];
      if (seen !== undefined && seen !== x.updatedAt) throw new Error(`Local system changed since the preview: ${x.id}; reconcile again before updating`);
    }
    const plan = planUpdate(doc.systems, stored, new Set(opts.takeLocal ?? []));
    const systems = [...doc.systems];
    const updated: string[] = [], unchanged: string[] = [], conflicts: string[] = [];
    for (const row of plan) {
      if (row.action === 'unchanged') unchanged.push(row.id);
      else if (row.action === 'needs-choice') conflicts.push(row.id);
      else {
        const i = systems.findIndex(x => x.id === row.id);
        if (i < 0) systems.push(row.next); else systems[i] = row.next;
        updated.push(row.id);
      }
    }
    if (conflicts.length) throw new Error(`Divergent systems need an explicit choice (takeLocal): ${conflicts.join(', ')}`);
    const out = portableSchema.parse({ version: 1, gitRoots: doc.gitRoots, systems });
    await catalog.checkPortablePaths(project.path, out.systems as any);
    if (!updated.length) return { updated, unchanged, sha256: sha(raw) };
    // last look before the swap: narrows (cannot eliminate) the window for an external writer
    if (sha(await current()) !== opts.expectedSha256) throw new Error('Portable catalog changed during the update; nothing was written');
    try { await writeJsonAtomic(file, out); }
    catch (e) { await fs.rm(`${file}.tmp`, { force: true }); throw e; }
    return { updated, unchanged, sha256: sha(await fs.readFile(file)) };
  });
}

// ---- previews: what an explicit export / update / import would do, computed without writing anything ------

export interface SystemDigest { id: string; name: string; status: string; origin: string; areas: number; relations: number; proposedItems: number }
const digest = (s: Portable): SystemDigest => ({
  id: s.id, name: s.name, status: s.status, origin: s.origin, areas: s.areas?.length ?? 0, relations: s.relations?.length ?? 0,
  proposedItems: [...(s.areas ?? []), ...(s.relations ?? [])].filter(x => x.status === 'proposed').length,
});

async function readExisting(project: { path: string }): Promise<{ raw: Buffer; systems: Portable[] } | { error: string } | null> {
  const w = await readWorking(project.path);
  if (w.symlink) return { error: 'Portable catalog cannot be a symlink' };
  if (!w.raw) return null;
  const parsed = await parseDoc(project.path, w.raw);
  return parsed.doc ? { raw: w.raw, systems: parsed.doc } : { error: parsed.reason ?? 'Portable catalog is not usable' };
}

/** Initial export: only offered when the file does not exist. Never writes. */
export async function previewExport(project: { id: string; path: string }) {
  const target = FILE;
  const existing = await readExisting(project);
  if (existing) return { target, canExport: false as const, reason: 'The portable file already exists; use update or import instead.', systems: [] as SystemDigest[] };
  try {
    const systems = (await catalog.listStored(project.id, true)).map(portableSystem);
    await catalog.portableGitRoot(project.path);
    await catalog.checkPortablePaths(project.path, systems as any);
    return { target, canExport: systems.length > 0, reason: systems.length ? undefined : 'There are no systems to publish yet.', systems: systems.map(digest) };
  } catch (e: any) {
    return { target, canExport: false as const, reason: String(e?.message ?? e).slice(0, 300), systems: [] as SystemDigest[] };
  }
}

/** Update of the existing file: per-system action with field changes (`published` = value in the file). */
export async function previewUpdate(project: { id: string; path: string }) {
  const existing = await readExisting(project);
  if (!existing) return { exists: false as const };
  if ('error' in existing) return { exists: true as const, error: existing.error };
  const stored = await catalog.listStored(project.id, true);
  const rows = planUpdate(existing.systems, stored, new Set()).map(({ next, current, ...r }) => ({
    ...r, status: next.status, origin: next.origin, file: current, local: next,
  }));
  const localIds = new Set(stored.map(s => s.id));
  return {
    exists: true as const, sha256: sha(existing.raw), rows,
    fileOnly: existing.systems.filter(s => !localIds.has(s.id)).map(digest),
  };
}

export interface ImportItem extends SystemDigest {
  kind: catalog.ImportKind; against?: string; changes: { field: string; current: unknown; incoming: unknown }[]; evidenceStale: boolean;
  /** A proposal stays a proposal on import; confirmed systems keep the provenance recorded in the file. */
  provenance?: string;
}

/** Import preview: classifies every system of the file against the local catalog, with the importer's own rules. */
export async function previewImport(project: { id: string; path: string }) {
  const existing = await readExisting(project);
  if (!existing) return { exists: false as const };
  if ('error' in existing) return { exists: true as const, error: existing.error };
  const stored = await catalog.listStored(project.id, true);
  const read = async (p: string): Promise<string | null> => { try { return await fs.readFile(join(project.path, p), 'utf8'); } catch { return null; } };
  const items: ImportItem[] = [];
  for (const s of existing.systems) {
    const c = catalog.classifyPortableImport(stored, s);
    const against = c.against ? stored.find(x => x.id === c.against) : undefined;
    const evidence = c.kind === 'new' ? await checkEvidence(read, s) : [];
    items.push({
      ...digest(s), kind: c.kind, against: c.against,
      changes: c.kind === 'changed' && against ? diff(portableSystem(against), s).map(f => ({ field: f.field, current: f.published, incoming: f.local })) : [],
      evidenceStale: evidence.some(e => e.state === 'stale' || e.state === 'missing'),
      provenance: s.confirmedAt ? `confirmed ${s.confirmedAt.slice(0, 10)}${s.confirmedVia ? ' via UI' : ''}` : undefined,
    });
  }
  const conflicts = items.filter(i => i.kind === 'changed' || i.kind === 'duplicate').length;
  return {
    exists: true as const, sha256: sha(existing.raw), items, conflicts,
    importable: items.filter(i => i.kind === 'new').length, safe: conflicts === 0,
  };
}

export const portableSha256 = async (project: { path: string }): Promise<string | null> => {
  const w = await readWorking(project.path);
  return w.raw ? sha(w.raw) : null;
};
