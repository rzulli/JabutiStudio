import { useState } from 'react'
import { AlertTriangle, ChevronRight, Sparkles } from 'lucide-react'
import type { SystemComparison, SystemCompareColumn, SystemCompareRow, SystemDecision, SystemView } from '@/lib/api'
import { cn } from '@/lib/utils'
import { baseName, Section, type SystemActions } from './parts'

/**
 * Rules & decisions. Conflicting DK records are lined up value by value (or text by text): what each side
 * claims, where it is observed in code/tests/documents, and — separately — whether anyone approved it and
 * whether its evidence is still current. The comparator never picks a side.
 */

const openRef = (ref: string, onOpen: SystemActions['onOpen']) => {
  const [f, l] = ref.replace(/ \(was.*$/, '').split('#L')
  onOpen(f, l ? parseInt(l, 10) : undefined)
}

export function RulesTab({ v, actions }: { v: SystemView; actions: SystemActions }) {
  const inConflict = new Set(v.comparisons.flatMap(c => c.decisions))
  const rest = v.design.decisions.filter(d => !inConflict.has(d.id))
  return (
    <div className="space-y-5" data-testid="tab-rules">
      {!v.design.available && (
        <p className="text-[11px] text-muted-foreground" data-testid="no-dk">
          Design Knowledge is not indexed for this project{v.design.reason ? ` (${v.design.reason})` : ''}. The system still shows its areas, implementation and evidence; there are no recorded rules to compare.
        </p>
      )}
      {v.comparisons.map(c => <Comparator key={c.id} c={c} v={v} actions={actions} />)}
      {v.design.available && (
        <Section title="Decisions" count={v.design.decisions.length} testId="system-decisions">
          {!v.design.decisions.length && <p className="text-[11px] text-muted-foreground">No decisions found for this system.</p>}
          {rest.map(d => <DecisionCard key={d.id} d={d} onOpen={actions.onOpen} />)}
          {!rest.length && v.comparisons.length > 0 && <p className="text-[11px] text-muted-foreground">All recorded decisions of this system are part of the comparison above.</p>}
        </Section>
      )}
    </div>
  )
}

function Comparator({ c, v, actions }: { c: SystemComparison; v: SystemView; actions: SystemActions }) {
  const ask = () => actions.onAsk('claude', undefined,
    `Investigate this unresolved design conflict (${c.decisions.join(' vs ')}), topic "${c.topic}". Compare the declared values with what the code actually does, quoting file:line. Do NOT choose a side, do NOT record an approval and do NOT edit code; report what you verified and what only the owner can decide.`)
  return (
    <section className="space-y-2 rounded-md border border-destructive/40 p-3" data-testid="system-conflict">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
        <h3 className="text-xs font-semibold">Unresolved conflict · {c.topic}</h3>
        <span className="text-[10px] text-muted-foreground">{c.decisions.join(' vs ')} · {c.numeric ? 'numeric values' : 'textual claims'}</span>
        <button onClick={ask} className="ml-auto flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent" data-testid="conflict-investigate"><Sparkles className="h-3 w-3" /> Investigate with Claude</button>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(c.columns.length, 3)}, minmax(0, 1fr))` }}>
        {c.columns.map(col => <Column key={col.key} col={col} numeric={c.numeric} actions={actions} />)}
      </div>
      <p className="text-[10px] text-muted-foreground" data-testid="compare-notes">{c.approvalNote}{c.unitNote ? ` ${c.unitNote}` : ''} Checked against {v.checkout.branch ?? '?'} {v.checkout.head ?? ''}.</p>
    </section>
  )
}

function Column({ col, numeric, actions }: { col: SystemCompareColumn; numeric: boolean; actions: SystemActions }) {
  return (
    <div className="min-w-0 space-y-1.5 rounded-md border bg-card/40 p-2" data-testid="compare-column" data-value={col.key}>
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className={cn('font-semibold tabular-nums', numeric ? 'text-base' : 'font-mono text-xs')} data-testid="compare-value">{col.key}</span>
        {col.unit && <span className="text-[10px] text-muted-foreground">{col.unit}</span>}
        <span className={cn('ml-auto rounded px-1.5 text-[10px]', col.implemented ? 'bg-success/15 text-success' : col.inTests ? 'bg-warning/15 text-warning' : 'border border-dashed text-muted-foreground')}
          title={col.inTests && !col.implemented ? 'Appears in a test fixture or assertion; this does not prove that the game uses it' : undefined} data-testid="compare-status">
          {col.implemented ? 'observed in code' : col.inTests ? 'appears in tests' : 'declared only'}
        </span>
      </div>
      {col.claimedBy.map(d => (
        <div key={d.id} className="space-y-0.5 text-[11px]" data-testid="compare-claim">
          <p><span className="font-mono font-medium">{d.id}</span> <span className="text-muted-foreground">{d.title}</span></p>
          <div className="flex flex-wrap gap-1 text-[10px]">
            <span className="rounded bg-accent px-1.5">approval: {d.approval === 'unknown' ? 'not located' : d.approval}</span>
            <span className="rounded bg-accent px-1.5">evidence: {d.evidenceStatus}</span>
            <span className="rounded bg-accent px-1.5">impl: {d.implementation}</span>
          </div>
        </div>
      ))}
      {col.claimedBy.length === 0 && <p className="text-[10px] text-muted-foreground">No record claims this value; it appears only in sources below.</p>}
      <div className="space-y-1 border-t pt-1.5">
        {col.rows.map((r, i) => <Row key={`${r.ref}${i}`} r={r} actions={actions} />)}
        {!col.rows.length && <p className="text-[10px] text-muted-foreground">No source found for this value.</p>}
      </div>
    </div>
  )
}

function Row({ r, actions }: { r: SystemCompareRow; actions: SystemActions }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-[11px]" data-testid="compare-row" data-kind={r.kind}>
      <div className="flex items-center gap-1">
        <button onClick={() => setOpen(!open)} aria-label="expand" className="shrink-0"><ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} /></button>
        <span className="shrink-0 font-medium">{r.label}</span>
        {r.unit && <span className="shrink-0 text-[10px] text-muted-foreground">({r.unit})</span>}
        {r.freshness && <span className="shrink-0 text-[10px] text-muted-foreground">{r.freshness}</span>}
      </div>
      <button onClick={() => openRef(r.ref, actions.onOpen)} className="block max-w-full truncate pl-4 font-mono text-[10px] text-muted-foreground hover:underline" title="Open at the line">{r.ref}</button>
      {open && (
        <div className="space-y-0.5 pl-4">
          {r.line && <pre className="overflow-x-auto rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">{r.line}</pre>}
          {r.note && <p className="text-[10px] text-muted-foreground">{r.note}</p>}
          <p className="text-[10px] text-muted-foreground">from {r.fromDecision}{r.ambiguous ? ' · several numbers on this line, value is ambiguous' : ''}</p>
        </div>
      )}
    </div>
  )
}

const EV_LABEL: Record<string, string> = { code: 'Implemented in code', document_claim: 'Declared in a document', test: 'Test expectation' }

function DecisionCard({ d, onOpen }: { d: SystemDecision; onOpen: SystemActions['onOpen'] }) {
  const approval = d.approval?.state ?? 'unknown'
  return (
    <div className="space-y-1.5 rounded-md border p-2" data-testid="system-decision" data-id={d.id}>
      <div className="flex flex-wrap items-center gap-1.5"><span className="font-mono text-[11px] font-medium">{d.id}</span><span className="text-xs">{d.title}</span></div>
      <p className="text-[11px] text-muted-foreground">{d.claim}</p>
      <div className="flex flex-wrap gap-1.5 text-[10px]">
        <span className="rounded bg-accent px-1.5 py-0.5">human approval: {approval === 'unknown' ? 'not located' : `${approval} (${d.approval?.source})`}</span>
        <span className="rounded bg-accent px-1.5 py-0.5">evidence: {d.evidenceStatus}</span>
        <span className="rounded bg-accent px-1.5 py-0.5">implementation: {d.implementation}</span>
        {d.relevance === 'touches-member' && <span className="rounded border border-dashed px-1.5 py-0.5 text-muted-foreground">touches a member file only</span>}
      </div>
      {d.evidence.map(e => (
        <div key={e.ref} className="text-[11px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{EV_LABEL[e.type] ?? e.type}</span>
            <button onClick={() => openRef(e.ref, onOpen)} className="truncate font-mono text-muted-foreground hover:underline">{e.ref}</button>
            {e.freshness && <span className="text-[10px] text-muted-foreground">{e.freshness}</span>}
          </div>
          {e.excerpt.slice(0, 2).map(x => <pre key={x} className="overflow-x-auto rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">{x}</pre>)}
        </div>
      ))}
      {d.tests.length > 0 && <p className="text-[10px] text-muted-foreground">Tests referenced (static; no result available): {d.tests.map(baseName).join(', ')}</p>}
    </div>
  )
}
