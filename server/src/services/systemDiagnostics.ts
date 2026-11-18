/**
 * Systems Explorer diagnostics (V1.1): turns the maintenance signals the catalog already derives into
 * explanations a person can act on. Pure: no I/O, no store, no writes. It never changes a system, a decision or an
 * anchor; every action it offers is an existing mechanism (review dialog, Graphify build, acknowledge, editor).
 *
 * Three different things are kept apart on purpose:
 *   classification  — `proposed` is a design state, not a defect
 *   analysis        — the code graph is older than the files (fixed by re-analyzing)
 *   integrity       — a reference points at a file this checkout does not have (fixed by a person, never by inference)
 */

export type DiagnosticCode =
  | 'proposal' | 'graph-not-built' | 'graph-stale' | 'graph-other-checkout'
  | 'files-missing' | 'references-vanished'

export type RefState =
  | 'absent'                 // not in this checkout, and the graph never knew it
  | 'absent-since-analysis'  // not in this checkout, but the graph still lists it: the analysis predates the deletion
  | 'other-checkout'         // not in this worktree, but present in the project checkout

export interface DiagnosticRef { path: string; source: string; state: RefState }

export type ActionKind = 'review' | 'reanalyze' | 'edit-members' | 'acknowledge' | 'none'
export interface DiagnosticAction {
  kind: ActionKind
  label: string
  available: boolean
  /** Why nothing can be done from here (set exactly when `available` is false). */
  blockedReason?: string
}

export interface Diagnostic {
  code: DiagnosticCode
  kind: 'classification' | 'analysis' | 'integrity'
  severity: 'info' | 'warning'
  title: string
  /** What the state means. */
  meaning: string
  /** The concrete cause, when it can be identified. */
  cause: string
  /** What it does to the knowledge shown. */
  effect: string
  action: DiagnosticAction
  refs: DiagnosticRef[]
  /** Always false: no diagnostic or action edits a decision or confirms a system. */
  altersDesign: false
}

export type AnalysisState = 'not-built' | 'current' | 'stale' | 'other-checkout'
export interface AnalysisSummary { state: AnalysisState; label: string; builtAt?: number; describes: string }

export interface DiagnosticsInput {
  status: 'proposed' | 'confirmed' | 'dismissed' | 'merged'
  origin: 'discovery' | 'agent' | 'user'
  checkout: { isCanonical: boolean; branch?: string; head?: string }
  graph: { built: boolean; builtAt?: number; installed: boolean; building: boolean }
  changedMembers: string[]
  unresolved: { path: string; source: string; inProjectCheckout: boolean; graphKnows: boolean }[]
  vanished: { key: string; since: string }[]
  pendingSuggestions?: number
}

const where = (c: DiagnosticsInput['checkout']) =>
  `${c.isCanonical ? 'the project checkout' : 'this worktree'}${c.branch ? ` (${c.branch}${c.head ? `@${c.head}` : ''})` : ''}`
const when = (ms?: number) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'an unknown time')
const list = (xs: string[], n = 5) => xs.slice(0, n).join(', ') + (xs.length > n ? ` +${xs.length - n} more` : '')
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)

export const ANALYSIS_DESCRIBES = 'the project checkout'

/** Why a re-analysis cannot be started from here, or undefined when it can. */
export function reanalyzeBlock(i: Pick<DiagnosticsInput, 'checkout' | 'graph'>): string | undefined {
  if (!i.graph.installed) return 'Graphify is not installed on this machine. Run `pnpm graphify:setup`, then try again.'
  if (i.graph.building) return 'An analysis is already running. Wait for it to finish.'
  if (!i.checkout.isCanonical) return 'Graphify analyzes the project checkout, never a worktree. Switch to the project checkout to re-analyze; the graph shown here would not change.'
  return undefined
}

export function summarizeAnalysis(i: Pick<DiagnosticsInput, 'checkout' | 'graph' | 'changedMembers'>): AnalysisSummary {
  if (!i.graph.built) return { state: 'not-built', label: 'code graph: not analyzed', describes: ANALYSIS_DESCRIBES }
  if (!i.checkout.isCanonical) return { state: 'other-checkout', label: 'code graph: describes the project checkout', builtAt: i.graph.builtAt, describes: ANALYSIS_DESCRIBES }
  if (i.changedMembers.length) return { state: 'stale', label: `code graph: ${i.changedMembers.length} file${i.changedMembers.length > 1 ? 's' : ''} changed since analysis`, builtAt: i.graph.builtAt, describes: ANALYSIS_DESCRIBES }
  return { state: 'current', label: 'code graph: current', builtAt: i.graph.builtAt, describes: ANALYSIS_DESCRIBES }
}

export function buildDiagnostics(i: DiagnosticsInput): Diagnostic[] {
  const out: Diagnostic[] = []
  const here = where(i.checkout)
  const rBlock = reanalyzeBlock(i)
  const reanalyze = (label: string): DiagnosticAction =>
    rBlock ? { kind: 'reanalyze', label, available: false, blockedReason: rBlock } : { kind: 'reanalyze', label, available: true }

  // ---- classification: a proposal is a state of the design, not a fault -------------------------------------
  if (i.status === 'proposed') {
    const by = i.origin === 'agent' ? 'an agent through MCP' : i.origin === 'discovery' ? 'automatic discovery from file names and text' : 'a person'
    out.push({
      code: 'proposal', kind: 'classification', severity: 'info',
      title: 'Proposed, not confirmed',
      meaning: 'This system is a proposal. Its grouping and wording are a suggestion, not a decision of the project.',
      cause: `It was created by ${by} and nobody has confirmed it.`,
      effect: 'Everything shown is usable as a draft; nothing here counts as an approved design decision.',
      action: { kind: 'review', label: 'Review and confirm…', available: true },
      refs: [], altersDesign: false,
    })
  }

  // ---- analysis: the code graph against the checkout ---------------------------------------------------------
  if (!i.graph.built) {
    out.push({
      code: 'graph-not-built', kind: 'analysis', severity: 'info',
      title: 'Code graph not analyzed',
      meaning: 'Graphify has not analyzed this project, so there is no code graph yet.',
      cause: 'No analysis has been run for this project on this machine.',
      effect: 'No symbols or technical links are shown. Membership by name or text, evidence and Git state still work.',
      action: reanalyze('Analyze project'), refs: [], altersDesign: false,
    })
  } else if (!i.checkout.isCanonical) {
    out.push({
      code: 'graph-other-checkout', kind: 'analysis', severity: 'info',
      title: 'Graph describes another checkout',
      meaning: 'The code graph was built from the project checkout, and you are looking at a worktree.',
      cause: `Analysis of ${when(i.graph.builtAt)} covers ${ANALYSIS_DESCRIBES}; files here come from ${here}.`,
      effect: 'Symbols and technical links may not match this worktree. Members, evidence and Git state are read from this worktree.',
      action: { kind: 'none', label: 'No action', available: false, blockedReason: 'Graphify cannot analyze a worktree. Switch to the project checkout to view or refresh the analysis.' },
      refs: [], altersDesign: false,
    })
  } else if (i.changedMembers.length) {
    out.push({
      code: 'graph-stale', kind: 'analysis', severity: 'warning',
      title: 'Code graph out of date',
      meaning: 'Member files were edited after the last Graphify analysis.',
      cause: `The analysis of ${when(i.graph.builtAt)} (${ANALYSIS_DESCRIBES}) is older than ${i.changedMembers.length} member file${i.changedMembers.length > 1 ? 's' : ''}: ${list(i.changedMembers.map(base))}.`,
      effect: 'Symbols and technical links for those files may be outdated. Design records, evidence and decisions are not affected.',
      action: reanalyze('Re-analyze project'), refs: [], altersDesign: false,
    })
  }

  // ---- integrity: references this checkout cannot resolve ----------------------------------------------------
  if (i.unresolved.length) {
    const refs: DiagnosticRef[] = i.unresolved.map(u => ({
      path: u.path, source: u.source,
      state: !i.checkout.isCanonical && u.inProjectCheckout ? 'other-checkout' : u.graphKnows ? 'absent-since-analysis' : 'absent',
    }))
    const n = (s: RefState) => refs.filter(r => r.state === s).length
    const parts: string[] = []
    if (n('absent')) parts.push(`${n('absent')} not in ${here} and unknown to the graph (deleted or never created)`)
    if (n('absent-since-analysis')) parts.push(`${n('absent-since-analysis')} not in ${here} but still listed by an older analysis`)
    if (n('other-checkout')) parts.push(`${n('other-checkout')} not in ${here} but present in the project checkout (this worktree's branch does not have them)`)
    const onlyOther = n('other-checkout') === refs.length
    out.push({
      code: 'files-missing', kind: 'integrity', severity: 'warning',
      title: `${refs.length} referenced file${refs.length > 1 ? 's' : ''} not found`,
      meaning: 'A file this system points to cannot be found, even allowing for renames and a unique file of the same name.',
      cause: `${parts.join('; ')}.`,
      effect: 'Those files are not counted as members, and evidence that depends on them cannot be verified here. The system itself is unchanged.',
      action: onlyOther
        ? { kind: 'none', label: 'No action', available: false, blockedReason: 'The references are correct in the project checkout. Integrate or rebase this worktree\'s branch, or switch to the project checkout; editing the system would break them there.' }
        : { kind: 'edit-members', label: 'Fix references…', available: true },
      refs, altersDesign: false,
    })
  }

  if (i.vanished.length) {
    out.push({
      code: 'references-vanished', kind: 'integrity', severity: 'warning',
      title: `${i.vanished.length} reference${i.vanished.length > 1 ? 's' : ''} disappeared`,
      meaning: 'Files or symbols this system used to include are gone from the project checkout.',
      cause: `Seen earlier, no longer present: ${list(i.vanished.map(v => v.key.replace(/^(file|sym):/, '')), 6)}.`,
      effect: 'Nothing is lost from the design. This is a record of what changed in the code.',
      action: { kind: 'acknowledge', label: 'Acknowledge', available: true },
      refs: [], altersDesign: false,
    })
  }

  return out
}
