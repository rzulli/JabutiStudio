/**
 * System catalog: discovery from structure, stable identity, derived (not stored) membership, worktree
 * isolation, vanished references, DK conflicts without invented approval, agent brief, and the rule that
 * only the UI classifies. Uses a tiny Godot-shaped fixture WITHOUT Design Knowledge (portability) and a
 * second one with the DK fixture.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, renameSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-sys-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-sys-proj-'))
const nodk = join(parent, 'nodk'), nodkWt = join(parent, 'nodk-wt'), withDk = join(parent, 'withdk')
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' })
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const UI = { host: 'localhost:5420', origin: 'http://localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }

let graphTick = 1
function graph(syms: string[]) {
  const nodes = [
    { id: 'store', label: 'GrainStore.gd', source_file: 'scripts/GrainStore.gd', source_location: 'L1' },
    { id: 'mill', label: 'Mill.gd', source_file: 'scripts/Mill.gd', source_location: 'L1' },
    ...syms.map((s, i) => ({ id: `s_${s}`, label: `${s}()`, source_file: 'scripts/GrainStore.gd', source_location: `L${i + 3}` })),
  ]
  const links = [{ _src: 'mill', _tgt: 'store', source: 'mill', target: 'store', relation: 'calls', confidence: 'EXTRACTED', source_file: 'scripts/Mill.gd', source_location: 'L2' }]
  const out = join(dataDir, 'graphify/projects/nodk/tree/graphify-out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'graph.json'), JSON.stringify({ nodes, links }))
  const t = new Date(Date.now() - 120_000 + graphTick++ * 2000)
  utimesSync(join(out, 'graph.json'), t, t)
}

type Svc = typeof import('../src/services/systemCatalog.js')
let svc: Svc
let app: import('fastify').FastifyInstance
let nodkP: any, dkP: any

before(async () => {
  put(nodk, 'project.godot', 'config_version=5\n')
  put(nodk, 'scripts/GrainStore.gd', 'extends Node\nfunc add():\n\tpass\nfunc drain():\n\tpass\n')
  put(nodk, 'scripts/GrainRules.gd', 'extends RefCounted\nconst CAP := 10\n')
  put(nodk, 'scripts/GrainPanel.gd', 'extends Control\n')
  put(nodk, 'tests/grain_smoke.gd', 'extends Node\n')
  put(nodk, 'scripts/Mill.gd', 'extends Node\n# grinds grain into flour\nvar g = grain\nvar h = grain_total\n')
  put(nodk, 'scripts/Unrelated.gd', 'extends Node\n')
  git(nodk, 'init', '-q'); git(nodk, 'add', '-A'); git(nodk, 'commit', '-qm', 'base')
  git(nodk, 'worktree', 'add', '-q', '-b', 'task-1', nodkWt)

  // second project: Design Knowledge with two conflicting records
  const PARAMS = 'extends RefCounted\nconst FIRST := 1000.0\n'
  put(withDk, 'project.godot', 'config_version=5\n')
  put(withDk, 'scripts/params.gd', PARAMS)
  mkdirSync(join(withDk, 'tools/design_knowledge'), { recursive: true })
  copyFileSync(join(here, 'fixtures/dk/dk.py'), join(withDk, 'tools/design_knowledge/dk.py'))
  for (const [id, other, n] of [['DK-T-001', 'DK-T-002', 1000], ['DK-T-002', 'DK-T-001', 200]] as const) {
    const rec = {
      id, title: `First maturation cost ${n}`, claim: `Maturation costs ${n}`, decision_state: 'unknown', approval_state: 'unknown',
      implementation_state: 'implemented', implementation_sources: [], scope: ['first maturation'],
      evidence: [{ type: 'code', ref: 'scripts/params.gd#L2-L2', sha256: sha(PARAMS), note: 'constant' }],
      supersedes: [], conflicts_with: [other], files: [{ role: 'param', path: 'scripts/params.gd' }], tests: [], qps: [], tags: [],
    }
    put(withDk, `docs/design_knowledge/records/${id}.md`, `<!-- dk-record\n${JSON.stringify(rec)}\n-->\n# r\n`)
  }
  git(withDk, 'init', '-q'); git(withDk, 'add', '-A'); git(withDk, 'commit', '-qm', 'base')

  const pd = await import('../src/services/projectDiscovery.js')
  const projects = await pd.addProjects([nodk, withDk])
  nodkP = projects.find(p => p.path === nodk); dkP = projects.find(p => p.path === withDk)
  assert.equal(nodkP.id, 'nodk')
  svc = await import('../src/services/systemCatalog.js')
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/systems.js')).systemRoutes)
  graph(['add', 'drain'])
})
after(async () => {
  await app?.close()
  for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true })
})

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json()

test('T8/T1: a project without DK still yields system candidates, with decisions marked unavailable', async () => {
  const r = await svc.discover(nodkP)
  assert.ok(!('error' in r) && r.added >= 1)
  const cat = await get('/api/projects/nodk/systems')
  const grain = cat.systems.find((s: any) => s.id === 'sys-grain')
  assert.ok(grain, 'grain candidate found')
  assert.equal(grain.status, 'proposed')
  assert.equal(grain.origin, 'discovery')
  const v = await get('/api/projects/nodk/systems/sys-grain')
  assert.equal(v.design.available, false)
  const paths = v.members.map((m: any) => m.path)
  assert.ok(paths.includes('scripts/GrainStore.gd') && paths.includes('tests/grain_smoke.gd'))
  assert.ok(paths.includes('scripts/Mill.gd'), 'found by text, not by name')
  assert.ok(!paths.includes('scripts/Unrelated.gd'))
  assert.equal(v.members.find((m: any) => m.path === 'tests/grain_smoke.gd').role, 'test')
  assert.equal(v.members.find((m: any) => m.path === 'scripts/Mill.gd').confidence, 'extracted')
})

test('discovery is idempotent and an agent proposal extends the owner instead of duplicating', async () => {
  const again = await svc.discover(nodkP)
  assert.ok(!('error' in again) && again.added === 0)
  const res = await svc.propose('nodk', { name: 'Grain economy', summary: 'Stores and mills grain.', terms: ['grain'], files: ['scripts/Mill.gd'] }, 'agent')
  assert.deepEqual([res.id, res.outcome], ['sys-grain', 'extended'])
  const cat = await get('/api/projects/nodk/systems')
  assert.equal(cat.systems.filter((s: any) => /grain/i.test(s.name)).length, 1)
  const v = await get('/api/projects/nodk/systems/sys-grain')
  assert.equal(v.origin, 'agent')
  assert.equal(v.members.find((m: any) => m.path === 'scripts/Mill.gd').confidence, 'declared')
  assert.ok(v.neighbors.every((n: any) => !v.members.some((m: any) => m.path === n.path)))
})

test('only the UI can classify; agents cannot confirm, and a proposal never rewrites a confirmed system', async () => {
  const denied = await app.inject({ method: 'PATCH', url: '/api/projects/nodk/systems/sys-grain', payload: { status: 'confirmed' } })
  assert.equal(denied.statusCode, 403)
  assert.equal((await get('/api/projects/nodk/systems/sys-grain')).status, 'proposed')
  const ok = await app.inject({ method: 'PATCH', url: '/api/projects/nodk/systems/sys-grain', payload: { status: 'confirmed', summary: 'Human text' }, headers: UI })
  assert.equal(ok.statusCode, 200)
  const res = await svc.propose('nodk', { name: 'Grain', summary: 'Agent rewrite', terms: ['grain'], files: ['scripts/GrainRules.gd'] }, 'agent')
  assert.equal(res.outcome, 'suggestion-recorded')
  const v = await get('/api/projects/nodk/systems/sys-grain')
  assert.equal(v.summary, 'Human text')
  assert.equal(v.status, 'confirmed')
  assert.equal(v.suggestions.length, 1)
  assert.equal(v.confirmedVia, 'ui-request')
})

test('T2/T6: reanalysis keeps the identity; a vanished symbol and a deleted file are flagged, not kept as facts', async () => {
  const first = await get('/api/projects/nodk/systems/sys-grain')
  assert.ok(first.members.find((m: any) => m.path === 'scripts/GrainStore.gd').symbols.some((s: any) => s.label === 'drain()'))
  graph(['add'])                                            // Graphify re-ran: drain() is gone
  rmSync(join(nodk, 'scripts/GrainPanel.gd'))
  git(nodk, 'add', '-A'); git(nodk, 'commit', '-qm', 'rm panel')
  svc.resetCaches()
  const next = await get('/api/projects/nodk/systems/sys-grain')
  assert.equal(next.id, first.id)
  assert.ok(!next.members.some((m: any) => m.path === 'scripts/GrainPanel.gd'))
  assert.ok(!next.members.find((m: any) => m.path === 'scripts/GrainStore.gd').symbols.some((s: any) => s.label === 'drain()'))
  const keys = next.maintenance.vanished.map((v: any) => v.key)
  assert.ok(keys.includes('file:scripts/GrainPanel.gd'), keys.join())
  assert.ok(keys.includes('sym:scripts/GrainStore.gd#drain()'), keys.join())
  const cat = await get('/api/projects/nodk/systems')
  assert.equal(cat.systems.filter((s: any) => s.id === 'sys-grain').length, 1)
  assert.ok(cat.systems.find((s: any) => s.id === 'sys-grain').flags.some((f: string) => /vanished/.test(f)))
})

test('T6: a moved anchor file is followed by name, not dropped or duplicated', async () => {
  mkdirSync(join(nodk, 'scripts/mill_new'), { recursive: true })
  renameSync(join(nodk, 'scripts/Mill.gd'), join(nodk, 'scripts/mill_new/Mill.gd'))
  svc.resetCaches()
  const v = await get('/api/projects/nodk/systems/sys-grain')
  const m = v.members.find((x: any) => x.path === 'scripts/mill_new/Mill.gd')
  assert.ok(m, 'followed')
  assert.equal(m.state, 'moved')
  assert.equal(m.movedFrom, 'scripts/Mill.gd')
  assert.equal(v.members.filter((x: any) => /Mill\.gd$/.test(x.path)).length, 1)
})

test('Case A: a member edited after the analysis marks the graph as possibly stale', async () => {
  const metaDir = join(dataDir, 'graphify/projects/nodk')
  writeFileSync(join(metaDir, 'meta.json'), JSON.stringify({ startedAt: Date.now() - 300_000, root: nodk }))
  svc.resetCaches()
  const v = await get('/api/projects/nodk/systems/sys-grain')
  assert.equal(v.maintenance.needsReanalysis, true)
  assert.ok(v.maintenance.changedMembers.includes('scripts/GrainStore.gd'))
})

test('T5/Case B: a worktree change shows with the worktree revision and never touches the integrated view', async () => {
  put(nodkWt, 'scripts/GrainSilo.gd', 'extends Node\n')            // new, uncommitted, only in the worktree
  svc.resetCaches()
  const wt = await get(`/api/projects/nodk/systems/sys-grain?worktree=${encodeURIComponent(nodkWt)}`)
  assert.equal(wt.checkout.isCanonical, false)
  assert.equal(wt.checkout.branch, 'task-1')
  assert.ok(wt.checkout.uncommitted >= 1)
  const silo = wt.members.find((m: any) => m.path === 'scripts/GrainSilo.gd')
  assert.ok(silo && silo.uncommitted)
  assert.match(wt.limitations.join(' '), /worktree/i)
  const main = await get('/api/projects/nodk/systems/sys-grain')
  assert.equal(main.checkout.isCanonical, true)
  assert.ok(!main.members.some((m: any) => m.path === 'scripts/GrainSilo.gd'))
  const stored = await svc.getStored('nodk', 'sys-grain')
  assert.ok(!stored!.seen!.keys.includes('file:scripts/GrainSilo.gd'), 'worktree view must not rewrite the integrated snapshot')
  const bad = await app.inject({ method: 'GET', url: `/api/projects/nodk/systems/sys-grain?worktree=${encodeURIComponent(parent)}` })
  assert.equal(bad.statusCode, 404)
})

test('T3: two conflicting DK records show up as a conflict with no invented approval', async () => {
  await svc.propose('withdk', { name: 'First maturation', terms: ['maturation'], files: ['scripts/params.gd'], decisions: ['DK-T-001', 'DK-T-002'] }, 'agent')
  const v: any = await svc.resolveSystem(dkP, 'sys-first-maturation')
  assert.equal(v.design.available, true)
  assert.deepEqual(v.design.decisions.map((d: any) => d.id).sort(), ['DK-T-001', 'DK-T-002'])
  assert.deepEqual(v.design.conflicts, [['DK-T-001', 'DK-T-002']])
  for (const d of v.design.decisions) { assert.equal(d.approval.state, 'unknown'); assert.equal(d.evidenceStatus, 'CURRENT') }
  assert.ok(v.design.decisions[0].evidence[0].excerpt.some((l: string) => l.includes('1000')))
  assert.equal(v.status, 'proposed')
})

test('T7: the agent brief carries identity, revision, conflicts and what is unconfirmed', async () => {
  const v: any = await svc.resolveSystem(dkP, 'sys-first-maturation')
  const text = svc.brief(v, 'Investigate the cost')
  assert.match(text, /sys-first-maturation/)
  assert.match(text, /HEAD: [0-9a-f]{7,}/)
  assert.match(text, /UNRESOLVED CONFLICT \(DK-T-001 vs DK-T-002\)/)
  assert.match(text, /NOT confirmed/)
  assert.match(text, /integrated checkout/)
  assert.ok(text.length < 6000)
  const res = await get('/api/projects/withdk/systems/sys-first-maturation/brief')
  assert.equal(res.head, v.checkout.head)
  const mcp = await import('../src/services/mcpServer.js')
  for (const n of ['list_systems', 'get_system', 'propose_system']) assert.ok(mcp.MCP_TOOLS.some(t => t.name === n), n)
  assert.ok(!mcp.MCP_TOOLS.some(t => /confirm_system|approve/i.test(t.name)))
})

test('merge keeps a redirect and unions the anchors', async () => {
  await svc.propose('nodk', { name: 'Flour', terms: ['flour'] }, 'agent')
  await svc.merge('nodk', 'sys-grain', ['sys-flour'])
  const flour = await svc.getStored('nodk', 'sys-flour')
  assert.equal(flour!.status, 'merged'); assert.equal(flour!.mergedInto, 'sys-grain')
  const grain = await svc.getStored('nodk', 'sys-grain')
  assert.ok(grain!.anchors.terms.includes('flour'))
})
