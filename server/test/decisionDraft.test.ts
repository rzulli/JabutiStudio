import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftProblems, proposalFromDraft, type DecisionDraft } from '../../client/src/lib/decisionDraft.js'

const ev = (over: Partial<DecisionDraft['evidence'][number]> = {}) => ({
  type: 'code', path: 'scripts/rhythm.gd', startLine: 2, needle: 'PERFECT_WINDOW_MS', note: 'found by searching', checked: true, ...over,
})

const base = (over: Partial<DecisionDraft> = {}): DecisionDraft => ({
  title: 'Perfect window', claim: 'A perfect hit is within 45 ms.', systems: ['rhythm'],
  evidence: [ev()], conflicts: [], limitations: [], notes: [], ...over,
})

test('a draft with no title, a short claim and no ticked evidence cannot be saved', () => {
  const problems = draftProblems(base({ title: ' ', claim: 'short', evidence: [ev({ checked: false })] }))
  assert.equal(problems.length, 3)
  assert.match(problems[2], /evidence found in the checkout/)
})

test('a complete draft with ticked evidence has no blocking problem', () => {
  assert.deepEqual(draftProblems(base()), [])
})

test('unticked evidence is never sent, and only code or tests become files', () => {
  const d = base({
    evidence: [
      ev(),
      ev({ path: 'scripts/other.gd', startLine: 9, needle: 'other', checked: false }),
      ev({ type: 'document_claim', path: 'docs/rhythm.md', startLine: 4, needle: 'PERFECT', checked: true }),
    ],
  })
  const body = proposalFromDraft(d, ['rhythm'])
  assert.deepEqual(body.evidence.map(e => e.path), ['scripts/rhythm.gd', 'docs/rhythm.md'])
  assert.deepEqual(body.files, ['scripts/rhythm.gd'])
  assert.equal(body.evidence.some(e => e.path === 'scripts/other.gd'), false)
})

test('only ticked conflicts are sent; title and claim are trimmed; systems are the chosen ones', () => {
  const d = base({
    title: '  Perfect window  ', claim: '  A perfect hit is within 45 ms.  ',
    conflicts: [{ id: 'dec-a', title: 'A', checked: true }, { id: 'dec-b', title: 'B', checked: false }],
  })
  const body = proposalFromDraft(d, ['rhythm', 'timing'])
  assert.equal(body.title, 'Perfect window')
  assert.equal(body.claim, 'A perfect hit is within 45 ms.')
  assert.deepEqual(body.conflictsWith, ['dec-a'])
  assert.deepEqual(body.systems, ['rhythm', 'timing'])
})

test('the proposal body never carries an approval or a status', () => {
  const body = proposalFromDraft(base(), ['rhythm']) as Record<string, unknown>
  for (const k of Object.keys(body)) assert.doesNotMatch(k, /approv|attest|status|implement/i)
})
