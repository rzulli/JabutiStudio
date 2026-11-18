import type { TaskLifecycle } from '@/lib/api'

/*
 * Plain-language reading of a task's lifecycle for the TaskViewer. Presentation
 * only: every fact comes from the lifecycle payload the server already derives,
 * nothing here decides what is allowed (the server still validates Accept and
 * Integrate).
 */

export type StageTone = 'neutral' | 'attention' | 'ready' | 'done' | 'danger'

export interface StageReading {
  /** Short name of the delivery stage ("In review"). */
  label: string
  tone: StageTone
  /** One sentence: what this stage means. */
  meaning: string
  /** One sentence: what the person should do next (or that nothing is left). */
  next: string
}

export const STAGE_LABEL: Record<TaskLifecycle['stage'], string> = {
  READY: 'Ready',
  RUNNING: 'Running',
  REVIEW: 'In review',
  ACCEPTED: 'Accepted',
  INTEGRATED: 'Integrated',
  CLOSED: 'Closed',
}

export function readStage(lc: TaskLifecycle): StageReading {
  const target = lc.target.branch || 'the target branch'
  const blocked = lc.blockers.length > 0
  switch (lc.stage) {
    case 'READY':
      return { label: STAGE_LABEL.READY, tone: 'neutral', meaning: 'No delivery yet. Nothing has been committed for this task.', next: 'Run an agent on it, or move it to In Progress.' }
    case 'RUNNING':
      return { label: STAGE_LABEL.RUNNING, tone: 'attention', meaning: 'An agent is still working on this task.', next: 'Review it once the agent stops.' }
    case 'REVIEW':
      if (lc.delivery.mode === 'none') {
        return { label: 'Not tracked', tone: 'neutral', meaning: 'This project is not a Git repository (or the task branch history is gone), so Git cannot say what it delivered.', next: 'Check the work by hand, or use Needs changes.' }
      }
      if (lc.delivery.mode === 'direct') {
        const d = lc.delivery.direct
        if (!d?.claim) {
          return {
            label: 'Delivery not identified', tone: 'attention',
            meaning: `The task was worked directly in the ${target} checkout, so there is no branch to compare. The agent is done, but no commits have been tied to it yet.`,
            next: d?.candidates.length ? 'Choose which commits are the delivery of this task, or use Needs changes.' : 'No commits since the task started: check the work by hand, or use Needs changes.',
          }
        }
        if (d.claimProblem) return { label: 'Delivery needs identifying again', tone: 'danger', meaning: d.claimProblem, next: 'Identify the delivery again, or use Needs changes.' }
        return {
          label: STAGE_LABEL.REVIEW, tone: 'attention',
          meaning: `Delivery identified: ${lc.delivery.commits.length} commit(s) already in ${target}. Committed directly, so there is nothing to merge.`,
          next: lc.canAccept ? 'Review the commits, then accept this exact delivery.' : blocked ? 'Resolve the blockers before accepting.' : 'Waiting on the delivery to become acceptable.',
        }
      }
      if (lc.delivery.commits.length === 0) {
        return {
          label: STAGE_LABEL.REVIEW, tone: 'attention',
          meaning: `The task branch has no commits beyond ${target}, so there is nothing to accept.`,
          next: 'If the work was code, use Needs changes. If it was research or admin work, there is nothing to merge.',
        }
      }
      return {
        label: STAGE_LABEL.REVIEW, tone: 'attention',
        meaning: 'The agent delivered commits. A person still has to look at them.',
        next: lc.canAccept ? 'Review the commits, then accept this exact delivery.' : blocked ? 'Resolve the blockers before accepting.' : 'Waiting on the delivery to become acceptable.',
      }
    case 'ACCEPTED':
      return {
        label: STAGE_LABEL.ACCEPTED, tone: lc.integration.mergeable === 'conflict' ? 'danger' : 'ready',
        meaning: `You accepted this delivery. It is not in ${target} yet.`,
        next: lc.canIntegrate ? `Integrate it into ${target}.` : blocked ? 'Resolve the blockers before integrating.' : 'Waiting on the target branch to be ready.',
      }
    case 'INTEGRATED':
      return {
        label: STAGE_LABEL.INTEGRATED, tone: 'done',
        meaning: lc.delivery.mode === 'direct' ? `You accepted this delivery, which was committed directly in ${target}. No merge was needed.` : `Git shows the accepted commit inside ${target}.`,
        next: 'Nothing left to do for this delivery.',
      }
    case 'CLOSED':
      return { label: STAGE_LABEL.CLOSED, tone: 'done', meaning: 'Integrated and cleaned up.', next: 'Nothing left to do.' }
  }
}

export const TONE_CLASS: Record<StageTone, { chip: string; dot: string }> = {
  neutral: { chip: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/50' },
  attention: { chip: 'bg-warning/15 text-warning', dot: 'bg-warning' },
  ready: { chip: 'bg-primary/15 text-primary', dot: 'bg-primary' },
  done: { chip: 'bg-muted text-foreground', dot: 'bg-success' },
  danger: { chip: 'bg-destructive/15 text-destructive', dot: 'bg-destructive' },
}

/** Operational status wording used next to the delivery stage. */
export const STATUS_MEANING: Record<string, string> = {
  backlog: 'Not scheduled yet.',
  todo: 'Waiting to be started.',
  in_progress: 'Someone or an agent is working on it.',
  done: 'The work was marked finished — by the agent or by you.',
}
