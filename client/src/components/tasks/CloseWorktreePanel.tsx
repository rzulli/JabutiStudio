import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, Check, X, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useClosePreview, useCloseTask } from '@/hooks/useGit'
import type { Task } from '@/hooks/useTasks'

const short = (h?: string | null) => (h || '').substring(0, 7)

/**
 * The review step before removing a task's worktree. Everything shown comes from the
 * server's preview of the exact state; the confirm sends that preview's token, and the
 * server re-reads Git and refuses if anything moved since. Nothing is removed by default:
 * ignored files need their own acknowledgement.
 */
export function CloseWorktreePanel({ task, onCancel }: { task: Task; onCancel: () => void }) {
  const preview = useClosePreview(task.projectId, task.id, true)
  const close = useCloseTask(task.projectId, task.id)
  const [ack, setAck] = useState(false)
  const p = preview.data

  if (preview.isLoading) {
    return <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Checking Git…</div>
  }
  if (!p) return <p className="text-[11px] text-destructive">Could not read the close preview.</p>

  const canRun = p.allowed || (p.needsAcknowledgement && ack)
  const run = async () => {
    try {
      const res = await close.mutateAsync({ expectedToken: p.token, acknowledgeIgnored: ack })
      if (res.complete) toast.success('Worktree and branch removed')
      else toast.warning(`Partly closed: worktree ${res.result?.worktree}, branch ${res.result?.branch}${res.result?.note ? ` — ${res.result.note}` : ''}`)
      onCancel()
    } catch (err: any) {
      toast.error(err.message || 'Close refused')
      preview.refetch()
    }
  }

  return (
    <div className="rounded border bg-accent/40 px-3 py-2.5 space-y-2">
      <ul className="space-y-0.5">
        {p.checks.map(c => (
          <li key={c.code} className="flex items-start gap-1.5 text-[11px]">
            {c.ok ? <Check className="h-3 w-3 text-success shrink-0 mt-0.5" /> : <X className="h-3 w-3 text-warning shrink-0 mt-0.5" />}
            <span className={c.ok ? 'text-muted-foreground' : ''}>{c.message}</span>
          </li>
        ))}
      </ul>

      <div className="text-[11px] space-y-0.5">
        {p.worktree.path && <p>Path: <span className="font-mono break-all">{p.worktree.path}</span></p>}
        <p>Branch: <span className="font-mono">{p.worktree.branch ?? '—'}</span> · Task #{p.taskNumber ?? p.taskId}</p>
        {p.integration.acceptedSha && <p>Integrated commit: <span className="font-mono">{short(p.integration.acceptedSha)}</span> into <span className="font-mono">{p.integration.targetBranch}</span></p>}
        {p.willRemove.length > 0 && <p><span className="font-medium">Will remove:</span> {p.willRemove.join('; ')}</p>}
        {p.willPreserve.length > 0 && <p><span className="font-medium">Will keep:</span> {p.willPreserve.join('; ')}</p>}
        <p className="text-muted-foreground">Branch: {p.branch.action === 'delete' ? 'deleted only if still proven integrated' : 'kept'} — {p.branch.reason}</p>
      </div>

      {p.needsAcknowledgement && p.changes && (
        <label className="flex items-start gap-1.5 text-[11px] cursor-pointer">
          <input type="checkbox" className="mt-0.5" checked={ack} onChange={e => setAck(e.target.checked)} />
          <span>
            {p.changes.ignored.total} ignored file{p.changes.ignored.total === 1 ? '' : 's'} are in this folder and will be deleted with it
            {p.changes.ignored.sample.length > 0 && <span className="font-mono text-muted-foreground"> ({p.changes.ignored.sample.slice(0, 3).join(', ')}{p.changes.ignored.total > 3 ? ', …' : ''})</span>}
          </span>
        </label>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="destructive" className="gap-1.5 text-xs" disabled={!canRun || close.isPending} onClick={run}>
          {close.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          Remove worktree
        </Button>
        <Button size="sm" variant="ghost" className="text-xs" onClick={onCancel}>Cancel</Button>
        {!canRun && <span className="text-[10px] text-muted-foreground">Blocked: resolve the unchecked items first.</span>}
      </div>
    </div>
  )
}
