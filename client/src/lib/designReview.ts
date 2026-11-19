/**
 * Pure logic of the project-wide design decision queue (Decisions > Feed / Review). No React, no I/O: the UI reads
 * the same native decisions the per-file panel reads, and this file only decides what is shown, in which order,
 * and whether an attestation still refers to the text the person was looking at.
 *
 * Three different things, never merged:
 *   proposed        a native record exists; nobody has approved it
 *   claimed         a document or migrated record says it was approved; nobody confirmed it here
 *   attested_local  this installation's ledger holds an approval for this exact claim text (not proof of who clicked)
 */
import type { DesignDecision } from './api'

export type ApprovalTier = 'attested_local' | 'claimed' | 'proposed' | 'lapsed' | 'rejected'

export const TIER_LABEL: Record<ApprovalTier, string> = {
  attested_local: 'attested locally',
  claimed: 'claimed, not verified',
  proposed: 'proposed, not approved',
  lapsed: 'approval lapsed: text changed',
  rejected: 'rejected locally',
}

export const TIER_HINT: Record<ApprovalTier, string> = {
  attested_local: 'This installation holds an approval for this exact text. It is a local record, not proof of who made it.',
  claimed: 'A document or migrated record says this was approved. Nobody has confirmed it here.',
  proposed: 'Recorded as a proposal. No approval exists.',
  lapsed: 'An approval existed for an earlier wording. It no longer applies to the current text.',
  rejected: 'A local rejection was recorded for this exact text.',
}

export function tierOf(d: DesignDecision): ApprovalTier {
  const a = d.approval
  if (a?.state === 'approved' && a.source === 'attested_local' && !a.lapsed) return 'attested_local'
  if (a?.state === 'rejected' || a?.state === 'revoked') return 'rejected'
  if (a?.lapsed || a?.source === 'attestation-lapsed') return 'lapsed'
  if (a?.state === 'claimed') return 'claimed'
  return 'proposed'
}

/** Pending = no attestation for the current text. Rejected and lapsed items still need a decision. */
export const isPending = (d: DesignDecision) => tierOf(d) !== 'attested_local'
export const hasConflict = (d: DesignDecision) => d.conflicts_with.length > 0

export type QueueScope = 'pending' | 'attested' | 'conflicts' | 'all'
export const SCOPE_LABEL: Record<QueueScope, string> = { pending: 'Pending', attested: 'Attested', conflicts: 'Conflicts', all: 'All' }

export interface QueueFilter {
  scope: QueueScope
  system?: string
  origin?: string
  query?: string
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** Title or ID, case- and accent-insensitive. `DEC-HUMUS` and `humus` both work; the full ID always finds its record. */
export function matchesQuery(d: DesignDecision, query: string | undefined): boolean {
  const q = fold(query ?? '')
  if (!q) return true
  return fold(d.id).includes(q) || fold(d.title).includes(q)
}

export function originOf(d: DesignDecision): string {
  const o = d.provenance?.origin
  if (o === 'agent') return 'agent'
  if (o === 'user') return 'user'
  if (o === 'legacy-migration') return 'legacy'
  return o ?? 'unknown'
}

export const ORIGIN_LABEL: Record<string, string> = {
  agent: 'agent proposal',
  user: 'declared by a person',
  legacy: 'migrated from legacy record',
  unknown: 'origin not recorded',
}

/** Stable order: by ID, so an item keeps its place while the person moves through the queue. */
export function filterQueue(decisions: DesignDecision[], f: QueueFilter): DesignDecision[] {
  return decisions
    .filter(d => {
      if (f.scope === 'pending' && !isPending(d)) return false
      if (f.scope === 'attested' && tierOf(d) !== 'attested_local') return false
      if (f.scope === 'conflicts' && !hasConflict(d)) return false
      if (f.system && !(d.systems ?? [d.system]).includes(f.system)) return false
      if (f.origin && originOf(d) !== f.origin) return false
      return matchesQuery(d, f.query)
    })
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function queueCounts(decisions: DesignDecision[]) {
  return {
    total: decisions.length,
    pending: decisions.filter(isPending).length,
    attested: decisions.filter(d => tierOf(d) === 'attested_local').length,
    conflicts: decisions.filter(hasConflict).length,
  }
}

/**
 * Where the reviewer is after the queue changed under them. The id is the identity: if it is still there the index
 * follows it; if it vanished the index is clamped and `vanished` says so, so the UI shows that instead of silently
 * moving to another record.
 */
export function resolveIndex(queue: DesignDecision[], id: string | null, previousIndex: number): { index: number; vanished: boolean } {
  if (!queue.length) return { index: 0, vanished: id !== null }
  if (id !== null) {
    const found = queue.findIndex(d => d.id === id)
    if (found >= 0) return { index: found, vanished: false }
  }
  return { index: Math.min(Math.max(previousIndex, 0), queue.length - 1), vanished: id !== null }
}

export const stepIndex = (length: number, index: number, dir: 1 | -1) =>
  length ? Math.min(Math.max(index + dir, 0), length - 1) : 0

/**
 * The attestation guard. `loaded` is what the person saw when they opened the item (ID + claim hash); `current` is what
 * the latest read of the queue says. Approval is allowed only when both still describe the same text. The server checks
 * the same hash again, so a stale page cannot record a decision for an edited or replaced record.
 */
export type ApprovalGuard = 'ok' | 'vanished' | 'changed' | 'not-loaded'
export function approvalGuard(loaded: { id: string; claimSha256: string } | null, current: DesignDecision | undefined): ApprovalGuard {
  if (!loaded) return 'not-loaded'
  if (!current || current.id !== loaded.id) return 'vanished'
  if (current.claim_sha256 !== loaded.claimSha256) return 'changed'
  return 'ok'
}

/** Other side(s) of a conflict. Missing ids (not in this checkout's file) are reported, never dropped. */
export function conflictSides(d: DesignDecision, all: DesignDecision[]): { found: DesignDecision[]; missing: string[] } {
  const byId = new Map(all.map(x => [x.id, x]))
  const found: DesignDecision[] = []
  const missing: string[] = []
  for (const id of new Set([...d.conflicts_with, ...(d.supersedes ?? []), ...(d.superseded_by ?? [])])) {
    const x = byId.get(id)
    if (x) found.push(x); else missing.push(id)
  }
  return { found, missing }
}

/** The text an agent receives when someone asks for changes: what is claimed, what the code does, and what is not approval. */
export function reviewBriefing(d: DesignDecision, projectId: string): string {
  const file = d.files[0]?.path ?? d.evidence.find(e => e.path)?.path ?? ''
  const conflicts = d.conflicts_with.length ? `Known conflict with ${d.conflicts_with.join(', ')}. Do not pick a side.` : ''
  return [
    `Review design decision ${d.id} (“${d.title}”) in project ${projectId}${file ? `, starting from ${file}` : ''}.`,
    `Recorded claim (unverified text): ${d.claim}`,
    `Implementation reads "${d.implementation}", evidence "${d.evidence_status}". Verify it in the code before answering.`,
    `Approval state: ${TIER_LABEL[tierOf(d)]}.`,
    conflicts,
    'Report what the code, tests and claim disagree on and what is missing. Do not record an approval, do not edit the decision and do not treat a passing test as approval.',
  ].filter(Boolean).join('\n')
}

/** Quick Actions on one decision. Each one is advisory: its answer is shown as a suggestion, never applied to the record. */
export const DECISION_ASSIST: { action: 'rephrase' | 'evidence' | 'conflicts' | 'compare'; label: string; hint: string }[] = [
  { action: 'rephrase', label: 'Improve wording', hint: 'Suggest a clearer claim. Applying it creates a new proposal; this decision and its approval stay as they are.' },
  { action: 'evidence', label: 'Investigate evidence', hint: 'Check whether each cited excerpt supports the claim. Reads only the evidence already attached.' },
  { action: 'conflicts', label: 'Find conflicts', hint: 'Compare with the decisions this one conflicts with. Does not pick a side.' },
  { action: 'compare', label: 'Compare with code', hint: 'Say what the cited code shows and what is not evidenced. Does not mark anything implemented.' },
]

/**
 * Evidence to carry onto a rewritten proposal: the cited, non-candidate items that point at a file. Anything without a
 * path is left out, and the server re-checks every file and line when the proposal is saved.
 */
/**
 * The file of a cited piece of evidence. The server sets `path` only when it resolved a moved reference; a current
 * code reference carries its file in `ref` as `file#L<line>`. Document references (`@...`) have no file.
 */
export function evidenceFile(e: { path?: string | null; ref: string }): string | null {
  if (e.path) return e.path
  const m = /^([^@\s].*?)(?:#L\d+(?:-L?\d+)?)?$/.exec(e.ref)
  return m ? m[1] : null
}

export function evidenceForProposal(d: DesignDecision): { type: string; path: string; startLine?: number; endLine?: number; note?: string }[] {
  return d.evidence
    .filter(e => !e.candidate_only && !!evidenceFile(e))
    .map(e => ({
      type: e.type,
      path: evidenceFile(e) as string,
      ...(e.lines ? { startLine: e.lines[0], endLine: e.lines[1] } : {}),
      ...(e.note ? { note: e.note } : {}),
    }));
}

/** A suggestion is only applicable to the text it was computed from. Changed text means it must be asked again. */
export function suggestionStale(suggestedFromSha: string, d: DesignDecision): boolean {
  return suggestedFromSha !== d.claim_sha256;
}

/**
 * The message for Ask Agent: the decision with its state, evidence, conflicts and the limits on what an agent may do.
 * It is a briefing for a terminal session, which the person reads and can change before sending.
 */
export function decisionAgentPrompt(d: DesignDecision, projectId: string, all: DesignDecision[], worktree?: string): string {
  const conflicts = conflictSides(d, all)
  const evidence = d.evidence.filter(e => !e.candidate_only).map(e => {
    const head = e.excerpt.slice(0, 6).map(x => `    ${x.line}: ${x.text}`).join('\n')
    return `- [${e.type}] ${e.ref} (${e.freshness.toLowerCase()})${e.note ? ` — ${e.note}` : ''}${head ? `\n${head}` : ''}`
  })
  return [
    `Help me review design decision ${d.id} ("${d.title}") in project ${projectId}${worktree ? `, checkout ${worktree}` : ''}.`,
    `Recorded claim (text, not approval): ${d.claim}`,
    `Systems: ${d.systems?.length ? d.systems.join(', ') : 'none'}`,
    `Approval state: ${TIER_LABEL[tierOf(d)]}.`,
    `Implementation reads "${d.implementation}", evidence "${d.evidence_status}". Verify in the code; do not repeat these readings as fact.`,
    `Cited evidence:${evidence.length ? `\n${evidence.join('\n')}` : ' none'}`,
    conflicts.found.length
      ? `Conflicting decisions:\n${conflicts.found.map(c => `- ${c.id}: ${c.title} — claim: ${c.claim}`).join('\n')}${conflicts.missing.length ? `\nNot in this checkout's file: ${conflicts.missing.join(', ')}` : ''}\nDo not pick a side; say what would decide between them.`
      : d.conflicts_with.length ? `Known conflicts (not in this checkout): ${d.conflicts_with.join(', ')}. Do not pick a side.` : 'Conflicts: none recorded.',
    'Rules: you may read files and report findings. Do not record an approval, do not edit the decisions file, do not mark the decision implemented, and do not treat a passing test as approval. Say what you could not verify.',
  ].join('\n')
}
