/**
 * Pure rules of the new-decision draft. The form shows exactly what these return: what blocks saving, and the body
 * sent to the proposal route. Evidence and conflicts that were not ticked are never sent.
 */

export interface DraftCandidate { type: string; path: string; startLine: number; needle: string; note: string }

export interface DecisionDraft {
  title: string
  claim: string
  systems: string[]
  evidence: (DraftCandidate & { checked: boolean })[]
  conflicts: { id: string; title: string; checked: boolean }[]
  limitations: string[]
  notes: string[]
}

/** What blocks saving. Empty means the draft can be proposed. */
export function draftProblems(d: Pick<DecisionDraft, 'title' | 'claim' | 'evidence'>): string[] {
  const p: string[] = []
  if (d.title.trim().length < 3) p.push('Give the decision a title of at least 3 characters.')
  if (d.claim.trim().length < 10) p.push('Write the claim in at least 10 characters.')
  if (!d.evidence.some(e => e.checked)) p.push('Keep at least one piece of evidence found in the checkout.')
  return p
}

/** The proposal body built from the reviewed draft. Only ticked evidence and conflicts are included. */
export function proposalFromDraft(d: DecisionDraft, systems: string[]) {
  const checked = d.evidence.filter(e => e.checked)
  return {
    title: d.title.trim(),
    claim: d.claim.trim(),
    systems,
    files: [...new Set(checked.filter(e => e.type === 'code' || e.type === 'test').map(e => e.path))],
    conflictsWith: d.conflicts.filter(c => c.checked).map(c => c.id),
    evidence: checked.map(e => ({ type: e.type, path: e.path, startLine: e.startLine, needle: e.needle, note: e.note })),
  }
}
