import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { GitBranch, Loader2, AlertTriangle, Check, ChevronRight, FolderGit2 } from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { useTaskLifecycleActions } from '@/hooks/useGit'
import { CloseWorktreePanel } from '@/components/tasks/CloseWorktreePanel'
import type { Task } from '@/hooks/useTasks'
import type { TaskLifecycle } from '@/lib/api'
import { readStage, TONE_CLASS } from '@/lib/lifecycleCopy'
import { cn } from '@/lib/utils'

const short = (h?: string | null) => (h || '').substring(0, 7)

function Step({ ok, label, detail }: { ok: boolean | 'warn'; label: string; detail?: string }) {
  const dot = ok === true ? 'bg-success' : ok === 'warn' ? 'bg-warning' : 'border border-muted-foreground/50'
  return (
    <li className="flex items-start gap-2 min-w-0">
      <span className={cn('mt-[5px] h-2 w-2 rounded-full shrink-0', dot)} aria-hidden />
      <div className="min-w-0">
        <p className="text-xs font-medium leading-tight">{label}</p>
        {detail && <p className="text-[11px] text-muted-foreground leading-snug break-words">{detail}</p>}
      </div>
    </li>
  )
}

function Row({ k, v, mono = true }: { k: string; v?: string | null; mono?: boolean }) {
  if (!v) return null
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 text-[11px]">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn('min-w-0 break-all select-all', mono && 'font-mono')}>{v}</dd>
    </div>
  )
}

/**
 * The delivery card of the Review tab: where the delivery stands, what blocks
 * it and the one action that moves it forward. Execution, delivery, acceptance
 * and integration are each read from their own authority on the server; Accept
 * and Integrate always ask for a second click that names the exact commit and
 * target, and the server still re-validates everything.
 *
 * `extraActions` renders secondary actions (Needs changes) after the primary
 * one. `children` is the integration point for the worktree/closure section
 * (R2-A2): it renders between the blockers and the Git details.
 */
export function LifecycleBar({ lc, task, extraActions, children }: { lc: TaskLifecycle; task: Task; extraActions?: ReactNode; children?: ReactNode }) {
  const actions = useTaskLifecycleActions(task.projectId, task.id)
  const [confirm, setConfirm] = useState<'accept' | 'integrate' | null>(null)
  const [closing, setClosing] = useState(false)
  const closable = lc.stage === 'INTEGRATED' && lc.delivery.mode !== 'direct'
  const target = lc.target.branch || ''
  const head = lc.delivery.head || ''
  const session = lc.execution.sessions[0]
  const integ = lc.integration.state
  const busy = actions.accept.isPending || actions.integrate.isPending || actions.revoke.isPending
  const reading = readStage(lc)
  const tone = TONE_CLASS[reading.tone]

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
  // "Not accepted yet" is not a blocker while Accept is available: the button below is its answer.
  const blockers = lc.stage !== 'CLOSED' ? lc.blockers.filter(b => !(b.code === 'not-accepted' && lc.canAccept)) : []
  const dirtyFiles = lc.delivery.dirty.files

  return (
    <section aria-label="Delivery" className="rounded-lg border bg-card">
      {/* Where it stands and what to do next */}
      <div className="px-4 pt-3.5 pb-3 space-y-1">
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', tone.chip)}>
            <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} aria-hidden />
            {reading.label}
          </span>
          <span className="text-[11px] text-muted-foreground">delivery stage</span>
        </div>
        <p className="text-sm leading-snug">{reading.meaning}</p>
        <p className="text-sm font-medium leading-snug">{reading.next}</p>
      </div>

      {/* Blockers come before the actions: they explain why an action is missing */}
      {blockers.length > 0 && (
        <div className="mx-4 mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2" role="alert">
          <p className="text-[11px] font-medium uppercase tracking-wider text-warning mb-1">
            {blockers.length === 1 ? '1 blocker' : `${blockers.length} blockers`}
          </p>
          <ul className="space-y-1">
            {blockers.map(b => (
              <li key={b.code} className="flex items-start gap-1.5 text-xs leading-snug">
                <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0 mt-px" />
                <span>{b.message}</span>
              </li>
            ))}
          </ul>
          {dirtyFiles.length > 0 && (
            <p className="mt-1.5 text-[11px] font-mono text-muted-foreground break-all" title={dirtyFiles.join('\n')}>
              {dirtyFiles.slice(0, 3).join(', ')}{lc.delivery.dirty.count > 3 ? ` +${lc.delivery.dirty.count - 3} more` : ''}
            </p>
          )}
        </div>
      )}

      {/* The one action that moves it forward, then the secondary ones */}
      <div className="px-4 pb-3.5">
        {closing && closable ? (
          <CloseWorktreePanel task={task} onCancel={() => setClosing(false)} />
        ) : confirm ? (
          <div className="flex items-center gap-2 flex-wrap rounded-md bg-accent/50 px-3 py-2">
            <p className="text-xs flex-1 min-w-[220px] leading-snug">
              {confirm === 'accept'
                ? <>Accept <span className="font-mono">{short(head)}</span> ({commitsLabel}, +{lc.delivery.additions} −{lc.delivery.deletions}) for <span className="font-mono">{target}</span>? You are saying you reviewed this exact commit.</>
                : <>Merge <span className="font-mono">{lc.delivery.branch}</span> (<span className="font-mono">{short(head)}</span>) into <span className="font-mono">{target}</span>? This creates a merge commit in the project checkout.</>}
            </p>
            <Button size="sm" className="gap-1.5 text-xs" disabled={busy} onClick={() => run(confirm)} autoFocus>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Confirm
            </Button>
            <Button size="sm" variant="ghost" className="text-xs" onClick={() => setConfirm(null)}>Cancel</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            {lc.canAccept && (
              <Button size="sm" className="gap-1.5" onClick={() => setConfirm('accept')}>
                <Check className="h-3.5 w-3.5" />Accept delivery
              </Button>
            )}
            {lc.canIntegrate && (
              <Button size="sm" className="gap-1.5" onClick={() => setConfirm('integrate')}>
                <GitBranch className="h-3.5 w-3.5" />Integrate into {target}
              </Button>
            )}
            {closable && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setClosing(true)}>
                <FolderGit2 className="h-3.5 w-3.5" />Close worktree…
              </Button>
            )}
            {lc.acceptance.record && integ !== 'integrated' && (
              <Button size="sm" variant="ghost" className="text-xs" disabled={busy} onClick={() => run('revoke')}>Revoke acceptance</Button>
            )}
            {extraActions}
          </div>
        )}
      </div>

      {/* Progress: four facts, each from its own authority */}
      <ol className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2.5 border-t px-4 py-3" aria-label="Delivery progress">
        <Step
          ok={lc.execution.finished ? true : lc.execution.sessionActive ? 'warn' : false}
          label="Agent"
          detail={session ? `${session.agent || session.type || 'session'} · ${session.state || 'open'}` : lc.execution.finished ? 'marked done' : 'no live session'}
        />
        <Step
          ok={lc.delivery.commits.length > 0 ? (lc.delivery.dirty.count ? 'warn' : true) : false}
          label="Delivered"
          detail={lc.delivery.mode === 'none' ? 'not tracked' : lc.delivery.mode === 'direct' && !lc.delivery.direct?.claim ? 'not identified' : lc.delivery.mode === 'direct' ? `${commitsLabel} · ${lc.delivery.direct?.claim?.basis === 'trailer' ? 'proven by trailer' : 'identified by you'}` : commitsLabel}
        />
        <Step
          ok={lc.acceptance.state === 'accepted' ? true : lc.acceptance.state === 'lapsed' ? 'warn' : false}
          label="Accepted"
          detail={lc.acceptance.state === 'accepted'
            ? `by you${lc.acceptance.record?.at ? ` · ${format(new Date(lc.acceptance.record.at), 'MMM d, HH:mm')}` : ''}`
            : lc.acceptance.state === 'lapsed' ? 'branch moved since' : 'by you, not the agent'}
        />
        <Step
          ok={integ === 'integrated' || integ === 'in-target' ? true : integ === 'patch-equivalent' ? 'warn' : false}
          label="Integrated"
          detail={integ === 'in-target' ? `already in ${target} · no merge` : integ === 'integrated' ? `in ${target}` : integ === 'patch-equivalent' ? 'same patch, no ancestry' : target ? `not in ${target}` : undefined}
        />
      </ol>

      {/* R2-A2 integration point: linked worktrees, local changes, active sessions, cleanup safety, CLOSED. */}
      {children}

      {/* Technical detail, one click away and never in the way */}
      <details className="group border-t px-4 py-2.5">
        <summary className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring list-none [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
          Git details
        </summary>
        <dl className="mt-2.5 space-y-1.5">
          <Row k="Task branch" v={lc.delivery.branch} />
          <Row k="Delivered head" v={lc.delivery.head} />
          <Row k="Target branch" v={lc.target.branch} />
          <Row k="Target head" v={lc.target.head} />
          <Row k="Accepted commit" v={lc.acceptance.record?.headSha} />
          <Row k="Merge commit" v={lc.integration.mergeCommit} />
          <Row k="Worktree" v={lc.delivery.worktreePath ? `${lc.delivery.worktreePath}${lc.delivery.worktreeExists ? '' : ' (gone)'}` : undefined} />
          <Row k="Project checkout" v={lc.target.checkoutBranch ? `on ${lc.target.checkoutBranch}${lc.target.checkoutDirty ? `, ${lc.target.checkoutDirty} uncommitted` : ', clean'}` : undefined} mono={false} />
        </dl>
      </details>
    </section>
  )
}
