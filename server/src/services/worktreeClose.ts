import { createHash } from 'crypto';
import { stat } from 'fs/promises';
import { join } from 'path';
import * as git from './gitService.js';
import * as taskStore from './taskStore.js';
import * as store from './taskLifecycleStore.js';
import * as links from './worktreeLinks.js';
import { withLink } from './worktreeLinks.js';
import * as lifecycle from './taskLifecycle.js';
import { classifyChanges, type ChangeReport } from './worktreeChanges.js';
import { canonicalPath } from './pathIdentity.js';
import * as log from './logService.js';
import type { Blocker, SessionLite } from './taskLifecycle.js';
import type { GodotProcesses } from './godot/activity.js';
import type { Project, Task } from '../types/index.js';

/**
 * Safe close of a task's worktree and branch (R2-A2).
 *
 * Nothing here is a new source of truth. Every check is read from its authority at
 * the moment it matters: Git (registration, ancestry, changes, locks, operations),
 * the acceptance ledger (what a person accepted), the terminal layer (live sessions).
 * The preview is what the person reviews; the close re-reads everything and refuses
 * if the state it was shown has changed (`token`). Removal never forces: no
 * `--force`, no `reset --hard`, no `clean`, no `branch -D`.
 *
 * Removing the folder and deleting the branch are two operations with two results.
 * A task is CLOSED only when Git shows both gone.
 */

/** Test seam: the two destructive git calls. Production never reassigns them. */
export const hooks = {
  removeWorktree: git.removeWorktreeSafe,
  deleteBranch: git.deleteBranchAt,
};

export interface CloseCheck { code: string; ok: boolean; message: string; acknowledgeable?: boolean }

export interface ClosePreview {
  taskId: string;
  taskNumber?: number;
  title: string;
  stage: lifecycle.Stage;
  /** `worktree`: remove the folder then the branch. `branch-only`: the folder is already gone (a retry). `none`: nothing left to close. */
  mode: 'worktree' | 'branch-only' | 'none';
  /** Every check passes: the close would run as shown. */
  allowed: boolean;
  /** The only thing failing is "ignored files are in the folder": the person may acknowledge them and close. */
  needsAcknowledgement: boolean;
  checks: CloseCheck[];
  blockers: Blocker[];
  worktree: { path: string | null; branch: string | null; head: string | null; exists: boolean; registered: boolean; locked: boolean };
  integration: { targetBranch: string | null; acceptedSha: string | null; mergeCommit: string | null; targetHead: string | null };
  changes: Pick<ChangeReport, 'total' | 'counts' | 'ignored' | 'digest'> | null;
  sessions: SessionLite[];
  branch: { name: string | null; action: 'delete' | 'preserve'; reason: string };
  willRemove: string[];
  willPreserve: string[];
  /** Identifies the exact state that was reviewed. The close refuses if it changed. */
  token: string;
}

export interface CloseResult {
  worktree: 'removed' | 'failed' | 'absent';
  branch: 'deleted' | 'preserved' | 'failed';
  note?: string;
}

// -- shared helpers -------------------------------------------------------------

/** Live terminal sessions known to Shipyard. Empty when the terminal layer is unavailable. */
export async function liveSessions(): Promise<SessionLite[]> {
  try {
    const { listSessions } = await import('./terminalService.js');
    return listSessions().map(s => ({ id: s.id, agent: s.agent, type: s.type, state: s.state ?? null, cwd: s.cwd, claudeSessionId: s.claudeSessionId, ...(s.taskId ? { taskId: s.taskId } : {}) } as SessionLite & { taskId?: string }));
  } catch { return []; }
}

export function isInside(child: string, parent: string): boolean {
  const c = canonicalPath(child), p = canonicalPath(parent);
  return c === p || c.startsWith(p + '/');
}

/** Sessions that hold this task or this folder: by task id, or by a working directory inside the worktree. */
export function sessionsHolding(all: (SessionLite & { taskId?: string })[], taskId: string | null, wtPath: string | null): SessionLite[] {
  return all.filter(s => (taskId && s.taskId === taskId) || (wtPath && s.cwd && isInside(s.cwd, wtPath)));
}

async function dirExists(p?: string | null): Promise<boolean> {
  if (!p) return false;
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}
async function isLinkedWorktreeDir(p: string): Promise<boolean> {
  try { return (await stat(join(p, '.git'))).isFile(); } catch { return false; }
}

const sha = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex');

// -- evaluation -----------------------------------------------------------------

export async function previewClose(
  project: Project, rawTask: Task,
  opts: { sessions?: (SessionLite & { taskId?: string })[] } = {},
): Promise<ClosePreview> {
  const task = await withLink(rawTask);
  const all = opts.sessions ?? await liveSessions();
  const taskSessions = all.filter(s => s.taskId === task.id);
  const view = await lifecycle.resolveLifecycle(project, task, { sessions: taskSessions });
  const entry = await store.getEntry(task.projectId, task.id);
  const rec = entry?.accepted;
  const integrated = entry?.integrated;
  const wtList = await git.listWorktrees(project.path);
  const mainPath = wtList[0]?.path ?? project.path;
  const wtPath = task.worktreePath ?? null;
  const reg = wtPath ? wtList.find(w => canonicalPath(w.path) === canonicalPath(wtPath)) : undefined;
  const exists = await dirExists(wtPath);
  const branch = task.worktreeBranch ?? null;
  const targetName = rec?.targetBranch ?? view.target.branch;
  const targetHead = targetName ? await git.resolveRef(project.path, `refs/heads/${targetName}`) : null;
  const branchHead = branch ? await git.resolveRef(project.path, `refs/heads/${branch}`) : null;

  const mode: ClosePreview['mode'] = (exists || reg) ? 'worktree' : branchHead ? 'branch-only' : 'none';
  const checks: CloseCheck[] = [];
  const add = (code: string, ok: boolean, message: string, acknowledgeable = false) => checks.push({ code, ok, message, ...(acknowledgeable ? { acknowledgeable } : {}) });

  // 1-3: the task really is integrated, in Git, for the commit a person accepted.
  add('integrated-stage', view.stage === 'INTEGRATED', view.stage === 'INTEGRATED'
    ? 'Task is integrated'
    : view.stage === 'CLOSED' ? 'Task is already closed: nothing left to remove' : `Task is ${view.stage}, not INTEGRATED. Done or closed status is not integration`);
  const acceptedSha = rec?.headSha ?? null;
  const proven = !!(acceptedSha && targetHead && integrated && integrated.headSha === acceptedSha && await git.isAncestor(project.path, acceptedSha, targetHead));
  add('ancestry', proven, proven
    ? `${acceptedSha!.slice(0, 7)} is an ancestor of ${targetName} (git merge-base --is-ancestor)`
    : `Git does not show the accepted commit in ${targetName ?? 'the target'}. Nothing is removed on the strength of a status`);
  const sameCommit = !!(acceptedSha && (!branchHead || branchHead === acceptedSha) && view.acceptance.state !== 'lapsed');
  add('accepted-commit', sameCommit, sameCommit
    ? 'The branch is at the commit that was accepted and integrated'
    : 'The branch is not at the accepted commit: it holds work nobody accepted');

  // 4, 11, 12: this folder is this task's, and is a linked worktree of THIS repository, not the main checkout.
  let ownership = true; let ownMsg = 'Registered by git as the worktree of this task\'s branch';
  let pathOk = true; let pathMsg = 'Path is a linked worktree of this repository';
  let notMain = true; let mainMsg = 'Not the main checkout and contains no other worktree';
  if (mode === 'worktree') {
    if (!wtPath || !reg) { ownership = false; ownMsg = 'git does not list this folder as a worktree of the project'; }
    else if (reg.branch !== branch) { ownership = false; ownMsg = `The worktree has ${reg.branch ?? 'a detached HEAD'} checked out, not the task's ${branch}`; }
    if (wtPath) {
      const claimants = (await taskStore.getTasks(task.projectId)).filter(t => t.id !== task.id && t.worktreePath && canonicalPath(t.worktreePath) === canonicalPath(wtPath));
      const linkClaim = (await links.listLinks(task.projectId)).filter(l => l.taskId !== task.id && canonicalPath(l.path) === canonicalPath(wtPath));
      if (claimants.length || linkClaim.length) { ownership = false; ownMsg = 'Another task also claims this worktree'; }
      if (!exists) { pathOk = false; pathMsg = 'The folder is not on disk'; }
      else if (!(await isLinkedWorktreeDir(wtPath))) { pathOk = false; pathMsg = 'The folder has no .git file: it is not a linked worktree'; }
      else {
        const a = await git.commonDir(wtPath), b = await git.commonDir(project.path);
        if (!a || !b || canonicalPath(a) !== canonicalPath(b)) { pathOk = false; pathMsg = 'The folder belongs to another repository'; }
      }
      if (canonicalPath(wtPath) === canonicalPath(project.path) || canonicalPath(wtPath) === canonicalPath(mainPath) || (wtList[0] && reg === wtList[0])) {
        notMain = false; mainMsg = 'This is the main checkout of the project. It is never removed by task cleanup';
      } else if (wtList.some(w => w !== reg && isInside(w.path, wtPath) && canonicalPath(w.path) !== canonicalPath(wtPath)) || isInside(project.path, wtPath)) {
        notMain = false; mainMsg = 'The folder contains the main checkout or another worktree';
      }
    }
  }
  add('ownership', ownership, ownMsg);
  add('path-valid', pathOk, pathMsg);
  add('not-main-checkout', notMain, mainMsg);

  // 5-7: nothing that exists only in this folder.
  let changes: ChangeReport | null = null;
  if (mode === 'worktree' && exists && pathOk) {
    changes = await classifyChanges(wtPath!);
    const tracked = changes.entries.filter(e => !e.kinds.includes('untracked')).length;
    const untracked = changes.counts.untracked;
    add('no-tracked-changes', changes.ok && tracked === 0, !changes.ok ? 'Git could not report the worktree state' : tracked === 0 ? 'No modified, staged, deleted or renamed files' : `${tracked} file${tracked === 1 ? '' : 's'} modified, staged, deleted or renamed`);
    add('no-untracked', changes.ok && untracked === 0, untracked === 0 ? 'No untracked files' : `${untracked} untracked file${untracked === 1 ? '' : 's'} exist only in this folder`);
    const ign = changes.ignored.total;
    add('ignored-files', ign === 0, ign === 0 ? 'No ignored files or folders' : `${ign} ignored file${ign === 1 ? '' : 's'}/folder${ign === 1 ? '' : 's'} (caches, generated data) would be deleted with the folder. Listed below; they are not removed unless you acknowledge them`, true);
  } else if (mode === 'worktree') {
    add('no-tracked-changes', false, 'The worktree could not be read, so its changes are unknown');
  }

  // 8-10: nothing is using it.
  const holding = mode === 'worktree' ? sessionsHolding(all, task.id, wtPath) : sessionsHolding(all, task.id, null);
  add('no-sessions', holding.length === 0, holding.length === 0 ? 'No known session uses this task or folder' : `${holding.length} terminal/agent session${holding.length === 1 ? '' : 's'} still open (${holding.map(s => s.state || s.type || 'open').join(', ')}). Close the tab first`);
  // 8b: Godot windows and Harness runs this server knows about in the folder. Running ones block (nothing is stopped
  // here); unfinished records with no recorded exit need an explicit acknowledgement, because they are not provably over.
  let procs: GodotProcesses | null = null;
  if (mode === 'worktree' && wtPath) {
    const { godotProcessesIn } = await import('./godot/activity.js');
    procs = await godotProcessesIn(wtPath, task.projectId);
    const n = procs.running.length;
    add('no-processes', n === 0, n === 0
      ? 'No Godot window or Harness run tracked by Shipyard is running in this folder. Godot opened by hand and windows started before a server restart are not tracked, so this is not proof that none is open'
      : `${n} Godot/Harness process${n === 1 ? '' : 'es'} still running in this folder (${procs.running.map(p => p.kind).join(', ')}). Close ${n === 1 ? 'it' : 'them'} first; Shipyard does not stop processes`);
    const u = procs.unknown.length;
    add('process-unknown', u === 0, u === 0
      ? 'No unfinished Harness run is recorded for this folder'
      : `${u} Harness run${u === 1 ? '' : 's'} recorded for this folder ${u === 1 ? 'has' : 'have'} no receipt and no recorded exit: ${u === 1 ? 'it may' : 'they may'} still be running (the server may have restarted). Acknowledge to close`, true);
  }
  if (mode === 'worktree' && exists) {
    const op = (await git.operationInProgress(wtPath!)) || (await git.operationInProgress(project.path));
    const idx = await git.isIndexLocked(wtPath!);
    add('no-operation', !op && !idx, op ? `A ${op} is in progress` : idx ? 'The worktree index is locked (index.lock): another git process is running' : 'No merge, rebase or other git operation in progress');
    add('not-locked', !reg?.locked, reg?.locked ? `The worktree is locked${reg.lockReason ? `: ${reg.lockReason}` : ''}` : 'Not locked');
  }

  // branch plan: separate decision, separate proof.
  let branchAction: ClosePreview['branch'] = { name: branch, action: 'preserve', reason: 'The task has no branch' };
  if (branch) {
    const elsewhere = wtList.find(w => w.branch === branch && canonicalPath(w.path) !== canonicalPath(wtPath ?? ''));
    if (!branchHead) branchAction = { name: branch, action: 'preserve', reason: 'The branch no longer exists' };
    else if (!proven) branchAction = { name: branch, action: 'preserve', reason: `Integration into ${targetName ?? 'the target'} is not proven, so the branch is kept` };
    else if (branchHead !== acceptedSha) branchAction = { name: branch, action: 'preserve', reason: 'The branch moved after it was accepted: it holds commits nobody integrated' };
    else if (elsewhere) branchAction = { name: branch, action: 'preserve', reason: `The branch is also checked out in ${elsewhere.path}` };
    else branchAction = { name: branch, action: 'delete', reason: `Proven integrated into ${targetName}; the ref is deleted only if it still points at ${acceptedSha!.slice(0, 7)}` };
  }

  const blockers: Blocker[] = checks.filter(c => !c.ok).map(c => ({ code: c.code, message: c.message }));
  const hardFailed = checks.filter(c => !c.ok && !c.acknowledgeable);
  const ackOnly = hardFailed.length === 0 && checks.some(c => !c.ok && c.acknowledgeable);
  const allowed = mode !== 'none' && hardFailed.length === 0 && !ackOnly;

  const willRemove: string[] = [];
  const willPreserve: string[] = [];
  if (mode === 'worktree') willRemove.push(`Worktree folder ${wtPath}`);
  if (branchAction.action === 'delete') willRemove.push(`Branch ${branch} (ref only: its commits stay in ${targetName})`);
  else if (branch && branchHead) willPreserve.push(`Branch ${branch}: ${branchAction.reason}`);
  if (integrated?.mergeCommit) willPreserve.push(`Merge commit ${integrated.mergeCommit.slice(0, 7)} and every commit in ${targetName}`);
  if (changes && changes.ignored.total > 0) willRemove.push(`${changes.ignored.total} ignored file${changes.ignored.total === 1 ? '' : 's'}/folder${changes.ignored.total === 1 ? '' : 's'} inside the folder (only with your acknowledgement)`);
  willPreserve.push('The task, its history and its acceptance record');

  const token = sha({
    t: task.id, p: wtPath ? canonicalPath(wtPath) : null, b: branch, bh: branchHead, wh: reg?.head ?? null, a: acceptedSha, ih: integrated?.headSha ?? null,
    tn: targetName, d: changes?.digest ?? null, s: holding.map(s => [s.id, s.state]).sort(), l: !!reg?.locked, m: mode,
    pr: procs ? [procs.running.map(p => [p.kind, p.pid ?? null, p.runId ?? null]), procs.unknown.map(p => p.runId ?? null)] : null,
  });

  return {
    taskId: task.id, taskNumber: task.number, title: task.title, stage: view.stage, mode,
    allowed, needsAcknowledgement: ackOnly, checks, blockers,
    worktree: { path: wtPath, branch, head: reg?.head ?? null, exists, registered: !!reg, locked: !!reg?.locked },
    integration: { targetBranch: targetName ?? null, acceptedSha, mergeCommit: integrated?.mergeCommit ?? null, targetHead },
    changes: changes ? { total: changes.total, counts: changes.counts, ignored: changes.ignored, digest: changes.digest } : null,
    sessions: holding, branch: branchAction, willRemove, willPreserve, token,
  };
}

// -- execution ------------------------------------------------------------------

export type CloseOutcome =
  | { ok: true; complete: boolean; result: CloseResult; view: lifecycle.LifecycleView }
  | { ok: false; code: string; message: string; result?: CloseResult; preview?: ClosePreview; view?: lifecycle.LifecycleView };

export async function closeTask(
  project: Project, rawTask: Task,
  req: { expectedToken?: string; acknowledgeIgnored?: boolean; acknowledgeUnknownProcesses?: boolean; sessions?: (SessionLite & { taskId?: string })[] },
): Promise<CloseOutcome> {
  const task = await withLink(rawTask);
  const refuse = async (code: string, message: string, preview?: ClosePreview): Promise<CloseOutcome> => {
    await store.mutate(task.projectId, task.id, e => { e.history.push({ at: new Date().toISOString(), event: 'closure-refused', detail: { code, message } }); });
    return { ok: false, code, message, preview };
  };
  if (!req.expectedToken) return refuse('token-required', 'expectedToken is required: you close the state you reviewed');

  // Everything is re-read here. Nothing from the earlier preview is trusted except the token it must still match.
  const preview = await previewClose(project, rawTask, { sessions: req.sessions });
  if (preview.mode === 'none') return refuse('nothing-to-close', 'There is no worktree or branch left to close', preview);
  if (preview.token !== req.expectedToken) return refuse('state-changed', 'The worktree, branch, files or sessions changed since you reviewed them. Review again', preview);
  const hard = preview.checks.filter(c => !c.ok && !c.acknowledgeable);
  if (hard.length) return refuse('blocked', hard.map(c => c.message).join('; '), preview);
  // Each acknowledgement covers only its own check: ignored files do not excuse an unknown process, nor the reverse.
  for (const c of preview.checks) {
    if (c.ok || !c.acknowledgeable) continue;
    if (c.code === 'ignored-files') {
      if (!req.acknowledgeIgnored) return refuse('ignored-files', 'Ignored files are in the folder. Acknowledge that they are deleted with it, or keep the worktree', preview);
    } else if (c.code === 'process-unknown') {
      if (!req.acknowledgeUnknownProcesses) return refuse('process-unknown', c.message, preview);
    } else {
      return refuse(c.code, c.message, preview);
    }
  }

  const cwd = project.path;
  const wtPath = preview.worktree.path;
  const branch = preview.worktree.branch;
  const acceptedSha = preview.integration.acceptedSha!;
  const result: CloseResult = { worktree: 'absent', branch: 'preserved' };
  const stamp = () => new Date().toISOString();

  // 1) the folder. git refuses anything it considers unclean or locked; we never retry with force.
  if (preview.mode === 'worktree' && wtPath) {
    const removed = await hooks.removeWorktree(cwd, wtPath);
    const stillThere = await dirExists(wtPath);
    const stillRegistered = (await git.listWorktrees(cwd)).some(w => canonicalPath(w.path) === canonicalPath(wtPath));
    if (!removed.ok || stillRegistered) {
      result.worktree = 'failed';
      result.note = removed.output.slice(0, 500) || 'git worktree remove did not complete';
      await store.mutate(task.projectId, task.id, e => {
        e.closure = { at: stamp(), worktreePath: wtPath, branch: branch ?? '', headSha: acceptedSha, worktree: 'failed', branchResult: 'preserved', note: result.note };
        e.history.push({ at: stamp(), event: 'closure-failed', detail: { step: 'worktree', output: result.note, folderStillOnDisk: stillThere } });
      });
      log.warn('git', `Worktree close failed for task #${task.number ?? task.id}`, result.note || '', task.projectId);
      return { ok: false, code: 'worktree-remove-failed', message: `git could not remove the worktree: ${result.note}. The branch was not touched and the task stays INTEGRATED`, result, view: await lifecycle.resolveLifecycle(project, task, {}) };
    }
    result.worktree = 'removed';
    await store.mutate(task.projectId, task.id, e => { e.history.push({ at: stamp(), event: 'worktree-removed', detail: { path: wtPath, headSha: acceptedSha } }); });
    lifecycle.invalidateSummary(task.projectId);
  }

  // 2) the branch: only if the proof still holds right now, and only the exact commit that was proven.
  if (branch && preview.branch.action === 'delete') {
    const now = await git.resolveRef(cwd, `refs/heads/${branch}`);
    const target = preview.integration.targetBranch;
    const targetNow = target ? await git.resolveRef(cwd, `refs/heads/${target}`) : null;
    const stillProven = !!(now && now === acceptedSha && targetNow && await git.isAncestor(cwd, acceptedSha, targetNow));
    if (!stillProven) {
      result.branch = 'preserved'; result.note = 'The branch or the target moved while closing; the branch was kept';
    } else {
      const del = await hooks.deleteBranch(cwd, branch, acceptedSha);
      const gone = !(await git.branchExists(cwd, branch));
      if (del.ok && gone) result.branch = 'deleted';
      else { result.branch = 'failed'; result.note = del.output.slice(0, 500) || 'the branch could not be deleted'; }
    }
  } else {
    result.branch = 'preserved'; result.note = preview.branch.reason;
  }
  await store.mutate(task.projectId, task.id, e => {
    e.closure = { at: stamp(), worktreePath: wtPath ?? '', branch: branch ?? '', headSha: acceptedSha, worktree: result.worktree, branchResult: result.branch, ...(result.note ? { note: result.note } : {}) };
    e.history.push({ at: stamp(), event: result.branch === 'deleted' ? 'branch-deleted' : result.branch === 'failed' ? 'closure-failed' : 'branch-preserved', detail: { branch, headSha: acceptedSha, note: result.note } });
  });

  const complete = result.branch === 'deleted' && result.worktree !== 'failed';
  if (complete) {
    // Only now, with Git showing both gone, does the task let go of the worktree fields and the link.
    await taskStore.updateTask(task.projectId, task.id, { worktreePath: undefined, worktreeBranch: undefined });
    await links.mutateLinks(task.projectId, l => { delete l[task.id]; });
  }
  lifecycle.invalidateSummary(task.projectId);
  const fresh = (await taskStore.getTask(task.projectId, task.id)) ?? task;
  return { ok: true, complete, result, view: await lifecycle.resolveLifecycle(project, await withLink(fresh), {}) };
}
