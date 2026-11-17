/**
 * What a relation may connect. Mirrors RELATION_RULES in server/src/services/systemSemantics.ts: the server is the
 * authority and refuses invalid relations; this copy only lets the editor explain the problem before saving.
 */
export type ThingKind = 'system' | 'subsystem' | 'mechanic' | 'entity'
export type RelationGroup = 'gameplay' | 'structure' | 'implementation'

const ACTORS: ThingKind[] = ['system', 'subsystem', 'mechanic']
const ANY: ThingKind[] = ['system', 'subsystem', 'mechanic', 'entity']

export const RELATION_RULES: Record<string, { label: string; group: RelationGroup; from: ThingKind[]; to: ThingKind[]; why: string; hint: string }> = {
  produces: { label: 'produces', group: 'gameplay', from: ACTORS, to: ['entity'], why: 'Only a resource or item (an entity) is produced, not a mechanic or an activity.', hint: 'Economy produces Currency' },
  consumes: { label: 'consumes', group: 'gameplay', from: ACTORS, to: ['entity'], why: 'Only a resource or item (an entity) is consumed, not a mechanic or an activity.', hint: 'Shop consumes Currency' },
  stores: { label: 'stores', group: 'gameplay', from: ['system', 'subsystem', 'entity'], to: ['entity'], why: 'Something stores a resource or item (an entity).', hint: 'Inventory stores Items' },
  modifies: { label: 'modifies', group: 'gameplay', from: ACTORS, to: ANY, why: 'A rule, system or mechanic changes something. An entity cannot act on its own.', hint: 'Upgrade effects modify Speed' },
  controls: { label: 'controls', group: 'gameplay', from: ACTORS, to: ANY, why: 'A system or mechanic manages something. An entity cannot manage things.', hint: 'Economy controls Currency' },
  unlocks: { label: 'unlocks', group: 'gameplay', from: ANY, to: ANY, why: '', hint: 'Level 3 unlocks an upgrade' },
  depends_on: { label: 'depends on', group: 'structure', from: ANY, to: ANY, why: '', hint: 'Upgrades depend on Progression' },
  implemented_by: { label: 'is implemented by', group: 'implementation', from: ANY, to: ANY, why: '', hint: 'a mechanic is implemented by a component' },
  validated_by: { label: 'is validated by', group: 'implementation', from: ANY, to: ANY, why: '', hint: 'a rule is validated by a test system' },
}

export const GROUPS: { id: RelationGroup; label: string; help: string }[] = [
  { id: 'gameplay', label: 'Gameplay', help: 'What the player or the rules do to resources and mechanics: produces, consumes, stores, modifies, controls, unlocks.' },
  { id: 'structure', label: 'Structure', help: 'How the parts of the design depend on each other.' },
  { id: 'implementation', label: 'Implementation', help: 'What realises or checks a part. Technical, not gameplay.' },
]

export const kindsOf = (g: RelationGroup) => Object.entries(RELATION_RULES).filter(([, r]) => r.group === g).map(([k]) => k)
export const relLabel = (k: string) => RELATION_RULES[k]?.label ?? k

/** null when fine. Unknown endpoint kinds are never blocked here (the server decides). */
export function relationProblem(kind: string, from?: ThingKind, to?: ThingKind): string | null {
  const r = RELATION_RULES[kind]
  if (!r) return `Unknown relation “${kind}”.`
  if (from && !r.from.includes(from)) return `A ${from} cannot ${r.label} anything. ${r.why}`.trim()
  if (to && !r.to.includes(to)) return `“${r.label}” does not apply to a ${to}. ${r.why}`.trim()
  return null
}

/** Same rule the server uses to make a component id from its name. */
export const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
