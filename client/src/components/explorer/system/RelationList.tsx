import { Pencil } from 'lucide-react'
import type { SystemRelation, SystemView } from '@/lib/api'
import { relationState } from '@/lib/relationState'
import { cn } from '@/lib/utils'
import type { SystemActions } from './parts'

/** The two independent facts about a relation: your classification (design) and what the code says (implementation). */
export function RelationPills({ r }: { r: Pick<SystemRelation, 'status' | 'basis' | 'evidence' | 'origin'> }) {
  const s = relationState(r)
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="relation-pills">
      <span data-testid="pill-design" data-design={s.design}
        title={s.design === 'confirmed' ? 'You confirmed this classification on this installation. It is not a design approval.' : `Written down by ${r.origin}; nobody has confirmed it yet.`}
        className={cn('rounded px-1.5 py-0.5 text-[10px]', s.design === 'confirmed' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning')}>
        {s.design === 'confirmed' ? 'confirmed' : `proposed by ${r.origin}`}
      </span>
      <span data-testid="pill-code" data-code={s.code} title={s.codeTitle}
        className={cn('rounded px-1.5 py-0.5 text-[10px]', s.code === 'matched' ? 'bg-success/15 text-success' : s.code === 'stale' ? 'bg-warning/15 text-warning' : 'border border-dashed text-muted-foreground')}>
        {s.codeLabel}
      </span>
    </span>
  )
}

/**
 * Every declared relation of the system as a plain list, independent of the map: it works with no code, no evidence
 * and no graph. Each row opens the quick editor directly.
 */
export function RelationList({ v, actions }: { v: SystemView; actions: SystemActions }) {
  const rels = v.relations
  return (
    <section className="space-y-1.5" data-testid="relation-list">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Design relations <span className="tabular-nums opacity-60">{rels.length}</span></h3>
        <button onClick={() => actions.onQuickEdit?.({ type: 'relation', id: 'new' })} data-testid="list-add-relation" className="ml-auto rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent">Add a relation</button>
      </div>
      {!rels.length && <p className="text-[11px] text-muted-foreground">None yet. A relation is a design statement such as “A consumes B”; it does not need any code.</p>}
      {rels.map(r => (
        <div key={r.id} className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs" data-testid="relation-item" data-code={relationState(r).code} data-design={r.status}>
          <span className="font-medium">{r.from.label}</span>
          <span className="rounded bg-accent px-1.5 py-0.5 text-[10px]">{r.label}</span>
          <span className="font-medium">{r.to.label}</span>
          <RelationPills r={r} />
          {r.note && <span className="basis-full truncate text-[11px] text-muted-foreground">{r.note}</span>}
          {r.direction !== 'incoming'
            ? <button onClick={() => actions.onQuickEdit?.({ type: 'relation', id: r.id })} data-testid="relation-item-edit" className="ml-auto flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent"><Pencil className="h-3 w-3" /> Edit</button>
            : <span className="ml-auto text-[10px] text-muted-foreground" title={`Stored in the other system (${r.storedIn}); edit it there`}>declared by the other system</span>}
        </div>
      ))}
    </section>
  )
}
