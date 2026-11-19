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
  for (const id of d.conflicts_with) {
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
