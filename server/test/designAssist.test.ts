import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { designRoutes } from '../src/routes/design.js'
import {
  approvalTier, ASSIST_ACTIONS, assistDecision, evidenceTypeFor, findEvidence, normalizeAssist, possibleConflicts,
} from '../src/services/designAssist.js'

const dec = (over: Record<string, any> = {}) => ({
  id: 'dec-a', title: 'Perfect window', claim: 'A perfect hit is within 45 ms.', implementation: 'implemented',
  evidence_status: 'CURRENT', systems: ['rhythm'], conflicts_with: [], evidence: [], approval: { state: 'unknown', source: 'none' },
  ...over,
})

test('approval tier reads the same states the client shows, and lapses are not attested', () => {
  assert.equal(approvalTier(dec({ approval: { state: 'approved', source: 'attested_local', lapsed: false } })), 'attested_local')
  assert.equal(approvalTier(dec({ approval: { state: 'approved', source: 'attested_local', lapsed: true } })), 'lapsed')
  assert.equal(approvalTier(dec({ approval: { state: 'approved', source: 'attestation-lapsed' } })), 'lapsed')
  assert.equal(approvalTier(dec({ approval: { state: 'revoked', source: 'attested_local' } })), 'rejected')
  assert.equal(approvalTier(dec({ approval: { state: 'claimed', source: 'repository-claim' } })), 'claimed')
  assert.equal(approvalTier(dec()), 'proposed')
})

test('the assist actions contain no approval, rejection or publish', () => {
  assert.deepEqual([...ASSIST_ACTIONS], ['rephrase', 'evidence', 'conflicts', 'compare'])
  for (const a of ASSIST_ACTIONS) assert.doesNotMatch(a, /approve|attest|reject|revoke|publish/)
})

test('normalizeAssist keeps the claim only for a rephrase, trims notes and caps them', () => {
  assert.deepEqual(normalizeAssist('rephrase', { claim: '  Clearer claim  ', notes: [' a ', '', 3, 'b'] }), { claim: 'Clearer claim', notes: ['a', 'b'] })
  assert.deepEqual(normalizeAssist('evidence', { claim: 'must not leak', notes: ['x'] }), { notes: ['x'] })
  assert.deepEqual(normalizeAssist('rephrase', { claim: '   ' }), { notes: [] })
  const many = { notes: Array.from({ length: 30 }, (_, i) => `n${i}`) }
  assert.equal(normalizeAssist('compare', many).notes.length, 12)
  assert.deepEqual(normalizeAssist('compare', null), { notes: [] })
})

test('a question with nothing to ask answers locally, without calling the AI', async () => {
  // No AI backend is configured in tests: any call would throw, so these must not reach it.
  const noEvidence = await assistDecision(dec(), 'evidence', [dec()])
  assert.deepEqual(noEvidence, { action: 'evidence', notes: ['No cited evidence to investigate.'] })
  const noConflicts = await assistDecision(dec(), 'conflicts', [dec()])
  assert.deepEqual(noConflicts, { action: 'conflicts', notes: ['No conflicting decision is recorded for this one.'] })
  const noCode = await assistDecision(dec(), 'compare', [dec()])
  assert.deepEqual(noCode, { action: 'compare', notes: ['No cited code or evidence to compare with the claim.'] })
})

test('possible conflicts need two shared title words and ignore short ones', () => {
  const others = [
    { id: 'x', title: 'Perfect hit window timing' },
    { id: 'y', title: 'Perfect scoring' },
    { id: 'z', title: 'Hit or to be' },
  ]
  assert.deepEqual(possibleConflicts('Perfect hit window', others).map(c => c.id), ['x'])
  assert.deepEqual(possibleConflicts('to be or hit', others), [])
})

test('evidence type follows the path, using the existing vocabulary', () => {
  assert.equal(evidenceTypeFor('docs/rhythm.md'), 'document_claim')
  assert.equal(evidenceTypeFor('tests/rhythm_test.gd'), 'test')
  assert.equal(evidenceTypeFor('scripts/rhythm.gd'), 'code')
})

test('findEvidence returns only real matches with their line, in a git checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'design-assist-'))
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true })
    git('init', '-q')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'fixture')
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'rhythm.gd'), 'extends Node\nconst PERFECT_WINDOW_MS := 45\n')
    git('add', '.')
    git('commit', '-q', '-m', 'fixture')
    const found = await findEvidence(root, ['PERFECT_WINDOW_MS', 'NOT_IN_THE_REPO_XYZ', 'ab'])
    assert.equal(found.length, 1)
    assert.equal(found[0].path, 'scripts/rhythm.gd')
    assert.equal(found[0].line, 2)
    assert.equal(found[0].term, 'PERFECT_WINDOW_MS')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findEvidence outside a git checkout finds nothing and does not throw', async () => {
  const root = mkdtempSync(join(tmpdir(), 'design-assist-plain-'))
  try {
    writeFileSync(join(root, 'a.txt'), 'PERFECT_WINDOW_MS\n')
    assert.deepEqual(await findEvidence(root, ['PERFECT_WINDOW_MS']), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the assist route refuses bad input before looking up the project or calling the AI', async () => {
  const app = Fastify()
  await app.register(designRoutes)
  try {
    const bad = await app.inject({ method: 'POST', url: '/api/projects/nope/design/assist', payload: { action: 'approve', decisionId: 'x' } })
    assert.equal(bad.statusCode, 400)
    const noId = await app.inject({ method: 'POST', url: '/api/projects/nope/design/assist', payload: { action: 'rephrase' } })
    assert.equal(noId.statusCode, 400)
    const short = await app.inject({ method: 'POST', url: '/api/projects/nope/design/assist', payload: { action: 'structure', text: 'short' } })
    assert.equal(short.statusCode, 400)
    const unknownProject = await app.inject({ method: 'POST', url: '/api/projects/nope/design/assist', payload: { action: 'rephrase', decisionId: 'x' } })
    assert.equal(unknownProject.statusCode, 404)
  } finally {
    await app.close()
  }
})
