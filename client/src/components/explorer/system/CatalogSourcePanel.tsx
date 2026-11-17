import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Info } from 'lucide-react'
import { api, type SiblingCatalog } from '@/lib/api'

/**
 * Which catalog this window reads, and whether another JabutiStudio installation on this machine holds a different
 * catalog for the same project. Nothing is merged or chosen for you: the only write is an explicit, add-only import
 * that backs up the active file first and is refused on any conflict.
 */

const RELATION: Record<SiblingCatalog['relation'], string> = {
  identical: 'same content as the active catalog',
  addable: 'has systems the active catalog does not',
  conflicting: 'conflicts with the active catalog',
  unreadable: 'could not be read',
}

export function useCatalogSource(projectId: string) {
  return useQuery({ queryKey: ['catalog-source', projectId], queryFn: () => api.getCatalogSource(projectId), retry: false, refetchOnWindowFocus: false })
}

/** Banner: shown only when another catalog has something the active one lacks (or disagrees with it). */
export function CatalogSourceBanner({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const q = useCatalogSource(projectId)
  const qc = useQueryClient()
  const [asking, setAsking] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const r = q.data
  if (!r) return null
  const others = r.others.filter(o => o.relation === 'addable' || o.relation === 'conflicting')
  if (!others.length) return null
  const doImport = async (o: SiblingCatalog) => {
    setBusy(true)
    try {
      const res = await api.importCatalogSource(projectId, { fromDir: o.dir, expectedSourceSha256: o.sha256!, expectedTargetSha256: r.active.sha256 })
      toast.success(`Imported ${res.added.length} system(s). Backup: ${res.backup ?? 'none needed'}`)
      await qc.invalidateQueries({ queryKey: ['catalog-source', projectId] })
      onChanged()
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(false); setAsking(null) }
  }
  return (
    <div className="m-2 space-y-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-[11px]" role="alert" data-testid="catalog-sibling">
      <p className="flex items-start gap-1.5 font-medium text-warning"><Info className="mt-0.5 h-3 w-3 shrink-0" />
        Another catalog exists for this project on this machine. This window is reading <span className="font-mono">{r.source.dataDir}</span> ({r.active.systems} system(s)).</p>
      {others.map(o => (
        <div key={o.dir} className="space-y-1 rounded border bg-background/60 p-1.5" data-testid="catalog-sibling-row">
          <p className="break-all font-mono">{o.dir}</p>
          <p className="text-muted-foreground">{o.systems} system(s) — {RELATION[o.relation]}.
            {o.relation === 'addable' && ` ${o.addableIds.length} would be added: ${o.addableIds.join(', ')}.`}
            {o.relation === 'conflicting' && ` Conflicting: ${o.conflictIds.join(', ')}. Nothing can be imported while a conflict exists, and nothing is merged for you.`}</p>
          {o.relation === 'addable' && (asking === o.dir ? (
            <div className="space-y-1 rounded border border-warning/50 p-1.5" data-testid="catalog-import-confirm">
              <p>Add {o.addableIds.length} system(s) to the active catalog? Existing systems are not touched, statuses stay as they are, and the current file is backed up first.</p>
              <div className="flex gap-1.5">
                <button disabled={busy} onClick={() => doImport(o)} data-testid="catalog-import-yes" className="rounded-md border bg-primary px-2 py-0.5 text-primary-foreground">Confirm import</button>
                <button disabled={busy} onClick={() => setAsking(null)} className="rounded-md border px-2 py-0.5 hover:bg-accent">Cancel</button>
              </div>
            </div>
          ) : <button onClick={() => setAsking(o.dir)} data-testid="catalog-import-btn" className="rounded-md border bg-primary px-2 py-0.5 text-primary-foreground">Import into the active catalog…</button>)}
        </div>
      ))}
    </div>
  )
}

/** Technical details: identity, active catalog, last read, other catalogs. No file contents, only paths and counts. */
export function CatalogSourceDetails({ projectId }: { projectId: string }) {
  const q = useCatalogSource(projectId)
  if (q.isError) return <p className="font-sans text-destructive" data-testid="catalog-source-error">catalog source unavailable: {(q.error as Error).message}</p>
  const r = q.data
  if (!r) return <p className="font-sans text-muted-foreground">reading catalog source…</p>
  const lr = r.active.lastRead
  return (
    <div className="space-y-1" data-testid="catalog-source">
      <p>project id {r.identity.projectId}</p>
      <p>project path {r.identity.path}</p>
      <p>server {r.source.mode} · pid {r.source.pid}{r.source.port ? ` · port ${r.source.port}` : ''}</p>
      <p>data dir {r.source.dataDir} (selected by {r.source.selectedBy})</p>
      <p>active catalog {r.active.file} — {r.active.exists ? `${r.active.systems} system(s), modified ${r.active.modifiedAt}` : 'file does not exist yet'}{r.active.error ? ` — ERROR ${r.active.error}` : ''}</p>
      <p>loaded systems {r.active.loaded ?? 'unreadable'}</p>
      <p>last read {lr ? `${lr.at} — ${lr.ok ? `ok (${lr.systems})` : `failed: ${lr.error}`}` : 'not read yet by this server'}</p>
      {r.others.length === 0 ? <p>other catalogs for this project: none found</p> : r.others.map(o => (
        <p key={o.dir}>other catalog {o.file} — {o.systems} system(s), {RELATION[o.relation]}</p>
      ))}
    </div>
  )
}
