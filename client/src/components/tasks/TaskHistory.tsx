import { Fragment, useState } from 'react'
import { format, formatDistanceToNow, isSameDay } from 'date-fns'
import type { Task } from '@/hooks/useTasks'
import { useTaskLifecycle } from '@/hooks/useGit'
import { buildTaskHistory, type HistoryEntry, type HistoryKind } from '@/lib/taskHistory'
import { cn } from '@/lib/utils'

const LABELS: Record<HistoryKind, string> = {
  created: 'Created',
  inbox: 'Back to Inbox',
  started: 'Started',
  done: 'Marked done',
  note: 'Note',
  'follow-up': 'Client follow-up',
  attachment: 'Attachment from the client',
  comment: 'Comment on the board',
  edited: 'Edited',
  accepted: 'Delivery accepted',
  'acceptance-revoked': 'Acceptance revoked',
  integrated: 'Integrated',
  'integration-refused': 'Integration refused',
}

/** Delivery events read as a different kind of fact than task edits: they get their own dot. */
const LIFECYCLE: ReadonlySet<HistoryKind> = new Set(['accepted', 'acceptance-revoked', 'integrated', 'integration-refused'])

function dot(kind: HistoryKind) {
  if (kind === 'follow-up') return 'bg-primary'
  if (kind === 'done' || kind === 'integrated') return 'bg-success'
  if (kind === 'started') return 'bg-warning'
  if (kind === 'accepted') return 'bg-primary'
  if (kind === 'integration-refused') return 'bg-destructive'
  return 'bg-muted-foreground/40'
}

function Entry({ entry, fresh }: { entry: HistoryEntry; fresh: boolean }) {
  const [open, setOpen] = useState(false)
  const long = !!entry.body && entry.body.length > 280
  const date = new Date(entry.at)
  return (
    <li className="relative pl-5">
      <span className={cn('absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full ring-2 ring-background', dot(entry.kind))} aria-hidden />
      <div className="flex items-baseline gap-2 text-sm">
        <span className={cn('font-medium', fresh && 'text-primary')}>{LABELS[entry.kind]}</span>
        {LIFECYCLE.has(entry.kind) && <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">delivery</span>}
        <time className="text-xs text-muted-foreground ml-auto shrink-0" dateTime={date.toISOString()} title={format(date, 'yyyy-MM-dd HH:mm')}>
          {formatDistanceToNow(date, { addSuffix: true })}
        </time>
      </div>
      {entry.title && <p className={cn('mt-0.5 text-xs text-foreground/90 break-words', LIFECYCLE.has(entry.kind) && 'font-mono')}>{entry.title}</p>}
      {entry.body && (
        <>
          <p className={cn('mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground', long && !open && 'line-clamp-4')}>
            {entry.body}
          </p>
          {long && (
            <button onClick={() => setOpen(v => !v)} className="mt-0.5 text-xs text-muted-foreground/70 hover:text-foreground">
              {open ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
    </li>
  )
}

/**
 * The task's own timeline: what changed and when, newest first, including the
 * delivery events the lifecycle ledger recorded (accept, revoke, integrate).
 * Only events with a real timestamp appear; a status moved twice shows its last time.
 */
export function TaskHistory({ task, seenBefore }: { task: Task; seenBefore?: number }) {
  // Same query key as the Review tab, so this costs nothing extra once either is open.
  const { data: lc } = useTaskLifecycle(task.projectId, task.id, !!task.inProgressAt || !!task.worktreeBranch)
  const entries = buildTaskHistory(task, lc?.history)
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
  }

  // A day header only when the day changes, so a busy hour is not chopped up.
  const rows: { day?: string; entry: HistoryEntry }[] = []
  entries.forEach((e, i) => {
    const prev = entries[i - 1]
    rows.push({ entry: e, day: !prev || !isSameDay(prev.at, e.at) ? format(e.at, 'EEE, MMM d') : undefined })
  })

  return (
    <ol className="ml-1.5 space-y-3 border-l border-border/60" aria-label="Task timeline">
      {rows.map(({ entry, day }) => (
        <Fragment key={entry.id}>
          {day && <li aria-hidden className="pl-5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 list-none">{day}</li>}
          <Entry entry={entry} fresh={seenBefore != null && entry.at > seenBefore} />
        </Fragment>
      ))}
    </ol>
  )
}
