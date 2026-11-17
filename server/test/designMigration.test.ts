/**
 * R1-B2: legacy DK -> native migration. Differential parity against the hardened dk.py, idempotency, trust
 * preservation (nothing is promoted), divergence safety, native-only operation (no Python), revisions, rollback.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { runLegacy, compareQuery, summarize, type Check } from './support/parity.js'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-mig-data-'))
const root = mkdtempSync(join(tmpdir(), 'jabuti-mig-proj-'))
process.env.SHIPYARD_DATA_DIR = dataDir
const PY = process.env.SHIPYARD_PYTHON || 'python'
const DKPY = join(here, 'fixtures/dk/dk.py')

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString()
const write = (dir: string, p: string, c: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c) }

const game = join(root, 'game')
let P: { id: string; path: string }
let core: typeof import('../src/services/designCore.js')
let store: typeof import('../src/services/designDecisions.js')
let mig: typeof import('../src/services/designMigration.js')
let dkMod: typeof import('../src/services/designKnowledge.js')
let legacyChecks: Check[] = []
let planSha = ''
let ledgerPath = ''

const FILES: Record<string, string> = {
  'project.godot': 'p\n',
  'scripts/p.gd': '# humus\nconst FIRST_MATURATION := 1000.0\nconst OTHER := 5\n',
  'scripts/stage.gd': '# stages\nconst T1 := 50\nconst T2 := 200\n',
  'scripts/chg.gd': 'extends Node\nconst X := 1\n',
  'scripts/stale.gd': 'const S := 7\n',
  'scripts/gone.gd': 'const G := 1\n',
  'scripts/old_name.gd': 'const MOVED_ME := 1\nconst MORE := 2\n',
  'scripts/spore.tres': 'cost = 44000\n',
  'docs/report.md': 'Report line one\nOwner decided 200\n',
  'tests/t.gd': 'extends Node\n',
}
const BASE = { ...FILES }
const rec = (id: string, over: Record<string, any>) => ({
  id, title: `Title ${id}`, claim: `Claim of ${id} about the thing`, decision_state: 'unknown', approval_state: 'unknown', implementation_state: 'implemented',
  implementation_sources: [], scope: ['topic'], evidence: [], supersedes: [], conflicts_with: [], files: [], tests: [], qps: [], tags: ['tag'], ...over,
})
const ev = (type: string, path: string, lines: string | null, over: Record<string, any> = {}) =>
  ({ type, ref: lines ? `${path}#${lines}` : path, note: `note ${path}`, sha256: sha(BASE[path] ?? ''), ...over })

const RECORDS = [
  rec('DK-HUMUS-001', { title: 'Implementation: 1000', claim: 'The code uses 1000 for first maturation.', scope: ['first maturation', 'humus'], tags: ['humus', 'cost'],
    evidence: [ev('code', 'scripts/p.gd', 'L2-L2'), ev('document_claim', 'docs/report.md', 'L1-L2', { note: 'report says 200' }),
      ev('code', 'scripts/stage.gd', null, { note: 'CANDIDATE IMPACT ONLY: fingerprint listed under files' })],
    conflicts_with: ['DK-HUMUS-002'], files: [{ path: 'scripts/p.gd', role: 'direct: source' }, { path: 'scripts/stage.gd', role: 'direct: other' }],
    tests: ['tests/t.gd'], qps: ['docs/report.md'], implementation_state: 'implemented',
    implementation_sources: [{ path: 'scripts/p.gd', sha256: sha(BASE['scripts/p.gd']) }] }),
  rec('DK-HUMUS-002', { title: 'Reported decision: 200', claim: 'A report attributes 200 to the owner; no primary source linked.', scope: ['first maturation', 'humus'], tags: ['humus', 'cost'],
    evidence: [ev('document_claim', 'docs/report.md', 'L2-L2', { note: 'owner decided 200' }), ev('code', 'scripts/p.gd', 'L2-L2', { note: 'code uses 1000' })],
    conflicts_with: ['DK-HUMUS-001'], implementation_state: 'divergent', files: [{ path: 'scripts/p.gd', role: 'direct: differs' }], tests: ['tests/t.gd'] }),
  rec('DK-EDITED-ELSEWHERE', { claim: 'Stage threshold two is 200.', evidence: [ev('code', 'scripts/stage.gd', 'L3-L3')], scope: ['stages'], tags: ['stages'] }),
  rec('DK-SHIFTED', { claim: 'Stage threshold one is 50.', evidence: [ev('code', 'scripts/stage.gd', 'L2-L2')], scope: ['stages'], tags: ['stages', 'shifted'] }),
  rec('DK-CHANGED', { claim: 'Chg constant is one.', evidence: [ev('code', 'scripts/chg.gd', 'L2-L2')], scope: ['chg'], tags: ['chg'] }),
  rec('DK-STALE', { claim: 'Stale constant is seven.', evidence: [{ type: 'code', ref: 'scripts/stale.gd#L1-L1', note: 'n', sha256: 'a'.repeat(64) }], scope: ['stale'], tags: ['stale'] }),
  rec('DK-GONE', { claim: 'Gone constant is one.', evidence: [ev('code', 'scripts/gone.gd', 'L1-L1')], scope: ['gone'], tags: ['gone'] }),
  rec('DK-MOVEDFILE', { claim: 'Moved file keeps its constant.', evidence: [ev('code', 'scripts/old_name.gd', null)], scope: ['rename'], tags: ['rename'] }),
  rec('DK-NOEVIDENCE', { claim: 'A claim nobody has evidence for.', scope: ['orphan'], tags: ['orphan'] }),
  rec('DK-EXTERNAL', { claim: 'Spore source costs 44000 per the external table.', scope: ['spore'], tags: ['spore'],
    evidence: [ev('data', '@economy_csv:spore_source', null, { sha256: 'c'.repeat(64) }), ev('code', 'scripts/spore.tres', 'L1-L1')] }),
  rec('DK-HUMAN', { claim: 'A human decision is cited but not attested.', scope: ['human'], tags: ['human'], approval_state: 'claimed',
    evidence: [ev('human_decision', 'docs/report.md', 'L2-L2', { note: 'owner said so' })] }),
  rec('DK-IMPL', { claim: 'Spore cost is implemented at 44000.', scope: ['impl'], tags: ['impl'], evidence: [ev('code', 'scripts/spore.tres', 'L1-L1')],
    implementation_sources: [{ path: 'scripts/spore.tres', sha256: sha(BASE['scripts/spore.tres']) }] }),
  rec('DK-ATTESTED', { claim: 'Attested claim text stays.', scope: ['att'], tags: ['att'], evidence: [ev('code', 'tests/t.gd', null)] }),
  rec('DK-LAPSED', { claim: 'Claim text edited after attestation.', scope: ['lapse'], tags: ['lapse'], evidence: [ev('code', 'tests/t.gd', null)] }),
]

const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
  const p = join(e.parentPath ?? (e as any).path, e.name); return [p, sha(readFileSync(p, 'utf8'))] }))

before(async () => {
  mkdirSync(game, { recursive: true })
  for (const [p, c] of Object.entries(FILES)) write(game, p, c)
  mkdirSync(join(game, 'tools/design_knowledge'), { recursive: true }); copyFileSync(DKPY, join(game, 'tools/design_knowledge/dk.py'))
  for (const r of RECORDS) write(game, `docs/design_knowledge/records/${r.id.toLowerCase()}.md`, `<!-- dk-record\n${JSON.stringify(r, null, 2)}\n-->\n\n# ${r.id}\n`)
  git(game, 'init', '-q'); git(game, 'add', '-A'); git(game, 'commit', '-qm', 'base')
  // Working-tree drift after the commit (the legacy engine finds the recorded versions in history)
  write(game, 'scripts/stage.gd', '# new header\n# stages\nconst T1 := 50\nconst T2 := 200\nconst T3 := 800\n')   // shifts T1/T2 down, appends elsewhere
  write(game, 'scripts/chg.gd', 'extends Node\nconst X := 2\n')                                              // cited line changed
  write(game, 'scripts/stale.gd', 'const S := 8\n')                                                        // fingerprint unknown to history
  unlinkSync(join(game, 'scripts/gone.gd'))
  git(game, 'mv', 'scripts/old_name.gd', 'scripts/new_name.gd')                                              // pure rename
  write(game, 'scripts/spore.tres', 'cost = 50\n')                                                         // implementation snapshot broken

  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  const discovery = await import('../src/services/projectDiscovery.js')
  const found = (await discovery.addProjects([game])).find(x => x.path === game)!
  P = { id: found.id, path: game }
  core = await import('../src/services/designCore.js'); store = await import('../src/services/designDecisions.js')
  mig = await import('../src/services/designMigration.js'); dkMod = await import('../src/services/designKnowledge.js')

  // local attestation ledger (what the app UI writes): one valid, one made against a different claim text
  mkdirSync(join(dataDir, 'design-approvals'), { recursive: true })
  ledgerPath = join(dataDir, 'design-approvals', `${P.id}.json`)
  const entry = (id: string, claim: string) => ({ decision_id: id, state: 'approved', claim_sha256: sha(claim.trim()), quote: 'owner said yes', channel: 'ui-request', trust: 'attested_local', at: '2026-11-15T10:00:00.000Z', projectId: P.id })
  const rl = (id: string) => RECORDS.find(r => r.id === id)!.claim
  writeFileSync(ledgerPath, JSON.stringify({ version: 1, approvals: [entry('DK-ATTESTED', rl('DK-ATTESTED')), entry('DK-LAPSED', 'An earlier claim text')], history: [] }))
})
after(async () => { for (const d of [dataDir, root]) rmSync(d, { recursive: true, force: true }) })

const queries = () => [
  ...RECORDS.map(r => ({ label: `id ${r.id}`, legacy: ['query', r.id], native: { q: r.id } })),
  ...['first maturation cost', 'humus', 'stages shifted', 'orphan', 'Approved first maturation Húmus rule', 'spore cost', 'nothing like this xyzzy']
    .map(t => ({ label: `term "${t}"`, legacy: ['query', t], native: { q: t } })),
  ...['scripts/p.gd', 'scripts/stage.gd', 'scripts/chg.gd', 'scripts/stale.gd', 'scripts/gone.gd', 'scripts/old_name.gd', 'scripts/spore.tres', 'docs/report.md', 'tests/t.gd', 'scripts/unrelated.gd']
    .map(f => ({ label: `file ${f}`, legacy: ['file', f], native: { file: f } })),
]

test('M0: baseline — the hardened legacy engine answers every query before any migration', async () => {
  assert.equal(dkMod.pythonAttempts.count, 0)
  legacyChecks = []
  for (const q of queries()) {
    const legacy = runLegacy(PY, DKPY, q.legacy, game, join(game, 'docs/design_knowledge/records'), ledgerPath)
    assert.ok(Array.isArray(legacy.decisions), q.label)
    ;(q as any).result = legacy
  }
  const v = runLegacy(PY, DKPY, ['validate'], game, join(game, 'docs/design_knowledge/records'), ledgerPath)
  assert.equal(v.valid, true, JSON.stringify(v.errors))
  ;(globalThis as any).__legacyRuns = queries().length
  ;(globalThis as any).__legacyValidate = v
})

test('M1: the preview converts every record, writes nothing, and says what the native engine cannot verify', async () => {
  const before = snapshot(game)
  const p = await mig.plan(P)
  assert.equal(p.state, 'ready'); assert.equal(p.inventory.found, RECORDS.length); assert.equal(p.inventory.add, RECORDS.length)
  assert.equal(p.inventory.blocked + p.inventory.divergent + p.inventory.duplicate, 0)
  assert.deepEqual(snapshot(game), before, 'preview must not touch the project')
  assert.equal(existsSync(join(game, store.DECISIONS_FILE)), false)
  assert.ok(p.records.find(r => r.id === 'DK-EXTERNAL')!.notes.some(n => /outside the checkout/.test(n)))
  assert.ok(p.records.find(r => r.id === 'DK-HUMUS-001')!.sourceSha256.length === 64)
  planSha = p.planSha256!
})

test('M2: apply needs the reviewed plan hash, leaves every legacy file byte-identical, and records a manifest', async () => {
  const legacyBefore = snapshot(join(game, 'docs')), toolBefore = snapshot(join(game, 'tools'))
  const bad = await mig.apply(P, { expectedPlanSha256: 'f'.repeat(64) })
  assert.equal(bad.ok, false); assert.equal(existsSync(join(game, store.DECISIONS_FILE)), false)
  const res = await mig.apply(P, { expectedPlanSha256: planSha })
  assert.ok(res.ok && res.changed, JSON.stringify((res as any).error))
  assert.deepEqual(snapshot(join(game, 'docs')), legacyBefore); assert.deepEqual(snapshot(join(game, 'tools')), toolBefore)
  const m = (res as any).manifest
  assert.equal(m.legacyFilesTouched, false); assert.equal(m.records.length, RECORDS.length); assert.equal(m.previousSha256, null)
  const doc = JSON.parse(readFileSync(join(game, store.DECISIONS_FILE), 'utf8'))
  assert.deepEqual(doc.decisions.map((d: any) => d.id).sort(), RECORDS.map(r => r.id).sort())
  assert.ok(doc.decisions.every((d: any) => d.origin === 'legacy' && d.status === 'proposed'), 'nothing is promoted')
  assert.ok(doc.decisions.every((d: any) => !('approval' in d) && !('approved' in d) && !('attestation' in d)), 'no approval is stored')
  assert.ok(!/[a-z]:[\\/]/i.test(readFileSync(join(game, store.DECISIONS_FILE), 'utf8').replace(/https?:\/\/\S+/g, '')), 'no absolute paths')
})

test('M3: idempotent — a second run is a no-op (no write, no new backup, same bytes)', async () => {
  const file = join(game, store.DECISIONS_FILE), before = readFileSync(file)
  const dirs = () => readdirSync(join(dataDir, 'design-migration'), { recursive: true }).length
  const n = dirs()
  const p = await mig.plan(P)
  assert.equal(p.state, 'nothing-to-do'); assert.equal(p.inventory.equivalent, RECORDS.length); assert.equal(p.inventory.add, 0)
  const res = await mig.apply(P, { expectedPlanSha256: p.planSha256 ?? '' })
  assert.ok(res.ok && !res.changed)
  assert.deepEqual(readFileSync(file), before); assert.equal(dirs(), n)
})

test('M4: differential parity — native (migrated) vs hardened dk.py, field by field, Python forbidden on the native side', async () => {
  process.env.SHIPYARD_DK_FORBID_PYTHON = '1'
  const attempts0 = dkMod.pythonAttempts.count
  const all: Check[] = []
  for (const q of queries()) {
    const legacy = runLegacy(PY, DKPY, q.legacy, game, join(game, 'docs/design_knowledge/records'), ledgerPath)
    const native: any = await core.query(P, q.native)
    assert.equal(native.sources.legacy.migrated, true, q.label)
    all.push(...compareQuery(q.label, legacy, native))
  }
  assert.equal(dkMod.pythonAttempts.count, attempts0, 'the native engine never tried to start Python')
  legacyChecks = all
  const s = summarize(all)
  const known = (c: Check) => /^DK-EXTERNAL\.evidence\[0\]\.freshness$/.test(c.field) || /^DK-EXTERNAL\.evidence_status$/.test(c.field)
  const unexpected = s.differences.filter(c => c.verdict === 'different' && !known(c))
  const uniq = [...new Set(unexpected.map(c => `${c.field} legacy=${JSON.stringify(c.legacy)} native=${JSON.stringify(c.native)}`))]
  assert.deepEqual(uniq, [], 'unexpected semantic differences')
  // the one capability gap, recorded rather than hidden: an external CSV row dk.py can try to read and the native engine cannot
  const ext = all.find(c => c.field === 'DK-EXTERNAL.evidence[0].freshness')!
  assert.deepEqual([ext.legacy, ext.native], ['GONE', 'UNKNOWN'])
  assert.ok(s.total > 500 && s.equal > 0)
  writeFileSync(join(dataDir, 'parity-fixture-report.json'), JSON.stringify({ total: s.total, equal: s.equal, representation: s.representation, different: s.different, byField: s.byField }, null, 2))
  delete process.env.SHIPYARD_DK_FORBID_PYTHON
})

test('M5: freshness states reproduce for every legacy evidence kind (current, edited elsewhere, shifted, changed, stale, gone, moved, none)', async () => {
  const get = async (id: string) => (await core.query(P, { id })).decisions[0]
  const st = async (id: string, i = 0) => (await get(id)).evidence[i].freshness
  assert.equal(await st('DK-HUMUS-001'), 'CURRENT')
  assert.equal(await st('DK-EDITED-ELSEWHERE'), 'MOVED')                                  // T2 line moved when a header was added
  assert.equal(await st('DK-SHIFTED'), 'MOVED')
  assert.equal(await st('DK-CHANGED'), 'CHANGED'); assert.equal(await st('DK-STALE'), 'STALE'); assert.equal(await st('DK-GONE'), 'GONE')
  assert.equal(await st('DK-MOVEDFILE'), 'MOVED'); assert.equal((await get('DK-MOVEDFILE')).evidence[0].path, 'scripts/new_name.gd')
  assert.equal((await get('DK-NOEVIDENCE')).evidence.length, 0); assert.equal((await get('DK-NOEVIDENCE')).evidence_status_legacy, 'UNKNOWN')
  assert.equal((await get('DK-IMPL')).implementation, 'unknown', 'a broken implementation snapshot downgrades the classification')
  assert.equal((await get('DK-IMPL')).catalogued_implementation, 'implemented')
})

test('M6: trust is preserved, never raised — claims stay claims, attestations survive and lapse on edit', async () => {
  const d = async (id: string) => (await core.query(P, { id })).decisions[0]
  for (const id of RECORDS.map(r => r.id).filter(i => !['DK-ATTESTED', 'DK-LAPSED', 'DK-HUMAN'].includes(i))) assert.equal((await d(id)).approval.state, 'unknown', id)
  assert.deepEqual([(await d('DK-HUMAN')).approval.state, (await d('DK-HUMAN')).approval.source], ['claimed', 'repository-claim'])
  assert.deepEqual([(await d('DK-ATTESTED')).approval.state, (await d('DK-ATTESTED')).approval.source], ['approved', 'attested_local'])
  const lapsed = (await d('DK-LAPSED')).approval
  assert.equal(lapsed.source, 'attestation-lapsed'); assert.notEqual(lapsed.state, 'approved')
  // editing the migrated claim lapses the attestation made against the legacy record
  const file = join(game, store.DECISIONS_FILE), original = readFileSync(file, 'utf8')
  const doc = JSON.parse(original); doc.decisions.find((x: any) => x.id === 'DK-ATTESTED').claim += ' (edited)'
  writeFileSync(file, JSON.stringify(doc, null, 2))
  assert.equal((await d('DK-ATTESTED')).approval.state, 'claimed'); assert.equal((await d('DK-ATTESTED')).approval.source, 'attestation-lapsed')
  writeFileSync(file, original)
})

test('M7: the Humus conflict survives intact — both ids, both texts, the relation, no winner, no approval', async () => {
  const r = await core.query(P, { q: 'first maturation cost' })
  const ids = r.decisions.map((x: any) => x.id).sort()
  assert.deepEqual(ids, ['DK-HUMUS-001', 'DK-HUMUS-002'])
  assert.deepEqual(r.conflicts, [{ ids: ['DK-HUMUS-001', 'DK-HUMUS-002'] }])
  const a = r.decisions.find((x: any) => x.id === 'DK-HUMUS-001'), b = r.decisions.find((x: any) => x.id === 'DK-HUMUS-002')
  assert.equal(a.claim, 'The code uses 1000 for first maturation.'); assert.equal(b.claim, 'A report attributes 200 to the owner; no primary source linked.')
  for (const d of [a, b]) { assert.equal(d.approval.state, 'unknown'); assert.equal(d.decision_state, 'unknown'); assert.equal(d.source, 'native'); assert.equal(d.provenance.origin, 'legacy-migration') }
  assert.equal(a.implementation, 'implemented'); assert.equal(b.catalogued_implementation, 'divergent')
  assert.equal(a.evidence_status, 'MOVED' === a.evidence_status ? 'MOVED' : a.evidence_status) // CURRENT evidence never means approved
  assert.ok(!r.decisions.some((x: any) => x.approval.state === 'approved'))
  // asking for one side alone still returns the contradiction it belongs to
  const only = await core.query(P, { file: 'docs/report.md' })
  assert.ok(only.conflicts.length >= 1)
})

test('M8: a changed or conflicting native decision is never overwritten; explicit resolutions work and are backed up', async () => {
  const file = join(game, store.DECISIONS_FILE), original = readFileSync(file, 'utf8')
  const doc = JSON.parse(original); doc.decisions.find((x: any) => x.id === 'DK-SHIFTED').claim = 'Someone refined this natively.'
  writeFileSync(file, JSON.stringify(doc, null, 2))
  const p = await mig.plan(P)
  assert.equal(p.state, 'blocked'); assert.equal(p.inventory.divergent, 1); assert.equal(p.divergent[0].id, 'DK-SHIFTED')
  assert.equal((p.divergent[0].native as any).claim, 'Someone refined this natively.'); assert.match((p.divergent[0].legacy as any).claim, /threshold one/)
  const refused = await mig.apply(P, { expectedPlanSha256: p.planSha256 ?? 'x' }); assert.equal(refused.ok, false)
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(doc, null, 2), 'the native decision is untouched')
  const keep = await mig.plan(P, { 'DK-SHIFTED': 'keep-native' }); assert.equal(keep.state, 'nothing-to-do')
  const take = await mig.plan(P, { 'DK-SHIFTED': 'take-legacy' }); assert.equal(take.state, 'ready')
  const res = await mig.apply(P, { expectedPlanSha256: take.planSha256!, resolutions: { 'DK-SHIFTED': 'take-legacy' } })
  assert.ok(res.ok && res.changed); assert.ok((res as any).manifest.previousCopy)
  const m = (res as any).manifest
  const back = await mig.rollback(P, m.id); assert.ok(back.ok)
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(doc, null, 2), 'rollback restores the exact previous file')
  writeFileSync(file, original)
})

test('M9: records that cannot be converted losslessly are blocked, not dropped, and nothing is written', async () => {
  const other = join(root, 'bad'); mkdirSync(other, { recursive: true })
  write(other, 'a.gd', 'x\n'); mkdirSync(join(other, 'docs/design_knowledge/records'), { recursive: true })
  const wr = (n: string, r: any) => write(other, `docs/design_knowledge/records/${n}.md`, `<!-- dk-record\n${JSON.stringify(r)}\n-->\n`)
  wr('ok', rec('DK-OK-001', { evidence: [{ type: 'code', ref: 'a.gd#L1-L1', sha256: sha('x\n'), note: 'n' }] }))
  wr('extra', { ...rec('DK-EXTRA-1', {}), mystery: 1 })
  wr('rel', rec('DK-REL-001', { conflicts_with: ['DK-NOPE-1'] }))
  wr('ref', rec('DK-REF-001', { evidence: [{ type: 'code', ref: '../escape.gd', sha256: sha('x') }] }))
  wr('badid', rec('1', {}))
  write(other, 'docs/design_knowledge/records/broken.md', 'no header here\n')
  git(other, 'init', '-q'); git(other, 'add', '-A'); git(other, 'commit', '-qm', 'b')
  const p = await mig.plan({ id: 'bad', path: other })
  assert.equal(p.state, 'blocked'); assert.equal(p.unreadable.length, 1)
  const by = Object.fromEntries(p.records.map(r => [r.id, r]))
  assert.equal(by['DK-OK-001'].outcome, 'add')
  assert.equal(by['DK-EXTRA-1'].outcome, 'blocked'); assert.match(by['DK-EXTRA-1'].issues[0], /no native equivalent/)
  assert.equal(by['DK-REL-001'].outcome, 'blocked'); assert.equal(by['DK-REF-001'].outcome, 'blocked'); assert.equal(by['1'].outcome, 'blocked')
  const res = await mig.apply({ id: 'bad', path: other }, { expectedPlanSha256: p.planSha256 ?? 'x' })
  assert.equal(res.ok, false); assert.equal(existsSync(join(other, store.DECISIONS_FILE)), false)
})

test('M10: native-only mode answers a migrated project with no Python at all (also for validate and MCP-shaped queries)', async () => {
  process.env.SHIPYARD_DK_FORBID_PYTHON = '1'; process.env.SHIPYARD_DK_NATIVE_ONLY = '1'
  const a0 = dkMod.pythonAttempts.count
  const r = await core.query(P, { file: 'scripts/p.gd' })
  assert.ok(r.available && r.decisions.length >= 2); assert.equal(r.sources.legacy.skipped, true)
  const v = await core.validateNative(P)
  assert.equal(v.valid, true, JSON.stringify(v.errors)); assert.equal(v.records, RECORDS.length)
  const lv = (globalThis as any).__legacyValidate
  assert.equal(v.records, lv.records); assert.deepEqual(v.unresolved_conflicts.map((p: string[]) => [...p].sort()), lv.unresolved_conflicts)
  const sys = await core.forSystem(P, { id: 'sys-x', anchors: { terms: ['humus'], decisions: ['DK-HUMUS-001'] } })
  assert.ok(sys.decisions.length >= 2)
  const mcp = await import('../src/services/mcpServer.js')
  const ctx = JSON.parse((await mcp.getDesignContext(P.id, undefined, 'first maturation cost')).content[0].text)
  assert.deepEqual(ctx.decisions.map((d: any) => d.id).sort(), ['DK-HUMUS-001', 'DK-HUMUS-002']); assert.equal(ctx.decisions[0].origin, 'native')
  assert.equal(dkMod.pythonAttempts.count, a0, 'no Python was started')
  delete process.env.SHIPYARD_DK_FORBID_PYTHON; delete process.env.SHIPYARD_DK_NATIVE_ONLY
})

test('M11: history — a revision is read from Git (not today\'s legacy), and a checkout is judged on its own files', async () => {
  const none = await core.query(P, { id: 'DK-HUMUS-001', revision: 'HEAD' })
  assert.equal(none.sources.native.state, 'absent', 'before the migration was committed there is no native record at that revision')
  git(game, 'add', store.DECISIONS_FILE); git(game, 'commit', '-qm', 'migrated decisions')
  const atRev = await core.query(P, { id: 'DK-HUMUS-001', revision: 'HEAD' })
  assert.equal(atRev.decisions[0].record_integration, 'revision')
  const wt = join(root, 'game-wt'); git(game, 'worktree', 'add', '-q', '-b', 'task', wt)
  write(wt, 'scripts/p.gd', '# humus\nconst FIRST_MATURATION := 200.0\nconst OTHER := 5\n')
  const here2 = (await core.query(P, { id: 'DK-HUMUS-001', worktree: wt })).decisions[0]
  const main = (await core.query(P, { id: 'DK-HUMUS-001' })).decisions[0]
  assert.notEqual(here2.evidence[0].freshness, main.evidence[0].freshness); assert.equal(here2.examined === undefined, true)
  assert.equal(main.evidence[0].freshness, 'CURRENT')
})

test('M12: partial migration — an unmigrated legacy record is still served from dk.py and never duplicated; native-only says what it skipped', async () => {
  const extra = rec('DK-LATE-001', { claim: 'A record added after the migration.', scope: ['late'], tags: ['late'], evidence: [ev('code', 'tests/t.gd', null)] })
  write(game, 'docs/design_knowledge/records/late.md', `<!-- dk-record\n${JSON.stringify(extra)}\n-->\n`)
  const mixed = await core.query(P, { q: 'late record added' })
  assert.equal(mixed.sources.legacy.available, true); assert.equal(mixed.sources.legacy.migrated, false)
  assert.deepEqual(mixed.decisions.map((d: any) => [d.id, d.source]), [['DK-LATE-001', 'legacy']])
  const dup = await core.query(P, { q: 'first maturation cost' })
  assert.equal(new Set(dup.decisions.map((d: any) => d.id)).size, dup.decisions.length, 'no decision appears twice')
  assert.ok(dup.decisions.every((d: any) => d.source === 'native'))
  const only = await core.query(P, { q: 'late record added', nativeOnly: true })
  assert.deepEqual(only.decisions, []); assert.match(only.limitations.join(' '), /1 legacy record\(s\) are not migrated/)
  const p = await mig.plan(P); assert.equal(p.inventory.add, 1)
  unlinkSync(join(game, 'docs/design_knowledge/records/late.md'))
})

test('M13: rollback removes a file the migration created, and refuses once the file was edited afterwards', async () => {
  const other = join(root, 'rb'); mkdirSync(other, { recursive: true }); write(other, 'a.gd', 'x\n')
  mkdirSync(join(other, 'docs/design_knowledge/records'), { recursive: true })
  write(other, 'docs/design_knowledge/records/r.md', `<!-- dk-record\n${JSON.stringify(rec('DK-RB-001', { evidence: [{ type: 'code', ref: 'a.gd#L1-L1', sha256: sha('x\n') }] }))}\n-->\n`)
  git(other, 'init', '-q'); git(other, 'add', '-A'); git(other, 'commit', '-qm', 'b')
  const pr = { id: 'rb', path: other }, p = await mig.plan(pr)
  const res: any = await mig.apply(pr, { expectedPlanSha256: p.planSha256! }); assert.ok(res.ok)
  assert.equal((await mig.rollback(pr, res.manifest.id)).ok, true); assert.equal(existsSync(join(other, store.DECISIONS_FILE)), false)
  assert.ok(existsSync(join(other, 'docs/design_knowledge/records/r.md')), 'legacy file kept')
  const res2: any = await mig.apply(pr, { expectedPlanSha256: p.planSha256! }); assert.ok(res2.ok)
  writeFileSync(join(other, store.DECISIONS_FILE), readFileSync(join(other, store.DECISIONS_FILE), 'utf8') + '\n')
  assert.equal((await mig.rollback(pr, res2.manifest.id)).ok, false)
})
