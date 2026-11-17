import { useState } from 'react'
import { AlertTriangle, ChevronRight, Code2, Network } from 'lucide-react'
import { api, type SystemMember, type SystemView, type SystemArea } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BasisPill, EvidenceLine, Section, StatusPill, baseName, type SystemActions } from './parts'
import { SystemMap } from './SystemMap'

const FACET: Record<string, string> = { logic: 'logic', data: 'data', ui: 'UI', telemetry: 'telemetry', purchase: 'purchase', requirement: 'requirement', effect: 'effect', test: 'test', other: 'other' }
const TIER_HELP: Record<string, string> = {
  core: 'Declared by an anchor, an area or a design decision',
  participant: 'Code or scene that matches by name only; not declared',
  candidate: 'Mentions the system in text, or a generated resource',
}

/** Overview: what it does, what it is made of, what is decided, and the map — all at a glance. */
export function OverviewTab({ v, actions, goTab, selectArea }: {
  v: SystemView; actions: SystemActions; goTab: (t: string) => void; selectArea: (id: string | null) => void
}) {
  const conflicts = v.comparisons.length
  const decided = v.design.decisions
  const implemented = decided.filter(d => d.implementation === 'implemented').length
  const approved = decided.filter(d => d.approval?.state === 'approved').length
  return (
    <div className="space-y-5" data-testid="tab-overview">
      <Section title="Responsibilities" count={v.areas.length} hint={v.areas.some(a => a.inferred) ? 'inferred from file names until someone describes them' : undefined}>
        {v.responsibilities.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">{v.responsibilities.map(r => <li key={r}>{r}</li>)}</ul>}
        <div className="grid gap-2 sm:grid-cols-2" data-testid="area-blocks">
          {v.areas.map(a => <AreaCard key={a.id} a={a} onPick={() => { selectArea(a.id); goTab('map') }} onImpl={() => { selectArea(a.id); goTab('implementation') }} />)}
        </div>
        {!v.areas.length && <p className="text-[11px] text-muted-foreground">No areas yet: not enough core files to group.</p>}
      </Section>

      <Section title="Design state" testId="design-state">
        {!v.design.available ? (
          <p className="text-[11px] text-muted-foreground">No Design Knowledge for this project: there are no recorded rules, so nothing is compared with the code.</p>
        ) : (
          <div className="flex flex-wrap gap-2 text-[11px]">
            <Stat label="decisions" value={decided.length} />
            <Stat label="implemented" value={`${implemented}/${decided.length}`} />
            <Stat label="approved by a person" value={`${approved}/${decided.length}`} warn={approved === 0 && decided.length > 0} />
            <button onClick={() => goTab('rules')} className={cn('rounded-md border px-2 py-1', conflicts ? 'border-destructive/50 bg-destructive/10 text-destructive' : 'hover:bg-accent')} data-testid="design-conflicts">
              {conflicts ? <><AlertTriangle className="mr-1 inline h-3 w-3" />{conflicts} unresolved conflict{conflicts > 1 ? 's' : ''} — compare</> : 'no unresolved conflicts'}
            </button>
          </div>
        )}
      </Section>

      <Section title="Map" hint="solid = demonstrated gameplay relation · dashed = inferred or code link">
        <SystemMap v={v} actions={actions} compact />
        <button onClick={() => goTab('map')} className="text-[11px] underline">Open the full map</button>
      </Section>
    </div>
  )
}

const Stat = ({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) => (
  <span className={cn('rounded-md border px-2 py-1', warn && 'border-warning/50 text-warning')}><b className="tabular-nums">{value}</b> <span className="text-muted-foreground">{label}</span></span>
)

function AreaCard({ a, onPick, onImpl }: { a: SystemArea; onPick: () => void; onImpl: () => void }) {
  return (
    <div className="space-y-1 rounded-md border bg-card/40 p-2" data-testid="area-card" data-inferred={a.inferred}>
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={onPick} className="text-xs font-medium hover:underline">{a.name}</button>
        <span className="rounded bg-accent px-1.5 text-[10px]">{a.kind === 'facet' ? 'inferred' : a.kind}</span>
        <StatusPill status={a.status === 'inferred' ? 'inferred' : a.status} />
        <BasisPill basis={a.basis} />
      </div>
      <p className="line-clamp-2 text-[11px] text-muted-foreground">{a.summary || (a.inferred ? 'Files grouped by path vocabulary; no responsibility written.' : 'No description.')}</p>
      <button onClick={onImpl} className="text-[10px] text-muted-foreground hover:underline">{a.fileCount} files · {a.testCount} tests{a.families.length ? ` · ${a.families.length} resource families` : ''}</button>
    </div>
  )
}

/** Implementation: what backs the system, tiered, so tests and generated resources never drown the core. */
export function ImplementationTab({ v, actions, area, setArea }: { v: SystemView; actions: SystemActions; area: string | null; setArea: (a: string | null) => void }) {
  const sel = area ? v.areas.find(a => a.id === area) : undefined
  const inArea = (m: SystemMember) => !sel || m.areas.includes(sel.id)
  const tiers = (['core', 'participant', 'candidate'] as const).map(t => [t, v.members.filter(m => m.tier === t && m.role !== 'test' && inArea(m))] as const)
  const tests = v.members.filter(m => m.role === 'test' && inArea(m))
  const fams = sel ? sel.families : v.families
  return (
    <div className="space-y-4" data-testid="tab-implementation">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <button onClick={() => setArea(null)} className={cn('rounded-md border px-2 py-0.5', !sel && 'bg-accent')}>All</button>
        {v.areas.map(a => <button key={a.id} onClick={() => setArea(a.id)} className={cn('rounded-md border px-2 py-0.5', sel?.id === a.id && 'bg-accent')}>{a.name}</button>)}
      </div>
      {tiers.map(([tier, ms]) => ms.length > 0 && (
        <Section key={tier} title={tier === 'core' ? 'Core' : tier === 'participant' ? 'Participants' : 'Candidates'} count={ms.length} hint={TIER_HELP[tier]} testId={`tier-${tier}`}>
          {ms.map(m => <MemberRow key={m.path} m={m} actions={actions} />)}
        </Section>
      ))}
      {fams.length > 0 && (
        <Section title="Resource families" count={fams.length} hint="generated .tres files grouped, not listed as separate systems">
          {fams.map(f => <FamilyRow key={f.key} f={f} actions={actions} />)}
        </Section>
      )}
      {tests.length > 0 && (
        <Section title="Tests" count={tests.length} hint="static references; results are not run here" testId="tier-test">
          <Collapsible label={`${tests.length} test files`}>{tests.map(m => <MemberRow key={m.path} m={m} actions={actions} />)}</Collapsible>
        </Section>
      )}
      {v.weakerMembers > 0 && <p className="text-[11px] text-muted-foreground">+ {v.weakerMembers} weaker references not listed.</p>}
    </div>
  )
}

function Collapsible({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"><ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />{open ? 'Hide' : 'Show'} {label}</button>
      {open && <div className="mt-1 space-y-0.5">{children}</div>}
    </div>
  )
}

function FamilyRow({ f, actions }: { f: SystemView['families'][number]; actions: SystemActions }) {
  return (
    <Collapsible label={`${f.label} ×${f.count}`}>
      {f.paths.slice(0, 40).map(p => <button key={p} onClick={() => actions.onOpen(p)} className="block truncate pl-4 font-mono text-[11px] hover:underline">{p}</button>)}
      {f.paths.length > 40 && <p className="pl-4 text-[10px] text-muted-foreground">+ {f.paths.length - 40} more</p>}
    </Collapsible>
  )
}

function MemberRow({ m, actions }: { m: SystemMember; actions: SystemActions }) {
  const [open, setOpen] = useState(false)
  return (
    <div data-testid="system-member" data-path={m.path} data-tier={m.tier}>
      <div className="group flex items-center gap-1.5 text-[11px]">
        {m.symbols.length > 0
          ? <button onClick={() => setOpen(!open)} aria-label="symbols"><ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} /></button>
          : <span className="w-3" />}
        <button onClick={() => actions.onOpen(m.path)} className="truncate font-mono hover:underline" title="Open in the editor">{m.path}</button>
        <span className="shrink-0 rounded bg-accent px-1 text-[10px]">{FACET[m.facet]}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground" title={m.why.map(w => `${w.kind}: ${w.detail}`).join('\n')}>
          {m.confidence === 'declared' ? 'declared' : m.why[0]?.kind === 'name' ? 'by name' : 'by text'}
        </span>
        {m.state === 'moved' && <span className="shrink-0 rounded bg-warning/15 px-1 text-[10px] text-warning" title={`was ${m.movedFrom}`}>moved</span>}
        {m.uncommitted && <span className="shrink-0 rounded bg-warning/15 px-1 text-[10px] text-warning">uncommitted</span>}
        {m.changedSinceAnalysis && <span className="shrink-0 rounded bg-warning/15 px-1 text-[10px] text-warning" title="Changed after the last Graphify analysis">graph stale</span>}
        {m.role === 'code' && <button onClick={() => actions.onGraph(m.path)} title="Open in Graphify" aria-label="Open in Graphify" data-testid="member-graph" className="ml-auto shrink-0 opacity-0 group-hover:opacity-100"><Network className="h-3 w-3" /></button>}
        <button onClick={() => actions.onOpen(m.path)} title="Open in editor" aria-label="Open in editor" className={cn('shrink-0 opacity-0 group-hover:opacity-100', m.role !== 'code' && 'ml-auto')}><Code2 className="h-3 w-3" /></button>
      </div>
      {open && (
        <div className="ml-5 space-y-0.5 pb-1">
          {m.symbols.map(s => <button key={s.id} onClick={() => actions.onOpen(m.path, s.line || undefined)} className="block truncate font-mono text-[10px] text-muted-foreground hover:text-foreground">{s.label.replace(/\(\)$/, '')}{s.line ? ` :${s.line}` : ''}</button>)}
        </div>
      )}
    </div>
  )
}

/** Evidence: everything the picture rests on, with its state in THIS checkout, plus maintenance. */
export function EvidenceTab({ v, actions, projectId, onChanged, onPick }: { v: SystemView; actions: SystemActions; projectId: string; onChanged: () => void; onPick: (id: string) => void }) {
  const m = v.maintenance
  return (
    <div className="space-y-5" data-testid="tab-evidence">
      {(v.limitations.length > 0 || m.vanished.length > 0 || m.unresolvedAnchors.length > 0 || m.needsReanalysis) && (
        <Section title="Maintenance and limits" testId="system-maintenance">
          <ul className="space-y-1 text-[11px] text-muted-foreground">
            {m.needsReanalysis && <li className="flex gap-1.5 text-warning"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />Changed after the last Graphify analysis: {m.changedMembers.map(baseName).join(', ')}. Re-analyze in Files to refresh symbols and relations.</li>}
            {m.vanished.length > 0 && (
              <li className="flex gap-1.5 text-warning" data-testid="system-vanished"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>Disappeared since earlier: {m.vanished.slice(0, 6).map(x => x.key.replace(/^(file|sym):/, '')).join('; ')}{m.vanished.length > 6 ? ` +${m.vanished.length - 6}` : ''}.{' '}
                  <button className="underline" onClick={async () => { await api.editSystem(projectId, v.id, { ackVanished: true }); onChanged() }}>Acknowledge</button></span>
              </li>
            )}
            {m.unresolvedAnchors.map(a => <li key={a.path} className="flex gap-1.5 text-warning"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />Anchored file no longer exists: <code>{a.path}</code></li>)}
            {v.limitations.map(l => <li key={l}>• {l}</li>)}
          </ul>
        </Section>
      )}

      <Section title="Gameplay relations" count={v.relations.length} testId="relations-evidence">
        {!v.relations.length && <p className="text-[11px] text-muted-foreground">None documented. Code links below are not gameplay relations.</p>}
        {v.relations.map(r => (
          <div key={r.id} className="space-y-0.5 rounded-md border p-2" data-testid="relation-row" data-basis={r.basis}>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium">{r.from.label} {r.label} {r.to.label}</span><BasisPill basis={r.basis} />
              <span className="text-[10px] text-muted-foreground">{r.status === 'confirmed' ? 'confirmed by you' : `proposed by ${r.origin}`} · {r.direction}</span>
            </div>
            {r.note && <p className="text-[11px] text-muted-foreground">{r.note}</p>}
            {r.evidence.map(e => <EvidenceLine key={`${e.path}|${e.needle}`} e={e} onOpen={actions.onOpen} />)}
          </div>
        ))}
      </Section>

      {v.technical.length > 0 && (
        <Section title="Code links (technical, not gameplay)" count={v.technical.length} hint="extracted = parsed from code · inferred = matched by function name">
          <div className="space-y-0.5">
            {v.technical.map(t => (
              <div key={t.toName} className="flex flex-wrap items-center gap-2 text-[11px]">
                {t.toSystem ? <button className="font-medium hover:underline" onClick={() => onPick(t.toSystem!)}>{t.toName}</button> : <span className="font-medium">{t.toName}</span>}
                <span className="text-muted-foreground">{Object.entries(t.relations).map(([k, n]) => `${k}×${n}`).join(', ')}</span>
                <span className="rounded bg-accent px-1 text-[10px]">{t.extracted} extracted</span>
                {t.inferred > 0 && <span className="rounded border border-dashed px-1 text-[10px] text-muted-foreground">{t.inferred} inferred</span>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {v.neighbors.length > 0 && (
        <Section title="Possible participants (graph neighbours, not members)" count={v.neighbors.length}>
          {v.neighbors.slice(0, 12).map(n => (
            <div key={n.path} className="flex items-center gap-2 text-[11px]">
              <button onClick={() => actions.onOpen(n.path)} className="truncate font-mono hover:underline">{n.path}</button>
              <span className={cn('shrink-0 rounded px-1 text-[10px]', n.confidence === 'EXTRACTED' ? 'bg-accent' : 'border border-dashed text-muted-foreground')}>{n.confidence === 'EXTRACTED' ? 'extracted' : 'inferred'} · {n.relation} ×{n.edges}</span>
            </div>
          ))}
        </Section>
      )}

      {v.overlaps.length > 0 && (
        <Section title="Possible duplicates" testId="system-overlaps" hint="same files described twice — review and merge if they are one system">
          {v.overlaps.map(o => <button key={o.id} onClick={() => onPick(o.id)} className="mr-2 rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent">{o.name} · {Math.round(o.ratio * 100)}% of files shared</button>)}
        </Section>
      )}

      <Section title="Related tasks" count={v.tasks.length}>
        {!v.tasks.length && <p className="text-[11px] text-muted-foreground">No task names a member file of this system.</p>}
        {v.tasks.map(t => <p key={t.id} className="text-[11px]"><span className="text-muted-foreground">{t.number ? `#${t.number}` : ''} {t.status}</span> {t.title} <span className="text-muted-foreground">· {t.matchedBy}</span></p>)}
      </Section>
    </div>
  )
}
