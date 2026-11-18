import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { Button } from '@/components/ui/button'
import type { Task } from '@/hooks/useTasks'
import { useTaskLifecycleActions } from '@/hooks/useGit'
import type { TaskLifecycle } from '@/lib/api'

const short = (sha?: string | null) => (sha ? sha.slice(0, 7) : '')

/**
 * Direct checkout: the task has no branch, so Git cannot say which commits are its delivery. This lists what reached
 * the target branch since the task started — as candidates by time only — and lets a person identify the range.
 * Identifying is not accepting: Accept stays its own step, bound to the last commit of the range.
 */
export function DirectDeliveryPicker({ lc, task }: { lc: TaskLifecycle; task: Task }) {
  const d = lc.delivery.direct
  const actions = useTaskLifecycleActions(task.projectId, task.id)
  // Candidates are newest first (git log). The range is [first .. last] in history order.
  const list = d?.candidates ?? []
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (list.length) { setLast(list[0].sha); setFirst(list[list.length - 1].sha) }
  }, [list.length, list[0]?.sha])
  if (!d) return null

  const claimed = !!d.claim && !d.claimProblem
  const open = !claimed || editing
  const iFirst = list.findIndex(c => c.sha === first)
  const iLast = list.findIndex(c => c.sha === last)
  const valid = iFirst >= 0 && iLast >= 0 && iLast <= iFirst
  const selected = valid ? list.slice(iLast, iFirst + 1) : []

  const identify = async () => {
    try {
      await actions.identify.mutateAsync({ baseSha: `${first}~1`, headSha: last })
      toast.success('Delivery identified'); setEditing(false)
    } catch (e: any) { toast.error(e.message || 'Could not identify the delivery') }
  }
  const clear = async () => {
    try { await actions.clearDelivery.mutateAsync(); toast.success('Delivery cleared') }
    catch (e: any) { toast.error(e.message || 'Could not clear the delivery') }
  }
  const busy = actions.identify.isPending || actions.clearDelivery.isPending

  return (
    <section aria-label="Direct delivery" className="rounded-lg border bg-card p-3 space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <h3 className="font-medium uppercase tracking-wider text-muted-foreground">Delivery attribution</h3>
        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">Direct checkout · no worktree, no merge</span>
        {claimed && !editing && (
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setEditing(true)}>Change</Button>
            {!lc.acceptance.record && <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={busy} onClick={clear}>Clear</Button>}
          </span>
        )}
      </div>

      {d.uncertainty.map(u => <p key={u} className="flex items-start gap-1.5 text-muted-foreground"><AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />{u}</p>)}
      {claimed && d.claim && !editing && (
        <p className="font-mono text-muted-foreground">{short(d.claim.baseSha)}..{short(d.claim.headSha)} in {d.claim.targetBranch} · identified {format(new Date(d.claim.at), 'MMM d, HH:mm')}</p>
      )}

      {open && (list.length === 0
        ? <p className="text-muted-foreground">No commits reached the target branch since the task started.</p>
        : (
          <div className="space-y-2">
            <ul className="max-h-44 overflow-y-auto scrollbar-dark rounded border divide-y">
              {list.map((c, i) => (
                <li key={c.sha} className={`flex items-start gap-2 px-2 py-1 ${valid && i >= iLast && i <= iFirst ? 'bg-accent/40' : ''}`}>
                  <span className="font-mono text-muted-foreground">{short(c.sha)}</span>
                  <span className="min-w-0 flex-1 break-words">{c.subject}</span>
                  {c.trailer && <span className="rounded bg-success/15 px-1 text-success" title="Carries Shipyard-Task for this task">trailer</span>}
                  <span className="text-muted-foreground">{c.author}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1">First <select value={first} onChange={e => setFirst(e.target.value)} className="h-6 rounded border bg-background px-1 font-mono">{list.map(c => <option key={c.sha} value={c.sha}>{short(c.sha)}</option>)}</select></label>
              <label className="flex items-center gap-1">Last <select value={last} onChange={e => setLast(e.target.value)} className="h-6 rounded border bg-background px-1 font-mono">{list.map(c => <option key={c.sha} value={c.sha}>{short(c.sha)}</option>)}</select></label>
              <Button size="sm" className="gap-1.5 text-xs" disabled={!valid || busy} onClick={identify}>
                {actions.identify.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                These {selected.length} commit(s) are this task's delivery
              </Button>
              {editing && <Button size="sm" variant="ghost" className="gap-1 text-xs" onClick={() => setEditing(false)}><X className="h-3.5 w-3.5" />Cancel</Button>}
              {!valid && <span className="text-destructive">"First" must not be newer than "Last".</span>}
            </div>
          </div>
        ))}
      <p className="text-muted-foreground">Identifying the commits is not accepting them. Needs changes works the same without a worktree and never reverts a commit.</p>
    </section>
  )
}
