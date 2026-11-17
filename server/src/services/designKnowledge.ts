import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { DATA_DIR } from './dataDir.js';
import { writeJsonAtomic } from './atomicJson.js';
import * as graphify from './graphifyAdapter.js';
import { canonicalPath } from './pathIdentity.js';

const run = promisify(execFile);

/**
 * Support services of the Design Knowledge Core: which checkouts may be examined, the Graphify relations of a
 * file and the local attestation ledger. There is no engine here and no Python: decisions are read, judged and
 * written by designCore/designDecisions from `jabutistudio.decisions.json` (R1-B3 retired dk.py).
 *
 * Approval exists only as an attestation in `data/design-approvals/{project}.json`, written by
 * `recordAttestation` — which the route only allows for a human action from the app's own UI.
 */

export interface DkProject { id: string; path: string }

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');
const ledgerPath = (projectId: string) => join(DATA_DIR, 'design-approvals', `${safeId(projectId)}.json`);

/** Same identity for 8.3 short names, separators and case (pathIdentity.ts) — never a bare string comparison. */
export const norm = canonicalPath;

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

type Json = Record<string, any>;

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

// ---- approvals ----------------------------------------------------------------------------------

type Ledger = { version: 1; approvals: Json[]; history: Json[] };
let chain: Promise<unknown> = Promise.resolve();
const withLock = <T,>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
};

export async function readLedger(projectId: string): Promise<Ledger> {
  try {
    const data = JSON.parse(await readFile(ledgerPath(projectId), 'utf-8'));
    return { version: 1, approvals: data.approvals ?? [], history: data.history ?? [] };
  } catch {
    return { version: 1, approvals: [], history: [] };
  }
}

export type AttestState = 'approved' | 'rejected' | 'revoked';

/**
 * Append an attestation to the local ledger. The quote is what the person typed or pasted in the dialog, bound to
 * the hash of the claim they were looking at: editing the claim afterwards lapses the approval. The route is
 * responsible for allowing this only from the app's own UI.
 */
export async function recordAttestation(project: DkProject, entry: Json) {
  await withLock(async () => {
    const ledger = await readLedger(project.id);
    ledger.approvals = [...ledger.approvals.filter(a => a.decision_id !== entry.decision_id), entry];
    ledger.history.push(entry);
    await mkdir(join(DATA_DIR, 'design-approvals'), { recursive: true });
    await writeJsonAtomic(ledgerPath(project.id), ledger);
  });
}
