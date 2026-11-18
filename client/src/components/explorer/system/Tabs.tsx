import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ChevronRight, Code2, Network, Pencil, Sparkles } from 'lucide-react'
import { api, type SystemMember, type SystemView, type SystemArea } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BasisPill, EvidenceLine, ProvenancePill, Section, StatusPill, baseName, provenanceOfBasis, type SystemActions } from './parts'
import { AskMenu } from './AskMenu'
import { RelationPills } from './RelationList'
import { CONFIRM_MEANING } from '@/lib/relationState'
import { SystemMap } from './SystemMap'

const FACET: Record<string, string> = { logic: 'logic', data: 'data', ui: 'UI', telemetry: 'telemetry', purchase: 'purchase', requirement: 'requirement', effect: 'effect', test: 'test', other: 'other' }
const TIER_HELP: Record<string, string> = {
  core: 'Declared by an anchor, an area or a design decision',
  participant: 'Code or scene that matches by name only; not declared',
  candidate: 'Mentions the system in text, or a generated resource',
}

/** Overview: what the system is for, what it is responsible for, what is proposed, what is decided. */
export function OverviewTab({ v, actions, goTab, selectArea, projectId }: {
  v: SystemView; actions: SystemActions; goTab: (t: string) => void; selectArea: (id: string | null) => void; projectId: string
}) {
  const conflicts = v.comparisons.length
  const decided = v.design.decisions
  const implemented = decided.filter(d => d.implementation === 'implemented').length
  const approved = decided.filter(d => d.approval?.state === 'approved').length
  const described = v.areas.filter(a => !a.inferred)
  const inferred = v.areas.filter(a => a.inferred)
  return (
    <div className="space-y-5" data-testid="tab-overview">
      <PurposeCard v={v} projectId={projectId} actions={actions} />
      <ProposalsCard v={v} projectId={projectId} actions={actions} />

      <Section title="Responsibilities" count={v.responsibilities.length + described.length}>
        <div className="flex gap-1.5">
          <button onClick={() => actions.onQuickEdit?.({ type: 'component', id: 'new' })} data-testid="add-component-quick" className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent"><Pencil className="h-3 w-3" /> Add a component</button>
        </div>
        {v.responsibilities.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-xs" data-testid="responsibility-list">{v.responsibilities.map((r, i) => (
          <li key={r} className="group">{r}
            <button onClick={() => actions.onQuickEdit?.({ type: 'responsibility', index: i })} aria-label={`edit responsibility ${i + 1}`} data-testid="edit-responsibility" className="ml-2 inline-flex items-center text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 focus:opacity-100"><Pencil className="h-3 w-3" /></button>
          </li>))}</ul>}
        <div className="grid gap-2 sm:grid-cols-2" data-testid="area-blocks">
          {described.map(a => <AreaCard key={a.id} a={a} onPick={() => { selectArea(a.id); goTab('map') }} onImpl={() => { selectArea(a.id); goTab('implementation') }} actions={actions} />)}
        </div>
        {!v.responsibilities.length && !described.length && (
          <div className="rounded-md border border-dashed p-3 text-[11px] text-muted-foreground" data-testid="no-responsibilities">
            Nobody has described what this system is responsible for.{' '}
            <button className="underline" onClick={() => actions.onEdit?.('responsibilities')}>Describe responsibilities</button>
          </div>
        )}
        {inferred.length > 0 && (
          <Collapsible label={`${inferred.length} groupings inferred from file names (not design judgements)`}>
            <div className="grid gap-2 sm:grid-cols-2" data-testid="inferred-areas">
              {inferred.map(a => <AreaCard key={a.id} a={a} onPick={() => { selectArea(a.id); goTab('implementation') }} onImpl={() => { selectArea(a.id); goTab('implementation') }} actions={actions} />)}
            </div>
          </Collapsible>
        )}
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
              {conflicts ? <><AlertTriangle className="mr-1 inline h-3 w-3" />{conflicts} conflict{conflicts > 1 ? 's' : ''} recorded in the registry — compare</> : 'no conflicts recorded'}
            </button>
          </div>
        )}
        <p className="text-[10px] text-muted-foreground">Conflicts are the ones declared in the registered decisions; this screen does not detect new ones by itself.</p>
      </Section>

      <Section title="Gameplay map" hint="only relations someone declared, with their evidence">
        {v.relations.length > 0 ? (
          <><SystemMap v={v} actions={actions} compact /><button onClick={() => goTab('map')} className="text-[11px] underline">Open the full map</button></>
        ) : (
          <p className="rounded-md border border-dashed p-3 text-[11px] text-muted-foreground" data-testid="map-limit">
            No gameplay relation is declared, so there is nothing to draw. Names and code links do not prove one.{' '}
            <button className="underline" onClick={() => actions.onEdit?.('relations')}>Add a relation</button>
          </p>
        )}
      </Section>
    </div>
  )
}

/** The description of the system, editable in place. Saves text only; it does not confirm the system. */
function PurposeCard({ v, projectId, actions }: { v: SystemView; projectId: string; actions: SystemActions }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(v.summary)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (!editing) setText(v.summary) }, [v.summary, v.id, editing])
  const save = async () => {
    setSaving(true)
    try { await api.editSystem(projectId, v.id, { summary: text }); toast.success('Description saved'); setEditing(false); actions.onChanged?.() }
    catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }
  return (
    <section className="space-y-1.5 rounded-md border bg-card/40 p-3" data-testid="purpose-card">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">What it is for</h3>
        {!editing && <button onClick={() => setEditing(true)} data-testid="purpose-edit" className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"><Pencil className="h-3 w-3" /> Edit</button>}
      </div>
      {editing ? (
        <>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={5} autoFocus aria-label="description" data-testid="purpose-input"
            onKeyDown={e => { if (e.key === 'Escape') setEditing(false); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save() }}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring" placeholder="What does this do for the player and the game?" />
          <div className="flex items-center gap-1.5">
            <button onClick={save} disabled={saving} data-testid="purpose-save" className="rounded-md bg-primary px-2.5 py-1 text-[11px] text-primary-foreground">Save</button>
            <button onClick={() => { setEditing(false); setText(v.summary) }} className="rounded-md border px-2.5 py-1 text-[11px] hover:bg-accent">Cancel</button>
            <span className="text-[10px] text-muted-foreground">Ctrl+Enter saves. Saving text does not confirm the system.</span>
          </div>
        </>
      ) : v.summary ? (
        <p className="whitespace-pre-wrap text-sm" data-testid="system-summary">{v.summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="system-summary-empty">No description yet. Write what this does for the player, or ask an agent to propose one.</p>
      )}
    </section>
  )
}

/** What agents proposed and nobody reviewed. An agent cannot confirm anything; "Accept" is the person's act. */
function ProposalsCard({ v, projectId, actions }: { v: SystemView; projectId: string; actions: SystemActions }) {
  const proposedAreas = v.areas.filter(a => !a.inferred && a.origin === 'agent' && a.status === 'proposed')
  const proposedRels = v.relations.filter(r => r.origin === 'agent' && r.status === 'proposed' && r.direction !== 'incoming')
  if (!v.suggestions.length && !proposedAreas.length && !proposedRels.length) return null
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast.success(ok); actions.onChanged?.() } catch (e: any) { toast.error(e.message) } }
  return (
    <section className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3" data-testid="proposals-card">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning"><Sparkles className="h-3 w-3" />Proposed by an agent — for you to review</h3>
      {v.suggestions.map((sg, i) => (
        <div key={sg.at} className="space-y-1 rounded-md border bg-background p-2 text-xs" data-testid="suggestion">
          <p className="text-[10px] text-muted-foreground">{sg.origin} · {sg.at.slice(0, 16).replace('T', ' ')} · proposal against a confirmed system</p>
          {sg.summary && <p>{sg.summary}</p>}
          <p className="text-[11px] text-muted-foreground">{[sg.areas?.length ? `${sg.areas.length} components` : '', sg.relations?.length ? `${sg.relations.length} relations` : '', sg.anchors.terms.length ? `terms: ${sg.anchors.terms.join(', ')}` : '', sg.anchors.files.length ? `${sg.anchors.files.length} files` : ''].filter(Boolean).join(' · ') || 'text only'}</p>
          <div className="flex gap-1.5">
            <button onClick={() => run(() => api.editSystem(projectId, v.id, { adoptSuggestion: i }), 'Adopted as a proposal')} className="rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent" data-testid="adopt-suggestion">Adopt as proposal</button>
            <button onClick={() => run(() => api.editSystem(projectId, v.id, { dropSuggestion: i }), 'Discarded')} className="rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent">Discard</button>
          </div>
        </div>
      ))}
      {proposedAreas.map(a => (
        <div key={a.id} className="flex flex-wrap items-center gap-2 text-xs" data-testid="proposed-area">
          <span className="font-medium">{a.name}</span><span className="rounded bg-accent px-1.5 text-[10px]">{a.kind}</span><BasisPill basis={a.basis} />
          <span className="text-[11px] text-muted-foreground">{a.summary}</span>
          <button onClick={() => run(() => api.editSystem(projectId, v.id, { confirm: { areas: [a.id] } }), 'Component confirmed')} className="ml-auto rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent">Accept</button>
          <button onClick={() => run(() => api.editSystem(projectId, v.id, { remove: { areas: [a.id] } }), 'Component removed')} className="rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent">Reject</button>
        </div>
      ))}
      {proposedRels.map(r => (
        <div key={r.id} className="flex flex-wrap items-center gap-2 text-xs" data-testid="proposed-relation">
          <span className="font-medium">{r.from.label} {r.label} {r.to.label}</span><RelationPills r={r} />
          <button onClick={() => actions.onQuickEdit?.({ type: 'relation', id: r.id })} className="ml-auto text-[11px] underline">Open in editor</button>
          <button onClick={() => run(() => api.editSystem(projectId, v.id, { confirm: { relations: [r.id] } }), 'Relation confirmed')} title="Confirms immediately, without opening the editor" className="rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent">Accept</button>
          <button onClick={() => run(() => api.editSystem(projectId, v.id, { remove: { relations: [r.id] } }), 'Relation removed')} className="rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent">Reject</button>
        </div>
      ))}
      <p className="text-[10px] text-muted-foreground">“Accept” is the same act as ticking “confirm” in the editor and takes effect immediately. {CONFIRM_MEANING}</p>
    </section>
  )
}

const Stat = ({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) => (
  <span className={cn('rounded-md border px-2 py-1', warn && 'border-warning/50 text-warning')}><b className="tabular-nums">{value}</b> <span className="text-muted-foreground">{label}</span></span>
)

function AreaCard({ a, onPick, onImpl, actions }: { a: SystemArea; onPick: () => void; onImpl: () => void; actions: SystemActions }) {
  return (
    <div className="space-y-1 rounded-md border bg-card/40 p-2" data-testid="area-card" data-inferred={a.inferred}>
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={onPick} className="text-xs font-medium hover:underline">{a.name}</button>
        <span className="rounded bg-accent px-1.5 text-[10px]">{a.kind === 'facet' ? 'inferred' : a.kind}</span>
        {a.planned && <span className="rounded border border-dashed px-1.5 text-[10px] text-muted-foreground" data-testid="planned-pill">planned</span>}
        <StatusPill status={a.status === 'inferred' ? 'inferred' : a.status} />
        <BasisPill basis={a.basis} />
      </div>
      <p className="line-clamp-2 text-[11px] text-muted-foreground">{a.summary || (a.inferred ? 'Files grouped by path vocabulary; no responsibility written.' : 'No description.')}</p>
      <div className="flex items-center gap-2">
        <button onClick={onImpl} className="text-[10px] text-muted-foreground hover:underline">{a.planned && !a.fileCount ? 'planned: not built yet' : `${a.fileCount} files · ${a.testCount} tests${a.families.length ? ` · ${a.families.length} resource families` : ''}`}</button>
        {!a.inferred && <button onClick={() => actions.onQuickEdit?.({ type: 'component', id: a.id })} data-testid="edit-component" className="ml-auto flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] hover:bg-accent"><Pencil className="h-3 w-3" /> Edit</button>}
        {!a.inferred && <span><AskMenu actions={actions} areaId={a.id} target={`the component "${a.name}"`} label="Ask" small /></span>}
      </div>
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
      <Provenance v={v} />

      {v.limitations.length > 0 && (
        <Section title="Limits" hint="Warnings about stale analysis and missing files are listed under the system header." testId="system-maintenance">
          <ul className="space-y-1 text-[11px] text-muted-foreground">
            {v.limitations.map(l => <li key={l}>• {l}</li>)}
          </ul>
        </Section>
      )}

      <Section title="Gameplay relations" count={v.relations.length} testId="relations-evidence">
        {!v.relations.length && <p className="text-[11px] text-muted-foreground">None documented. Code links below are not gameplay relations.</p>}
        {v.relations.map(r => (
          <div key={r.id} className="space-y-0.5 rounded-md border p-2" data-testid="relation-row" data-basis={r.basis}>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium">{r.from.label} {r.label} {r.to.label}</span><RelationPills r={r} />
              <span className="text-[10px] text-muted-foreground">{r.direction}</span>
              {r.direction !== 'incoming' && <button onClick={() => actions.onQuickEdit?.({ type: 'relation', id: r.id })} data-testid="evidence-relation-edit" className="ml-auto rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent">Edit</button>}
            </div>
            {!r.evidence.length && <p className="text-[11px] text-muted-foreground">Design only: no code evidence attached.</p>}
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

/** Every claim of this system with where it comes from. Four kinds, never merged: observed, inferred, test reference, human. */
function Provenance({ v }: { v: SystemView }) {
  type K = 'observed' | 'inferred' | 'test' | 'human'
  const rows: { claim: string; what: string; kinds: { k: K; label?: string }[] }[] = []
  rows.push({
    claim: 'Classification', what: `${v.name} as a system`,
    kinds: v.status === 'confirmed' ? [{ k: 'human', label: `confirmed by you ${v.confirmedAt?.slice(0, 10) ?? ''}` }] : [{ k: 'inferred', label: v.origin === 'discovery' ? 'found by file names' : `proposed by ${v.origin}` }],
  })
  for (const a of v.areas.filter(x => !x.inferred)) {
    rows.push({ claim: 'Component', what: a.name, kinds: [{ k: provenanceOfBasis(a.basis), label: a.basis === 'demonstrated' ? 'evidence text found' : a.basis }, ...(a.status === 'confirmed' ? [{ k: 'human' as K, label: 'confirmed' }] : [])] })
  }
  for (const r of v.relations.filter(x => x.direction !== 'incoming')) {
    rows.push({ claim: 'Relation', what: `${r.from.label} ${r.label} ${r.to.label}`, kinds: [{ k: provenanceOfBasis(r.basis), label: r.basis === 'demonstrated' ? 'cited text found' : r.basis }, ...(r.status === 'confirmed' ? [{ k: 'human' as K, label: 'confirmed' }] : [])] })
  }
  for (const d of v.design.decisions) {
    const ap = d.approval?.state
    const kinds: { k: K; label?: string }[] = []
    if (d.implementation === 'implemented') kinds.push({ k: 'observed', label: 'implemented in code' })
    else kinds.push({ k: 'inferred', label: `implementation: ${d.implementation}` })
    if (d.tests.length) kinds.push({ k: 'test', label: `${d.tests.length} test files (not run)` })
    kinds.push(ap && ap !== 'unknown' && d.approval?.source === 'attested_local' ? { k: 'human', label: `${ap} (attested locally)` } : { k: 'inferred', label: ap && ap !== 'unknown' ? `${ap} (claimed in a document)` : 'no approval located' })
    rows.push({ claim: 'Decision', what: `${d.id} ${d.title}`, kinds })
  }
  return (
    <Section title="Where each claim comes from" hint="observed is not approved, and approved is not tested" testId="provenance">
      <div className="space-y-1" data-testid="provenance-list">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{r.claim}</span>
            <span className="min-w-0 flex-1 truncate" title={r.what}>{r.what}</span>
            {r.kinds.map((k, j) => <ProvenancePill key={j} kind={k.k} label={k.label} />)}
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground">Observed = text or structure found in this checkout. Inferred = by name or by a name-only code link. Test reference = a test file mentions it; nothing is executed here. Human = a person confirmed or approved it on this installation.</p>
    </Section>
  )
}
