import { join } from 'path';
import { mkdir, readFile } from 'fs/promises';
import { DATA_DIR } from './dataDir.js';
import { writeJsonAtomic } from './atomicJson.js';

/**
 * Human acceptance ledger (R2-A1): `data/task-lifecycle/{projectId}.json`.
 *
 * This is the ONLY thing the task lifecycle persists. Execution, delivery and
 * integration are derived from the task, the sessions and Git on every read.
 * Acceptance cannot be derived — it is a human act — so it is recorded here,
 * outside the task files on purpose: an agent that edits tasks through MCP
 * (`update_task`), a Trello/ClickUp pull (`replaceTasks`) or the cloud sync can
 * neither forge nor erase it. Machine-local: it is not in the cloud WATCHED set.
 *
 * An acceptance is bound to the exact commit that was reviewed (`headSha`). If
 * the branch moves, the acceptance no longer covers it (state `lapsed`).
 *
 * Same honesty limit as the Design Knowledge attestation: the route that writes
 * this is open only to requests that look like the app's own renderer, and any
 * local process can forge those headers. A record proves someone called the
 * route, not that a person clicked.
 */

export interface AcceptanceRecord {
  at: string;
  /** Always 'ui' today: the route refuses anything that is not the app renderer. */
  by: 'ui';
  branch: string;
  headSha: string;
  targetBranch: string;
  /** merge-base of target and branch when it was accepted. */
  baselineSha: string | null;
  note?: string;
}

export interface LifecycleEvent {
  at: string;
  event: 'accepted' | 'acceptance-revoked' | 'integrated' | 'integration-refused';
  detail?: Record<string, unknown>;
}

export interface LifecycleEntry {
  accepted?: AcceptanceRecord;
  integrated?: { at: string; targetBranch: string; mergeCommit: string; headSha: string; targetBefore: string };
  history: LifecycleEvent[];
}

interface LedgerFile { version: 1; tasks: Record<string, LifecycleEntry> }

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9._-]/g, '_');
const ledgerPath = (projectId: string) => join(DATA_DIR, 'task-lifecycle', `${safeId(projectId)}.json`);

const chains = new Map<string, Promise<unknown>>();
function withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(projectId) ?? Promise.resolve()).then(fn, fn);
  chains.set(projectId, run.catch(() => undefined));
  return run;
}

async function read(projectId: string): Promise<LedgerFile> {
  try {
    const parsed = JSON.parse(await readFile(ledgerPath(projectId), 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.tasks && typeof parsed.tasks === 'object') return parsed as LedgerFile;
  } catch { /* missing or unreadable: no acceptance on record */ }
  return { version: 1, tasks: {} };
}

async function write(projectId: string, file: LedgerFile): Promise<void> {
  await mkdir(join(DATA_DIR, 'task-lifecycle'), { recursive: true });
  await writeJsonAtomic(ledgerPath(projectId), file);
}

export async function getEntry(projectId: string, taskId: string): Promise<LifecycleEntry | undefined> {
  return (await read(projectId)).tasks[taskId];
}

export function mutate(projectId: string, taskId: string, fn: (entry: LifecycleEntry) => void): Promise<LifecycleEntry> {
  return withLock(projectId, async () => {
    const file = await read(projectId);
    const entry = file.tasks[taskId] ?? { history: [] };
    fn(entry);
    file.tasks[taskId] = entry;
    await write(projectId, file);
    return entry;
  });
}
