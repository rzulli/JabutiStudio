/**
 * Systems Explorer diagnostics (V1.1): turns the maintenance signals the catalog already derives into
 * explanations a person can act on. Pure: no I/O, no store, no writes. It never changes a system, a decision or an
 * anchor; every action it offers is an existing mechanism (review dialog, Graphify build, acknowledge, editor).
 *
 * Three different things are kept apart on purpose:
 *   classification  — `proposed` is a design state, not a defect
 *   analysis        — the code graph is older than the files, or a file lies outside what the index covers
 *   integrity       — a reference points at a file this checkout does not have (fixed by a person, never by inference)
 */

export type DiagnosticCode =
  | 'proposal' | 'graph-not-built' | 'graph-stale' | 'graph-other-checkout'
  | 'files-missing' | 'files-not-indexed' | 'files-unverifiable' | 'references-vanished'

export type RefState =
  | 'absent'                 // not on disk in this checkout, and the graph never knew it
  | 'absent-since-analysis'  // not on disk in this checkout, but the graph still lists it: the analysis predates the deletion
  | 'other-checkout'         // not on disk in this worktree, but present in the project checkout
  | 'not-indexed'            // on disk here; only outside the catalog's Godot file index (e.g. a .md)
  | 'unknown'                // could not be checked (not a relative path inside the checkout, or unreadable)

export interface DiagnosticRef { path: string; source: string; state: RefState }

export type ActionKind = 'review' | 'reanalyze' | 'edit-members' | 'acknowledge' | 'none'
export interface DiagnosticAction {
  kind: ActionKind
  label: string
  available: boolean
  /** Why nothing can be done from here (set when `available` is false). */
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

export interface UnresolvedRef {
  path: string
  source: string
  /** probed on disk in the examined checkout, not looked up in the Godot-only file index */
  physical: 'present' | 'absent' | 'unknown'
  /** why it could not be checked, when physical is 'unknown' */
  note?: string
  /** physically present in the project checkout (only probed when examining a worktree) */
  inProjectCheckout: boolean
  graphKnows: boolean
}

export interface DiagnosticsInput {
  status: 'proposed' | 'confirmed' | 'dismissed' | 'merged'
  origin: 'discovery' | 'agent' | 'user'
  checkout: { isCanonical: boolean; branch?: string; head?: string }
  graph: { built: boolean; builtAt?: number; installed: boolean; building: boolean }
  changedMembers: string[]
  unresolved: UnresolvedRef[]
  vanished: { key: string; since: string }[]
}

const where = (c: DiagnosticsInput['checkout']) =>
  `${c.isCanonical ? 'the project checkout' : 'this worktree'}${c.branch ? ` (${c.branch}${c.head ? `@${c.head}` : ''})` : ''}`
const when = (ms?: number) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'an unknown time')
const list = (xs: string[], n = 5) => xs.slice(0, n).join(', ') + (xs.length > n ? ` +${xs.length - n} more` : '')
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

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

/** One reference, classified from a disk probe. Never proposes a replacement path. */
export function classifyRef(u: UnresolvedRef, isCanonical: boolean): RefState {
  if (u.physical === 'unknown') return 'unknown'
  if (u.physical === 'present') return 'not-indexed'
  if (!isCanonical && u.inProjectCheckout) return 'other-checkout'
  return u.graphKnows ? 'absent-since-analysis' : 'absent'
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

  // ---- references the file index could not resolve: each one is probed on disk, never guessed ----------------
  const refs: DiagnosticRef[] = i.unresolved.map(u => ({ path: u.path, source: u.source, state: classifyRef(u, i.checkout.isCanonical) }))
  const of = (...st: RefState[]) => refs.filter(r => st.includes(r.state))
  const count = (s: RefState) => of(s).length
  const missing = of('absent', 'absent-since-analysis', 'other-checkout')

  if (missing.length) {
    const parts: string[] = []
    if (count('absent')) parts.push(`${count('absent')} not on disk in ${here} and unknown to the graph (deleted or never created)`)
    if (count('absent-since-analysis')) parts.push(`${count('absent-since-analysis')} not on disk in ${here} but still listed by an older analysis`)
    if (count('other-checkout')) parts.push(`${count('other-checkout')} not on disk in ${here} but present in the project checkout (this worktree's branch does not have them)`)
    out.push({
      code: 'files-missing', kind: 'integrity', severity: 'warning',
      title: `${missing.length} referenced ${plural(missing.length, 'file', 'files')} not found`,
      meaning: 'A file this system points to is not on disk, even allowing for renames and a unique file of the same name.',
      cause: `${parts.join('; ')}.`,
      effect: 'Those files are not counted as members, and evidence that depends on them cannot be verified here. The system itself is unchanged.',
      action: count('other-checkout') === missing.length
        ? { kind: 'none', label: 'No action', available: false, blockedReason: "The references are correct in the project checkout. Integrate or rebase this worktree's branch, or switch to the project checkout; editing the system would break them there." }
        : { kind: 'edit-members', label: 'Fix references…', available: true },
      refs: missing, altersDesign: false,
    })
  }

  if (count('not-indexed')) {
    const n = count('not-indexed')
    out.push({
      code: 'files-not-indexed', kind: 'analysis', severity: 'info',
      title: `${n} referenced ${plural(n, 'file', 'files')} outside the code index`,
      meaning: 'The file exists. The catalog and Graphify only index Godot project files (scripts, scenes, resources), so a document or asset like this is not listed as a member and has no symbols.',
      cause: `${n} anchored ${plural(n, 'file is', 'files are')} present on disk in ${here} but absent from the catalog's file index (not a Godot file type, or ignored by Git).`,
      effect: 'The reference is valid and stays on the system. It is just not shown among members or in the code graph.',
      action: { kind: 'none', label: 'No action', available: false, blockedReason: 'Nothing is wrong; no fix is needed.' },
      refs: of('not-indexed'), altersDesign: false,
    })
  }

  if (count('unknown')) {
    const n = count('unknown')
    out.push({
      code: 'files-unverifiable', kind: 'integrity', severity: 'warning',
      title: `${n} ${plural(n, 'reference', 'references')} could not be checked`,
      meaning: 'The catalog could not tell whether these files exist.',
      cause: `${i.unresolved.filter(u => u.physical === 'unknown').map(u => `${u.path}: ${u.note ?? 'unreadable'}`).join('; ')}.`,
      effect: 'Their state is unknown, so they are neither counted as members nor reported as deleted.',
      action: { kind: 'edit-members', label: 'Review references…', available: true },
      refs: of('unknown'), altersDesign: false,
    })
  }

  if (i.vanished.length) {
    out.push({
      code: 'references-vanished', kind: 'integrity', severity: 'warning',
      title: `${i.vanished.length} ${plural(i.vanished.length, 'reference', 'references')} disappeared`,
      meaning: 'Files or symbols this system used to include are gone from the project checkout.',
      cause: `Seen earlier, no longer present: ${list(i.vanished.map(v => v.key.replace(/^(file|sym):/, '')), 6)}.`,
      effect: 'Nothing is lost from the design. This is a record of what changed in the code.',
      action: { kind: 'acknowledge', label: 'Acknowledge', available: true },
      refs: [], altersDesign: false,
    })
  }

  return out
}
