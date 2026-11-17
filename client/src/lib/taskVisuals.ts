import {
  AlertTriangle, ArrowUp, ArrowDown, Minus,
  Inbox, Loader, CheckCircle2, CircleDashed, CircleDot, GitMerge,
} from 'lucide-react'
import type { Task } from '@/hooks/useTasks'
import type { TaskLifecycleSummary } from '@/lib/api'

/*
 * Single source of truth for how priorities and statuses look across the app.
 * Only urgent/high carry color so the board stays calm; medium/low recede.
 * Status hues map to the semantic tokens in index.css:
 *   inbox/todo → primary (blue) · in_progress → warning (amber) · done → success (green)
 */

export interface PriorityVisual {
  icon: React.ElementType
  color: string
  /** pill style for badge-like contexts (import dialogs, chips) */
  badge: string
  label: string
  order: number
}

export const PRIORITY_CONFIG: Record<Task['priority'], PriorityVisual> = {
  urgent: { icon: AlertTriangle, color: 'text-destructive', badge: 'bg-destructive/15 text-destructive', label: 'Urgent', order: 0 },
  high: { icon: ArrowUp, color: 'text-warning', badge: 'bg-warning/15 text-warning', label: 'High', order: 1 },
  medium: { icon: Minus, color: 'text-muted-foreground', badge: 'bg-muted text-muted-foreground', label: 'Medium', order: 2 },
  low: { icon: ArrowDown, color: 'text-muted-foreground/60', badge: 'bg-muted text-muted-foreground/70', label: 'Low', order: 3 },
}

export interface StatusVisual {
  icon: React.ElementType
  color: string
  label: string
  badgeVariant: 'default' | 'secondary' | 'outline'
}

export const STATUS_CONFIG: Record<Task['status'], StatusVisual> = {
  backlog: { icon: Inbox, color: 'text-muted-foreground', label: 'Backlog', badgeVariant: 'outline' },
  todo: { icon: Inbox, color: 'text-primary', label: 'To Do', badgeVariant: 'secondary' },
  in_progress: { icon: Loader, color: 'text-warning', label: 'In Progress', badgeVariant: 'default' },
  done: { icon: CheckCircle2, color: 'text-success', label: 'Done', badgeVariant: 'outline' },
}

/*
 * Lifecycle of a finished task (R2-A1), drawn on top of `status`. `status: done` only
 * says the agent stopped; what the owner needs to know is whether a person reviewed
 * the delivery and whether Git has it in the target branch. Shape and wording carry
 * the meaning; the only warm tone stays "needs you" (review), per the neutral palette.
 */
export type LifecycleGroup = 'review' | 'ready' | 'merged' | 'other'

export interface LifecycleVisual {
  group: LifecycleGroup
  icon: React.ElementType
  /** Icon color, replacing the always-green check on a done card. */
  color: string
  label: string
  /** Chip classes: text and a faint fill of the same token. */
  chip: string
  title: string
}

/** Null for tasks with no worktree branch (nothing verifiable) and for tasks not yet finished. */
export function lifecycleVisual(task: Pick<Task, 'status'>, s?: TaskLifecycleSummary): LifecycleVisual | null {
  if (!s || task.status !== 'done') return null
  const review = (label: string, title: string, destructive = false): LifecycleVisual => ({
    group: 'review', icon: destructive ? AlertTriangle : CircleDashed,
    color: destructive ? 'text-destructive' : 'text-warning',
    label, title, chip: destructive ? 'bg-destructive/15 text-destructive' : 'bg-warning/15 text-warning',
  })
  if (s.integration === 'integrated') {
    return { group: 'merged', icon: GitMerge, color: 'text-success', label: 'Merged', title: 'Git shows the accepted commit in the target branch', chip: 'bg-muted text-muted-foreground' }
  }
  if (s.flag === 'branch-missing') return { group: 'other', icon: AlertTriangle, color: 'text-muted-foreground', label: 'Branch gone', title: 'The task branch no longer exists and the work was never integrated', chip: 'bg-muted text-muted-foreground' }
  if (s.integration === 'nothing-to-integrate') return { group: 'other', icon: Minus, color: 'text-muted-foreground', label: 'No changes', title: 'The branch has no commits beyond the target', chip: 'bg-muted text-muted-foreground' }
  if (s.flag === 'patch-equivalent') return review('Equivalent', 'Same patch exists in the target without being an ancestor (cherry-pick or rebase). Not treated as integrated')
  if (s.acceptance === 'lapsed') return review('Re-review', 'The branch moved after it was accepted', true)
  if (s.acceptance === 'accepted') {
    if (s.flag === 'conflict') return { group: 'ready', icon: AlertTriangle, color: 'text-destructive', label: 'Conflict', title: 'Accepted, but merging conflicts and needs a decision', chip: 'bg-destructive/15 text-destructive' }
    return { group: 'ready', icon: CircleDot, color: 'text-primary', label: 'Ready to merge', title: 'Accepted by a person; not yet in the target branch', chip: 'bg-primary/15 text-primary' }
  }
  return review('Review', 'Delivered, waiting for a person to review it')
}

export function priorityVisual(priority: Task['priority']): PriorityVisual {
  return PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.medium
}

export function statusVisual(status: Task['status']): StatusVisual {
  return STATUS_CONFIG[status] || STATUS_CONFIG.todo
}
