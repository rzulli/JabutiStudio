/**
 * Comparing and resolving two catalogs of the same project (the "Another catalog" warning).
 *
 * R1  equivalent catalogs (only timestamps differ) are reported as identical, never as a conflict
 * R2  compare tells identical / only-here / only-there / different (field by field) / duplicate apart
 * R3  resolve needs a choice for every conflict; a missing or invalid choice writes nothing; non-UI callers get 403
 * R4  the choices are applied (keep-active / take-other / keep-both) with nothing merged and nothing lost: the replaced
 *     version and the declined version are kept in the manifest, the previous file is backed up, the other catalog is untouched
 * R5  the decision survives a restart (caches dropped): the sibling is reported as `resolved`, not as a conflict again,
 *     and a changed sibling file brings the warning back
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const activeDir = mkdtempSync(join(tmpdir(), 'jabuti-res-active-'))
const otherDir = mkdtempSync(join(tmpdir(), 'jabuti-res-other-'))
const proj = mkdtempSync(join(tmpdir(), 'jabuti-res-proj-'))
process.env.SHIPYARD_DATA_DIR = activeDir
process.env.SHIPYARD_SIBLING_DATA_DIRS = otherDir

const UI = { host: 'localhost:5420', origin: 'http://localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }
let svc: typeof import('../src/services/systemCatalog.js')
let app: import('fastify').FastifyInstance
let P: { id: string; path: string }
const activeFile = () => join(activeDir, 'systems', `${P.id}.json`)
const otherFile = () => join(otherDir, 'systems', `${P.id}.json`)
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'))
const writeOther = (fn: (systems: any[]) => any[]) => { const j = readJson(otherFile()); j.systems = fn(j.systems); writeFileSync(otherFile(), JSON.stringify(j, null, 2)) }
const report = async () => (await app.inject({ method: 'GET', url: `/api/projects/${P.id}/systems/catalog-source` })).json() as any
const compare = async () => (await app.inject({ method: 'GET', url: `/api/projects/${P.id}/systems/catalog-source/compare?fromDir=${encodeURIComponent(otherDir)}` })).json() as any
const resolve = (body: object, headers: object = UI) => app.inject({ method: 'POST', url: `/api/projects/${P.id}/systems/catalog-source/resolve`, headers: headers as any, payload: body as any })

before(async () => {
  mkdirSync(join(proj, 'docs'), { recursive: true })
  writeFileSync(join(proj, 'project.godot'), 'config_version=5\n'); writeFileSync(join(proj, 'docs', 'C.md'), '# c\n')
  execFileSync('git', ['-C', proj, 'init', '-q'])
  const pd = await import('../src/services/projectDiscovery.js')
  P = (await pd.addProjects([proj]))[0] as any
  svc = await import('../src/services/systemCatalog.js')
  for (const name of ['Momentum', 'Character Locomotion', 'Building Traversal', 'Perk Progression'])
    await svc.propose(P.id, { name, summary: `${name} summary`, terms: [name.split(' ')[0].toLowerCase()], createOnly: true } as any, 'agent')
  mkdirSync(join(otherDir, 'systems'), { recursive: true })
  copyFileSync(activeFile(), otherFile())
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/systems.js')).systemRoutes)
})
after(async () => { await app?.close(); for (const d of [activeDir, otherDir, proj]) rmSync(d, { recursive: true, force: true }) })

test('R1 same content with different timestamps is identical, not a conflict', async () => {
  writeOther(xs => xs.map(s => ({ ...s, updatedAt: '2030-01-01T00:00:00.000Z' })))
  const r = await report()
  assert.equal(r.others[0].relation, 'identical'); assert.deepEqual(r.others[0].conflictIds, [])
  assert.equal(r.others[0].label, 'Other data directory'); assert.equal(r.active.label, 'Other data directory')
})

test('R2 compare separates identical, only-there, different (by field) and duplicate rows', async () => {
  writeOther(xs => [
    ...xs.map(s => s.id === 'sys-momentum' ? { ...s, summary: 'Momentum, other version', responsibilities: ['Keep speed'] }
      : s.id === 'sys-building-traversal' ? { ...s, anchors: { ...s.anchors, terms: ['building', 'stride'] } } : s),
    { ...xs[0], id: 'sys-new-one', name: 'Brand New', anchors: { terms: ['brandnew'], files: [], decisions: [] } },
    { ...xs[0], id: 'sys-locomotion-2', name: 'Character locomotion', anchors: { terms: ['zzz'], files: [], decisions: [] } },
  ])
  const c = await compare()
  const kind = (id: string) => c.rows.find((r: any) => r.id === id)?.kind
  assert.equal(kind('sys-character-locomotion'), 'identical'); assert.equal(kind('sys-perk-progression'), 'identical')
  assert.equal(kind('sys-momentum'), 'different'); assert.equal(kind('sys-building-traversal'), 'different')
  assert.equal(kind('sys-new-one'), 'only-there'); assert.equal(kind('sys-locomotion-2'), 'duplicate')
  const m = c.rows.find((r: any) => r.id === 'sys-momentum')
  assert.deepEqual(m.changes.map((x: any) => x.field).sort(), ['responsibilities', 'summary'])
  assert.equal(m.changes.find((x: any) => x.field === 'summary').here, 'Momentum summary')
  const r = await report(); assert.equal(r.others[0].relation, 'conflicting')
  assert.deepEqual(r.others[0].conflictIds.sort(), ['sys-building-traversal', 'sys-locomotion-2', 'sys-momentum'])
})

test('R3 every conflict needs a choice; nothing is written otherwise; only the UI may resolve', async () => {
  const c = await compare(); const before = readFileSync(activeFile(), 'utf8')
  const body = { fromDir: otherDir, expectedSourceSha256: c.other.sha256, expectedTargetSha256: c.active.sha256 }
  assert.equal((await resolve({ ...body, choices: {} }, {})).statusCode, 403)
  const none = await resolve({ ...body, choices: { 'sys-momentum': 'take-other' } })
  assert.equal(none.statusCode, 409); assert.match(none.json().error, /sys-building-traversal/)
  const bad = await resolve({ ...body, choices: { 'sys-momentum': 'merge', 'sys-building-traversal': 'keep-active', 'sys-locomotion-2': 'keep-active' } })
  assert.equal(bad.statusCode, 409)
  const dupReplace = await resolve({ ...body, choices: { 'sys-momentum': 'keep-active', 'sys-building-traversal': 'keep-active', 'sys-locomotion-2': 'take-other' } })
  assert.equal(dupReplace.statusCode, 409); assert.match(dupReplace.json().error, /no counterpart/)
  assert.equal(readFileSync(activeFile(), 'utf8'), before, 'a refused resolution leaves the active file byte-identical')
  assert.equal((await resolve({ ...body, expectedSourceSha256: 'a'.repeat(64), choices: {} })).statusCode, 409)
})

test('R4 choices are applied without merging or losing anything', async () => {
  const c = await compare(); const otherBefore = readFileSync(otherFile(), 'utf8')
  const activeBefore = readJson(activeFile()).systems
  const res = await resolve({ fromDir: otherDir, expectedSourceSha256: c.other.sha256, expectedTargetSha256: c.active.sha256,
    choices: { 'sys-momentum': 'take-other', 'sys-building-traversal': 'keep-active', 'sys-locomotion-2': 'keep-both' } })
  assert.equal(res.statusCode, 200, res.body); const out = res.json()
  assert.deepEqual(out.replaced, ['sys-momentum']); assert.deepEqual(out.added, ['sys-new-one']); assert.deepEqual(out.keptActive, ['sys-building-traversal'])
  assert.deepEqual(out.copies, ['sys-locomotion-2-other'])
  const after = readJson(activeFile()).systems as any[]
  const get = (id: string) => after.find(s => s.id === id)
  assert.equal(get('sys-momentum').summary, 'Momentum, other version')
  assert.deepEqual(get('sys-building-traversal'), activeBefore.find((s: any) => s.id === 'sys-building-traversal'), 'keep-active leaves the system untouched')
  assert.equal(get('sys-locomotion-2-other').status, 'proposed'); assert.match(get('sys-locomotion-2-other').name, /other catalog/)
  assert.ok(get('sys-new-one'))
  for (const s of activeBefore) assert.ok(get(s.id), `${s.id} still exists`)
  assert.equal(readFileSync(otherFile(), 'utf8'), otherBefore, 'the other catalog is never written')
  const manifest = readJson(out.manifest)
  assert.equal(manifest.discardedActiveVersions[0].id, 'sys-momentum'); assert.equal(manifest.discardedActiveVersions[0].summary, 'Momentum summary')
  assert.equal(manifest.declinedOtherVersions[0].id, 'sys-building-traversal')
  assert.ok(existsSync(out.backup)); assert.equal(readJson(out.backup).systems.length, activeBefore.length)
})

test('R5 the decision is on disk: after a restart the sibling is "resolved", and a changed sibling warns again', async () => {
  svc.resetCaches() // what a restart does: nothing but the files remain
  const r = await report()
  assert.equal(r.others[0].relation, 'resolved'); assert.ok(r.others[0].resolution.manifest)
  assert.equal(r.active.systems, 6)
  writeOther(xs => xs.map(s => s.id === 'sys-perk-progression' ? { ...s, summary: 'changed after the decision' } : s))
  const again = await report()
  assert.equal(again.others[0].relation, 'conflicting'); assert.deepEqual(again.others[0].conflictIds.sort(), ['sys-building-traversal', 'sys-locomotion-2', 'sys-perk-progression'])
})
