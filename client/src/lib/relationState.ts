import type { SystemRelation } from './api'

/**
 * What a declared relation IS, in two independent dimensions (pure, no DOM, tested on the server runner):
 *
 *  - design:  proposed (someone wrote it down) | confirmed (YOU accepted it as the classification of the design)
 *  - code:    none (nothing built / no evidence yet) | pointer (cites a file, no text to check) | matched (the cited text exists
 *             in this checkout) | stale (the cited evidence no longer holds)
 *
 * A relation with no code evidence is a normal, complete design relation. Evidence is extra information about
 * the implementation, never a condition for the relation to exist, be drawn or be edited.
 */
export type CodeState = 'none' | 'pointer' | 'matched' | 'stale'
export interface RelationState {
  design: 'proposed' | 'confirmed'
  code: CodeState
  /** short labels for pills */
  designLabel: string
  codeLabel: string
  codeTitle: string
}

export function codeStateOf(r: Pick<SystemRelation, 'basis' | 'evidence'>): CodeState {
  if (!r.evidence.length || r.basis === 'candidate') return 'none'
  if (r.basis === 'demonstrated') return 'matched'
  if (r.basis === 'inferred') return 'pointer'
  return 'stale'
}

const CODE: Record<CodeState, { label: string; title: string }> = {
  none: { label: 'design only', title: 'No code evidence is attached. The relation is a design record; nothing has been implemented or checked yet.' },
  pointer: { label: 'code pointer', title: 'Cites a file that exists, with no text to check. Not verified.' },
  matched: { label: 'code matched', title: 'The cited text exists in this checkout. This does not prove the relation is correct, only that the code it points at is there.' },
  stale: { label: 'code stale', title: 'The cited evidence no longer holds in this checkout. The design relation is unaffected.' },
}

export function relationState(r: Pick<SystemRelation, 'status' | 'basis' | 'evidence'>): RelationState {
  const code = codeStateOf(r)
  return {
    design: r.status, code,
    designLabel: r.status === 'confirmed' ? 'confirmed' : 'proposed',
    codeLabel: CODE[code].label, codeTitle: CODE[code].title,
  }
}

/** One wording for the whole Systems tab, so quick edit, the staged editor and the review screen never disagree. */
export const CONFIRM_MEANING = 'Confirming records, on this installation only, that you accept this classification (this relation or component). It is not a design approval: design decisions are approved separately in Design Knowledge, and confirming here never touches them.'
export const SAVE_MEANING = 'Saving writes your edit as a proposal. Anything you edit goes back to proposed, even if it was confirmed, unless you confirm it again in the same save.'
