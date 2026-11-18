import { stat } from 'fs/promises';
import * as git from './gitService.js';
import * as taskStore from './taskStore.js';
import * as store from './taskLifecycleStore.js';
import { canonicalPath } from './pathIdentity.js';
import { withLink } from './worktreeLinks.js';
import type { Project, Task } from '../types/index.js';

/**
 * Task lifecycle (R2-A1): READY → RUNNING → REVIEW → ACCEPTED → INTEGRATED → CLOSED.
 *
 * Nothing here is a new state machine. The stage is DERIVED on every read from
 * four independent facts, each with its own authority:
 *
 *   execution    the task status and live terminal sessions       (Shipyard)
 *   delivery     commits/diff on the task's branch vs. the target (Git)
 *   acceptance   a human recorded "I reviewed this exact commit"  (ledger)
 *   integration  the accepted commit is an ancestor of the target (Git)
 *
 * `done` set by an agent is only execution. It is never acceptance and never
 * integration. Integration is never read from text: only `git merge-base
 * --is-ancestor` can say it. Patch-equivalent work without ancestry (rebase,
 * cherry-pick, squash) is reported as its own case and never trusted.
 */

export type Stage = 'READY' | 'RUNNING' | 'REVIEW' | 'ACCEPTED' | 'INTEGRATED' | 'CLOSED';

export interface Blocker { code: string; message: string }

export interface DirectCandidate { sha: string; subject: string; date: string; author: string; trailer: boolean }
export interface DirectInfo {
  /** Commits on the target branch since the task started. Candidates by time only, unless `trailer`. Never an attribution by themselves. */
  candidates: DirectCandidate[];
  claim?: store.DirectClaim;
  /** The recorded range no longer holds (history rewritten, commit gone, no longer in the target). */
  claimProblem?: string;
  /** What Git and Shipyard can and cannot say about whose commits these are. Shown to the reviewer as is. */
  uncertainty: string[];
  /** Other tasks without a worktree whose working period overlaps this one in the same checkout. */
  concurrentTasks: { id: string; number?: number; title: string }[];
}

export interface SessionLite { id: string; taskId?: string; agent?: string; type?: string; state?: string | null; cwd?: string; claudeSessionId?: string }

export interface LifecycleView {
  taskId: string;
  projectId: string;
  stage: Stage;
  execution: { status: Task['status']; finished: boolean; sessions: SessionLite[]; sessionActive: boolean };
  delivery: {
    /** branch = isolated worktree; direct = worked in an existing checkout (a person identifies the commits); none = not a Git project. */
    mode: 'branch' | 'direct' | 'none';
    branch?: string;
    head?: string | null;
    worktreePath?: string;
    worktreeExists: boolean;
    /** The branch is checked out, in git's own list, in the folder the task claims. */
    worktreeMatches: boolean;
    dirty: git.DirtySummary;
    commits: git.TaskCommit[];
    files: { file: string; additions: number; deletions: number; commits: number }[];
    additions: number;
    deletions: number;
    direct?: DirectInfo;
  };
  target: { branch: string | null; exists: boolean; head?: string | null; baseline?: string | null; checkoutBranch: string | null; checkoutDirty: number; operation: string | null };
  acceptance: { state: 'none' | 'accepted' | 'lapsed'; record?: store.AcceptanceRecord; reason?: string };
  integration: {
    /** `in-target`: a direct delivery already sits in the target branch; no merge exists or is pending. */
    state: 'integrated' | 'in-target' | 'not-integrated' | 'patch-equivalent' | 'nothing-to-integrate' | 'unknown';
    mergeable: 'clean' | 'conflict' | 'unknown' | null;
    mergeCommit?: string;
    equivalentCommits?: number;
  };
  /** Outcome of the last close attempt, when there was one. */
  closure?: store.LifecycleEntry['closure'];
  blockers: Blocker[];
  canAccept: boolean;
  canIntegrate: boolean;
  history: store.LifecycleEvent[];
}

/** The one place the stage is decided, shared by the full view and the board summary. */
function deriveStage(
  integration: LifecycleView['integration']['state'],
  closed: boolean,
  status: Task['status'],
  acceptance: LifecycleView['acceptance']['state'],
): Stage {
  // CLOSED needs Git to show BOTH halves gone: the folder (disk and registration) and the branch.
  if (integration === 'integrated') return closed ? 'CLOSED' : 'INTEGRATED';
  if (status === 'todo' || status === 'backlog') return 'READY';
  if (status === 'in_progress') return 'RUNNING';
  return acceptance === 'accepted' ? 'ACCEPTED' : 'REVIEW';
}

/** Cheap per-task read for the board: enough to draw a chip, never to act on. */
export interface LifecycleSummary {
  taskId: string;
  stage: Stage;
  acceptance: LifecycleView['acceptance']['state'];
  integration: LifecycleView['integration']['state'];
  /** Commits on the task branch not yet in the target. */
  commits: number;
  /** Why the card needs a second look, when it does. */
  flag?: 'conflict' | 'branch-missing' | 'patch-equivalent';
}

const SUMMARY_TTL_MS = 5000;
const summaryCache = new Map<string, { at: number; value: Promise<LifecycleSummary[]> }>();

/**
 * Lifecycle of every task with a worktree branch in one project, in a handful of
 * git calls per branch (no dirty scan, no diff). Tasks without a branch are left
 * out: nothing about them can be verified, and the board must not pretend otherwise.
 * Cached briefly per project so several open boards and the rail share one read.
 */
export function summarizeProject(project: Project): Promise<LifecycleSummary[]> {
  const hit = summaryCache.get(project.id);
  if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.value;
  const value = computeSummary(project).catch(() => [] as LifecycleSummary[]);
  summaryCache.set(project.id, { at: Date.now(), value });
  return value;
}

/** Drop the cache after anything that changes what the summary would say. */
export function invalidateSummary(projectId: string): void { summaryCache.delete(projectId); }

async function computeSummary(project: Project): Promise<LifecycleSummary[]> {
  if (!project.isGitRepo) return [];
  const tasks = (await Promise.all((await taskStore.getTasks(project.id)).map(withLink))).filter(t => t.worktreeBranch);
  if (!tasks.length) return [];
  const cwd = project.path;
  const checkoutBranch = await git.currentBranch(cwd);
  const out: LifecycleSummary[] = [];
  // Four at a time: Windows pays for every process it spawns.
  for (let i = 0; i < tasks.length; i += 4) {
    out.push(...await Promise.all(tasks.slice(i, i + 4).map(async (task): Promise<LifecycleSummary> => {
      const entry = await store.getEntry(task.projectId, task.id);
      const rec = entry?.accepted;
      const branch = task.worktreeBranch!;
      const head = await git.resolveRef(cwd, `refs/heads/${branch}`);
      const headEffective = head ?? rec?.headSha ?? null;
      const targetName = rec?.targetBranch ?? checkoutBranch;
      const targetHead = targetName ? await git.resolveRef(cwd, `refs/heads/${targetName}`) : null;
      const worktreeExists = await dirExists(task.worktreePath);

      let acceptance: LifecycleSummary['acceptance'] = 'none';
      if (rec) acceptance = (head && rec.headSha !== head) || rec.branch !== branch ? 'lapsed' : 'accepted';

      let integration: LifecycleSummary['integration'] = 'unknown';
      let flag: LifecycleSummary['flag'];
      let commits = 0;
      if (headEffective && targetHead) {
        if (await git.isAncestor(cwd, headEffective, targetHead)) {
          integration = rec && rec.headSha === headEffective ? 'integrated' : 'nothing-to-integrate';
        } else {
          integration = 'not-integrated';
          const r = await git.runGit(cwd, ['rev-list', '--count', `${targetHead}..${headEffective}`]);
          commits = r.code === 0 ? parseInt(r.stdout.trim(), 10) || 0 : 0;
          // Only a finished task's verdict is shown, so only it pays for the extra calls.
          if (task.status === 'done') {
            const c = await git.cherryCounts(cwd, targetHead, headEffective);
            if (c.unique === 0 && c.equivalent > 0) { integration = 'patch-equivalent'; flag = 'patch-equivalent'; }
            else if (acceptance === 'accepted' && (await git.predictMerge(cwd, targetHead, headEffective)) === 'conflict') flag = 'conflict';
          }
        }
      }
      if (!head && integration !== 'integrated') flag = 'branch-missing';
      return { taskId: task.id, stage: deriveStage(integration, !worktreeExists && !head, task.status, acceptance), acceptance, integration, commits, ...(flag ? { flag } : {}) };
    })));
  }
  return out;
}

async function dirExists(p?: string): Promise<boolean> {
  if (!p) return false;
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

export async function resolveLifecycle(
  project: Project,
  task: Task,
  opts: { target?: string; sessions?: SessionLite[]; withDiff?: boolean } = {},
): Promise<LifecycleView> {
  const cwd = project.path;
  const entry = await store.getEntry(task.projectId, task.id);
  const rec = entry?.accepted;
  const branch = task.worktreeBranch || undefined;
  // A task that once had a worktree branch (accepted, integrated or closed through it) is never re-read as a direct one:
  // its branch being gone is part of its isolated history, not a missing attribution.
  const hadBranch = !!(entry?.closure || entry?.integrated || (rec && rec.branch !== '(direct)'));
  const mode: 'branch' | 'direct' | 'none' = branch ? 'branch' : hadBranch ? 'none' : project.isGitRepo ? 'direct' : 'none';

  const checkoutBranch = project.isGitRepo ? await git.currentBranch(cwd) : null;
  const targetName = rec?.targetBranch ?? opts.target ?? (mode === 'direct' ? entry?.direct?.targetBranch : undefined) ?? checkoutBranch;
  const targetExists = !!targetName && (await git.branchExists(cwd, targetName));
  const targetHead = targetExists ? await git.resolveRef(cwd, `refs/heads/${targetName}`) : null;

  // Direct checkout: the delivery is the range a person identified, re-validated against Git on every read.
  const direct = mode === 'direct' ? await resolveDirect(project, task, entry, targetName ?? null, targetHead, opts.sessions ?? []) : undefined;
  const directHead = direct?.claim && !direct.claimProblem ? direct.claim.headSha : null;

  const head = branch ? await git.resolveRef(cwd, `refs/heads/${branch}`) : directHead;
  // The branch can be gone after a worktree removal; the accepted commit still answers "was it integrated".
  const headEffective = head ?? rec?.headSha ?? null;
  const checkoutDirty = project.isGitRepo ? (await git.dirtySummary(cwd)).count : 0;
  const operation = project.isGitRepo ? await git.operationInProgress(cwd) : null;

  const worktreeExists = await dirExists(task.worktreePath);
  const registered = branch ? await git.worktreeOfBranch(cwd, branch) : null;
  const worktreeMatches = !!(worktreeExists && registered && task.worktreePath && canonicalPath(registered) === canonicalPath(task.worktreePath));
  const dirty = worktreeExists && task.worktreePath ? await git.dirtySummary(task.worktreePath) : { count: 0, files: [] };

  const baseline = mode === 'direct' ? (directHead ? direct!.claim!.baseSha : null) : headEffective && targetHead ? await git.mergeBase(cwd, targetHead, headEffective) : null;
  const commits = mode === 'direct'
    ? (directHead ? await git.getCommitsBetween(cwd, direct!.claim!.baseSha, directHead) : [])
    : head && targetHead ? await git.getCommitsBetween(cwd, targetHead, head) : [];
  const ancestor = !!(headEffective && targetHead && (await git.isAncestor(cwd, headEffective, targetHead)));

  const byFile = new Map<string, { file: string; additions: number; deletions: number; commits: number }>();
  for (const c of commits) for (const f of c.files) {
    const e = byFile.get(f.file) || { file: f.file, additions: 0, deletions: 0, commits: 0 };
    e.additions += f.additions; e.deletions += f.deletions; e.commits += 1; byFile.set(f.file, e);
  }

  // -- acceptance ---------------------------------------------------------
  let acceptance: LifecycleView['acceptance'] = { state: 'none' };
  if (rec) {
    if (head && rec.headSha !== head) acceptance = { state: 'lapsed', record: rec, reason: 'The branch moved after it was accepted' };
    else if (mode === 'direct' && !directHead) acceptance = { state: 'lapsed', record: rec, reason: 'The delivery identified for this task no longer holds' };
    else if (branch && rec.branch !== branch) acceptance = { state: 'lapsed', record: rec, reason: 'The task now uses a different branch' };
    else acceptance = { state: 'accepted', record: rec };
  }

  // -- integration (Git only) ---------------------------------------------
  let integrationState: LifecycleView['integration']['state'] = 'unknown';
  let mergeable: LifecycleView['integration']['mergeable'] = null;
  let equivalentCommits: number | undefined;
  if (mode === 'direct') {
    // Already committed in the target by construction (validated): nothing to merge, ever.
    integrationState = directHead ? 'in-target' : 'unknown';
  } else if (headEffective && targetHead) {
    if (ancestor) {
      // An empty branch is an ancestor of everything. It counts as integrated only
      // when an accepted record names this very commit.
      integrationState = rec && rec.headSha === headEffective ? 'integrated' : 'nothing-to-integrate';
    } else {
      const c = await git.cherryCounts(cwd, targetHead, headEffective);
      if (c.unique === 0 && c.equivalent > 0) { integrationState = 'patch-equivalent'; equivalentCommits = c.equivalent; }
      else integrationState = 'not-integrated';
      mergeable = await git.predictMerge(cwd, targetHead, headEffective);
    }
  }

  // -- stage ----------------------------------------------------------------
  const stage = mode === 'direct'
    ? (task.status === 'todo' || task.status === 'backlog' ? 'READY' : task.status === 'in_progress' ? 'RUNNING' : acceptance.state === 'accepted' ? 'INTEGRATED' : 'REVIEW') as Stage
    : deriveStage(integrationState, !worktreeExists && !registered && !head, task.status, acceptance.state);

  const sessions = (opts.sessions ?? []).filter(s => s);
  const sessionActive = sessions.some(s => s.state === 'busy' || s.state === 'awaiting-input');

  // -- blockers: why it cannot move forward ---------------------------------
  const blockers: Blocker[] = [];
  const add = (code: string, message: string) => blockers.push({ code, message });
  if (!project.isGitRepo) add('not-git', 'The project is not a git repository');
  if (mode === 'none') add('no-branch', 'The project is not a Git repository, so there is no delivery to identify.');
  else if (mode === 'direct') {
    if (!direct!.claim) add('unattributed', "No commit has been identified as this task's delivery yet. Choose the commits that belong to it; nothing is assumed from timing.");
    else if (direct!.claimProblem) add('claim-invalid', direct!.claimProblem);
  } else if (!head && integrationState !== 'integrated') add('branch-missing', `Branch ${branch} no longer exists`);
  if (task.status !== 'done' && integrationState !== 'integrated') add('not-finished', 'The agent has not marked the task done');
  if (sessionActive) add('session-active', 'An agent session on this task is still working');
  if (mode === 'branch' && head && task.worktreePath && !worktreeExists) add('worktree-missing', 'The worktree folder is gone; the branch still holds the work');
  if (worktreeExists && branch && !worktreeMatches) add('worktree-mismatch', `${task.worktreePath} is not git's worktree for ${branch}`);
  if (dirty.count > 0) add('worktree-dirty', `${dirty.count} uncommitted or untracked file${dirty.count === 1 ? '' : 's'} in the worktree`);
  if (!targetName) add('no-target', 'No target branch: the checkout is detached');
  else if (!targetExists) add('target-missing', `Target branch ${targetName} does not exist`);
  if (integrationState === 'nothing-to-integrate' && mode === 'branch') add('nothing-to-integrate', `${branch} has no commits beyond ${targetName}`);
  if (integrationState === 'patch-equivalent') add('patch-equivalent', `${equivalentCommits} commit(s) have an equivalent patch in ${targetName} but are not ancestors of it (rebase, cherry-pick or squash). Not treated as integrated`);
  if (acceptance.state === 'lapsed') add('acceptance-lapsed', acceptance.reason || 'Acceptance no longer covers the branch');
  if (acceptance.state === 'none' && integrationState === 'not-integrated') add('not-accepted', 'No human acceptance recorded');
  if (mergeable === 'conflict') add('conflict', `Merging into ${targetName} conflicts and needs a decision`);
  if (integrationState === 'not-integrated' && targetName) {
    if (checkoutBranch !== targetName) add('target-not-checked-out', `The project checkout is on ${checkoutBranch ?? 'a detached HEAD'}, not ${targetName}`);
    if (checkoutDirty > 0) add('target-dirty', `${checkoutDirty} uncommitted file${checkoutDirty === 1 ? '' : 's'} in the ${targetName} checkout`);
    if (operation) add('operation-in-progress', `A ${operation} is in progress in the project checkout`);
  }

  if (integrationState === 'integrated' && stage !== 'CLOSED') {
    if (entry?.closure && (entry.closure.worktree === 'failed' || entry.closure.branchResult !== 'deleted')) add('closure-incomplete', `Closing is incomplete: worktree ${entry.closure.worktree}, branch ${entry.closure.branchResult}${entry.closure.note ? ` (${entry.closure.note})` : ''}`);
    else if (worktreeExists || head) add('cleanup-pending', 'Integrated, but its worktree/branch have not been closed yet');
  }

  const hard = (codes: string[]) => blockers.some(b => codes.includes(b.code));
  const baseBlock = ['not-git', 'no-branch', 'unattributed', 'claim-invalid', 'branch-missing', 'not-finished', 'session-active', 'worktree-missing', 'worktree-mismatch', 'worktree-dirty', 'no-target', 'target-missing', 'nothing-to-integrate', 'patch-equivalent'];
  const canAccept = (integrationState === 'not-integrated' || integrationState === 'in-target') && commits.length > 0 && !hard(baseBlock) && acceptance.state !== 'accepted';
  const canIntegrate = mode !== 'direct' && integrationState === 'not-integrated' && acceptance.state === 'accepted' &&
    !hard([...baseBlock, 'conflict', 'target-not-checked-out', 'target-dirty', 'operation-in-progress']) && mergeable === 'clean';

  return {
    taskId: task.id,
    projectId: task.projectId,
    stage,
    execution: { status: task.status, finished: task.status === 'done', sessions, sessionActive },
    delivery: {
      mode, branch, head, worktreePath: task.worktreePath, worktreeExists, worktreeMatches, dirty, commits,
      files: [...byFile.values()].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions)),
      additions: commits.reduce((s, c) => s + c.additions, 0),
      deletions: commits.reduce((s, c) => s + c.deletions, 0),
      ...(direct ? { direct } : {}),
    },
    target: { branch: targetName ?? null, exists: targetExists, head: targetHead, baseline, checkoutBranch, checkoutDirty, operation },
    acceptance,
    integration: { state: integrationState, mergeable, ...(entry?.integrated ? { mergeCommit: entry.integrated.mergeCommit } : {}), ...(equivalentCommits ? { equivalentCommits } : {}) },
    ...(entry?.closure ? { closure: entry.closure } : {}),
    blockers,
    canAccept,
    canIntegrate,
    history: entry?.history ?? [],
  };
}

const TRAILER = 'Shipyard-Task';

async function candidatesSince(cwd: string, targetName: string, since: string | undefined): Promise<DirectCandidate[]> {
  if (!since) return [];
  const r = await git.runGit(cwd, ['log', targetName, `--since=${since}`, '-n', '60', '--format=%H%x1f%s%x1f%aI%x1f%an']);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map(line => {
    const [sha, subject, date, author] = line.split('\x1f');
    return { sha, subject, date, author, trailer: false };
  });
}

/** The trailer must name THIS task: a Shipyard-Task trailer for another task proves nothing here. */
async function carriesTrailer(cwd: string, sha: string, taskId: string): Promise<boolean> {
  const t = await git.runGit(cwd, ['log', '-1', `--format=%(trailers:key=${TRAILER},valueonly,separator=%x1f)`, sha]);
  return t.code === 0 && t.stdout.trim().split('\x1f').map(x => x.trim()).includes(taskId);
}

async function resolveDirect(
  project: Project, task: Task, entry: store.LifecycleEntry | undefined,
  targetName: string | null, targetHead: string | null, sessions: SessionLite[],
): Promise<DirectInfo> {
  const cwd = project.path;
  const since = task.inProgressAt || task.inboxAt || task.createdAt;
  const raw = targetName && targetHead ? await candidatesSince(cwd, targetName, since) : [];
  const candidates: DirectCandidate[] = [];
  for (const c of raw) candidates.push({ ...c, trailer: await carriesTrailer(cwd, c.sha, task.id) });

  const claim = entry?.direct;
  let claimProblem: string | undefined;
  if (claim) {
    const head = await git.resolveRef(cwd, claim.headSha);
    const base = await git.resolveRef(cwd, claim.baseSha);
    if (!head || !base) claimProblem = 'A commit of the identified delivery no longer exists in this repository (history was rewritten). Identify it again.';
    else if (!targetHead || !(await git.isAncestor(cwd, head, targetHead))) claimProblem = `The identified delivery is no longer inside ${targetName ?? 'the target branch'}. Identify it again.`;
    else if (!(await git.isAncestor(cwd, base, head))) claimProblem = 'The identified range is not a straight line of history any more. Identify it again.';
  }

  // Who else could have written into this checkout while the task ran: other direct tasks with an overlapping window.
  const start = since ? Date.parse(since) : NaN;
  const end = task.doneAt ? Date.parse(task.doneAt) : Date.now();
  const concurrentTasks: DirectInfo['concurrentTasks'] = [];
  if (!Number.isNaN(start)) {
    for (const other of await taskStore.getTasks(project.id)) {
      if (other.id === task.id) continue;
      if ((await withLink(other)).worktreeBranch) continue; // isolated: cannot write here
      const os = Date.parse(other.inProgressAt || other.inboxAt || '');
      if (Number.isNaN(os)) continue;
      const oe = other.status === 'in_progress' ? Date.now() : other.doneAt ? Date.parse(other.doneAt) : os;
      if (os <= end && oe >= start) concurrentTasks.push({ id: other.id, number: other.number, title: other.title });
    }
  }

  const uncertainty: string[] = [];
  if (!claim) {
    uncertainty.push(candidates.length
      ? `${candidates.length} commit(s) reached ${targetName} since the task started. They are candidates by time only; Git does not say which of them belong to this task.`
      : `No commit reached ${targetName} since the task started. If the work was done, it is uncommitted or lives elsewhere.`);
  } else if (!claimProblem) {
    uncertainty.push(claim.basis === 'trailer'
      ? `Every commit in this range carries ${TRAILER}: ${task.id}.`
      : 'These commits were attributed to the task by a person. Git itself does not prove it.');
  }
  if (concurrentTasks.length) uncertainty.push(`Task(s) ${concurrentTasks.map(t => t.number ? `#${t.number}` : t.id).join(', ')} also worked in this checkout during the same period, so commits may not be this task's.`);
  if (sessions.some(s => s.state === 'busy' || s.state === 'awaiting-input')) uncertainty.push('An agent session is still working on this task; the delivery may still change.');
  return { candidates, ...(claim ? { claim } : {}), ...(claimProblem ? { claimProblem } : {}), uncertainty, concurrentTasks };
}

/**
 * A person says which commits of the target branch are this task's delivery (direct checkout only). The range is
 * validated against Git; the basis is `trailer` only when every commit says so itself. UI-only at the route.
 */
export async function identifyDirectDelivery(
  project: Project, task: Task, req: { baseSha?: string; headSha?: string; note?: string; sessions?: SessionLite[] },
): Promise<ActionResult> {
  const view0 = await resolveLifecycle(project, task, { sessions: req.sessions });
  if (view0.delivery.mode !== 'direct') return refuse('not-direct', task.worktreeBranch ? 'This task has its own worktree branch; its delivery is the branch.' : 'Only a Git project can have a direct delivery.', view0);
  if (!req.baseSha || !req.headSha) return refuse('range-required', 'baseSha (the commit before the work) and headSha (the last delivered commit) are required.', view0);
  // Only commit ids (optionally "<id>~N") reach Git: never an option, a path or an arbitrary revision expression.
  const REV = /^[0-9a-fA-F]{7,40}(~\d{1,3})?$/;
  if (!REV.test(req.baseSha) || !REV.test(req.headSha)) return refuse('bad-commit', 'Commits must be given as commit ids.', view0);
  const cwd = project.path;
  const target = view0.target.branch;
  if (!target || !view0.target.head) return refuse('no-target', 'There is no target branch to identify commits in.', view0);
  const base = await git.resolveRef(cwd, req.baseSha);
  const head = await git.resolveRef(cwd, req.headSha);
  if (!base || !head) return refuse('unknown-commit', 'One of those commits does not exist in this repository.', view0);
  if (!(await git.isAncestor(cwd, head, view0.target.head))) return refuse('not-in-target', `${head.slice(0, 7)} is not inside ${target}.`, view0);
  if (base === head || !(await git.isAncestor(cwd, base, head))) return refuse('bad-range', 'The base must be an ancestor of the head, and different from it.', view0);
  const range = await git.getCommitsBetween(cwd, base, head);
  if (range.length === 0) return refuse('empty-range', 'That range contains no commits.', view0);
  if (range.length > 200) return refuse('range-too-large', `${range.length} commits is too many to be one task's delivery; narrow it.`, view0);
  let allTrailers = true;
  for (const c of range) if (!(await carriesTrailer(cwd, c.hash, task.id))) { allTrailers = false; break; }
  const basis: store.DirectClaim['basis'] = allTrailers ? 'trailer' : 'person';

  await store.mutate(task.projectId, task.id, entry => {
    const at = new Date().toISOString();
    entry.direct = { at, by: 'ui', targetBranch: target, baseSha: base, headSha: head, basis, ...(req.note?.trim() ? { note: req.note.trim() } : {}) };
    entry.history.push({ at, event: 'delivery-identified', detail: { baseSha: base, headSha: head, commits: range.length, basis, targetBranch: target } });
  });
  return { ok: true, view: await resolveLifecycle(project, task, { sessions: req.sessions }) };
}

export async function clearDirectDelivery(project: Project, task: Task, sessions?: SessionLite[]): Promise<ActionResult> {
  const entry = await store.getEntry(task.projectId, task.id);
  if (!entry?.direct) return refuse('no-delivery', 'No delivery is identified for this task.');
  // Clearing a delivery a person accepted would silently orphan the acceptance: revoke it first, on purpose.
  if (entry.accepted) return refuse('accepted', 'The delivery is accepted. Revoke the acceptance first.', await resolveLifecycle(project, task, { sessions }));
  await store.mutate(task.projectId, task.id, e => {
    e.history.push({ at: new Date().toISOString(), event: 'delivery-cleared', detail: { headSha: e.direct?.headSha } });
    delete e.direct;
  });
  return { ok: true, view: await resolveLifecycle(project, task, { sessions }) };
}

export type ActionResult = { ok: true; view: LifecycleView } | { ok: false; code: string; message: string; view?: LifecycleView };

const refuse = (code: string, message: string, view?: LifecycleView): ActionResult => ({ ok: false, code, message, view });

/** Record that a person reviewed this exact commit. The caller must have checked the request came from the UI. */
export async function accept(
  project: Project, task: Task,
  req: { targetBranch?: string; expectedHeadSha?: string; note?: string; sessions?: SessionLite[] },
): Promise<ActionResult> {
  if (!req.targetBranch) return refuse('target-required', 'targetBranch is required: the target is never guessed');
  if (!req.expectedHeadSha) return refuse('head-required', 'expectedHeadSha is required: you accept the commit you reviewed');
  const view = await resolveLifecycle(project, task, { target: req.targetBranch, sessions: req.sessions });
  if (view.acceptance.state === 'accepted' && view.acceptance.record?.headSha === req.expectedHeadSha) return { ok: true, view };
  if (view.target.branch !== req.targetBranch) return refuse('target-mismatch', `The task is bound to ${view.target.branch}, not ${req.targetBranch}`, view);
  if (view.delivery.head !== req.expectedHeadSha) return refuse('head-moved', 'The branch is not at the commit you reviewed', view);
  if (!view.canAccept) return refuse('blocked', view.blockers.map(b => b.message).join('; ') || 'Not ready to accept', view);

  await store.mutate(task.projectId, task.id, entry => {
    const at = new Date().toISOString();
    entry.accepted = {
      at, by: 'ui', branch: view.delivery.branch ?? '(direct)', headSha: req.expectedHeadSha!, targetBranch: req.targetBranch!,
      baselineSha: view.target.baseline ?? null, ...(req.note?.trim() ? { note: req.note.trim() } : {}),
    };
    entry.history.push({ at, event: 'accepted', detail: { headSha: req.expectedHeadSha, targetBranch: req.targetBranch, commits: view.delivery.commits.length } });
  });
  return { ok: true, view: await resolveLifecycle(project, task, { sessions: req.sessions }) };
}

export async function revokeAcceptance(project: Project, task: Task, sessions?: SessionLite[]): Promise<ActionResult> {
  const entry = await store.getEntry(task.projectId, task.id);
  if (!entry?.accepted) return refuse('not-accepted', 'Nothing to revoke');
  const view0 = await resolveLifecycle(project, task, { sessions });
  if (view0.integration.state === 'integrated') return refuse('already-integrated', 'Already integrated: acceptance is part of the history', view0);
  await store.mutate(task.projectId, task.id, e => {
    e.history.push({ at: new Date().toISOString(), event: 'acceptance-revoked', detail: { headSha: e.accepted?.headSha } });
    delete e.accepted;
  });
  return { ok: true, view: await resolveLifecycle(project, task, { sessions }) };
}

/**
 * Merge the accepted commit into the target. Every precondition is re-read from
 * Git here; nothing from the earlier view is trusted. Git confirms the result.
 */
export async function integrate(
  project: Project, task: Task,
  req: { targetBranch?: string; expectedHeadSha?: string; branch?: string; sessions?: SessionLite[] },
): Promise<ActionResult> {
  const view = await resolveLifecycle(project, task, { sessions: req.sessions });
  const fail = async (code: string, message: string) => {
    await store.mutate(task.projectId, task.id, e => { e.history.push({ at: new Date().toISOString(), event: 'integration-refused', detail: { code, message } }); });
    return refuse(code, message, view);
  };

  if (view.delivery.mode === 'direct') return fail('direct-delivery', `This task was delivered directly in ${view.target.branch ?? 'the checkout'}; there is no branch to merge and nothing is pending.`);
  if (!req.targetBranch) return fail('target-required', 'targetBranch is required: the target is never guessed');
  if (req.branch && req.branch !== task.worktreeBranch) return fail('wrong-branch', `This task owns ${task.worktreeBranch ?? 'no branch'}, not ${req.branch}`);
  if (view.integration.state === 'integrated') return fail('already-integrated', 'Already integrated');
  const rec = view.acceptance.record;
  if (view.acceptance.state === 'none' || !rec) return fail('not-accepted', 'No human acceptance recorded for this task');
  if (view.acceptance.state === 'lapsed') return fail('acceptance-lapsed', view.acceptance.reason || 'Acceptance no longer covers the branch');
  if (rec.targetBranch !== req.targetBranch) return fail('target-mismatch', `Accepted for ${rec.targetBranch}, not ${req.targetBranch}`);
  if (!req.expectedHeadSha || req.expectedHeadSha !== rec.headSha || view.delivery.head !== rec.headSha) {
    return fail('head-moved', 'The branch is not at the accepted commit');
  }
  if (!view.canIntegrate) {
    const why = view.blockers.filter(b => b.code !== 'not-accepted').map(b => b.message).join('; ');
    return fail('blocked', why || 'Not ready to integrate');
  }

  const targetBefore = view.target.head!;
  const label = task.number ? `#${task.number} ${task.title}` : task.title;
  const merged = await git.mergeCommitNoFf(project.path, rec.headSha, `Integrate task ${label}\n\nBranch: ${rec.branch}\nAccepted commit: ${rec.headSha}`);
  if (!merged.ok) return fail(merged.conflict ? 'conflict' : 'merge-failed', merged.output.slice(0, 500) || 'git merge failed; nothing was changed');

  // Git, not the merge's exit code, confirms it.
  const targetAfter = await git.resolveRef(project.path, `refs/heads/${rec.targetBranch}`);
  if (!targetAfter || !(await git.isAncestor(project.path, rec.headSha, targetAfter))) {
    return fail('verification-failed', 'The merge ran but git does not show the accepted commit in the target');
  }
  await store.mutate(task.projectId, task.id, e => {
    const at = new Date().toISOString();
    e.integrated = { at, targetBranch: rec.targetBranch, mergeCommit: targetAfter, headSha: rec.headSha, targetBefore };
    e.history.push({ at, event: 'integrated', detail: { mergeCommit: targetAfter, targetBefore, headSha: rec.headSha } });
  });
  // Execution closes the way every task does: through the task store, history intact.
  if (task.status !== 'done') await taskStore.updateTask(task.projectId, task.id, { status: 'done' });
  return { ok: true, view: await resolveLifecycle(project, task, { sessions: req.sessions }) };
}
