/**
 * R1-B1 Design Knowledge Core: native decisions (no Python, no docs/ structure); legacy records are reported, never read through another engine (R1-B3), trust vocabulary, evidence freshness per checkout/revision, conflicts, identity and safety.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-core-data-'))
const root = mkdtempSync(join(tmpdir(), 'jabuti-core-proj-'))
process.env.SHIPYARD_DATA_DIR = dataDir

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString()
const SONG = 'extends Node\nconst PERFECT_WINDOW_MS := 45\nconst GOOD_WINDOW_MS := 90\n'
const mk = (dir: string, files: Record<string, string>) => {
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c) }
  git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base')
}

const beats = join(root, 'beats'), clone = join(root, 'beats-clone'), wt = join(root, 'beats-wt')
const gameA = join(root, 'a', 'game'), gameB = join(root, 'b', 'game')
const legacy = join(root, 'pnmg')
let P: Record<string, { id: string; path: string }> = {}
let core: typeof import('../src/services/designCore.js')
let store: typeof import('../src/services/designDecisions.js')
let app: import('fastify').FastifyInstance
let proposedId = ''

before(async () => {
  mk(beats, { 'project.godot': 'config_version=5\n', 'scripts/rhythm.gd': SONG, 'scripts/hud.gd': 'extends Control\n' })
  mk(gameA, { 'project.godot': 'a\n', 'scripts/x.gd': 'const A := 1\n' })
  mk(gameB, { 'project.godot': 'b\n', 'scripts/x.gd': 'const A := 1\n' })
  // legacy registry: the Humus conflict (code says 1000, a historic record says 200, nobody located the approval)
  const params = 'const FIRST := 1000.0\n'
  mkdirSync(join(legacy, 'docs/design_knowledge/records'), { recursive: true })
  const rec = (id: string, claim: string, other: string) => ({
    id, title: claim, claim, decision_state: 'unknown', approval_state: 'unknown', implementation_state: 'implemented', implementation_sources: [],
    scope: ['first maturation'], evidence: [{ type: 'code', ref: 'scripts/p.gd#L1-L1', sha256: sha(params), note: 'const' }],
    supersedes: [], conflicts_with: [other], files: [{ role: 'param', path: 'scripts/p.gd' }], tests: [], qps: [], tags: ['humus'],
  })
  for (const [id, c, o] of [['DK-HUMUS-001', 'Code uses 1000', 'DK-HUMUS-002'], ['DK-HUMUS-002', 'Report says 200', 'DK-HUMUS-001']])
    writeFileSync(join(legacy, `docs/design_knowledge/records/${id}.md`), `<!-- dk-record\n${JSON.stringify(rec(id, c, o))}\n-->\n# r\n`)
  mkdirSync(join(legacy, 'scripts'), { recursive: true }); writeFileSync(join(legacy, 'scripts/p.gd'), params); writeFileSync(join(legacy, 'project.godot'), 'p\n')
  git(legacy, 'init', '-q'); git(legacy, 'add', '-A'); git(legacy, 'commit', '-qm', 'base')

  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  const discovery = await import('../src/services/projectDiscovery.js')
  for (const [k, p] of Object.entries({ beats, gameA, gameB, legacy })) {
    const list = await discovery.addProjects([p]); const found = list.find(x => x.path === p)!
    P[k] = { id: found.id, path: p }
  }
  core = await import('../src/services/designCore.js')
  store = await import('../src/services/designDecisions.js')
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/design.js')).designRoutes)
})
after(async () => { await app?.close(); for (const d of [dataDir, root]) rmSync(d, { recursive: true, force: true }) })

const evidence = [{ type: 'code' as const, path: 'scripts/rhythm.gd', needle: 'PERFECT_WINDOW_MS := 45', note: 'perfect window' }]

test('T1: a project with no DK answers empty, then accepts a proposal without Python or docs/', async () => {
  const before = await core.query(P.beats, { q: 'perfect window' })
  assert.equal(before.available, true); assert.deepEqual(before.decisions, []); assert.equal(before.sources.native.state, 'absent')
  assert.equal(existsSync(join(beats, 'docs')), false)
  const res = await core.propose(P.beats, { title: 'Perfect window is 45 ms', claim: 'A perfect hit is within 45 ms of the beat.', scope: ['timing', 'perfect window'], evidence, origin: 'agent' })
  assert.ok(res.ok, JSON.stringify(res)); proposedId = (res as any).decision.id
  const after = await core.query(P.beats, { file: 'scripts/rhythm.gd' })
  const d = after.decisions[0]
  assert.equal(d.id, proposedId); assert.equal(d.source, 'native'); assert.equal(d.decision_state, 'hypothesis')
  assert.equal(d.evidence[0].freshness, 'CURRENT'); assert.equal(d.implementation, 'implemented'); assert.equal(d.evidence[0].excerpt[0].text, 'const PERFECT_WINDOW_MS := 45')
  assert.equal(d.approval.state, 'unknown')
  assert.equal(existsSync(join(beats, 'tools')), false)
})

test('T11: one authoritative copy — the file holds the claim, nothing leaks into the systems file, no approval is stored', async () => {
  const file = readFileSync(join(beats, store.DECISIONS_FILE), 'utf8')
  assert.equal(file.split('A perfect hit is within 45 ms').length - 1, 1)
  assert.ok(!/approv|attested/i.test(file.replace(/"claim"[^\n]*/g, '')))
  assert.equal(existsSync(join(beats, 'jabutistudio.systems.json')), false)
  const a = await core.propose(P.beats, { title: 'Good window', claim: 'Good is 90 ms', evidence: [{ type: 'code', path: 'scripts/rhythm.gd', needle: 'GOOD_WINDOW_MS := 90' }], origin: 'agent' })
  assert.ok(a.ok)
  const doc = JSON.parse(readFileSync(join(beats, store.DECISIONS_FILE), 'utf8'))
  assert.equal(doc.decisions.length, 2); assert.notEqual(doc.decisions[0].id, doc.decisions[1].id)
})

test('T2: the decision follows the project in a clone and is queryable by another checkout', async () => {
  git(beats, 'add', '-A'); git(beats, 'commit', '-qm', 'decisions')
  execFileSync('git', ['clone', '-q', beats, clone])
  const { addProjects } = await import('../src/services/projectDiscovery.js')
  const c = (await addProjects([clone])).find(p => p.path === clone)!
  const res = await core.query({ id: c.id, path: clone }, { id: proposedId })
  assert.equal(res.decisions.length, 1); assert.equal(res.decisions[0].evidence_status, 'CURRENT')
})

test('T3: changed, stale, moved and removed evidence change state — in the examined checkout only (T6)', async () => {
  git(beats, 'worktree', 'add', '-q', '-b', 'task', wt)
  const q = () => core.query(P.beats, { id: proposedId, worktree: wt }).then(r => r.decisions[0])
  writeFileSync(join(wt, 'scripts/rhythm.gd'), '# new header\n' + SONG)
  assert.equal((await q()).evidence_status, 'CHANGED')
  writeFileSync(join(wt, 'scripts/rhythm.gd'), SONG.replace('45', '60'))
  let d = await q(); assert.equal(d.evidence_status, 'STALE'); assert.equal(d.implementation, 'divergent')
  writeFileSync(join(wt, 'scripts/rhythm.gd'), SONG)
  renameSync(join(wt, 'scripts/rhythm.gd'), join(wt, 'scripts/timing.gd'))
  git(wt, 'add', '-A'); d = await q()
  assert.equal(d.evidence_status, 'MOVED'); assert.equal(d.evidence[0].path, 'scripts/timing.gd')
  rmSync(join(wt, 'scripts/timing.gd')); d = await q(); assert.equal(d.evidence_status, 'GONE')
  // T6: the canonical checkout is untouched by all of the above
  assert.equal((await core.query(P.beats, { id: proposedId })).decisions[0].evidence_status, 'CURRENT')
  assert.equal((await core.query(P.beats, { id: proposedId })).examined.isCanonical, true)
})

test('T6b: a historic revision reads the committed state, ignoring working-tree edits', async () => {
  writeFileSync(join(beats, 'scripts/rhythm.gd'), SONG.replace('45', '99'))
  assert.equal((await core.query(P.beats, { id: proposedId })).decisions[0].evidence_status, 'STALE')
  const old = await core.query(P.beats, { id: proposedId, revision: 'HEAD' })
  assert.equal(old.decisions[0].evidence_status, 'CURRENT'); assert.equal(old.examined.revision, 'HEAD')
  writeFileSync(join(beats, 'scripts/rhythm.gd'), SONG)
})

test('T4: conflicting claims stay as two distinct, traceable decisions', async () => {
  const b = await core.propose(P.beats, { title: 'Perfect window is 30 ms', claim: 'Perfect is 30 ms (older design doc)', conflictsWith: [proposedId],
    evidence: [{ type: 'document_claim', path: 'scripts/hud.gd', needle: 'extends Control', note: 'stand-in doc' }], origin: 'agent' })
  assert.ok(b.ok); const other = (b as any).decision.id
  const res = await core.query(P.beats, { file: 'scripts/rhythm.gd' }); const both = await core.query(P.beats, { q: 'perfect' })
  assert.ok(both.decisions.length >= 2)
  assert.deepEqual(both.conflicts, [{ ids: [proposedId, other].sort() }])
  const first = both.decisions.find((d: any) => d.id === proposedId)
  assert.deepEqual(first.conflicts_with, [other])            // the inverse side is derived, not duplicated
  assert.notEqual(first.claim, both.decisions.find((d: any) => d.id === other).claim)
  assert.ok(res.decisions.length >= 1)
})

test('T5: documents and files never become approval; only a local attestation does, and it lapses when the claim changes', async () => {
  const h = await core.propose(P.beats, { title: 'Combo cap', claim: 'Combo caps at 100', origin: 'agent',
    evidence: [{ type: 'human_decision', path: 'scripts/hud.gd', needle: 'extends Control', note: 'someone says the owner decided' }] })
  const id = (h as any).decision.id
  let d = (await core.query(P.beats, { id })).decisions[0]
  assert.equal(d.approval.state, 'claimed'); assert.equal(d.decision_state, 'hypothesis')
  assert.deepEqual(await core.attest(P.beats, { decisionId: id, state: 'approved', quote: '' }), { ok: false, error: 'A quote of what was decided is required' })
  const ok: any = await core.attest(P.beats, { decisionId: id, state: 'approved', quote: 'Owner: cap at 100' })
  assert.equal(ok.entry.trust, 'attested_local')
  d = (await core.query(P.beats, { id })).decisions[0]
  assert.equal(d.approval.state, 'approved'); assert.equal(d.approval.source, 'attested_local'); assert.equal(d.decision_state, 'approved')
  const doc = JSON.parse(readFileSync(join(beats, store.DECISIONS_FILE), 'utf8'))   // the attestation never enters the portable file
  assert.ok(!JSON.stringify(doc).includes('attested_local'))
  doc.decisions.find((x: any) => x.id === id).claim = 'Combo caps at 500'
  writeFileSync(join(beats, store.DECISIONS_FILE), JSON.stringify(doc))
  d = (await core.query(P.beats, { id })).decisions[0]
  assert.equal(d.approval.state, 'unknown'); assert.equal(d.approval.lapsed, true)
})

test('T7: unmigrated legacy records are reported, never read, never converted by a query', async () => {
  const res = await core.query(P.legacy, { q: 'first maturation' })
  assert.equal(res.available, true); assert.deepEqual(res.decisions, [])
  assert.match(res.limitations.join(' '), /2 legacy Design Knowledge record\(s\).*DK-HUMUS-001/)
  assert.equal(existsSync(join(legacy, 'jabutistudio.decisions.json')), false)   // never converted by a read
})

test('T8: get_design_context serves native, unmigrated-legacy, empty and revision cases', async () => {
  const mcp = await import('../src/services/mcpServer.js')
  const call = async (a: Record<string, any>) => JSON.parse((await mcp.handleToolCall('get_design_context', a)).content[0].text)
  const leg = await call({ projectId: P.legacy.id, query: 'first maturation' })
  assert.equal(leg.decisions.length, 0); assert.match(leg.limitations.join(' '), /not in the native file/)
  const nat = await call({ projectId: P.beats.id, file: 'scripts/rhythm.gd' })
  assert.equal(nat.decisions[0].origin, 'native'); assert.equal(nat.decisions[0].approval.state, 'unknown'); assert.match(nat.rules, /never an approved rule/)
  const none = await call({ projectId: P.gameA.id, query: 'anything' })
  assert.deepEqual(none.decisions, [])
  const rev = await call({ projectId: P.beats.id, query: 'perfect window', revision: 'HEAD' })
  assert.equal(rev.examined.revision, 'HEAD')
  assert.ok(mcp.MCP_TOOLS.some(t => t.name === 'propose_design_decision'))
  assert.ok(!mcp.MCP_TOOLS.some(t => /approve|confirm_decision/i.test(t.name)))
  const bad = await mcp.handleToolCall('propose_design_decision', { projectId: P.beats.id, title: 'x', claim: 'y', evidence: [{ type: 'code', path: '../secret' }] })
  assert.equal(bad.isError, true)
})

test('T9: two projects with the same folder name never share decisions', async () => {
  assert.notEqual(P.gameA.id, P.gameB.id)
  assert.ok((await core.propose(P.gameA, { title: 'Only in A', claim: 'A rule', evidence: [{ type: 'code', path: 'scripts/x.gd', needle: 'const A' }], origin: 'user' })).ok)
  assert.equal((await core.query(P.gameA, { q: 'rule' })).decisions.length, 1)
  assert.equal((await core.query(P.gameB, { q: 'rule' })).decisions.length, 0)
  copyFileSync(join(gameA, store.DECISIONS_FILE), join(gameB, store.DECISIONS_FILE))   // a file from another history is refused
  const r = await core.query(P.gameB, { q: 'rule' })
  assert.equal(r.sources.native.state, 'incompatible'); assert.equal(r.decisions.length, 0)
})

test('T10: bad references, schemas and paths are rejected', async () => {
  const base = { title: 'T', claim: 'C', origin: 'agent' as const }
  for (const path of ['../outside.gd', 'C:/x.gd', '/etc/passwd', 'a\\b.gd', 'scripts/missing.gd'])
    assert.equal((await core.propose(P.beats, { ...base, evidence: [{ type: 'code', path }] })).ok, false, path)
  assert.equal((await core.propose(P.beats, { ...base, evidence: [] })).ok, false)
  assert.equal((await core.propose(P.beats, { ...base, evidence: [{ type: 'code', path: 'scripts/hud.gd', needle: 'not in file' }] })).ok, false)
  assert.equal((await core.propose(P.beats, { ...base, conflictsWith: ['dec-nope'], evidence: [{ type: 'code', path: 'scripts/hud.gd' }] })).ok, false)
  const parsed = store.decisionsSchema.safeParse({ version: 2, gitRoots: ['a'.repeat(40)], decisions: [] }); assert.equal(parsed.success, false)
  const trav = store.decisionsSchema.safeParse({ version: 1, gitRoots: ['a'.repeat(40)], decisions: [{ id: 'dec-abc', title: 't', claim: 'c', scope: [], systems: [], files: ['../x'], evidence: [{ type: 'code', path: 'a' }], conflictsWith: [], supersedes: [], origin: 'agent', status: 'proposed', createdAt: '', updatedAt: '' }] })
  assert.equal(trav.success, false)
  writeFileSync(join(gameB, store.DECISIONS_FILE), '{ not json')
  assert.equal((await core.query(P.gameB, { q: 'x' })).sources.native.state, 'invalid')
  assert.equal((await core.query(P.beats, { q: 'x', worktree: root })).available, false)    // not a worktree of the project
})

test('routes: proposals work over HTTP, a browser origin only changes the stated origin, approval stays UI-only', async () => {
  const body = { title: 'HUD font', claim: 'HUD uses the default font', evidence: [{ type: 'code', path: 'scripts/hud.gd', needle: 'extends Control' }] }
  const r = await app.inject({ method: 'POST', url: `/api/projects/${P.beats.id}/design/proposals`, payload: body })
  assert.equal(r.statusCode, 200); assert.equal(r.json().origin, 'agent'); assert.equal(r.json().status, 'proposed')
  const ap = await app.inject({ method: 'POST', url: `/api/projects/${P.beats.id}/design/approve`, payload: { decisionId: r.json().id, state: 'approved', quote: 'fine' } })
  assert.equal(ap.statusCode, 403)
  const q = (await app.inject({ method: 'GET', url: `/api/projects/${P.beats.id}/design?system=sys-none` })).json()
  assert.deepEqual(q.decisions, [])
})
