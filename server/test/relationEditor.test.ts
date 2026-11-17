/**
 * Relation editor regression (PDI / Perk Progression modifies Momentum).
 * The editor state lives in client/src/lib/relationForm.ts (pure); persistence is the real catalog service.
 * Root cause covered: the old form kept a separate "group" tab and, on switching tabs, re-picked the first operator of
 * the group (modifies -> produces, which cannot target a system). Now the operator changes only through setOperator.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { formReducer, formToDraft, initForm, isDirty, problemOf, relationEdits, operatorChoices, type DraftRel, type FormAction, type FormState } from '../../client/src/lib/relationForm.js'
import { GROUPS, RELATION_RULES } from '../../client/src/lib/relationRules.js'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-rel-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-rel-proj-'))
const repo = join(parent, 'rel')
process.env.SHIPYARD_DATA_DIR = dataDir
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' })
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }

type Svc = typeof import('../src/services/systemCatalog.js')
let svc: Svc; let P: any
const NOTE = 'Design intent: perks change how speed is conserved on stairs.'
const FROM = 'area:perk-progression'; let TO = ''

before(async () => {
  put(repo, 'project.godot', 'config_version=5\n')
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [{ id: 'rel', path: repo }] }))
  const pd = await import('../src/services/projectDiscovery.js')
  P = (await pd.addProjects([repo])).find(p => p.path === repo)
  svc = await import('../src/services/systemCatalog.js')
  const mom = await svc.propose('rel', { name: 'Momentum', kind: 'system', createOnly: true }, 'user')
  TO = 'sys:' + mom.id
  const pdi = await svc.propose('rel', { name: 'PDI', kind: 'system', createOnly: true, areas: [{ name: 'Perk Progression', kind: 'mechanic' }] }, 'user')
  PDI = pdi.id
  await svc.review('rel', PDI, { upsertRelation: { kind: 'modifies', from: FROM, to: TO, note: NOTE } })
})
after(() => { for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true }) })

const view = async (id: string): Promise<any> => { svc.resetCaches(); return svc.resolveSystem(P, id) }
let PDI = ''
const persistedRel = async (): Promise<DraftRel> => {
  const v = await view(PDI); const r = v.relations.find((x: any) => x.direction !== 'incoming')
  return { key: r.id, id: r.id, kind: r.kind, from: r.from.ref, to: r.to.ref, note: r.note ?? '', ev: r.evidence.map((e: any) => ({ path: e.path })), isNew: false, removed: false, pick: false, status: r.status }
}
const run = (s: FormState, ...as: FormAction[]) => as.reduce(formReducer, s)
/** Every way the old UI let a person "browse" without editing: it must leave the relation exactly as stored. */
const browse = (): FormAction[] => [
  { type: 'setTarget', target: { type: 'sys' } }, { type: 'setFrom', from: FROM }, { type: 'setNote', note: NOTE },
  { type: 'setTarget', target: { sys: TO.slice(4) } }, { type: 'setEvidence', ev: [] },
]

test('1. browsing the form (the old Gameplay/Structure/Implementation tabs) never changes the stored relation, never marks it dirty, never writes', async () => {
  const p = await persistedRel()
  assert.deepEqual([p.kind, p.from, p.to, p.note], ['modifies', FROM, TO, NOTE])
  const s0 = initForm(p)
  const s1 = run(s0, ...browse())
  const d = formToDraft(s1, p, 'x')
  assert.equal(d.kind, 'modifies'); assert.equal(d.to, TO); assert.equal(d.note, NOTE); assert.equal(d.from, FROM)
  assert.equal(isDirty(p, d), false, 'no phantom pending change')
  assert.deepEqual(relationEdits([p], [d]), [], 'no write is planned')
  // The three groups are only labels in the operator picker; every operator of every group is offered at once.
  const choices = operatorChoices(GROUPS)
  assert.deepEqual(choices.map(c => c.id), ['gameplay', 'structure', 'implementation'])
  assert.ok(choices.find(c => c.id === 'gameplay')!.kinds.includes('modifies'))
  // And nothing was written in the catalog.
  assert.equal((await persistedRel()).kind, 'modifies')
})

test('1b. the actual defect: selecting then coming back used to land on the first operator of the group (produces)', () => {
  const first = Object.entries(RELATION_RULES).find(([, r]) => r.group === 'gameplay')![0]
  assert.equal(first, 'produces', 'this is what the old pickGroup chose after a round trip')
  assert.match(problemOf('produces', FROM, TO, 'mechanic', 'system')!, /entity/, 'and produces cannot target a system')
  const s = initForm({ from: FROM, kind: 'modifies', to: TO, note: NOTE, ev: [] })
  assert.equal(run(s, { type: 'setTarget', target: { type: 'sys' } }).kind, 'modifies')
})

test('2. an explicit edit is saved and reopens exactly as requested', async () => {
  const p = await persistedRel()
  const s = run(initForm(p), { type: 'setOperator', kind: 'controls' }, { type: 'setNote', note: 'Now the perks control it.' })
  const d = formToDraft(s, p, 'x')
  assert.equal(isDirty(p, d), true)
  const edits = relationEdits([p], [d]); assert.equal(edits.length, 1)
  for (const e of edits) await svc.review('rel', PDI, e as any)
  const after = await persistedRel()
  assert.deepEqual([after.kind, after.from, after.to, after.note], ['controls', FROM, TO, 'Now the perks control it.'])
  assert.equal(after.status, 'proposed', 'a changed meaning is a proposal again')
  // put it back so later tests start from the documented relation
  await svc.review('rel', PDI, { replaceRelation: { id: after.id!, relation: { kind: 'modifies', from: FROM, to: TO, note: NOTE } } })
})

test('3. cancelling persists nothing: the draft is discarded and the stored relation is untouched', async () => {
  const p = await persistedRel()
  const edited = formToDraft(run(initForm(p), { type: 'setOperator', kind: 'unlocks' }, { type: 'setNote', note: 'scratch' }), p, 'x')
  assert.equal(isDirty(p, edited), true)
  // Cancel = never calling relationEdits/review. Reopening reads from the catalog again:
  const reopened = await persistedRel()
  assert.deepEqual([reopened.kind, reopened.note], ['modifies', NOTE])
  assert.equal(isDirty(p, formToDraft(initForm(reopened), reopened, 'x')), false)
  // Reverting by hand also clears the pending state (it is derived, not remembered).
  const back = formToDraft(run(initForm(p), { type: 'setOperator', kind: 'unlocks' }, { type: 'setOperator', kind: 'modifies' }), p, 'x')
  assert.equal(isDirty(p, back), false)
})

test('4. an invalid operator is explained, blocks saving, and changes no other field', async () => {
  const p = await persistedRel()
  const s = run(initForm(p), { type: 'setOperator', kind: 'produces' })
  assert.equal(s.target.sys, TO.slice(4)); assert.equal(s.note, NOTE); assert.equal(s.from, FROM)
  const msg = problemOf(s.kind, s.from, formToDraft(s, p, 'x').to, 'mechanic', 'system')
  assert.match(msg!, /“produces” does not apply to a system/); assert.match(msg!, /entity/)
  // The server refuses it too, and the stored relation is not altered by the refusal.
  const d = formToDraft(s, p, 'x')
  await assert.rejects(svc.review('rel', PDI, relationEdits([p], [d])[0] as any), /entity/)
  const still = await persistedRel()
  assert.deepEqual([still.kind, still.to, still.note], ['modifies', TO, NOTE])
})

test('5. saving a proposal and confirming are different operations; a plain save never confirms', async () => {
  const p = await persistedRel()
  assert.equal(p.status, 'proposed')
  // Edit + plain save (what "Save" does): stays a proposal.
  const d = formToDraft(run(initForm(p), { type: 'setNote', note: NOTE + ' (v2)' }), p, 'x')
  for (const e of relationEdits([p], [d])) await svc.review('rel', PDI, e as any)
  let cur = await persistedRel(); assert.equal(cur.status, 'proposed')
  // Explicit confirmation is a separate call carrying the relation id.
  await svc.review('rel', PDI, { confirm: { relations: [cur.id!] } })
  cur = await persistedRel(); assert.equal(cur.status, 'confirmed')
  // Re-saving the identical relation keeps it confirmed and plans no write at all.
  assert.deepEqual(relationEdits([cur], [formToDraft(initForm(cur), cur, 'x')]), [])
  // A changed meaning returns it to proposed: it can never stay confirmed by accident.
  const changed = formToDraft(run(initForm(cur), { type: 'setOperator', kind: 'controls' }), cur, 'x')
  for (const e of relationEdits([cur], [changed])) await svc.review('rel', PDI, e as any)
  assert.equal((await persistedRel()).status, 'proposed')
})
