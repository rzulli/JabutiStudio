import { useState, useEffect, type ReactNode } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Pencil, Copy, Inbox, Loader, CheckCircle2, Trash2, Check, Wand2, Loader2, GitCommit, GitBranch, History, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUpdateTask, useDeleteTask, type Task } from '@/hooks/useTasks'
import { buildTaskPrompt } from '@/lib/promptBuilder'
import { useClaudeStatus, useAnalyzeTask } from '@/hooks/useClaude'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { TaskAttachments } from '@/components/tasks/TaskAttachments'
import { TaskComments } from '@/components/tasks/TaskComments'
import { AgentSelect } from '@/components/tasks/AgentSelect'
import { TaskReviewPanel } from '@/components/tasks/TaskReviewPanel'
import { TaskOutcomeCard } from '@/components/tasks/TaskOutcomeCard'
import { TaskHistory } from '@/components/tasks/TaskHistory'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { playAiCompleteSound } from '@/lib/sounds'
import { priorityVisual, statusVisual } from '@/lib/taskVisuals'
import { useTaskLifecycle } from '@/hooks/useGit'
import { readStage, TONE_CLASS, STATUS_MEANING } from '@/lib/lifecycleCopy'

interface TaskViewerProps {
  task: Task | null
  projectName?: string
  projectPath?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit: (task: Task) => void
}

function formatDate(date?: string) {
  if (!date) return null
  try { return formatDistanceToNow(new Date(date), { addSuffix: true }) }
  catch { return null }
}

export function TaskViewer({ task: taskProp, projectName, projectPath, open, onOpenChange, onEdit }: TaskViewerProps) {
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: Infinity })
  const updateTask = useUpdateTask()
  const deleteTask = useDeleteTask()
  const { data: claudeStatus } = useClaudeStatus()
  const analyzeTask = useAnalyzeTask()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [tab, setTab] = useState<'details' | 'history' | 'review'>('details')
  // Set when the task was opened with a client follow-up not seen yet.
  const [unseenSince, setUnseenSince] = useState<number | undefined>()
  const canAiImprove = !!(claudeStatus?.configured || claudeStatus?.cliAvailable)

  // The caller passes a snapshot captured when the dialog opened, so a comment
  // or screenshot the client adds on Trello meanwhile would never appear. Task
  // queries are keyed per milestone, so scan the project's cached lists and
  // keep whichever copy is newest — an inactive cache entry can be older than
  // the prop we were handed.
  const queryClient = useQueryClient()
  let task = taskProp
  if (taskProp) {
    for (const [key, tasks] of queryClient.getQueriesData<Task[]>({ queryKey: ['tasks', taskProp.projectId] })) {
      // Guard against a project literally named "all" colliding with the
      // cross-project list, which carries counts instead of the bodies.
      if (key.length !== 3) continue
      const found = tasks?.find(t => t.id === taskProp.id)
      if (found && new Date(found.updatedAt).getTime() > new Date(task!.updatedAt).getTime()) {
        task = found
      }
    }
  }

  // Opened from the global Tasks page, the task comes from the cross-project
  // list, which ships counts instead of comment bodies. Fetch the project's
  // tasks so the dialog can actually show what the badges promise.
  const needsBodies = !!taskProp && !!open
    && ((taskProp.commentCount ?? 0) > 0 || (taskProp.attachmentCount ?? 0) > 0)
    && !task?.comments && !task?.attachments
  const { data: projectTasks } = useQuery({
    queryKey: ['tasks', taskProp?.projectId ?? '', 'all'],
    queryFn: () => api.getTasks(taskProp!.projectId).then(r => r.tasks as Task[]),
    enabled: needsBodies,
  })
  if (needsBodies && projectTasks) {
    task = projectTasks.find(t => t.id === taskProp!.id) ?? task
  }

  // A task opened because a client follow-up arrived starts on its history:
  // the question is "what changed?", not "what is this task?". Read before
  // the effect below clears the mark.
  useEffect(() => {
    if (!open) return
    const unseen = !!task?.needsReview && !!task?.followUpAt
    setTab(unseen ? 'history' : 'details')
    setUnseenSince(unseen ? Date.parse(task!.followUpAt!) - 60_000 : undefined)
  }, [open, taskProp?.id])

  // Clear "needs review" indicator when the user opens/views the task
  useEffect(() => {
    if (open && task?.needsReview) {
      updateTask.mutate({ projectId: task.projectId, taskId: task.id, needsReview: false })
    }
  }, [open, task?.id, task?.needsReview])

  // Same query key the Review and History tabs use, so the header costs no extra request.
  const lcQuery = useTaskLifecycle(task?.projectId, task?.id, !!task && !!open && (!!task.inProgressAt || !!task.worktreeBranch))

  if (!task) return null

  // A task that never reached In Progress has no window of commits to show.
  const showReview = !!task.inProgressAt
  const lcReading = lcQuery.data ? readStage(lcQuery.data) : null

  const pri = priorityVisual(task.priority)
  const sts = statusVisual(task.status)
  const PriIcon = pri.icon
  const StsIcon = sts.icon

  const handleCopy = () => {
    const prompt = buildTaskPrompt(task, projectName, projectPath, settings?.tasksDir)
    navigator.clipboard.writeText(prompt)
    toast.success('Copied to clipboard')
  }

  const handleEdit = () => {
    onOpenChange(false)
    onEdit(task)
  }

  const handleAiImprove = async () => {
    try {
      const result = await analyzeTask.mutateAsync({
        projectId: task.projectId,
        title: task.title,
        taskId: task.id,
      })
      updateTask.mutate({
        projectId: task.projectId,
        taskId: task.id,
        description: result.description,
        prompt: result.prompt,
      })
      playAiCompleteSound()
      toast.success('Task improved with AI')
    } catch (err: any) {
      toast.error(err.message || 'AI analysis failed')
    }
  }

  const handleAgentChange = (agentId: string) => {
    updateTask.mutate({ projectId: task.projectId, taskId: task.id, agent: agentId })
  }

  const handleStatusChange = (status: Task['status']) => {
    updateTask.mutate({ projectId: task.projectId, taskId: task.id, status })
    onOpenChange(false)
  }

  const handleDelete = () => {
    deleteTask.mutate({ projectId: task.projectId, taskId: task.id })
    setDeleteOpen(false)
    onOpenChange(false)
  }

  const statusActions = [
    { status: 'todo' as const, label: 'Inbox', icon: Inbox, color: 'text-primary' },
    { status: 'in_progress' as const, label: 'In Progress', icon: Loader, color: 'text-warning' },
    { status: 'done' as const, label: 'Done', icon: CheckCircle2, color: 'text-success' },
  ]

  const lines = (t: string) => `${t.split('\n').length} line${t.split('\n').length === 1 ? '' : 's'}`

  const dates: { label: string; value: string | null; strong?: boolean }[] = [
    { label: 'Created', value: task.createdAt ? formatDate(task.createdAt) : null },
    { label: 'Started', value: task.inProgressAt ? formatDate(task.inProgressAt) : null },
    { label: 'Done', value: task.doneAt ? formatDate(task.doneAt) : null },
    { label: 'Follow-up', value: task.followUpAt ? formatDate(task.followUpAt) : null, strong: true },
  ]

  const detailsBody = (
    <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_200px]">
      <div className="space-y-4 min-w-0">
        <TaskOutcomeCard task={task} onEdit={handleEdit} />

        {task.description ? (
          <Section title="Description">
            <p className="text-sm whitespace-pre-wrap leading-relaxed break-words">{task.description}</p>
          </Section>
        ) : !task.prompt && (
          <p className="text-sm text-muted-foreground">No description yet. <button className="underline underline-offset-2 hover:text-foreground" onClick={handleEdit}>Add one</button></p>
        )}

        {task.subtasks && task.subtasks.length > 0 && (
          <Section title={`Subtasks (${task.subtasks.filter(s => s.done).length}/${task.subtasks.length})`}>
            <ul className="space-y-1">
              {task.subtasks.map((st) => (
                <li key={st.id} className="flex items-start gap-2">
                  {st.done ? (
                    <Check className="h-3.5 w-3.5 text-success shrink-0 mt-1" />
                  ) : (
                    <div className="h-3.5 w-3.5 rounded-sm border border-muted-foreground/40 shrink-0 mt-1" />
                  )}
                  <span className={cn('text-sm', st.done && 'text-muted-foreground')}>{st.title}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {task.attachments && task.attachments.length > 0 && (
          <Section title="Attachments">
            <TaskAttachments
              projectId={task.projectId}
              taskId={task.id}
              milestoneId={task.milestoneId}
              attachments={task.attachments}
            />
          </Section>
        )}

        {task.comments && task.comments.length > 0 && (
          <Section title={`Comments (${task.comments.length})`}>
            <TaskComments comments={task.comments} />
          </Section>
        )}

        {task.prompt && (
          <Fold title="Technical notes" hint={lines(task.prompt)}>
            <pre className="text-xs font-mono bg-muted/50 rounded-md p-3 whitespace-pre-wrap max-h-64 overflow-y-auto">{task.prompt}</pre>
          </Fold>
        )}

        {task.context && (
          <Fold title="Private context" hint="never sent to Trello, ClickUp or Sheets">
            <pre className="text-xs font-mono bg-muted/50 rounded-md p-3 whitespace-pre-wrap max-h-64 overflow-y-auto">{task.context}</pre>
          </Fold>
        )}
      </div>

      {/* Properties: administrative, so they sit beside the content and stay quiet */}
      <aside aria-label="Properties" className="space-y-4 sm:border-l sm:pl-5 text-xs">
        <div className="space-y-1.5">
          <h3 className="font-medium text-muted-foreground uppercase tracking-wider">Agent</h3>
          <AgentSelect value={task.agent} onChange={handleAgentChange} />
          <p className="text-muted-foreground/80 leading-snug">Runs this task when you pick Run with AI.</p>
        </div>

        {task.worktreeBranch && (
          <div className="space-y-1.5">
            <h3 className="font-medium text-muted-foreground uppercase tracking-wider">Worktree</h3>
            <p className="flex items-start gap-1.5 font-mono break-all" title={task.worktreePath}>
              <GitBranch className="h-3.5 w-3.5 shrink-0 mt-px text-muted-foreground" />
              {task.worktreeBranch}
            </p>
            {/* R2-A2 integration point: linked-worktree health, local changes and cleanup safety. */}
          </div>
        )}

        <div className="space-y-1.5">
          <h3 className="font-medium text-muted-foreground uppercase tracking-wider">Timeline</h3>
          <dl className="space-y-1">
            {dates.filter(d => d.value).map(d => (
              <div key={d.label} className="grid grid-cols-[64px_1fr] gap-2">
                <dt className="text-muted-foreground">{d.label}</dt>
                <dd className={cn(d.strong && 'text-foreground')}>{d.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </aside>
    </div>
  )

  const current = statusActions.find(a => task.status === a.status || (a.status === 'todo' && task.status === 'backlog'))
  const needsAction = lcQuery.data?.stage === 'REVIEW' && lcQuery.data.delivery.mode !== 'none'
  const lcTone = lcReading ? TONE_CLASS[lcReading.tone] : null
  const lower = (t: string) => t.replace(/\.$/, '').replace(/^./, c => c.toLowerCase())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // One size for every tab: the dialog must not jump when the tab changes.
        className="h-[min(84vh,700px)] max-h-[86vh] flex flex-col gap-3 sm:max-w-[780px] w-[calc(100vw-2rem)]"
      >
        <DialogHeader className="shrink-0 space-y-2 pr-6">
          <p className="text-xs text-muted-foreground font-mono select-all">
            #{task.number || '?'}{projectName ? <span className="font-sans"> · {projectName}</span> : null}
          </p>
          <DialogTitle className="text-lg leading-snug font-semibold break-words">{task.title}</DialogTitle>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs" title={STATUS_MEANING[task.status]}>
              <StsIcon className={cn('h-3 w-3', sts.color)} />
              <span className="text-muted-foreground">Status</span>
              <span className="font-medium">{sts.label}</span>
            </span>
            {lcReading && lcTone && lcQuery.data && (
              <button
                type="button"
                onClick={() => showReview && setTab('review')}
                title="Open the Review tab"
                className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', lcTone.chip)}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', lcTone.dot)} aria-hidden />
                <span className="opacity-80">Delivery</span>
                <span className="font-medium">{lcReading.label}</span>
              </button>
            )}
            <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs">
              <PriIcon className={cn('h-3 w-3', pri.color)} />
              {pri.label}
            </span>
            {task.effort && <span className="rounded-full border px-2.5 py-0.5 text-xs">{task.effort} pts</span>}
          </div>
          {lcReading && lcQuery.data && (
            <p className="text-xs text-muted-foreground leading-snug">
              <span className="text-foreground/80">{sts.label}</span> is the board column: {lower(STATUS_MEANING[task.status])}.{' '}
              <span className="text-foreground/80">{lcReading.label}</span> is the delivery stage: {lower(lcReading.meaning)}.
            </p>
          )}
        </DialogHeader>

        <Tabs value={tab} onValueChange={v => setTab(v as 'details' | 'history' | 'review')} className="flex flex-col min-h-0 flex-1">
          <TabsList className="h-9 p-0.5 self-start shrink-0">
            <TabsTrigger value="details" className="h-8 text-xs px-3">Details</TabsTrigger>
            <TabsTrigger value="history" className="h-8 text-xs px-3 gap-1.5">
              <History className="h-3 w-3" />
              History
            </TabsTrigger>
            {showReview && (
              <TabsTrigger value="review" className="h-8 text-xs px-3 gap-1.5">
                <GitCommit className="h-3 w-3" />
                Review
                {needsAction && <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-label="needs your review" />}
              </TabsTrigger>
            )}
          </TabsList>
          {/* One scroll region, always the same box: tabs differ in content, not in frame */}
          <TabsContent value="details" className="mt-3 overflow-y-auto min-h-0 flex-1 pr-1">
            {detailsBody}
          </TabsContent>
          <TabsContent value="history" className="mt-3 overflow-y-auto min-h-0 flex-1 pr-1">
            <TaskHistory task={task} seenBefore={unseenSince} />
          </TabsContent>
          {showReview && (
            <TabsContent value="review" className="mt-3 overflow-y-auto min-h-0 flex-1 pr-1">
              <TaskReviewPanel task={task} onDone={() => onOpenChange(false)} />
            </TabsContent>
          )}
        </Tabs>

        <div className="flex items-center justify-between gap-2 pt-3 border-t shrink-0 flex-wrap">
          <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete task?</AlertDialogTitle>
                <AlertDialogDescription>
                  "{task.title}" will be permanently deleted. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <div className="flex items-center gap-2 flex-wrap">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                  Move to
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {statusActions.map(({ status, label, icon: Icon, color }) => (
                  <DropdownMenuItem key={status} disabled={current?.status === status} className="gap-2 text-xs" onSelect={() => handleStatusChange(status)}>
                    <Icon className={cn('h-3.5 w-3.5', color)} />
                    {label}
                    {current?.status === status && <Check className="h-3 w-3 ml-auto" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={handleCopy}>
              <Copy className="h-3.5 w-3.5" />
              Copy as Prompt
            </Button>
            {canAiImprove && task.status !== 'done' && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs text-primary hover:text-primary/80"
                onClick={handleAiImprove}
                disabled={analyzeTask.isPending}
              >
                {analyzeTask.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                AI Improve
              </Button>
            )}
            <Button variant="default" size="sm" className="gap-1.5 text-xs" onClick={handleEdit}>
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</h3>
      {children}
    </section>
  )
}

/** Technical text stays one click away: it is reference, not the answer. */
function Fold({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border px-3 py-2">
      <summary className="flex items-center gap-1.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-xs font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
        {title}
        {hint && <span className="font-normal text-muted-foreground">· {hint}</span>}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  )
}
