import { join } from 'path';
import { mkdir, readFile } from 'fs/promises';
import { DATA_DIR } from './dataDir.js';
import { writeJsonAtomic } from './atomicJson.js';
import type { Task } from '../types/index.js';

/**
 * Manual task <-> worktree links (R2-A2): `data/worktree-links/{projectId}.json`.
 *
 * A link says "this existing git worktree belongs to this task". It is only a
 * claim written by a person; Git stays the authority on whether the worktree
 * exists, which branch it has and what it holds. A link never touches the
 * worktree, the task file or the acceptance ledger — it lives in its own file so
 * an MCP `update_task`, a Trello pull or the cloud sync can neither forge nor
 * erase it, and a restart reads it back from disk.
 *
 * Same honesty limit as the acceptance ledger: the route that writes it only
 * serves requests that look like the app renderer, which any local process can forge.
 */

export interface WorktreeLink {
  taskId: string;
  /** Path exactly as `git worktree list` reported it when linked. */
  path: string;
  branch: string;
  /** HEAD of the worktree at link time: context only, never a claim about integration. */
  headAtLink: string;
  at: string;
  by: 'ui';
}

interface LinkFile { version: 1; links: Record<string, WorktreeLink> }

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9._-]/g, '_');
const linkPath = (projectId: string) => join(DATA_DIR, 'worktree-links', `${safeId(projectId)}.json`);

const chains = new Map<string, Promise<unknown>>();
function withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(projectId) ?? Promise.resolve()).then(fn, fn);
  chains.set(projectId, run.catch(() => undefined));
  return run;
}

async function read(projectId: string): Promise<LinkFile> {
  try {
    const parsed = JSON.parse(await readFile(linkPath(projectId), 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.links && typeof parsed.links === 'object') return parsed as LinkFile;
  } catch { /* missing or unreadable: no links on record */ }
  return { version: 1, links: {} };
}

export async function listLinks(projectId: string): Promise<WorktreeLink[]> {
  return Object.values((await read(projectId)).links);
}

export async function getLink(projectId: string, taskId: string): Promise<WorktreeLink | undefined> {
  return (await read(projectId)).links[taskId];
}

/** Run `fn` against the links under the project lock; it returns the new link set or leaves it (`undefined`). */
export function mutateLinks<T>(projectId: string, fn: (links: Record<string, WorktreeLink>) => T): Promise<T> {
  return withLock(projectId, async () => {
    const file = await read(projectId);
    const out = fn(file.links);
    await mkdir(join(DATA_DIR, 'worktree-links'), { recursive: true });
    await writeJsonAtomic(linkPath(projectId), file);
    return out;
  });
}

/** The task as the lifecycle should see it: a manual link fills in a worktree the task does not have itself. The task file is never written. */
export async function withLink(task: Task): Promise<Task> {
  if (task.worktreePath && task.worktreeBranch) return task;
  const link = await getLink(task.projectId, task.id);
  return link ? { ...task, worktreePath: task.worktreePath || link.path, worktreeBranch: task.worktreeBranch || link.branch } : task;
}
