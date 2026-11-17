/**
 * R1-B3: retiring the legacy DK engine. Closes the R1-B2 blockers on the shared engine:
 *   A1 external evidence (@name:key) is resolved only through explicit local configuration, with honest states;
 *   A2 one identity per folder across 8.3 short names / separators / case, without widening what may be examined;
 *   A3 historic revisions never fall back to anything and never borrow later knowledge;
 *   T14 no product code starts Python or dk.py any more.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-ret-data-'))
const root = mkdtempSync(join(tmpdir(), 'jabuti-ret-proj-'))
process.env.SHIPYARD_DATA_DIR = dataDir
for (const k of Object.keys(process.env)) if (k.startsWith('SHIPYARD_DK_SOURCE_')) delete process.env[k]

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString()
const write = (dir: string, p: string, c: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c) }

const CSV = 'id;cost\nspore_source;44000\nother;1\n'
const csvPath = join(root, 'economy.csv')
const game = join(root, 'game'), other = join(root, 'other', 'game')
let P: { id: string; path: string }
let core: typeof import('../src/services/designCore.js')
let sources: typeof import('../src/services/designSources.js')
let app: import('fastify').FastifyInstance
let firstCommit = ''

const rec = {
  id: 'DK-EXT-001', title: 'Spore source cost', claim: 'The spore source costs 44000 per the external table.', decision_state: 'unknown', approval_state: 'unknown',
  implementation_state: 'unknown', implementation_sources: [], scope: ['spore'], supersedes: [], conflicts_with: [], files: [], tests: [], qps: [], tags: ['spore'],
  evidence: [{ type: 'data', ref: '@economy_csv:spore_source', sha256: sha(CSV), note: 'external table' }],
}

before(async () => {
  writeFileSync(csvPath, CSV)
  write(game, 'project.godot', 'g\n'); write(other, 'project.godot', 'o\n')
  git(game, 'init', '-q'); git(game, 'add', '-A'); git(game, 'commit', '-qm', 'before knowledge'); firstCommit = git(game, 'rev-parse', 'HEAD').trim()
  git(other, 'init', '-q'); git(other, 'add', '-A'); git(other, 'commit', '-qm', 'base')
  write(game, 'docs/design_knowledge/records/ext.md', `<!-- dk-record\n${JSON.stringify(rec, null, 2)}\n-->\n`)
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  const discovery = await import('../src/services/projectDiscovery.js')
  const a = (await discovery.addProjects([game])).find(x => x.path === game)!
  P = { id: a.id, path: game }
  core = await import('../src/services/designCore.js'); sources = await import('../src/services/designSources.js')
  const mig = await import('../src/services/designMigration.js')
  const plan = await mig.plan(P)
  assert.ok((await mig.apply(P, { expectedPlanSha256: plan.planSha256! })).ok)
  git(game, 'add', '-A'); git(game, 'commit', '-qm', 'native decisions')
  const Fastify = (await import('fastify')).default
  app = Fastify(); await app.register((await import('../src/routes/design.js')).designRoutes)
})
after(async () => { await app?.close(); for (const d of [dataDir, root]) rmSync(d, { recursive: true, force: true }) })

const ev = async (opts: Record<string, any> = {}) => (await core.query(P, { id: 'DK-EXT-001', ...opts })).decisions[0].evidence[0]
const setSource = (p: string | null) => sources.setSource(P.id, 'economy_csv', p)

test('A1: unconfigured => UNKNOWN (never GONE, never CURRENT), and says what to configure', async () => {
  const e = await ev()
  assert.equal(e.freshness, 'UNKNOWN'); assert.equal(e.external.status, 'unconfigured'); assert.match(e.detail, /not configured/)
  assert.equal((await core.query(P, { id: 'DK-EXT-001' })).decisions[0].evidence_status_legacy, 'UNKNOWN')
})

test('A1: configured and matching => CURRENT with the cited row; the source is explicit and local', async () => {
  assert.ok((await setSource(csvPath)).ok)
  const e = await ev()
  assert.equal(e.freshness, 'CURRENT'); assert.equal(e.external.status, 'present'); assert.equal(e.external.origin, 'config')
  assert.deepEqual(e.excerpt, [{ line: 2, text: 'spore_source;44000' }])
})

test('A1: modified => CHANGED when the row is still there, STALE when it is gone', async () => {
  writeFileSync(csvPath, CSV.replace('44000', '50000')); assert.equal((await ev()).freshness, 'CHANGED')
  writeFileSync(csvPath, 'id;cost\nother;1\n'); assert.equal((await ev()).freshness, 'STALE')
  writeFileSync(csvPath, CSV); assert.equal((await ev()).freshness, 'CURRENT')
})

test('A1: configured but absent => GONE; unreadable / not a file => UNKNOWN (inaccessible), not GONE', async () => {
  await setSource(join(root, 'nope.csv')); let e = await ev()
  assert.equal(e.freshness, 'GONE'); assert.equal(e.external.status, 'missing')
  await setSource(root)   // a directory
  e = await ev(); assert.equal(e.freshness, 'UNKNOWN'); assert.equal(e.external.status, 'inaccessible')
  await setSource(csvPath)
})

test('A1: only an explicit absolute local file is accepted; nothing arbitrary is read', async () => {
  assert.equal((await setSource('relative/economy.csv')).ok, false)
  assert.equal((await setSource('\\\\server\\share\\x.csv')).ok, false)
  assert.equal((await sources.setSource(P.id, '../evil', csvPath)).ok, false)
  const refs = ['@economy_csv:spore_source', '@x:y']
  assert.deepEqual(refs.map(r => !!sources.parseExternalRef(r)), [true, true]); assert.equal(sources.parseExternalRef('/etc/passwd'), null)
  // a repository cannot point a name at a path: the decisions file holds only the name
  assert.ok(!/economy\.csv/.test(readFileSync(join(game, 'jabutistudio.decisions.json'), 'utf8')))
})

test('A1: the environment variable configures every project, the file wins nothing over it being explicit', async () => {
  await setSource(null)
  process.env.SHIPYARD_DK_SOURCE_ECONOMY_CSV = csvPath
  const e = await ev(); delete process.env.SHIPYARD_DK_SOURCE_ECONOMY_CSV
  assert.equal(e.freshness, 'CURRENT'); assert.equal(e.external.origin, 'env')
  await setSource(csvPath)
})

test('A1: external files are not part of a revision — UNKNOWN, never a verdict from today\'s file', async () => {
  const e = await ev({ revision: 'HEAD' })
  assert.equal(e.freshness, 'UNKNOWN'); assert.equal(e.external.status, 'unsupported')
})

test('A1: configuring a source over HTTP is UI-only', async () => {
  const url = `/api/projects/${P.id}/design/sources/economy_csv`
  assert.equal((await app.inject({ method: 'PUT', url, payload: { path: csvPath } })).statusCode, 403)
  const ui = await app.inject({ method: 'PUT', url, payload: { path: csvPath }, headers: { host: 'localhost:5420', origin: 'http://localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' } })
  assert.equal(ui.statusCode, 200, ui.body)
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${P.id}/design/sources` })).json().sources[0].name, 'economy_csv')
})

test('A2: one identity per folder — short 8.3 name, long name, separators and case', async () => {
  const { canonicalPath } = await import('../src/services/pathIdentity.js')
  const long = realpathSync.native(game)
  assert.equal(canonicalPath(game), canonicalPath(long))
  assert.equal(canonicalPath(game), canonicalPath(game.replace(/\\/g, '/')))
  assert.equal(canonicalPath(long.toUpperCase()), canonicalPath(long.toLowerCase()))   // win32 is case-insensitive; elsewhere identical inputs only
  assert.notEqual(canonicalPath(game), canonicalPath(other), 'same folder name in two parents stays two identities')
  // the same project reached through its other spelling is one project, not a duplicate
  const discovery = await import('../src/services/projectDiscovery.js')
  const again = await discovery.addProjects([long])
  assert.equal(again.filter(p => canonicalPath(p.path) === canonicalPath(game)).length, 1)
})

test('A2: the same project and worktree resolve by any spelling, and nothing outside the git list can be examined', async () => {
  const long = realpathSync.native(game)
  const viaLong = await core.query({ id: P.id, path: long }, { id: 'DK-EXT-001' })
  assert.equal(viaLong.sources.native.state, 'present'); assert.equal(viaLong.decisions.length, 1)
  const wt = join(root, 'game-wt'); git(game, 'worktree', 'add', '-q', '-b', 'task', wt)
  const spelled = realpathSync.native(wt).replace(/\\/g, '/')
  const r = await core.query(P, { id: 'DK-EXT-001', worktree: spelled })
  assert.equal(r.available, true); assert.equal(r.examined.isCanonical, false)
  assert.equal((await core.query(P, { id: 'DK-EXT-001', worktree: long })).examined.isCanonical, true)
  for (const bad of [root, dirname(game), join(game, '..', 'other', 'game'), other, 'C:\\Windows', '..', join(game, 'docs')])
    assert.equal((await core.query(P, { id: 'DK-EXT-001', worktree: bad })).available, false, bad)
})

test('A3: a revision before the manifest has no knowledge and says so — no fallback, no later knowledge', async () => {
  const before = await core.query(P, { id: 'DK-EXT-001', revision: firstCommit })
  assert.equal(before.available, true); assert.deepEqual(before.decisions, []); assert.equal(before.sources.native.state, 'absent')
  assert.match(before.limitations.join(' '), /had no native Design Knowledge/)
  assert.equal((await core.query(P, { q: 'spore cost', revision: firstCommit })).decisions.length, 0)
})

test('A3: an unknown revision is an error state, not an empty history; the revision ignores later working-tree edits', async () => {
  const bad = await core.query(P, { id: 'DK-EXT-001', revision: 'no-such-branch' })
  assert.equal(bad.available, false); assert.match(bad.reason, /Unknown revision/)
  const file = join(game, 'jabutistudio.decisions.json'), saved = readFileSync(file, 'utf8')
  const doc = JSON.parse(saved); doc.decisions[0].claim = 'edited later'; writeFileSync(file, JSON.stringify(doc, null, 2))
  assert.equal((await core.query(P, { id: 'DK-EXT-001', revision: 'HEAD' })).decisions[0].claim, rec.claim)
  assert.equal((await core.query(P, { id: 'DK-EXT-001' })).decisions[0].claim, 'edited later')
  writeFileSync(file, saved)
})

test('A4: record_integration says where the decisions file stands (committed/integrated, local, revision)', async () => {
  assert.equal((await core.query(P, { id: 'DK-EXT-001' })).decisions[0].record_integration, 'integrated')
  const file = join(game, 'jabutistudio.decisions.json'), saved = readFileSync(file, 'utf8')
  writeFileSync(file, saved + '\n'); assert.equal((await core.query(P, { id: 'DK-EXT-001' })).decisions[0].record_integration, 'local')
  writeFileSync(file, saved)
  assert.equal((await core.query(P, { id: 'DK-EXT-001', revision: 'HEAD' })).decisions[0].record_integration, 'revision')
})

test('A4: MCP get_design_context returns the migrated rule and its evidence, bounded, without Python', async () => {
  const mcp = await import('../src/services/mcpServer.js')
  const out = JSON.parse((await mcp.handleToolCall('get_design_context', { projectId: P.id, query: 'spore source cost' })).content[0].text)
  assert.equal(out.decisions.length, 1); assert.equal(out.decisions[0].id, 'DK-EXT-001')
  assert.equal(out.decisions[0].sources[0].freshness, 'CURRENT'); assert.ok(out.decisions[0].sources[0].excerpt.length <= 4)
  assert.ok(JSON.stringify(out).length < 6000)
})

test('T14: no product code starts Python or dk.py', () => {
  const src = join(here, '..', 'src'); const hits: string[] = []
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(n)) {
    const t = readFileSync(p, 'utf8')
    if (/execFile(Sync)?\(\s*['"`](python3?|py)['"`]/.test(t) || /['"`]python3?['"`]\s*,\s*\[/.test(t) || /SHIPYARD_PYTHON|FORBID_PYTHON|pythonAttempts/.test(t)) hits.push(p)
    if (/join\([^)]*['"]dk\.py['"]/.test(t) || /tools[\\/]+design_knowledge/.test(t.replace(/\/\/.*$/gm, ''))) hits.push(p)
  } } }
  walk(src)
  assert.deepEqual(hits, [])
})

test('A5: a worktree registered as the project is NOT "integrated" until its commit is in the main checkout', async () => {
  const dd = await import('../src/services/designDecisions.js')
  const main = join(root, 'a5-main'), wt = join(root, 'a5-wt'), f = 'jabutistudio.decisions.json'
  write(main, 'README.md', 'x\n'); git(main, 'init', '-q'); git(main, 'add', '-A'); git(main, 'commit', '-qm', 'base')
  git(main, 'worktree', 'add', '-q', '-b', 'migration/x', wt)
  write(wt, f, '{}\n'); git(wt, 'add', f); git(wt, 'commit', '-qm', 'decisions on the branch only')
  // The worktree may be the registered project path, yet main does not contain the commit yet.
  assert.equal(await dd.fileIntegration(wt, true), 'committed')
  const { canonicalPath } = await import('../src/services/pathIdentity.js')
  assert.equal(canonicalPath((await dd.mainCheckout(wt))!.root), canonicalPath(main))
  git(main, 'merge', '-q', '--ff-only', 'migration/x')
  assert.equal(await dd.fileIntegration(wt, true), 'integrated')
  assert.equal(await dd.fileIntegration(main, true), 'integrated')
})
