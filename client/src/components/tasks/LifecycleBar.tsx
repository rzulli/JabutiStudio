import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { GitBranch, Loader2, AlertTriangle, Check, FolderGit2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTaskLifecycleActions } from '@/hooks/useGit'
import { CloseWorktreePanel } from '@/components/tasks/CloseWorktreePanel'
import type { Task } from '@/hooks/useTasks'
import type { TaskLifecycle } from '@/lib/api'

const STAGE_LABEL: Record<TaskLifecycle['stage'], string> = {
  READY: 'Ready',
  RUNNING: 'Running',
  REVIEW: 'In review',
  ACCEPTED: 'Accepted — not integrated',
  INTEGRATED: 'Integrated',
  CLOSED: 'Closed',
}

const short = (h?: string | null) => (h || '').substring(0, 7)

function Step({ ok, label, detail }: { ok: boolean | 'warn'; label: string; detail?: string }) {
  const dot = ok === true ? 'bg-success' : ok === 'warn' ? 'bg-warning' : 'border border-muted-foreground/50'
  return (
    <div className="flex items-start gap-1.5 min-w-0">
      <span className={`mt-[3px] h-2 w-2 rounded-full shrink-0 ${dot}`} />
      <div className="min-w-0">
        <p className="text-[11px] font-medium leading-tight">{label}</p>
        {detail && <p className="text-[10px] text-muted-foreground leading-tight truncate" title={detail}>{detail}</p>}
      </div>
    </div>
  )
}

/**
 * Execution, delivery, acceptance and integration — each read from its own
 * authority on the server — plus the two human actions. Accept and Integrate
 * always ask for a second click that names the exact commit and target.
 */
export function LifecycleBar({ lc, task }: { lc: TaskLifecycle; task: Task }) {
  const actions = useTaskLifecycleActions(task.projectId, task.id)
  const [confirm, setConfirm] = useState<'accept' | 'integrate' | null>(null)
  const [closing, setClosing] = useState(false)
  const closable = lc.stage === 'INTEGRATED'
  const target = lc.target.branch || ''
  const head = lc.delivery.head || ''
  const session = lc.execution.sessions[0]
  const integ = lc.integration.state
  const busy = actions.accept.isPending || actions.integrate.isPending || actions.revoke.isPending

  const run = async (kind: 'accept' | 'integrate' | 'revoke') => {
    try {
      if (kind === 'accept') await actions.accept.mutateAsync({ targetBranch: target, expectedHeadSha: head })
      else if (kind === 'integrate') await actions.integrate.mutateAsync({ targetBranch: target, expectedHeadSha: head, branch: lc.delivery.branch! })
      else await actions.revoke.mutateAsync()
      toast.success(kind === 'accept' ? 'Delivery accepted' : kind === 'integrate' ? `Integrated into ${target}` : 'Acceptance revoked')
    } catch (err: any) {
      toast.error(err.message || 'Action failed')
    } finally {
      setConfirm(null)
    }
  }

  const commitsLabel = `${lc.delivery.commits.length} commit${lc.delivery.commits.length === 1 ? '' : 's'}`

  return (
    <div className="rounded-md border px-3 py-2.5 space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="text-[10px]">{STAGE_LABEL[lc.stage]}</Badge>
        {lc.delivery.worktreePath && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground min-w-0" title={lc.delivery.worktreePath}>
            <FolderGit2 className="h-3 w-3 shrink-0" />
            <span className="font-mono truncate">{lc.delivery.worktreePath}{lc.delivery.worktreeExists ? '' : ' (gone)'}</span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Step
          ok={lc.execution.finished ? true : lc.execution.sessionActive ? 'warn' : false}
          label="Agent"
          detail={session ? `${session.agent || session.type || 'session'} · ${session.state || 'open'}` : lc.execution.finished ? 'marked done' : 'no live session'}
        />
        <Step
          ok={lc.delivery.commits.length > 0 ? (lc.delivery.dirty.count ? 'warn' : true) : false}
          label="Delivered"
          detail={lc.delivery.mode === 'none' ? 'no worktree branch' : `${commitsLabel}${head ? ` @ ${short(head)}` : ''}`}
        />
        <Step
          ok={lc.acceptance.state === 'accepted' ? true : lc.acceptance.state === 'lapsed' ? 'warn' : false}
          label="Accepted"
          detail={lc.acceptance.state === 'accepted'
            ? `${short(lc.acceptance.record?.headSha)} → ${lc.acceptance.record?.targetBranch}`
            : lc.acceptance.state === 'lapsed' ? 'branch moved since' : 'by you, not the agent'}
        />
        <Step
          ok={integ === 'integrated' ? true : integ === 'patch-equivalent' ? 'warn' : false}
          label="Integrated"
          detail={integ === 'integrated' ? `in ${target} (git)` : integ === 'patch-equivalent' ? 'same patch, no ancestry' : target ? `not in ${target}` : undefined}
        />
      </div>

      {lc.blockers.length > 0 && lc.stage !== 'CLOSED' && (
        <ul className="space-y-0.5">
          {lc.blockers.map(b => (
            <li key={b.code} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <AlertTriangle className="h-3 w-3 text-warning shrink-0 mt-0.5" />
              <span>{b.message}</span>
            </li>
          ))}
        </ul>
      )}
      {lc.delivery.dirty.count > 0 && (
        <p className="text-[10px] font-mono text-muted-foreground truncate" title={lc.delivery.dirty.files.join('\n')}>
          {lc.delivery.dirty.files.slice(0, 3).join(', ')}{lc.delivery.dirty.count > 3 ? ` +${lc.delivery.dirty.count - 3}` : ''}
        </p>
      )}

      {closing && closable ? (
        <CloseWorktreePanel task={task} onCancel={() => setClosing(false)} />
      ) : confirm ? (
        <div className="flex items-center gap-2 flex-wrap rounded bg-accent/50 px-2 py-1.5">
          <p className="text-[11px] flex-1 min-w-[200px]">
            {confirm === 'accept'
              ? <>Accept <span className="font-mono">{short(head)}</span> ({commitsLabel}, +{lc.delivery.additions} −{lc.delivery.deletions}) for <span className="font-mono">{target}</span>? You are saying you reviewed this exact commit.</>
              : <>Merge <span className="font-mono">{lc.delivery.branch}</span> (<span className="font-mono">{short(head)}</span>) into <span className="font-mono">{target}</span>? This creates a merge commit in the project checkout.</>}
          </p>
          <Button size="sm" className="gap-1.5 text-xs" disabled={busy} onClick={() => run(confirm)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Confirm
          </Button>
          <Button size="sm" variant="ghost" className="text-xs" onClick={() => setConfirm(null)}>Cancel</Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {lc.canAccept && (
            <Button size="sm" className="gap-1.5 text-xs" onClick={() => setConfirm('accept')}>
              <Check className="h-3.5 w-3.5" />Accept delivery
            </Button>
          )}
          {lc.canIntegrate && (
            <Button size="sm" className="gap-1.5 text-xs" onClick={() => setConfirm('integrate')}>
              <GitBranch className="h-3.5 w-3.5" />Integrate into {target}
            </Button>
          )}
          {closable && (
            <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => setClosing(true)}>
              <FolderGit2 className="h-3.5 w-3.5" />Close worktree…
            </Button>
          )}
          {lc.acceptance.record && integ !== 'integrated' && (
            <Button size="sm" variant="ghost" className="text-xs" disabled={busy} onClick={() => run('revoke')}>Revoke acceptance</Button>
          )}
        </div>
      )}
    </div>
  )
}
