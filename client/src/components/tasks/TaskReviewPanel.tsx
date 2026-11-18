import { useMemo, useState, type ReactNode } from 'react'
import { TaskOutcomeCard } from '@/components/tasks/TaskOutcomeCard'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  GitCommit, ChevronDown, ChevronRight, Plus, Minus,
  Loader2, AlertTriangle, RotateCcw, X,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { useTaskGitReview, useCommitDiff, useTaskLifecycle } from '@/hooks/useGit'
import { LifecycleBar } from '@/components/tasks/LifecycleBar'
import { TaskGodotReview } from '@/components/tasks/TaskGodotReview'
import { DirectDeliveryPicker } from '@/components/tasks/DirectDeliveryPicker'
import { useAddTaskNote, type Task } from '@/hooks/useTasks'
import { DiffFileEntry, parseDiffByFile } from '@/components/git/DiffView'
import type { TaskCommit } from '@/lib/api'

// A finished task is bounded at doneAt so unrelated later work stays out. The
// grace covers the agent that commits right after marking the task done.
const DONE_GRACE_MS = 15 * 60 * 1000

function relative(date?: string) {
  if (!date) return ''
  try { return formatDistanceToNow(new Date(date), { addSuffix: true }) }
  catch { return '' }
}

function CommitEntry({ projectId, commit }: { projectId: string; commit: TaskCommit }) {
  const [expanded, setExpanded] = useState(false)
  // Only fetch the diff once the user asks for it
  const { data, isLoading } = useCommitDiff(expanded ? projectId : undefined, expanded ? commit.hash : undefined)

  const fileDiffs = useMemo(() => {
    if (!data?.diff) return new Map<string, string>()
    return parseDiffByFile(data.diff)
  }, [data?.diff])

  const statusByFile = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of data?.files || []) map.set(f.file, f.status)
    return map
  }, [data?.files])

  return (
    <div className="relative pl-6">
      {/* timeline rail + dot */}
      <span className="absolute left-[5px] top-4 bottom-0 w-px bg-border" aria-hidden />
      <span className="absolute left-0 top-[9px] h-2.5 w-2.5 rounded-full border-2 border-primary bg-background" aria-hidden />

      <button
        className="flex items-start gap-2 w-full text-left rounded px-2 py-1.5 -ml-1 hover:bg-accent/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />}
        <div className="flex-1 min-w-0">
          <p className="text-xs leading-snug break-words">{commit.message}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {commit.author_name} &middot; {relative(commit.date)} &middot;{' '}
            <span className="font-mono">{commit.hash.substring(0, 7)}</span>
            {commit.files.length > 0 && <> &middot; {commit.files.length} file{commit.files.length !== 1 ? 's' : ''}</>}
          </p>
        </div>
        {commit.additions > 0 && (
          <span className="text-[10px] text-success flex items-center gap-0.5 shrink-0 mt-0.5">
            <Plus className="h-2.5 w-2.5" />{commit.additions}
          </span>
        )}
        {commit.deletions > 0 && (
          <span className="text-[10px] text-destructive flex items-center gap-0.5 shrink-0 mt-0.5">
            <Minus className="h-2.5 w-2.5" />{commit.deletions}
          </span>
        )}
      </button>

      {expanded && (
        <div className="space-y-1.5 mt-1 mb-3">
          {isLoading && (
            <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading diff...
            </div>
          )}
          {commit.files.map(file => (
            <DiffFileEntry
              key={file.file}
              compact
              file={file.file}
              status={statusByFile.get(file.file)}
              additions={file.additions}
              deletions={file.deletions}
              diff={fileDiffs.get(file.file)}
              defaultExpanded={commit.files.length <= 4}
            />
          ))}
          {!isLoading && commit.files.length === 0 && (
            <p className="text-xs text-muted-foreground py-2">Merge commit &mdash; no file changes of its own.</p>
          )}
        </div>
      )}
    </div>
  )
}

interface TaskReviewPanelProps {
  task: Task
  onDone: () => void
  /** R2-A2 integration point: worktree, local-change and cleanup sections, rendered inside the delivery card. */
  extraSections?: ReactNode
}

export function TaskReviewPanel({ task, onDone, extraSections }: TaskReviewPanelProps) {
  const until = task.doneAt
    ? new Date(new Date(task.doneAt).getTime() + DONE_GRACE_MS).toISOString()
    : undefined
  const lifecycle = useTaskLifecycle(task.projectId, task.id)
  const lc = lifecycle.data
  // With a worktree branch the review is exact (branch vs target). Without one only the
  // old date window exists, and the lifecycle says plainly that nothing can be verified.
  // A direct delivery is exact only once a person identified it; until then the date window still shows what to look at.
  const branchMode = lc?.delivery.mode === 'branch' || (lc?.delivery.mode === 'direct' && !!lc.delivery.direct?.claim)
  const windowReview = useTaskGitReview(task.projectId, task.inProgressAt, until, undefined, lifecycle.isFetched && !branchMode)
  const data = branchMode && lc
    ? { available: true, branch: lc.delivery.branch ?? null, commits: lc.delivery.commits, files: lc.delivery.files, additions: lc.delivery.additions, deletions: lc.delivery.deletions, working: null }
    : windowReview.data
  const isLoading = lifecycle.isLoading || (!branchMode && windowReview.isLoading)
  const addNote = useAddTaskNote()
  const [reasonOpen, setReasonOpen] = useState(false)
  const [reason, setReason] = useState('')

  const dirty = !branchMode && data?.working
    ? data.working.staged + data.working.unstaged + data.working.untracked
    : 0

  const handleNeedsChanges = async () => {
    const text = reason.trim()
    if (!text) return
    // The delivery being sent back is named in the note, so the next session knows which commit it is correcting.
    const head = lc?.delivery.head ?? undefined
    const delivery = head ? `\n\nDelivery sent back: ${head.slice(0, 7)} (${commits.length} commit${commits.length === 1 ? '' : 's'}).` : ''
    try {
      await addNote.mutateAsync({
        projectId: task.projectId,
        taskId: task.id,
        note: `Needs changes: ${text}${delivery}`,
        status: 'in_progress',
        reviewedHeadSha: head,
      })
      toast.success('Sent back to In Progress')
      onDone()
    } catch (err: any) {
      toast.error(err.message || 'Could not save the note')
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading git history...
      </div>
    )
  }

  if (data && !data.available) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        This project is not a git repository, so there is nothing to review here.
      </p>
    )
  }

  const commits = data?.commits || []
  const files = data?.files || []

  const needsChanges = reasonOpen ? null : (
    <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => setReasonOpen(true)}>
      <RotateCcw className="h-3.5 w-3.5" />
      Needs changes
    </Button>
  )

  return (
    <div className="space-y-4">
      {lc && <LifecycleBar lc={lc} task={task} extraActions={needsChanges}>{extraSections}</LifecycleBar>}

      {lc?.delivery.mode === 'direct' && <DirectDeliveryPicker lc={lc} task={task} />}

      <TaskGodotReview task={task} />

      {reasonOpen && (
        <div className="space-y-2 rounded-lg border p-3">
          <Textarea
            autoFocus
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="What still needs to change?"
            className="text-xs min-h-[70px]"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" className="gap-1.5 text-xs" onClick={handleNeedsChanges} disabled={!reason.trim() || addNote.isPending}>
              {addNote.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              Send back to In Progress
            </Button>
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={() => setReasonOpen(false)}>
              <X className="h-3.5 w-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      )}

      {dirty > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2" role="alert">
          <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
          <p className="text-xs leading-relaxed">
            {dirty} change{dirty !== 1 ? 's' : ''} left uncommitted in the working tree
            {data?.working && (
              <span className="text-muted-foreground">
                {' '}({data.working.staged} staged, {data.working.unstaged} modified, {data.working.untracked} untracked)
              </span>
            )}
            . Check the Git panel before signing this off.
          </p>
        </div>
      )}

      {/* What was delivered */}
      <section aria-label="Delivered work" className="space-y-2">
        <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap">
          <h3 className="text-sm font-medium">Delivered work</h3>
          <p className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
            <span>
              {commits.length} commit{commits.length !== 1 ? 's' : ''}{' '}
              {branchMode ? (lc?.delivery.mode === 'direct' ? `identified in ${lc?.target.branch ?? 'target'}` : `ahead of ${lc?.target.branch ?? 'target'}`) : <>since started {relative(task.inProgressAt)}</>}
            </span>
            {files.length > 0 && <span>· {files.length} file{files.length !== 1 ? 's' : ''}</span>}
            {(data?.additions ?? 0) > 0 && <span className="text-success inline-flex items-center gap-0.5"><Plus className="h-2.5 w-2.5" />{data!.additions}</span>}
            {(data?.deletions ?? 0) > 0 && <span className="text-destructive inline-flex items-center gap-0.5"><Minus className="h-2.5 w-2.5" />{data!.deletions}</span>}
          </p>
        </div>

        {commits.length === 0 ? (
          <div className="rounded-lg border border-dashed text-center py-6 px-4 space-y-1">
            <GitCommit className="h-5 w-5 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No commits since task started</p>
            <p className="text-xs text-muted-foreground/80 max-w-sm mx-auto leading-relaxed">
              The work may still be uncommitted, may live on another branch
              {data?.branch && <> (this one is <span className="font-mono">{data.branch}</span>)</>}
              , or in a sub-repository.
            </p>
          </div>
        ) : (
          <div>
            {commits.map(commit => (
              <CommitEntry key={commit.hash} projectId={task.projectId} commit={commit} />
            ))}
          </div>
        )}
      </section>

      {/* Files touched across the whole delivery */}
      {files.length > 0 && (
        <details className="group rounded-lg border px-3 py-2">
          <summary className="flex items-center gap-1.5 cursor-pointer select-none text-xs font-medium list-none [&::-webkit-details-marker]:hidden rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
            Files touched ({files.length})
          </summary>
          <div className="mt-2 space-y-0.5">
            {files.map(f => (
              <div key={f.file} className="flex items-center gap-2 text-[11px]">
                <span className="font-mono truncate flex-1" title={f.file}>{f.file}</span>
                {f.additions > 0 && <span className="text-success shrink-0">+{f.additions}</span>}
                {f.deletions > 0 && <span className="text-destructive shrink-0">-{f.deletions}</span>}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Evidence: what the agent reported, when it recorded anything */}
      {(task.resolution || task.rootCause) && (
        <section aria-label="Agent report" className="space-y-1.5">
          <h3 className="text-sm font-medium">Agent report</h3>
          <TaskOutcomeCard task={task} />
        </section>
      )}
    </div>
  )
}
