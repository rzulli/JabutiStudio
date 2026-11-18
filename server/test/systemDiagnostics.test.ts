/**
 * Systems Explorer V1.1 diagnostics: each state is explained (meaning, cause, effect, next action or the reason there
 * is none), the three kinds of problem stay separate, and nothing here confirms a system or edits a decision.
 * Part 1 is the pure builder; part 2 runs the real catalog on a throwaway git repo + worktree + fake graph.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildDiagnostics, summarizeAnalysis, reanalyzeBlock, type DiagnosticsInput } from '../src/services/systemDiagnostics.js'

const base = (over: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  status: 'confirmed', origin: 'user',
  checkout: { isCanonical: true, branch: 'main', head: 'abc1234' },
  graph: { built: true, builtAt: Date.UTC(2026, 0, 2, 10, 30), installed: true, building: false },
  changedMembers: [], unresolved: [], vanished: [], ...over,
})
const codes = (i: DiagnosticsInput) => buildDiagnostics(i).map(d => d.code)

// ---- part 1: pure --------------------------------------------------------------------------------------------

test('a proposed system with a current analysis shows only the proposal notice, and it is not a defect', () => {
  const ds = buildDiagnostics(base({ status: 'proposed', origin: 'agent' }))
  assert.deepEqual(ds.map(d => d.code), ['proposal'])
  assert.equal(ds[0].kind, 'classification')
  assert.equal(ds[0].severity, 'info')
  assert.match(ds[0].cause, /agent/)
  assert.deepEqual([ds[0].action.kind, ds[0].action.available], ['review', true])
  assert.equal(summarizeAnalysis(base()).state, 'current')
})

test('a confirmed, current system has no notices at all', () => {
  assert.deepEqual(codes(base()), [])
})

test('a stale graph names the analysis time, the checkout it describes and the changed files; re-analysis is offered', () => {
  const [d] = buildDiagnostics(base({ changedMembers: ['scripts/a/GrainStore.gd', 'scripts/Mill.gd'] }))
  assert.equal(d.code, 'graph-stale')
  assert.match(d.cause, /2026-01-02 10:30 UTC/)
  assert.match(d.cause, /project checkout/)
  assert.match(d.cause, /GrainStore\.gd, Mill\.gd/)
  assert.deepEqual([d.action.kind, d.action.available], ['reanalyze', true])
  assert.equal(d.altersDesign, false)
  assert.equal(summarizeAnalysis(base({ changedMembers: ['x.gd'] })).state, 'stale')
})

test('missing files: each reference keeps its path and origin, and the three situations are told apart', () => {
  const ds = buildDiagnostics(base({
    unresolved: [
      { path: 'a/Gone.gd', source: 'system anchor', inProjectCheckout: false, graphKnows: false },
      { path: 'a/Listed.gd', source: 'area "Storage"', inProjectCheckout: false, graphKnows: true },
    ],
  }))
  const d = ds.find(x => x.code === 'files-missing')!
  assert.equal(d.kind, 'integrity')
  assert.deepEqual(d.refs.map(r => [r.path, r.source, r.state]), [
    ['a/Gone.gd', 'system anchor', 'absent'], ['a/Listed.gd', 'area "Storage"', 'absent-since-analysis'],
  ])
  assert.deepEqual([d.action.kind, d.action.available], ['edit-members', true])
  assert.equal(ds.some(x => x.code === 'graph-stale'), false, 'missing files are not an out-of-date analysis')
})

test('in a worktree, a file that only the project checkout has is a checkout mismatch with no action', () => {
  const [d] = buildDiagnostics(base({
    checkout: { isCanonical: false, branch: 'task-1', head: 'def5678' },
    graph: { built: false, installed: true, building: false },
    unresolved: [{ path: 'scripts/Silo.gd', source: 'system anchor', inProjectCheckout: true, graphKnows: false }],
  })).filter(x => x.code === 'files-missing')
  assert.equal(d.refs[0].state, 'other-checkout')
  assert.match(d.cause, /task-1@def5678/)
  assert.equal(d.action.available, false)
  assert.match(d.action.blockedReason!, /project checkout/)
})

test('an unavailable action always says why: worktree, not installed, already running', () => {
  const stale = { changedMembers: ['x.gd'] }
  const wt = buildDiagnostics(base({ checkout: { isCanonical: false, branch: 'task-1' } }))
  assert.deepEqual(wt.map(d => d.code), ['graph-other-checkout'])
  assert.equal(wt[0].action.available, false)
  assert.match(wt[0].action.blockedReason!, /never a worktree|cannot analyze a worktree/)
  assert.match(reanalyzeBlock({ checkout: base().checkout, graph: { ...base().graph, installed: false } })!, /graphify:setup/)
  assert.match(reanalyzeBlock({ checkout: base().checkout, graph: { ...base().graph, building: true } })!, /already running/)
  const notInstalled = buildDiagnostics(base({ ...stale, graph: { built: true, builtAt: 1, installed: false, building: false } }))[0]
  assert.equal(notInstalled.action.available, false)
  assert.ok(notInstalled.action.blockedReason)
  const missingGraph = buildDiagnostics(base({ graph: { built: false, installed: true, building: false } }))[0]
  assert.equal(missingGraph.code, 'graph-not-built')
  assert.equal(missingGraph.action.available, true)
})

test('every diagnostic is read-only: none claims to alter design, and the available-or-blocked contract holds', () => {
  const all = buildDiagnostics(base({
    status: 'proposed', changedMembers: ['x.gd'], vanished: [{ key: 'file:old.gd', since: 'now' }],
    unresolved: [{ path: 'm.gd', source: 'system anchor', inProjectCheckout: false, graphKnows: false }],
  }))
  assert.deepEqual(all.map(d => d.code).sort(), ['files-missing', 'graph-stale', 'proposal', 'references-vanished'])
  for (const d of all) {
    assert.equal(d.altersDesign, false)
    if (d.action.kind !== 'none' && !d.action.available) assert.ok(d.action.blockedReason, `${d.code} blocked without reason`)
    assert.ok(d.meaning && d.cause && d.effect)
  }
})

// ---- part 2: the real catalog ---------------------------------------------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-diag-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-diag-proj-'))
const proj = join(parent, 'game'), wt = join(parent, 'game-wt')
process.env.SHIPYARD_DATA_DIR = dataDir
process.env.SHIPYARD_GRAPHIFY_PYTHON = process.execPath // "installed"; never executed here
const UI = { host: 'localhost:5420', origin: 'http://localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' })
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }

type Svc = typeof import('../src/services/systemCatalog.js')
let svc: Svc
let app: import('fastify').FastifyInstance
let P: any

function writeGraph(files: string[], startedAt: number) {
  const nodes = files.map(f => ({ id: f, label: f.split('/').pop(), source_file: f, source_location: 'L1' }))
  const out = join(dataDir, 'graphify/projects/game/tree/graphify-out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'graph.json'), JSON.stringify({ nodes, links: [] }))
  const t = new Date(Date.now() - 60_000); utimesSync(join(out, 'graph.json'), t, t)
  writeFileSync(join(dataDir, 'graphify/projects/game/meta.json'), JSON.stringify({ startedAt, root: proj }))
}
const view = async (q = '') => (await app.inject({ method: 'GET', url: `/api/projects/game/systems/sys-grain${q}` })).json()

before(async () => {
  put(proj, 'project.godot', 'config_version=5\n')
  put(proj, 'scripts/GrainStore.gd', 'extends Node\nfunc add():\n\tpass\n')
  put(proj, 'scripts/GrainRules.gd', 'extends RefCounted\n')
  put(proj, 'scripts/GrainPanel.gd', 'extends Control\n')
  git(proj, 'init', '-q'); git(proj, 'add', '-A'); git(proj, 'commit', '-qm', 'base')
  git(proj, 'worktree', 'add', '-q', '-b', 'task-1', wt)
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [{ id: 'game', path: proj }] }))
  const pd = await import('../src/services/projectDiscovery.js')
  P = (await pd.addProjects([proj]))[0]
  assert.equal(P.id, 'game')
  svc = await import('../src/services/systemCatalog.js')
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/systems.js')).systemRoutes)
  writeGraph(['scripts/GrainStore.gd', 'scripts/GrainRules.gd', 'scripts/GrainPanel.gd'], Date.now() + 120_000)
  await svc.discover(P)
})
after(async () => { await app?.close(); for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true }) })

test('D1: a discovered system with a current analysis is only a proposal, identifies the checkout, and is not confirmed by reading', async () => {
  svc.resetCaches()
  const v = await view()
  assert.equal(v.status, 'proposed')
  assert.deepEqual(v.maintenance.diagnostics.map((d: any) => d.code), ['proposal'])
  assert.equal(v.maintenance.analysis.state, 'current')
  assert.equal(v.checkout.isCanonical, true)
  assert.equal(v.checkout.branch, git(proj, 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim())
  assert.match(v.maintenance.diagnostics[0].cause, /discovery/)
  for (let i = 0; i < 3; i++) await view()                       // reading, polling, re-resolving: still a proposal
  svc.resetCaches()
  assert.equal((await view()).status, 'proposed')
  assert.equal((await svc.getStored('game', 'sys-grain'))!.status, 'proposed')
})

test('D2: files edited after the analysis give a stale-graph notice, and the design record is untouched', async () => {
  const before = JSON.stringify(await svc.getStored('game', 'sys-grain'))
  writeGraph(['scripts/GrainStore.gd', 'scripts/GrainRules.gd', 'scripts/GrainPanel.gd'], Date.now() - 300_000)
  svc.resetCaches()
  const v = await view()
  const d = v.maintenance.diagnostics.find((x: any) => x.code === 'graph-stale')
  assert.ok(d, JSON.stringify(v.maintenance.diagnostics.map((x: any) => x.code)))
  assert.deepEqual([d.action.kind, d.action.available], ['reanalyze', true])
  assert.match(d.cause, /GrainStore\.gd/)
  assert.equal(v.maintenance.analysis.state, 'stale')
  assert.equal(v.maintenance.diagnostics.some((x: any) => x.code === 'files-missing'), false)
  const after = JSON.stringify(await svc.getStored('game', 'sys-grain'))
  assert.deepEqual(JSON.parse(after).anchors, JSON.parse(before).anchors)
  assert.equal(JSON.parse(after).status, 'proposed')
})

test('D3: after a (simulated) completed analysis the stale notice is gone; the proposal remains', async () => {
  writeGraph(['scripts/GrainStore.gd', 'scripts/GrainRules.gd', 'scripts/GrainPanel.gd'], Date.now() + 120_000)
  svc.invalidateViews()
  const v = await view()
  assert.deepEqual(v.maintenance.diagnostics.map((d: any) => d.code), ['proposal'])
  assert.equal(v.status, 'proposed')
})

test('D4: deleted anchored files are listed with path and origin; the graph still listing one is told apart', async () => {
  await app.inject({ method: 'PATCH', url: '/api/projects/game/systems/sys-grain', headers: UI, payload: { anchors: { files: ['scripts/GrainRules.gd', 'scripts/GrainPanel.gd'] } } })
  git(proj, 'rm', '-q', 'scripts/GrainRules.gd', 'scripts/GrainPanel.gd'); git(proj, 'commit', '-qm', 'rm')
  writeGraph(['scripts/GrainStore.gd', 'scripts/GrainRules.gd'], Date.now() + 120_000) // graph still lists Rules, never knew Panel
  svc.resetCaches()
  const v = await view()
  const d = v.maintenance.diagnostics.find((x: any) => x.code === 'files-missing')
  assert.ok(d)
  const by = Object.fromEntries(d.refs.map((r: any) => [r.path, r]))
  assert.equal(by['scripts/GrainRules.gd'].state, 'absent-since-analysis')
  assert.equal(by['scripts/GrainPanel.gd'].state, 'absent')
  assert.equal(by['scripts/GrainPanel.gd'].source, 'system anchor')
  assert.equal(v.maintenance.diagnostics.some((x: any) => x.code === 'graph-stale'), false)
  assert.deepEqual((await svc.getStored('game', 'sys-grain'))!.anchors.files.sort(), ['scripts/GrainPanel.gd', 'scripts/GrainRules.gd'], 'anchors are never rewritten by inference')
})

test('D5: examined from a worktree whose branch lacks a file, it is a checkout mismatch and the checkout is identified', async () => {
  put(proj, 'scripts/GrainSilo.gd', 'extends Node\n')
  git(proj, 'add', '-A'); git(proj, 'commit', '-qm', 'silo')
  await app.inject({ method: 'PATCH', url: '/api/projects/game/systems/sys-grain', headers: UI, payload: { anchors: { files: ['scripts/GrainSilo.gd'] } } })
  svc.resetCaches()
  const main = await view()
  assert.equal(main.maintenance.diagnostics.some((x: any) => x.code === 'files-missing' && x.refs.some((r: any) => r.path === 'scripts/GrainSilo.gd')), false, 'present in the project checkout')
  const w = await view(`?worktree=${encodeURIComponent(wt)}`)
  assert.equal(w.checkout.isCanonical, false)
  assert.equal(w.checkout.branch, 'task-1')
  const d = w.maintenance.diagnostics.find((x: any) => x.code === 'files-missing')
  const silo = d.refs.find((r: any) => r.path === 'scripts/GrainSilo.gd')
  assert.equal(silo.state, 'other-checkout')
  assert.match(d.cause, /task-1@/)
  assert.ok(w.maintenance.diagnostics.some((x: any) => x.code === 'graph-other-checkout'))
  assert.equal(w.maintenance.analysis.state, 'other-checkout')
  const note = w.maintenance.diagnostics.find((x: any) => x.code === 'graph-other-checkout')
  assert.equal(note.action.available, false)                     // an unavailable action: a worktree cannot be analyzed
  assert.ok(note.action.blockedReason)
  assert.equal((await svc.getStored('game', 'sys-grain'))!.status, 'proposed')
})

test('D6: only the UI can confirm; no diagnostic, read or catalog row does it', async () => {
  const denied = await app.inject({ method: 'PATCH', url: '/api/projects/game/systems/sys-grain', payload: { status: 'confirmed' } })
  assert.equal(denied.statusCode, 403)
  const cat = (await app.inject({ method: 'GET', url: '/api/projects/game/systems' })).json()
  assert.equal(cat.systems.find((s: any) => s.id === 'sys-grain').status, 'proposed')
})
