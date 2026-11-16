import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Search, RefreshCw, FileCode2, Clapperboard, Package, FileQuestion, ArrowLeft,
  Code2, Sparkles, TextSearch, AlertTriangle, ArrowRight, ArrowLeftFromLine,
} from 'lucide-react'
import { api, type ExplorerNode, type ExplorerEdge } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useEditorTabsContext } from '@/hooks/useEditorTabsContext'
import { openContentSearch } from '@/components/layout/SearchPalette'

type Filter = 'all' | 'gd' | 'tscn' | 'tres' | 'problems'

const KIND_ICON = { gd: FileCode2, tscn: Clapperboard, tres: Package, missing: FileQuestion } as const
const EDGE_LABEL: Record<ExplorerEdge['kind'], string> = {
  extends: 'extends', preload: 'preload', load: 'load', literal: 'path literal',
  script: 'script', scene: 'scene', resource: 'resource',
}
const MAX_SIDE = 14

function isAsset(n: ExplorerNode) {
  return !!n.base?.startsWith('asset')
}

function scoreNode(n: ExplorerNode, terms: string[]): number {
  if (!terms.length) return 1
  const name = n.name.toLowerCase()
  const p = n.path.toLowerCase()
  let total = 0
  for (const t of terms) {
    let s = 0
    if (name === t) s = 100
    else if (name.startsWith(t)) s = 60
    else if (name.includes(t)) s = 40
    else if (p.includes(t)) s = 20
    else if (n.symbols.some(x => x.name.toLowerCase().includes(t))) s = 15
    if (!s) return 0
    total += s
  }
  return total
}

export function ProjectExplorer({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const editor = useEditorTabsContext()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['explorer', projectId],
    queryFn: () => api.getExplorer(projectId),
    staleTime: 30_000,
  })

  const index = data && data.godot ? data : null

  const byId = useMemo(() => new Map((index?.nodes ?? []).map(n => [n.id, n])), [index])
  const incoming = useMemo(() => {
    const m = new Map<string, ExplorerEdge[]>()
    for (const e of index?.edges ?? []) (m.get(e.to) ?? m.set(e.to, []).get(e.to)!).push(e)
    return m
  }, [index])
  const outgoing = useMemo(() => {
    const m = new Map<string, ExplorerEdge[]>()
    for (const e of index?.edges ?? []) (m.get(e.from) ?? m.set(e.from, []).get(e.from)!).push(e)
    return m
  }, [index])

  const results = useMemo(() => {
    if (!index) return []
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const pool = index.nodes.filter(n => {
      if (isAsset(n)) return false
      if (filter === 'problems') return n.kind === 'missing' || !!n.error
      return filter === 'all' || n.kind === filter
    })
    return pool
      .map(n => ({ n, s: scoreNode(n, terms) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || a.n.path.localeCompare(b.n.path))
      .map(x => x.n)
  }, [index, query, filter])

  const select = useCallback((id: string, push = true) => {
    setSelected(prev => {
      if (push && prev && prev !== id) setHistory(h => [...h.slice(-30), prev])
      return id
    })
  }, [])

  const back = () => {
    setHistory(h => {
      const prev = h[h.length - 1]
      if (prev) setSelected(prev)
      return h.slice(0, -1)
    })
  }

  // Selection survives a reindex only when the file still exists.
  useEffect(() => {
    if (index && selected && !byId.has(selected)) setSelected(null)
  }, [index, selected, byId])

  const reindex = async () => {
    setRefreshing(true)
    try {
      const fresh = await api.getExplorer(projectId, true)
      queryClient.setQueryData(['explorer', projectId], fresh)
      if (fresh.godot) toast.success(`Reindexed ${fresh.nodes.length} files in ${fresh.tookMs} ms`)
    } catch (err: any) {
      toast.error(err.message || 'Reindex failed')
    } finally {
      setRefreshing(false)
    }
  }

  const openInEditor = (n: ExplorerNode, line?: number) => {
    if (n.kind === 'missing') return
    const ext = n.name.includes('.') ? n.name.slice(n.name.lastIndexOf('.') + 1) : ''
    editor.openFileForProject(projectId, n.path, n.name, ext,
      line ? { reveal: { line, column: 1, length: 0 } } : undefined)
  }

  const askAgent = (n: ExplorerNode, agent?: 'codex') => {
    const out = outgoing.get(n.id) ?? []
    const inn = incoming.get(n.id) ?? []
    const fmt = (e: ExplorerEdge, other: string) => `- ${EDGE_LABEL[e.kind]} ${other}${e.resolved ? '' : ' (FILE NOT FOUND)'} — ${e.from === n.id ? n.path : e.from}:${e.line}`
    const prompt = [
      `Investigate \`${n.path}\` in this Godot project.`,
      '',
      'Context taken from the Project Explorer index (derived from the files, verified relations only):',
      n.symbols.length ? `Symbols: ${n.symbols.slice(0, 20).map(s => `${s.kind} ${s.name}`).join(', ')}` : '',
      n.base ? `Extends engine class: ${n.base}` : '',
      '',
      `Depends on (${out.length}):`,
      ...out.slice(0, 30).map(e => fmt(e, e.to)),
      '',
      `Referenced by (${inn.length}):`,
      ...inn.slice(0, 30).map(e => fmt(e, e.from)),
      '',
      'Read these files before answering. Explain what this file does and how the relations above work together. Do not change anything until I ask.',
    ].filter(l => l !== '' || true).join('\n')
    window.dispatchEvent(new CustomEvent('shipyard:open-terminal', {
      detail: { projectId, type: 'claude', prompt, ...(agent ? { agent } : {}) },
    }))
    toast.success(`Sent ${n.name} to ${agent === 'codex' ? 'Codex' : 'Claude'}`)
  }

  if (isLoading) return <Centered>Indexing project…</Centered>
  if (error) return <Centered>Could not index: {(error as Error).message}</Centered>
  if (!data) return null
  if (!data.godot) {
    return <Centered>No <code className="mx-1 font-mono">project.godot</code> in this project. The Project Explorer reads Godot projects.</Centered>
  }
  if (!index) return null

  const sel = selected ? byId.get(selected) : undefined
  const s = index.summary

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* ── Search + list ── */}
      <aside className="flex w-[290px] shrink-0 flex-col border-r bg-card/40">
        <div className="space-y-2 border-b p-2">
          <div className="flex items-center gap-1.5 rounded-md border bg-background px-2">
            <Search className="h-3 w-3 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search files and symbols"
              className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none"
              data-testid="explorer-search"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {(['all', 'gd', 'tscn', 'tres', 'problems'] as Filter[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium',
                  filter === f ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f === 'all' ? 'All' : f === 'problems' ? `Problems ${s.missing + s.errors}` : `.${f} ${s[f]}`}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-dark" data-testid="explorer-results">
          {results.slice(0, 300).map(n => {
            const Icon = KIND_ICON[n.kind]
            return (
              <button
                key={n.id}
                onClick={() => select(n.id)}
                className={cn(
                  'flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-accent/60',
                  selected === n.id && 'bg-accent',
                )}
              >
                <Icon className={cn('mt-0.5 h-3 w-3 shrink-0', n.kind === 'missing' ? 'text-destructive' : 'text-muted-foreground')} />
                <span className="min-w-0">
                  <span className="block truncate text-xs">{n.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{n.dir || '.'}</span>
                </span>
              </button>
            )
          })}
          {results.length > 300 && (
            <p className="px-2 py-2 text-[10px] text-muted-foreground">Showing 300 of {results.length}. Narrow the search.</p>
          )}
          {!results.length && <p className="px-2 py-3 text-xs text-muted-foreground">No match.</p>}
          {query.trim() && (
            <button
              onClick={() => openContentSearch(query.trim())}
              className="flex w-full items-center gap-2 border-t px-2 py-2 text-left text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            >
              <TextSearch className="h-3 w-3" /> Search “{query.trim()}” in file contents
            </button>
          )}
        </div>
        <div className="flex items-center justify-between border-t px-2 py-1.5 text-[10px] text-muted-foreground">
          <span title={`Skipped: ${s.skippedDirs.join(', ') || 'none'}`}>
            {s.gd} gd · {s.tscn} tscn · {s.tres} tres · {s.edges} relations
            {s.unresolved > 0 && <span className="text-warning"> · {s.unresolved} unresolved</span>}
          </span>
          <button onClick={reindex} disabled={refreshing} title={`Indexed ${new Date(index.indexedAt).toLocaleTimeString()} in ${index.tookMs} ms`}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground">
            <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} /> Reindex
          </button>
        </div>
      </aside>

      {/* ── Graph ── */}
      <section className="relative min-w-0 flex-1 overflow-hidden">
        {sel ? (
          <RelationGraph
            node={sel}
            byId={byId}
            incoming={incoming.get(sel.id) ?? []}
            outgoing={outgoing.get(sel.id) ?? []}
            onSelect={id => select(id)}
            canBack={history.length > 0}
            onBack={back}
          />
        ) : (
          <Centered>
            Select a file to see what it depends on and what references it.
            <span className="mt-2 block text-[11px]">Try searching “humus”.</span>
          </Centered>
        )}
      </section>

      {/* ── Inspector ── */}
      <aside className="w-[330px] shrink-0 overflow-y-auto border-l bg-card/40 scrollbar-dark" data-testid="explorer-inspector">
        {sel ? (
          <Inspector
            node={sel}
            byId={byId}
            incoming={incoming.get(sel.id) ?? []}
            outgoing={outgoing.get(sel.id) ?? []}
            onSelect={id => select(id)}
            onOpen={openInEditor}
            onAsk={askAgent}
          />
        ) : (
          <p className="p-3 text-xs text-muted-foreground">
            Relations come from literal references in the files (<code>extends</code>, <code>preload</code>,{' '}
            <code>load</code>, <code>[ext_resource]</code>, <code>res://</code> strings). Each one shows its file and line.
          </p>
        )}
      </aside>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">{children}</div>
}

const EDGE_COLOR: Record<ExplorerEdge['kind'], string> = {
  extends: 'hsl(var(--warning))', preload: 'hsl(var(--primary))', load: 'hsl(var(--primary))',
  script: 'hsl(var(--muted-foreground))', scene: 'hsl(var(--muted-foreground))',
  resource: 'hsl(var(--muted-foreground))', literal: 'hsl(var(--border))',
}

function RelationGraph({ node, byId, incoming, outgoing, onSelect, canBack, onBack }: {
  node: ExplorerNode
  byId: Map<string, ExplorerNode>
  incoming: ExplorerEdge[]
  outgoing: ExplorerEdge[]
  onSelect: (id: string) => void
  canBack: boolean
  onBack: () => void
}) {
  // One row per neighbour (several edges to the same file collapse to one,
  // labelled with each kind). The inspector lists every edge with its line.
  const group = (edges: ExplorerEdge[], pick: (e: ExplorerEdge) => string) => {
    const m = new Map<string, Set<ExplorerEdge['kind']>>()
    for (const e of edges) {
      const id = pick(e)
      if (id === node.id) continue
      ;(m.get(id) ?? m.set(id, new Set()).get(id)!).add(e.kind)
    }
    return [...m.entries()]
  }
  const ins = group(incoming, e => e.from)
  const outs = group(outgoing, e => e.to)

  const rowH = 34
  const rows = Math.max(1, Math.min(MAX_SIDE, Math.max(ins.length, outs.length)))
  const H = rows * rowH + 40
  const W = 900
  const cx = W / 2, cy = H / 2
  const boxW = 230
  const ys = (count: number, i: number) => (H - Math.min(count, MAX_SIDE) * rowH) / 2 + i * rowH + rowH / 2

  const NodeBox = ({ id, x, y, kinds, center }: { id: string; x: number; y: number; kinds?: Set<ExplorerEdge['kind']>; center?: boolean }) => {
    const n = byId.get(id)!
    const missing = n.kind === 'missing'
    return (
      <g transform={`translate(${x},${y})`} onClick={() => !center && onSelect(id)} className={center ? '' : 'cursor-pointer'} data-testid={center ? 'graph-center' : 'graph-node'} data-id={id}>
        <rect x={-boxW / 2} y={-13} width={boxW} height={26} rx={5}
          fill={center ? 'hsl(var(--accent))' : 'hsl(var(--card))'}
          stroke={missing ? 'hsl(var(--destructive))' : center ? 'hsl(var(--primary))' : 'hsl(var(--border))'}
          strokeDasharray={missing ? '4 3' : undefined} />
        <text x={-boxW / 2 + 8} y={4} fontSize={11} fill="hsl(var(--foreground))">
          {n.name.length > 30 ? n.name.slice(0, 29) + '…' : n.name}
        </text>
        {kinds && (
          <text x={boxW / 2 - 8} y={4} fontSize={9} textAnchor="end" fill="hsl(var(--muted-foreground))">
            {[...kinds].map(k => EDGE_LABEL[k]).join(' · ')}
          </text>
        )}
        <title>{n.path}</title>
      </g>
    )
  }

  const leftX = boxW / 2 + 10, rightX = W - boxW / 2 - 10
  const edgePath = (x1: number, y1: number, x2: number, y2: number) => {
    const mx = (x1 + x2) / 2
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-[11px] text-muted-foreground">
        <button onClick={onBack} disabled={!canBack} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent disabled:opacity-30">
          <ArrowLeft className="h-3 w-3" /> Back
        </button>
        <span className="truncate font-mono">{node.id}</span>
        <span className="ml-auto flex gap-3">
          <span>← referenced by {ins.length}</span><span>depends on {outs.length} →</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-dark">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minHeight: H, maxHeight: 'none' }} role="img" aria-label="Relation graph">
          {ins.slice(0, MAX_SIDE).map(([id], i) => {
            const kinds = [...(group(incoming, e => e.from).find(x => x[0] === id)?.[1] ?? [])]
            return <path key={'ei' + id} d={edgePath(leftX + boxW / 2, ys(ins.length, i), cx - boxW / 2, cy)} fill="none" stroke={EDGE_COLOR[kinds[0]]} strokeWidth={1.2} opacity={0.8} />
          })}
          {outs.slice(0, MAX_SIDE).map(([id, kinds], i) => (
            <path key={'eo' + id} d={edgePath(cx + boxW / 2, cy, rightX - boxW / 2, ys(outs.length, i))} fill="none"
              stroke={EDGE_COLOR[[...kinds][0]]} strokeWidth={1.2} opacity={0.8}
              strokeDasharray={byId.get(id)?.kind === 'missing' ? '4 3' : undefined} />
          ))}
          {ins.slice(0, MAX_SIDE).map(([id, kinds], i) => <NodeBox key={'ni' + id} id={id} x={leftX} y={ys(ins.length, i)} kinds={kinds} />)}
          {outs.slice(0, MAX_SIDE).map(([id, kinds], i) => <NodeBox key={'no' + id} id={id} x={rightX} y={ys(outs.length, i)} kinds={kinds} />)}
          <NodeBox id={node.id} x={cx} y={cy} center />
          {ins.length > MAX_SIDE && <text x={leftX} y={H - 6} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">+{ins.length - MAX_SIDE} more in the inspector</text>}
          {outs.length > MAX_SIDE && <text x={rightX} y={H - 6} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">+{outs.length - MAX_SIDE} more in the inspector</text>}
        </svg>
        {!ins.length && !outs.length && <p className="px-3 pb-3 text-xs text-muted-foreground">No verified relations for this file.</p>}
      </div>
    </div>
  )
}

function Inspector({ node, byId, incoming, outgoing, onSelect, onOpen, onAsk }: {
  node: ExplorerNode
  byId: Map<string, ExplorerNode>
  incoming: ExplorerEdge[]
  outgoing: ExplorerEdge[]
  onSelect: (id: string) => void
  onOpen: (n: ExplorerNode, line?: number) => void
  onAsk: (n: ExplorerNode, agent?: 'codex') => void
}) {
  const missing = node.kind === 'missing'
  const Row = ({ e, otherId }: { e: ExplorerEdge; otherId: string }) => {
    const other = byId.get(otherId)
    return (
      <div className="border-b px-3 py-1.5 last:border-0">
        <button onClick={() => onSelect(otherId)} className="flex w-full items-center gap-1.5 text-left text-xs hover:text-foreground">
          <span className="rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">{EDGE_LABEL[e.kind]}</span>
          <span className={cn('truncate', !e.resolved && 'text-destructive')}>{other?.name ?? otherId}</span>
          {!e.resolved && <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />}
        </button>
        <button
          onClick={() => { const src = byId.get(e.from); if (src) onOpen(src, e.line) }}
          title="Open the source line in the editor"
          className="mt-0.5 block w-full truncate text-left font-mono text-[10px] text-muted-foreground hover:text-foreground"
        >
          {byId.get(e.from)?.path}:{e.line} — {e.snippet}
        </button>
      </div>
    )
  }
  return (
    <div className="text-xs">
      <div className="space-y-1 border-b p-3">
        <div className="truncate text-sm font-medium">{node.name}</div>
        <div className="break-all font-mono text-[10px] text-muted-foreground">{node.id}</div>
        {node.base && !isAsset(node) && <div className="text-[11px] text-muted-foreground">extends engine class <code>{node.base}</code></div>}
        {missing && <div className="flex items-center gap-1 text-destructive"><AlertTriangle className="h-3 w-3" /> File does not exist; referenced below.</div>}
        {node.error && <div className="flex items-center gap-1 text-warning"><AlertTriangle className="h-3 w-3" /> {node.error}</div>}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <button disabled={missing} onClick={() => onOpen(node)} className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40" data-testid="open-in-editor">
            <Code2 className="h-3 w-3" /> Open in editor
          </button>
          <button disabled={missing} onClick={() => onAsk(node)} className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40" data-testid="ask-claude">
            <Sparkles className="h-3 w-3" /> Ask Claude
          </button>
          <button disabled={missing} onClick={() => onAsk(node, 'codex')} className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40">
            <Sparkles className="h-3 w-3" /> Ask Codex
          </button>
        </div>
      </div>

      {node.symbols.length > 0 && (
        <Section title={`Symbols ${node.symbols.length}`}>
          <div className="max-h-40 overflow-y-auto px-3 pb-2 scrollbar-dark">
            {node.symbols.slice(0, 80).map((s, i) => (
              <button key={i} onClick={() => onOpen(node, s.line)} className="flex w-full gap-2 py-0.5 text-left hover:text-foreground">
                <span className="w-16 shrink-0 text-[10px] uppercase text-muted-foreground">{s.kind}</span>
                <span className="truncate font-mono text-[11px]">{s.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{s.line}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title={<><ArrowRight className="h-3 w-3" /> Depends on {outgoing.length}</>}>
        {outgoing.map((e, i) => <Row key={i} e={e} otherId={e.to} />)}
        {!outgoing.length && <p className="px-3 pb-2 text-muted-foreground">Nothing.</p>}
      </Section>
      <Section title={<><ArrowLeftFromLine className="h-3 w-3" /> Referenced by {incoming.length}</>}>
        {incoming.map((e, i) => <Row key={i} e={e} otherId={e.from} />)}
        {!incoming.length && <p className="px-3 pb-2 text-muted-foreground">Nothing references this file directly.</p>}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border-b">
      <div className="flex items-center gap-1.5 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  )
}
