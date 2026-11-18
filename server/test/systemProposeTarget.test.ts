/**
 * MCP propose_system must act on exactly the system it names (regression: a proposal for "Character Locomotion"
 * was applied to "Building Traversal" because both shared the term "traversal"). Isolated fixture: a throwaway data
 * dir and repo; no real catalog is read or written.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-target-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-target-proj-'))
const repo = join(parent, 'stairs')
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' })
const put = (rel: string, text: string) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text) }

type Svc = typeof import('../src/services/systemCatalog.js')
type Mcp = typeof import('../src/services/mcpServer.js')
let svc: Svc, mcp: Mcp, P: any

before(async () => {
  put('project.godot', 'config_version=5\n')
  put('scripts/Player.gd', 'extends CharacterBody3D\nfunc move():\n\tpass\n')
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  const pd = await import('../src/services/projectDiscovery.js')
  P = (await pd.addProjects([repo])).find(p => p.path === repo)
  svc = await import('../src/services/systemCatalog.js')
  mcp = await import('../src/services/mcpServer.js')
  // two systems that share the word "traversal", like the real case
  await svc.propose(P.id, { name: 'Character Locomotion', summary: 'How the player moves.', terms: ['locomotion', 'traversal'], createOnly: true }, 'user')
  await svc.propose(P.id, { name: 'Building Traversal', summary: 'Crossing the building.', terms: ['traversal', 'building'], responsibilities: ['Cross floors'], createOnly: true }, 'discovery')
})
after(() => { for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true }) })

const call = async (args: any) => { const r = await mcp.proposeSystem(P.id, args); return { err: !!r.isError, body: JSON.parse(r.content[0].text) } }
const stored = async (id: string) => { svc.resetCaches(); return svc.getStored(P.id, id) }

test('extend with an explicit id changes only that system, even when another shares a term', async () => {
  const before = JSON.stringify(await stored('sys-building-traversal'))
  const r = await call({ operation: 'extend', systemId: 'sys-character-locomotion', terms: ['traversal', 'stride'], responsibilities: ['Walk on stairs'], summary: 'ignored: extend keeps summaries' })
  assert.equal(r.err, false); assert.equal(r.body.id, 'sys-character-locomotion'); assert.equal(r.body.outcome, 'extended')
  assert.equal(JSON.stringify(await stored('sys-building-traversal')), before, 'Building Traversal must be byte-identical')
  const loco = (await stored('sys-character-locomotion'))!
  assert.ok(loco.anchors.terms.includes('stride')); assert.deepEqual(loco.responsibilities, ['Walk on stairs'])
  assert.equal(loco.summary, 'How the player moves.')
})

test('an unknown id is an error that writes nothing and creates nothing', async () => {
  const snap = JSON.stringify((await svc.catalog(P)).systems.map((s: any) => s.id))
  const r = await call({ operation: 'extend', systemId: 'sys-character-locomotion-typo', terms: ['traversal'] })
  assert.equal(r.err, true); assert.equal(r.body.code, 'not-found'); assert.equal(r.body.written, false)
  svc.resetCaches()
  assert.equal(JSON.stringify((await svc.catalog(P)).systems.map((s: any) => s.id)), snap)
})

test('extend/correct without an id never pick a system by name or terms', async () => {
  const before = JSON.stringify(await stored('sys-building-traversal'))
  for (const operation of ['extend', 'correct']) {
    const r = await call({ operation, name: 'Character Locomotion', terms: ['traversal'], summary: 'x' })
    assert.equal(r.err, true); assert.equal(r.body.code, 'id-required')
  }
  assert.equal(JSON.stringify(await stored('sys-building-traversal')), before)
})

test('create is its own operation: refuses an existing name, takes no id, and never folds into a term owner', async () => {
  const dup = await call({ operation: 'create', name: 'character locomotion', terms: ['x'] })
  assert.equal(dup.err, true); assert.equal(dup.body.code, 'already-exists')
  const withId = await call({ operation: 'create', name: 'Whatever', systemId: 'sys-building-traversal' })
  assert.equal(withId.body.code, 'id-not-allowed')
  const before = JSON.stringify(await stored('sys-building-traversal'))
  const made = await call({ operation: 'create', name: 'Stair Climbing', terms: ['traversal'] })
  assert.equal(made.err, false); assert.equal(made.body.outcome, 'created'); assert.equal(made.body.id, 'sys-stair-climbing')
  assert.deepEqual(made.body.similar.map((x: any) => x.id).sort(), ['sys-building-traversal', 'sys-character-locomotion'], 'similarity is reported, never acted on')
  assert.equal(JSON.stringify(await stored('sys-building-traversal')), before)
})

test('correct retires wrong content from an agent/discovery system, and refuses what a person wrote or confirmed', async () => {
  // the earlier, wrong write: terms/areas that belong to locomotion landed in Building Traversal
  await svc.agentPropose(P.id, { operation: 'extend', systemId: 'sys-building-traversal', terms: ['stride'], areas: [{ id: 'stepping', name: 'Stepping', kind: 'mechanic' }] })
  const fix = await call({ operation: 'correct', systemId: 'sys-building-traversal', summary: 'Crossing floors of a building.', remove: { terms: ['stride', 'nope'], areas: ['stepping'] } })
  assert.equal(fix.err, false); assert.equal(fix.body.outcome, 'corrected')
  const bt = (await stored('sys-building-traversal'))!
  assert.ok(!bt.anchors.terms.includes('stride')); assert.equal(bt.areas?.length ?? 0, 0); assert.equal(bt.summary, 'Crossing floors of a building.')
  assert.ok(fix.body.refused.some((x: string) => /nope/.test(x)), 'a term that was not there is reported')
  // a person's system: summary and anchors are theirs
  const person = await call({ operation: 'correct', systemId: 'sys-character-locomotion', summary: 'overwrite', remove: { terms: ['locomotion'] } })
  assert.equal(person.err, true, 'nothing an agent may change')
  assert.ok((await stored('sys-character-locomotion'))!.anchors.terms.includes('locomotion'))
  // confirmed: cannot be corrected; extend leaves a suggestion
  await svc.review(P.id, 'sys-stair-climbing', { status: 'confirmed' })
  assert.equal((await call({ operation: 'correct', systemId: 'sys-stair-climbing', summary: 'x' })).body.code, 'confirmed')
  const sug = await call({ operation: 'extend', systemId: 'sys-stair-climbing', summary: 'maybe' })
  assert.equal(sug.body.outcome, 'suggestion-recorded')
  assert.equal((await stored('sys-stair-climbing'))!.summary, '')
})

test('without operation: systemId means extend, no systemId means create', async () => {
  const r = await call({ systemId: 'sys-building-traversal', terms: ['floors'] })
  assert.equal(r.body.outcome, 'extended')
  assert.equal((await call({ name: 'Wall Running' })).body.outcome, 'created')
})
