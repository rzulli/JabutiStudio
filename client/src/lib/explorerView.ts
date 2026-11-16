import type { ExplorerKind, ExplorerNeighbor, ExplorerNodeDetail } from './api'

/** Pure view logic of the Project Explorer, kept out of the component so it can be tested. */

export type Filter = 'all' | ExplorerKind

export const KIND_LABEL: Record<ExplorerKind, string> = {
  file: 'File', func: 'Function', signal: 'Signal', class: 'Class', external: 'Engine / unresolved',
}
export const FILTER_LABEL: Record<ExplorerKind, string> = {
  file: 'Files', func: 'Functions', signal: 'Signals', class: 'Classes', external: 'Engine',
}

export const cleanLabel = (label: string) => label.replace(/\(signal\)$/, '').replace(/^\./, '')

export type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok' }
  /** The analysis ran but the graph has no node of this kind at all. */
  | { kind: 'index-empty'; filter: ExplorerKind }
  /** There are nodes of this kind (or any), but none matches the text. */
  | { kind: 'no-match'; query: string; filter: Filter }

export function listState(input: {
  loading: boolean
  error?: string
  resultCount: number
  query: string
  filter: Filter
  counts?: Partial<Record<ExplorerKind, number>>
}): ListState {
  if (input.error) return { kind: 'error', message: input.error }
  if (input.loading) return { kind: 'loading' }
  if (input.resultCount > 0) return { kind: 'ok' }
  if (input.filter !== 'all' && input.counts && (input.counts[input.filter] ?? 0) === 0) {
    return { kind: 'index-empty', filter: input.filter }
  }
  return { kind: 'no-match', query: input.query.trim(), filter: input.filter }
}

export function listStateMessage(s: ListState): string | null {
  switch (s.kind) {
    case 'ok': case 'loading': return null
    case 'error': return `Search failed: ${s.message}`
    case 'index-empty': return `The analysis found no ${FILTER_LABEL[s.filter].toLowerCase()}. Re-analyze if the project has some.`
    case 'no-match': return s.query
      ? `No ${s.filter === 'all' ? 'node' : FILTER_LABEL[s.filter].toLowerCase()} matches “${s.query}”.`
      : 'Nothing to list.'
  }
}

export function stalenessLabel(s?: { changed: number; added: number; removed: number }): string | null {
  if (!s) return null
  const total = s.changed + s.added + s.removed
  if (!total) return null
  const parts = [s.changed && `${s.changed} edited`, s.added && `${s.added} new`, s.removed && `${s.removed} removed`].filter(Boolean)
  return `${total} file${total === 1 ? '' : 's'} changed since the analysis (${parts.join(', ')})`
}

const fmtNeighbor = (nb: ExplorerNeighbor, dir: 'to' | 'from') =>
  `- ${nb.edge.relation}${nb.edge.confidence === 'INFERRED' ? ' (inferred)' : ''} ${dir === 'to' ? '→' : '←'} ${nb.node.label}${nb.node.file ? ` [${nb.node.file}${nb.node.line ? ':' + nb.node.line : ''}]` : ''}`

/** The prompt "Ask Claude / Ask Codex" sends: what, where (project, checkout, file:line) and the relations. */
export function buildAgentPrompt(d: ExplorerNodeDetail, ctx: { projectId: string; projectName?: string; root?: string }): string {
  const n = d.node
  const where = n.file ? `${n.file}${n.line ? ':' + n.line : ''}` : null
  return [
    `Investigate \`${n.label}\`${where ? ` in \`${where}\`` : ''} (${KIND_LABEL[n.kind].toLowerCase()}) in this Godot project.`,
    '',
    `Project: ${ctx.projectName ?? ctx.projectId} (id ${ctx.projectId})`,
    ...(ctx.root ? [`Checkout: ${ctx.root} — the graph was analyzed from this tree; file paths below are relative to it.`] : []),
    ...(where ? [`Location: ${where}`] : []),
    '',
    'Context from the Project Explorer (relations extracted by Graphify; "inferred" ones are name-based guesses and may point at the wrong same-named function):',
    '',
    `Depends on (${d.outgoing.length}):`,
    ...d.outgoing.slice(0, 30).map(x => fmtNeighbor(x, 'to')),
    '',
    `Referenced by (${d.incoming.length}):`,
    ...d.incoming.slice(0, 30).map(x => fmtNeighbor(x, 'from')),
    '',
    'Read the real code before answering and confirm any inferred relation. Explain what this does and how the relations above work together. Do not change anything until I ask.',
  ].join('\n')
}

/** `.gd` for the editor (its language table is keyed with the dot). */
export function extensionOf(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1)
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i) : ''
}
