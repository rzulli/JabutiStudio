import { stat, realpath, readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { getProjects } from '../projectDiscovery.js';
import * as taskStore from '../taskStore.js';
import { withLink } from '../worktreeLinks.js';
import * as git from '../gitService.js';
import { findRegistered } from '../worktreeInventory.js';
import { canonicalPath } from '../pathIdentity.js';
import { isInside } from '../worktreeClose.js';
import type { Project } from '../../types/index.js';

/**
 * Execution Context for Godot actions (Open in Godot, Run Scene, Run Test).
 *
 * ONE resolver decides which checkout an action touches. The caller names a project, optionally a task and an
 * explicit checkout choice, and optionally a project-relative file. It never supplies a directory: the checkout
 * is either the project folder or a worktree that Git itself lists for the project and that the task owns.
 * Nothing falls back silently: a task whose worktree is gone is refused, not run on the main checkout.
 */

export type Origin = 'project' | 'task' | 'editor';

export interface ContextRequest {
  projectId: string;
  taskId?: string;
  /** 'main' = the project folder, chosen on purpose. 'task' = the task's worktree. Omitted = the task's worktree if it has one. */
  checkout?: 'main' | 'task';
  /** Project-relative path (or res://). */
  file?: string;
  /** Files of a non-Godot project only need the checkout, not a Godot project at its root. */
  requireGodot?: boolean;
  origin?: Origin;
}

export interface ContextFile {
  rel: string;
  res: string;
  absolute: string;
  ext: string;
  /** The same file in the main checkout (what the Editor shows) has identical bytes. Only set when running in a task worktree. */
  sameAsEditorCheckout?: boolean;
  existsInEditorCheckout?: boolean;
}

export interface ExecutionContext {
  ok: true;
  projectId: string;
  projectName: string;
  projectPath: string;
  taskId?: string;
  taskNumber?: number;
  taskTitle?: string;
  /** Directory the action will use. */
  checkoutPath: string;
  source: 'project' | 'task';
  isMainCheckout: boolean;
  /** Why this checkout: shown to the person verbatim. */
  reason: string;
  origin: Origin;
  branch: string | null;
  head: string | null;
  detached: boolean;
  /** Uncommitted + untracked entries at resolve time; null when the checkout is not a Git work tree. */
  dirty: { count: number; files: string[] } | null;
  /** True only when HEAD alone reproduces what runs (clean tree, known commit). */
  reproducibleFromSha: boolean;
  file?: ContextFile;
  /** Things the person should know before running (never blockers). */
  notes: string[];
}

export type RefusalCode =
  | 'project-not-found' | 'not-godot-project' | 'task-not-found' | 'task-without-worktree' | 'worktree-missing'
  | 'worktree-unregistered' | 'bad-selection' | 'bad-file' | 'file-missing' | 'file-outside' | 'not-a-file';

export interface Refusal {
  ok: false;
  code: RefusalCode;
  message: string;
  /** Explicit choices that would make the request unambiguous. */
  options?: { checkout: 'main' | 'task'; label: string }[];
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** `res://a/b.tscn` or `a\b.tscn` -> `a/b.tscn`; null when it could point anywhere but inside the checkout. */
export function cleanRel(input: string): string | null {
  const s = String(input ?? '').replace(/\\/g, '/').replace(/^res:\/\//, '');
  if (!s || s.includes('\0') || s.startsWith('/') || s.includes(':')) return null;
  const parts = s.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) return null;
  if (parts[0].toLowerCase() === '.git') return null;
  return parts.join('/');
}

async function sha(path: string): Promise<string | null> {
  try { return createHash('sha1').update(await readFile(path)).digest('hex'); } catch { return null; }
}

async function resolveFile(root: string, mainRoot: string | null, input: string): Promise<{ ok: true; file: ContextFile } | Refusal> {
  const rel = cleanRel(input);
  if (!rel) return { ok: false, code: 'bad-file', message: `"${input}" is not a project-relative file path (no absolute paths, drive letters or ".." allowed).` };
  const absolute = join(root, ...rel.split('/'));
  let st;
  try { st = await stat(absolute); } catch { return { ok: false, code: 'file-missing', message: `${rel} does not exist in ${root}.` }; }
  if (!st.isFile()) return { ok: false, code: 'not-a-file', message: `${rel} is not a file.` };
  let real: string;
  try { real = await realpath(absolute); } catch { return { ok: false, code: 'file-missing', message: `${rel} does not exist in ${root}.` }; }
  if (!isInside(real, root)) return { ok: false, code: 'file-outside', message: `${rel} resolves outside the checkout (${root}) and will not be executed.` };
  const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.')).toLowerCase() : '';
  const file: ContextFile = { rel, res: `res://${rel}`, absolute, ext };
  if (mainRoot) {
    const mainAbs = join(mainRoot, ...rel.split('/'));
    file.existsInEditorCheckout = await exists(mainAbs);
    if (file.existsInEditorCheckout) file.sameAsEditorCheckout = (await sha(mainAbs)) === (await sha(absolute));
  }
  return { ok: true, file };
}

export async function resolveContext(req: ContextRequest): Promise<ExecutionContext | Refusal> {
  const project = (await getProjects()).find(p => p.id === req.projectId);
  if (!project) return { ok: false, code: 'project-not-found', message: 'Project not found.' };
  return resolveForProject(project, req);
}

export async function resolveForProject(project: Project, req: ContextRequest): Promise<ExecutionContext | Refusal> {
  if (req.checkout && req.checkout !== 'main' && req.checkout !== 'task') return { ok: false, code: 'bad-selection', message: `Unknown checkout "${String(req.checkout)}".` };
  if (req.checkout === 'task' && !req.taskId) return { ok: false, code: 'bad-selection', message: 'checkout "task" needs a task.' };

  let checkoutPath = project.path;
  let source: 'project' | 'task' = 'project';
  let reason = '';
  let task: Awaited<ReturnType<typeof taskStore.getTask>> | undefined;
  const notes: string[] = [];

  if (req.taskId) {
    const raw = await taskStore.getTask(project.id, req.taskId);
    if (!raw) return { ok: false, code: 'task-not-found', message: 'Task not found in this project.' };
    task = await withLink(raw);
    const label = `Task #${task.number ?? task.id}`;

    if (req.checkout === 'main') {
      reason = `${label} is selected, but the main checkout was chosen explicitly.`;
      notes.push(task.worktreePath ? `${label} has its own worktree (${task.worktreePath}); this run does NOT see its changes.` : `${label} has no worktree; running the main checkout.`);
    } else if (!task.worktreePath) {
      return {
        ok: false, code: 'task-without-worktree',
        message: `${label} has no worktree, so there is nothing task-specific to run. Choose the main checkout explicitly if that is what you want.`,
        options: [{ checkout: 'main', label: `Run on the main checkout (${project.path})` }],
      };
    } else {
      if (!(await exists(task.worktreePath))) {
        return { ok: false, code: 'worktree-missing', message: `${label}'s worktree is recorded at ${task.worktreePath} but that folder no longer exists. Nothing was run; the main checkout was NOT used as a fallback.`, options: [{ checkout: 'main', label: `Run on the main checkout (${project.path}) instead` }] };
      }
      const reg = await findRegistered(project, task.worktreePath);
      if (!reg || reg.isMain || reg.entry.prunable) {
        return { ok: false, code: 'worktree-unregistered', message: `${label}'s recorded worktree ${task.worktreePath} is not a live worktree of this project according to Git. Nothing was run.`, options: [{ checkout: 'main', label: `Run on the main checkout (${project.path}) instead` }] };
      }
      checkoutPath = reg.entry.path;
      source = 'task';
      reason = `${label} owns this worktree${task.worktreeBranch ? ` (${task.worktreeBranch})` : ''}.`;
    }
  } else {
    reason = 'No task selected: the project\'s main checkout.';
  }

  if (req.requireGodot !== false && !(await exists(join(checkoutPath, 'project.godot')))) {
    return { ok: false, code: 'not-godot-project', message: `No project.godot at the root of ${checkoutPath}; this is not a Godot project checkout.` };
  }

  const isMain = source === 'project';
  let branch: string | null = null, head: string | null = null, dirty: ExecutionContext['dirty'] = null, detached = false;
  if (project.isGitRepo) {
    head = await git.resolveRef(checkoutPath, 'HEAD');
    branch = await git.currentBranch(checkoutPath);
    detached = !!head && !branch;
    if (head) dirty = await git.dirtySummary(checkoutPath);
  }
  if (dirty && dirty.count > 0) notes.push(`${dirty.count} uncommitted change${dirty.count === 1 ? '' : 's'} in this checkout: the commit alone does not reproduce what runs.`);
  if (!project.isGitRepo) notes.push('Not a Git repository: branch and commit are unknown.');
  if (isMain && task) { /* explicit main choice, already noted */ }

  const ctx: ExecutionContext = {
    ok: true, projectId: project.id, projectName: project.name, projectPath: project.path,
    taskId: task?.id, taskNumber: task?.number, taskTitle: task?.title,
    checkoutPath, source, isMainCheckout: isMain, reason,
    origin: req.origin ?? (task ? 'task' : req.file ? 'editor' : 'project'),
    branch, head, detached, dirty, reproducibleFromSha: !!head && !!dirty && dirty.count === 0, notes,
  };

  if (req.file) {
    const f = await resolveFile(checkoutPath, isMain ? null : project.path, req.file);
    if (!f.ok) return f;
    ctx.file = f.file;
    if (!isMain && f.file.existsInEditorCheckout === false) ctx.notes.push(`${f.file.rel} does not exist in the main checkout the Editor shows; it only exists in this worktree.`);
    if (!isMain && f.file.sameAsEditorCheckout === false) ctx.notes.push(`${f.file.rel} differs from the copy the Editor is showing (main checkout). The worktree copy is what runs.`);
  }
  return ctx;
}

export function sameCheckout(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}
