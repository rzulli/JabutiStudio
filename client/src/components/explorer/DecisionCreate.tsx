import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Sparkles } from 'lucide-react'
import { api, type DecisionAssistResult, type DesignDecision } from '@/lib/api'
import { cn } from '@/lib/utils'
import { draftProblems, proposalFromDraft, type DecisionDraft } from '@/lib/decisionDraft'

/**
 * New decision from a description. The agent drafts the wording and the search terms; the evidence is what the project's
 * own search finds in the checkout (file and line come from there, never typed by hand). Saving creates a PROPOSAL only:
 * the server records it as proposed, nothing is approved, and no implementation status is set.
 */

type Draft = DecisionDraft

const field = 'w-full rounded border bg-background p-2 text-xs outline-none focus:ring-1 focus:ring-ring'

export function DecisionCreate({ projectId, worktree, decisions, onCancel, onSaved }: {
  projectId: string; worktree?: string; decisions: DesignDecision[]
  onCancel: () => void; onSaved: (id: string) => void
}) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [systems, setSystems] = useState<string[]>([])

  const knownSystems = useMemo(
    () => [...new Set(decisions.flatMap(d => d.systems ?? (d.system ? [d.system] : [])))].sort(),
    [decisions],
  )

  const structure = async () => {
    if (text.trim().length < 10 || busy) return
    setBusy(true); setError(null)
    try {
      const r: DecisionAssistResult = await api.assistDecision(projectId, { action: 'structure', text: text.trim(), worktree })
      const d: Draft = {
        title: r.title ?? '', claim: r.claim ?? '', systems: r.systems ?? [],
        evidence: (r.evidence ?? []).map(e => ({ ...e, checked: true })),
        conflicts: (r.conflicts ?? []).map(c => ({ ...c, checked: false })),
        limitations: r.limitations ?? [], notes: r.notes ?? [],
      }
      setDraft(d)
      setSystems(d.systems)
    } catch (e: any) {
      // The description stays in the box; nothing is drafted and nothing is saved.
      setError(e?.message ?? 'The agent did not answer. Your description is kept.')
    } finally {
      setBusy(false)
    }
  }

  const problems = draft ? draftProblems(draft) : []

  const save = async () => {
    if (!draft || problems.length || saving) return
    setSaving(true); setError(null)
    try {
      const body = proposalFromDraft(draft, systems)
      const res = await api.proposeDecision(projectId, body)
      toast.success(`${res.id} proposed. Nothing was approved; review it before attesting.`)
      qc.invalidateQueries({ queryKey: ['design-decisions', projectId] })
      qc.invalidateQueries({ queryKey: ['design', projectId] })
      onSaved(res.id)
    } catch (e: any) {
      setError(e?.message ?? 'The proposal was not saved. Your draft is kept.')
    } finally {
      setSaving(false)
    }
  }

  const toggleSystem = (s: string) => setSystems(cur => cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s])
  const patch = (p: Partial<Draft>) => setDraft(d => (d ? { ...d, ...p } : d))

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4" data-testid="decision-create">
      <div className="flex items-center gap-2">
        <button onClick={onCancel} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" data-testid="decision-create-cancel">
          <ArrowLeft className="h-3 w-3" /> Back to decisions
        </button>
        <h2 className="ml-2 text-sm font-semibold">New decision</h2>
        <span className="ml-auto text-[10px] text-muted-foreground">Saved as a proposal. Nothing is approved.</span>
      </div>

      {!draft && (
        <div className="space-y-2">
          <label className="block text-[11px] text-muted-foreground">
            Describe the decision in your own words
            <textarea value={text} onChange={e => setText(e.target.value)} rows={5} data-testid="decision-create-text"
              placeholder="e.g. A perfect hit in the rhythm game is any press within 45 ms of the beat; anything wider is good, not perfect."
              className={cn(field, 'mt-1 resize-y')} />
          </label>
          <div className="flex items-center gap-2">
            <button onClick={structure} disabled={busy || text.trim().length < 10} data-testid="decision-create-structure"
              className="flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] hover:bg-accent disabled:opacity-40">
              <Sparkles className="h-3 w-3" />{busy ? 'Structuring…' : 'Structure with agent'}
            </button>
            <span className="text-[10px] text-muted-foreground">The agent drafts the wording and what to search for. Evidence is what the checkout actually contains.</span>
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-[11px] text-destructive" data-testid="decision-create-error">{error}</p>}

      {draft && (
        <div className="space-y-3">
          {draft.notes.map((n, i) => (
            <p key={i} className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-[11px]" role="status">{n}</p>
          ))}

          <label className="block text-[11px] text-muted-foreground">
            Title
            <input value={draft.title} onChange={e => patch({ title: e.target.value })} data-testid="decision-create-title" className={cn(field, 'mt-1 h-8')} />
          </label>
          <label className="block text-[11px] text-muted-foreground">
            Claim (the text that would be recorded; review it before saving)
            <textarea value={draft.claim} onChange={e => patch({ claim: e.target.value })} rows={3} data-testid="decision-create-claim" className={cn(field, 'mt-1 resize-y')} />
          </label>

          <div className="space-y-1.5">
            <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">System</h3>
            <div className="flex flex-wrap gap-1.5" data-testid="decision-create-systems">
              {[...new Set([...draft.systems, ...knownSystems])].map(s => (
                <button key={s} type="button" aria-pressed={systems.includes(s)} onClick={() => toggleSystem(s)}
                  className={cn('rounded-md border px-2 py-0.5 font-mono text-[11px] hover:bg-accent', systems.includes(s) && 'bg-accent text-foreground')}>{s}</button>
              ))}
              {!draft.systems.length && !knownSystems.length && <span className="text-[11px] text-muted-foreground">No system known yet. The decision is saved without one.</span>}
            </div>
          </div>

          <div className="space-y-1.5" data-testid="decision-create-evidence">
            <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Evidence found in the checkout</h3>
            {!draft.evidence.length && (
              <p className="text-[11px] text-muted-foreground">
                Nothing matching the search terms was found in this checkout. Describe the code more specifically (names of constants, functions or files) and structure again.
              </p>
            )}
            {draft.evidence.map((e, i) => (
              <label key={`${e.path}:${e.startLine}:${i}`} className="flex items-start gap-2 rounded border px-2 py-1.5 text-[11px]" data-testid="decision-create-evidence-row">
                <input type="checkbox" className="mt-0.5" checked={e.checked}
                  onChange={ev => patch({ evidence: draft.evidence.map((x, j) => (j === i ? { ...x, checked: ev.target.checked } : x)) })} />
                <span className="min-w-0 flex-1">
                  <span className="font-mono">{e.path}:{e.startLine}</span>
                  <span className="ml-2 rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">{e.type.replace('_', ' ')}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">matched “{e.needle}”</span>
                </span>
              </label>
            ))}
          </div>

          {draft.conflicts.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-destructive/40 p-2.5" data-testid="decision-create-conflicts">
              <h3 className="flex items-center gap-1.5 text-[11px] font-medium text-destructive">
                <AlertTriangle className="h-3 w-3" /> Possible conflicts (by title; check before tying them)
              </h3>
              {draft.conflicts.map((c, i) => (
                <label key={c.id} className="flex items-start gap-2 text-[11px]">
                  <input type="checkbox" checked={c.checked}
                    onChange={ev => patch({ conflicts: draft.conflicts.map((x, j) => (j === i ? { ...x, checked: ev.target.checked } : x)) })} />
                  <span><span className="font-mono">{c.id}</span> — {c.title}</span>
                </label>
              ))}
              <p className="text-[10px] text-muted-foreground">Only what you tick is recorded as a conflict. Nothing is resolved here.</p>
            </div>
          )}

          {draft.limitations.length > 0 && (
            <div className="space-y-1" data-testid="decision-create-limitations">
              <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Not settled by the description</h3>
              <ul className="list-disc pl-4 text-[11px] text-muted-foreground">{draft.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </div>
          )}

          {problems.length > 0 && (
            <ul className="list-disc pl-4 text-[11px] text-muted-foreground" data-testid="decision-create-problems">
              {problems.map(p => <li key={p}>{p}</li>)}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <button onClick={() => setDraft(null)} className="text-[11px] text-muted-foreground underline hover:text-foreground">Edit the description again</button>
            <button onClick={save} disabled={saving || problems.length > 0} data-testid="decision-create-save"
              className="ml-auto rounded-md border border-success/50 px-2.5 py-1 text-[11px] text-success hover:bg-accent disabled:opacity-40">
              {saving ? 'Saving…' : 'Save as proposal'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
