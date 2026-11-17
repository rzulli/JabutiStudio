import type { SystemView } from './api'

/**
 * Deterministic layout for the System Explorer map. Pure (no DOM), so the server test runner can check it.
 *
 * Three columns: where things come from (left), the responsibilities of this system (centre), where they go
 * (right). Gameplay relations are solid edges and carry their evidence basis; technical links from the code
 * graph are dashed edges from the whole-system node and are NEVER drawn as gameplay.
 */

export interface MapNode {
  id: string
  label: string
  type: 'self' | 'area' | 'system' | 'entity'
  column: 0 | 1 | 2
  x: number; y: number; w: number; h: number
  areaId?: string; systemId?: string
  /** inferred areas (grouped by file name) and unknown endpoints are drawn hollow */
  soft: boolean
  sub?: string
}
export interface MapEdge {
  id: string
  from: string; to: string
  layer: 'gameplay' | 'technical'
  label: string
  basis: 'demonstrated' | 'inferred' | 'candidate' | 'stale'
  status?: 'proposed' | 'confirmed'
  relationId?: string
  detail?: string
}
export interface SystemMapLayout { nodes: MapNode[]; edges: MapEdge[]; width: number; height: number }

export const NODE_W = 168
export const NODE_H = 44
const GAP_Y = 14
const COL_X = [8, 262, 516]
const SELF_ID = 'self'

/** Whether a relation is drawn when evidence is missing: candidates stay out of the default map. */
export function visibleEdge(basis: MapEdge['basis'], showWeak: boolean) {
  return showWeak || basis === 'demonstrated' || basis === 'inferred'
}

export function buildSystemMap(v: Pick<SystemView, 'id' | 'name' | 'areas' | 'relations' | 'technical'>, opts: { showWeak?: boolean; showTechnical?: boolean } = {}): SystemMapLayout {
  const showWeak = !!opts.showWeak
  const nodes = new Map<string, MapNode>()
  const edges: MapEdge[] = []
  const mk = (n: Omit<MapNode, 'x' | 'y' | 'w' | 'h'>) => { if (!nodes.has(n.id)) nodes.set(n.id, { ...n, x: 0, y: 0, w: NODE_W, h: NODE_H }); return nodes.get(n.id)! }

  mk({ id: SELF_ID, label: v.name, type: 'self', column: 1, soft: false, sub: 'whole system' })
  for (const a of v.areas) mk({ id: `area:${a.id}`, label: a.name, type: 'area', column: 1, areaId: a.id, soft: a.inferred, sub: a.inferred ? 'inferred from file names' : a.kind })

  const idOf = (e: SystemView['relations'][number]['from']): string => {
    if (e.type === 'self') return SELF_ID
    if (e.type === 'area' && e.areaId && (!e.systemId || e.systemId === v.id)) return nodes.has(`area:${e.areaId}`) ? `area:${e.areaId}` : SELF_ID
    return `${e.type}:${e.ref}`
  }
  // Which side an external endpoint lives on: the left if it only ever feeds this system, else the right.
  const feeds = new Set<string>(); const fed = new Set<string>()

  for (const r of v.relations) {
    if (!visibleEdge(r.basis, showWeak)) continue
    const f = idOf(r.from), t = idOf(r.to)
    for (const [e, id] of [[r.from, f], [r.to, t]] as const) {
      if (nodes.has(id)) continue
      const other = e.type === 'system' || e.type === 'area'
      mk({ id, label: e.label, type: other ? 'system' : 'entity', column: 2, soft: !e.known, systemId: e.systemId, sub: other ? 'other system' : 'resource / entity' })
    }
    const fromInternal = nodes.get(f)!.column === 1, toInternal = nodes.get(t)!.column === 1
    if (fromInternal && !toInternal) fed.add(t)
    if (!fromInternal && toInternal) feeds.add(f)
    edges.push({
      id: r.id, relationId: r.id, from: f, to: t, layer: 'gameplay', label: r.label, basis: r.basis, status: r.status,
      detail: r.evidence.length ? `${r.evidence.length} evidence item(s)` : 'no evidence recorded',
    })
  }
  for (const id of feeds) if (!fed.has(id)) nodes.get(id)!.column = 0

  if (opts.showTechnical !== false) {
    for (const t of v.technical.slice(0, 8)) {
      const id = t.toSystem ? `system:sys:${t.toSystem}` : `tech:${t.toName}`
      if (!nodes.has(id)) mk({ id, label: t.toName, type: 'system', column: 2, soft: true, systemId: t.toSystem, sub: 'code link only' })
      edges.push({
        id: `tech:${id}`, from: SELF_ID, to: id, layer: 'technical',
        label: `${t.edges} code ref${t.edges === 1 ? '' : 's'}`, basis: t.extracted ? 'inferred' : 'candidate',
        detail: `${t.extracted} extracted / ${t.inferred} name-based`,
      })
    }
  }

  // Place: each column stacked, the centre ordered self first, then areas by declaration.
  const cols: MapNode[][] = [[], [], []]
  for (const n of nodes.values()) cols[n.column].push(n)
  const rows = Math.max(...cols.map(c => c.length), 1)
  const height = rows * (NODE_H + GAP_Y) + GAP_Y
  cols.forEach((list, ci) => {
    const total = list.length * (NODE_H + GAP_Y) - GAP_Y
    let y = Math.max(GAP_Y, (height - total) / 2)
    for (const n of list) { n.x = COL_X[ci]; n.y = y; y += NODE_H + GAP_Y }
  })
  return { nodes: [...nodes.values()], edges, width: COL_X[2] + NODE_W + 8, height }
}

/** Cubic path from the facing sides of two nodes. */
export function edgePath(a: MapNode, b: MapNode): { d: string; mx: number; my: number } {
  const left = b.x < a.x
  const sameCol = b.column === a.column
  const x1 = sameCol ? a.x : left ? a.x : a.x + a.w
  const x2 = sameCol ? b.x : left ? b.x + b.w : b.x
  const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2
  if (sameCol) {
    const bulge = 36
    return { d: `M${x1},${y1} C${x1 - bulge},${y1} ${x2 - bulge},${y2} ${x2},${y2}`, mx: x1 - bulge * 0.75, my: (y1 + y2) / 2 }
  }
  const dx = Math.abs(x2 - x1) / 2
  const sx = left ? -dx : dx
  return { d: `M${x1},${y1} C${x1 + sx},${y1} ${x2 - sx},${y2} ${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 }
}
