/**
 * Review queue and attestation guard. The queue logic is pure (client/src/lib/designReview.ts) and the write goes
 * through the existing route POST /design/approve into the existing ledger; nothing else is created here.
 * Covers: a project-wide list of native decisions, the three approval tiers kept apart, approval bound to the exact
 * claim hash (a changed text is refused with 409 and writes nothing), UI-only writes, and persistence across a fresh app.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  tierOf, filterQueue, queueCounts, resolveIndex, approvalGuard, conflictSides, matchesQuery, reviewBriefing, TIER_LABEL,
} from '../../client/src/lib/designReview.js'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-review-data-'))
const root = mkdtempSync(join(tmpdir(), 'jabuti-review-proj-'))
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString()
const beats = join(root, 'beats')
const SONG = 'extends Node\nconst PERFECT_WINDOW_MS := 45\nconst GOOD_WINDOW_MS := 90\n'
const UI = { origin: 'http://127.0.0.1:5420', host: '127.0.0.1:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }
let app: import('fastify').FastifyInstance
let projectId = ''
let core: typeof import('../src/services/designCore.js')
let DEC_A = '', DEC_B = ''

before(async () => {
  mkdirSync(join(beats, 'scripts'), { recursive: true })
  writeFileSync(join(beats, 'project.godot'), 'config_version=5\n')
  writeFileSync(join(beats, 'scripts/rhythm.gd'), SONG)
  git(beats, 'init', '-q'); git(beats, 'add', '-A'); git(beats, 'commit', '-qm', 'base')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  const discovery = await import('../src/services/projectDiscovery.js')
  const list = await discovery.addProjects([beats])
  projectId = list.find(x => x.path === beats)!.id
  core = await import('../src/services/designCore.js')
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/design.js')).designRoutes)
  const ev = [{ type: 'code' as const, path: 'scripts/rhythm.gd', needle: 'PERFECT_WINDOW_MS := 45', note: 'perfect window' }]
  const a = await core.propose({ id: projectId, path: beats }, { title: 'Perfect window is 45 ms', claim: 'A perfect hit is within 45 ms.', scope: ['timing'], evidence: ev, origin: 'agent' })
  const b = await core.propose({ id: projectId, path: beats }, { title: 'Good window is 90 ms', claim: 'A good hit is within 90 ms.', scope: ['timing'], evidence: ev, origin: 'user' })
  assert.ok(a.ok && b.ok)
  DEC_A = (a as any).decision.id; DEC_B = (b as any).decision.id
})
after(async () => { await app?.close(); for (const d of [dataDir, root]) rmSync(d, { recursive: true, force: true }) })

const url = (p: string) => `/api/projects/${projectId}/design/${p}`
const listOnce = async () => (await app.inject({ method: 'GET', url: url('decisions') })).json() as { available: boolean; decisions: any[] }

test('R1: the project-wide list returns every native decision with its real approval tier', async () => {
  const r = await listOnce()
  assert.equal(r.available, true)
  assert.deepEqual(r.decisions.map(d => d.id).sort(), [DEC_A, DEC_B].sort())
  for (const d of r.decisions) assert.equal(tierOf(d), 'proposed', 'a proposal is never shown as approved or claimed')
})

test('R2: approval is refused without the browser origin and writes nothing', async () => {
  const r = await app.inject({ method: 'POST', url: url('approve'), payload: { decisionId: DEC_A, state: 'approved', quote: 'looks right', claimSha256: (await listOnce()).decisions[0].claim_sha256 } })
  assert.equal(r.statusCode, 403)
  assert.equal((await listOnce()).decisions.find(d => d.id === DEC_A)!.approval.state, 'unknown')
})

test('R3: a changed claim is refused with 409 and no approval is written for the new text', async () => {
  const before = (await listOnce()).decisions.find(d => d.id === DEC_A)!
  const stale = 'f'.repeat(64) // the hash the person saw before someone edited the record
  const r = await app.inject({ method: 'POST', url: url('approve'), headers: UI, payload: { decisionId: DEC_A, state: 'approved', quote: 'looks right', claimSha256: stale } })
  assert.equal(r.statusCode, 409)
  assert.equal(r.json().code, 'claim-changed')
  assert.equal((await listOnce()).decisions.find(d => d.id === DEC_A)!.approval.state, before.approval.state)
})

test('R4: a fresh attestation of the exact text is recorded in the ledger and survives a new app instance', async () => {
  const d = (await listOnce()).decisions.find(x => x.id === DEC_A)!
  const ok = await app.inject({ method: 'POST', url: url('approve'), headers: UI, payload: { decisionId: DEC_A, state: 'approved', quote: 'Confirmed by the owner', claimSha256: d.claim_sha256 } })
  assert.equal(ok.statusCode, 200)
  // A fresh app and a fresh read stand in for a page refresh: the state comes from the ledger file, not from memory.
  const Fastify = (await import('fastify')).default
  const fresh = Fastify()
  await fresh.register((await import('../src/routes/design.js')).designRoutes)
  const again = (await fresh.inject({ method: 'GET', url: url('decisions') })).json().decisions.find((x: any) => x.id === DEC_A)
  await fresh.close()
  assert.equal(again.approval.state, 'approved'); assert.equal(again.approval.source, 'attested_local')
  assert.equal(tierOf(again), 'attested_local')
  assert.equal(queueCounts([again]).attested, 1)
  // Only one entry per decision: re-reading never duplicates it.
  const ledger = JSON.parse(readFileSync(join(dataDir, 'design-approvals', `${projectId}.json`), 'utf8'))
  assert.equal(ledger.approvals.filter((a: any) => a.decision_id === DEC_A).length, 1)
  assert.equal(existsSync(join(beats, 'jabutistudio.decisions.json')), true)
  // The decisions file itself never carries the approval.
  assert.equal(readFileSync(join(beats, 'jabutistudio.decisions.json'), 'utf8').includes('attested'), false)
})

test('R5: editing the claim text after attestation lapses it in the backend (never attested_local), and the ledger is not rewritten', async () => {
  const ledgerFile = join(dataDir, 'design-approvals', `${projectId}.json`)
  const ledgerBefore = readFileSync(ledgerFile, 'utf8')
  // Edit the decision's text on disk, the way a person or an agent would. The old attestation is bound to the old hash.
  const file = join(beats, 'jabutistudio.decisions.json')
  const original = readFileSync(file, 'utf8')
  assert.ok(original.includes('A perfect hit is within 45 ms.'))
  writeFileSync(file, original.replace('A perfect hit is within 45 ms.', 'A perfect hit is within 50 ms.'))
  try {
    const d = (await listOnce()).decisions.find(x => x.id === DEC_A)!
    assert.notEqual(d.claim_sha256, (await listOnce()).decisions.find(x => x.id === DEC_B)!.claim_sha256)
    assert.equal(d.approval.state, 'unknown')
    assert.equal(d.approval.lapsed, true, 'the backend reports the lapse, not just a missing approval')
    assert.equal(tierOf(d), 'lapsed')
    assert.notEqual(tierOf(d), 'attested_local')
    assert.equal(readFileSync(ledgerFile, 'utf8'), ledgerBefore, 'the ledger is not rewritten by a read')
    // And approval for the NEW text is refused unless the person confirms the new hash, which the guard checks.
    const stale = await app.inject({ method: 'POST', url: url('approve'), headers: UI, payload: { decisionId: DEC_A, state: 'approved', quote: 'same words', claimSha256: 'a'.repeat(64) } })
    assert.equal(stale.statusCode, 409)
  } finally {
    writeFileSync(file, original)
  }
  assert.match(TIER_LABEL.lapsed, /changed|lapsed/)
})

// ---- pure queue logic ----

const mk = (over: Record<string, any>) => ({
  id: 'dec-x', title: 'Title', claim: 'c', claim_sha256: 'a'.repeat(64), system: null, systems: [], decision_state: 'hypothesis',
  approval: { state: 'unknown', source: 'none' }, evidence_status: 'CURRENT', implementation: 'implemented', catalogued_implementation: 'implemented',
  supersedes: [], conflicts_with: [], files: [], tests: [], qps: [], evidence: [], provenance: { origin: 'agent' }, ...over,
}) as any

test('Q1: claimed (document or migrated record) is never shown as attested', () => {
  const c = mk({ id: 'dec-c', approval: { state: 'claimed', source: 'repository-claim' } })
  assert.equal(tierOf(c), 'claimed')
  assert.equal(queueCounts([c]).attested, 0)
  assert.equal(filterQueue([c], { scope: 'attested' }).length, 0)
  assert.equal(filterQueue([c], { scope: 'pending' }).length, 1)
})

test('Q2: the queue is stable by ID and the search finds the exact ID and a title word', () => {
  const xs = [mk({ id: 'dec-b', title: 'Esporos surgem naturalmente' }), mk({ id: 'dec-a', title: 'Humus 1000' })]
  assert.deepEqual(filterQueue(xs, { scope: 'all' }).map(d => d.id), ['dec-a', 'dec-b'])
  assert.deepEqual(filterQueue(xs, { scope: 'all', query: 'dec-b' }).map(d => d.id), ['dec-b'])
  assert.deepEqual(filterQueue(xs, { scope: 'all', query: 'ESPOROS' }).map(d => d.id), ['dec-b'])
  assert.equal(matchesQuery(xs[1], 'humus'), true)
})

test('Q3: conflicts stay explicit and an attestation of one side is still a conflict', () => {
  const a = mk({ id: 'dec-a', conflicts_with: ['dec-b'], approval: { state: 'approved', source: 'attested_local' } })
  const b = mk({ id: 'dec-b', conflicts_with: ['dec-a'] })
  assert.equal(filterQueue([a, b], { scope: 'conflicts' }).length, 2)
  const sides = conflictSides(a, [a, b])
  assert.deepEqual(sides.found.map(d => d.id), ['dec-b'])
  assert.deepEqual(sides.missing, [])
  assert.deepEqual(conflictSides(b, [b]).missing, ['dec-a'], 'a missing side is reported, never dropped')
})

test('Q4: the approval guard refuses when the item vanished or its text changed', () => {
  const a = mk({ id: 'dec-a', claim_sha256: 'h1' })
  assert.equal(approvalGuard({ id: 'dec-a', claimSha256: 'h1' }, a), 'ok')
  assert.equal(approvalGuard({ id: 'dec-a', claimSha256: 'h0' }, a), 'changed')
  assert.equal(approvalGuard({ id: 'dec-a', claimSha256: 'h1' }, undefined), 'vanished')
  assert.equal(approvalGuard({ id: 'dec-z', claimSha256: 'h1' }, a), 'vanished')
  assert.equal(approvalGuard(null, a), 'not-loaded')
})

test('Q5: when the queue shrinks, the selection reports vanished and clamps; it does not jump to a different ID silently', () => {
  const q = [mk({ id: 'dec-a' }), mk({ id: 'dec-c' })]
  assert.deepEqual(resolveIndex(q, 'dec-c', 1), { index: 1, vanished: false })
  assert.deepEqual(resolveIndex(q, 'dec-b', 1), { index: 1, vanished: true })
})

test('Q6: the briefing for an agent carries ID, state, text, conflicts and no approval claim', () => {
  const a = mk({ id: 'dec-a', title: 'Esporos', claim: 'Esporos surgem', conflicts_with: ['dec-b'], files: [{ role: 'declared', path: 'scripts/x.gd' }] })
  const text = reviewBriefing(a, 'pnmg')
  assert.ok(text.includes('dec-a') && text.includes('Esporos surgem') && text.includes('dec-b') && text.includes('scripts/x.gd'))
  assert.ok(text.includes('Approval state: proposed, not approved'))
})
