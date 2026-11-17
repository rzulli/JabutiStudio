import { useMemo, useState } from 'react'
import { Code2, Network, Sparkles } from 'lucide-react'
import type { SystemView } from '@/lib/api'
import { buildSystemMap, edgePath, type MapEdge, type MapNode } from '@/lib/systemMap'
import { cn } from '@/lib/utils'
import { BasisPill, EvidenceLine, type SystemActions } from './parts'

/**
 * The map: responsibilities in the middle, gameplay relations as solid edges (with their evidence basis),
 * technical links from the code graph as dashed edges from the whole-system node. A selected node or edge
 * opens an inspector with the evidence and the actions that belong to that object.
 */
export function SystemMap({ v, actions, compact, selectedArea, onSelectArea }: {
  v: SystemView; actions: SystemActions; compact?: boolean
  selectedArea?: string | null; onSelectArea?: (id: string | null) => void
}) {
  const [showWeak, setShowWeak] = useState(false)
  const [showTech, setShowTech] = useState(true)
  const [sel, setSel] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null)
  const layout = useMemo(() => buildSystemMap(v, { showWeak, showTechnical: showTech }), [v, showWeak, showTech])
  const byId = useMemo(() => new Map(layout.nodes.map(n => [n.id, n])), [layout])
  const hiddenWeak = v.relations.filter(r => r.basis === 'candidate' || r.basis === 'stale').length

  const selNode = sel?.kind === 'node' ? byId.get(sel.id) : undefined
  const selEdge = sel?.kind === 'edge' ? layout.edges.find(e => e.id === sel.id) : undefined
  const pick = (s: typeof sel) => {
    setSel(s)
    if (s?.kind === 'node') { const n = byId.get(s.id); onSelectArea?.(n?.areaId ?? null) }
  }

  const empty = layout.nodes.length <= 1 && !layout.edges.length
  return (
    <div className="space-y-2" data-testid="system-map">
      {!compact && (
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <Legend />
          <label className="ml-auto flex items-center gap-1"><input type="checkbox" checked={showTech} onChange={e => setShowTech(e.target.checked)} /> code links</label>
          <label className="flex items-center gap-1" title="Relations without verifiable evidence in this checkout">
            <input type="checkbox" checked={showWeak} onChange={e => setShowWeak(e.target.checked)} data-testid="map-show-weak" /> candidates ({hiddenWeak})
          </label>
        </div>
      )}
      <div className="overflow-x-auto rounded-md border bg-card/30">
        <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} className="mx-auto block max-w-full" role="img" aria-label={`Map of ${v.name}`}>
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground" /></marker>
            <marker id="arrow-sel" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" className="fill-foreground" /></marker>
          </defs>
          {layout.edges.map(e => <Edge key={e.id} e={e} byId={byId} active={sel?.kind === 'edge' && sel.id === e.id} onPick={() => pick({ kind: 'edge', id: e.id })} />)}
          {layout.nodes.map(n => (
            <Node key={n.id} n={n} active={(sel?.kind === 'node' && sel.id === n.id) || (!!n.areaId && n.areaId === selectedArea)} onPick={() => pick({ kind: 'node', id: n.id })} />
          ))}
        </svg>
      </div>
      {empty && (
        <p className="text-[11px] text-muted-foreground" data-testid="map-empty">
          Nothing to draw yet: no responsibilities are described and no gameplay relation is documented. Ask an agent to propose them (it can only propose).
        </p>
      )}
      {!compact && v.relations.length === 0 && !empty && (
        <p className="text-[11px] text-muted-foreground">No gameplay relation is documented for this system. Dashed lines are code references from the graph — they do not prove gameplay responsibility.</p>
      )}
      {!compact && (selNode || selEdge) && (
        <div className="rounded-md border p-2.5" data-testid="map-inspector">
          {selNode && <NodeInspector n={selNode} v={v} actions={actions} />}
          {selEdge && <EdgeInspector e={selEdge} v={v} actions={actions} />}
        </div>
      )}
    </div>
  )
}

function Legend() {
  return (
    <span className="flex items-center gap-3">
      <span className="flex items-center gap-1"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" className="stroke-foreground" strokeWidth="1.6" /></svg>gameplay (demonstrated)</span>
      <span className="flex items-center gap-1"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" className="stroke-foreground" strokeWidth="1.6" strokeDasharray="5 3" /></svg>inferred / code link</span>
    </span>
  )
}

function Node({ n, active, onPick }: { n: MapNode; active: boolean; onPick: () => void }) {
  const label = n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label
  return (
    <g onClick={onPick} className="cursor-pointer" data-testid="map-node" data-node={n.id}>
      <title>{n.label}{n.sub ? ` — ${n.sub}` : ''}</title>
      <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={6}
        className={cn(n.type === 'self' ? 'fill-accent' : 'fill-card', active ? 'stroke-foreground' : 'stroke-border')}
        strokeWidth={active ? 1.6 : 1} strokeDasharray={n.soft ? '4 3' : undefined} />
      <text x={n.x + 10} y={n.y + 19} className="fill-foreground text-[11px] font-medium">{label}</text>
      <text x={n.x + 10} y={n.y + 33} className="fill-muted-foreground text-[9px]">{n.sub ?? n.type}</text>
    </g>
  )
}

function Edge({ e, byId, active, onPick }: { e: MapEdge; byId: Map<string, MapNode>; active: boolean; onPick: () => void }) {
  const a = byId.get(e.from), b = byId.get(e.to)
  if (!a || !b) return null
  const { d, mx, my } = edgePath(a, b)
  const dashed = e.layer === 'technical' || e.basis !== 'demonstrated'
  return (
    <g onClick={onPick} className="cursor-pointer" data-testid="map-edge" data-layer={e.layer} data-basis={e.basis}>
      <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
      <path d={d} fill="none" className={cn(active ? 'stroke-foreground' : 'stroke-muted-foreground')} strokeWidth={e.layer === 'gameplay' ? 1.6 : 1}
        strokeDasharray={dashed ? '5 3' : undefined} markerEnd={`url(#${active ? 'arrow-sel' : 'arrow'})`} opacity={e.layer === 'technical' && !active ? 0.55 : 1} />
      <rect x={mx - 3 - e.label.length * 2.6} y={my - 7} width={e.label.length * 5.2 + 6} height={13} rx={3} className="fill-background" opacity={0.92} />
      <text x={mx} y={my + 3} textAnchor="middle" className="fill-foreground text-[9px]">{e.label}</text>
    </g>
  )
}

function NodeInspector({ n, v, actions }: { n: MapNode; v: SystemView; actions: SystemActions }) {
  const area = n.areaId ? v.areas.find(a => a.id === n.areaId) : undefined
  if (n.type === 'self') {
    return (
      <div className="space-y-1.5 text-[11px]">
        <p className="text-xs font-medium">{v.name} <span className="font-normal text-muted-foreground">— the whole system</span></p>
        <p className="text-muted-foreground">{v.summary || 'No responsibility written.'}</p>
        <div className="flex gap-1.5"><AskBtn label="Ask Claude" onClick={() => actions.onAsk('claude')} /></div>
      </div>
    )
  }
  if (!area) {
    return (
      <div className="space-y-1 text-[11px]">
        <p className="text-xs font-medium">{n.label} <span className="font-normal text-muted-foreground">— {n.sub}</span></p>
        {n.systemId && <button className="underline" onClick={() => actions.onPickSystem?.(n.systemId!)}>Open that system</button>}
        {n.soft && <p className="text-muted-foreground">Not a described system or area of this project: it appears only as the endpoint of a relation or a code reference.</p>}
      </div>
    )
  }
  const core = area.files.filter(f => f.tier === 'core')
  const cited = area.evidence.find(e => e.line && e.state !== 'missing')
  const entry = cited ? { path: cited.resolvedPath ?? cited.path, line: cited.line } : core[0] ? { path: core[0].path, line: core[0].line } : undefined
  return (
    <div className="space-y-1.5 text-[11px]" data-testid="area-inspector">
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="text-xs font-medium">{area.name}</p>
        <span className="rounded bg-accent px-1.5 text-[10px]">{area.kind === 'facet' ? 'inferred group' : area.kind}</span>
        <BasisPill basis={area.basis} />
        {area.inferred && <span className="text-[10px] text-warning">grouped from file names, not a design judgement</span>}
      </div>
      {area.summary && <p className="text-muted-foreground">{area.summary}</p>}
      <p className="text-muted-foreground">{area.fileCount} files · {core.length} core · {area.testCount} tests{area.families.length ? ` · ${area.families.length} resource families` : ''}</p>
      {core.slice(0, 4).map(f => (
        <button key={f.path} className="block truncate font-mono hover:underline" onClick={() => actions.onOpen(f.path, f.line)} title="Open in the editor (the system view stays)">{f.path}{f.line ? `:${f.line}` : ''}</button>
      ))}
      {area.evidence.slice(0, 3).map(e => <EvidenceLine key={`${e.path}|${e.needle}`} e={e} onOpen={actions.onOpen} />)}
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {entry && <button className="flex items-center gap-1 rounded-md border px-2 py-0.5 hover:bg-accent" onClick={() => actions.onOpen(entry.path, entry.line)}><Code2 className="h-3 w-3" /> Open code</button>}
        {entry && <button className="flex items-center gap-1 rounded-md border px-2 py-0.5 hover:bg-accent" onClick={() => actions.onGraph(entry.path)}><Network className="h-3 w-3" /> Graphify</button>}
        <AskBtn label="Ask Claude about this" onClick={() => actions.onAsk('claude', area.id)} />
      </div>
    </div>
  )
}

function EdgeInspector({ e, v, actions }: { e: MapEdge; v: SystemView; actions: SystemActions }) {
  const from = e.from, to = e.to
  if (e.layer === 'technical') {
    const t = v.technical.find(x => `tech:${x.toSystem ? `system:sys:${x.toSystem}` : `tech:${x.toName}`}` === e.id)
    return (
      <div className="space-y-1 text-[11px]" data-testid="edge-inspector">
        <p className="text-xs font-medium">Code link: {t?.toName ?? to}</p>
        <p className="text-warning">Technical, not gameplay. {t ? `${t.extracted} extracted, ${t.inferred} matched by name only.` : ''} A call or import does not prove that this system is responsible for the other.</p>
        {t && Object.entries(t.relations).map(([k, n]) => <span key={k} className="mr-2 rounded bg-accent px-1.5 text-[10px]">{k} ×{n}</span>)}
        {t?.files.slice(0, 4).map(f => <button key={f} className="block truncate font-mono hover:underline" onClick={() => actions.onOpen(f)}>{f}</button>)}
      </div>
    )
  }
  const r = v.relations.find(x => x.id === e.relationId)
  if (!r) return null
  return (
    <div className="space-y-1.5 text-[11px]" data-testid="edge-inspector">
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="text-xs font-medium">{r.from.label} {r.label} {r.to.label}</p>
        <BasisPill basis={r.basis} />
        <span className="rounded bg-accent px-1.5 text-[10px]">{r.status === 'confirmed' ? 'confirmed by you' : `proposed by ${r.origin}`}</span>
      </div>
      {r.note && <p className="text-muted-foreground">{r.note}</p>}
      {r.evidence.length === 0 && <p className="text-warning">No evidence recorded: shown only because candidates are visible.</p>}
      {r.evidence.map(ev => <EvidenceLine key={`${ev.path}|${ev.needle}`} e={ev} onOpen={actions.onOpen} />)}
      <p className="text-[10px] text-muted-foreground">Checked against {v.checkout.branch ?? '?'} {v.checkout.head ?? ''}{v.checkout.uncommitted ? ` (+${v.checkout.uncommitted} uncommitted)` : ''}. {from !== to ? '' : ''}</p>
      <AskBtn label="Investigate this relation" onClick={() => actions.onAsk('claude', undefined, `Verify this gameplay relation in the real code and report whether it holds: ${r.from.label} ${r.label} ${r.to.label}. Evidence given: ${r.evidence.map(x => `${x.resolvedPath ?? x.path}${x.line ? `:${x.line}` : ''} [${x.state}]`).join('; ') || 'none'}. Do not edit code.`)} />
    </div>
  )
}

function AskBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return <button onClick={onClick} className="flex items-center gap-1 rounded-md border px-2 py-0.5 hover:bg-accent"><Sparkles className="h-3 w-3" /> {label}</button>
}
