import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { api } from '@/lib/api'

/**
 * Register a design PROPOSAL backed by one real piece of evidence. It is saved to
 * `jabutistudio.decisions.json` in the project (commit it to share) as "proposed": nothing here approves it.
 */
export function ProposeDecision({ projectId, file, systemId, onDone }: { projectId: string; file?: string; systemId?: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ title: '', claim: '', path: file ?? '', needle: '', line: '', type: 'code' })
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(s => ({ ...s, [k]: e.target.value }))
  const valid = f.title.trim() && f.claim.trim() && f.path.trim()
  const save = async () => {
    setBusy(true)
    try {
      const d = await api.proposeDecision(projectId, {
        title: f.title, claim: f.claim, systems: systemId ? [systemId] : [], scope: f.title.split(/\s+/).filter(w => w.length > 3).slice(0, 5),
        evidence: [{ type: f.type, path: f.path.trim(), needle: f.needle.trim() || undefined, startLine: f.line ? parseInt(f.line, 10) : undefined }],
      })
      toast.success(`Proposal ${d.id} saved (not approved)`)
      setOpen(false); setF(s => ({ ...s, title: '', claim: '', needle: '', line: '' }))
      qc.invalidateQueries({ queryKey: ['design', projectId] }); qc.invalidateQueries({ queryKey: ['system', projectId] }); qc.invalidateQueries({ queryKey: ['systems', projectId] })
      onDone?.()
    } catch (err) { toast.error((err as Error).message) } finally { setBusy(false) }
  }
  if (!open) {
    return <button onClick={() => setOpen(true)} className="mx-3 mb-2 flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent" data-testid="design-propose"><Plus className="h-3 w-3" /> Propose decision…</button>
  }
  const field = 'w-full rounded border bg-background p-1.5 text-[11px]'
  return (
    <div className="mx-3 mb-2 space-y-1.5 rounded border p-2" data-testid="design-propose-form">
      <p className="text-[10px] text-muted-foreground">A proposal needs real evidence from this checkout. It is stored as “proposed”; approving it is a separate step.</p>
      <input className={field} placeholder="Title" value={f.title} onChange={set('title')} data-testid="propose-title" />
      <textarea className={field} rows={2} placeholder="The rule or claim, stated precisely" value={f.claim} onChange={set('claim')} data-testid="propose-claim" />
      <div className="flex gap-1.5">
        <select className="rounded border bg-background p-1 text-[11px]" value={f.type} onChange={set('type')}>
          {['code', 'test', 'document_claim', 'data'].map(t => <option key={t}>{t}</option>)}
        </select>
        <input className={field} placeholder="evidence file (relative path)" value={f.path} onChange={set('path')} data-testid="propose-path" />
      </div>
      <div className="flex gap-1.5">
        <input className={field} placeholder="exact text that must appear (optional)" value={f.needle} onChange={set('needle')} data-testid="propose-needle" />
        <input className="w-16 rounded border bg-background p-1.5 text-[11px]" placeholder="line" value={f.line} onChange={set('line')} />
      </div>
      <div className="flex gap-1.5">
        <button disabled={!valid || busy} onClick={save} className="rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40" data-testid="propose-save">Save proposal</button>
        <button onClick={() => setOpen(false)} className="ml-auto text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>
      </div>
    </div>
  )
}
