import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DECISION_ASSIST, decisionAgentPrompt, evidenceForProposal, suggestionStale,
} from '../../client/src/lib/designReview.js'

// A decision as the API returns it, with only the fields these helpers read.
const decision = (over: Record<string, any> = {}): any => ({
  id: 'dec-perfect-window-1a2b3c', title: 'Perfect window', claim: 'A perfect hit is within 45 ms.', claim_sha256: 'sha-1',
  systems: ['rhythm'], scope: ['rhythm'], implementation: 'implemented', catalogued_implementation: 'implemented',
  evidence_status: 'CURRENT', conflicts_with: [], supersedes: [], files: [{ role: 'code', path: 'scripts/rhythm.gd' }], tests: [], qps: [],
  approval: { state: 'unknown', source: 'none' }, provenance: { origin: 'user' },
  evidence: [
    { type: 'code', ref: 'scripts/rhythm.gd:2', note: 'constant', candidate_only: false, freshness: 'CURRENT', detail: '',
      lines: [2, 2], path: 'scripts/rhythm.gd', excerpt: [{ line: 2, text: 'const PERFECT_WINDOW_MS := 45' }] },
    { type: 'code', ref: 'scripts/other.gd:9', note: '', candidate_only: true, freshness: 'CURRENT', detail: '', lines: null, path: 'scripts/other.gd', excerpt: [] },
    { type: 'document_claim', ref: '@design:window', note: '', candidate_only: false, freshness: 'CURRENT', detail: '', lines: null, path: null, excerpt: [] },
  ],
  ...over,
})

test('Quick Actions on a decision never include an approval, rejection or publish', () => {
  assert.equal(DECISION_ASSIST.length, 4)
  for (const a of DECISION_ASSIST) assert.doesNotMatch(`${a.action} ${a.label}`, /approve|attest|reject|revoke|publish/i)
  assert.deepEqual(DECISION_ASSIST.map(a => a.action), ['rephrase', 'evidence', 'conflicts', 'compare'])
})

test('evidence carried to a rewritten proposal keeps only cited files, with their lines', () => {
  const ev = evidenceForProposal(decision())
  assert.deepEqual(ev, [{ type: 'code', path: 'scripts/rhythm.gd', startLine: 2, endLine: 2, note: 'constant' }])
})

test('evidence without a path, or only as a candidate, is never carried over', () => {
  assert.deepEqual(evidenceForProposal(decision({ evidence: [] })), [])
  assert.deepEqual(evidenceForProposal(decision({
    evidence: [{ type: 'code', ref: 'x', note: '', candidate_only: true, freshness: 'CURRENT', detail: '', lines: null, path: 'a.gd', excerpt: [] }],
  })), [])
})

test('a suggestion is stale as soon as the decision text changes', () => {
  assert.equal(suggestionStale('sha-1', decision()), false)
  assert.equal(suggestionStale('sha-0', decision()), true)
})

test('the Ask Agent briefing carries state, evidence and conflicts, and forbids approval', () => {
  const d = decision({ approval: { state: 'approved', source: 'attested_local', lapsed: false }, conflicts_with: ['dec-other-9'] })
  const other = decision({ id: 'dec-other-9', title: 'Window at 50 ms', claim: 'A perfect hit is within 50 ms.' })
  const text = decisionAgentPrompt(d, 'jabutistudio', [d, other], 'main')
  assert.match(text, /dec-perfect-window-1a2b3c/)
  assert.match(text, /Approval state: attested locally/)
  assert.match(text, /scripts\/rhythm\.gd:2/)
  assert.match(text, /2: const PERFECT_WINDOW_MS := 45/)
  assert.match(text, /dec-other-9: Window at 50 ms/)
  assert.match(text, /Do not pick a side/)
  assert.match(text, /Do not record an approval/)
  assert.doesNotMatch(text, /scripts\/other\.gd/, 'candidate-only evidence is not part of the briefing')
})

test('the briefing says when a conflicting decision is not in this checkout', () => {
  const text = decisionAgentPrompt(decision({ conflicts_with: ['dec-missing-1'] }), 'jabutistudio', [decision()])
  assert.match(text, /Known conflicts \(not in this checkout\): dec-missing-1/)
})
