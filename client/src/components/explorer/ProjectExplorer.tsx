import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Search, RefreshCw, FileCode2, Zap, Box, CircleDashed, Braces, ArrowLeft,
  Code2, Sparkles, TextSearch, ArrowRight, ArrowLeftFromLine, Loader2,
} from 'lucide-react'
import { api, type ExplorerNode, type ExplorerNeighbor, type ExplorerNodeDetail, type ExplorerKind } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useEditorTabsContext } from '@/hooks/useEditorTabsContext'
import { openContentSearch } from '@/components/layout/SearchPalette'

/**
 * Project Explorer. The relations come from Graphify (external engine, Godot
 * fork) — see server/src/services/graphifyAdapter.ts. This view only searches,
 * navigates and inspects what Graphify extracted.
 */

type Filter = 'all' | ExplorerKind

const KIND_ICON: Record<ExplorerKind, typeof FileCode2> = {
  file: FileCode2, func: Braces, signal: Zap, class: Box, external: CircleDashed,
}
const KIND_LABEL: Record<ExplorerKind, string> = {
  file: 'File', func: 'Function', signal: 'Signal', class: 'Class', external: 'Engine / unresolved',
}
const FILTERS: Filter[] = ['all', 'file', 'func', 'signal', 'class']
const FILTER_LABEL: Record<ExplorerKind, string> = {
  file: 'Files', func: 'Functions', signal: 'Signals', class: 'Classes', external: 'Engine',
}
const MAX_SIDE = 14

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const clean = (label: string) => label.replace(/\(signal\)$/, '').replace(/^\./, '')

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

export function ProjectExplorer({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const editor = useEditorTabsContext()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [building, setBuilding] = useState(false)
  const debounced = useDebounced(query, 150)

  const statusQ = useQuery({
    queryKey: ['explorer', projectId],
    queryFn: () => api.getExplorer(projectId),
    staleTime: 10_000,
    refetchInterval: q => (q.state.data && 'godot' in q.state.data && q.state.data.godot && q.state.data.building ? 2000 : false),
  })
  const status = statusQ.data && statusQ.data.godot ? statusQ.data : null
  const built = !!status?.built

  const searchQ = useQuery({
    queryKey: ['explorer-search', projectId, debounced, filter, status?.builtAt],
    queryFn: ({ signal }) => api.searchExplorer(projectId, debounced, filter, signal),
    enabled: built,
    placeholderData: prev => prev,
  })

  const detailQ = useQuery({
    queryKey: ['explorer-node', projectId, selected, status?.builtAt],
    queryFn: () => api.getExplorerNode(projectId, selected!),
    enabled: built && !!selected,
    retry: false,
  })
  const detail = selected ? detailQ.data : undefined

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

  const build = async () => {
    setBuilding(true)
    try {
      const r = await api.buildExplorer(projectId)
      toast.success(`Graphify: ${r.nodes} nodes, ${r.edges} relations from ${r.files} files in ${(r.tookMs / 1000).toFixed(1)}s`)
      await queryClient.invalidateQueries({ queryKey: ['explorer', projectId] })
    } catch (err: any) {
      toast.error(err.message || 'Graphify failed')
    } finally {
      setBuilding(false)
    }
  }

  const openInEditor = (file: string, line?: number) => {
    if (!file) return
    const name = baseName(file)
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
    editor.openFileForProject(projectId, file, name, ext,
      line ? { reveal: { line, column: 1, length: 0 } } : undefined)
  }

  const askAgent = (d: ExplorerNodeDetail, agent?: 'codex') => {
    const fmt = (nb: ExplorerNeighbor, dir: 'to' | 'from') =>
      `- ${nb.edge.relation}${nb.edge.confidence === 'INFERRED' ? ' (inferred)' : ''} ${dir === 'to' ? '→' : '←'} ${nb.node.label}${nb.node.file ? ` [${nb.node.file}${nb.node.line ? ':' + nb.node.line : ''}]` : ''}`
    const n = d.node
    const prompt = [
      `Investigate \`${n.label}\`${n.file ? ` in \`${n.file}${n.line ? ':' + n.line : ''}\`` : ''} (${KIND_LABEL[n.kind].toLowerCase()}) in this Godot project.`,
      '',
      'Context from the Project Explorer (relations extracted by Graphify; "inferred" ones are name-based guesses and may point at the wrong same-named function):',
      '',
      `Depends on (${d.outgoing.length}):`,
      ...d.outgoing.slice(0, 30).map(x => fmt(x, 'to')),
      '',
      `Referenced by (${d.incoming.length}):`,
      ...d.incoming.slice(0, 30).map(x => fmt(x, 'from')),
      '',
      'Read the real code before answering and confirm any inferred relation. Explain what this does and how the relations above work together. Do not change anything until I ask.',
    ].join('\n')
    window.dispatchEvent(new CustomEvent('shipyard:open-terminal', {
      detail: { projectId, type: 'claude', prompt, ...(agent ? { agent } : {}) },
    }))
    toast.success(`Sent ${clean(n.label)} to ${agent === 'codex' ? 'Codex' : 'Claude'}`)
  }

  if (statusQ.isLoading) return <Centered>Loading…</Centered>
  if (statusQ.error) return <Centered>Could not load: {(statusQ.error as Error).message}</Centered>
  if (!statusQ.data) return null
  if (!statusQ.data.godot) {
    return <Centered>No <code className="mx-1 font-mono">project.godot</code> in this project. The Project Explorer reads Godot projects.</Centered>
  }
  if (!status) return null

  if (!built) {
    const busy = building || status.building
    return (
      <Centered>
        <div className="max-w-md space-y-3">
          <p>The Project Explorer reads a relation graph built by <b>Graphify</b> (Godot fork) from your <code>.gd</code>, <code>.tscn</code> and <code>.tres</code> files.</p>
          {!status.installed ? (
            <p className="text-warning">Graphify is not installed. Run <code className="font-mono">pnpm graphify:setup</code> in the Shipyard folder, then come back.</p>
          ) : (
            <button onClick={build} disabled={busy}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-60" data-testid="explorer-build">
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {busy ? 'Analyzing project…' : 'Analyze project'}
            </button>
          )}
          <p className="text-[11px]">Your checkout is not touched: files are copied to Shipyard's data folder first.</p>
        </div>
      </Centered>
    )
  }

  const results = searchQ.data?.nodes ?? []
  const s = status.summary!

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
              placeholder="Search files, functions, signals"
              className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none"
              data-testid="explorer-search"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium',
                  filter === f ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f === 'all' ? 'All' : FILTER_LABEL[f]}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-dark" data-testid="explorer-results">
          {results.map(n => {
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
                <Icon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-xs">{clean(n.label)}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{n.file || KIND_LABEL[n.kind]}</span>
                </span>
              </button>
            )
          })}
          {searchQ.data && searchQ.data.total > results.length && (
            <p className="px-2 py-2 text-[10px] text-muted-foreground">Showing {results.length} of {searchQ.data.total}. Narrow the search.</p>
          )}
          {searchQ.data && !results.length && <p className="px-2 py-3 text-xs text-muted-foreground">No match.</p>}
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
          <span title={Object.entries(s.relations).map(([k, v]) => `${k} ${v}`).join(' · ')}>
            {s.files} files · {s.edges} relations
          </span>
          <button onClick={build} disabled={building || status.building}
            title={`Analyzed ${new Date(status.builtAt!).toLocaleString()}. Re-run after code changes.`}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground">
            <RefreshCw className={cn('h-3 w-3', (building || status.building) && 'animate-spin')} /> Re-analyze
          </button>
        </div>
      </aside>

      {/* ── Graph ── */}
      <section className="relative min-w-0 flex-1 overflow-hidden">
        {selected && detail ? (
          <RelationGraph detail={detail} onSelect={id => select(id)} canBack={history.length > 0} onBack={back} />
        ) : selected && detailQ.isLoading ? (
          <Centered><Loader2 className="h-4 w-4 animate-spin" /></Centered>
        ) : (
          <Centered>
            Select a file, function or signal to see what it depends on and what references it.
            <span className="mt-2 block text-[11px]">Try searching “humus”.</span>
          </Centered>
        )}
      </section>

      {/* ── Inspector ── */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-l bg-card/40 scrollbar-dark" data-testid="explorer-inspector">
        {detail ? (
          <Inspector detail={detail} onSelect={id => select(id)} onOpen={openInEditor} onAsk={askAgent} />
        ) : (
          <div className="space-y-2 p-3 text-xs text-muted-foreground">
            <p>Relations are extracted statically by Graphify. <b>Extracted</b> ones are read directly from the code; <b>inferred</b> ones are matched by name and can be wrong.</p>
            <p>Dynamic loads (<code>load(variable)</code>, directory scans) and shaders are not seen.</p>
          </div>
        )}
      </aside>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">{children}</div>
}

/** One row per neighbour; several relations to the same node collapse to one. */
function groupNeighbors(list: ExplorerNeighbor[], side: 'to' | 'from', selfId: string) {
  const m = new Map<string, { node: ExplorerNode; relations: Set<string>; inferred: boolean }>()
  for (const nb of list) {
    if (nb.node.id === selfId) continue
    const cur = m.get(nb.node.id) ?? { node: nb.node, relations: new Set<string>(), inferred: true }
    cur.relations.add(nb.edge.relation)
    if (nb.edge.confidence === 'EXTRACTED') cur.inferred = false
    m.set(nb.node.id, cur)
  }
  void side
  return [...m.values()]
}

function RelationGraph({ detail, onSelect, canBack, onBack }: {
  detail: ExplorerNodeDetail
  onSelect: (id: string) => void
  canBack: boolean
  onBack: () => void
}) {
  const node = detail.node
  const ins = useMemo(() => groupNeighbors(detail.incoming, 'from', node.id), [detail, node.id])
  const outs = useMemo(() => groupNeighbors(detail.outgoing, 'to', node.id), [detail, node.id])

  const rowH = 34
  const rows = Math.max(1, Math.min(MAX_SIDE, Math.max(ins.length, outs.length)))
  const H = rows * rowH + 40
  const W = 900
  const cx = W / 2, cy = H / 2
  const boxW = 250
  const ys = (count: number, i: number) => (H - Math.min(count, MAX_SIDE) * rowH) / 2 + i * rowH + rowH / 2

  const NodeBox = ({ n, x, y, relations, inferred, center }: { n: ExplorerNode; x: number; y: number; relations?: Set<string>; inferred?: boolean; center?: boolean }) => {
    const label = clean(n.label)
    return (
      <g transform={`translate(${x},${y})`} onClick={() => !center && onSelect(n.id)} className={center ? '' : 'cursor-pointer'} data-testid={center ? 'graph-center' : 'graph-node'} data-id={n.id}>
        <rect x={-boxW / 2} y={-13} width={boxW} height={26} rx={5}
          fill={center ? 'hsl(var(--accent))' : 'hsl(var(--card))'}
          stroke={center ? 'hsl(var(--primary))' : 'hsl(var(--border))'}
          strokeDasharray={inferred ? '4 3' : undefined} />
        <text x={-boxW / 2 + 8} y={4} fontSize={11} fill="hsl(var(--foreground))">
          {label.length > 26 ? label.slice(0, 25) + '…' : label}
        </text>
        {relations && (
          <text x={boxW / 2 - 8} y={4} fontSize={9} textAnchor="end" fill="hsl(var(--muted-foreground))">
            {[...relations].join(' · ')}
          </text>
        )}
        <title>{`${n.label}${n.file ? ' — ' + n.file : ''}`}</title>
      </g>
    )
  }

  const leftX = boxW / 2 + 10, rightX = W - boxW / 2 - 10
  const edgePath = (x1: number, y1: number, x2: number, y2: number) => {
    const mx = (x1 + x2) / 2
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
  }
  const stroke = (inferred: boolean) => (inferred ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary))')

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-[11px] text-muted-foreground">
        <button onClick={onBack} disabled={!canBack} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent disabled:opacity-30">
          <ArrowLeft className="h-3 w-3" /> Back
        </button>
        <span className="truncate font-mono">{node.file || node.label}</span>
        <span className="ml-auto flex gap-3">
          <span>← referenced by {ins.length}</span><span>depends on {outs.length} →</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-dark">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minHeight: H }} role="img" aria-label="Relation graph">
          {ins.slice(0, MAX_SIDE).map((x, i) => (
            <path key={'ei' + x.node.id} d={edgePath(leftX + boxW / 2, ys(ins.length, i), cx - boxW / 2, cy)} fill="none"
              stroke={stroke(x.inferred)} strokeWidth={1.2} opacity={0.8} strokeDasharray={x.inferred ? '4 3' : undefined} />
          ))}
          {outs.slice(0, MAX_SIDE).map((x, i) => (
            <path key={'eo' + x.node.id} d={edgePath(cx + boxW / 2, cy, rightX - boxW / 2, ys(outs.length, i))} fill="none"
              stroke={stroke(x.inferred)} strokeWidth={1.2} opacity={0.8} strokeDasharray={x.inferred ? '4 3' : undefined} />
          ))}
          {ins.slice(0, MAX_SIDE).map((x, i) => <NodeBox key={'ni' + x.node.id} n={x.node} x={leftX} y={ys(ins.length, i)} relations={x.relations} inferred={x.inferred} />)}
          {outs.slice(0, MAX_SIDE).map((x, i) => <NodeBox key={'no' + x.node.id} n={x.node} x={rightX} y={ys(outs.length, i)} relations={x.relations} inferred={x.inferred} />)}
          <NodeBox n={node} x={cx} y={cy} center />
          {ins.length > MAX_SIDE && <text x={leftX} y={H - 6} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">+{ins.length - MAX_SIDE} more in the inspector</text>}
          {outs.length > MAX_SIDE && <text x={rightX} y={H - 6} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">+{outs.length - MAX_SIDE} more in the inspector</text>}
        </svg>
        <p className="px-3 pb-3 text-[10px] text-muted-foreground">Solid = read from the code · dashed = inferred by name.</p>
        {!ins.length && !outs.length && <p className="px-3 pb-3 text-xs text-muted-foreground">No relations found for this node.</p>}
      </div>
    </div>
  )
}

function Inspector({ detail, onSelect, onOpen, onAsk }: {
  detail: ExplorerNodeDetail
  onSelect: (id: string) => void
  onOpen: (file: string, line?: number) => void
  onAsk: (d: ExplorerNodeDetail, agent?: 'codex') => void
}) {
  const { node } = detail
  const canOpen = !!node.file
  const Row = ({ nb, other }: { nb: ExplorerNeighbor; other: 'from' | 'to' }) => {
    const target = nb.node
    const inferred = nb.edge.confidence !== 'EXTRACTED'
    return (
      <div className="border-b px-3 py-1.5 last:border-0">
        <button onClick={() => onSelect(target.id)} className="flex w-full items-center gap-1.5 text-left text-xs hover:text-foreground">
          <span className="rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">{nb.edge.relation.replace('_', ' ')}</span>
          <span className="truncate">{clean(target.label)}</span>
          {nb.edge.count > 1 && <span className="text-[10px] text-muted-foreground">×{nb.edge.count}</span>}
          {inferred && <span className="ml-auto rounded border border-dashed px-1 text-[9px] text-warning" title="Matched by name, not read from the code. Verify before trusting.">inferred</span>}
        </button>
        <div className="mt-0.5 flex gap-2 text-[10px] text-muted-foreground">
          {target.file && (
            <button onClick={() => onOpen(target.file, target.line || undefined)} title="Open the target in the editor" className="truncate font-mono hover:text-foreground">
              {target.file}{target.line ? `:${target.line}` : ''}
            </button>
          )}
          {nb.edge.file && nb.edge.line > 0 && (
            <button onClick={() => onOpen(nb.edge.file, nb.edge.line)} title={`Open where this relation is declared (${other === 'from' ? 'caller' : 'call site'})`}
              className="ml-auto shrink-0 hover:text-foreground">
              @{baseName(nb.edge.file)}:{nb.edge.line}
            </button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="text-xs">
      <div className="space-y-1 border-b p-3">
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">{KIND_LABEL[node.kind]}</span>
          <span className="truncate text-sm font-medium">{clean(node.label)}</span>
        </div>
        {node.file && <div className="break-all font-mono text-[10px] text-muted-foreground">{node.file}{node.line ? `:${node.line}` : ''}</div>}
        {detail.container && (
          <button onClick={() => onSelect(detail.container!.id)} className="text-[11px] text-muted-foreground hover:text-foreground">
            in <span className="font-mono">{detail.container.label}</span>
          </button>
        )}
        {!node.file && <div className="text-[11px] text-muted-foreground">Engine class or reference Graphify could not resolve to a project file.</div>}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <button disabled={!canOpen} onClick={() => onOpen(node.file, node.line || undefined)} className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40" data-testid="open-in-editor">
            <Code2 className="h-3 w-3" /> Open in editor
          </button>
          <button onClick={() => onAsk(detail)} className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent" data-testid="ask-claude">
            <Sparkles className="h-3 w-3" /> Ask Claude
          </button>
          <button onClick={() => onAsk(detail, 'codex')} className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent">
            <Sparkles className="h-3 w-3" /> Ask Codex
          </button>
        </div>
      </div>

      {detail.contains.length > 0 && (
        <Section title={`Contains ${detail.contains.length}`}>
          <div className="max-h-44 overflow-y-auto px-3 pb-2 scrollbar-dark">
            {detail.contains.slice(0, 300).map(c => (
              <button key={c.id} onClick={() => onSelect(c.id)} className="flex w-full gap-2 py-0.5 text-left hover:text-foreground">
                <span className="w-12 shrink-0 text-[10px] uppercase text-muted-foreground">{c.kind === 'func' ? 'func' : c.kind}</span>
                <span className="truncate font-mono text-[11px]">{clean(c.label)}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{c.line || ''}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title={<><ArrowRight className="h-3 w-3" /> Depends on {detail.outgoing.length}</>}>
        {detail.outgoing.map((nb, i) => <Row key={i} nb={nb} other="to" />)}
        {!detail.outgoing.length && <p className="px-3 pb-2 text-muted-foreground">Nothing.</p>}
      </Section>
      <Section title={<><ArrowLeftFromLine className="h-3 w-3" /> Referenced by {detail.incoming.length}</>}>
        {detail.incoming.map((nb, i) => <Row key={i} nb={nb} other="from" />)}
        {!detail.incoming.length && <p className="px-3 pb-2 text-muted-foreground">Nothing references this directly.</p>}
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
