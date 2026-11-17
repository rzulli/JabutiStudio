import { CheckCircle2, CircleDashed } from 'lucide-react'
import type { EvidenceBasis, SystemEvidence, SystemStatus } from '@/lib/api'
import { cn } from '@/lib/utils'

export type AskAgent = 'claude' | 'codex' | 'design'
export interface SystemActions {
  onOpen: (file: string, line?: number) => void
  onGraph: (file: string) => void
  /** agent, optional selected area, optional extra instruction */
  onAsk: (agent: AskAgent, areaId?: string, goal?: string) => void
  onPickSystem?: (id: string) => void
}

export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)

export function StatusPill({ status }: { status: SystemStatus | 'inferred' }) {
  const ok = status === 'confirmed'
  return (
    <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium', ok ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning')}>
      {ok ? <CheckCircle2 className="h-2.5 w-2.5" /> : <CircleDashed className="h-2.5 w-2.5" />}{status}
    </span>
  )
}

const BASIS: Record<EvidenceBasis, { label: string; cls: string; title: string }> = {
  demonstrated: { label: 'demonstrated', cls: 'bg-success/15 text-success', title: 'The cited code still contains the cited text in this checkout' },
  inferred: { label: 'inferred', cls: 'border border-dashed text-muted-foreground', title: 'Supported by a file reference only, not by the text it claims' },
  candidate: { label: 'candidate', cls: 'border border-dashed text-warning', title: 'No verifiable evidence' },
  stale: { label: 'stale', cls: 'bg-warning/15 text-warning', title: 'The evidence no longer holds in this checkout' },
}
export function BasisPill({ basis }: { basis: EvidenceBasis }) {
  const b = BASIS[basis]
  return <span className={cn('rounded px-1.5 py-0.5 text-[10px]', b.cls)} title={b.title} data-testid="basis-pill" data-basis={basis}>{b.label}</span>
}

const EV_STATE: Record<SystemEvidence['state'], string> = {
  verified: 'verified here', 'file-only': 'file exists, no text to check', moved: 'file moved', stale: 'text no longer found', missing: 'file missing',
}
export function EvidenceLine({ e, onOpen }: { e: SystemEvidence; onOpen: (f: string, l?: number) => void }) {
  const path = e.resolvedPath ?? e.path
  const bad = e.state === 'stale' || e.state === 'missing'
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="evidence-line" data-state={e.state}>
      <button disabled={e.state === 'missing'} onClick={() => onOpen(path, e.line)} className="truncate font-mono hover:underline disabled:no-underline" title="Open at the cited line">{path}{e.line ? `:${e.line}` : ''}</button>
      <span className={cn('text-[10px]', bad ? 'text-warning' : 'text-muted-foreground')}>{EV_STATE[e.state]}{e.state === 'moved' ? ` (was ${e.path})` : ''}</span>
      {e.needle && <code className="rounded bg-muted/50 px-1 text-[10px]">{e.needle}</code>}
      {e.note && <span className="text-[10px] text-muted-foreground">— {e.note}</span>}
    </div>
  )
}

export function Section({ title, count, children, testId, hint }: { title: string; count?: number; children: React.ReactNode; testId?: string; hint?: string }) {
  return (
    <section className="space-y-1.5" data-testid={testId}>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}{count !== undefined && <span className="ml-1.5 tabular-nums opacity-60">{count}</span>}
        {hint && <span className="ml-2 font-normal normal-case tracking-normal opacity-70">{hint}</span>}
      </h3>
      {children}
    </section>
  )
}
