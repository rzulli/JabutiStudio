import { join, resolve, isAbsolute, dirname } from 'path';
import { mkdir, stat } from 'fs/promises';
import * as gitService from './gitService.js';
import { canonicalPath } from './pathIdentity.js';
import * as taskStore from './taskStore.js';
import { getProjects } from './projectDiscovery.js';
import { getSettings, saveSettings } from './settingsStore.js';
import { DATA_DIR } from './dataDir.js';
import * as log from './logService.js';
import type { Project, Task } from '../types/index.js';

/**
 * Worktree per task.
 *
 * With the setting on, starting a task checks the repo out into its own
 * directory on its own branch. Several agents can then work on the same
 * project at once without overwriting each other's files or fighting over
 * which branch is checked out. The path lands on the task, and the terminal
 * opens there instead of in the project folder.
 */

export const DEFAULT_WORKTREE_DIR = join(DATA_DIR, 'worktrees');

/** After this many days a finished task's worktree is flagged `stale` (informational: nothing is removed by age). */
export const WORKTREE_TTL_DAYS = 7;

export interface WorktreeConfig {
  enabled: boolean;
  basePath: string;
  /** True when basePath comes from the setting rather than the default. */
  custom: boolean;
}

export function getConfig(): WorktreeConfig {
  const settings = getSettings();
  const raw = settings.worktreeBasePath?.trim();
  return {
    enabled: !!settings.worktreePerTask,
    basePath: raw ? resolve(raw) : DEFAULT_WORKTREE_DIR,
    custom: !!raw,
  };
}

export async function saveConfig(input: { enabled?: boolean; basePath?: string | null }): Promise<WorktreeConfig> {
  const next = { ...getSettings() };

  if (input.enabled !== undefined) next.worktreePerTask = !!input.enabled;

  if (input.basePath !== undefined) {
    const raw = (input.basePath || '').trim();
    if (!raw) {
      delete next.worktreeBasePath;
    } else {
      if (!isAbsolute(raw)) throw new Error('Worktree folder must be an absolute path');
      next.worktreeBasePath = resolve(raw);
    }
  }

  await saveSettings(next);
  return getConfig();
}

// -- Naming ---------------------------------------------------------------

const COMBINING_MARKS = /[̀-ͯ]/g;

function slugify(title: string): string {
  return title
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * Branch for a task: `shipyard/task-12-fix-login`. Two worktrees can never
 * share a branch, so the task number (or its id, for older tasks without one)
 * carries the uniqueness and the slug only makes it readable.
 */
export function branchNameFor(task: Task): string {
  const key = task.number ? String(task.number) : task.id;
  const slug = slugify(task.title);
  return `shipyard/task-${key}${slug ? `-${slug}` : ''}`;
}

/** Directory name: same shape as the branch, flattened for the filesystem. */
export function dirNameFor(projectId: string, task: Task): string {
  const key = task.number ? String(task.number) : task.id;
  const slug = slugify(task.title);
  return `${projectId}-task-${key}${slug ? `-${slug}` : ''}`;
}

// -- Creating and resolving -----------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A task that requires a worktree (the setting is on, or it already owns one) is never started anywhere else.
 * Creating or resolving it either yields a worktree path or throws CheckoutUnavailableError; the project folder is
 * never handed back as a substitute. Only a task with no worktree and the setting off keeps the project folder
 * (Direct Checkout), unchanged.
 */

/** A task whose worktree is required cannot be started: the reason is final and nothing was launched. */
export class CheckoutUnavailableError extends Error {
  constructor(readonly code: 'not-git' | 'worktree-missing' | 'create-failed' | 'checkout-mismatch', message: string) {
    super(message);
    this.name = 'CheckoutUnavailableError';
  }
}
export function isCheckoutUnavailable(e: unknown): e is CheckoutUnavailableError {
  return e instanceof CheckoutUnavailableError;
}

/** The task must run in its own worktree: the setting is on, or the task already owns one. */
export function requiresWorktree(task: Task): boolean {
  return getConfig().enabled || !!task.worktreePath;
}

/**
 * Last check before a process is spawned. A task that requires a worktree may only start in the worktree it records.
 * Throws otherwise; the caller must not spawn.
 */
export function assertLaunchCheckout(task: Task, cwd: string): void {
  if (!requiresWorktree(task)) return;
  if (!task.worktreePath || canonicalPath(cwd) !== canonicalPath(task.worktreePath)) {
    throw new CheckoutUnavailableError('checkout-mismatch', `The session would start in ${cwd}, which is not this task's worktree. Nothing was started.`);
  }
}

// One ensure at a time per task. A second launch of the same task waits and then reads the worktree the first one
// recorded, instead of creating a second one from a stale copy of the task.
const queues = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

/** A folder that Git itself links as a worktree has a `.git` file, not a directory. */
async function isLinkedWorktree(path: string): Promise<boolean> {
  try { return (await stat(join(path, '.git'))).isFile(); } catch { return false; }
}

export interface EnsureResult {
  path: string;
  branch?: string;
  created: boolean;
  /** Why the task kept the project path (Direct Checkout only). */
  reason?: string;
  /** The worktree was re-created after an explicit recovery request. */
  recovered?: boolean;
  /** What the recovery did and did not bring back. */
  recoveryNote?: string;
}

export interface EnsureOptions {
  /** Re-create a recorded worktree whose folder has gone, from its branch. Only when a person asked for it. */
  recover?: boolean;
}

export function ensureTaskWorktree(project: Project, task: Task, opts: EnsureOptions = {}): Promise<EnsureResult> {
  return serialize(`${project.id}:${task.id}`, async (): Promise<EnsureResult> => {
    const config = getConfig();
    const fresh = (await taskStore.getTask(task.projectId, task.id)) ?? task;
    if (!requiresWorktree(fresh)) return { path: project.path, created: false, reason: 'disabled' };
    if (!project.isGitRepo) {
      throw new CheckoutUnavailableError('not-git', 'The project is not a git repository, so this task cannot get a worktree. Nothing was started.');
    }

    if (fresh.worktreePath) {
      if (await isLinkedWorktree(fresh.worktreePath)) {
        return { path: fresh.worktreePath, branch: fresh.worktreeBranch, created: false };
      }
      if (!opts.recover) {
        throw new CheckoutUnavailableError('worktree-missing', `The worktree recorded for this task (${fresh.worktreePath}) is no longer there. Nothing was started, and the project folder was not used. Recover it explicitly to re-create it from its branch.`);
      }
      const branch = fresh.worktreeBranch || branchNameFor(fresh);
      const dest = fresh.worktreePath;
      try {
        await mkdir(dirname(dest), { recursive: true });
        await gitService.createWorktree(project.path, branch, dest);
      } catch (err: any) {
        log.error('git', 'Failed to recover task worktree', err?.message || String(err), project.id);
        throw new CheckoutUnavailableError('create-failed', `The worktree could not be re-created (${err?.message || 'git worktree add failed'}). Nothing was started.`);
      }
      await taskStore.updateTask(task.projectId, task.id, { worktreePath: dest, worktreeBranch: branch });
      log.info('git', `Worktree re-created for task #${task.number ?? task.id}`, `${branch} -> ${dest}`, project.id);
      return {
        path: dest, branch, created: true, recovered: true,
        recoveryNote: `Re-created from branch ${branch}. Only commits on that branch are back; uncommitted changes that were in the deleted folder are not recovered.`,
      };
    }

    const branch = fresh.worktreeBranch || branchNameFor(fresh);
    const dest = join(config.basePath, dirNameFor(project.id, fresh));
    try {
      await mkdir(config.basePath, { recursive: true });
      await gitService.createWorktree(project.path, branch, dest);
    } catch (err: any) {
      log.error('git', 'Failed to create task worktree', err?.message || String(err), project.id);
      throw new CheckoutUnavailableError('create-failed', `The worktree could not be created (${err?.message || 'git worktree add failed'}). Nothing was started, and the project folder was not used.`);
    }
    await taskStore.updateTask(task.projectId, task.id, { worktreePath: dest, worktreeBranch: branch });
    log.info('git', `Worktree created for task #${task.number ?? task.id}`, `${branch} -> ${dest}`, project.id);
    return { path: dest, branch, created: true };
  });
}

// -- Removing -------------------------------------------------------------

export interface RemoveOutcome {
  removed: boolean;
  /** Why nothing was removed (the first blocker), when `removed` is false. */
  reason?: string;
}

/**
 * Ask the safe close (R2-A2/A3) to drop a task's worktree and branch. There is
 * no other removal path: no `--force`, no `branch -D`, no recursive delete. The
 * close only runs when Git proves the task integrated and nothing would be lost;
 * otherwise the worktree stays exactly where it is (it shows as unlinked in the
 * inventory once the task is gone). Never throws.
 */
export async function removeTaskWorktree(
  task: Task,
  options: { project?: Project; clearTask?: boolean } = {},
): Promise<RemoveOutcome> {
  if (!task.worktreePath && !task.worktreeBranch) return { removed: false, reason: 'The task has no worktree' };
  try {
    const project = options.project || (await getProjects()).find(p => p.id === task.projectId);
    if (!project?.isGitRepo) return { removed: false, reason: 'Not a git project: nothing is removed without Git to prove it is safe' };
    const closer = await import('./worktreeClose.js');
    const preview = await closer.previewClose(project, task);
    if (!preview.allowed) {
      const reason = preview.blockers[0]?.message || 'The worktree cannot be closed safely';
      log.info('git', `Worktree of task #${task.number ?? task.id} kept`, reason, task.projectId);
      return { removed: false, reason };
    }
    const res = await closer.closeTask(project, task, { expectedToken: preview.token });
    if (!res.ok || !res.complete) {
      const reason = !res.ok ? res.message : 'Closed only partly; see the task lifecycle';
      return { removed: false, reason };
    }
    log.info('git', `Worktree closed for task #${task.number ?? task.id}`, task.worktreePath, task.projectId);
    return { removed: true };
  } catch (err: any) {
    log.error('git', 'Safe worktree close failed', err?.message || String(err), task.projectId);
    return { removed: false, reason: err?.message || 'Unexpected error' };
  }
}

/**
 * Gate for deleting a task (R2 consolidation). A task that still owns a worktree or
 * branch is the only record that explains why that worktree exists, so it may only be
 * deleted when nothing is left behind: either there is nothing on disk/in Git, or the
 * safe close (R2-A2) is allowed and completes. Otherwise the task stays and the caller
 * reports `reason`. Nothing is forced, removed or recorded to make a delete possible.
 * Must run BEFORE the task is deleted.
 */
export async function canDeleteTask(
  task: Task,
  options: { project?: Project } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { withLink } = await import('./worktreeLinks.js');
  const linked = await withLink(task);
  if (!linked.worktreePath && !linked.worktreeBranch) return { ok: true };
  try {
    const project = options.project || (await getProjects()).find(p => p.id === task.projectId);
    if (!project?.isGitRepo) return { ok: false, reason: 'This task has a worktree and the project is not a Git repository, so Shipyard cannot prove removing it is safe. Nothing was deleted.' };
    const closer = await import('./worktreeClose.js');
    const preview = await closer.previewClose(project, task);
    if (preview.mode === 'none') return { ok: true };
    if (!preview.allowed) {
      const why = preview.blockers.map(b => b.message).join('; ') || 'the worktree cannot be closed safely';
      return { ok: false, reason: `Task #${task.number ?? task.id} still owns a worktree that cannot be closed yet: ${why}. Resolve that (Review tab > Close worktree) before deleting the task. Nothing was deleted.` };
    }
    const res = await closer.closeTask(project, task, { expectedToken: preview.token });
    if (!res.ok) return { ok: false, reason: `The worktree could not be closed: ${res.message}. Nothing was deleted.` };
    if (!res.complete) return { ok: false, reason: 'The worktree was only partly closed (see the task lifecycle). The task was kept so it can be finished.' };
    log.info('git', `Worktree closed before deleting task #${task.number ?? task.id}`, task.worktreePath, task.projectId);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: `Could not verify the worktree is safe to close: ${err?.message || 'unexpected error'}. Nothing was deleted.` };
  }
}

// -- Listing and cleanup --------------------------------------------------

export interface WorktreeInfo {
  path: string;
  branch?: string;
  projectId: string;
  projectName?: string;
  taskId: string;
  taskNumber?: number;
  taskTitle: string;
  taskStatus: Task['status'];
  doneAt?: string;
  /** True when the recorded directory is no longer on disk. */
  missing: boolean;
  /** True when the automatic sweep would remove it on its next pass. */
  stale: boolean;
}

function isStale(task: Task, cutoff: number): boolean {
  if (task.status !== 'done') return false;
  const doneAt = task.doneAt ? Date.parse(task.doneAt) : NaN;
  // A done task with no usable doneAt falls back to updatedAt.
  const at = Number.isNaN(doneAt) ? Date.parse(task.updatedAt) : doneAt;
  return !Number.isNaN(at) && at < cutoff;
}

/** Every worktree Shipyard knows about, with the task that owns it. */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  const [tasks, projects] = await Promise.all([taskStore.getAllTasks(), getProjects()]);
  const byId = new Map(projects.map(p => [p.id, p]));
  const cutoff = Date.now() - WORKTREE_TTL_DAYS * 24 * 60 * 60 * 1000;

  const out: WorktreeInfo[] = [];
  for (const task of tasks) {
    if (!task.worktreePath) continue;
    out.push({
      path: task.worktreePath,
      branch: task.worktreeBranch,
      projectId: task.projectId,
      projectName: byId.get(task.projectId)?.name,
      taskId: task.id,
      taskNumber: task.number,
      taskTitle: task.title,
      taskStatus: task.status,
      doneAt: task.doneAt,
      missing: !(await exists(task.worktreePath)),
      stale: isStale(task, cutoff),
    });
  }
  return out.sort((a, b) => a.projectId.localeCompare(b.projectId) || (a.taskNumber ?? 0) - (b.taskNumber ?? 0));
}

export interface CleanupResult {
  /** Always 0: nothing is removed by a sweep any more. */
  removed: number;
  /** Stale git records (folder already gone) pruned. */
  pruned: number;
}

/**
 * The legacy sweep deleted worktrees by age or on request, with force, without
 * asking Git whether the work was integrated. It is gone (R2-A3). All that is
 * left is `git worktree prune`, which only forgets records of folders that no
 * longer exist. Removing a worktree is the safe close: `worktreeClose.closeTask`.
 */
export async function cleanupWorktrees(): Promise<CleanupResult> {
  const [tasks, projects] = await Promise.all([taskStore.getAllTasks(), getProjects()]);
  const byId = new Map(projects.map(p => [p.id, p]));
  const touched = new Set(tasks.filter(t => t.worktreePath).map(t => t.projectId));
  let pruned = 0;
  await Promise.all(
    [...touched].map(async id => {
      const project = byId.get(id);
      if (project?.isGitRepo) { await gitService.pruneWorktrees(project.path); pruned++; }
    }),
  );
  return { removed: 0, pruned };
}

// -- Scheduled sweep ------------------------------------------------------

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Run the age-based sweep shortly after boot and every six hours. Nothing
 * happens while the setting is off, so the timer costs nothing.
 */
export function startWorktreeCleanup(): void {
  const run = () => {
    if (!getConfig().enabled) return;
    cleanupWorktrees().catch(() => {});
  };
  setTimeout(run, 30_000).unref?.();
  setInterval(run, SWEEP_INTERVAL_MS).unref?.();
}
