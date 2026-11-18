import { simpleGit, SimpleGit, StatusResult, LogResult } from 'simple-git';
import path from 'path';
import { promises as fsp, realpathSync } from 'fs';
import { execFile } from 'child_process';

// Cache SimpleGit instances per resolved path so that all operations on the
// same repo go through one instance's internal task queue. This serializes git
// commands and prevents concurrent index access that can cause incomplete
// status results on Windows (index.lock conflicts).
const gitInstances = new Map<string, SimpleGit>();

function getGit(projectPath: string): SimpleGit {
  const key = path.resolve(projectPath);
  let instance = gitInstances.get(key);
  if (!instance) {
    instance = simpleGit(projectPath, {
      config: ['core.quotepath=false'],
    });
    gitInstances.set(key, instance);
  }
  return instance;
}

// `fetch` talks to the network: a slow remote or a credential prompt can hold
// it for a minute or more. It gets its own SimpleGit instance so it never sits
// in the shared queue in front of a status/log read, and it never asks for
// credentials — an unanswerable prompt is what made it hang in the first place.
const fetchInstances = new Map<string, SimpleGit>();
const fetchInFlight = new Map<string, Promise<void>>();
const FETCH_BLOCK_TIMEOUT_MS = 120_000;

function getFetchGit(projectPath: string): SimpleGit {
  const key = path.resolve(projectPath);
  let instance = fetchInstances.get(key);
  if (!instance) {
    instance = simpleGit(projectPath, {
      config: ['core.quotepath=false'],
      timeout: { block: FETCH_BLOCK_TIMEOUT_MS },
    });
    fetchInstances.set(key, instance);
  }
  return instance;
}

/** Refresh remote refs. Callers should not await it on a request path. */
export function fetch(projectPath: string): Promise<void> {
  const key = path.resolve(projectPath);
  const running = fetchInFlight.get(key);
  if (running) return running;

  const promise = (async () => {
    try {
      const git = getFetchGit(projectPath).env({
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      });
      await git.fetch();
      // ahead/behind just moved — don't serve the pre-fetch counts.
      invalidateStatus(projectPath);
    } catch {
      // ignore fetch errors (no remote, no network, no credentials)
    } finally {
      fetchInFlight.delete(key);
    }
  })();

  fetchInFlight.set(key, promise);
  return promise;
}

// A repo's status is polled by the git panel (5s), the project list refresh
// (15s) and the task review at once. Without this, each of those spawns its own
// `git status` and they queue up behind each other on the same repo.
const STATUS_TTL_MS = 2_500;
const statusCache = new Map<string, { at: number; result: StatusResult }>();
const statusInFlight = new Map<string, Promise<StatusResult>>();

// When a repo was last used through the app. The project list refresh backs
// off on repos that sit unchanged and reads this to go back to its fast poll.
const touchedAt = new Map<string, number>();

/** Mark a repo as in use: a mutation ran on it or someone is looking at it. */
export function touch(projectPath: string): void {
  touchedAt.set(path.resolve(projectPath), Date.now());
}

export function getTouchedAt(projectPath: string): number {
  return touchedAt.get(path.resolve(projectPath)) ?? 0;
}

/** Drop the cached status of a repo — every write path below calls this. */
function invalidateStatus(projectPath: string): void {
  statusCache.delete(path.resolve(projectPath));
  touch(projectPath);
}

export async function getStatus(projectPath: string): Promise<StatusResult> {
  const key = path.resolve(projectPath);

  const cached = statusCache.get(key);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.result;

  const inFlight = statusInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = getGit(projectPath)
    .status()
    .then(result => {
      statusCache.set(key, { at: Date.now(), result });
      return result;
    })
    .finally(() => {
      statusInFlight.delete(key);
    });

  statusInFlight.set(key, promise);
  return promise;
}

export async function getRemotes(projectPath: string) {
  const git = getGit(projectPath);
  return git.getRemotes(true);
}

export async function getDiff(projectPath: string, file?: string, staged = false): Promise<string> {
  const git = getGit(projectPath);
  const args = staged ? ['--cached'] : [];
  if (file) args.push(file);
  return git.diff(args);
}

export async function getFileAtRef(projectPath: string, file: string, ref = 'HEAD'): Promise<string> {
  const git = getGit(projectPath);
  return git.show([`${ref}:${file}`]);
}

export async function stageFile(projectPath: string, file: string): Promise<void> {
  const git = getGit(projectPath);
  await git.add(file);
  invalidateStatus(projectPath);
}

export async function stageAll(projectPath: string): Promise<void> {
  const git = getGit(projectPath);
  await git.add('-A');
  invalidateStatus(projectPath);
}

export async function unstageFile(projectPath: string, file: string): Promise<void> {
  const git = getGit(projectPath);
  await git.reset(['HEAD', '--', file]);
  invalidateStatus(projectPath);
}

export async function unstageAll(projectPath: string): Promise<void> {
  const git = getGit(projectPath);
  await git.reset(['HEAD']);
  invalidateStatus(projectPath);
}

export async function commit(projectPath: string, message: string): Promise<string> {
  const git = getGit(projectPath);
  const result = await git.commit(message);
  invalidateStatus(projectPath);
  return result.commit;
}

export async function push(projectPath: string): Promise<void> {
  const git = getGit(projectPath);
  await git.push();
  invalidateStatus(projectPath);
}

export async function pull(projectPath: string): Promise<void> {
  const git = getGit(projectPath);
  await git.pull();
  invalidateStatus(projectPath);
}

export async function getLog(projectPath: string, maxCount = 20): Promise<LogResult> {
  const git = getGit(projectPath);
  return git.log({ maxCount });
}

export async function getBranches(projectPath: string) {
  const git = getGit(projectPath);
  return git.branch();
}

export async function checkoutBranch(projectPath: string, branch: string): Promise<void> {
  const git = getGit(projectPath);
  await git.checkout(branch);
  invalidateStatus(projectPath);
}

export async function discardFile(projectPath: string, file: string, type: 'staged' | 'unstaged' | 'untracked'): Promise<void> {
  const git = getGit(projectPath);
  if (type === 'staged') {
    try {
      await git.checkout(['HEAD', '--', file]);
    } catch {
      // New file not in HEAD — just unstage (leaves as untracked)
      await git.reset(['HEAD', '--', file]);
    }
  } else if (type === 'unstaged') {
    await git.checkout(['--', file]);
  } else {
    // untracked — delete the file or directory
    const fullPath = path.resolve(projectPath, file);
    if (!fullPath.startsWith(path.resolve(projectPath))) {
      throw new Error('Invalid path');
    }
    const stat = await fsp.stat(fullPath);
    if (stat.isDirectory()) {
      await fsp.rm(fullPath, { recursive: true });
    } else {
      await fsp.unlink(fullPath);
    }
  }
  invalidateStatus(projectPath);
}

export async function discardAll(projectPath: string, section: 'staged' | 'unstaged'): Promise<void> {
  const git = getGit(projectPath);
  const status = await git.status();
  if (section === 'staged') {
    // Mirror discardFile logic for each staged file (handles new files not in HEAD)
    for (const file of status.staged) {
      try {
        await git.checkout(['HEAD', '--', file]);
      } catch {
        // New file not in HEAD — just unstage (leaves as untracked)
        try { await git.reset(['HEAD', '--', file]); } catch { /* ignore */ }
      }
    }
  } else {
    // Restore all tracked modified/deleted files
    try { await git.checkout(['--', '.']); } catch { /* nothing to restore */ }
    // Delete untracked files (mirrors discardFile for type='untracked')
    for (const file of status.not_added) {
      const fullPath = path.resolve(projectPath, file);
      if (!fullPath.startsWith(path.resolve(projectPath))) continue;
      try {
        const stat = await fsp.stat(fullPath);
        if (stat.isDirectory()) {
          await fsp.rm(fullPath, { recursive: true });
        } else {
          await fsp.unlink(fullPath);
        }
      } catch { /* ignore */ }
    }
  }
  invalidateStatus(projectPath);
}

export async function undoLastCommit(projectPath: string): Promise<void> {
  const git = getGit(projectPath);
  // Check there's at least one commit
  try {
    await git.raw(['rev-parse', 'HEAD']);
  } catch {
    throw new Error('No commits to undo');
  }
  await git.reset(['--soft', 'HEAD~1']);
  invalidateStatus(projectPath);
}

export async function getCommitDiff(projectPath: string, hash: string): Promise<{ files: { file: string; status: string; additions: number; deletions: number }[]; diff: string }> {
  const git = getGit(projectPath);
  // Get list of changed files with stats
  const nameStatus = await git.raw(['diff-tree', '--no-commit-id', '-r', '--name-status', hash]);
  const numstat = await git.raw(['diff-tree', '--no-commit-id', '-r', '--numstat', hash]);
  const diff = await git.raw(['diff-tree', '-p', '--no-commit-id', '-r', hash]);

  const statusLines = nameStatus.trim().split('\n').filter(Boolean);
  const statLines = numstat.trim().split('\n').filter(Boolean);

  const files = statusLines.map((line, i) => {
    const [status, ...fileParts] = line.split('\t');
    const file = fileParts.join('\t'); // handle renames with tab
    const statParts = statLines[i]?.split('\t') || [];
    const additions = parseInt(statParts[0]) || 0;
    const deletions = parseInt(statParts[1]) || 0;
    const statusMap: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C' };
    return { file, status: statusMap[status.charAt(0)] || status.charAt(0), additions, deletions };
  });

  return { files, diff };
}

export async function getMainBranchLastCommit(projectPath: string): Promise<{ hash: string; message: string; date: string; author_name: string; isMerged: boolean } | null> {
  const git = getGit(projectPath);
  try {
    const branches = await git.branch();
    const mainRef = branches.all.find(b => b === 'main')
      || branches.all.find(b => b === 'master')
      || branches.all.find(b => b === 'remotes/origin/main')
      || branches.all.find(b => b === 'remotes/origin/master');
    if (!mainRef) return null;
    const raw = await git.raw(['log', mainRef, '-1', '--format=%H%n%s%n%aI%n%an']);
    if (!raw.trim()) return null;
    const [hash, message, date, author_name] = raw.trim().split('\n');

    // Check if main's last commit is already in the current branch
    let isMerged = false;
    try {
      await git.raw(['merge-base', '--is-ancestor', hash, 'HEAD']);
      isMerged = true;
    } catch {
      // exit code 1 = not ancestor, meaning main commit is NOT in current branch
    }

    return { hash, message, date, author_name, isMerged };
  } catch {
    return null;
  }
}


export interface TaskCommitFile {
  file: string;
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface TaskCommit {
  hash: string;
  message: string;
  date: string;
  author_name: string;
  files: TaskCommitFile[];
  additions: number;
  deletions: number;
}

const REC = '\x1e'; // record separator — one per commit
const UNIT = '\x1f'; // unit separator — between header fields

function parseNumstatLog(raw: string): TaskCommit[] {
  const commits: TaskCommit[] = [];
  for (const record of raw.split(REC)) {
    if (!record.trim()) continue;
    const [header, ...rest] = record.split('\n');
    const [hash, message, date, author_name] = header.split(UNIT);
    if (!hash) continue;

    const files: TaskCommitFile[] = [];
    let additions = 0;
    let deletions = 0;
    for (const line of rest) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [addRaw, delRaw, ...fileParts] = parts;
      const file = fileParts.join('\t');
      // Binary files report "-" instead of a line count
      const binary = addRaw === '-' || delRaw === '-';
      const a = binary ? 0 : parseInt(addRaw, 10) || 0;
      const d = binary ? 0 : parseInt(delRaw, 10) || 0;
      additions += a;
      deletions += d;
      files.push({ file, additions: a, deletions: d, ...(binary ? { binary: true } : {}) });
    }

    commits.push({ hash, message: message || '', date: date || '', author_name: author_name || '', files, additions, deletions });
  }

  return commits;
}

/**
 * Commits whose date falls inside a window, each with the files it touched.
 * One `git log --numstat` call covers the whole range; the per-commit diff is
 * fetched on demand by getCommitDiff when the user expands a commit.
 */
export async function getCommitsSince(projectPath: string, since: string, until?: string): Promise<TaskCommit[]> {
  const git = getGit(projectPath);
  const args = [
    'log',
    `--since=${since}`,
    '--numstat',
    `--format=${REC}%H${UNIT}%s${UNIT}%aI${UNIT}%an`,
  ];
  if (until) args.push(`--until=${until}`);

  let raw: string;
  try {
    raw = await git.raw(args);
  } catch {
    // No commits yet, or not a repo — nothing to review
    return [];
  }

  return parseNumstatLog(raw);
}

// ── Worktrees ────────────────────────────────────────────

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  /** `git worktree lock` (or a lock git set itself): git refuses to remove it. */
  locked?: boolean;
  lockReason?: string;
  /** git says the folder is gone and the record can be pruned. */
  prunable?: boolean;
}

/** Every worktree of a repo, main one included, from `git worktree list`. */
export async function listWorktrees(projectPath: string): Promise<WorktreeEntry[]> {
  const git = getGit(projectPath);
  let raw: string;
  try {
    raw = await git.raw(['worktree', 'list', '--porcelain']);
  } catch {
    return [];
  }

  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (text.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: text.slice('worktree '.length) };
    } else if (!current) {
      continue;
    } else if (text.startsWith('HEAD ')) {
      current.head = text.slice('HEAD '.length);
    } else if (text.startsWith('branch ')) {
      current.branch = text.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (text === 'bare') {
      current.bare = true;
    } else if (text === 'detached') {
      current.detached = true;
    } else if (text === 'locked' || text.startsWith('locked ')) {
      current.locked = true;
      if (text.length > 7) current.lockReason = text.slice(7);
    } else if (text === 'prunable' || text.startsWith('prunable ')) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export interface PruneResult {
  /** `git worktree prune` ran. */
  pruned: boolean;
  /** Paths of records that were missing but still belong to a task: the prune was skipped to keep them. */
  kept: string[];
}

/**
 * Drop worktree records whose directory no longer exists. `keep` lists worktree paths that a task still
 * records. Git prunes every missing record at once, so if any of them is in `keep` the whole prune is skipped:
 * the record is what lets a moved folder be restored with its history and link intact. Orphan records (no task
 * behind them) are still pruned when nothing is kept.
 */
/** Same folder under one spelling: real parent directory (resolves 8.3 short names) + basename, lowercased on Windows. */
function pathKey(p: string): string {
  const abs = path.resolve(p);
  let real = abs;
  try { real = path.join(realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch { /* parent missing */ }
  return real.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export async function pruneWorktrees(projectPath: string, keep: string[] = []): Promise<PruneResult> {
  const git = getGit(projectPath);
  if (keep.length) {
    const wanted = new Set(keep.map(pathKey));
    const kept: string[] = [];
    for (const entry of await listWorktrees(projectPath)) {
      const key = pathKey(entry.path);
      if (!wanted.has(key)) continue;
      const missing = entry.prunable || !(await fsp.stat(entry.path).then(s => s.isDirectory(), () => false));
      if (missing) kept.push(entry.path);
    }
    if (kept.length) return { pruned: false, kept };
  }
  try {
    await git.raw(['worktree', 'prune']);
    return { pruned: true, kept: [] };
  } catch {
    // Not a repo, or nothing to prune — either way there is nothing to do.
    return { pruned: false, kept: [] };
  }
}

/**
 * Check out `branch` into `dest` as a new worktree. The branch is created off
 * the repo's current HEAD when it doesn't exist yet; an existing branch is
 * reused, which makes the call safe to repeat for the same task.
 */
export async function createWorktree(projectPath: string, branch: string, dest: string): Promise<void> {
  const git = getGit(projectPath);
  // A stale record (directory deleted by hand) would make `add` refuse.
  await pruneWorktrees(projectPath);

  const branches = await git.branch();
  const exists = branches.all.includes(branch);
  const args = exists
    ? ['worktree', 'add', dest, branch]
    : ['worktree', 'add', '-b', branch, dest];
  await git.raw(args);
}

// ── Lifecycle primitives (R2-A1) ─────────────────────────
// Fresh reads, never the 2.5 s status cache: acceptance and integration decide
// on what git says now. They run `git` directly so exit codes (merge-tree,
// merge-base --is-ancestor) are observable instead of folded into an exception.


export interface GitRun { code: number; stdout: string; stderr: string }

export function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise(resolve => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err: any, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 128) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Commit a ref points to, or null when the ref does not exist. */
export async function resolveRef(cwd: string, ref: string): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

/** Checked-out branch of a working directory; null when detached. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** True only when git says `ancestor` is reachable from `descendant`. */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  const r = await runGit(cwd, ['merge-base', a, b]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Commits reachable from `head` but not from `base`, oldest last, with their files. */
export async function getCommitsBetween(cwd: string, base: string, head: string): Promise<TaskCommit[]> {
  const r = await runGit(cwd, ['log', '--numstat', `--format=${REC}%H${UNIT}%s${UNIT}%aI${UNIT}%an`, `${base}..${head}`]);
  return r.code === 0 ? parseNumstatLog(r.stdout) : [];
}

/**
 * Patch-equivalence: how many of head's commits have no equivalent patch in
 * `upstream` (`+`) and how many do (`-`). Equivalent without ancestry is the
 * cherry-pick / rebase / squash case — reported, never trusted as integrated.
 */
export async function cherryCounts(cwd: string, upstream: string, head: string): Promise<{ unique: number; equivalent: number }> {
  const r = await runGit(cwd, ['cherry', upstream, head]);
  let unique = 0, equivalent = 0;
  if (r.code === 0) for (const l of r.stdout.split('\n')) { if (l.startsWith('+')) unique++; else if (l.startsWith('-')) equivalent++; }
  return { unique, equivalent };
}

export interface DirtySummary { count: number; files: string[] }

/** Uncommitted and untracked (non-ignored) entries of a working directory, read fresh. */
export async function dirtySummary(cwd: string): Promise<DirtySummary> {
  invalidateStatus(cwd);
  const r = await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  const lines = r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  return { count: lines.length, files: lines.slice(0, 20).map(l => l.slice(3)) };
}

/** A merge, rebase, cherry-pick or revert left half-done in this checkout. */
export async function operationInProgress(cwd: string): Promise<string | null> {
  for (const [ref, label] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const) {
    if ((await runGit(cwd, ['rev-parse', '--verify', '--quiet', ref])).code === 0) return label;
  }
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const p = await runGit(cwd, ['rev-parse', '--git-path', dir]);
    if (p.code === 0) { try { await fsp.access(path.resolve(cwd, p.stdout.trim())); return 'rebase'; } catch { /* absent */ } }
  }
  return null;
}

/** Would merging `head` into `target` conflict? Computed in the object store; touches no checkout. */
export async function predictMerge(cwd: string, target: string, head: string): Promise<'clean' | 'conflict' | 'unknown'> {
  const r = await runGit(cwd, ['merge-tree', '--write-tree', '--no-messages', target, head]);
  if (r.code === 0) return 'clean';
  if (r.code === 1) return 'conflict';
  return 'unknown';
}

/**
 * Merge an exact commit (never a branch name) with --no-ff into the branch
 * checked out in `cwd`. On any failure the merge is aborted so the checkout is
 * left as it was.
 */
export async function mergeCommitNoFf(cwd: string, sha: string, message: string): Promise<{ ok: boolean; conflict: boolean; output: string }> {
  const r = await runGit(cwd, ['merge', '--no-ff', '-m', message, sha]);
  if (r.code === 0) { invalidateStatus(cwd); return { ok: true, conflict: false, output: r.stdout.trim() }; }
  const output = (r.stdout + r.stderr).trim();
  const conflict = /CONFLICT|Automatic merge failed/i.test(output);
  await runGit(cwd, ['merge', '--abort']);
  invalidateStatus(cwd);
  return { ok: false, conflict, output };
}

/** Branch name -> path of the worktree that has it checked out (from `git worktree list`). */
export async function worktreeOfBranch(cwd: string, branch: string): Promise<string | null> {
  const all = await listWorktrees(cwd);
  return all.find(w => w.branch === branch)?.path ?? null;
}

// ── Worktree safety primitives (R2-A2) ───────────────────
// Read-only except the two removal functions, which never force.

export type ChangeKind = 'staged' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
export interface ChangeEntry {
  path: string;
  /** Previous path for a rename/copy. */
  from?: string;
  kinds: ChangeKind[];
  /** Raw porcelain XY code, kept so nothing is lost in the classification. */
  xy: string;
}

/** `git status --porcelain=v1 -z --untracked-files=all` parsed, fresh (no cache). Ignored files are not here. */
export async function statusEntries(cwd: string): Promise<{ ok: boolean; entries: ChangeEntry[] }> {
  const r = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (r.code !== 0) return { ok: false, entries: [] };
  const parts = r.stdout.split('\0');
  const entries: ChangeEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const file = rec.slice(3);
    const x = xy[0], y = xy[1];
    let from: string | undefined;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') from = parts[++i];
    const kinds: ChangeKind[] = [];
    if (xy === '??') kinds.push('untracked');
    else {
      if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') kinds.push('conflicted');
      if (x !== ' ' && x !== '?' && x !== 'U') kinds.push('staged');
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') kinds.push('renamed');
      if (x === 'D' || y === 'D') kinds.push('deleted');
      if (y === 'M' || y === 'T' || y === 'A') kinds.push('modified');
    }
    entries.push({ path: file, ...(from ? { from } : {}), kinds, xy });
  }
  return { ok: true, entries };
}

/** Ignored files and directories that deleting the worktree folder would take with it (`--directory` collapses trees). */
export async function ignoredEntries(cwd: string): Promise<{ ok: boolean; entries: string[]; fingerprint: string }> {
  const r = await runGit(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  if (r.code !== 0) return { ok: false, entries: [], fingerprint: '' };
  const entries = r.stdout.split(' ').filter(Boolean).sort();
  return { ok: true, entries, fingerprint: await fingerprintEntries(cwd, entries) };
}

/** Count, size and newest mtime under each ignored entry (bounded): a directory name alone hides what is inside. */
async function fingerprintEntries(cwd: string, entries: string[]): Promise<string> {
  let budget = 50_000;
  const walk = async (abs: string): Promise<[number, number, number]> => {
    let st;
    try { st = await fsp.lstat(abs); } catch { return [0, 0, 0]; }
    if (!st.isDirectory()) return [1, st.size, st.mtimeMs];
    let names: string[] = [];
    try { names = await fsp.readdir(abs); } catch { return [0, 0, 0]; }
    let n = 0, size = 0, mt = 0;
    for (const nm of names) {
      if (budget-- <= 0) { n = -1; break; }
      const [a, b, c] = await walk(path.join(abs, nm));
      n += a; size += b; mt = Math.max(mt, c);
    }
    return [n, size, mt];
  };
  const parts: string[] = [];
  for (const e of entries) parts.push(e + ':' + (await walk(path.join(cwd, e))).join(','));
  return parts.join('|');
}

/** The repository's shared git dir, as an absolute path: equal for every worktree of one repo. */
export async function commonDir(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function isIndexLocked(cwd: string): Promise<boolean> {
  const p = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock']);
  if (p.code !== 0) return false;
  try { await fsp.access(p.stdout.trim()); return true; } catch { return false; }
}

/** Diff of one path against HEAD (staged and unstaged together), capped. */
export async function diffAgainstHead(cwd: string, file: string, maxBytes = 200_000): Promise<{ ok: boolean; diff: string; truncated: boolean; binary: boolean }> {
  const r = await runGit(cwd, ['diff', '--no-color', '-U3', 'HEAD', '--', file]);
  if (r.code !== 0) return { ok: false, diff: '', truncated: false, binary: false };
  const binary = /^Binary files /m.test(r.stdout);
  return { ok: true, diff: r.stdout.slice(0, maxBytes), truncated: r.stdout.length > maxBytes, binary };
}

/**
 * `git worktree remove` WITHOUT --force: git itself refuses a worktree with
 * tracked changes, untracked files, or that is locked. Returns what git said.
 */
export async function removeWorktreeSafe(cwd: string, dest: string): Promise<{ ok: boolean; output: string }> {
  const r = await runGit(cwd, ['worktree', 'remove', dest]);
  invalidateStatus(cwd);
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

/**
 * Delete a branch ref only if it still points at `expectedSha` (compare-and-delete).
 * The caller has already proven integration against the task's target; this is not
 * `branch -D`: a branch that moved since the proof is left alone.
 */
export async function deleteBranchAt(cwd: string, branch: string, expectedSha: string): Promise<{ ok: boolean; output: string }> {
  const r = await runGit(cwd, ['update-ref', '-d', `refs/heads/${branch}`, expectedSha]);
  invalidateStatus(cwd);
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

/** Commits in `head` not reachable from `base`. */
export async function countAhead(cwd: string, base: string, head: string): Promise<number | null> {
  const r = await runGit(cwd, ['rev-list', '--count', `${base}..${head}`]);
  return r.code === 0 ? parseInt(r.stdout.trim(), 10) || 0 : null;
}
