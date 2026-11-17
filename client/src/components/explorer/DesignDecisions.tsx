import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Scale, AlertTriangle, ChevronRight, Sparkles } from 'lucide-react'
import { api, type DesignDecision, type DesignEvidence, type DesignFreshness } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ProposeDecision } from './ProposeDecision'

/**
 * Design decisions that cite or list the selected file (from the project's own Design Knowledge
 * registry), shown with what is verified and what is only claimed. Never a place that says
 * "approved" because a document says so: only a local attestation does (never a verified identity).
 */

const FRESH: Record<DesignFreshness, { label: string; tone: string; hint: string }> = {
  CURRENT: { label: 'current', tone: 'text-muted-foreground', hint: 'The cited text is where it was recorded.' },
  MOVED: { label: 'moved', tone: 'text-muted-foreground', hint: 'Same text, new position or file name.' },
  CHANGED: { label: 'changed', tone: 'text-warning', hint: 'The cited text no longer appears. The claim may be outdated.' },
  AMBIGUOUS: { label: 'ambiguous', tone: 'text-warning', hint: 'The cited text now appears more than once.' },
  STALE: { label: 'changed', tone: 'text-warning', hint: 'The file changed and the cited lines cannot be located.' },
  GONE: { label: 'missing', tone: 'text-destructive', hint: 'The source file is gone and no rename was found.' },
  UNKNOWN: { label: 'unknown', tone: 'text-muted-foreground', hint: 'No fingerprint was registered.' },
}


const NL = String.fromCharCode(10)

/** The briefing an agent gets: what is claimed, what the code does, and that approval is a separate fact. */
export function buildInvestigationPrompt(d: DesignDecision, others: Record<string, DesignDecision>, ctx: { projectId: string; file: string; examined?: string; branch?: string | null; head?: string | null }): string {
  const ev = d.evidence.filter(e => !e.candidate_only)
  const lines = (kind: (e: DesignEvidence) => boolean) => ev.filter(kind).map(e => `  - ${e.type} ${e.path ?? e.ref} [${e.freshness}]${e.note ? ` — ${e.note}` : ''}`).join(NL) || '  - (none)'
  const conflicts = d.conflicts_with.map(id => others[id] ? `${id} (“${others[id].claim}”)` : id).join('; ')
  const a = d.approval
  const approval = a.state === 'approved' ? `a local attestation exists (${a.source}${a.at ? `, ${a.at}` : ''}); it is not proof of who made it`
    : a.state === 'claimed' ? 'NOT LOCATED: only a document or agent claims approval; nobody has confirmed it'
    : a.state === 'unknown' ? 'NOT LOCATED: no approval is recorded anywhere' : `${a.state}`
  return [
    `Investigate design decision ${d.id} (“${d.title}”) in project ${ctx.projectId}, file ${ctx.file}.`,
    `Examined checkout: ${ctx.examined ?? 'project root'}${ctx.branch ? ` @ ${ctx.branch}` : ''}${ctx.head ? ` (${ctx.head})` : ''}. First call the MCP tool get_design_context with projectId="${ctx.projectId}" and file="${ctx.file}" (add taskId if you work in a task worktree).`,
    `Recorded claim (historical, unverified): ${d.claim}`,
    `What the implementation does now (${d.implementation}; evidence ${d.evidence_status}):
${lines(e => e.type === 'code')}`,
    `Documents asserting this (claims, not approvals):
${lines(e => e.type !== 'code' && e.type !== 'test')}`,
    `Tests:
${lines(e => e.type === 'test')}`,
    conflicts ? `Known conflict with: ${conflicts}. Do not pick a side.` : '',
    `Human approval: ${approval}.`,
    'Report where code, tests and claims diverge and what evidence is missing. Do NOT treat a comment, report, passing test or your own reading as human approval, and do not change any value to resolve the conflict.',
  ].filter(Boolean).join(NL)
}

function ApprovalBadge({ d }: { d: DesignDecision }) {
  const a = d.approval
  if (a.state === 'approved') return <span className="rounded border border-success/40 px-1 text-[9px] uppercase text-success" title={`Attested locally in this JabutiStudio${a.at ? ` on ${a.at}` : ''}${a.quote ? `: “${a.quote}”` : ''}. This is a local record, not proof of who made it, and it stays on this installation (not in the repository).`}>attested locally</span>
  if (a.state === 'rejected' || a.state === 'revoked') return <span className="rounded border px-1 text-[9px] uppercase text-destructive">{a.state}</span>
  if (a.state === 'claimed') {
    return <span className="rounded border border-dashed px-1 text-[9px] uppercase text-warning" title={a.detail ?? 'A document or record says this was approved. Nobody has confirmed it here.'}>
      {a.source === 'attestation-lapsed' ? 'approval lapsed' : 'claimed, unverified'}
    </span>
  }
  if (a.lapsed) return <span className="rounded border border-dashed px-1 text-[9px] uppercase text-warning" title="A local attestation existed for an earlier wording of this claim.">approval lapsed</span>
  return <span className="rounded border border-dashed px-1 text-[9px] uppercase text-muted-foreground" title="No approval is recorded.">not approved</span>
}

function EvidenceRow({ e, onOpen }: { e: DesignEvidence; onOpen: (file: string, line?: number) => void }) {
  const f = FRESH[e.freshness]
  const m = /^(.+?)(?:#L(\d+))?(?:-L?\d+)?$/.exec(e.ref)
  const file = e.path ?? m?.[1] ?? e.ref
  const line = e.lines?.[0] ?? (m?.[2] ? Number(m[2]) : undefined)
  return (
    <div className="border-t px-3 py-1.5 first:border-0">
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="rounded bg-muted px-1 uppercase text-muted-foreground">{e.type.replace('_', ' ')}</span>
        <button onClick={() => !e.ref.startsWith('@') && onOpen(file, line)} className="truncate font-mono hover:text-foreground" title="Open the cited source">{e.ref}</button>
        <span className={cn('ml-auto shrink-0', f.tone)} title={`${f.hint} ${e.detail}`}>{f.label}</span>
      </div>
      {e.note && <div className="mt-0.5 text-[11px] text-muted-foreground">{e.note}</div>}
      {e.excerpt.length > 0 && (
        <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-1.5 font-mono text-[10px] leading-snug scrollbar-dark">
          {e.excerpt.map(x => `${x.line}: ${x.text}`).join('\n')}
        </pre>
      )}
      {e.detail && e.freshness !== 'CURRENT' && <div className="mt-0.5 text-[10px] text-muted-foreground">{e.detail}</div>}
    </div>
  )
}

function Decision({ d, projectId, onOpen, onInvestigate, others, ctx }: {
  d: DesignDecision; projectId: string; others: Record<string, DesignDecision>; ctx: { projectId: string; file: string; examined?: string; branch?: string | null; head?: string | null }
  onOpen: (file: string, line?: number) => void; onInvestigate: (text: string) => void
}) {
  const [open, setOpen] = useState(d.conflicts_with.length > 0 || d.approval.state === 'unknown')
  const [asking, setAsking] = useState(false)
  const [quote, setQuote] = useState('')
  const queryClient = useQueryClient()
  const send = async (state: 'approved' | 'rejected' | 'revoked') => {
    try {
      await api.attestDecision(projectId, { decisionId: d.id, state, quote })
      toast.success(`${d.id} ${state} (recorded locally)`)
      setAsking(false); setQuote('')
      queryClient.invalidateQueries({ queryKey: ['design', projectId] })
    } catch (err) { toast.error((err as Error).message) }
  }
  const evidence = d.evidence.filter(e => !e.candidate_only)
  const candidates = d.files.length + d.tests.filter(t => !t.direct).length
  return (
    <div className="border-b last:border-0" data-testid="design-decision">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-start gap-1.5 px-3 py-2 text-left">
        <ChevronRight className={cn('mt-0.5 h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] text-muted-foreground">{d.id}</span>
            <ApprovalBadge d={d} />
            {d.source === 'native' && <span className="rounded border px-1 text-[9px] uppercase text-muted-foreground" title="Stored in jabutistudio.decisions.json in the project">{d.provenance?.origin === 'agent' ? 'agent proposal' : 'proposal'}</span>}
            {d.conflicts_with.length > 0 && <span className="flex items-center gap-0.5 text-[10px] text-destructive"><AlertTriangle className="h-3 w-3" />conflict</span>}
          </div>
          <div className="mt-0.5 text-xs font-medium leading-snug">{d.title}</div>
        </div>
      </button>
      {open && (
        <div className="space-y-2 pb-2">
          <p className="px-3 text-[11px] leading-snug text-muted-foreground">{d.claim}</p>
          {d.conflicts_with.length > 0 && (
            <div className="mx-3 rounded border border-destructive/30 p-1.5 text-[11px]">
              Conflicts with {d.conflicts_with.map(id => others[id] ? `${id} (${others[id].title})` : id).join('; ')}. Neither side is approved here.
            </div>
          )}
          <div className="px-3 text-[10px] text-muted-foreground">
            Code reads <b>{d.implementation}</b>{d.implementation !== d.catalogued_implementation && ` (catalogued as ${d.catalogued_implementation})`} · evidence <b>{d.evidence_status.toLowerCase()}</b>
          </div>
          <div className="rounded border-y">{evidence.map((e, i) => <EvidenceRow key={i} e={e} onOpen={onOpen} />)}</div>
          {candidates > 0 && (
            <details className="px-3 text-[10px] text-muted-foreground">
              <summary className="cursor-pointer">Candidate impact, hand-listed and incomplete ({candidates})</summary>
              <ul className="mt-1 space-y-0.5 font-mono">
                {d.files.map(f => <li key={f.path}><button className="hover:text-foreground" onClick={() => onOpen(f.path)}>{f.path}</button></li>)}
                {d.tests.filter(t => !t.direct).map(t => <li key={t.path}>test: {t.path}</li>)}
              </ul>
            </details>
          )}
          <div className="flex flex-wrap gap-1.5 px-3">
            <button onClick={() => onInvestigate(buildInvestigationPrompt(d, others, ctx))}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent"><Sparkles className="h-3 w-3" /> Investigate with agent</button>
            {!asking && <button onClick={() => setAsking(true)} className="rounded-md border px-2 py-1 text-[11px] hover:bg-accent" data-testid="design-record-approval">Record my decision…</button>}
          </div>
          {asking && (
            <div className="mx-3 space-y-1.5 rounded border p-2">
              <p className="text-[10px] text-muted-foreground">Paste or write what you decided. It is stored with this exact claim text; editing the claim later lapses it.</p>
              <textarea value={quote} onChange={e => setQuote(e.target.value)} rows={3} placeholder="e.g. First maturation costs 1000 matter for now — owner, 12 Nov"
                className="w-full resize-y rounded border bg-background p-1.5 text-[11px]" data-testid="design-quote" />
              <div className="flex gap-1.5">
                <button disabled={quote.trim().length < 3} onClick={() => send('approved')} className="rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40">Approve</button>
                <button disabled={quote.trim().length < 3} onClick={() => send('rejected')} className="rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40">Reject</button>
                {d.approval.state === 'approved' && <button disabled={quote.trim().length < 3} onClick={() => send('revoked')} className="rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40">Revoke</button>}
                <button onClick={() => setAsking(false)} className="ml-auto text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function DesignDecisions({ projectId, file, worktree, onOpen, onInvestigate }: {
  projectId: string; file: string; worktree?: string
  onOpen: (file: string, line?: number) => void; onInvestigate: (text: string) => void
}) {
  const q = useQuery({
    queryKey: ['design', projectId, file, worktree ?? ''],
    queryFn: () => api.getDesign(projectId, file, worktree),
    staleTime: 5_000,
  })
  if (!q.data || !q.data.available) return null
  const decisions = q.data.decisions ?? []
  const byId = Object.fromEntries(decisions.map(d => [d.id, d]))
  const where = q.data.examined && !q.data.examined.isCanonical ? q.data.branch ?? 'worktree' : null
  return (
    <div className="border-b" data-testid="design-decisions">
      <div className="flex items-center gap-1.5 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <Scale className="h-3 w-3" /> Design decisions {decisions.length}
        {where && <span className="ml-auto normal-case text-warning" title="Evidence is judged against this worktree, not the integrated code.">checking {where}</span>}
      </div>
      {decisions.length === 0 && <p className="px-3 pb-2 text-[11px] text-muted-foreground">No recorded decision cites this file. That does not mean none exists.</p>}
      {decisions.map(d => <Decision key={d.id} d={d} projectId={projectId} others={byId} onOpen={onOpen} onInvestigate={onInvestigate} ctx={{ projectId, file, examined: q.data.examined?.root, branch: q.data.branch, head: q.data.head }} />)}
      <ProposeDecision projectId={projectId} file={file} />
    </div>
  )
}
