import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { RefreshCw, Upload, Download, GitBranch, Info } from 'lucide-react'
import { api, type KnowledgeReconciliation, type KnowledgeState, type KnowledgeSystem, type PortableSystem, type KnowledgePlan } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Knowledge / Publish: what the examined revision publishes, what the working-tree file says, what only this
 * installation knows — and the three explicit operations on jabutistudio.systems.json (export, update, import).
 * Publishing writes the file; it never stages, commits or merges. Nothing here runs without a confirmation.
 */

const STATE: Record<KnowledgeState, { label: string; cls: string; title: string }> = {
  published: { label: 'published', cls: 'bg-success/15 text-success', title: 'Identical to what this revision publishes' },
  'local-change': { label: 'local changes', cls: 'bg-warning/15 text-warning', title: 'Differs from the published value; not published yet' },
  diverged: { label: 'diverged', cls: 'bg-destructive/15 text-destructive', title: 'Both sides changed; nothing is chosen for you' },
  'unpublished-proposal': { label: 'local only', cls: 'border border-dashed text-muted-foreground', title: 'A proposal that exists only in this installation' },
  unavailable: { label: 'not in this revision', cls: 'border border-dashed text-muted-foreground', title: 'This revision publishes no knowledge for it' },
}
const FILE_TEXT: Record<KnowledgeReconciliation['file']['state'], string> = {
  present: 'Published in this revision', modified: 'Published, but the file has uncommitted edits', untracked: 'File exists but is not committed',
  absent: 'Nothing published in this revision', invalid: 'File is not usable', incompatible: 'File belongs to another Git history',
}
const INTEGRATION: Record<string, string> = {
  same: 'same file as the project checkout', differs: 'differs from the project checkout (not integrated there)', 'absent-in-main': 'the project checkout has no file yet',
}

const shown = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : Array.isArray(v) ? (v.length ? v.join(' · ') : '—') : String(v))
function fields(s: PortableSystem | null): [string, string][] {
  if (!s) return []
  return [
    ['Name', s.name], ['Summary', shown(s.summary)], ['Responsibilities', shown(s.responsibilities)],
    ['Functional areas', shown((s.areas ?? []).map(a => `${a.name} (${a.status})`))],
    ['Relations', shown((s.relations ?? []).map(r => `${r.from} ${r.kind} ${r.to} (${r.status})`))],
    ['Confirmation', s.status === 'confirmed' ? `confirmed${s.confirmedAt ? ` ${s.confirmedAt.slice(0, 10)}` : ''}` : s.status],
    ['Provenance', `${s.origin}${s.confirmedVia ? ' · confirmed in the UI' : ''}`],
  ]
}

function Pill({ state }: { state: KnowledgeState }) {
  const s = STATE[state]
  return <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', s.cls)} title={s.title} data-state={state}>{s.label}</span>
}

/** Two-step button: the first click only asks. */
function Confirm({ label, ask, onConfirm, disabled, testId }: { label: string; ask: string; onConfirm: () => Promise<void> | void; disabled?: boolean; testId: string }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!asking) {
    return <button disabled={disabled} onClick={() => setAsking(true)} data-testid={testId}
      className="rounded-md border bg-primary px-2.5 py-1 text-[11px] text-primary-foreground disabled:opacity-40">{label}</button>
  }
  return (
    <div className="space-y-1.5 rounded-md border border-warning/50 bg-warning/10 p-2 text-[11px]" data-testid={`${testId}-confirm`}>
      <p>{ask}</p>
      <div className="flex gap-1.5">
        <button disabled={busy} data-testid={`${testId}-yes`} className="rounded-md border bg-primary px-2 py-0.5 text-primary-foreground"
          onClick={async () => { setBusy(true); try { await onConfirm() } finally { setBusy(false); setAsking(false) } }}>Confirm</button>
        <button disabled={busy} onClick={() => setAsking(false)} className="rounded-md border px-2 py-0.5 hover:bg-accent">Cancel</button>
      </div>
    </div>
  )
}

function Compare({ sys }: { sys: KnowledgeSystem }) {
  const cols: [string, PortableSystem | null, string][] = [
    ['Published', sys.published, 'Not published in this revision'], ['File in working tree', sys.workingFile ?? sys.published, 'No file'], ['Local catalog', sys.local, 'Not in the local catalog'],
  ]
  const data = cols.map(([, s]) => new Map(fields(s)))
  const names = ['Name', 'Summary', 'Responsibilities', 'Functional areas', 'Relations', 'Confirmation', 'Provenance']
  const [raw, setRaw] = useState(false)
  return (
    <div className="space-y-2 rounded-md border p-2" data-testid="knowledge-compare">
      <div className="grid grid-cols-[110px_repeat(3,minmax(0,1fr))] gap-x-2 gap-y-1 text-[11px]">
        <span />{cols.map(([t]) => <b key={t}>{t}</b>)}
        {names.map(n => {
          const vals = data.map(m => m.get(n))
          const differs = new Set(vals.filter(v => v !== undefined)).size > 1
          return [
            <span key={n} className="text-muted-foreground">{n}</span>,
            ...vals.map((v, i) => (
              <span key={n + i} className={cn('break-words', v === undefined && 'italic text-muted-foreground', differs && v !== undefined && 'rounded bg-warning/10 px-1')}>
                {v ?? (n === 'Name' ? cols[i][2] : '')}
              </span>
            )),
          ]
        })}
      </div>
      <button onClick={() => setRaw(!raw)} className="text-[10px] text-muted-foreground underline">{raw ? 'Hide' : 'Show'} full documents</button>
      {raw && <pre className="max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[10px]">{JSON.stringify({ published: sys.published, workingFile: sys.workingFile, local: sys.local }, null, 2)}</pre>}
    </div>
  )
}

export function KnowledgePanel({ projectId, worktree, onChanged, onOpenSystem }: {
  projectId: string; worktree: string; onChanged: () => void; onOpenSystem: (id: string) => void
}) {
  const qc = useQueryClient()
  const [revisionInput, setRevisionInput] = useState('')
  const [revision, setRevision] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [tech, setTech] = useState(false)
  const [included, setIncluded] = useState<Record<string, boolean>>({})
  const [take, setTake] = useState<Record<string, boolean>>({})
  const [exportSel, setExportSel] = useState<Record<string, boolean>>({})

  // No polling and no refetch on focus: the hash shown is the hash that is sent. "Refresh" is explicit.
  const once = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const
  const kq = useQuery({ queryKey: ['knowledge', projectId, worktree, revision], queryFn: () => api.getKnowledge(projectId, worktree || undefined, revision || undefined), retry: false, ...once })
  const pq = useQuery({ queryKey: ['knowledge-plan', projectId], queryFn: () => api.getKnowledgePlan(projectId), retry: false, ...once })
  const k = kq.data
  const plan: KnowledgePlan | undefined = pq.data
  const readAt = useMemo(() => new Date().toLocaleTimeString(), [kq.dataUpdatedAt, pq.dataUpdatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const writable = !worktree && !revision
  const upd = plan && plan.update.exists && 'rows' in plan.update ? plan.update : null
  const imp = plan && plan.import.exists && 'items' in plan.import ? plan.import : null
  const updSha = upd?.sha256
  useEffect(() => { setIncluded({}); setTake({}) }, [updSha])
  useEffect(() => { if (!selected && k?.systems[0]) setSelected(k.systems[0].id) }, [k, selected])

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['knowledge', projectId] }), qc.invalidateQueries({ queryKey: ['knowledge-plan', projectId] })])
    onChanged()
  }
  const fail = async (e: any) => { toast.error(e.message || 'Failed'); setNote(`${e.message}. The file or catalog changed; the differences below were read again.`); await refresh() }

  const exportOn = (s: { id: string; origin: string; status: string }) => exportSel[s.id] ?? !(s.origin === 'discovery' && s.status === 'proposed')
  const exportIds = (plan?.export.systems ?? []).filter(exportOn).map(s => s.id)
  const rows = upd?.rows ?? []
  const picked = rows.filter(r => (r.action === 'add' || r.action === 'update') ? included[r.id] !== false : !!take[r.id])
  const takeIds = rows.filter(r => r.action === 'needs-choice' && take[r.id]).map(r => r.id)
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const s of k?.systems ?? []) c[s.state] = (c[s.state] ?? 0) + 1
    return c
  }, [k])
  const sel = k?.systems.find(s => s.id === selected) ?? null

  if (kq.isLoading) return <p className="p-6 text-xs text-muted-foreground">Reading knowledge…</p>
  if (!k) return <p className="p-6 text-xs text-destructive">{(kq.error as Error)?.message ?? 'Could not read knowledge'}</p>

  const f = k.file
  return (
    <div className="mx-auto max-w-4xl space-y-3 p-4 text-xs" data-testid="knowledge-panel">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Knowledge</h2>
        <span className="text-[11px] text-muted-foreground">publish and recover what you classified, in the repository</span>
        <button onClick={refresh} className="ml-auto flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent" data-testid="knowledge-refresh">
          <RefreshCw className={cn('h-3 w-3', (kq.isFetching || pq.isFetching) && 'animate-spin')} /> Refresh <span className="text-muted-foreground">read {readAt}</span>
        </button>
      </div>

      <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2 py-1.5 text-[11px]', !k.checkout.isCanonical && 'border-warning/50 bg-warning/10')} data-testid="knowledge-checkout">
        <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" />{k.checkout.branch ?? '?'} <code className="font-mono">{k.checkout.head}</code></span>
        <span>{k.checkout.isCanonical ? 'project checkout' : 'worktree'}</span>
        <span>{k.checkout.dirty ? 'uncommitted changes' : 'clean'}</span>
        <label className="ml-auto flex items-center gap-1">revision
          <input value={revisionInput} onChange={e => setRevisionInput(e.target.value)} placeholder="HEAD" data-testid="knowledge-revision"
            onKeyDown={e => { if (e.key === 'Enter') setRevision(revisionInput.trim()) }} onBlur={() => setRevision(revisionInput.trim())}
            className="h-6 w-28 rounded-md border bg-background px-1.5 font-mono" />
        </label>
      </div>
      {revision && <p className="text-[11px] text-warning" data-testid="knowledge-readonly">Past revision {k.revision.commit.slice(0, 8)}: read-only. Uncommitted edits and the working file are not consulted.</p>}
      {!revision && worktree && <p className="text-[11px] text-warning" data-testid="knowledge-readonly">Worktree: read-only here. Publish from the project checkout; integration into it still needs your Git merge.</p>}
      {!k.checkout.isCanonical && <p className="text-[11px] text-muted-foreground">The code graph describes the project checkout, not this worktree; technical relations are not verified here.</p>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="knowledge-status">
        <div className="rounded-md border p-2"><p className="text-muted-foreground">In this revision</p>
          <p className="font-medium" data-testid="knowledge-file-state">{FILE_TEXT[f.state]}</p>
          {f.reason && <p className="text-[10px] text-destructive">{f.reason}</p>}
          {f.integration && <p className="text-[10px] text-muted-foreground">{INTEGRATION[f.integration]}</p>}</div>
        <div className="rounded-md border p-2"><p className="text-muted-foreground">Working file</p>
          <p className="font-medium">{revision ? 'not consulted' : f.state === 'modified' ? 'edited, not committed' : f.state === 'untracked' ? 'new, not committed' : f.state === 'present' ? 'same as committed' : 'none'}</p></div>
        <div className="rounded-md border p-2"><p className="text-muted-foreground">Local only</p>
          <p className="font-medium">{(counts['unpublished-proposal'] ?? 0) + (counts['local-change'] ?? 0)} <span className="font-normal text-muted-foreground">not published</span></p></div>
        <div className="rounded-md border p-2"><p className="text-muted-foreground">Diverged</p>
          <p className={cn('font-medium', counts.diverged && 'text-destructive')}>{counts.diverged ?? 0}</p></div>
      </div>

      {note && <p className="rounded-md border border-warning/50 bg-warning/10 p-2 text-[11px]" data-testid="knowledge-note">{note}</p>}

      <div className="rounded-md border" data-testid="knowledge-systems">
        {k.systems.length === 0 && <p className="p-3 text-muted-foreground">No systems here yet. Find or propose systems first.</p>}
        {k.systems.map(s => (
          <button key={s.id} onClick={() => setSelected(s.id)} data-testid="knowledge-row"
            className={cn('flex w-full items-center gap-2 border-b border-border/40 px-2 py-1.5 text-left last:border-0 hover:bg-accent/60', selected === s.id && 'bg-accent')}>
            <span className="truncate font-medium">{s.name}</span><Pill state={s.state} />
            {!s.local && s.published && <span className="text-[10px] text-muted-foreground" title="Published in the repository but not in this installation's catalog yet">not imported here</span>}
            {s.evidenceStale && <span className="text-[10px] text-warning" title="Some evidence no longer holds in this checkout">evidence stale</span>}
            <span className="ml-auto text-[10px] text-muted-foreground">{s.changes.length ? `${s.changes.length} field(s) differ` : ''}</span>
          </button>
        ))}
      </div>
      {sel && <><Compare sys={sel} /><button className="text-[11px] underline" onClick={() => onOpenSystem(sel.id)}>Open {sel.name} to review it</button></>}

      {/* Initial export */}
      {writable && plan && !plan.update.exists && (
        <div className="space-y-2 rounded-md border p-3" data-testid="knowledge-export">
          <p className="flex items-center gap-1.5 font-medium"><Upload className="h-3 w-3" /> Publish for the first time</p>
          {plan.export.canExport ? <>
            <p className="text-muted-foreground">Creates <code className="font-mono">{plan.export.target}</code> at the root of this repository with the {exportIds.length} ticked system(s). Proposals stay proposals; local attestations, caches and absolute paths are not written. You commit it yourself.</p>
            <ul className="space-y-0.5">{plan.export.systems.map(s => (
              <li key={s.id}><label className="flex items-center gap-2"><input type="checkbox" data-testid="knowledge-export-pick" checked={exportOn(s)} onChange={e => setExportSel({ ...exportSel, [s.id]: e.target.checked })} />
                {s.name} <span className="text-muted-foreground">· {s.status} · {s.areas} areas · {s.relations} relations{s.proposedItems ? ` · ${s.proposedItems} proposed item(s)` : ''}</span></label></li>))}</ul>
            {plan.export.systems.some(s => s.origin === 'discovery' && s.status === 'proposed') && <p className="text-[11px] text-muted-foreground">Unreviewed discovery candidates start unticked; tick the ones worth publishing.</p>}
            <Confirm testId="knowledge-export-btn" disabled={!exportIds.length} label={`Create the file (${exportIds.length})…`} ask={`Write ${plan.export.target} with ${exportIds.length} system(s) now? Nothing is staged or committed.`}
              onConfirm={async () => { try { await api.exportKnowledge(projectId, exportIds); toast.success('File created in the working tree (not committed)'); setNote(null); await refresh() } catch (e) { await fail(e) } }} />
          </> : <p className="text-muted-foreground">{plan.export.reason}</p>}
        </div>
      )}

      {/* Update of the existing file */}
      {writable && upd && rows.length > 0 && (
        <div className="space-y-2 rounded-md border p-3" data-testid="knowledge-update">
          <p className="flex items-center gap-1.5 font-medium"><Upload className="h-3 w-3" /> Update the published file</p>
          {rows.every(r => r.action === 'unchanged') ? <p className="text-muted-foreground">The file already matches your local catalog.</p> : <>
            <p className="text-muted-foreground">Writes the checked systems into <code className="font-mono">jabutistudio.systems.json</code> as it was when read at {readAt}. If the file changes before you confirm, nothing is written.</p>
            {rows.filter(r => r.action !== 'unchanged').map(r => (
              <div key={r.id} className="space-y-1 rounded border p-2" data-testid="knowledge-update-row" data-action={r.action}>
                <label className="flex items-center gap-2">
                  {r.action === 'needs-choice'
                    ? <input type="checkbox" checked={!!take[r.id]} onChange={e => setTake({ ...take, [r.id]: e.target.checked })} data-testid="knowledge-take" />
                    : <input type="checkbox" checked={included[r.id] !== false} onChange={e => setIncluded({ ...included, [r.id]: e.target.checked })} />}
                  <span className="font-medium">{r.name}</span>
                  <span className="text-muted-foreground">{r.action === 'add' ? 'new in the file' : r.action === 'update' ? 'newer than the file' : 'the file holds a newer or different value'} · {r.status}</span>
                </label>
                {r.action === 'needs-choice' && <p className="text-[11px] text-warning">Tick to replace the file's value with your local one. Unticked, this system is left alone.</p>}
                {r.changes.map(c => (
                  <p key={c.field} className="grid grid-cols-[100px_1fr_1fr] gap-2 text-[11px]"><span className="text-muted-foreground">{c.field}</span>
                    <span className="break-words"><i className="text-muted-foreground">file: </i>{shown(typeof c.published === 'object' ? JSON.stringify(c.published) : c.published)}</span>
                    <span className="break-words"><i className="text-muted-foreground">local: </i>{shown(typeof c.local === 'object' ? JSON.stringify(c.local) : c.local)}</span></p>
                ))}
              </div>
            ))}
            {upd.fileOnly.length > 0 && <p className="text-[11px] text-muted-foreground">In the file only (left untouched): {upd.fileOnly.map(s => s.name).join(', ')}</p>}
            <Confirm testId="knowledge-update-btn" disabled={!picked.length} label={`Update the file (${picked.length})…`}
              ask={`Write ${picked.length} system(s) into the file${takeIds.length ? `, replacing the file's value for ${takeIds.length}` : ''}? Nothing is staged or committed.`}
              onConfirm={async () => {
                try {
                  const r = await api.updateKnowledge(projectId, { expectedSha256: upd.sha256, systemIds: picked.map(p => p.id), takeLocal: takeIds, expectedLocal: Object.fromEntries(picked.map(p => [p.id, p.local.updatedAt])) })
                  toast.success(`File updated: ${r.updated.length} system(s). Not committed.`); setNote(null); await refresh()
                } catch (e) { await fail(e) }
              }} />
          </>}
        </div>
      )}

      {/* Recovery */}
      {writable && imp && (imp.importable > 0 || imp.conflicts > 0) && (
        <div className="space-y-2 rounded-md border p-3" data-testid="knowledge-import">
          <p className="flex items-center gap-1.5 font-medium"><Download className="h-3 w-3" /> Recover from the file</p>
          <ul className="space-y-0.5">
            {imp.items.filter(i => i.kind !== 'identical').map(i => (
              <li key={i.id} data-kind={i.kind} data-testid="knowledge-import-item">
                <span className="font-medium">{i.name}</span>{' '}
                <span className={cn(i.kind === 'new' ? 'text-success' : 'text-destructive')}>
                  {i.kind === 'new' ? 'new system' : i.kind === 'changed' ? 'same identity, different content: conflict' : `possible duplicate of ${i.against}: conflict`}
                </span>
                <span className="text-muted-foreground"> · {i.status === 'confirmed' ? `confirmed${i.provenance ? ` (${i.provenance})` : ''}` : 'proposal'}{i.evidenceStale ? ' · evidence not found in this checkout' : ''}</span>
                {i.changes.map(c => <p key={c.field} className="ml-3 text-[11px] text-muted-foreground">{c.field}: here “{shown(typeof c.current === 'object' ? JSON.stringify(c.current) : c.current)}” · file “{shown(typeof c.incoming === 'object' ? JSON.stringify(c.incoming) : c.incoming)}”</p>)}
              </li>
            ))}
          </ul>
          {imp.items.some(i => i.kind === 'identical') && <p className="text-[11px] text-muted-foreground">{imp.items.filter(i => i.kind === 'identical').length} system(s) already match and are skipped.</p>}
          {imp.safe
            ? <Confirm testId="knowledge-import-btn" label={`Import ${imp.importable} system(s)…`}
                ask={`Add ${imp.importable} system(s) to this installation? Proposals stay proposals; confirmed ones keep the provenance written in the file.`}
                onConfirm={async () => { try { const r = await api.importKnowledge(projectId, imp.sha256); toast.success(`Imported ${r.added} system(s)`); setNote(null); await refresh() } catch (e) { await fail(e) } }} />
            : <p className="flex items-start gap-1.5 text-[11px] text-warning" data-testid="knowledge-import-blocked"><Info className="mt-0.5 h-3 w-3 shrink-0" />
                Nothing is imported while a conflict exists, and nothing is chosen for you. Review the system here, or resolve the file, then refresh.</p>}
        </div>
      )}

      {/* After a write */}
      {writable && (f.state === 'modified' || f.state === 'untracked') && (
        <p className="flex items-start gap-1.5 rounded-md border p-2 text-[11px]" data-testid="knowledge-uncommitted"><Info className="mt-0.5 h-3 w-3 shrink-0" />
          The file in the working tree is {f.state === 'untracked' ? 'new' : 'changed'} and not committed (HEAD {k.checkout.head}). It is published only once you commit it, and integrated elsewhere only after you merge it.</p>
      )}

      <button onClick={() => setTech(!tech)} className="text-[10px] text-muted-foreground underline">{tech ? 'Hide' : 'Show'} technical details</button>
      {tech && (
        <div className="space-y-1 rounded bg-muted/40 p-2 font-mono text-[10px]" data-testid="knowledge-tech">
          <p>revision {k.revision.commit}</p><p>committed sha256 {f.revisionSha256 ?? '—'}</p><p>working sha256 {f.workingSha256 ?? '—'}</p>
          <p>expected sha256 {upd?.sha256 ?? f.expectedSha256 ?? '—'}</p>
          {k.limitations.map(l => <p key={l} className="font-sans">· {l}</p>)}
        </div>
      )}
    </div>
  )
}
