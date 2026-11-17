import { stat } from 'fs/promises';
import * as git from './gitService.js';
import * as taskStore from './taskStore.js';
import * as links from './worktreeLinks.js';
import * as lifecycle from './taskLifecycle.js';
import { classifyChanges } from './worktreeChanges.js';
import { liveSessions, previewClose, sessionsHolding } from './worktreeClose.js';
import { canonicalPath } from './pathIdentity.js';
import type { Blocker, SessionLite } from './taskLifecycle.js';
import type { Project, Task } from '../types/index.js';

/**
 * Unified worktree inventory (R2-A2).
 *
 * The rows come from `git worktree list --porcelain`, so worktrees made by hand or by
 * other agents appear next to the ones Shipyard made. Each row is joined, never
 * guessed, with: the task that owns it (a worktree the task itself recorded, or a
 * link a person made), the lifecycle verdict for that task, what is changed in the
 * folder, and the sessions that hold it.
 *
 * The flags are independent facts, not one status: a worktree can be linked AND
 * dirty AND unmerged. "Unlinked" does not mean orphan, and clean does not mean safe
 * to remove — `cleanup` says whether the close would run and, if not, why.
 */

export interface InventoryFlags {
  taskLinked: boolean;
  unlinked: boolean;
  integrated: boolean;
  unmerged: boolean;
  dirty: boolean;
  busy: boolean;
  unknown: boolean;
}

export interface InventoryEntry {
  path: string;
  isMain: boolean;
  exists: boolean;
  branch: string | null;
  head: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  task: null | {
    id: string; number?: number; title: string; status: Task['status'];
    /** `shipyard`: the task recorded this worktree itself. `manual`: a person linked it. */
    origin: 'shipyard' | 'manual';
    stage: lifecycle.Stage;
    integration: lifecycle.LifecycleView['integration']['state'];
    acceptance: lifecycle.LifecycleView['acceptance']['state'];
  };
  /** Other tasks that also claim this folder. Never resolved silently. */
  collisions: { id: string; number?: number; title: string; origin: 'shipyard' | 'manual' }[];
  /** The branch the unmerged count is measured against, and why. */
  comparedTo: { branch: string | null; reason: 'accepted-target' | 'main-checkout-branch' };
  /** Commits in this worktree's HEAD that are not in `comparedTo`. null = could not be measured. */
  unmergedCommits: number | null;
  changes: null | { total: number; staged: number; modified: number; untracked: number; deleted: number; renamed: number; conflicted: number };
  sessions: SessionLite[];
  flags: InventoryFlags;
  /** Would closing this worktree run? `blockers` is the answer to "why not". */
  cleanup: { allowed: boolean; needsAcknowledgement: boolean; blockers: Blocker[] };
}

export interface Inventory {
  projectId: string;
  checkout: { path: string; branch: string | null; head: string | null };
  worktrees: InventoryEntry[];
  summary: { total: number; taskLinked: number; unlinked: number; integrated: number; unmerged: number; dirty: number; busy: number; unknown: number; closable: number };
  generatedAt: string;
}

const CACHE_TTL_MS = 8000;
const cache = new Map<string, { at: number; value: Promise<Inventory> }>();
export function invalidateInventory(projectId: string): void { cache.delete(projectId); }

async function dirExists(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

type Claim = { task: Task; origin: 'shipyard' | 'manual' };

/** Who claims each folder: tasks that recorded it, and links people made. */
async function claimsByPath(project: Project): Promise<Map<string, Claim[]>> {
  const [tasks, ls] = await Promise.all([taskStore.getTasks(project.id), links.listLinks(project.id)]);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const out = new Map<string, Claim[]>();
  const push = (path: string, c: Claim) => {
    const k = canonicalPath(path);
    const list = out.get(k) ?? [];
    if (!list.some(x => x.task.id === c.task.id)) list.push(c);
    out.set(k, list);
  };
  for (const t of tasks) if (t.worktreePath) push(t.worktreePath, { task: t, origin: 'shipyard' });
  for (const l of ls) { const t = byId.get(l.taskId); if (t) push(l.path, { task: t, origin: 'manual' }); }
  return out;
}

export function inventory(project: Project): Promise<Inventory> {
  const hit = cache.get(project.id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = compute(project);
  cache.set(project.id, { at: Date.now(), value });
  value.catch(() => cache.delete(project.id));
  return value;
}

async function compute(project: Project): Promise<Inventory> {
  const list = project.isGitRepo ? await git.listWorktrees(project.path) : [];
  const checkoutBranch = project.isGitRepo ? await git.currentBranch(project.path) : null;
  const checkoutHead = project.isGitRepo ? await git.resolveRef(project.path, 'HEAD') : null;
  const claims = await claimsByPath(project);
  const sessions = await liveSessions();
  const mainCanon = list[0] ? canonicalPath(list[0].path) : canonicalPath(project.path);

  const worktrees = await mapLimit(list, 4, async (w, index): Promise<InventoryEntry> => {
    const canon = canonicalPath(w.path);
    const isMain = index === 0 || canon === mainCanon;
    const exists = await dirExists(w.path);
    const owners = claims.get(canon) ?? [];
    const primary = owners.find(c => c.origin === 'shipyard') ?? owners[0];
    const collisions = owners.filter(c => c !== primary).map(c => ({ id: c.task.id, number: c.task.number, title: c.task.title, origin: c.origin }));

    // Lifecycle of the owning task (the same read the Review tab uses).
    let task: InventoryEntry['task'] = null;
    let acceptedTarget: string | null = null;
    if (primary && !isMain) {
      const effective = await links.withLink(primary.task);
      const mine = sessionsHolding(sessions, primary.task.id, exists ? w.path : null);
      const view = await lifecycle.resolveLifecycle(project, effective, { sessions: mine });
      acceptedTarget = view.acceptance.record?.targetBranch ?? null;
      task = {
        id: primary.task.id, number: primary.task.number, title: primary.task.title, status: primary.task.status, origin: primary.origin,
        stage: view.stage, integration: view.integration.state, acceptance: view.acceptance.state,
      };
    }

    const compareBranch = acceptedTarget ?? checkoutBranch;
    const compareHead = compareBranch ? await git.resolveRef(project.path, `refs/heads/${compareBranch}`) : null;
    const unmergedCommits = w.head && compareHead && !isMain ? await git.countAhead(project.path, compareHead, w.head) : null;

    let changes: InventoryEntry['changes'] = null;
    if (exists && !w.bare && !w.prunable) {
      const st = await git.statusEntries(w.path);
      if (st.ok) {
        const c = { total: st.entries.length, staged: 0, modified: 0, untracked: 0, deleted: 0, renamed: 0, conflicted: 0 };
        for (const e of st.entries) for (const k of e.kinds) c[k]++;
        changes = c;
      }
    }
    const holding = sessionsHolding(sessions, primary?.task.id ?? null, exists ? w.path : null);

    let cleanup: InventoryEntry['cleanup'];
    if (isMain) cleanup = { allowed: false, needsAcknowledgement: false, blockers: [{ code: 'main-checkout', message: 'This is the main checkout of the project. It is never removed by task cleanup' }] };
    else if (!primary) cleanup = { allowed: false, needsAcknowledgement: false, blockers: [{ code: 'unlinked', message: 'No task owns this worktree, so nothing here can prove it is finished. Link it to a task to review it' }] };
    else if (collisions.length) cleanup = { allowed: false, needsAcknowledgement: false, blockers: [{ code: 'claimed-twice', message: `Claimed by more than one task (${[primary.task, ...collisions.map(c => ({ number: c.number, id: c.id }))].map((t: any) => `#${t.number ?? t.id}`).join(', ')})` }] };
    else {
      const p = await previewClose(project, primary.task, { sessions });
      cleanup = { allowed: p.allowed, needsAcknowledgement: p.needsAcknowledgement, blockers: p.blockers };
    }

    const flags: InventoryFlags = {
      taskLinked: !!task,
      unlinked: !isMain && !task,
      integrated: task?.integration === 'integrated',
      unmerged: (unmergedCommits ?? 0) > 0,
      dirty: (changes?.total ?? 0) > 0,
      busy: holding.length > 0,
      unknown: !isMain && (!exists || w.prunable === true || !changes || unmergedCommits === null),
    };
    return {
      path: w.path, isMain, exists, branch: w.branch ?? null, head: w.head ?? null, detached: !!w.detached, locked: !!w.locked, prunable: !!w.prunable,
      task, collisions, comparedTo: { branch: compareBranch, reason: acceptedTarget ? 'accepted-target' : 'main-checkout-branch' },
      unmergedCommits, changes, sessions: holding, flags, cleanup,
    };
  });

  const rest = worktrees.filter(w => !w.isMain);
  return {
    projectId: project.id,
    checkout: { path: list[0]?.path ?? project.path, branch: checkoutBranch, head: checkoutHead },
    worktrees,
    summary: {
      total: rest.length,
      taskLinked: rest.filter(w => w.flags.taskLinked).length,
      unlinked: rest.filter(w => w.flags.unlinked).length,
      integrated: rest.filter(w => w.flags.integrated).length,
      unmerged: rest.filter(w => w.flags.unmerged).length,
      dirty: rest.filter(w => w.flags.dirty).length,
      busy: rest.filter(w => w.flags.busy).length,
      unknown: rest.filter(w => w.flags.unknown).length,
      closable: rest.filter(w => w.cleanup.allowed || w.cleanup.needsAcknowledgement).length,
    },
    generatedAt: new Date().toISOString(),
  };
}

// -- one worktree, in detail -----------------------------------------------------

/** A registered, non-main worktree of this project, found by Git's list (never by a caller-supplied path alone). */
export async function findRegistered(project: Project, path: string): Promise<{ entry: git.WorktreeEntry; isMain: boolean } | null> {
  const list = await git.listWorktrees(project.path);
  const canon = canonicalPath(path);
  const i = list.findIndex(w => canonicalPath(w.path) === canon);
  return i < 0 ? null : { entry: list[i], isMain: i === 0 };
}

export async function worktreeChanges(project: Project, path: string) {
  const found = await findRegistered(project, path);
  if (!found) return { ok: false as const, code: 'not-registered', message: 'git does not list this folder as a worktree of the project' };
  if (!(await dirExists(found.entry.path))) return { ok: false as const, code: 'missing', message: 'The folder is not on disk' };
  return { ok: true as const, path: found.entry.path, report: await classifyChanges(found.entry.path) };
}

/** Diff of one file of a registered worktree. The file must be a relative path inside it. */
export async function worktreeDiff(project: Project, path: string, file: string) {
  const found = await findRegistered(project, path);
  if (!found) return { ok: false as const, code: 'not-registered', message: 'git does not list this folder as a worktree of the project' };
  if (!file || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).includes('..')) return { ok: false as const, code: 'bad-file', message: 'file must be a relative path inside the worktree' };
  const st = await git.statusEntries(found.entry.path);
  const entry = st.entries.find(e => e.path === file);
  if (!entry) return { ok: false as const, code: 'not-changed', message: 'That file has no changes in this worktree' };
  if (entry.kinds.includes('untracked')) return { ok: true as const, file, untracked: true, diff: '', truncated: false, binary: false };
  const d = await git.diffAgainstHead(found.entry.path, file);
  if (!d.ok) return { ok: false as const, code: 'diff-failed', message: 'git could not produce the diff' };
  return { ok: true as const, file, untracked: false, diff: d.diff, truncated: d.truncated, binary: d.binary };
}

// -- manual links ----------------------------------------------------------------

export type LinkResult = { ok: true; link: links.WorktreeLink; already: boolean } | { ok: false; code: string; message: string };
const no = (code: string, message: string): LinkResult => ({ ok: false, code, message });

/**
 * Record "this worktree belongs to this task". Writes only the link file: the worktree,
 * the task, the acceptance and the branch are not touched. Never matches by name.
 */
export async function linkWorktree(project: Project, taskId: string, path: string): Promise<LinkResult> {
  const task = await taskStore.getTask(project.id, taskId);
  if (!task) return no('task-not-found', 'Task not found in this project');
  if (!project.isGitRepo) return no('not-git', 'The project is not a git repository');
  const found = await findRegistered(project, path);
  if (!found) return no('not-registered', 'git does not list this folder as a worktree of this project. Worktrees of other repositories and plain folders cannot be linked');
  const w = found.entry;
  if (found.isMain) return no('main-checkout', 'The main checkout cannot be linked to a task');
  if (w.bare || w.prunable || !(await dirExists(w.path))) return no('unavailable', 'The worktree folder is not usable (missing or prunable)');
  if (!w.branch || !w.head) return no('detached', 'The worktree has no branch checked out, so its branch and HEAD cannot be identified');

  const canon = canonicalPath(w.path);
  const tasks = await taskStore.getTasks(project.id);
  const sameFolder = tasks.find(t => t.id !== taskId && t.worktreePath && canonicalPath(t.worktreePath) === canon);
  if (sameFolder) return no('already-claimed', `Task #${sameFolder.number ?? sameFolder.id} already owns this worktree. Unlink or close that one first`);
  const sameBranch = tasks.find(t => t.id !== taskId && t.worktreeBranch === w.branch);
  if (sameBranch) return no('branch-claimed', `Task #${sameBranch.number ?? sameBranch.id} already owns branch ${w.branch}`);
  if (task.worktreePath && canonicalPath(task.worktreePath) !== canon) return no('task-has-worktree', 'This task already has its own worktree');
  if (task.worktreePath && canonicalPath(task.worktreePath) === canon) {
    return { ok: true, already: true, link: { taskId, path: w.path, branch: w.branch, headAtLink: w.head, at: new Date().toISOString(), by: 'ui' } };
  }

  const res = await links.mutateLinks(project.id, current => {
    const mine = current[taskId];
    if (mine) return canonicalPath(mine.path) === canon ? { ok: true as const, already: true, link: mine } : no('task-already-linked', `This task is already linked to ${mine.path}. Remove that link first`);
    const other = Object.values(current).find(l => canonicalPath(l.path) === canon);
    if (other) return no('already-claimed', 'Another task is already linked to this worktree. Remove that link first');
    const otherBranch = Object.values(current).find(l => l.branch === w.branch);
    if (otherBranch) return no('branch-claimed', `Another task is already linked to branch ${w.branch}`);
    const link: links.WorktreeLink = { taskId, path: w.path, branch: w.branch!, headAtLink: w.head!, at: new Date().toISOString(), by: 'ui' };
    current[taskId] = link;
    return { ok: true as const, already: false, link };
  });
  invalidateInventory(project.id);
  lifecycle.invalidateSummary(project.id);
  return res;
}

/** Remove the claim. The worktree, its branch and the task are left exactly as they are. */
export async function unlinkWorktree(project: Project, taskId: string): Promise<{ ok: boolean; removed: boolean }> {
  const removed = await links.mutateLinks(project.id, current => { const had = !!current[taskId]; delete current[taskId]; return had; });
  invalidateInventory(project.id);
  lifecycle.invalidateSummary(project.id);
  return { ok: true, removed };
}
