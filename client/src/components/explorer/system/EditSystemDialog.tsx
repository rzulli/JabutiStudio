import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronRight, FileCode2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, type SystemSummary, type SystemView } from '@/lib/api'
import { cn } from '@/lib/utils'
import { relationProblem, relLabel, type ThingKind } from '@/lib/relationRules'
import { relSig, relationEdits } from '@/lib/relationForm'
import { CONFIRM_MEANING, SAVE_MEANING } from '@/lib/relationState'
import {
  ComponentEditor, IdentityStep, Label, MembersStep, RelationForm, RelationsStep, ResponsibilitiesStep, areaId, areaRef, blankArea, field, uniq,
  type AreaKind, type DraftArea, type DraftRel, type Focus, type RelCtx,
} from './EditSteps'

export { FilePicker, TermChips, type Focus } from './EditSteps'

/**
 * Editor for one system, new or existing. A draft is built (across five steps, or on one piece in quick-edit mode)
 * and NOTHING is written until Save. The Review step separates what was changed, what stays pending, and what the
 * person explicitly selects to confirm. Confirming a classification is not approving a design decision, and nothing
 * here touches Design Knowledge. A new system is created with the same calls, right before the same edits.
 */

const STEPS = [['identity', 'Identity'], ['responsibilities', 'Responsibilities'], ['members', 'Members'], ['relations', 'Relations'], ['review', 'Review']] as const
type Step = typeof STEPS[number][0]
export type EditStep = Step

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** A system that does not exist yet, so the editor can start from nothing with the same code path. */
export function blankView(p: { name?: string; kind?: SystemView['kind']; summary?: string; terms?: string[]; files?: string[]; planned?: boolean } = {}): SystemView {
  return {
    id: '', name: p.name ?? '', summary: p.summary ?? '', responsibilities: [], kind: p.kind ?? 'system', planned: !!p.planned,
    areas: [], relations: [], technical: [], comparisons: [], families: [], testGroups: [], overlaps: [],
    tierCounts: { core: 0, participant: 0, candidate: 0, test: 0, historical: 0, related: 0 }, status: 'proposed', origin: 'user',
    anchors: { terms: p.terms ?? [], files: p.files ?? [], decisions: [] }, suggestions: [],
    checkout: { root: '', isCanonical: true, uncommitted: 0, integration: '' }, members: [], weakerMembers: 0, neighbors: [],
    design: { available: false, decisions: [], conflicts: [] }, tasks: [], related: [],
    maintenance: { graph: { built: false, describesCheckout: '' }, changedMembers: [], needsReanalysis: false, vanished: [], unresolvedAnchors: [], graphAgainstCheckout: '', analysis: { state: 'not-built', label: '', describes: '' }, diagnostics: [] },
    limitations: [],
  } as SystemView
}

const toDraftArea = (a: SystemView['areas'][number]): DraftArea => ({
  key: a.id, id: a.id, name: a.name, kind: (a.kind === 'facet' ? 'subsystem' : a.kind) as AreaKind, summary: a.summary,
  files: [...(a.anchors?.files ?? [])], terms: [...(a.anchors?.terms ?? [])], resp: [...(a.responsibilities ?? [])], planned: !!a.planned,
  ev: a.evidence.map(e => ({ path: e.path, ...(e.needle ? { needle: e.needle } : {}), ...(e.note ? { note: e.note } : {}) })), evView: a.evidence,
  isNew: false, removed: false, pick: false,
})
const toDraftRel = (r: SystemView['relations'][number]): DraftRel => ({
  key: r.id, id: r.id, kind: r.kind, from: r.from.ref, to: r.to.ref, note: r.note ?? '',
  ev: r.evidence.map(e => ({ path: e.path, ...(e.needle ? { needle: e.needle } : {}), ...(e.note ? { note: e.note } : {}) })),
  isNew: false, removed: false, pick: false, status: r.status,
})
const areaSig = (a: DraftArea) => JSON.stringify([a.name.trim(), a.kind, a.summary, a.files, a.terms, a.resp, a.planned, a.ev])

export function EditSystemDialog({ v, projectId, allSystems, open, onOpenChange, onChanged, initialStep, focus, draft, onOpenFile }: {
  v: SystemView; projectId: string; allSystems: SystemSummary[]; open: boolean; onOpenChange: (b: boolean) => void
  onChanged: (createdId?: string) => void | Promise<unknown>; initialStep?: Step; focus?: Focus | null; draft?: boolean; onOpenFile?: (f: string) => void
}) {
  const orig = useMemo(() => ({
    name: v.name, kind: v.kind as string, summary: v.summary, planned: !!v.planned, responsibilities: [...v.responsibilities],
    files: [...v.anchors.files], terms: [...v.anchors.terms],
    areas: v.areas.filter(a => !a.inferred).map(toDraftArea),
    rels: v.relations.filter(r => r.direction !== 'incoming').map(toDraftRel),
  }), [v])

  const [step, setStep] = useState<Step>(initialStep ?? 'identity')
  const [name, setName] = useState(orig.name)
  const [kind, setKind] = useState<string>(orig.kind)
  const [summary, setSummary] = useState(orig.summary)
  const [planned, setPlanned] = useState(orig.planned)
  const [resp, setResp] = useState(orig.responsibilities)
  const [files, setFiles] = useState(orig.files)
  const [terms, setTerms] = useState(orig.terms)
  const [areas, setAreas] = useState<DraftArea[]>(orig.areas)
  const [rels, setRels] = useState<DraftRel[]>(orig.rels)
  const [pickSystem, setPickSystem] = useState(false)
  const [saving, setSaving] = useState(false)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [relEdit, setRelEdit] = useState<string | null>(null)
  const [alsoConfirm, setAlsoConfirm] = useState(false)

  useEffect(() => {
    if (!open) return
    setStep(initialStep ?? 'identity'); setName(orig.name); setKind(orig.kind); setSummary(orig.summary); setPlanned(orig.planned); setResp(orig.responsibilities)
    setFiles(orig.files); setTerms(orig.terms); setRels(orig.rels); setPickSystem(false); setAlsoConfirm(false); setRelEdit(null); setOpenKey(null)
    let as = orig.areas
    if (focus?.type === 'component') {
      if (focus.id === 'new') { const a = blankArea(); as = [...as, a]; setOpenKey(a.key) } else setOpenKey(focus.id)
    }
    setAreas(as)
    if (focus?.type === 'relation') setRelEdit(focus.id)
  }, [open, v.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- helpers over the draft ----
  const liveAreas = areas.filter(a => !a.removed)
  const kindOf = (ref: string): ThingKind | undefined => {
    if (ref === 'self') return kind as ThingKind
    if (ref.startsWith('area:')) return liveAreas.find(a => areaId(a) === ref.slice(5))?.kind
    if (ref.startsWith('ent:')) return 'entity'
    if (ref.startsWith('sys:')) { const [sid, aid] = ref.slice(4).split('/'); return aid ? undefined : allSystems.find(s => s.id === sid)?.kind }
    return undefined
  }
  const label = (ref: string) => {
    if (ref === 'self') return name.trim() || v.name || 'this system'
    if (ref.startsWith('area:')) return areas.find(a => areaId(a) === ref.slice(5))?.name || ref.slice(5)
    if (ref.startsWith('sys:')) { const [sid, aid] = ref.slice(4).split('/'); const n = allSystems.find(s => s.id === sid)?.name ?? sid; return aid ? `${n} · ${aid}` : n }
    if (ref.startsWith('ent:')) return ref.slice(4)
    return ref
  }
  const renameResp = (i: number, t: string) => { const old = resp[i]; setResp(resp.map((x, j) => j === i ? t : x)); setAreas(areas.map(a => a.resp.includes(old) ? { ...a, resp: a.resp.map(x => x === old ? t : x) } : a)) }
  const removeResp = (i: number) => { const old = resp[i]; setResp(resp.filter((_, j) => j !== i)); setAreas(areas.map(a => ({ ...a, resp: a.resp.filter(x => x !== old) }))) }
  const ctx: RelCtx = { v, systemKind: kind as ThingKind, areas, allSystems, projectId, label, kindOf, onOpen: onOpenFile }

  const origArea = (a: DraftArea) => orig.areas.find(x => x.id === a.id)
  const areaChanged = (a: DraftArea) => { const o = origArea(a); return !!o && areaSig(o) !== areaSig(a) }
  const origRel = (r: DraftRel) => orig.rels.find(x => x.id === r.id)
  const relChanged = (r: DraftRel) => { const o = origRel(r); return !!o && relSig(o) !== relSig(r) }
  const identityChanged = draft || name.trim() !== orig.name || kind !== orig.kind || summary !== orig.summary || planned !== orig.planned
    || !same(files, orig.files) || !same(terms, orig.terms) || !same(resp, orig.responsibilities)
  const sysConfirmed = !draft && v.status === 'confirmed'

  // ---- what changed, in plain words ----
  const changes = useMemo(() => {
    const out: { step: Step; text: string }[] = []
    if (draft) out.push({ step: 'identity', text: `Create ${kind} “${name.trim() || 'unnamed'}”` })
    else {
      if (name.trim() !== orig.name) out.push({ step: 'identity', text: `Name: “${orig.name}” → “${name.trim()}”` })
      if (kind !== orig.kind) out.push({ step: 'identity', text: `Type: ${orig.kind} → ${kind}` })
      if (summary !== orig.summary) out.push({ step: 'identity', text: 'Description rewritten' })
      if (planned !== orig.planned) out.push({ step: 'identity', text: planned ? 'Marked as planned (not built yet)' : 'No longer marked as planned' })
    }
    if (!same(resp, orig.responsibilities)) out.push({ step: 'responsibilities', text: `Responsibilities: ${resp.length} item${resp.length === 1 ? '' : 's'} (was ${orig.responsibilities.length})` })
    for (const a of areas) {
      if (a.isNew && !a.removed) out.push({ step: 'responsibilities', text: `Add ${a.kind} “${a.name || 'unnamed'}”${a.planned ? ' (planned)' : ''}` })
      else if (a.removed && !a.isNew) out.push({ step: 'responsibilities', text: `Remove ${a.kind} “${a.name}”` })
      else if (!a.removed && areaChanged(a)) out.push({ step: 'responsibilities', text: `Edit ${a.kind} “${a.name}”` })
    }
    if (!same(files, orig.files)) out.push({ step: 'members', text: `Pinned files: ${files.filter(f => !orig.files.includes(f)).length} added, ${orig.files.filter(f => !files.includes(f)).length} removed` })
    if (!same(terms, orig.terms)) out.push({ step: 'members', text: `Name terms: ${terms.filter(f => !orig.terms.includes(f)).length} added, ${orig.terms.filter(f => !terms.includes(f)).length} removed` })
    for (const r of rels) {
      const s = `${label(r.from)} ${relLabel(r.kind)} ${label(r.to)}`
      if (r.isNew && !r.removed) out.push({ step: 'relations', text: `Add relation: ${s}` })
      else if (r.removed && !r.isNew) out.push({ step: 'relations', text: `Remove relation: ${s}` })
      else if (!r.removed && relChanged(r)) out.push({ step: 'relations', text: `Edit relation: ${s}` })
    }
    return out
  }, [name, kind, summary, planned, resp, files, terms, areas, rels, orig, draft]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- blocking problems ----
  const problemList: { text: string; step: Step; areaKey?: string }[] = []
  if (!name.trim()) problemList.push({ text: 'The system needs a name.', step: 'identity' })
  liveAreas.forEach((a, i) => { if (!a.name.trim()) problemList.push({ text: `Component ${i + 1} has no name.`, step: 'responsibilities', areaKey: a.key }) })
  const ids = liveAreas.map(areaId).filter(Boolean)
  if (new Set(ids).size !== ids.length) problemList.push({ text: 'Two components have the same name.', step: 'responsibilities' })
  for (const r of rels.filter(x => !x.removed)) {
    const s = `${label(r.from)} ${relLabel(r.kind)} ${label(r.to)}`
    if (r.from.startsWith('area:') && !kindOf(r.from)) problemList.push({ text: `“${s}” starts at a component that no longer exists.`, step: 'relations' })
    else if (r.to.startsWith('area:') && !kindOf(r.to)) problemList.push({ text: `“${s}” points at a component that no longer exists.`, step: 'relations' })
    else { const p = r.from === r.to ? 'It connects something to itself.' : relationProblem(r.kind, kindOf(r.from), kindOf(r.to)); if (p) problemList.push({ text: `“${s}”: ${p}`, step: 'relations' }) }
  }
  const problems = problemList.map(p => p.text)
  const fixProblem = (p: { step: Step; areaKey?: string }) => { setStep(p.step); if (p.areaKey) setOpenKey(p.areaKey) }
  /** Planned and not yet built: there is nothing to pin, so Members is skipped (still reachable from the list). */
  const skipMembers = planned && !files.length && !terms.length
  const nextStep = (s: Step): Step => { const n = STEPS[Math.min(STEPS.findIndex(x => x[0] === s) + 1, 4)][0]; return n === 'members' && skipMembers ? 'relations' : n }

  // ---- what each item will be after saving ----
  const keepsConfirmed = (a: DraftArea) => !a.isNew && !!origArea(a) && origArea(a)!.key !== undefined && v.areas.find(x => x.id === a.id)?.status === 'confirmed' && !areaChanged(a)
  const relKeepsConfirmed = (r: DraftRel) => !r.isNew && origRel(r)?.status === 'confirmed' && !relChanged(r)

  const save = async (mode: 'proposal' | 'confirm', only?: { system?: boolean; areas?: string[]; rels?: string[] }) => {
    setSaving(true)
    try {
      let sid = v.id
      if (draft) {
        const c = await api.createSystem(projectId, { name: name.trim(), kind: kind as SystemView['kind'], createOnly: true })
        sid = c.id
      }
      const edit = (body: Parameters<typeof api.editSystem>[2]) => api.editSystem(projectId, sid, body)
      // Only write the identity when it changed (or the system is new): saving one relation must not rewrite the rest.
      if (draft || identityChanged) await edit({ name: name.trim(), kind: kind as SystemView['kind'], summary, responsibilities: resp, anchors: { terms, files }, planned })
      for (const a of areas) {
        if (a.removed) { if (!a.isNew) await edit({ remove: { areas: [a.id] } }); continue }
        if (a.isNew || areaChanged(a)) {
          await edit({ setArea: { id: areaId(a), name: a.name.trim(), kind: a.kind, summary: a.summary, files: a.files, terms: a.terms, responsibilities: a.resp, planned: a.planned, evidence: a.ev } })
        }
      }
      for (const body of relationEdits(orig.rels, rels)) await edit(body)
      let confirmed = 0
      if (mode === 'confirm') {
        const fresh = await api.getSystem(projectId, sid)
        const wantAreas = (only?.areas ?? liveAreas.filter(a => a.pick).map(areaId)).filter(id => fresh.areas.some(x => !x.inferred && x.id === id))
        const relIds = only?.rels ?? rels.filter(r => !r.removed && r.pick).map(r => `${r.from}	${r.kind}	${r.to}`)
        const wantRels = relIds.map(k => { const [f, kd, t] = k.split('	'); const x = fresh.relations.find(y => y.from.ref === f && y.to.ref === t && y.kind === kd && y.direction !== 'incoming'); return x ? x.id : '' }).filter(Boolean)
        if (wantAreas.length || wantRels.length) await edit({ confirm: { areas: wantAreas, relations: wantRels } })
        confirmed = wantAreas.length + wantRels.length
        if (only?.system ?? pickSystem) { await edit({ status: 'confirmed' }); confirmed++ }
      } else if (sysConfirmed && identityChanged) {
        await edit({ status: 'proposed' }) // the text is no longer what was accepted
      }
      // Wait for the lists to refetch before closing, so the screen never shows the old state after "saved".
      await onChanged(draft ? sid : undefined)
      toast.success(mode === 'confirm' ? `Saved. ${confirmed} item${confirmed === 1 ? '' : 's'} confirmed as your classification (recorded locally)` : draft ? 'System created as a proposal' : 'Saved as a proposal')
      onOpenChange(false)
    } catch (e: any) { toast.error(e.message || 'Could not save'); onChanged() } finally { setSaving(false) }
  }

  const stepChanged = (s: Step) => changes.some(c => c.step === s)
  const toConfirm = (pickSystem ? 1 : 0) + liveAreas.filter(a => a.pick).length + rels.filter(r => !r.removed && r.pick).length

  // ---- quick edit: one piece, same draft, same save ----
  const focused = focus ?? null
  const focusArea = focused?.type === 'component' ? areas.find(a => a.key === openKey) : undefined
  const focusRel = focused?.type === 'relation' ? (relEdit === 'new' ? null : rels.find(r => r.key === relEdit) ?? null) : null
  const focusTitle = !focused ? '' : focused.type === 'identity' ? 'Name and description' : focused.type === 'responsibility' ? 'Responsibility'
    : focused.type === 'component' ? (focused.id === 'new' ? 'New component' : `Component “${focusArea?.name ?? ''}”`) : (focused.id === 'new' ? 'New relation' : 'Relation')

  const quickBody = () => {
    if (!focused) return null
    if (focused.type === 'identity') return <IdentityStep {...{ name, setName, kind, setKind, summary, setSummary, planned, setPlanned }} />
    if (focused.type === 'responsibility') {
      const i = focused.index; const r = resp[i] ?? ''
      return (
        <div className="space-y-3" data-testid="quick-responsibility">
          <input className={field} value={r} onChange={e => renameResp(i, e.target.value)} aria-label="responsibility" data-testid="quick-resp-input" autoFocus />
          <div><Label hint="which components carry it out">Components</Label>
            {!liveAreas.length && <p className="text-[11px] text-muted-foreground">No components yet.</p>}
            {liveAreas.map(a => <label key={a.key} className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={a.resp.includes(r)} onChange={e => setAreas(areas.map(x => x.key === a.key ? { ...x, resp: e.target.checked ? [...x.resp, r] : x.resp.filter(y => y !== r) } : x))} />{a.name || 'unnamed'}</label>)}
          </div>
        </div>
      )
    }
    if (focused.type === 'component') {
      return focusArea ? <ComponentEditor a={focusArea} patch={p => setAreas(areas.map(a => a.key === focusArea.key ? { ...a, ...p } : a))} allResp={resp} projectId={projectId} onOpen={onOpenFile}
        onRemove={() => (focusArea.isNew ? onOpenChange(false) : setAreas(areas.map(a => a.key === focusArea.key ? { ...a, removed: !a.removed } : a)))} /> : null
    }
    // One stable form for the whole session of this dialog; every edit goes into the draft, the footer is the only Save.
    if (!relEdit) return null // the draft is seeded in the open effect; mount the form only once it knows which relation
    return <RelationForm key={focused.id} ctx={ctx} initial={focusRel} onCancel={() => onOpenChange(false)}
      live={nr => { setRels(cur => cur.some(x => x.key === nr.key) ? cur.map(x => x.key === nr.key ? nr : x) : [...cur, nr]); setRelEdit(nr.key) }} />
  }
  const focusConfirmTarget = () => {
    if (focused?.type === 'component' && focusArea) return { areas: [areaId(focusArea)] }
    if (focused?.type === 'relation') { const r = rels.find(x => x.key === relEdit); return r ? { rels: [`${r.from}	${r.kind}	${r.to}`] } : undefined }
    if (focused?.type === 'identity') return { system: true }
    return undefined
  }

  if (focused) {
    const target = focusConfirmTarget()
    const dirty = changes.length > 0
    const quickRel = focused.type === 'relation' ? rels.find(x => x.key === relEdit) : undefined
    const alreadyConfirmed = focused.type === 'relation' ? (!!quickRel && relKeepsConfirmed(quickRel))
      : focused.type === 'component' ? (!!focusArea && keepsConfirmed(focusArea)) : focused.type === 'identity' ? (sysConfirmed && !identityChanged) : false
    const canConfirm = !!target && !alreadyConfirmed
    const confirming = canConfirm && alsoConfirm
    const wasConfirmed = focused.type === 'relation' ? origRel(quickRel ?? ({} as DraftRel))?.status === 'confirmed' : focused.type === 'identity' ? sysConfirmed : false
    const state = alreadyConfirmed ? 'Confirmed' : wasConfirmed ? 'Confirmed, but your edit returns it to Proposed' : 'Proposed'
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[88vh] max-w-xl flex-col gap-0 overflow-hidden p-0" data-testid="quick-edit-dialog">
          <DialogHeader className="border-b px-5 py-3">
            <DialogTitle className="text-sm">{focusTitle}</DialogTitle>
            <DialogDescription className="text-[11px]">Editing one piece of “{v.name}”. Nothing is written until you press Save.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-dark">{quickBody()}</div>
          <footer className="space-y-2 border-t px-4 py-2.5">
            {problems.length > 0 && <p className="text-[11px] text-destructive" data-testid="quick-problems">Cannot save yet: {focused.type === 'relation' ? 'fix the problem shown above.' : problems[0]}</p>}
            {target && (
              <div className="space-y-1 rounded-md bg-accent/40 p-2 text-[11px]" data-testid="quick-status">
                <p>Status: <b data-testid="quick-state">{state}</b></p>
                {canConfirm && (
                  <label className="flex items-start gap-2"><input type="checkbox" checked={alsoConfirm} onChange={e => setAlsoConfirm(e.target.checked)} className="mt-0.5" data-testid="quick-also-confirm" />
                    <span>Also confirm it. {CONFIRM_MEANING} Editing it again returns it to proposed.</span></label>
                )}
                {!canConfirm && alreadyConfirmed && <p className="text-muted-foreground">Already confirmed and unchanged.</p>}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button onClick={() => onOpenChange(false)} className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent" data-testid="quick-cancel">Cancel</button>
              <span className="ml-auto text-[11px] text-muted-foreground" data-testid="quick-dirty">{dirty ? `${changes.length} unsaved change${changes.length > 1 ? 's' : ''}` : 'No changes'}</span>
              <button disabled={saving || problems.length > 0 || (!dirty && !confirming)} onClick={() => save(confirming ? 'confirm' : 'proposal', confirming ? target : undefined)} data-testid="quick-save" className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40">
                {confirming ? 'Save and confirm' : 'Save'}
              </button>
            </div>
          </footer>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(700px,90vh)] max-w-3xl flex-col gap-0 overflow-hidden p-0" data-testid="edit-system-dialog">
        <DialogHeader className="border-b px-5 py-3">
          <DialogTitle className="text-sm">{draft ? 'New system' : <>Edit “{v.name}”</>}</DialogTitle>
          <DialogDescription className="text-[11px]">Nothing is saved until you save from the Review step. Editing text is not approving a design decision.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <nav className="w-40 shrink-0 space-y-0.5 border-r bg-card/40 p-2" aria-label="Edit steps" data-testid="edit-steps">
            {STEPS.map(([id, lbl], i) => (
              <button key={id} onClick={() => setStep(id)} data-testid={`edit-step-${id}`} aria-current={step === id}
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60', step === id && 'bg-accent font-medium')}>
                <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px]', stepChanged(id) && 'border-warning bg-warning/20')}>{i + 1}</span>
                {lbl}
                {id === 'members' && skipMembers && <span className="text-[10px] font-normal text-muted-foreground">optional</span>}
                {id === 'review' && changes.length > 0 && <span className="ml-auto rounded bg-warning/20 px-1 text-[10px] text-warning">{changes.length}</span>}
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto p-4 scrollbar-dark">
            {step === 'identity' && <IdentityStep {...{ name, setName, kind, setKind, summary, setSummary, planned, setPlanned }} />}
            {step === 'responsibilities' && <ResponsibilitiesStep {...{ resp, setResp, renameResp, removeResp, areas, setAreas, projectId, openKey, setOpenKey }} onOpen={onOpenFile} />}
            {step === 'members' && (
              <>
                {draft && <p className="mb-3 rounded-md bg-accent/50 p-2 text-[11px] text-muted-foreground">Candidates by name or by code appear after the first save, once the system exists. You can pin files now.</p>}
                <MembersStep v={v} projectId={projectId} files={files} setFiles={setFiles} terms={terms} setTerms={setTerms} areas={areas} onOpen={onOpenFile} />
              </>
            )}
            {step === 'relations' && <RelationsStep ctx={ctx} rels={rels} setRels={setRels} editKey={relEdit} setEditKey={setRelEdit} />}
            {step === 'review' && (
              <ReviewStep {...{ v, draft: !!draft, name, kind, summary, planned, resp, changes, problems: problemList, fixProblem, areas, setAreas, rels, setRels, pickSystem, setPickSystem, sysConfirmed, identityChanged, label, goTo: setStep }}
                keepsConfirmed={keepsConfirmed} relKeepsConfirmed={relKeepsConfirmed} areaChanged={areaChanged} relChanged={relChanged} />
            )}
          </div>
        </div>
        <footer className="flex items-center gap-2 border-t px-4 py-2.5">
          <button onClick={() => onOpenChange(false)} className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent">Cancel</button>
          {problemList.length > 0 && step !== 'review' && (
            <button onClick={() => fixProblem(problemList[0])} className="ml-auto truncate text-[11px] text-destructive hover:underline" data-testid="edit-problem-hint">{problemList[0].text} Fix</button>
          )}
          <span className={cn('text-[11px] text-muted-foreground', !(problemList.length > 0 && step !== 'review') && 'ml-auto')}>{changes.length ? `${changes.length} change${changes.length > 1 ? 's' : ''} pending` : 'No changes yet'}</span>
          {step !== 'review' ? (
            <button onClick={() => setStep(nextStep(step))} className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground" data-testid="edit-next">Next <ChevronRight className="h-3 w-3" /></button>
          ) : (
            <>
              <button disabled={saving || problems.length > 0 || (!draft && !changes.length)} onClick={() => save('proposal')} data-testid="edit-save-proposal" className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-40">{draft ? 'Create system' : 'Save changes'}</button>
              <button disabled={saving || problems.length > 0 || toConfirm === 0} onClick={() => save('confirm')} data-testid="edit-save-confirm" className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40">
                Save &amp; confirm selected ({toConfirm})
              </button>
            </>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}

// ---- 5. review ------------------------------------------------------------------------------------

function ReviewStep({ v, draft, name, kind, summary, planned, resp, changes, problems, fixProblem, areas, setAreas, rels, setRels, pickSystem, setPickSystem, sysConfirmed, identityChanged, label, goTo, keepsConfirmed, relKeepsConfirmed, areaChanged, relChanged }: {
  v: SystemView; draft: boolean; name: string; kind: string; summary: string; planned: boolean; resp: string[]
  changes: { step: Step; text: string }[]; problems: { text: string; step: Step; areaKey?: string }[]; fixProblem: (p: { step: Step; areaKey?: string }) => void
  areas: DraftArea[]; setAreas: (x: DraftArea[]) => void; rels: DraftRel[]; setRels: (x: DraftRel[]) => void
  pickSystem: boolean; setPickSystem: (b: boolean) => void; sysConfirmed: boolean; identityChanged: boolean
  label: (r: string) => string; goTo: (s: Step) => void
  keepsConfirmed: (a: DraftArea) => boolean; relKeepsConfirmed: (r: DraftRel) => boolean; areaChanged: (a: DraftArea) => boolean; relChanged: (r: DraftRel) => boolean
}) {
  const liveAreas = areas.filter(a => !a.removed)
  const liveRels = rels.filter(r => !r.removed)
  const selectableAreas = liveAreas.filter(a => !keepsConfirmed(a))
  const selectableRels = liveRels.filter(r => !relKeepsConfirmed(r))
  const alreadyAreas = liveAreas.filter(keepsConfirmed)
  const alreadyRels = liveRels.filter(relKeepsConfirmed)
  // proposals nobody has touched in this edit: they stay proposals
  const pendingAreas = liveAreas.filter(a => !a.isNew && !areaChanged(a) && v.areas.find(x => x.id === a.id)?.status === 'proposed')
  const pendingRels = liveRels.filter(r => !r.isNew && !relChanged(r) && r.status === 'proposed')
  const pendingSuggestions = v.suggestions.length
  const statusOfArea = (a: DraftArea) => a.pick || keepsConfirmed(a) ? 'confirmed' : 'proposal'
  const statusOfRel = (r: DraftRel) => r.pick || relKeepsConfirmed(r) ? 'confirmed' : 'proposal'
  const Tag = ({ s }: { s: string }) => <span className={cn('rounded px-1.5 text-[10px]', s === 'confirmed' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning')}>{s}</span>
  return (
    <div className="space-y-4" data-testid="step-review">
      {problems.length > 0 && <ul className="space-y-0.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive" data-testid="review-problems">{problems.map(p => <li key={p.text} className="flex items-center gap-2">• {p.text}<button onClick={() => fixProblem(p)} className="ml-auto underline" data-testid="review-fix">Fix</button></li>)}</ul>}

      <section className="space-y-1" data-testid="review-changes">
        <Label hint="what saving will write">1 · Changes you made</Label>
        {!changes.length && <p className="text-[11px] text-muted-foreground">No changes.</p>}
        {changes.map((c, i) => (
          <div key={i} className="flex items-center gap-2 text-xs" data-testid="review-change">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />{c.text}
            <button onClick={() => goTo(c.step)} className="ml-auto text-[10px] text-muted-foreground hover:underline">edit</button>
          </div>
        ))}
      </section>

      <section className="space-y-1 rounded-md border border-dashed p-3" data-testid="review-pending">
        <Label hint="not touched by this edit: they stay proposals">2 · Proposals still pending</Label>
        {!pendingAreas.length && !pendingRels.length && !pendingSuggestions && <p className="text-[11px] text-muted-foreground">None.</p>}
        {pendingAreas.map(a => <p key={a.key} className="text-xs">Component <b>{a.name}</b> <span className="text-muted-foreground">({a.kind}) · proposed by {v.areas.find(x => x.id === a.id)?.origin}</span></p>)}
        {pendingRels.map(r => <p key={r.key} className="text-xs">Relation <b>{label(r.from)} {relLabel(r.kind)} {label(r.to)}</b></p>)}
        {pendingSuggestions > 0 && <p className="text-xs">{pendingSuggestions} agent suggestion{pendingSuggestions > 1 ? 's' : ''} waiting in Overview</p>}
      </section>

      <section className="space-y-1.5 rounded-md border p-3" data-testid="review-confirm">
        <Label hint="nothing is selected for you; tick what you accept as your classification">3 · Select what to confirm</Label>
        {(sysConfirmed && !identityChanged) ? <p className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /><b>{v.name}</b> as a system: already confirmed, unchanged.</p> : (
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={pickSystem} onChange={e => setPickSystem(e.target.checked)} className="mt-0.5" data-testid="confirm-system" />
            <span><b>{name.trim() || 'This system'}</b> as a system — its name, type, description and members.
              {sysConfirmed && identityChanged && <span className="block text-[10px] text-warning">It was confirmed, and you changed it. Without ticking this it goes back to proposal.</span>}</span></label>
        )}
        {selectableAreas.map(a => (
          <label key={a.key} className="flex items-start gap-2 text-xs"><input type="checkbox" checked={a.pick} onChange={e => setAreas(areas.map(x => x.key === a.key ? { ...x, pick: e.target.checked } : x))} className="mt-0.5" data-testid="confirm-area" />
            <span>Component <b>{a.name || 'unnamed'}</b> <span className="text-muted-foreground">({a.kind}){a.isNew ? ' · new' : areaChanged(a) ? ' · edited' : ''}</span></span></label>
        ))}
        {selectableRels.map(r => (
          <label key={r.key} className="flex items-start gap-2 text-xs"><input type="checkbox" checked={r.pick} onChange={e => setRels(rels.map(x => x.key === r.key ? { ...x, pick: e.target.checked } : x))} className="mt-0.5" data-testid="confirm-relation" />
            <span>Relation <b>{label(r.from)} {relLabel(r.kind)} {label(r.to)}</b><span className="text-muted-foreground">{r.isNew ? ' · new' : relChanged(r) ? ' · edited' : ''}</span></span></label>
        ))}
        {(alreadyAreas.length > 0 || alreadyRels.length > 0) && (
          <p className="text-[11px] text-muted-foreground"><Check className="mr-1 inline h-3 w-3" />Already confirmed and unchanged: {[...alreadyAreas.map(a => a.name), ...alreadyRels.map(r => `${label(r.from)} ${relLabel(r.kind)} ${label(r.to)}`)].join('; ')}</p>
        )}
        <p className="text-[10px] text-muted-foreground">“Save changes” ignores these ticks: {SAVE_MEANING} {CONFIRM_MEANING}</p>
      </section>

      <section className="space-y-1.5 rounded-md border bg-card/40 p-3" data-testid="review-preview">
        <Label hint="what the system will look like after saving">Result</Label>
        <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{name.trim() || 'Unnamed'}</span><span className="rounded bg-accent px-1.5 text-[10px]">{kind}</span>{planned && <span className="rounded border border-dashed px-1.5 text-[10px] text-muted-foreground">planned</span>}<Tag s={pickSystem || (sysConfirmed && !identityChanged) ? 'confirmed' : 'proposal'} /></div>
        <p className="text-xs">{summary || <span className="text-muted-foreground">No description.</span>}</p>
        {resp.length > 0 && <ul className="list-disc pl-5 text-xs">{resp.map(r => <li key={r}>{r}<span className="text-muted-foreground"> {liveAreas.filter(a => a.resp.includes(r)).map(a => `· ${a.name}`).join(' ')}</span></li>)}</ul>}
        {liveAreas.map(a => <p key={a.key} className="flex items-center gap-1.5 text-xs"><span className="font-medium">{a.name || 'unnamed'}</span><span className="rounded bg-accent px-1.5 text-[10px]">{a.kind}</span>{a.planned && <span className="text-[10px] text-muted-foreground">planned</span>}<span className="text-[10px] text-muted-foreground">{a.files.length} files</span><Tag s={statusOfArea(a)} /></p>)}
        {liveRels.map(r => <p key={r.key} className="flex items-center gap-1.5 text-xs">{label(r.from)} <i className="text-muted-foreground">{relLabel(r.kind)}</i> {label(r.to)}<Tag s={statusOfRel(r)} /></p>)}
        <p className="text-[10px] text-muted-foreground"><FileCode2 className="mr-1 inline h-3 w-3" />Statuses assume “Save &amp; confirm selected”. Agent proposals, code evidence and Design Knowledge decisions stay where they are; this editor never changes them.{draft && ' Nothing exists yet: saving creates the system as a proposal.'}</p>
      </section>
    </div>
  )
}

export { uniq, areaRef }
