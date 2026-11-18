import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, RotateCw, Square, XCircle, GitBranch, FolderGit2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useGodotRun, useGodotRuns, godotKeys } from '@/hooks/useGodot'
import { godotApi, shortSha, type Outcome, type RunRecord, type RunView } from '@/lib/godotApi'

const GOOD: Outcome[] = ['PASS']
const WARN: Outcome[] = ['TIMEOUT', 'CANCELLED', 'FOCUS_BLOCKED', 'INFRA_BLOCKED', 'NO_ASSERTIONS', 'NO_RECEIPT']

export function OutcomeChip({ outcome, label }: { outcome: Outcome; label?: string }) {
  const tone = GOOD.includes(outcome) ? 'bg-success/15 text-success' : outcome === 'RUNNING' ? 'bg-muted text-foreground' : WARN.includes(outcome) ? 'bg-warning/15 text-warning' : 'bg-destructive/15 text-destructive'
  const Icon = GOOD.includes(outcome) ? CheckCircle2 : outcome === 'RUNNING' ? Loader2 : WARN.includes(outcome) ? AlertTriangle : XCircle
  return (
    <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium', tone)}>
      <Icon className={cn('h-3 w-3', outcome === 'RUNNING' && 'animate-spin')} />
      {label ?? outcome}
    </span>
  )
}

export const when = (iso: string) => { try { return new Date(iso).toLocaleString() } catch { return iso } }

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[132px_1fr] gap-2 py-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function EvidenceViewer({ projectId, view }: { projectId: string; view: RunView }) {
  const [name, setName] = useState<string | null>(null)
  const [text, setText] = useState<{ text: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runId = view.record.runId
  const isShot = !!name && name.startsWith('screenshots/')

  useEffect(() => { setName(null); setText(null) }, [runId])
  useEffect(() => {
    if (!name || isShot) { setText(null); return }
    let cancelled = false
    setError(null)
    godotApi.evidenceText(projectId, runId, name).then(t => { if (!cancelled) setText(t) }, e => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [projectId, runId, name, isShot, view.running])

  if (view.evidence.length === 0) return <p className="text-muted-foreground">No logs or captures were written for this run.</p>
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {view.evidence.map(e => (
          <button
            key={e.name} onClick={() => setName(name === e.name ? null : e.name)}
            className={cn('rounded border px-2 py-0.5 text-xs font-mono hover:bg-accent/50', name === e.name && 'bg-accent')}
            title={`${e.bytes} bytes`}
          >
            {e.name}
          </button>
        ))}
      </div>
      {isShot && name && <img alt={name} src={godotApi.evidenceUrl(projectId, runId, name)} className="max-h-72 rounded border" />}
      {name && !isShot && (
        <div>
          {error && <p className="text-destructive">{error}</p>}
          {text && (
            <>
              {text.truncated && <p className="mb-1 text-muted-foreground">Showing the last 256 KB.</p>}
              <pre className="max-h-72 overflow-auto scrollbar-dark rounded border bg-background p-2 text-[11px] leading-snug whitespace-pre-wrap">{text.text || '(empty)'}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function RunDetail({ projectId, runId, rerunLabel, onRerun }: { projectId: string; runId: string; rerunLabel: string; onRerun: (r: RunRecord) => void }) {
  const qc = useQueryClient()
  const { data: view, error } = useGodotRun(projectId, runId)
  const [cancelling, setCancelling] = useState(false)

  if (error) return <p className="text-destructive text-sm">{(error as Error).message}</p>
  if (!view) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  const { record: r, verdict: v, receipt } = view

  const cancel = async () => {
    setCancelling(true)
    try { await godotApi.cancel(projectId, runId); toast.success('Cancel requested') }
    catch (e) { toast.error((e as Error).message) }
    finally { setCancelling(false); void qc.invalidateQueries({ queryKey: godotKeys.run(projectId, runId) }) }
  }

  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeChip outcome={v.outcome} label={v.headline} />
        <span className="font-mono text-muted-foreground">{v.harnessStatus ? `Harness: ${v.harnessStatus}` : 'No receipt yet'}</span>
        <div className="ml-auto flex gap-1.5">
          {view.running && (
            <button onClick={cancel} disabled={cancelling} className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-accent/50 disabled:opacity-50">
              <Square className="h-3 w-3" /> Cancel run
            </button>
          )}
          {!view.running && (
            <button onClick={() => onRerun(r)} className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-accent/50" title="Runs the same target on the context currently selected in the Editor">
              <RotateCw className="h-3 w-3" /> Re-run on {rerunLabel}
            </button>
          )}
        </div>
      </div>

      {v.reason && <p className="rounded border border-destructive/30 bg-destructive/10 p-2 text-destructive break-words">{v.reason}</p>}
      {view.provenanceMismatch && <p className="rounded border border-warning/40 bg-warning/10 p-2 text-warning">{view.provenanceMismatch}</p>}

      <section>
        <h4 className="mb-1 font-medium uppercase tracking-wider text-muted-foreground">What this result means</h4>
        <dl>
          <Row label="Execution completed">{view.running ? 'In progress' : v.executionCompleted ? 'Yes' : 'No / not proven'}</Row>
          <Row label="Assertions">
            {v.assertions === 'VERIFIED' ? `Verified (${receipt?.assertions?.passed_count ?? 0} reported)` : v.assertions === 'FAILED' ? `Failed: ${(receipt?.assertions?.failed ?? []).join(', ') || 'see log'}` : 'Not proven'}
            {receipt?.assertions?.marker && <span className="text-muted-foreground"> · marker {receipt.assertions.marker}</span>}
          </Row>
          <Row label="Visual evidence">{v.visualEvidence === 'AVAILABLE' ? 'Captures available below' : 'None captured'}</Row>
          <Row label="Human validation"><span className="inline-flex items-center gap-1"><CircleDashed className="h-3 w-3" /> Pending — nobody has looked at this run</span></Row>
        </dl>
        {v.limitations.map(l => <p key={l} className="mt-1 text-muted-foreground">{l}</p>)}
      </section>

      <section>
        <h4 className="mb-1 font-medium uppercase tracking-wider text-muted-foreground">Where it ran</h4>
        <dl>
          <Row label="Target">{r.action === 'test' ? 'Test' : 'Scene'} <span className="font-mono">{r.res}</span>{r.via && <span className="text-muted-foreground"> · from {r.via}</span>}</Row>
          <Row label="Project / task">{r.taskId ? `Task #${r.taskNumber ?? '?'} ${r.taskTitle ?? ''}` : 'No task (project-level)'} <span className="text-muted-foreground">· started from {r.origin}</span></Row>
          <Row label="Checkout">
            <span className="inline-flex items-start gap-1 font-mono break-all"><FolderGit2 className="mt-px h-3 w-3 shrink-0" />{r.checkout.path}</span>
            <div className="text-muted-foreground">{r.checkout.isMainCheckout ? 'Main checkout' : 'Task worktree'} — {r.checkout.reason}</div>
          </Row>
          <Row label="Branch @ commit"><span className="inline-flex items-center gap-1 font-mono"><GitBranch className="h-3 w-3" />{r.checkout.branch ?? (r.checkout.detached ? 'detached' : 'unknown')} @ {shortSha(r.checkout.head)}</span></Row>
          <Row label="State at start">
            {r.checkout.dirtyAtStart == null ? 'Unknown (not a Git checkout)' : r.checkout.dirtyAtStart.count === 0 ? 'Clean' : `${r.checkout.dirtyAtStart.count} uncommitted change(s)`}
            {!r.checkout.reproducibleFromSha && <div className="text-warning">The commit alone does not reproduce what ran.</div>}
            {r.checkout.dirtyAtStart && r.checkout.dirtyAtStart.files.length > 0 && <div className="font-mono text-muted-foreground break-all">{r.checkout.dirtyAtStart.files.join(', ')}</div>}
          </Row>
          <Row label="Parameters">{r.params.mode} · {r.params.profile} · marker {r.params.marker}</Row>
          <Row label="Godot / Harness">{r.harness.godotVersion ?? 'version unknown'} · <span className="font-mono break-all">{r.harness.dir}</span></Row>
          <Row label="Started">{when(r.startedAt)}{receipt?.duration_sec != null && ` · ${receipt.duration_sec}s`}</Row>
          <Row label="Run id / artifacts"><span className="font-mono break-all">{r.runId}</span>{receipt?.paths?.run && <div className="font-mono text-muted-foreground break-all">{receipt.paths.run}</div>}</Row>
        </dl>
        {r.checkout.notes.map(n => <p key={n} className="mt-1 text-warning">{n}</p>)}
      </section>

      {receipt && (
        <section>
          <h4 className="mb-1 font-medium uppercase tracking-wider text-muted-foreground">Receipt highlights</h4>
          <dl>
            <Row label="Process">{receipt.process?.status}{receipt.process?.exit_code != null && ` · exit ${receipt.process.exit_code}`}{receipt.process?.timed_out && ' · timed out'}</Row>
            {receipt.import?.status && receipt.import.status !== 'SKIPPED' && <Row label="Import">{receipt.import.status}</Row>}
            {receipt.focus?.status && <Row label="Focus">{receipt.focus.status} ({receipt.focus.reason})</Row>}
            {Array.isArray(receipt.diagnostics) && receipt.diagnostics.length > 0 && (
              <Row label="Diagnostics"><ul className="font-mono space-y-0.5">{receipt.diagnostics.slice(0, 8).map((d: string, i: number) => <li key={i} className="break-words">{d}</li>)}</ul></Row>
            )}
          </dl>
        </section>
      )}

      <section>
        <h4 className="mb-1 font-medium uppercase tracking-wider text-muted-foreground">Logs, captures and the original receipt</h4>
        <EvidenceViewer projectId={projectId} view={view} />
      </section>
    </div>
  )
}

interface Props {
  projectId: string
  /** Project-relative editor file; runs of it (and of files provably related to it) are listed. */
  file?: string
  /** When set (Review), lists every run recorded for the task instead of the runs of one file. */
  taskId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  focusRunId?: string | null
  /** Short name of the context a re-run would use, e.g. "Task #4 worktree". */
  rerunLabel: string
  onRerun: (record: RunRecord) => void
}

export function GodotResults({ projectId, file, taskId, open, onOpenChange, focusRunId, rerunLabel, onRerun }: Props) {
  const { data } = useGodotRuns(projectId, taskId ? undefined : file, open, open, taskId)
  const [selected, setSelected] = useState<string | null>(null)
  const runs = data?.runs ?? []

  useEffect(() => { if (open && focusRunId) setSelected(focusRunId) }, [open, focusRunId])
  const current = useMemo(() => selected ?? runs[0]?.record.runId ?? null, [selected, runs])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm">Godot results <span className="font-mono text-muted-foreground">· {taskId ? 'this task' : file}</span></DialogTitle>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr] gap-4">
          <div className="min-h-0 space-y-1 overflow-y-auto scrollbar-dark pr-1">
            {runs.length === 0 && <p className="text-xs text-muted-foreground">No runs yet. Nothing runs automatically: use Run Scene or Run Test.</p>}
            {runs.map(({ record, verdict }) => (
              <button
                key={record.runId} onClick={() => setSelected(record.runId)}
                className={cn('w-full rounded border p-2 text-left text-xs hover:bg-accent/40', current === record.runId && 'bg-accent/60')}
              >
                <OutcomeChip outcome={verdict.outcome} label={verdict.headline} />
                <div className="mt-1 truncate font-mono">{record.file}</div>
                <div className="text-muted-foreground">{record.checkout.isMainCheckout ? 'Main checkout' : `Task #${record.taskNumber ?? '?'}`} · {when(record.startedAt)}</div>
              </button>
            ))}
          </div>
          <div className="min-h-0 overflow-y-auto scrollbar-dark pr-1">
            {current ? <RunDetail key={current} projectId={projectId} runId={current} rerunLabel={rerunLabel} onRerun={onRerun} /> : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
