import { CheckCircle2, CircleDashed } from 'lucide-react'
import type { AgentRunChoice, EvidenceBasis, SystemEvidence, SystemStatus } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Focus } from './EditSteps'

export type AskAgent = 'claude' | 'codex' | 'design'
export interface SystemActions {
  onOpen: (file: string, line?: number) => void
  onGraph: (file: string) => void
  /** agent, optional selected area, optional extra instruction */
  onAsk: (agent: AskAgent, areaId?: string, goal?: string, run?: AgentRunChoice) => void
  onPickSystem?: (id: string) => void
  /** open the dedicated editor at a step */
  onEdit?: (step: 'identity' | 'responsibilities' | 'members' | 'relations' | 'review') => void
  onChanged?: () => void
  /** quick edit of one piece (name, a responsibility, a component, a relation) without the five steps */
  onQuickEdit?: (f: Focus) => void
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
  demonstrated: { label: 'text matched', cls: 'bg-success/15 text-success', title: 'The cited text exists in this checkout; this alone does not prove the proposed relation' },
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

/**
 * Provenance of a claim, kept in four separate kinds so one never passes for another:
 * observation (text/structure found in this checkout), inference (matched by name or by a name-only code link),
 * test (a static reference to a test file; nothing is executed here) and human (a person confirmed or approved it).
 */
export type Provenance = 'observed' | 'inferred' | 'test' | 'human'
const PROV: Record<Provenance, { label: string; cls: string; title: string }> = {
  observed: { label: 'observed', cls: 'bg-success/15 text-success', title: 'The cited text or structure exists in this checkout. It says the code contains it, not that the game rule is right.' },
  inferred: { label: 'inferred', cls: 'border border-dashed text-muted-foreground', title: 'Matched by name, by a file reference or by a function name. Similarity is not proof.' },
  test: { label: 'test reference', cls: 'bg-accent', title: 'A test file mentions it. Static reference only: no test was executed here.' },
  human: { label: 'human', cls: 'bg-primary/15 text-foreground', title: 'A person confirmed or approved this in this installation.' },
}
export function ProvenancePill({ kind, label }: { kind: Provenance; label?: string }) {
  const p = PROV[kind]
  return <span className={cn('rounded px-1.5 py-0.5 text-[10px]', p.cls)} title={p.title} data-testid="provenance-pill" data-provenance={kind}>{label ?? p.label}</span>
}
export const provenanceOfBasis = (b: EvidenceBasis): Provenance => (b === 'demonstrated' ? 'observed' : 'inferred')

/** What an agent can be asked, always answered as a PROPOSAL that comes back to this screen (propose_system). */
export const ASSIST_RULES =
  'Answer by calling the MCP tool propose_system for this system, so your result appears in the Systems screen as a pending proposal for the user to review. You may only PROPOSE: never confirm anything, never record an approval, never pick a side in a conflict, never edit code or game rules. Cite file:line and say what you could not verify.'
export type AssistKind = 'explain' | 'responsibilities' | 'relation' | 'classify' | 'impact'
export const ASSISTS: { id: AssistKind; label: string; hint: string; goal: (target?: string) => string }[] = [
  { id: 'explain', label: 'Explain this', hint: 'How it works today, from the real code', goal: t => `Explain how ${t ?? 'this system'} works today in the examined checkout: what it does for the player, what is confirmed and what is not. Read the real code first. Put the explanation in the summary of your proposal. ${ASSIST_RULES}` },
  { id: 'responsibilities', label: 'Suggest responsibilities', hint: 'Subsystems, mechanics, entities', goal: t => `Suggest the gameplay responsibilities (areas: subsystem, mechanic or entity) of ${t ?? 'this system'}. Each needs a name, a one-line summary and at least one evidence pointer (path + text that must stay in the code). ${ASSIST_RULES}` },
  { id: 'relation', label: 'Investigate a relation', hint: 'Is it really connected to another system?', goal: t => `Investigate which other systems ${t ?? 'this system'} has gameplay relations with (produces, consumes, stores, modifies, unlocks, depends_on, controls). A call or import alone is NOT a relation; name the code that demonstrates the gameplay effect, with evidence. ${ASSIST_RULES}` },
  { id: 'classify', label: 'Propose a classification', hint: 'Name, kind, members', goal: t => `Propose a classification for ${t ?? 'this system'}: a better name if the current one is only a word in file names, its kind, its purpose, and which files really belong to it versus only mention it. ${ASSIST_RULES}` },
  { id: 'impact', label: 'Analyze consequences of a change', hint: 'What a change would touch', goal: t => `Analyze what would be affected if the design of ${t ?? 'this system'} changed: dependent systems, decisions, tests, data files. Do not change anything. ${ASSIST_RULES}` },
]
