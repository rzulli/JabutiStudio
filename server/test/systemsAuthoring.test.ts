/**
 * Authoring systems by hand (R3-KNOWLEDGE-UX2): create from nothing, planned components, relation rules,
 * in-place relation edits, cross-system relations, and the guarantee that a refused edit leaves nothing half-written.
 * Fixture is a tiny repo; nothing here depends on a real game.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as sem from '../src/services/systemSemantics.js'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-auth-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-auth-proj-'))
const repo = join(parent, 'auth')
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' })
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }

type Svc = typeof import('../src/services/systemCatalog.js')
let svc: Svc
let P: any

before(async () => {
  put(repo, 'project.godot', 'config_version=5\n')
  put(repo, 'scripts/Wallet.gd', 'extends Node\nfunc add_coin(n):\n\tcoins += n\n')
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [{ id: 'auth', path: repo }] }))
  const pd = await import('../src/services/projectDiscovery.js')
  P = (await pd.addProjects([repo])).find(p => p.path === repo)
  svc = await import('../src/services/systemCatalog.js')
})
after(() => { for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true }) })

const view = async (id: string): Promise<any> => { svc.resetCaches(); return svc.resolveSystem(P, id) }

test('rules: a resource is produced or consumed, an activity is not; an entity cannot act', () => {
  assert.equal(sem.relationProblem('consumes', 'mechanic', 'entity'), null)
  assert.match(sem.relationProblem('consumes', 'mechanic', 'mechanic')!, /entity/)
  assert.match(sem.relationProblem('produces', 'entity', 'entity')!, /cannot/)
  assert.match(sem.relationProblem('controls', 'entity', 'mechanic')!, /cannot/)
  assert.equal(sem.relationProblem('depends_on', 'mechanic', 'mechanic'), null)
  assert.equal(sem.relationProblem('consumes', undefined, undefined), null, 'unknown endpoints are not blocked')
  const groups = new Set(Object.values(sem.RELATION_RULES).map(r => r.group))
  assert.deepEqual([...groups].sort(), ['gameplay', 'implementation', 'structure'])
})

test('a system is created from nothing: no files, no evidence, planned, a proposal by the user, never confirmed', async () => {
  const r = await svc.propose('auth', { name: 'Economy', kind: 'system', summary: 'Manages the currency.', planned: true, createOnly: true }, 'user')
  assert.equal(r.outcome, 'created')
  const s = await svc.getStored('auth', r.id)
  assert.equal(s!.status, 'proposed'); assert.equal(s!.origin, 'user'); assert.equal(s!.planned, true); assert.equal(s!.confirmedAt, undefined)
  const v = await view(r.id)
  assert.equal(v.planned, true); assert.equal(v.members.length, 0)
})

test('createOnly never folds a new system into an existing one that shares a term', async () => {
  const a = await svc.propose('auth', { name: 'Coin store', terms: ['coin'], createOnly: true }, 'user')
  const b = await svc.propose('auth', { name: 'Coin shop', terms: ['coin'], createOnly: true }, 'user')
  assert.equal(b.outcome, 'created'); assert.notEqual(a.id, b.id)
  const c = await svc.propose('auth', { name: 'Coin again', terms: ['coin'] }, 'agent')
  assert.equal(c.outcome, 'extended', 'without createOnly the old behaviour (extend the owner) is unchanged')
})

test('planned components keep responsibilities and need no files; they come back in the view', async () => {
  await svc.review('auth', 'sys-economy', { responsibilities: ['Earn currency', 'Spend currency'] })
  await svc.review('auth', 'sys-economy', { setArea: { id: 'earning', name: 'Earning', kind: 'mechanic', summary: 'Collect coins', planned: true, responsibilities: ['Earn currency'] } })
  await svc.review('auth', 'sys-economy', { setArea: { id: 'coin', name: 'Coin', kind: 'entity', summary: 'The currency', files: ['scripts/Wallet.gd#add_coin'] } })
  const v = await view('sys-economy')
  const earning = v.areas.find((a: any) => a.id === 'earning'); const coin = v.areas.find((a: any) => a.id === 'coin')
  assert.equal(earning.planned, true); assert.deepEqual(earning.responsibilities, ['Earn currency']); assert.equal(earning.fileCount, 0)
  assert.equal(coin.planned, false); assert.ok(coin.anchors.files.includes('scripts/Wallet.gd#add_coin'))
})

test('relations: gameplay rules are enforced, and a refused edit leaves the store untouched', async () => {
  await svc.review('auth', 'sys-economy', { setArea: { id: 'spending', name: 'Spending', kind: 'mechanic', summary: 'Buy things', planned: true } })
  await svc.review('auth', 'sys-economy', { upsertRelation: { kind: 'produces', from: 'area:earning', to: 'area:coin' } })
  const before = JSON.stringify(await svc.getStored('auth', 'sys-economy'))
  await assert.rejects(svc.review('auth', 'sys-economy', { summary: 'SHOULD NOT PERSIST', upsertRelation: { kind: 'consumes', from: 'area:spending', to: 'area:earning' } }), /entity/)
  await assert.rejects(svc.review('auth', 'sys-economy', { upsertRelation: { kind: 'produces', from: 'area:coin', to: 'area:coin' } }), /itself/)
  const after = JSON.stringify(await svc.getStored('auth', 'sys-economy'))
  assert.equal(after.replace(/"updatedAt":"[^"]*"/, ''), before.replace(/"updatedAt":"[^"]*"/, ''), 'nothing was half-applied, not even the summary')
  const ok = await svc.review('auth', 'sys-economy', { upsertRelation: { kind: 'consumes', from: 'area:spending', to: 'area:coin' } })
  assert.equal(ok!.relations!.length, 2)
})

test('an agent proposal with an invalid relation is stored without that relation', async () => {
  const r = await svc.propose('auth', { name: 'Crafting', createOnly: true, areas: [{ name: 'Recipe', kind: 'mechanic' }, { name: 'Brew', kind: 'mechanic' }],
    relations: [{ kind: 'consumes', from: 'area:brew', to: 'area:recipe' }, { kind: 'depends_on', from: 'area:brew', to: 'area:recipe' }] }, 'agent')
  const s = await svc.getStored('auth', r.id)
  assert.deepEqual(s!.relations!.map(x => x.kind), ['depends_on'])
})

test('editing a relation in place: same meaning keeps its status, a different meaning goes back to proposal; both id forms are accepted', async () => {
  const v0 = await view('sys-economy')
  const rel = v0.relations.find((r: any) => r.kind === 'produces')
  assert.ok(rel.id.startsWith('sys-economy:'), 'the view prefixes ids with their owner')
  await svc.review('auth', 'sys-economy', { confirm: { relations: [rel.id] } })
  assert.equal((await svc.getStored('auth', 'sys-economy'))!.relations!.find(r => r.kind === 'produces')!.status, 'confirmed', 'confirm accepts the view id')
  const same = await svc.review('auth', 'sys-economy', { replaceRelation: { id: rel.id, relation: { kind: 'produces', from: 'area:earning', to: 'area:coin', note: 'on pickup' } } })
  const kept = same!.relations!.find(r => r.kind === 'produces')!
  assert.equal(kept.status, 'confirmed'); assert.equal(kept.note, 'on pickup')
  const changed = await svc.review('auth', 'sys-economy', { replaceRelation: { id: kept.id, relation: { kind: 'stores', from: 'self', to: 'area:coin' } } })
  const moved = changed!.relations!.find(r => r.kind === 'stores')!
  assert.equal(moved.status, 'proposed'); assert.ok(!changed!.relations!.some(r => r.kind === 'produces'))
  await assert.rejects(svc.review('auth', 'sys-economy', { replaceRelation: { id: 'nope', relation: { kind: 'stores', from: 'self', to: 'area:coin' } } }), /no longer exists/)
})

test('relations between different systems are allowed and validated against the other system', async () => {
  const shop = await svc.propose('auth', { name: 'Shop', kind: 'system', createOnly: true }, 'user')
  await svc.review('auth', shop.id, { setArea: { id: 'checkout', name: 'Checkout', kind: 'mechanic' } })
  const ok = await svc.review('auth', shop.id, { upsertRelation: { kind: 'consumes', from: 'area:checkout', to: 'sys:sys-economy/coin' } })
  assert.equal(ok!.relations![0].to, 'sys:sys-economy/coin')
  await assert.rejects(svc.review('auth', shop.id, { upsertRelation: { kind: 'consumes', from: 'area:checkout', to: 'sys:sys-economy/earning' } }), /entity/)
  const v = await view(shop.id)
  assert.equal(v.relations[0].direction, 'outgoing')
  const eco = await view('sys-economy')
  assert.ok(eco.relations.some((r: any) => r.direction === 'incoming' && r.kind === 'consumes'), 'the target system sees it as incoming')
})

test('rewriting a confirmed component returns it to proposal; an identical save keeps it', async () => {
  await svc.review('auth', 'sys-economy', { confirm: { areas: ['coin'] } })
  const same = await svc.review('auth', 'sys-economy', { setArea: { id: 'coin', name: 'Coin', kind: 'entity', summary: 'The currency', files: ['scripts/Wallet.gd#add_coin'] } })
  assert.equal(same!.areas!.find(a => a.id === 'coin')!.status, 'confirmed')
  const edited = await svc.review('auth', 'sys-economy', { setArea: { id: 'coin', name: 'Coin', kind: 'entity', summary: 'A different description', files: ['scripts/Wallet.gd#add_coin'] } })
  assert.equal(edited!.areas!.find(a => a.id === 'coin')!.status, 'proposed')
})

test('the portable file accepts the new fields (planned, component responsibilities) and still validates', async () => {
  const { portableSchema } = await import('../src/services/systemPortable.js')
  const s = await svc.getStored('auth', 'sys-economy')
  const portable: any = JSON.parse(JSON.stringify(s)); delete portable.seen; delete portable.vanished
  const doc = { version: 1, gitRoots: ['a'.repeat(40)], systems: [portable] }
  const r = portableSchema.safeParse(doc)
  assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3)))
})
