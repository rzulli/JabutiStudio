import * as taskStore from './taskStore.js';
import * as lifecycleStore from './taskLifecycleStore.js';
import { withLink } from './worktreeLinks.js';
import { isLinkedWorktree, recordCheckoutChoice, type CheckoutChoice } from './worktreeService.js';
import type { Project } from '../types/index.js';

/**
 * Selective, auditable migration of legacy tasks (no recorded `checkoutMode`). Only evidence decides a task:
 *  - isolated: its worktree (own, or a trusted manual link) is a live linked worktree of this project;
 *  - direct: a person identified its delivery commits (lifecycle `direct` claim), or it was accepted as a direct delivery.
 * A legacy task with no such evidence stays ambiguous and waits for an explicit choice in Review. Nothing is migrated
 * by the global setting, by age, or in bulk without that evidence. `planCheckoutMigration` only reads; apply recomputes
 * the plan and records each decision, with its evidence, in the task's lifecycle history.
 */

export interface MigrationItem { taskId: string; number?: number; title: string; checkoutMode: CheckoutChoice; evidence: string }
export interface AmbiguousItem { taskId: string; number?: number; title: string; reason: string }
export interface MigrationPlan { projectId: string; items: MigrationItem[]; ambiguous: AmbiguousItem[] }

export async function planCheckoutMigration(project: Project): Promise<MigrationPlan> {
  const legacy = (await taskStore.getAllTasks()).filter(t => t.projectId === project.id && !t.checkoutMode);
  const items: MigrationItem[] = [];
  const ambiguous: AmbiguousItem[] = [];
  for (const raw of legacy) {
    const base = { taskId: raw.id, number: raw.number, title: raw.title };
    const task = await withLink(raw);
    if (task.worktreePath) {
      if (await isLinkedWorktree(task.worktreePath)) {
        items.push({ ...base, checkoutMode: 'isolated', evidence: `live linked worktree ${task.worktreePath}` });
      } else {
        ambiguous.push({ ...base, reason: 'the recorded worktree is not a live linked worktree of this project; nothing is decided from it' });
      }
      continue;
    }
    const entry = await lifecycleStore.getEntry(project.id, raw.id);
    if (entry?.direct) {
      const d = entry.direct;
      items.push({ ...base, checkoutMode: 'direct', evidence: `delivery identified by a person (${d.basis}): ${d.baseSha}..${d.headSha} on ${d.targetBranch}` });
    } else if (entry?.accepted?.branch === '(direct)') {
      items.push({ ...base, checkoutMode: 'direct', evidence: 'accepted as a direct delivery' });
    } else {
      ambiguous.push({ ...base, reason: 'no evidence of where it was worked: needs a choice in Review' });
    }
  }
  return { projectId: project.id, items, ambiguous };
}

/** Records the planned decisions. `taskIds` limits it to some of them; anything refused by a check is reported, not forced. */
export async function applyCheckoutMigration(project: Project, taskIds?: string[]) {
  const plan = await planCheckoutMigration(project);
  const applied: { taskId: string; checkoutMode: CheckoutChoice }[] = [];
  const refused: { taskId: string; code: string; message: string }[] = [];
  for (const item of plan.items) {
    if (taskIds && !taskIds.includes(item.taskId)) continue;
    const r = await recordCheckoutChoice(project, item.taskId, item.checkoutMode, 'migration', item.evidence);
    if (r.ok) applied.push({ taskId: item.taskId, checkoutMode: item.checkoutMode });
    else refused.push({ taskId: item.taskId, code: r.code, message: r.message });
  }
  return { applied, refused, ambiguous: plan.ambiguous };
}
