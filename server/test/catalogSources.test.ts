/**
 * Two JabutiStudio data dirs, one project id (the real IncrementalStairs case: the installed app wrote four systems
 * to %APPDATA%, `pnpm dev:electron` reads <repo>/data and answered "No systems yet").
 *
 * C1  the active catalog is empty, the report finds the sibling catalog with its systems and says so (nothing hidden)
 * C2  the project id does not change when the first commit is created
 * C3  nothing is copied by reading: neither catalog changes while it is inspected
 * C4  import is refused for an unknown directory, a stale source hash, a stale target hash, and from a non-UI caller
 * C5  import adds the systems with ids, status and areas intact, backs up the previous file and writes a manifest
 * C6  a conflicting id (same id, different content) blocks the whole import and writes nothing
 * C7  a second import is a no-op (already identical); an unreadable active catalog is an error, never "empty"
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const activeDir = mkdtempSync(join(tmpdir(), 'jabuti-cat-active-'))
const otherDir = mkdtempSync(join(tmpdir(), 'jabuti-cat-other-'))
const proj = mkdtempSync(join(tmpdir(), 'jabuti-cat-proj-'))
process.env.SHIPYARD_DATA_DIR = activeDir
process.env.SHIPYARD_SIBLING_DATA_DIRS = otherDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe', encoding: 'utf8' })
const UI = { host: 'localhost:5420', origin: 'http://localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }
const NAMES = ['Momentum', 'Character Locomotion', 'Building Traversal', 'Perk Progression']

let svc: typeof import('../src/services/systemCatalog.js')
let app: import('fastify').FastifyInstance
let P: { id: string; path: string }
let otherFile = ''
let otherRaw = ''
const activeFile = () => join(activeDir, 'systems', `${P.id}.json`)

before(async () => {
  mkdirSync(join(proj, 'docs'), { recursive: true })
  writeFileSync(join(proj, 'project.godot'), 'config_version=5\n'); writeFileSync(join(proj, 'docs', 'C.md'), '# c\nMomentum\n')
  git(proj, 'init', '-q')
  const pd = await import('../src/services/projectDiscovery.js')
  P = (await pd.addProjects([proj]))[0] as any
  svc = await import('../src/services/systemCatalog.js')
  for (const name of NAMES) await svc.propose(P.id, { name, summary: `${name} summary`, terms: [name.split(' ')[0].toLowerCase()], files: ['docs/C.md'] } as any, 'agent')
  // The "other installation": same file name, in the sibling data dir. The active one starts empty (ENOENT).
  mkdirSync(join(otherDir, 'systems'), { recursive: true })
  otherFile = join(otherDir, 'systems', `${P.id}.json`)
  copyFileSync(activeFile(), otherFile)
  rmSync(activeFile()); svc.resetCaches()
  otherRaw = readFileSync(otherFile, 'utf8')
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/systems.js')).systemRoutes)
})
after(async () => { await app?.close(); for (const d of [activeDir, otherDir, proj]) rmSync(d, { recursive: true, force: true }) })

const report = async () => (await app.inject({ method: 'GET', url: `/api/projects/${P.id}/systems/catalog-source` })).json() as any
const doImport = (body: object, headers: object = UI) => app.inject({ method: 'POST', url: `/api/projects/${P.id}/systems/catalog-source/import`, headers: headers as any, payload: body as any })

test('C1 an empty active catalog is reported next to the catalog that has the systems', async () => {
  const c: any = await svc.catalog(P)
  assert.equal(c.systems.length, 0)
  const r = await report()
  assert.equal(r.active.exists, false); assert.equal(r.active.loaded, 0)
  assert.equal(r.source.dataDir, activeDir); assert.equal(r.source.selectedBy, 'SHIPYARD_DATA_DIR')
  assert.equal(r.identity.projectId, P.id)
  assert.equal(r.active.lastRead.ok, true)
  assert.equal(r.others.length, 1)
  assert.equal(r.others[0].systems, 4); assert.equal(r.others[0].relation, 'addable'); assert.equal(r.others[0].addableIds.length, 4)
})

test('C2 the project id is the same before and after the first commit', async () => {
  const before = P.id
  git(proj, 'commit', '--allow-empty', '-q', '-m', 'first')
  const pd = await import('../src/services/projectDiscovery.js')
  const again = (await pd.getProjects()).find((p: any) => p.id === before)
  assert.ok(again, 'project still registered under the same id')
  assert.equal((await report()).identity.projectId, before)
})

test('C3 inspecting writes nothing', async () => {
  await report(); await report()
  assert.equal(readFileSync(otherFile, 'utf8'), otherRaw)
  assert.equal(existsSync(activeFile()), false)
})

test('C4 refusals: unknown dir, stale hashes, non-UI caller', async () => {
  const r = await report(); const o = r.others[0]
  assert.equal((await doImport({ fromDir: join(tmpdir(), 'elsewhere'), expectedSourceSha256: o.sha256, expectedTargetSha256: null })).statusCode, 409)
  assert.equal((await doImport({ fromDir: o.dir, expectedSourceSha256: 'a'.repeat(64), expectedTargetSha256: null })).statusCode, 409)
  assert.equal((await doImport({ fromDir: o.dir, expectedSourceSha256: o.sha256, expectedTargetSha256: 'b'.repeat(64) })).statusCode, 409)
  assert.equal((await doImport({ fromDir: o.dir, expectedSourceSha256: o.sha256, expectedTargetSha256: null }, {})).statusCode, 403)
  assert.equal(existsSync(activeFile()), false, 'nothing written by refused imports')
})

test('C5 import keeps ids/status/areas, backs up, writes a manifest', async () => {
  // give the active side a different system so a backup exists
  await svc.propose(P.id, { name: 'Local Only', summary: 'x', terms: ['zzzlocal'], files: ['docs/C.md'] } as any, 'agent')
  const before = readFileSync(activeFile(), 'utf8')
  const o = (await report()).others[0]
  const t = (await report()).active.sha256
  const res = await doImport({ fromDir: o.dir, expectedSourceSha256: o.sha256, expectedTargetSha256: t })
  assert.equal(res.statusCode, 200, res.body)
  const out = res.json() as any
  assert.equal(out.added.length, 4)
  assert.equal(readFileSync(out.backup, 'utf8'), before)
  const manifest = JSON.parse(readFileSync(out.manifest, 'utf8'))
  assert.equal(manifest.addedIds.length, 4); assert.equal(manifest.source.dir, otherDir); assert.equal(manifest.projectId, P.id)
  const mine = JSON.parse(readFileSync(activeFile(), 'utf8')).systems, theirs = JSON.parse(otherRaw).systems
  assert.equal(mine.length, 5)
  for (const s of theirs) assert.deepEqual(mine.find((x: any) => x.id === s.id), s, 'record copied as data, unchanged')
  assert.ok(mine.filter((s: any) => theirs.some((t: any) => t.id === s.id)).every((s: any) => s.status === 'proposed'))
  assert.equal(readFileSync(otherFile, 'utf8'), otherRaw, 'the source is never modified')
})

test('C7a a second import adds nothing', async () => {
  const r = await report()
  assert.equal(r.others[0].relation, 'identical')
  const o = r.others[0]
  const res = (await doImport({ fromDir: o.dir, expectedSourceSha256: o.sha256, expectedTargetSha256: r.active.sha256 })).json() as any
  assert.deepEqual(res.added, [])
})

test('C6 a conflicting system blocks everything and writes nothing', async () => {
  const theirs = JSON.parse(otherRaw)
  theirs.systems[0].summary = 'changed on the other installation'
  theirs.systems.push({ ...JSON.parse(otherRaw).systems[1], id: 'sys-brand-new', name: 'Brand New', anchors: { terms: ['qqqunique'], files: [], decisions: [] } })
  writeFileSync(otherFile, JSON.stringify(theirs, null, 2))
  const r = await report(); const o = r.others[0]
  assert.equal(o.relation, 'conflicting'); assert.deepEqual(o.conflictIds, [theirs.systems[0].id])
  const before = readFileSync(activeFile(), 'utf8')
  const res = await doImport({ fromDir: o.dir, expectedSourceSha256: o.sha256, expectedTargetSha256: r.active.sha256 })
  assert.equal(res.statusCode, 409); assert.deepEqual((res.json() as any).conflicts, [theirs.systems[0].id])
  assert.equal(readFileSync(activeFile(), 'utf8'), before)
})

test('C7b an unreadable active catalog is an error, not an empty list', async () => {
  const keep = readFileSync(activeFile(), 'utf8')
  writeFileSync(activeFile(), '{ not json'); svc.resetCaches()
  await assert.rejects(() => svc.catalog(P), /not valid JSON/)
  const r = await app.inject({ method: 'GET', url: `/api/projects/${P.id}/systems` })
  assert.equal(r.statusCode, 500)
  const rep = await report()
  assert.equal(rep.active.lastRead.ok, false); assert.ok(rep.active.error)
  writeFileSync(activeFile(), keep); svc.resetCaches()
})
