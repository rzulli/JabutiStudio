import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowRight } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, type SystemSummary, type SystemView } from '@/lib/api'
import { cn } from '@/lib/utils'
import { FilePicker, TermChips } from './EditSystemDialog'

const field = 'w-full rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring'
const diff = (a: string[], b: string[]) => a.filter(x => !b.includes(x))

/**
 * Merge: choose a system, compare it with this one, read the exact result, then confirm.
 * The merged system stays behind as a redirect, so links and agent notes keep working.
 */
export function MergeDialog({ v, projectId, allSystems, open, onOpenChange, onChanged }: {
  v: SystemView; projectId: string; allSystems: SystemSummary[]; open: boolean; onOpenChange: (b: boolean) => void; onChanged: () => void
}) {
  const [other, setOther] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setOther('') }, [open])
  const q = useQuery({ queryKey: ['system', projectId, other, ''], queryFn: () => api.getSystem(projectId, other), enabled: open && !!other })
  const o = q.data && q.data.id === other ? q.data : undefined
  const choices = allSystems.filter(s => s.id !== v.id && s.status !== 'dismissed' && s.status !== 'merged')
  const sharedFiles = o ? v.members.filter(m => o.members.some(x => x.path === m.path)).length : 0
  const run = async () => {
    setBusy(true)
    try { await api.mergeSystems(projectId, v.id, [other]); toast.success(`Merged “${o?.name}” into “${v.name}”`); onChanged(); onOpenChange(false) }
    catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="merge-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm">Merge a system into “{v.name}”</DialogTitle>
          <DialogDescription className="text-[11px]">Use this when two entries describe the same part of the game. Nothing changes until you confirm.</DialogDescription>
        </DialogHeader>
        <select className={field} value={other} onChange={e => setOther(e.target.value)} aria-label="system to merge" data-testid="merge-pick">
          <option value="">Choose the system to fold in…</option>
          {choices.map(s => <option key={s.id} value={s.id}>{s.name} · {s.files} files</option>)}
        </select>
        {other && !o && <p className="text-xs text-muted-foreground">Loading comparison…</p>}
        {o && (
          <div className="space-y-3" data-testid="merge-preview">
            <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3">
              <Side title="Folded in (will be marked merged)" s={o} />
              <ArrowRight className="mt-6 h-4 w-4 text-muted-foreground" />
              <Side title="Kept (target)" s={v} />
            </div>
            <ul className="space-y-0.5 rounded-md border bg-card/40 p-2.5 text-[11px]">
              <li><b>{sharedFiles}</b> member files appear in both{o.overlaps.some(x => x.id === v.id) || v.overlaps.some(x => x.id === o.id) ? ' — they are likely the same system' : ''}.</li>
              <li>Terms added to “{v.name}”: <b>{diff(o.anchors.terms, v.anchors.terms).join(', ') || 'none'}</b></li>
              <li>Files pinned and added: <b>{diff(o.anchors.files, v.anchors.files).length}</b> · Decisions linked: <b>{diff(o.anchors.decisions, v.anchors.decisions).join(', ') || 'none'}</b></li>
              <li>Responsibilities moved over: <b>{o.responsibilities.length}</b> · Components: <b>{o.areas.filter(a => !a.inferred).length}</b> · Relations: <b>{o.relations.filter(r => r.direction !== 'incoming').length}</b></li>
              {o.summary && v.summary && o.summary !== v.summary && <li className="text-warning">Both have a description. “{v.name}” keeps its own; the other text is not copied.</li>}
              <li className="text-muted-foreground">“{o.name}” stays as a redirect to this system, so old links and agent notes still resolve. It is not deleted.</li>
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={() => onOpenChange(false)} className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent">Cancel</button>
          <button disabled={!o || busy} onClick={run} data-testid="merge-confirm" className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40">Merge</button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Side({ title, s }: { title: string; s: SystemView }) {
  return (
    <div className="min-w-0 space-y-1 rounded-md border p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="truncate text-xs font-semibold">{s.name}</p>
      <p className="line-clamp-3 text-[11px] text-muted-foreground">{s.summary || 'No description.'}</p>
      <p className="text-[10px] text-muted-foreground">{s.members.filter(m => m.role !== 'test').length} files · {s.areas.filter(a => !a.inferred).length} components · {s.design.decisions.length} decisions · {s.status}</p>
    </div>
  )
}

/**
 * Split: choose what moves into a new system. The preview names every file, term and component that leaves.
 * A component moves only when ALL of its files move with it (server rule), so a component is never cut in half.
 */
export function SplitDialog({ v, projectId, open, onOpenChange, onChanged, onPick }: {
  v: SystemView; projectId: string; open: boolean; onOpenChange: (b: boolean) => void; onChanged: () => void; onPick: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [terms, setTerms] = useState<string[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setName(''); setTerms([]); setFiles([]) } }, [open])
  const termChoices = v.anchors.terms
  const fileChoices = v.anchors.files
  const movingAreas = v.areas.filter(a => !a.inferred && a.anchors && ((a.anchors.files.length > 0 && a.anchors.files.every(f => files.includes(f.split('#')[0]))) ||
    (a.anchors.files.length === 0 && a.anchors.terms.length > 0 && a.anchors.terms.every(t => terms.includes(t)))))
  const stays = v.members.filter(m => m.role !== 'test' && !terms.some(t => m.path.toLowerCase().includes(t))).length
  const moves = v.members.filter(m => m.role !== 'test' && terms.some(t => m.path.toLowerCase().includes(t)))
  const run = async () => {
    setBusy(true)
    try { const r = await api.splitSystem(projectId, v.id, { name: name.trim(), terms, files }); toast.success(`Created “${name.trim()}” as a proposal`); onChanged(); onOpenChange(false); onPick(r.id) }
    catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }
  const nothing = !terms.length && !files.length
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="split-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm">Split part of “{v.name}” into a new system</DialogTitle>
          <DialogDescription className="text-[11px]">The new system starts as a proposal. To undo, merge it back.</DialogDescription>
        </DialogHeader>
        <input className={field} value={name} onChange={e => setName(e.target.value)} placeholder="Name of the new system" aria-label="new system name" data-testid="split-name" />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="text-xs font-medium">Terms that move</p>
            <div className="flex flex-wrap gap-1">
              {termChoices.map(t => <button key={t} onClick={() => setTerms(terms.includes(t) ? terms.filter(x => x !== t) : [...terms, t])} aria-pressed={terms.includes(t)}
                className={cn('rounded-full border px-2 py-0.5 text-[11px] hover:bg-accent', terms.includes(t) && 'border-foreground bg-accent')}>{t}</button>)}
              {!termChoices.length && <span className="text-[11px] text-muted-foreground">This system has no name terms to move.</span>}
            </div>
            <TermChips label="Another term" value={terms.filter(t => !termChoices.includes(t))} onChange={x => setTerms([...terms.filter(t => termChoices.includes(t)), ...x])} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">Pinned files that move</p>
            <div className="max-h-24 space-y-0.5 overflow-y-auto">
              {fileChoices.map(f => (
                <label key={f} className="flex items-center gap-1.5 text-[11px]"><input type="checkbox" checked={files.includes(f)} onChange={e => setFiles(e.target.checked ? [...files, f] : files.filter(x => x !== f))} /><span className="truncate font-mono">{f}</span></label>
              ))}
              {!fileChoices.length && <span className="text-[11px] text-muted-foreground">No pinned files.</span>}
            </div>
            <FilePicker projectId={projectId} value={files.filter(f => !fileChoices.includes(f))} onChange={x => setFiles([...files.filter(f => fileChoices.includes(f)), ...x])} />
          </div>
        </div>
        <div className="space-y-0.5 rounded-md border bg-card/40 p-2.5 text-[11px]" data-testid="split-preview">
          {nothing ? <p className="text-muted-foreground">Choose at least one term or file to see what would move.</p> : (
            <>
              <p><b>{moves.length + files.length}</b> files would follow by name or pin; <b>{stays}</b> stay in “{v.name}”.</p>
              <p>Components that move whole: <b>{movingAreas.map(a => a.name).join(', ') || 'none'}</b>. A component with files on both sides stays here.</p>
              {moves.slice(0, 5).map(m => <p key={m.path} className="truncate font-mono text-muted-foreground">{m.path}</p>)}
              {moves.length > 5 && <p className="text-muted-foreground">+ {moves.length - 5} more</p>}
              <p className="text-muted-foreground">Design decisions linked to “{v.name}” stay with it; link them again to the new system if they belong there.</p>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={() => onOpenChange(false)} className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent">Cancel</button>
          <button disabled={busy || !name.trim() || nothing} onClick={run} data-testid="split-confirm" className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40">Create new system</button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
