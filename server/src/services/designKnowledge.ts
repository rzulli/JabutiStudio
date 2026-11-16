import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, realpathSync } from 'fs';
import { mkdir, readFile } from 'fs/promises';
import { join, resolve, relative, sep } from 'path';
import { DATA_DIR } from './dataDir.js';
import { writeJsonAtomic } from './atomicJson.js';
import * as graphify from './graphifyAdapter.js';

const run = promisify(execFile);

/**
 * Design Knowledge bridge. The decisions and the CLI (`tools/design_knowledge/dk.py`) belong to the
 * project, so a game stays understandable without this app; this service only calls it, adds what the
 * project cannot know (the examined worktree, the Graphify relations, who approved) and caches briefly.
 *
 * Authority rules (see CLAUDE.md "Design Knowledge"):
 *  - decisions and evidence come from the project's registry, read from the canonical checkout;
 *  - freshness is judged in the worktree under review (`root`), so a task's code never contaminates
 *    the integrated state;
 *  - approval exists only as an attestation in `data/design-approvals/{project}.json`, written by
 *    `attest()` — which the route only allows for a human action from the app's own UI.
 */

export interface DkProject { id: string; path: string }

const DK_REL = join('tools', 'design_knowledge', 'dk.py');
const RECORDS_REL = join('docs', 'design_knowledge', 'records');
const TIMEOUT_MS = 20_000;

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');
const ledgerPath = (projectId: string) => join(DATA_DIR, 'design-approvals', `${safeId(projectId)}.json`);
// realpath: git reports long Windows paths while callers may hold the 8.3 short form of the same folder
export const norm = (p: string) => {
  let full = resolve(p);
  try { full = realpathSync.native(full); } catch { /* path may not exist yet */ }
  return full.replace(/[\\/]+$/, '').toLowerCase();
};

export const hasRegistry = (projectPath: string) =>
  existsSync(join(projectPath, DK_REL)) && existsSync(join(projectPath, RECORDS_REL));

// ---- python -------------------------------------------------------------------------------------

let pythonCmd: string | null | undefined;
async function python(): Promise<string | null> {
  if (pythonCmd !== undefined) return pythonCmd;
  const candidates = [process.env.SHIPYARD_PYTHON, 'python', 'python3', 'py'].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      await run(c, ['-I', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], { timeout: 8000 });
      return (pythonCmd = c);
    } catch { /* try the next one */ }
  }
  return (pythonCmd = null);
}
export const resetPythonCache = () => { pythonCmd = undefined; };

// ---- worktrees ----------------------------------------------------------------------------------

/** Only checkouts git itself lists for the project can be examined — never an arbitrary path. */
export async function listCheckouts(projectPath: string): Promise<{ path: string; branch?: string }[]> {
  try {
    const { stdout } = await run('git', ['-C', projectPath, 'worktree', 'list', '--porcelain'], { timeout: 8000 });
    const out: { path: string; branch?: string }[] = [];
    for (const block of stdout.split(/\r?\n\r?\n/)) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (path) out.push({ path, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] });
    }
    return out;
  } catch {
    return [{ path: projectPath }];
  }
}

export async function resolveRoot(project: DkProject, worktree?: string): Promise<string | { error: string }> {
  if (!worktree || norm(worktree) === norm(project.path)) return project.path;
  const known = (await listCheckouts(project.path)).find(c => norm(c.path) === norm(worktree));
  return known ? known.path : { error: 'Not a git worktree of this project' };
}

// ---- which dk.py ---------------------------------------------------------------------------------

/**
 * The records are canonical in the project checkout, but the CLI that reads them may be older there than
 * in a sibling worktree (a hardening branch not merged yet). Use the project's own script when it speaks
 * `--approvals`; otherwise the newest-looking one among the checkouts git lists. Never merges anything.
 */
const cliCache = new Map<string, { at: number; script: string }>();
const speaksApprovals = async (script: string) => {
  try { return (await readFile(script, 'utf-8')).includes('--approvals'); } catch { return false; }
};
async function dkScript(project: DkProject): Promise<string> {
  const hit = cliCache.get(project.path);
  if (hit && Date.now() - hit.at < 60_000) return hit.script;
  let script = join(project.path, DK_REL);
  if (!(await speaksApprovals(script))) {
    for (const c of await listCheckouts(project.path)) {
      const candidate = join(c.path, DK_REL);
      if (await speaksApprovals(candidate)) { script = candidate; break; }
    }
  }
  cliCache.set(project.path, { at: Date.now(), script });
  return script;
}

// ---- running dk.py ------------------------------------------------------------------------------

type Json = Record<string, any>;
const cache = new Map<string, { at: number; value: Json }>();
const CACHE_MS = 5000;

async function dk(project: DkProject, command: string[], root: string): Promise<Json> {
  const py = await python();
  if (!py) return { available: false, reason: 'Python 3.9+ was not found (set SHIPYARD_PYTHON)' };
  if (!hasRegistry(project.path)) {
    return { available: false, reason: 'This project has no Design Knowledge registry (tools/design_knowledge + docs/design_knowledge/records)' };
  }
  const key = [project.id, root, ...command].join('\u0000');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const args = ['-I', await dkScript(project), command[0], ...command.slice(1),
    '--root', root, '--records', join(project.path, RECORDS_REL), '--json'];
  const ledger = ledgerPath(project.id);
  if (existsSync(ledger)) args.push('--approvals', ledger);
  let stdout: string;
  try {
    ({ stdout } = await run(py, args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
  } catch (err: any) {
    // `validate` exits 1 with a JSON body when the registry has errors; keep that body.
    if (typeof err.stdout === 'string' && err.stdout.trim().startsWith('{')) stdout = err.stdout;
    else return { available: false, reason: String(err.stderr || err.message || 'dk.py failed').split('\n').slice(0, 3).join(' ') };
  }
  const value = { available: true, ...JSON.parse(stdout) } as Json;
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ---- queries ------------------------------------------------------------------------------------

const toRel = (root: string, file: string) => {
  const rel = relative(root, resolve(root, file));
  return rel.split(sep).join('/');
};

/** Importers/imports of a file according to Graphify, with the confidence of each relation. */
export async function graphRelations(projectId: string, file: string) {
  const g = await graphify.loadGraph(projectId).catch(() => null);
  if (!g) return { built: false as const, incoming: [], outgoing: [] };
  const node = [...g.nodes.values()].find(n => n.kind === 'file' && n.file === file);
  if (!node) return { built: true as const, builtAt: g.builtAt, incoming: [], outgoing: [] };
  const fileOf = (id: string) => g.nodes.get(id)?.file || g.nodes.get(id)?.label || id;
  const rows = (edges: graphify_Edge[] | undefined, side: 'from' | 'to') => (edges ?? [])
    .filter(e => e.relation !== 'contains' && e.relation !== 'method')
    .map(e => ({ file: fileOf(e[side]), relation: e.relation, confidence: e.confidence, line: e.line }));
  return { built: true as const, builtAt: g.builtAt, incoming: rows(g.inn.get(node.id), 'from'), outgoing: rows(g.out.get(node.id), 'to') };
}
type graphify_Edge = import('./graphifyAdapter.js').GEdge;

export async function contextForFile(project: DkProject, file: string, worktree?: string) {
  const root = await resolveRoot(project, worktree);
  if (typeof root !== 'string') return { available: false, reason: root.error };
  const rel = toRel(root, file);
  if (rel.startsWith('..')) return { available: false, reason: 'File is outside the examined checkout' };
  const [dkRes, graph] = await Promise.all([dk(project, ['file', rel], root), graphRelations(project.id, rel)]);
  return withProvenance(project, root, { ...dkRes, graph });
}

export async function contextForQuery(project: DkProject, q: string, worktree?: string) {
  const root = await resolveRoot(project, worktree);
  if (typeof root !== 'string') return { available: false, reason: root.error };
  return withProvenance(project, root, await dk(project, ['query', q], root));
}

export async function validateRegistry(project: DkProject, worktree?: string) {
  const root = await resolveRoot(project, worktree);
  if (typeof root !== 'string') return { available: false, reason: root.error };
  return dk(project, ['validate'], root);
}

/**
 * Which state is shown: the registry always comes from the canonical checkout, the evidence from
 * `root`. When they differ the response says so, so a task's worktree is never read as "integrated".
 */
function withProvenance(project: DkProject, root: string, res: Json): Json {
  return { ...res, examined: { root, isCanonical: norm(root) === norm(project.path), registry: project.path } };
}

// ---- approvals ----------------------------------------------------------------------------------

type Ledger = { version: 1; approvals: Json[]; history: Json[] };
let chain: Promise<unknown> = Promise.resolve();
const withLock = <T,>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
};

async function readLedger(projectId: string): Promise<Ledger> {
  try {
    const data = JSON.parse(await readFile(ledgerPath(projectId), 'utf-8'));
    return { version: 1, approvals: data.approvals ?? [], history: data.history ?? [] };
  } catch {
    return { version: 1, approvals: [], history: [] };
  }
}

export type AttestState = 'approved' | 'rejected' | 'revoked';

/**
 * Record a human decision. The quote is what the person typed or pasted in the dialog, bound to the
 * hash of the claim text they were looking at: editing the claim afterwards lapses the approval.
 * The route is responsible for allowing this only from the app's own UI.
 */
export async function attest(project: DkProject, input: { decisionId: string; state: AttestState; quote: string }, worktree?: string) {
  const quote = input.quote.trim();
  if (quote.length < 3) return { ok: false as const, error: 'A quote of what was decided is required' };
  const root = project.path; // decisions are canonical: always read from the registry checkout
  const res = await dk(project, ['query', input.decisionId], root);
  const found = (res.decisions as Json[] | undefined)?.find(d => d.id === input.decisionId);
  if (!found) return { ok: false as const, error: `Decision ${input.decisionId} not found` };
  const entry = {
    decision_id: input.decisionId, state: input.state, claim_sha256: found.claim_sha256, quote,
    channel: 'ui-request', trust: 'attested_local', at: new Date().toISOString(), projectId: project.id,
  };
  await withLock(async () => {
    const ledger = await readLedger(project.id);
    ledger.approvals = [...ledger.approvals.filter(a => a.decision_id !== input.decisionId), entry];
    ledger.history.push(entry);
    await mkdir(join(DATA_DIR, 'design-approvals'), { recursive: true });
    await writeJsonAtomic(ledgerPath(project.id), ledger);
  });
  cache.clear();
  return { ok: true as const, entry };
}

export const clearCache = () => cache.clear();
