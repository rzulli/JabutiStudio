import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Info } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, type CatalogChoice, type CatalogCompare, type CatalogCompareRow, type SiblingCatalog } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Which catalog this window reads, and whether another JabutiStudio installation on this machine holds a different
 * catalog for the same project. Nothing is merged or chosen for you. Differences are shown system by system and you
 * pick what to keep; the previous file is backed up, what you did not keep is stored in a manifest, the other catalog
 * is never written, and the decision is remembered for that exact file so the warning does not come back.
 */

const RELATION: Record<SiblingCatalog['relation'], string> = {
  identical: 'same content as the active catalog',
  addable: 'has systems the active catalog does not',
  conflicting: 'differs from the active catalog',
  resolved: 'reviewed by you; nothing left to decide',
  unreadable: 'could not be read',
}

export function useCatalogSource(projectId: string) {
  return useQuery({ queryKey: ['catalog-source', projectId], queryFn: () => api.getCatalogSource(projectId), retry: false, refetchOnWindowFocus: false })
}

/** Banner: shown only while another catalog has something to decide. Identical or already-resolved catalogs stay quiet. */
export function CatalogSourceBanner({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const q = useCatalogSource(projectId)
  const [open, setOpen] = useState<SiblingCatalog | null>(null)
  const r = q.data
  if (!r) return null
  const others = r.others.filter(o => o.relation === 'addable' || o.relation === 'conflicting')
  if (!others.length) return null
  return (
    <div className="m-2 space-y-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-[11px]" role="alert" data-testid="catalog-sibling">
      <p className="flex items-start gap-1.5 font-medium text-warning"><Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span className="break-words">Another catalog exists for this project on this machine. <b>This window reads: {r.active.label}</b> <span className="break-all font-mono">{r.source.dataDir}</span> ({r.active.systems} system(s)).</span></p>
      {others.map(o => (
        <div key={o.dir} className="space-y-1 rounded border bg-background/60 p-1.5" data-testid="catalog-sibling-row">
          <p><b>{o.label}</b> <span className="break-all font-mono">{o.dir}</span></p>
          <p className="text-muted-foreground">{o.systems} system(s), {RELATION[o.relation]}.
            {o.addableIds.length > 0 && ` Only there: ${o.addableIds.join(', ')}.`}
            {o.conflictIds.length > 0 && ` Different: ${o.conflictIds.join(', ')}.`}
            {' '}Nothing is merged for you.</p>
          <button onClick={() => setOpen(o)} data-testid="catalog-compare-btn" className="rounded-md border bg-primary px-2 py-0.5 text-primary-foreground">Compare and decide…</button>
        </div>
      ))}
      {open && <CatalogResolveDialog projectId={projectId} fromDir={open.dir} onClose={() => setOpen(null)} onChanged={onChanged} />}
    </div>
  )
}

const CHOICE_LABEL: Record<CatalogChoice, string> = { 'keep-active': 'Keep this window’s version', 'take-other': 'Use the other catalog’s version', 'keep-both': 'Keep both (other as a proposed copy)' }
const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}…` : s)

function Row({ row, choice, setChoice, dupOf }: { row: CatalogCompareRow; choice?: CatalogChoice; setChoice: (c: CatalogChoice) => void; dupOf?: string }) {
  const options: CatalogChoice[] = row.kind === 'different' ? ['keep-active', 'take-other', 'keep-both'] : ['keep-active', 'keep-both']
  return (
    <div className="space-y-1 rounded border p-2" data-testid={`resolve-row-${row.id}`}>
      <p className="font-medium">{row.name} <span className="font-mono text-[10px] font-normal text-muted-foreground">{row.id}</span></p>
      {row.kind === 'different' && (
        <div className="space-y-0.5 text-[11px]">
          <p className="text-muted-foreground">Updated here {row.hereUpdatedAt?.slice(0, 16).replace('T', ' ')} ({row.hereStatus}) · there {row.thereUpdatedAt?.slice(0, 16).replace('T', ' ')} ({row.thereStatus})</p>
          {row.changes.map(c => (
            <div key={c.field} className="grid grid-cols-[84px_1fr_1fr] gap-2 border-t pt-0.5">
              <span className="text-muted-foreground">{c.field}</span><span className="break-words">{clip(c.here)}</span><span className="break-words">{clip(c.there)}</span>
            </div>
          ))}
        </div>
      )}
      {row.kind === 'duplicate' && <p className="text-[11px] text-muted-foreground">Not in this catalog under this id, but its name or terms match <span className="font-mono">{dupOf ?? row.duplicateOf}</span>. It may be the same idea under another id.</p>}
      {row.kind === 'only-there' && <p className="text-[11px] text-muted-foreground">Only the other catalog has it. It will be added unless you skip it.</p>}
      <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
        {options.map(o => (
          <label key={o} className="flex items-center gap-1"><input type="radio" name={`c-${row.id}`} checked={choice === o} onChange={() => setChoice(o)} data-testid={`choice-${row.id}-${o}`} />{CHOICE_LABEL[o]}</label>
        ))}
      </div>
    </div>
  )
}

export function CatalogResolveDialog({ projectId, fromDir, onClose, onChanged }: { projectId: string; fromDir: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient()
  const q = useQuery<CatalogCompare>({ queryKey: ['catalog-compare', projectId, fromDir], queryFn: () => api.compareCatalogSource(projectId, fromDir), retry: false, refetchOnWindowFocus: false, gcTime: 0 })
  const [choices, setChoices] = useState<Record<string, CatalogChoice>>({})
  const [skipNew, setSkipNew] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<null | { added: string[]; replaced: string[]; copies: string[]; keptActive: string[]; backup: string | null; manifest: string; systems: number }>(null)
  const d = q.data
  useEffect(() => { setChoices({}); setSkipNew({}) }, [d?.other.sha256, d?.active.sha256])
  const groups = useMemo(() => ({
    identical: d?.rows.filter(r => r.kind === 'identical') ?? [],
    onlyHere: d?.rows.filter(r => r.kind === 'only-here') ?? [],
    onlyThere: d?.rows.filter(r => r.kind === 'only-there') ?? [],
    needs: d?.rows.filter(r => r.kind === 'different' || r.kind === 'duplicate') ?? [],
  }), [d])
  const pending = groups.needs.filter(r => !choices[r.id])
  const run = async () => {
    if (!d) return
    setBusy(true)
    try {
      const all: Record<string, CatalogChoice> = { ...choices }
      for (const r of groups.onlyThere) if (skipNew[r.id]) all[r.id] = 'keep-active'
      const res = await api.resolveCatalogSource(projectId, { fromDir, expectedSourceSha256: d.other.sha256!, expectedTargetSha256: d.active.sha256, choices: all })
      // read it back from the server (which reads the file): the result shown is what is on disk
      await qc.invalidateQueries({ queryKey: ['catalog-source', projectId] })
      setDone(res); onChanged()
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto text-xs" data-testid="catalog-resolve">
        <DialogHeader>
          <DialogTitle>Two catalogs for this project</DialogTitle>
          <DialogDescription>Choose what to keep, system by system. Nothing is merged: each system is kept as it is, replaced by the other version, or both are kept. Your current file is backed up and the other catalog is not changed.</DialogDescription>
        </DialogHeader>
        {q.isError && <p className="text-destructive">{(q.error as Error).message}</p>}
        {!d && !q.isError && <p className="text-muted-foreground">Comparing…</p>}
        {d && !done && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {([['This window reads (active)', d.active, true], ['Other catalog', d.other, false]] as const).map(([t, side, act]) => (
                <div key={t} className={cn('space-y-0.5 rounded border p-2', act && 'border-primary')}>
                  <p className="font-medium">{t}: {side.label}</p><p className="break-all font-mono text-[10px]">{side.dir}</p>
                  <p className="text-muted-foreground">{side.systems} system(s) · file modified {side.modifiedAt?.slice(0, 16).replace('T', ' ')}</p>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground" data-testid="resolve-summary">{groups.identical.length} identical (nothing to decide) · {groups.onlyHere.length} only in the active catalog (kept) · {groups.onlyThere.length} only in the other · {groups.needs.length} to decide</p>
            {groups.identical.length > 0 && <details><summary className="cursor-pointer">Identical systems ({groups.identical.length})</summary><p className="pl-3 text-muted-foreground">{groups.identical.map(r => r.name).join(', ')}</p></details>}
            {groups.onlyThere.map(r => (
              <label key={r.id} className="flex items-center gap-1.5 rounded border p-2"><input type="checkbox" checked={!skipNew[r.id]} onChange={e => setSkipNew(s => ({ ...s, [r.id]: !e.target.checked }))} />Add “{r.name}” from the other catalog <span className="font-mono text-[10px] text-muted-foreground">{r.id}</span></label>
            ))}
            {groups.needs.map(r => <Row key={r.id} row={r} choice={choices[r.id]} setChoice={c => setChoices(s => ({ ...s, [r.id]: c }))} />)}
            <div className="flex items-center justify-between gap-2 border-t pt-2">
              <p className="text-muted-foreground">{pending.length ? `${pending.length} system(s) still need a choice.` : 'Every difference has a choice.'}</p>
              <div className="flex gap-1.5">
                <button onClick={onClose} className="rounded-md border px-2 py-1 hover:bg-accent">Cancel</button>
                <button disabled={busy || pending.length > 0 || (groups.needs.length + groups.onlyThere.length === 0)} onClick={run} data-testid="resolve-apply" className="rounded-md bg-primary px-2 py-1 text-primary-foreground disabled:opacity-40">Apply my choices</button>
              </div>
            </div>
          </div>
        )}
        {done && (
          <div className="space-y-2" data-testid="resolve-done">
            <p className="font-medium text-success">Saved. The active catalog now has {done.systems} system(s).</p>
            <ul className="list-disc pl-5 text-muted-foreground">
              {done.keptActive.length > 0 && <li>Kept as they were here: {done.keptActive.join(', ')}</li>}
              {done.replaced.length > 0 && <li>Replaced by the other version: {done.replaced.join(', ')}</li>}
              {done.added.length > 0 && <li>Added from the other catalog: {done.added.join(', ')}</li>}
              {done.copies.length > 0 && <li>Kept both, other version as a proposed copy: {done.copies.join(', ')}</li>}
            </ul>
            <p className="break-all text-muted-foreground">Previous file: {done.backup ?? 'none'}<br />Record of what was replaced or declined: {done.manifest}</p>
            <p className="text-muted-foreground">This is written to disk and remembered for that exact file of the other catalog: it stays resolved after you restart. It asks again only if that other file changes.</p>
            <button onClick={onClose} className="rounded-md border px-2 py-1 hover:bg-accent">Close</button>
          </div>
        )}
      </DialogContent>
    </Dialog>
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
      <p>data dir {r.source.dataDir} — {r.active.label} (selected by {r.source.selectedBy})</p>
      <p>active catalog {r.active.file} — {r.active.exists ? `${r.active.systems} system(s), modified ${r.active.modifiedAt}` : 'file does not exist yet'}{r.active.error ? ` — ERROR ${r.active.error}` : ''}</p>
      <p>loaded systems {r.active.loaded ?? 'unreadable'}</p>
      <p>last read {lr ? `${lr.at} — ${lr.ok ? `ok (${lr.systems})` : `failed: ${lr.error}`}` : 'not read yet by this server'}</p>
      {r.others.length === 0 ? <p>other catalogs for this project: none found</p> : r.others.map(o => (
        <p key={o.dir}>other catalog {o.label}: {o.file} — {o.systems} system(s), {RELATION[o.relation]}{o.resolution ? ` (${o.resolution.resolvedAt.slice(0, 16).replace('T', ' ')}; record ${o.resolution.manifest ?? 'none'})` : ''}</p>
      ))}
    </div>
  )
}
