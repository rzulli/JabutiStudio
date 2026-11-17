/**
 * Knowledge in a repository with NO commits (the real IncrementalStairs bootstrap: `git init`, a Godot project,
 * a design doc, four systems proposed through MCP, no HEAD).
 *
 * U1  unborn + existing catalog: the catalog and reconcile answer, nothing is called "Revision not found"
 * U2  unborn + empty catalog: empty is empty (and says it is unborn)
 * U3  unborn: publishing is refused with the reason and the way out, never a generic error; update/import do not throw
 * U4  explicit revision that does not exist is still an error (only the default HEAD is tolerated)
 * U5  first commit: empty root commit, files stay untracked, the catalog is untouched, publishing becomes possible
 * U6  first commit refuses when files are staged or when the repository already has commits
 * U7  read errors are errors: a corrupt catalog rejects, an unreadable checkout is reported in loadErrors, not an empty list
 * U8  the first-commit route is UI-only
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-unborn-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-unborn-proj-'))
const unborn = join(parent, 'IncrementalStairs'), empty = join(parent, 'Blank'), staged = join(parent, 'Staged')
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe', encoding: 'utf8' })
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
const UI = { host: 'localhost:5420', origin: 'http://localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }

let svc: typeof import('../src/services/systemCatalog.js')
let know: typeof import('../src/services/systemKnowledge.js')
let app: import('fastify').FastifyInstance
let P: { id: string; path: string }, B: { id: string; path: string }, S: { id: string; path: string }

before(async () => {
  put(unborn, 'project.godot', 'config_version=5\n')
  put(unborn, 'docs/design/CONCEPT.md', '# Concept\nMomentum builds up on stairs.\n')
  git(unborn, 'init', '-q')
  put(empty, 'project.godot', 'config_version=5\n'); git(empty, 'init', '-q')
  put(staged, 'project.godot', 'config_version=5\n'); git(staged, 'init', '-q'); git(staged, 'add', 'project.godot')

  const pd = await import('../src/services/projectDiscovery.js')
  const projects = await pd.addProjects([unborn, empty, staged])
  const byName = (n: string) => projects.find((p: any) => p.path.endsWith(n))! as any
  P = byName('IncrementalStairs'); B = byName('Blank'); S = byName('Staged')
  svc = await import('../src/services/systemCatalog.js')
  know = await import('../src/services/systemKnowledge.js')
  for (const name of ['Momentum', 'Character Locomotion', 'Building Traversal', 'Perk Progression']) {
    await svc.propose(P.id, { name, summary: `${name} summary`, terms: [name.split(' ')[0].toLowerCase()], files: ['docs/design/CONCEPT.md'] } as any, 'agent')
  }
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/systems.js')).systemRoutes)
})
after(async () => { await app?.close(); rmSync(dataDir, { recursive: true, force: true }); rmSync(parent, { recursive: true, force: true }) })

const catalogFile = () => join(dataDir, 'systems', `${P.id}.json`)

test('U1 unborn repo with a registered catalog: the systems and reconcile are available', async () => {
  const before = readFileSync(catalogFile(), 'utf8')
  const c: any = await svc.catalog(P)
  assert.equal(c.systems.length, 4, 'all four systems listed')
  assert.deepEqual(c.loadErrors, [])
  assert.equal(c.checkout.unborn, true)
  assert.equal(c.checkout.integration, 'no commits yet')
  assert.equal(c.checkout.branch, git(unborn, 'symbolic-ref', '--short', 'HEAD').trim())

  const r: any = await know.reconcile(P)
  assert.equal(r.error, undefined, JSON.stringify(r))
  assert.equal(r.revision.unborn, true); assert.equal(r.revision.commit, null)
  assert.equal(r.checkout.unborn, true); assert.equal(r.checkout.head, undefined)
  assert.equal(r.systems.length, 4)
  assert.ok(r.systems.every((s: any) => s.state === 'unpublished-proposal' && s.published === null))
  assert.equal(r.file.state, 'absent')
  assert.ok(r.limitations.some((l: string) => /no commits yet/.test(l)))

  const route = await app.inject({ method: 'GET', url: `/api/projects/${P.id}/systems/knowledge` })
  assert.equal(route.statusCode, 200)
  assert.equal(readFileSync(catalogFile(), 'utf8'), before, 'reading never writes the catalog')
  assert.ok(!existsSync(join(unborn, 'jabutistudio.systems.json')))
})

test('U2 unborn repo with an empty catalog is empty, and says it is unborn', async () => {
  const c: any = await svc.catalog(B)
  assert.deepEqual(c.systems, []); assert.equal(c.checkout.unborn, true)
  const r: any = await know.reconcile(B)
  assert.equal(r.error, undefined); assert.deepEqual(r.systems, []); assert.equal(r.revision.unborn, true)
})

test('U3 publishing is refused with a reason and a way out; update and import do not throw', async () => {
  const ex: any = await know.previewExport(P)
  assert.equal(ex.canExport, false); assert.equal(ex.needsFirstCommit, true)
  assert.match(ex.reason, /no commits yet/)
  assert.deepEqual(await know.previewUpdate(P), { exists: false })
  assert.deepEqual(await know.previewImport(P), { exists: false })
  await assert.rejects(() => svc.exportPortable(P), /no commits yet/)
  // a file that was written elsewhere cannot be judged yet, but it is not "broken"
  put(unborn, 'jabutistudio.systems.json', JSON.stringify({ version: 1, gitRoots: ['0'.repeat(40)], systems: [] }))
  try {
    const r: any = await know.reconcile(P)
    assert.equal(r.file.state, 'untracked'); assert.match(r.file.reason, /no commits yet/)
  } finally { rmSync(join(unborn, 'jabutistudio.systems.json'), { force: true }) }
})

test('U4 an explicit revision that does not exist is still an error', async () => {
  const r: any = await know.reconcile(P, { revision: 'HEAD' })
  assert.match(r.error, /Revision not found: HEAD/)
  const route = await app.inject({ method: 'GET', url: `/api/projects/${P.id}/systems/knowledge?revision=nope` })
  assert.equal(route.statusCode, 400)
})

test('U6 first commit refuses when files are staged', async () => {
  await assert.rejects(() => know.createFirstCommit(S), /already staged/)
  assert.equal(await svc.isUnborn(S.path), true, 'nothing was committed')
})

test('U8 the first-commit route is UI-only', async () => {
  const denied = await app.inject({ method: 'POST', url: `/api/projects/${B.id}/systems/knowledge/first-commit` })
  assert.equal(denied.statusCode, 403)
  assert.equal(await svc.isUnborn(B.path), true)
})

test('U5 first commit: empty root, files untouched, catalog untouched, publishing unlocked', async () => {
  const catalogBefore = readFileSync(catalogFile(), 'utf8')
  const statusBefore = git(unborn, 'status', '--porcelain')
  const res = await app.inject({ method: 'POST', url: `/api/projects/${P.id}/systems/knowledge/first-commit`, headers: UI })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(git(unborn, 'rev-list', '--count', 'HEAD').trim(), '1')
  assert.equal(git(unborn, 'show', '--stat', '--format=%s', 'HEAD').trim(), 'Initial commit (empty): root of the project history')
  assert.equal(git(unborn, 'ls-tree', '-r', 'HEAD').trim(), '', 'the commit contains no files')
  assert.equal(git(unborn, 'status', '--porcelain'), statusBefore, 'working tree and index unchanged')
  assert.equal(readFileSync(catalogFile(), 'utf8'), catalogBefore)

  const r: any = await know.reconcile(P)
  assert.equal(r.revision.unborn, false); assert.ok(r.revision.commit)
  assert.equal(r.systems.length, 4)
  const ex: any = await know.previewExport(P)
  assert.equal(ex.canExport, true, JSON.stringify(ex))

  // U6b: a second attempt is refused and changes nothing
  const again = await app.inject({ method: 'POST', url: `/api/projects/${P.id}/systems/knowledge/first-commit`, headers: UI })
  assert.equal(again.statusCode, 409); assert.match(again.json().error, /already has commits/)
  assert.equal(git(unborn, 'rev-list', '--count', 'HEAD').trim(), '1')

  // and the published flow works end to end afterwards
  await svc.exportPortable(P)
  assert.ok(existsSync(join(unborn, 'jabutistudio.systems.json')))
})

test('U7 a read error is an error, never an empty list', async () => {
  // checkout that cannot be examined: every system is reported, none silently dropped
  const c: any = await svc.catalog(P, join(parent, 'not-a-worktree'))
  assert.equal(c.systems.length, 0)
  assert.equal(c.loadErrors.length, 4)
  assert.match(c.loadErrors[0].error, /Not a git worktree/)
  // corrupt catalog file: the read rejects instead of answering "no systems"
  writeFileSync(catalogFile(), '{ not json')
  await assert.rejects(() => svc.catalog(P))
  const route = await app.inject({ method: 'GET', url: `/api/projects/${P.id}/systems` })
  assert.equal(route.statusCode, 500); assert.match(route.json().error, /not valid JSON/)
})
