/**
 * System Explorer V2 (design-first): rule comparator, evidence re-verification, tiers/families, gameplay
 * relations and their provenance, the map layout, maintenance after changes, agent brief and portability.
 * Fixtures are tiny Godot-shaped repos; nothing here depends on a real game.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as sem from '../src/services/systemSemantics.js'
import { buildSystemMap } from '../../client/src/lib/systemMap.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-sys2-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-sys2-proj-'))
const hum = join(parent, 'hum')
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' })
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
const COLLECT = 'extends Node\nfunc capture_clod(m):\n\tcarried += m\n'
const RESERVE = 'extends Node\nvar reserve_humus := 0\n'
const PARAMS = 'extends RefCounted\nconst FIRST_MATURATION := 1000.0\n'

type Svc = typeof import('../src/services/systemCatalog.js')
let svc: Svc
let P: any

before(async () => {
  put(hum, 'project.godot', 'config_version=5\n')
  put(hum, 'scripts/HumusCollector.gd', COLLECT)
  put(hum, 'scripts/HumusReserve.gd', RESERVE)
  put(hum, 'scripts/HumusParams.gd', PARAMS)
  put(hum, 'scripts/ui/HumusHud.gd', 'extends Control\n')
  put(hum, 'scripts/telemetry/HumusFlowTelemetry.gd', 'extends Node\n')
  put(hum, 'tests/humus_smoke.gd', 'extends Node\n')
  put(hum, 'tests/humus_params_smoke.gd', 'extends Node\n')
  for (let i = 1; i <= 5; i++) put(hum, `perks_v5/humus_farto_0${i}.tres`, '[gd_resource]\n')
  git(hum, 'init', '-q'); git(hum, 'add', '-A'); git(hum, 'commit', '-qm', 'base')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [{ id: 'hum', path: hum }] }))
  const pd = await import('../src/services/projectDiscovery.js')
  P = (await pd.addProjects([hum])).find(p => p.path === hum)
  svc = await import('../src/services/systemCatalog.js')
})
after(() => { for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true }) })

const ev = (path: string, needle?: string) => ({ path, ...(needle ? { needle } : {}) })
const view = async (id = 'sys-humus'): Promise<any> => { svc.resetCaches(); return svc.resolveSystem(P, id) }

// ---- pure: comparator (T3) ----------------------------------------------------------------------

const rec = (id: string, n: number, rows: { type: string; ref: string; excerpt: string[] }[]) => ({
  id, title: `First maturation cost ${n}`, claim: `Costs ${n}`, decisionState: 'unknown', approval: { state: 'unknown' },
  evidenceStatus: 'CURRENT', implementation: 'implemented', evidence: rows,
})

test('T3: 1000 vs 200 are compared side by side with source kinds, a unit only where a document states it, and no chosen side', () => {
  const c = sem.compareDecisions([
    rec('A', 1000, [{ type: 'code', ref: 'scripts/Params.gd#L11-L11', excerpt: ['L11: const FIRST_MATURATION_MATTER := 1000.0'] }]),
    rec('B', 200, [{ type: 'document_claim', ref: 'docs/report.md#L74-L74', excerpt: ['L74: custo padrão **200 de matéria** decidido'] },
      { type: 'test', ref: 'tests/panel.gd#L30-L30', excerpt: ['L30: "humus_to_mature": 200.0'] }]),
  ])
  assert.equal(c.numeric, true)
  assert.deepEqual(c.columns.map(x => x.key).sort(), ['1000', '200'])
  const k1000 = c.columns.find(x => x.key === '1000')!, k200 = c.columns.find(x => x.key === '200')!
  assert.equal(k1000.implemented, true)
  assert.equal(k1000.rows[0].unit, undefined, 'a code constant carries no unit')
  assert.equal(k200.implemented, false, 'a value found only in a document and a test fixture is not "observed in code"')
  assert.equal(k200.inTests, true)
  assert.equal(k200.rows.find(r => r.kind === 'document')?.unit, 'matéria')
  assert.match(c.approvalNote, /No human approval/)
  assert.match(c.approvalNote, /not that the rule was approved/)
  assert.equal(k1000.claimedBy[0].approval, 'not located')
  assert.equal(k1000.claimedBy[0].evidenceStatus, 'CURRENT', 'freshness stays a separate field')
})

test('T3: a textual conflict (no numbers) is compared claim by claim, not forced into numbers', () => {
  const mk = (id: string, claim: string) => ({ id, title: `Spore source ${id}`, claim, decisionState: 'unknown', evidenceStatus: 'CURRENT', implementation: 'unknown',
    evidence: [{ type: 'document_claim', ref: `docs/${id}.md#L1-L1`, excerpt: [`L1: ${claim}`] }] })
  const c = sem.compareDecisions([mk('X', 'Spores come from the cap'), mk('Y', 'Spores come from the stem')])
  assert.equal(c.numeric, false)
  assert.deepEqual(c.columns.map(x => x.key), ['X', 'Y'])
  assert.ok(c.columns.every(x => x.rows.length === 1))
})

test('dates and ids inside text are not mistaken for conflicting values', () => {
  assert.deepEqual(sem.numbersIn('decidido pelo dono em 2026-11-12 custo 200'), [200])
})

// ---- pure: relevance without noise (T2) ------------------------------------------------------------

test('T2: facets, test paths and resource families keep tests and generated files from dominating', () => {
  assert.equal(sem.facetOf('tests/humus_smoke.gd'), 'test')
  assert.equal(sem.facetOf('scripts/ui/HumusHud.gd'), 'ui')
  assert.equal(sem.facetOf('scripts/telemetry/HumusFlowTelemetry.gd'), 'telemetry')
  const f = sem.familiesOf(['perks_v5/a_01.tres', 'perks_v5/a_02.tres', 'perks_v5/a_03.tres', 'scripts/One.gd', 'perks_v5/b_01.tres'])
  assert.equal(f.families.length, 1)
  assert.equal(f.families[0].count, 3)
  assert.ok(f.rest.includes('scripts/One.gd') && f.rest.includes('perks_v5/b_01.tres'))
})

test('evidence: a moved file is followed, a vanished needle makes it stale, a missing file stays missing', async () => {
  const files = ['scripts/Renamed.gd', 'scripts/HumusReserve.gd']
  const ok = await sem.verifyEvidence(hum, files, ev('scripts/HumusReserve.gd', 'var reserve_humus := 0'))
  assert.equal(ok.state, 'verified'); assert.equal(ok.line, 2)
  const stale = await sem.verifyEvidence(hum, files, ev('scripts/HumusReserve.gd', 'var something_else'))
  assert.equal(stale.state, 'stale')
  const missing = await sem.verifyEvidence(hum, files, ev('scripts/Gone.gd', 'x'))
  assert.equal(missing.state, 'missing')
  assert.equal(sem.basisOf([ok]), 'demonstrated'); assert.equal(sem.basisOf([stale]), 'stale'); assert.equal(sem.basisOf([]), 'candidate')
})

// ---- service: areas, relations, provenance (T1, T5, T6, T8) -------------------------------------------

test('T1/T5: an agent proposal with areas and relations is stored as PROPOSED, never confirmed, and relations carry verified evidence', async () => {
  svc.resetCaches()
  const d = await svc.discover(P)
  assert.ok(!('error' in d))
  const res: any = await svc.propose('hum', {
    name: 'Humus', kind: 'system', summary: 'Collects and spends humus.',
    areas: [
      { id: 'acquisition', name: 'Matter acquisition', kind: 'mechanic', files: ['scripts/HumusCollector.gd'], evidence: [ev('scripts/HumusCollector.gd', 'func capture_clod(m)')] },
      { id: 'reserve', name: 'Reserve', kind: 'subsystem', files: ['scripts/HumusReserve.gd'], evidence: [ev('scripts/HumusReserve.gd', 'var reserve_humus := 0')] },
    ],
    relations: [
      { kind: 'produces', from: 'area:acquisition', to: 'ent:Humus', evidence: [ev('scripts/HumusCollector.gd', 'carried += m')] },
      { kind: 'stores', from: 'area:reserve', to: 'ent:Humus', evidence: [ev('scripts/HumusReserve.gd', 'var reserve_humus := 0')] },
      { kind: 'depends_on', from: 'sys:sys-fertility', to: 'area:reserve' },
    ],
  }, 'agent')
  assert.ok(res.id)
  const v = await view(res.id)
  assert.equal(v.kind, 'system')
  assert.equal(v.status === 'confirmed', false, 'an agent can never confirm')
  const a = v.areas.find((x: any) => x.id === 'acquisition')
  assert.equal(a.status, 'proposed'); assert.equal(a.basis, 'demonstrated'); assert.equal(a.inferred, false)
  const produced = v.relations.find((r: any) => r.kind === 'produces')
  assert.equal(produced.basis, 'demonstrated')
  assert.equal(produced.evidence[0].state, 'verified'); assert.equal(produced.evidence[0].line, 3)
  const unproven = v.relations.find((r: any) => r.kind === 'depends_on')
  assert.equal(unproven.basis, 'candidate', 'no evidence → candidate, never presented as demonstrated')
})

test('T5: technical (graph) links stay out of the gameplay relations and are never converted into them', async () => {
  const v = await view()
  assert.ok(v.relations.every((r: any) => ['produces', 'stores', 'consumes', 'modifies', 'unlocks', 'depends_on', 'controls', 'implemented_by', 'validated_by'].includes(r.kind)))
  assert.ok(!v.relations.some((r: any) => r.kind === 'imports_from' || r.kind === 'calls'))
  assert.ok(Array.isArray(v.technical))
})

test('map: every declared relation is drawn (evidence only changes its style), technical links are a separate layer', async () => {
  const v = await view()
  const def = buildSystemMap(v)
  assert.ok(def.edges.some(e => e.layer === 'gameplay' && e.basis === 'demonstrated'))
  assert.ok(def.edges.some(e => e.basis === 'candidate' && e.layer === 'gameplay'), 'a relation without evidence is still drawn')
  assert.equal(def.edges.filter(e => e.layer === 'gameplay').length, v.relations.length, 'one edge per declared relation')
  const ids = new Set(def.nodes.map(n => n.id))
  assert.ok(def.edges.every(e => ids.has(e.from) && ids.has(e.to)), 'every edge has both ends')
  assert.equal(new Set(def.nodes.map(n => n.id)).size, def.nodes.length, 'one node per identity')
  assert.ok(def.nodes.filter(n => n.type === 'area').every(n => n.column === 1))
  const again = buildSystemMap(v)
  assert.deepEqual(again.nodes.map(n => [n.id, n.x, n.y]), def.nodes.map(n => [n.id, n.x, n.y]), 'layout is deterministic')
})

test('T6/T2: resource files collapse into a family and tests are tiered apart from core', async () => {
  const v = await view()
  assert.ok(v.families.some((f: any) => f.count >= 5 && f.label.includes('humus_farto')), 'five .tres collapse into one family')
  assert.ok(!v.members.some((m: any) => m.path.endsWith('.tres')), 'individual .tres are not listed as members')
  assert.ok(v.tierCounts.test >= 2)
  assert.ok(v.members.filter((m: any) => m.tier === 'core').every((m: any) => m.role !== 'test'))
  const core = v.members.filter((m: any) => m.tier === 'core').map((m: any) => m.path)
  assert.ok(core.includes('scripts/HumusCollector.gd') && core.includes('scripts/HumusReserve.gd'))
})

test('T8: the agent brief separates facts, decisions and hypotheses and stays compact; an area narrows it', async () => {
  const v = await view()
  const full = svc.brief(v, 'Investigate')
  for (const h of ['## FACTS', '## DESIGN DECISIONS', '## HYPOTHESES', '## LIMITATIONS']) assert.ok(full.includes(h), h)
  assert.match(full, /HEAD: [0-9a-f]{7,}/)
  assert.match(full, /basis demonstrated/)
  assert.match(full, /NOT confirmed/)
  assert.match(full, /does not prove a gameplay relation/)
  assert.ok(full.length < 6000)
  const narrow = svc.brief(v, undefined, 'reserve')
  assert.match(narrow, /Selected responsibility: Reserve/)
  assert.ok(!narrow.includes('Matter acquisition (acquisition;'), 'other areas collapse out of a narrowed brief')
})

test('T9: without Design Knowledge nothing is invented; areas, relations and implementation still work', async () => {
  const v = await view()
  assert.equal(v.design.available, true)
  assert.deepEqual(v.design.decisions, [])
  assert.deepEqual(v.comparisons, [])
  assert.ok(v.areas.length >= 2 && v.members.length > 0)
  assert.ok(svc.brief(v).includes('None recorded'))
})

test('T5: worktree evidence is checked against its own unintegrated and dirty checkout', async () => {
  const wt = join(parent, 'hum-worktree')
  git(hum, 'worktree', 'add', '-qb', 'isolated-review', wt)
  try {
    put(wt, 'scripts/HumusReserve.gd', 'extends Node\n# reserve removed\n')
    git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'change reserve')
    put(wt, 'scripts/HumusNew.gd', 'extends Node\n')
    svc.resetCaches()
    const w: any = await svc.resolveSystem(P, 'sys-humus', wt)
    assert.equal(w.checkout.isCanonical, false)
    assert.match(w.checkout.integration, /NOT integrated/)
    assert.ok(w.checkout.uncommitted >= 1)
    assert.equal(w.relations.find((r: any) => r.kind === 'stores').basis, 'stale')
    assert.match(w.maintenance.graphAgainstCheckout, /different checkout/)
    const main = await view()
    assert.equal(main.relations.find((r: any) => r.kind === 'stores').basis, 'demonstrated')
  } finally {
    git(hum, 'worktree', 'remove', '--force', wt)
  }
})

// ---- maintenance (T7, Etapa G) --------------------------------------------------------------------------

test('T7: when the cited text disappears the relation goes stale; when it returns it is demonstrated again', async () => {
  put(hum, 'scripts/HumusReserve.gd', 'extends Node\n# reserve removed\n')
  let v = await view()
  const stored = v.relations.find((r: any) => r.kind === 'stores')
  assert.equal(stored.basis, 'stale')
  assert.equal(stored.status, 'proposed', 'a stale relation is not deleted')
  put(hum, 'scripts/HumusReserve.gd', RESERVE)
  v = await view()
  assert.equal(v.relations.find((r: any) => r.kind === 'stores').basis, 'demonstrated')
})

test('T7: renaming a cited file is followed (moved), not lost', async () => {
  git(hum, 'mv', 'scripts/HumusReserve.gd', 'scripts/HumusReserveStore.gd')
  try {
    const v = await view()
    const stored = v.relations.find((r: any) => r.kind === 'stores')
    assert.equal(stored.evidence[0].state, 'moved')
    assert.equal(stored.evidence[0].resolvedPath, 'scripts/HumusReserveStore.gd')
    assert.equal(stored.basis, 'demonstrated')
    assert.ok(v.members.some((m: any) => m.path === 'scripts/HumusReserveStore.gd' && m.movedFrom === 'scripts/HumusReserve.gd'))
  } finally {
    git(hum, 'mv', 'scripts/HumusReserveStore.gd', 'scripts/HumusReserve.gd')
  }
})

test('T7: re-resolving does not duplicate identities, and members that merely drop off the list are not "vanished"', async () => {
  // The previous test intentionally removed the temporary renamed path again.
  await view()
  await svc.review('hum', 'sys-humus', { ackVanished: true })
  svc.resetCaches()
  const before = (await svc.catalog(P) as any).systems.map((s: any) => s.id)
  for (let i = 0; i < 3; i++) { await view(); await svc.discover(P) }
  const after = (await svc.catalog(P) as any).systems.map((s: any) => s.id)
  assert.deepEqual(after.sort(), before.sort())
  const v = await view()
  assert.deepEqual(v.maintenance.vanished, [])
})

test('T7: a file that really disappears is reported as vanished, and a human classification is kept', async () => {
  const UI = { ok: true }
  await svc.review('hum', 'sys-humus', { status: 'confirmed', confirm: { areas: ['acquisition'] }, summary: 'Reviewed by a person.' })
  await view()
  git(hum, 'rm', '-q', 'scripts/HumusParams.gd')
  const v = await view()
  assert.ok(v.maintenance.vanished.some((x: any) => x.key === 'file:scripts/HumusParams.gd'))
  assert.equal(v.status, 'confirmed'); assert.equal(v.summary, 'Reviewed by a person.')
  assert.equal(v.areas.find((a: any) => a.id === 'acquisition').status, 'confirmed')
  void UI
})

test('T7: an agent proposal never overwrites a confirmed system or area; it becomes a pending suggestion', async () => {
  await svc.propose('hum', { name: 'Humus', summary: 'Agent rewrite', areas: [{ id: 'acquisition', name: 'Rewritten', files: ['scripts/HumusCollector.gd'] }] }, 'agent')
  const v = await view()
  assert.equal(v.summary, 'Reviewed by a person.')
  assert.equal(v.areas.find((a: any) => a.id === 'acquisition').name, 'Matter acquisition')
  assert.ok(v.suggestions.length >= 1)
})

test('T7: split moves an area with its relations; merge unions areas without renaming confirmed ones', async () => {
  const s: any = await svc.split('hum', 'sys-humus', { name: 'Humus reserve', files: ['scripts/HumusReserve.gd'] })
  assert.ok(s?.id)
  const parentV = await view('sys-humus')
  assert.ok(!parentV.areas.some((a: any) => a.id === 'reserve'), 'the area moved with its anchors')
  const child = await view(s.id)
  assert.ok(child.areas.some((a: any) => a.id === 'reserve'))
  await svc.merge('hum', 'sys-humus', [s.id])
  const merged = await view('sys-humus')
  assert.ok(merged.areas.some((a: any) => a.id === 'reserve') && merged.areas.some((a: any) => a.id === 'acquisition'))
  assert.equal(merged.areas.find((a: any) => a.id === 'acquisition').status, 'confirmed')
})

// ---- MCP and the rule that agents only propose --------------------------------------------------------

test('MCP: propose_system accepts areas and relations; there is no confirm/approve tool; get_system takes an area', async () => {
  const mcp = await import('../src/services/mcpServer.js')
  const t: any = mcp.MCP_TOOLS.find(x => x.name === 'propose_system')
  assert.ok(t.inputSchema.properties.areas && t.inputSchema.properties.relations && t.inputSchema.properties.kind)
  assert.ok(mcp.MCP_TOOLS.find(x => x.name === 'get_system')!.inputSchema.properties.areaId)
  assert.ok(!mcp.MCP_TOOLS.some(x => /confirm|approve/i.test(x.name)))
  const out: any = await mcp.proposeSystem('hum', { systemId: 'sys-humus', areas: [{ name: 'Telemetry', files: ['scripts/telemetry/HumusFlowTelemetry.gd'] }] } as any)
  assert.ok(!out.isError)
  const brief: any = await mcp.getSystem('hum', 'sys-humus', undefined, 'acquisition')
  assert.match(brief.content[0].text, /Selected responsibility/)
})

test('source: the new view fields exist in the stored shape only as identity, never as derived facts', () => {
  const stored = JSON.parse(readFileSync(join(dataDir, 'systems', 'hum.json'), 'utf8'))
  const s = stored.systems.find((x: any) => x.id === 'sys-humus')
  for (const a of s.areas ?? []) assert.ok(!('files' in a) && !('basis' in a) && !('fileCount' in a), 'no derived member list persisted in areas')
  for (const r of s.relations ?? []) assert.ok(!('basis' in r), 'basis is derived on read, not stored')
})
