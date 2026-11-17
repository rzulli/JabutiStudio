/**
 * Pure state of the relation editor. No React, no network: the component renders this and the tests drive it.
 *
 * Rules that keep editing safe:
 *  - The form starts from the persisted relation and `formToDraft(initForm(r))` gives that relation back unchanged.
 *  - The operator (`kind`) changes ONLY through `setOperator`. Browsing, grouping or re-rendering never touches it.
 *  - "Dirty" is always derived by comparing with the persisted relation, so reverting a field removes the pending change.
 *  - Saving is planned from that same comparison: an untouched relation produces no write at all.
 */
import { RELATION_RULES, relationProblem, type RelationGroup, type ThingKind } from './relationRules'

export interface Ev { path: string; needle?: string; note?: string }
export interface DraftRel {
  key: string; id?: string; kind: string; from: string; to: string; note: string; ev: Ev[]
  isNew: boolean; removed: boolean; pick: boolean; status: 'proposed' | 'confirmed' | 'new'
}

export type TargetType = 'sys' | 'area' | 'ent'
export interface Target { type: TargetType; sys: string; sysArea: string; area: string; ent: string }

export function parseTarget(to: string): Target {
  const t: Target = { type: 'sys', sys: '', sysArea: '', area: '', ent: '' }
  if (to.startsWith('area:')) { t.type = 'area'; t.area = to.slice(5) }
  else if (to.startsWith('ent:')) { t.type = 'ent'; t.ent = to.slice(4) }
  else if (to.startsWith('sys:')) { const [s, a] = to.slice(4).split('/'); t.sys = s; t.sysArea = a ?? '' }
  return t
}

export function buildTarget(t: Target): string {
  if (t.type === 'sys') return t.sys ? `sys:${t.sys}${t.sysArea ? `/${t.sysArea}` : ''}` : ''
  if (t.type === 'area') return t.area ? `area:${t.area}` : ''
  return t.ent.trim() ? `ent:${t.ent.trim()}` : ''
}

export interface FormState { from: string; kind: string; target: Target; note: string; ev: Ev[] }

export function initForm(r: Pick<DraftRel, 'from' | 'kind' | 'to' | 'note' | 'ev'> | null, defaultKind = 'modifies'): FormState {
  return { from: r?.from ?? 'self', kind: r?.kind ?? defaultKind, target: parseTarget(r?.to ?? ''), note: r?.note ?? '', ev: r ? r.ev.map(e => ({ ...e })) : [] }
}

export type FormAction =
  | { type: 'setOperator'; kind: string }
  | { type: 'setFrom'; from: string }
  | { type: 'setTarget'; target: Partial<Target> }
  | { type: 'setNote'; note: string }
  | { type: 'setEvidence'; ev: Ev[] }

export function formReducer(s: FormState, a: FormAction): FormState {
  switch (a.type) {
    case 'setOperator': return s.kind === a.kind ? s : { ...s, kind: a.kind }
    case 'setFrom': return { ...s, from: a.from }
    // Changing the kind of target, or the system it points at, clears only what no longer applies to the target itself.
    case 'setTarget': {
      const next = { ...s.target, ...a.target }
      if (a.target.sys !== undefined && a.target.sys !== s.target.sys && a.target.sysArea === undefined) next.sysArea = ''
      return { ...s, target: next }
    }
    case 'setNote': return { ...s, note: a.note }
    case 'setEvidence': return { ...s, ev: a.ev }
  }
}

/** The relation this form currently describes. The persisted identity (key, id, status) is carried over untouched. */
export function formToDraft(s: FormState, base: DraftRel | null, key: string): DraftRel {
  return {
    key: base?.key ?? key, id: base?.id, kind: s.kind, from: s.from, to: buildTarget(s.target), note: s.note, ev: s.ev,
    isNew: base?.isNew ?? true, removed: false, pick: base?.pick ?? false, status: base?.status ?? 'new',
  }
}

/** What identifies the meaning of a relation. Equal signatures mean "nothing to save". */
export const relSig = (r: Pick<DraftRel, 'kind' | 'from' | 'to' | 'note' | 'ev'>) => JSON.stringify([r.kind, r.from, r.to, r.note, r.ev])

export const isDirty = (persisted: DraftRel | null, current: DraftRel) => !persisted || relSig(persisted) !== relSig(current)

/** Operators offered by the picker, by what they say, so a person never has to know the internal categories. */
export function operatorChoices(groups: { id: RelationGroup; label: string }[]) {
  return groups.map(g => ({ ...g, kinds: Object.entries(RELATION_RULES).filter(([, r]) => r.group === g.id).map(([k]) => k) }))
}

/** The message that explains why a relation cannot be saved, or null. The form never changes a field to avoid it. */
export function problemOf(kind: string, from: string, to: string, fromKind?: ThingKind, toKind?: ThingKind): string | null {
  if (!to) return null
  if (from === to) return 'A relation cannot connect something to itself.'
  return relationProblem(kind, fromKind, toKind)
}

export type EditBody =
  | { upsertRelation: { kind: string; from: string; to: string; note?: string; evidence?: Ev[] } }
  | { replaceRelation: { id: string; relation: { kind: string; from: string; to: string; note?: string; evidence?: Ev[] } } }
  | { remove: { relations: string[] } }

/** The writes saving would make for the relations of one system. Nothing changed => an empty list. */
export function relationEdits(persisted: DraftRel[], drafts: DraftRel[]): EditBody[] {
  const out: EditBody[] = []
  for (const r of drafts) {
    if (r.removed) { if (!r.isNew && r.id) out.push({ remove: { relations: [r.id] } }); continue }
    const input = { kind: r.kind, from: r.from, to: r.to, note: r.note || undefined, evidence: r.ev.length ? r.ev : undefined }
    if (r.isNew) out.push({ upsertRelation: input })
    else {
      const p = persisted.find(x => x.id === r.id)
      if (p && relSig(p) !== relSig(r) && r.id) out.push({ replaceRelation: { id: r.id, relation: input } })
    }
  }
  return out
}
