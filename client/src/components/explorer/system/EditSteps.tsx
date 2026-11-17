import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, ExternalLink, FileCode2, Plus, Trash2, X } from 'lucide-react'
import { api, type SystemEvidence, type SystemSummary, type SystemView } from '@/lib/api'
import { cn } from '@/lib/utils'
import { GROUPS, RELATION_RULES, relLabel, slug, type ThingKind } from '@/lib/relationRules'
import { buildTarget, formReducer, formToDraft, initForm, operatorChoices, problemOf, relSig, type DraftRel, type Ev, type TargetType } from '@/lib/relationForm'
import { EvidenceLine } from './parts'

/** Pieces of the system editor. The dialog owns the draft; these only render and patch it. */

export type AreaKind = 'subsystem' | 'mechanic' | 'entity'
export type { Ev, DraftRel }
export interface DraftArea {
  key: string; id: string; name: string; kind: AreaKind; summary: string; files: string[]; terms: string[]
  resp: string[]; planned: boolean; ev: Ev[]; evView: SystemEvidence[]
  isNew: boolean; removed: boolean; pick: boolean
}
/** What a quick edit targets, so the same editor can open on one piece instead of the five steps. */
export type Focus =
  | { type: 'identity' }
  | { type: 'responsibility'; index: number }
  | { type: 'component'; id: string | 'new' }
  | { type: 'relation'; id: string | 'new' }

export const uniq = <T,>(xs: T[]) => [...new Set(xs)]
export const field = 'w-full rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring'
let uid = 0
export const newKey = () => `k${++uid}`
export const areaId = (a: Pick<DraftArea, 'isNew' | 'id' | 'name'>) => (a.isNew ? slug(a.name) : a.id)
export const areaRef = (a: Pick<DraftArea, 'isNew' | 'id' | 'name'>) => `area:${areaId(a)}`

export const KIND_HELP: Record<string, string> = {
  system: 'A self-contained part of the game with its own rules. Often the thing that manages entities and mechanics.',
  subsystem: 'A part that only makes sense inside a larger system.',
  mechanic: 'A single rule or action the player performs.',
  entity: 'A thing the game keeps track of: a resource, an item, a status. It is not the system that handles it.',
}

export function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return <div className="mb-1"><span className="text-xs font-medium">{children}</span>{hint && <span className="ml-2 text-[11px] text-muted-foreground">{hint}</span>}</div>
}

// ---- shared pickers -------------------------------------------------------------------------------

const splitSym = (f: string) => { const i = f.indexOf('#'); return i < 0 ? [f, ''] as const : [f.slice(0, i), f.slice(i + 1)] as const }

/** Search-as-you-type picker over the project file index (the same one behind Ctrl+K and the Explorer). */
export function FilePicker({ projectId, value, onChange, label, single, symbols, onOpen }: {
  projectId: string; value: string[]; onChange: (x: string[]) => void; label?: string; single?: boolean
  /** show an optional symbol (function, class) next to each file; stored as path#symbol */
  symbols?: boolean; onOpen?: (file: string) => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<string[]>([])
  const seq = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!q.trim()) { setHits([]); return }
    const t = setTimeout(() => {
      seq.current?.abort(); const ac = new AbortController(); seq.current = ac
      api.searchFiles(q, { projectId, signal: ac.signal }).then(r => setHits(r.results.filter(x => x.type === 'file').slice(0, 8).map(x => x.path.replace(/\\/g, '/')))).catch(() => { /* aborted */ })
    }, 150)
    return () => clearTimeout(t)
  }, [q, projectId])
  const add = (p: string) => { onChange(single ? [p] : uniq([...value, p])); setQ(''); setHits([]) }
  return (
    <div className="space-y-1.5">
      {label && <Label>{label}</Label>}
      {value.length > 0 && (
        <ul className="space-y-0.5" data-testid="picked-files">
          {value.map(f => {
            const [path, sym] = splitSym(f)
            return (
              <li key={f} className="flex items-center gap-1.5 rounded bg-muted/40 px-1.5 py-0.5 text-[11px]">
                <FileCode2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                {onOpen ? <button onClick={() => onOpen(path)} className="truncate font-mono hover:underline" title="Open in the editor">{path}</button> : <span className="truncate font-mono">{path}</span>}
                {symbols && (
                  <input value={sym} onChange={e => onChange(value.map(x => x === f ? (e.target.value.trim() ? `${path}#${e.target.value.trim()}` : path) : x))}
                    placeholder="symbol (optional)" aria-label={`symbol in ${path}`} className="ml-auto h-5 w-32 shrink-0 rounded border bg-background px-1 text-[10px] outline-none" />
                )}
                <button onClick={() => onChange(value.filter(x => x !== f))} aria-label={`remove ${f}`} className={cn('shrink-0 rounded hover:bg-accent', !symbols && 'ml-auto')}><X className="h-3 w-3" /></button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="relative">
        <input className={field} value={q} onChange={e => setQ(e.target.value)} placeholder="Search the project's files by name…" aria-label="search files" data-testid="file-search" />
        {hits.length > 0 && (
          <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
            {hits.map(h => <button key={h} onClick={() => add(h)} className="block w-full truncate px-2 py-1 text-left font-mono text-[11px] hover:bg-accent">{h}</button>)}
          </div>
        )}
      </div>
    </div>
  )
}

export function TermChips({ label, hint, value, onChange }: { label: string; hint?: string; value: string[]; onChange: (x: string[]) => void }) {
  const [t, setT] = useState('')
  const commit = () => { const x = t.trim().toLowerCase(); if (x) { onChange(uniq([...value, x])); setT('') } }
  return (
    <div className="space-y-1.5">
      <Label hint={hint}>{label}</Label>
      <div className="flex flex-wrap gap-1">
        {value.map(x => <span key={x} className="flex items-center gap-1 rounded-full border bg-accent/50 py-0.5 pl-2 pr-1 text-[11px]">{x}<button onClick={() => onChange(value.filter(y => y !== x))} aria-label={`remove ${x}`}><X className="h-3 w-3" /></button></span>)}
        <input className="h-6 min-w-[8rem] flex-1 rounded-md border bg-background px-2 text-[11px] outline-none" value={t} onChange={e => setT(e.target.value)} onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() } }} placeholder="add a term" aria-label={`${label} input`} />
      </div>
    </div>
  )
}

// ---- 1. identity ----------------------------------------------------------------------------------

export function IdentityStep({ name, setName, kind, setKind, summary, setSummary, planned, setPlanned }: {
  name: string; setName: (s: string) => void; kind: string; setKind: (s: string) => void; summary: string; setSummary: (s: string) => void
  planned: boolean; setPlanned: (b: boolean) => void
}) {
  return (
    <div className="space-y-4" data-testid="step-identity">
      <div><Label hint="the word the team uses for it">Name</Label><input className={field} value={name} onChange={e => setName(e.target.value)} aria-label="name" data-testid="identity-name" /></div>
      <div>
        <Label>What is it?</Label>
        <div className="grid grid-cols-2 gap-2">
          {(['system', 'subsystem', 'mechanic', 'entity'] as const).map(k => (
            <button key={k} onClick={() => setKind(k)} aria-pressed={kind === k} data-testid={`kind-${k}`}
              className={cn('rounded-md border p-2 text-left hover:bg-accent/60', kind === k && 'border-foreground bg-accent')}>
              <span className="block text-xs font-medium capitalize">{k}</span><span className="block text-[10px] text-muted-foreground">{KIND_HELP[k]}</span>
            </button>
          ))}
        </div>
        <p className="mt-1.5 rounded-md bg-accent/50 p-2 text-[10px] text-muted-foreground">
          A resource and the system that earns, spends and balances it are different things. Describe the resource as an <b>entity</b>, the system as a <b>system</b>, and connect them in Relations
          (the system <i>produces</i>, <i>consumes</i> or <i>controls</i> the entity).
        </p>
      </div>
      <div>
        <Label hint="purpose first: what does it do for the player and the game?">Description and purpose</Label>
        <textarea className={field} rows={6} value={summary} onChange={e => setSummary(e.target.value)} aria-label="summary" data-testid="identity-summary" placeholder="e.g. What the player does with it, what it earns or costs, what it is for." />
        <p className="mt-1 text-[10px] text-muted-foreground">Written in game terms. Rules and numbers belong in Design decisions, where they can be compared with the code.</p>
      </div>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={planned} onChange={e => setPlanned(e.target.checked)} className="mt-0.5" data-testid="identity-planned" />
        <span><b>Planned</b> — designed but not built yet. No files are expected, and their absence is not reported as a gap.</span></label>
    </div>
  )
}

// ---- 2. responsibilities and components -----------------------------------------------------------

export function ComponentEditor({ a, patch, allResp, projectId, onOpen, onRemove }: {
  a: DraftArea; patch: (p: Partial<DraftArea>) => void; allResp: string[]; projectId: string; onOpen?: (f: string) => void; onRemove: () => void
}) {
  const [evFile, setEvFile] = useState<string[]>([])
  const [evNeedle, setEvNeedle] = useState('')
  const viewOf = (e: Ev) => a.evView.find(x => x.path === e.path && (x.needle ?? '') === (e.needle ?? ''))
  return (
    <div className="space-y-3" data-testid="component-editor">
      <div className="grid grid-cols-[1fr_150px_auto] gap-2">
        <input className={cn(field, !a.name.trim() && 'border-destructive/60')} value={a.name} onChange={e => patch({ name: e.target.value })} placeholder="Name" aria-label="component name" aria-invalid={!a.name.trim()} data-testid="component-name" autoFocus={a.isNew && !a.name} />
        <select className={field} value={a.kind} onChange={e => patch({ kind: e.target.value as AreaKind })} aria-label="component type" data-testid="component-kind">
          <option value="mechanic">mechanic</option><option value="subsystem">subsystem</option><option value="entity">entity</option>
        </select>
        <button onClick={onRemove} title={a.removed ? 'Keep this component' : 'Remove component'} aria-label={a.removed ? 'Keep this component' : 'Remove component'} data-testid="component-remove"
          className="rounded-md border px-2 text-destructive hover:bg-destructive/10"><Trash2 className="h-3.5 w-3.5" /></button>
        {!a.name.trim() && <p className="col-span-3 -mt-1 text-[10px] text-destructive" data-testid="component-name-error">This component needs a name before the system can be saved. Remove it with the bin if you added it by mistake.</p>}
      </div>
      <textarea className={field} rows={2} value={a.summary} onChange={e => patch({ summary: e.target.value })} placeholder="What does it do in the game?" aria-label="component summary" data-testid="component-summary" />
      <label className="flex items-start gap-2 text-[11px]"><input type="checkbox" checked={a.planned} onChange={e => patch({ planned: e.target.checked })} className="mt-0.5" data-testid="component-planned" />
        <span><b>Planned</b> — not built yet; no files needed.</span></label>

      <div>
        <Label hint="which of this system's responsibilities it carries out">Responsibilities</Label>
        {!allResp.length ? <p className="text-[11px] text-muted-foreground">The system has no responsibilities listed yet. Add them in the Responsibilities step.</p> : (
          <div className="space-y-0.5">
            {allResp.map(r => (
              <label key={r} className="flex items-start gap-2 text-[11px]">
                <input type="checkbox" checked={a.resp.includes(r)} onChange={e => patch({ resp: e.target.checked ? [...a.resp, r] : a.resp.filter(x => x !== r) })} className="mt-0.5" />{r}
              </label>
            ))}
          </div>
        )}
      </div>

      <FilePicker label="Files and symbols that implement it" projectId={projectId} value={a.files} onChange={f => patch({ files: f })} symbols onOpen={onOpen} />
      {a.planned && a.files.length === 0 && <p className="text-[10px] text-muted-foreground">Planned: no files yet is fine. Link them when the code exists.</p>}
      <TermChips label="Name terms" hint="files whose name contains one of these are counted as participants" value={a.terms} onChange={t => patch({ terms: t })} />

      <details className="rounded-md border p-2 text-[11px]" data-testid="component-evidence">
        <summary className="cursor-pointer text-muted-foreground">Evidence ({a.ev.length}) — code that shows it exists</summary>
        <div className="mt-2 space-y-1.5">
          {!a.ev.length && <p className="text-muted-foreground">None. Without evidence the component is a description, not a verified part of the code.</p>}
          {a.ev.map((e, i) => {
            const vw = viewOf(e)
            return (
              <div key={`${e.path}|${e.needle ?? ''}`} className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">{vw && onOpen ? <EvidenceLine e={vw} onOpen={onOpen} /> : <span className="font-mono">{e.path}{e.needle ? ` — “${e.needle}”` : ''} <span className="text-muted-foreground">(not checked yet)</span></span>}</div>
                <button onClick={() => patch({ ev: a.ev.filter((_, j) => j !== i) })} aria-label="remove evidence" className="rounded p-0.5 hover:bg-accent"><X className="h-3 w-3" /></button>
              </div>
            )
          })}
          <FilePicker projectId={projectId} value={evFile} onChange={p => setEvFile(p.slice(-1))} single />
          <input className={field} value={evNeedle} onChange={e => setEvNeedle(e.target.value)} placeholder="Text that must stay in that file (optional)" aria-label="evidence text" />
          <button disabled={!evFile[0]} onClick={() => { patch({ ev: [...a.ev, { path: evFile[0], ...(evNeedle.trim() ? { needle: evNeedle.trim() } : {}) }] }); setEvFile([]); setEvNeedle('') }}
            className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-40">Add evidence</button>
        </div>
      </details>

    </div>
  )
}

export function ResponsibilitiesStep({ resp, setResp, renameResp, removeResp, areas, setAreas, projectId, onOpen, openKey, setOpenKey }: {
  resp: string[]; setResp: (x: string[]) => void; renameResp: (i: number, t: string) => void; removeResp: (i: number) => void
  areas: DraftArea[]; setAreas: (x: DraftArea[]) => void; projectId: string; onOpen?: (f: string) => void
  openKey: string | null; setOpenKey: (k: string | null) => void
}) {
  const [text, setText] = useState('')
  const patch = (key: string, p: Partial<DraftArea>) => setAreas(areas.map(a => a.key === key ? { ...a, ...p } : a))
  // One unnamed component at a time: a second click reopens the one that still needs its name.
  const add = () => {
    const pending = areas.find(a => a.isNew && !a.removed && !a.name.trim())
    if (pending) { setOpenKey(pending.key); return }
    const a = blankArea(); setAreas([...areas, a]); setOpenKey(a.key)
  }
  const visible = areas.filter(a => !(a.removed && a.isNew))
  return (
    <div className="space-y-5" data-testid="step-responsibilities">
      <section className="space-y-2">
        <Label hint="short statements of what the system answers for. Components below carry them out">What this system is responsible for</Label>
        <ul className="space-y-1">
          {resp.map((r, i) => (
            <li key={i} className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <input className={field} value={r} onChange={e => renameResp(i, e.target.value)} aria-label={`responsibility ${i + 1}`} />
                <button onClick={() => removeResp(i)} aria-label="remove responsibility" className="rounded p-1 hover:bg-accent"><X className="h-3.5 w-3.5" /></button>
              </div>
              <p className="pl-1 text-[10px] text-muted-foreground">{areas.filter(a => !a.removed && a.resp.includes(r)).map(a => a.name || 'unnamed').join(' · ') || 'not carried out by any component yet'}</p>
            </li>
          ))}
        </ul>
        <div className="flex gap-1.5">
          <input className={field} value={text} onChange={e => setText(e.target.value)} placeholder="Add a responsibility and press Enter" data-testid="resp-input"
            onKeyDown={e => { if (e.key === 'Enter' && text.trim()) { setResp([...resp, text.trim()]); setText('') } }} />
          <button onClick={() => { if (text.trim()) { setResp([...resp, text.trim()]); setText('') } }} className="rounded-md border px-2 hover:bg-accent" aria-label="add responsibility"><Plus className="h-3.5 w-3.5" /></button>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center"><Label hint="parts of the system: a mechanic, a subsystem or an entity, each with its own files and evidence">Components</Label>
          <button onClick={add} data-testid="add-area" className="ml-auto flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent"><Plus className="h-3 w-3" /> Add component</button>
        </div>
        {!visible.length && <p className="rounded-md border border-dashed p-3 text-[11px] text-muted-foreground">No components described. A planned mechanic needs only a name and a purpose; files can come later.</p>}
        {visible.map(a => (
          <div key={a.key} className={cn('rounded-md border', a.removed && 'opacity-50')} data-testid="area-edit-card">
            <button onClick={() => setOpenKey(openKey === a.key ? null : a.key)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
              <ChevronRight className={cn('h-3 w-3 transition-transform', openKey === a.key && 'rotate-90')} />
              <span className={cn('text-xs font-medium', a.removed && 'line-through', !a.name.trim() && 'text-destructive')}>{a.name || 'Needs a name'}</span>
              <span className="rounded bg-accent px-1.5 text-[10px]">{a.kind}</span>
              {a.planned && <span className="rounded border border-dashed px-1.5 text-[10px] text-muted-foreground">planned</span>}
              {a.isNew && <span className="rounded bg-warning/15 px-1.5 text-[10px] text-warning">new</span>}
              {a.removed && <span className="text-[10px] text-destructive">will be removed</span>}
              <span className="ml-auto text-[10px] text-muted-foreground">{a.files.length} files · {a.resp.length} resp. · {a.ev.length} evidence</span>
            </button>
            {openKey === a.key && (
              <div className="border-t p-2.5">
                <ComponentEditor a={a} patch={p => patch(a.key, p)} allResp={resp} projectId={projectId} onOpen={onOpen}
                  onRemove={() => (a.isNew ? setAreas(areas.filter(x => x.key !== a.key)) : patch(a.key, { removed: !a.removed }))} />
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  )
}

export const blankArea = (): DraftArea => ({ key: newKey(), id: '', name: '', kind: 'mechanic', summary: '', files: [], terms: [], resp: [], planned: false, ev: [], evView: [], isNew: true, removed: false, pick: false })

// ---- 3. members -----------------------------------------------------------------------------------

type MemberClass = 'confirmed' | 'declared' | 'name' | 'code'
const CLASS_UI: Record<MemberClass, { label: string; cls: string; title: string }> = {
  confirmed: { label: 'confirmed', cls: 'bg-success/15 text-success', title: 'Pinned or linked by a person and the system or component is confirmed' },
  declared: { label: 'declared', cls: 'bg-accent', title: 'Named by a person, an agent, a component or a decision, not yet confirmed' },
  name: { label: 'candidate · by name', cls: 'border border-dashed text-muted-foreground', title: 'Its file name or text matches; nobody said it belongs' },
  code: { label: 'candidate · by code', cls: 'border border-dashed text-warning', title: 'A code-graph neighbour: calls or imports. A dependency, not necessarily a member' },
}

interface MemberRow { path: string; cls: MemberClass; why: string[]; via: string[]; direct: boolean }

export function MembersStep({ v, projectId, files, setFiles, terms, setTerms, areas, onOpen }: {
  v: SystemView; projectId: string; files: string[]; setFiles: (x: string[]) => void; terms: string[]; setTerms: (x: string[]) => void
  areas: DraftArea[]; onOpen?: (f: string) => void
}) {
  const [all, setAll] = useState(false)
  const rows = useMemo(() => {
    const direct = new Map(files.map(f => [splitSym(f)[0], f]))
    const byArea = new Map<string, string[]>()
    for (const a of areas) if (!a.removed) for (const f of a.files) { const p = splitSym(f)[0]; byArea.set(p, [...(byArea.get(p) ?? []), a.name || 'unnamed component']) }
    const confirmedArea = new Set(v.areas.filter(a => a.status === 'confirmed').map(a => a.id))
    const out = new Map<string, MemberRow>()
    for (const m of v.members) {
      if (m.role === 'test' || m.tier === 'historical' || m.tier === 'related') continue
      const decl = m.why.filter(w => w.kind === 'anchor' || w.kind === 'dk')
      const viaAreas = uniq([...(byArea.get(m.path) ?? []), ...m.areas.map(id => v.areas.find(a => a.id === id)?.name ?? id)])
      const declared = decl.length > 0 || direct.has(m.path) || viaAreas.length > 0
      const conf = declared && ((v.status === 'confirmed' && (direct.has(m.path) || decl.some(w => w.kind === 'anchor'))) || m.areas.some(id => confirmedArea.has(id)))
      out.set(m.path, {
        path: m.path, cls: conf ? 'confirmed' : declared ? 'declared' : 'name', direct: direct.has(m.path), via: viaAreas,
        why: m.why.map(w => `${w.kind === 'anchor' ? 'pinned' : w.kind === 'dk' ? 'decision' : w.kind === 'name' ? 'name' : 'text'}: ${w.detail}`),
      })
    }
    for (const [p] of direct) if (!out.has(p)) out.set(p, { path: p, cls: 'declared', direct: true, via: byArea.get(p) ?? [], why: ['pinned in this edit (not saved yet)'] })
    for (const [p, names] of byArea) if (!out.has(p)) out.set(p, { path: p, cls: 'declared', direct: direct.has(p), via: names, why: ['listed by a component in this edit'] })
    for (const n of v.neighbors) {
      if (out.has(n.path)) continue
      out.set(n.path, { path: n.path, cls: 'code', direct: false, via: [], why: [`code graph (${n.confidence === 'EXTRACTED' ? 'extracted' : 'inferred'}): ${n.relation} via ${n.via}`] })
    }
    return [...out.values()]
  }, [v, files, areas])
  const core = rows.filter(r => r.cls === 'confirmed' || r.cls === 'declared')
  const byName = rows.filter(r => r.cls === 'name')
  const byCode = rows.filter(r => r.cls === 'code')
  const limit = all ? 500 : 12
  const Row = ({ r }: { r: MemberRow }) => {
    const [why, setWhy] = useState(false)
    const ui = CLASS_UI[r.cls]
    return (
      <li className="rounded border px-2 py-1 text-[11px]" data-testid="member-row" data-class={r.cls}>
        <div className="flex items-center gap-2">
          <button onClick={() => onOpen?.(r.path)} className="min-w-0 flex-1 truncate text-left font-mono hover:underline" title="Open in the editor">{r.path}</button>
          <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', ui.cls)} title={ui.title}>{ui.label}</span>
          <button onClick={() => setWhy(!why)} className="shrink-0 text-[10px] text-muted-foreground hover:underline" aria-expanded={why}>why</button>
          {r.direct ? <button onClick={() => setFiles(files.filter(f => splitSym(f)[0] !== r.path))} className="shrink-0 rounded-md border px-1.5 py-0.5 hover:bg-accent" data-testid="unpin-member">Unpin</button>
            : r.via.length || r.cls === 'confirmed' || r.cls === 'declared'
              ? <span className="shrink-0 text-[10px] text-muted-foreground">via {r.via.join(', ') || 'decision'}</span>
              : <button onClick={() => setFiles(uniq([...files, r.path]))} className="shrink-0 rounded-md border px-1.5 py-0.5 hover:bg-accent" data-testid="pin-candidate">Pin as member</button>}
        </div>
        {why && (
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[10px] text-muted-foreground" data-testid="member-why">
            {r.why.map((w, i) => <li key={i}>{w}</li>)}
            {r.via.length > 0 && <li>carried by component: {r.via.join(', ')}</li>}
          </ul>
        )}
      </li>
    )
  }
  const List = ({ rs, empty }: { rs: MemberRow[]; empty: string }) => (
    <>
      {!rs.length && <p className="text-[11px] text-muted-foreground">{empty}</p>}
      <ul className="space-y-1">{rs.slice(0, limit).map(r => <Row key={r.path} r={r} />)}</ul>
      {rs.length > limit && <button onClick={() => setAll(true)} className="text-[11px] underline">Show all {rs.length}</button>}
    </>
  )
  return (
    <div className="space-y-5" data-testid="step-members">
      <section className="space-y-2">
        <Label hint="always belong, whatever their name">Pin a file</Label>
        <FilePicker projectId={projectId} value={files} onChange={setFiles} symbols onOpen={onOpen} />
        <TermChips label="Name terms" hint="words that, in a file name, say it belongs here" value={terms} onChange={setTerms} />
      </section>
      <section className="space-y-1.5" data-testid="members-core">
        <Label hint="pinned here, or carried by a component or a decision">Central members <span className="tabular-nums opacity-60">{core.length}</span></Label>
        <List rs={core} empty="No central members yet. Pin a file above, link files to a component, or leave it planned." />
      </section>
      <section className="space-y-1.5" data-testid="members-name">
        <Label hint="match by name or text only: not part of the system until you pin them">Candidates by name <span className="tabular-nums opacity-60">{byName.length}</span></Label>
        <List rs={byName} empty="No further candidates by name." />
      </section>
      <section className="space-y-1.5" data-testid="members-code">
        <Label hint="code this system's files call or import: a dependency, not a member">Candidates by code <span className="tabular-nums opacity-60">{byCode.length}</span></Label>
        <List rs={byCode} empty="No code-graph neighbours." />
      </section>
    </div>
  )
}

// ---- 4. relations ---------------------------------------------------------------------------------

export interface RelCtx {
  v: SystemView; systemKind: ThingKind; areas: DraftArea[]; allSystems: SystemSummary[]; projectId: string
  label: (ref: string) => string; kindOf: (ref: string) => ThingKind | undefined; onOpen?: (f: string) => void
}

/**
 * One relation, new or existing. The operator is one picker (grouped by meaning) and is changed only by the person.
 * Two ways to host it: with `onDone/onCancel` it has its own Done/Cancel (the multi-step editor, which saves from Review);
 * with `live` it has no buttons at all and every edit goes straight into the draft, so the dialog footer is the only Save.
 */
export function RelationForm({ ctx, initial, onDone, onCancel, live }: {
  ctx: RelCtx; initial: DraftRel | null; onDone?: (r: DraftRel) => void; onCancel?: () => void; live?: (r: DraftRel) => void
}) {
  const { v, areas, allSystems, projectId } = ctx
  const base = useRef(initial); const newId = useRef(newKey())
  const [s, dispatch] = useReducer(formReducer, initial, r => initForm(r))
  const [evFile, setEvFile] = useState<string[]>([]); const [evNeedle, setEvNeedle] = useState('')
  const { target: t, kind, from, note, ev } = s
  const others = allSystems.filter(x => x.id !== v.id && x.status !== 'dismissed' && x.status !== 'merged')
  const targetQ = useQuery({ queryKey: ['system', projectId, t.sys, ''], queryFn: () => api.getSystem(projectId, t.sys), enabled: t.type === 'sys' && !!t.sys, staleTime: 30_000 })
  const to = buildTarget(t)
  const mine = areas.filter(a => !a.removed && areaId(a))
  const toKind: ThingKind | undefined = t.type === 'ent' ? 'entity'
    : t.type === 'area' ? mine.find(a => areaId(a) === t.area)?.kind
      : t.sysArea ? targetQ.data?.areas.find(a => a.id === t.sysArea && !a.inferred)?.kind as ThingKind | undefined
        : (others.find(x => x.id === t.sys)?.kind)
  const fromKind = from === 'self' ? ctx.systemKind : mine.find(a => areaRef(a) === from)?.kind
  const problem = problemOf(kind, from, to, fromKind, toKind)
  const current = formToDraft(s, base.current, newId.current)
  const persisted = base.current && !base.current.isNew ? base.current : null
  const changedOperator = persisted && persisted.kind !== kind

  // Live mode: push each real edit into the draft (an unfinished new relation without a target is withdrawn, not half-saved).
  const pushed = useRef(relSig(initial ?? { kind: '', from: '', to: '', note: '', ev: [] }) + (initial ? '' : '|none'))
  useEffect(() => {
    if (!live) return
    const sig = relSig(current) + (to ? '' : '|none')
    if (sig === pushed.current) return
    pushed.current = sig
    if (to || base.current) live({ ...current, removed: !to })
  }) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => { if (to && !problem && onDone) onDone(current) }
  return (
    <div className={cn('space-y-2', !live && 'rounded-md border p-3')} data-testid="relation-builder">
      <div className="grid grid-cols-[1fr_1fr] items-start gap-2">
        <label className="space-y-0.5"><span className="text-[10px] text-muted-foreground">From</span>
          <select className={field} value={from} onChange={e => dispatch({ type: 'setFrom', from: e.target.value })} aria-label="relation from" data-testid="rel-from">
            <option value="self">{v.name || 'This system'} (whole system)</option>
            {mine.map(a => <option key={a.key} value={areaRef(a)}>{a.name || '(unnamed)'} · {a.kind}</option>)}
          </select></label>
        <label className="space-y-0.5"><span className="text-[10px] text-muted-foreground">Relation</span>
          <select className={field} value={kind} onChange={e => dispatch({ type: 'setOperator', kind: e.target.value })} aria-label="relation kind" data-testid="rel-kind">
            {operatorChoices(GROUPS).map(g => (
              <optgroup key={g.id} label={g.label}>{g.kinds.map(k => <option key={k} value={k}>{relLabel(k)}</option>)}</optgroup>
            ))}
          </select></label>
        <div className="col-span-2 space-y-0.5"><span className="text-[10px] text-muted-foreground">To</span>
          <div className="flex gap-1">
            <select className={cn(field, 'w-32 shrink-0')} value={t.type} onChange={e => dispatch({ type: 'setTarget', target: { type: e.target.value as TargetType } })} aria-label="target type" data-testid="rel-to-type">
              <option value="sys">another system</option><option value="area">a component here</option><option value="ent">a named entity</option>
            </select>
            {t.type === 'sys' && <select className={field} value={t.sys} onChange={e => dispatch({ type: 'setTarget', target: { sys: e.target.value } })} aria-label="relation target system" data-testid="rel-to-system"><option value="">choose a system…</option>{others.map(x => <option key={x.id} value={x.id}>{x.name} · {x.kind}</option>)}</select>}
            {t.type === 'area' && <select className={field} value={t.area} onChange={e => dispatch({ type: 'setTarget', target: { area: e.target.value } })} aria-label="relation target component" data-testid="rel-to-component"><option value="">choose…</option>{mine.map(a => <option key={a.key} value={areaId(a)}>{a.name} · {a.kind}</option>)}</select>}
            {t.type === 'ent' && <input className={field} value={t.ent} onChange={e => dispatch({ type: 'setTarget', target: { ent: e.target.value } })} placeholder="e.g. Currency" aria-label="relation target name" data-testid="rel-to-entity" />}
          </div>
          {t.type === 'sys' && t.sys && (
            <select className={field} value={t.sysArea} onChange={e => dispatch({ type: 'setTarget', target: { sysArea: e.target.value } })} aria-label="component of the other system" data-testid="rel-to-sys-area">
              <option value="">the whole system</option>
              {(targetQ.data?.areas ?? []).filter(a => !a.inferred).map(a => <option key={a.id} value={a.id}>{a.name} · {a.kind}</option>)}
            </select>
          )}
        </div>
      </div>
      <p className="text-[11px]" data-testid="rel-sentence">{to ? <><b>{ctx.label(from)}</b> {relLabel(kind)} <b>{ctx.label(to)}</b></> : <span className="text-muted-foreground">Example: {RELATION_RULES[kind]?.hint}</span>}</p>
      {changedOperator && <p className="text-[10px] text-warning" data-testid="rel-operator-changed">You changed the relation from “{relLabel(persisted!.kind)}” to “{relLabel(kind)}”. That is a different statement, not a rewording.</p>}
      {problem && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-1.5 text-[11px] text-destructive" data-testid="rel-problem">{problem} Pick another relation or another target; nothing was changed for you.</p>}
      <input className={field} value={note} onChange={e => dispatch({ type: 'setNote', note: e.target.value })} placeholder="Why / how (optional)" aria-label="relation note" />
      <details className="text-[11px]">
        <summary className="cursor-pointer text-muted-foreground">Evidence in the code ({ev.length}) — optional, makes the relation checkable</summary>
        <div className="mt-2 space-y-1.5">
          {ev.map((e, i) => <div key={i} className="flex items-center gap-1.5 font-mono"><span className="truncate">{e.path}{e.needle ? ` — “${e.needle}”` : ''}</span><button onClick={() => dispatch({ type: 'setEvidence', ev: ev.filter((_, j) => j !== i) })} aria-label="remove evidence" className="ml-auto rounded p-0.5 hover:bg-accent"><X className="h-3 w-3" /></button></div>)}
          <FilePicker projectId={projectId} value={evFile} onChange={p => setEvFile(p.slice(-1))} single onOpen={ctx.onOpen} />
          <input className={field} value={evNeedle} onChange={e => setEvNeedle(e.target.value)} placeholder="Text that must stay in that file, e.g. add_currency(" aria-label="evidence text" />
          <button disabled={!evFile[0]} onClick={() => { dispatch({ type: 'setEvidence', ev: [...ev, { path: evFile[0], ...(evNeedle.trim() ? { needle: evNeedle.trim() } : {}) }] }); setEvFile([]); setEvNeedle('') }} className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-40">Add evidence</button>
        </div>
      </details>
      {!live && (
        <div className="flex items-center gap-2">
          <button onClick={submit} disabled={!to || !!problem} data-testid="add-relation" className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-40">Done</button>
          <button onClick={onCancel} className="rounded-md border px-3 py-1 text-xs hover:bg-accent">Cancel</button>
          <span className="text-[10px] text-muted-foreground">Keeps this in the draft. Nothing is saved until Review.</span>
        </div>
      )}
    </div>
  )
}

export function RelationsStep({ ctx, rels, setRels, editKey, setEditKey }: {
  ctx: RelCtx; rels: DraftRel[]; setRels: (x: DraftRel[]) => void; editKey: string | null; setEditKey: (k: string | null) => void
}) {
  const visible = rels.filter(r => !(r.removed && r.isNew))
  const editing = editKey === 'new' ? null : rels.find(r => r.key === editKey) ?? null
  return (
    <div className="space-y-4" data-testid="step-relations">
      <p className="rounded-md bg-accent/50 p-2 text-[11px] text-muted-foreground">A relation says how two things connect, with a direction: “A <i>consumes</i> B”. It can point at a component, at another system or at a named entity.
        A function call or an import between files is not a relation; point at the code that shows the effect as evidence.</p>
      {GROUPS.map(g => {
        const rs = visible.filter(r => (RELATION_RULES[r.kind]?.group ?? 'gameplay') === g.id)
        return (
          <section key={g.id} className="space-y-1.5" data-testid={`rel-section-${g.id}`}>
            <Label hint={g.help}>{g.label} <span className="tabular-nums opacity-60">{rs.length}</span></Label>
            {!rs.length && <p className="text-[11px] text-muted-foreground">None.</p>}
            {rs.map(r => editKey === r.key ? <RelationForm key={r.key} ctx={ctx} initial={r} onCancel={() => setEditKey(null)} onDone={nr => { setRels(rels.map(x => x.key === r.key ? nr : x)); setEditKey(null) }} /> : (
              <div key={r.key} className={cn('flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs', r.removed && 'opacity-50')} data-testid="relation-edit-row">
                <span className={cn('font-medium', r.removed && 'line-through')}>{ctx.label(r.from)}</span>
                <span className="rounded bg-accent px-1.5 py-0.5 text-[10px]">{relLabel(r.kind)}</span>
                <span className={cn('font-medium', r.removed && 'line-through')}>{ctx.label(r.to)}</span>
                {r.isNew && <span className="rounded bg-warning/15 px-1.5 text-[10px] text-warning">new</span>}
                {r.note && <span className="text-[11px] text-muted-foreground">— {r.note}</span>}
                <span className="ml-auto flex items-center gap-0.5">
                  {!r.removed && <button onClick={() => setEditKey(r.key)} className="rounded px-1.5 py-0.5 text-[11px] hover:bg-accent" data-testid="edit-relation">Edit</button>}
                  <button onClick={() => (r.isNew ? setRels(rels.filter(x => x.key !== r.key)) : setRels(rels.map(x => x.key === r.key ? { ...x, removed: !x.removed } : x)))} aria-label="remove relation" className="rounded p-1 hover:bg-accent">
                    {r.removed ? <span className="text-[10px]">undo</span> : <Trash2 className="h-3 w-3" />}
                  </button>
                </span>
              </div>
            ))}
          </section>
        )
      })}
      {editKey === 'new' || (editKey && !editing) ? (
        <RelationForm ctx={ctx} initial={null} onCancel={() => setEditKey(null)} onDone={nr => { setRels([...rels, nr]); setEditKey(null) }} />
      ) : !editKey && (
        <button onClick={() => setEditKey('new')} data-testid="new-relation" className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs hover:bg-accent"><Plus className="h-3 w-3" /> Add a relation</button>
      )}
    </div>
  )
}

/** A small “open” affordance used by quick edits. */
export const OpenLink = ({ onClick }: { onClick: () => void }) => <button onClick={onClick} className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:underline"><ExternalLink className="h-2.5 w-2.5" />open</button>
