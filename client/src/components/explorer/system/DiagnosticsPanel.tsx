import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, Info, Loader2, RefreshCw } from 'lucide-react'
import { api, type SystemDiagnostic, type SystemView } from '@/lib/api'
import { cn } from '@/lib/utils'

const REF_STATE: Record<SystemDiagnostic['refs'][number]['state'], string> = {
  absent: 'not on disk in this checkout; unknown to the graph',
  'absent-since-analysis': 'not on disk in this checkout; an older analysis still lists it',
  'other-checkout': 'not on disk here; present in the project checkout',
  'not-indexed': 'exists on disk; outside the Godot file index',
  unknown: 'could not be checked',
}

/**
 * Explains every notice on a system: what it means, the concrete cause, the effect on what is shown, and the next
 * action, or why none is possible from here. Nothing in this panel confirms a system or edits a decision; every action
 * opens an existing flow or runs the existing Graphify build.
 */
export function DiagnosticsPanel({ v, projectId, onReview, onEditMembers, onChanged }: {
  v: SystemView; projectId: string; onReview: () => void; onEditMembers: () => void; onChanged: () => void
}) {
  const qc = useQueryClient()
  const [running, setRunning] = useState(false)
  const items = v.maintenance.diagnostics
  if (!items.length) return null

  // Success is reported only after Graphify has actually finished and the views were re-read.
  const reanalyze = async () => {
    setRunning(true)
    try {
      const r = await api.buildExplorer(projectId)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['explorer', projectId] }),
        qc.invalidateQueries({ queryKey: ['systems', projectId] }),
        qc.invalidateQueries({ queryKey: ['system', projectId] }),
      ])
      onChanged()
      toast.success(`Analysis finished: ${r.nodes} nodes, ${r.edges} relations from ${r.files} files`)
    } catch (e: any) {
      toast.error(e?.message || 'Graphify failed')
    } finally {
      setRunning(false)
    }
  }

  const run = async (d: SystemDiagnostic) => {
    switch (d.action.kind) {
      case 'review': return onReview()
      case 'edit-members': return onEditMembers()
      case 'reanalyze': return reanalyze()
      case 'acknowledge':
        try { await api.editSystem(projectId, v.id, { ackVanished: true }); onChanged() } catch (e: any) { toast.error(e.message) }
    }
  }

  return (
    <section className="space-y-1.5" data-testid="system-diagnostics" aria-label="Notices">
      {items.map(d => {
        const Icon = d.severity === 'warning' ? AlertTriangle : Info
        const busy = running && d.action.kind === 'reanalyze'
        return (
          <div key={d.code} data-testid="diagnostic" data-code={d.code} data-kind={d.kind}
            className={cn('rounded-md border px-2.5 py-2 text-[11px]', d.severity === 'warning' ? 'border-warning/40 bg-warning/5' : 'bg-card/40')}>
            <div className="flex items-center gap-1.5 text-xs font-medium"><Icon className={cn('h-3 w-3 shrink-0', d.severity === 'warning' && 'text-warning')} />{d.title}</div>
            <dl className="mt-1 space-y-0.5 text-muted-foreground">
              <div><dt className="inline font-medium text-foreground">Means: </dt><dd className="inline">{d.meaning}</dd></div>
              <div><dt className="inline font-medium text-foreground">Why: </dt><dd className="inline" data-testid="diagnostic-cause">{d.cause}</dd></div>
              <div><dt className="inline font-medium text-foreground">Effect: </dt><dd className="inline">{d.effect}</dd></div>
            </dl>
            {d.refs.length > 0 && (
              <ul className="mt-1 space-y-0.5" data-testid="diagnostic-refs">
                {d.refs.map(r => (
                  <li key={`${r.source}|${r.path}`} className="flex flex-wrap items-baseline gap-x-1.5" data-state={r.state}>
                    <code className="font-mono">{r.path}</code>
                    <span className="text-muted-foreground">from {r.source} · {REF_STATE[r.state]}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {d.action.kind !== 'none' && (
                <button onClick={() => run(d)} disabled={!d.action.available || busy} data-testid="diagnostic-action" data-available={d.action.available}
                  className="flex items-center gap-1 rounded-md border px-2 py-0.5 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60">
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : d.action.kind === 'reanalyze' ? <RefreshCw className="h-3 w-3" /> : null}
                  {busy ? 'Analyzing…' : d.action.label}
                </button>
              )}
              {d.action.blockedReason && <span className="text-muted-foreground" data-testid="diagnostic-blocked">{d.action.kind === 'none' ? '' : 'Unavailable: '}{d.action.blockedReason}</span>}
            </div>
          </div>
        )
      })}
    </section>
  )
}
