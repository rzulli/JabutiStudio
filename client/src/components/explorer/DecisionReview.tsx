import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, Loader2, Scale, Search, SkipForward, Sparkles, Undo2 } from 'lucide-react'
import { api, type DesignDecision } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  approvalGuard, conflictSides, DECISION_ASSIST, decisionAgentPrompt, evidenceForProposal, filterQueue, hasConflict, originOf, ORIGIN_LABEL,
  queueCounts, resolveIndex, reviewBriefing, SCOPE_LABEL, stepIndex, suggestionStale, tierOf, TIER_HINT, TIER_LABEL,
  type ApprovalTier, type QueueFilter, type QueueScope,
} from '@/lib/designReview'
import { buildChanges } from '@/lib/suggestions'
import { openAgentSession } from '@/lib/terminalDispatch'
import { SuggestionPanel } from '@/components/claude/SuggestionPanel'

/**
 * Decisions, project-wide: a Feed (searchable list) and a Review (one decision at a time). Both read the same query and
 * the same native records as the per-file panel, and both keep the selected decision when switching. The only write is
 * the existing attestation route (POST /design/approve) with the hash of the text the person read; nothing here edits
 * the decisions file, and skipping or moving between items never changes an approval.
 */

export type DecisionsMode = 'feed' | 'review'

export interface DecisionsState {
  mode: DecisionsMode
  selectedId: string | null
  filter: QueueFilter
}

const TIER_CLASS: Record<ApprovalTier, string> = {
  attested_local: 'border-success/50 text-success',
  claimed: 'border-dashed border-warning/60 text-warning',
  proposed: 'border-dashed text-muted-foreground',
  lapsed: 'border-dashed border-warning/60 text-warning',
  rejected: 'border-destructive/50 text-destructive',
}

const FRESH_LABEL: Record<string, string> = {
  CURRENT: 'current', MOVED: 'moved', CHANGED: 'changed', AMBIGUOUS: 'ambiguous', STALE: 'changed', GONE: 'missing', UNKNOWN: 'unknown',
}

const btn = 'rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent'

/** An agent answer about one decision. `claimSha256` pins the text it was computed from. */
interface AssistSuggestion { action: string; claimSha256: string; claim?: string; notes: string[] }
const ASSIST_HEADING: Record<string, string> = { rephrase: 'Improve wording', evidence: 'Evidence', conflicts: 'Conflicts', compare: 'Compared with code' }

export function TierBadge({ d }: { d: DesignDecision }) {
  const t = tierOf(d)
  return <span className={cn('rounded border px-1.5 py-px text-[10px]', TIER_CLASS[t])} title={TIER_HINT[t]} data-testid="tier-badge" data-tier={t}>{TIER_LABEL[t]}</span>
}

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.error('Could not copy. The clipboard is not available here.')
  }
}

export function DecisionsView({ projectId, worktree, state, onState, onOpenFile, onOpenSystem }: {
  projectId: string; worktree?: string; state: DecisionsState
  onState: (patch: Partial<DecisionsState>) => void
  onOpenFile: (file: string, line?: number) => void; onOpenSystem: (id: string) => void
}) {
  const q = useQuery({
    queryKey: ['design-decisions', projectId, worktree ?? ''],
    queryFn: () => api.listDesignDecisions(projectId, worktree || undefined),
    refetchInterval: 15_000, staleTime: 5_000, placeholderData: p => p,
  })
  const all = q.data?.decisions ?? []
  const queue = useMemo(() => filterQueue(all, state.filter), [all, state.filter])
  const counts = queueCounts(all)
  const setFilter = (patch: Partial<QueueFilter>) => onState({ filter: { ...state.filter, ...patch } })

  if (q.isError && !all.length) {
    return (
      <div className="m-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs" role="alert" data-testid="decisions-error">
        <p className="font-medium text-destructive">Could not load the decisions.</p>
        <p className="mt-1 text-muted-foreground">{(q.error as Error).message}</p>
        <button onClick={() => q.refetch()} className="mt-2 underline">Retry</button>
      </div>
    )
  }
  if (q.data && !q.data.available) {
    return <p className="p-6 text-xs text-muted-foreground" data-testid="decisions-unavailable">Design decisions are not available for this checkout{q.data.reason ? `: ${q.data.reason}` : '.'}</p>
  }

  const systems = [...new Set(all.flatMap(d => d.systems ?? (d.system ? [d.system] : [])))].sort()
  const origins = [...new Set(all.map(originOf))].sort()
  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4" data-testid="decisions-view">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex gap-0.5" role="tablist" aria-label="Decisions view">
          {(['feed', 'review'] as const).map(m => (
            <button key={m} role="tab" aria-selected={state.mode === m} data-testid={`decisions-mode-${m}`}
              onClick={() => onState({ mode: m, selectedId: state.selectedId ?? queue[0]?.id ?? null })}
              className={cn('rounded-md px-2.5 py-1 text-[11px] hover:bg-accent', state.mode === m ? 'bg-accent text-foreground' : 'text-muted-foreground')}>
              {m === 'feed' ? 'Feed' : 'Review'}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums" data-testid="decisions-counts">
          {counts.total} decisions · {counts.pending} pending · {counts.attested} attested locally · {counts.conflicts} in conflict
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <div className="flex items-center gap-1.5 rounded-md border bg-background px-2">
          <Search className="h-3 w-3 text-muted-foreground" />
          <input value={state.filter.query ?? ''} onChange={e => setFilter({ query: e.target.value })} placeholder="Find by title or ID"
            data-testid="decisions-search" className="h-7 w-56 bg-transparent text-xs outline-none" />
        </div>
        {(Object.keys(SCOPE_LABEL) as QueueScope[]).map(s => (
          <button key={s} onClick={() => setFilter({ scope: s })} aria-pressed={state.filter.scope === s} data-testid={`decisions-scope-${s}`}
            className={cn('rounded-md border px-2 py-1 hover:bg-accent', state.filter.scope === s && 'bg-accent text-foreground')}>{SCOPE_LABEL[s]}</button>
        ))}
        <select value={state.filter.system ?? ''} onChange={e => setFilter({ system: e.target.value || undefined })} aria-label="System"
          className="h-7 rounded-md border bg-background px-1.5 text-[11px]" data-testid="decisions-system">
          <option value="">Any system</option>
          {systems.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={state.filter.origin ?? ''} onChange={e => setFilter({ origin: e.target.value || undefined })} aria-label="Origin"
          className="h-7 rounded-md border bg-background px-1.5 text-[11px]" data-testid="decisions-origin">
          <option value="">Any origin</option>
          {origins.map(o => <option key={o} value={o}>{ORIGIN_LABEL[o] ?? o}</option>)}
        </select>
      </div>

      {!q.isLoading && !all.length && <p className="text-xs text-muted-foreground">No native decisions are recorded in this checkout yet.</p>}
      {all.length > 0 && !queue.length && <p className="text-xs text-muted-foreground" data-testid="decisions-empty-filter">No decision matches this filter.</p>}

      {state.mode === 'feed'
        ? <Feed queue={queue} selectedId={state.selectedId} onSelect={id => onState({ mode: 'review', selectedId: id })} />
        : <Review projectId={projectId} worktree={worktree} all={all} queue={queue} state={state} onState={onState} counts={counts}
            onOpenFile={onOpenFile} onOpenSystem={onOpenSystem} />}
    </div>
  )
}

function Feed({ queue, selectedId, onSelect }: { queue: DesignDecision[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <ul className="divide-y rounded-md border" data-testid="decisions-feed">
      {queue.map(d => (
        <li key={d.id} data-testid="decision-row" data-id={d.id} className={cn('flex items-start gap-2 px-3 py-2', selectedId === d.id && 'bg-accent/50')}>
          <button onClick={() => onSelect(d.id)} className="min-w-0 flex-1 text-left">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10px] text-muted-foreground">{d.id}</span>
              <TierBadge d={d} />
              {hasConflict(d) && <span className="flex items-center gap-0.5 text-[10px] text-destructive"><AlertTriangle className="h-3 w-3" />conflict</span>}
            </div>
            <div className="mt-0.5 text-xs font-medium leading-snug">{d.title}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">{d.systems?.length ? d.systems.join(', ') : 'no system'} · {ORIGIN_LABEL[originOf(d)] ?? originOf(d)} · evidence {d.evidence_status.toLowerCase()} · code {d.implementation}</div>
          </button>
          <button onClick={() => copyText(d.id, 'ID')} className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground" aria-label={`Copy ID ${d.id}`} title="Copy ID">
            <Copy className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  )
}

function Review({ projectId, worktree, all, queue, state, onState, counts, onOpenFile, onOpenSystem }: {
  projectId: string; worktree?: string; all: DesignDecision[]; queue: DesignDecision[]; state: DecisionsState
  counts: ReturnType<typeof queueCounts>
  onState: (patch: Partial<DecisionsState>) => void; onOpenFile: (file: string, line?: number) => void; onOpenSystem: (id: string) => void
}) {
  const qc = useQueryClient()
  const [lastIndex, setLastIndex] = useState(0)
  const [loaded, setLoaded] = useState<{ id: string; claimSha256: string } | null>(null)
  const [viewed, setViewed] = useState<Set<string>>(() => new Set())
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set())
  const [attestedNow, setAttestedNow] = useState<Set<string>>(() => new Set())
  const [confirm, setConfirm] = useState<'approved' | 'revoked' | null>(null)
  const [quote, setQuote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Agent suggestions are kept per decision, so moving to another item and back does not lose them.
  const [suggestions, setSuggestions] = useState<Record<string, AssistSuggestion>>({})
  const [busyAssist, setBusyAssist] = useState<string | null>(null)

  const { index, vanished } = resolveIndex(queue, state.selectedId, lastIndex)
  const current = queue[index]

  // Opening an item records what the person is looking at: its ID and the hash of its text. That is the only thing an
  // attestation is bound to.
  const open = (d: DesignDecision | undefined) => {
    if (!d) return
    onState({ selectedId: d.id })
    setLoaded({ id: d.id, claimSha256: d.claim_sha256 })
    setViewed(s => new Set(s).add(d.id))
    setConfirm(null); setQuote(''); setError(null)
  }
  // Remember the last position so a vanished item falls back to the neighbour, not to the top of the queue.
  useEffect(() => { setLastIndex(index) }, [index])
  // First open (or arriving from the Feed with a selection): the item is loaded as it is now. A vanished item is NOT
  // re-loaded silently: the guard keeps approval blocked until the person moves to an item on purpose.
  useEffect(() => {
    if (current && !vanished && state.selectedId === current.id && (!loaded || loaded.id !== current.id)) open(current)
    else if (current && !state.selectedId) open(current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, vanished, state.selectedId])

  const go = (dir: 1 | -1) => open(queue[stepIndex(queue.length, index, dir)])
  const skip = () => {
    if (!current) return
    setSkipped(s => new Set(s).add(current.id))
    // Skipping only moves on; the decision stays pending and nothing is written.
    go(1)
  }

  const guard = approvalGuard(loaded, current)
  const canWrite = guard === 'ok' && !!current
  const send = async (verdict: 'approved' | 'revoked') => {
    if (!current || !loaded || guard !== 'ok') return
    setSending(true); setError(null)
    try {
      await api.attestDecision(projectId, { decisionId: current.id, state: verdict, quote, claimSha256: loaded.claimSha256 })
      if (verdict === 'approved') setAttestedNow(s => new Set(s).add(current.id))
      toast.success(verdict === 'approved' ? `${current.id} attested locally` : `${current.id} attestation revoked`)
      setConfirm(null); setQuote('')
    } catch (e: any) {
      setError(e?.message ?? 'The attestation was not recorded.')
    } finally {
      setSending(false)
      qc.invalidateQueries({ queryKey: ['design-decisions', projectId] })
      qc.invalidateQueries({ queryKey: ['design', projectId] })
    }
  }

  // Keyboard: arrows move, S skips, A opens the attestation confirmation. Typing in a field never triggers them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      else if (e.key === 's' || e.key === 'S') skip()
      else if ((e.key === 'a' || e.key === 'A') && canWrite && tierOf(current!) !== 'attested_local') setConfirm('approved')
      else if (e.key === 'Escape') setConfirm(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!queue.length) {
    return <p className="text-xs text-muted-foreground" data-testid="review-empty">Nothing to review with this filter.</p>
  }
  if (!current) return null

  const sides = conflictSides(current, all)
  const attested = tierOf(current) === 'attested_local'
  const evidence = current.evidence.filter(e => !e.candidate_only)
  const briefing = reviewBriefing(current, projectId)

  // Advisory only: asks the agent about this decision and keeps the answer as a suggestion. Nothing is written.
  const runAssist = async (action: string) => {
    if (busyAssist) return
    const item = current
    setBusyAssist(action)
    try {
      const r = await api.assistDecision(projectId, { action: action as 'rephrase', decisionId: item.id, worktree })
      setSuggestions(s => ({ ...s, [item.id]: { action, claimSha256: item.claim_sha256, claim: r.claim, notes: r.notes ?? [] } }))
    } catch (e: any) {
      toast.error(`${e?.message ?? 'The agent did not answer.'} Nothing was changed.`)
    } finally {
      setBusyAssist(null)
    }
  }

  // Applying a rewording creates a NEW proposal that supersedes this one. The original text, its evidence and its
  // approval stay exactly as they were.
  const applyRewrite = async (item: DesignDecision, sugg: AssistSuggestion, picks: Record<string, boolean>) => {
    if (!picks.claim || !sugg.claim || sending) return
    setSending(true); setError(null)
    try {
      const res = await api.proposeDecision(projectId, {
        title: item.title, claim: sugg.claim, systems: item.systems ?? [], scope: item.scope ?? [],
        files: item.files.map(f => f.path), supersedes: [item.id], evidence: evidenceForProposal(item),
      })
      toast.success(`${res.id} proposed; it supersedes ${item.id}. Nothing was approved; ${item.id} is unchanged.`)
      setSuggestions(s => { const n = { ...s }; delete n[item.id]; return n })
    } catch (e: any) {
      setError(e?.message ?? 'The new proposal was not saved.')
    } finally {
      setSending(false)
      qc.invalidateQueries({ queryKey: ['design-decisions', projectId] })
      qc.invalidateQueries({ queryKey: ['design', projectId] })
    }
  }

  const askAgent = async () => {
    const item = current
    const result = await openAgentSession({ projectId, agent: 'claude', prompt: decisionAgentPrompt(item, projectId, all, worktree) })
    if (result.ok) toast.success(`Agent session opened for ${item.id}. Nothing is applied from it.`)
    else toast.error(`${result.error} The context was not sent.`)
  }

  return (
    <div className="space-y-3" data-testid="decision-review">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="review-progress">
        <span className="font-medium text-foreground tabular-nums">Item {index + 1} of {queue.length}</span>
        <span className="tabular-nums">{counts.pending} pending in project</span>
        <span className="tabular-nums" title="Items you opened in this session. Opening is not approval.">{viewed.size} reviewed this session</span>
        <span className="tabular-nums">{attestedNow.size} attested this session</span>
        <span className="tabular-nums">{skipped.size} skipped</span>
        <button onClick={() => onState({ mode: 'feed' })} className="ml-auto underline hover:text-foreground" data-testid="review-back-feed">Back to Feed</button>
      </div>

      {vanished && <Notice tone="warning">The decision you were on is no longer in this queue. Showing the nearest one; nothing was attested.</Notice>}
      {guard === 'changed' && <Notice tone="warning" action={<button className="underline" onClick={() => setLoaded({ id: current.id, claimSha256: current.claim_sha256 })}>Reload this item</button>}>
        This decision text changed while you were reviewing it. Read the new text before attesting; the attestation is blocked until you reload it.
      </Notice>}

      <article className="space-y-3 rounded-lg border bg-card p-4 shadow-sm" data-testid="review-card" data-id={current.id}>
        <header className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-accent px-1.5 py-px text-[10px] uppercase text-muted-foreground">decision</span>
            <span className="font-mono text-[11px] text-muted-foreground" data-testid="review-id">{current.id}</span>
            <button onClick={() => copyText(current.id, 'ID')} className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Copy ID" title="Copy ID"><Copy className="h-3 w-3" /></button>
            <button onClick={() => copyText(briefing, 'Context')} className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Copy context for an agent" title="Copy context for an agent"><Sparkles className="h-3 w-3" /></button>
          </div>
          <h2 className="text-sm font-semibold leading-snug" data-testid="review-title">{current.title}</h2>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <TierBadge d={current} />
            <span>{ORIGIN_LABEL[originOf(current)] ?? originOf(current)}</span>
            <span>·</span>
            <span>system:</span>
            {current.systems?.length
              ? current.systems.map(s => <button key={s} onClick={() => onOpenSystem(s)} className="font-mono underline hover:text-foreground">{s}</button>)
              : <span>none</span>}
          </div>
        </header>

        <section className="space-y-1">
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Recorded text (proposal, not approval)</h3>
          <p className="whitespace-pre-wrap text-sm leading-relaxed" data-testid="review-claim">{current.claim}</p>
          {(current.scope?.length ?? 0) > 0 && <p className="text-[11px] text-muted-foreground">Scope: {(current.scope ?? []).join(', ')}</p>}
          <p className="text-[11px] text-muted-foreground" data-testid="review-intent-vs-code">
            Intent: as recorded above. Code reads <b>{current.implementation}</b> (catalogued {current.catalogued_implementation}) · evidence <b>{current.evidence_status.toLowerCase()}</b>.
            {current.implementation === 'implemented' && ' Code matching the cited snippets is not human approval, nor full compliance.'}
          </p>
        </section>

        {hasConflict(current) && (
          <section className="space-y-2 rounded-md border border-destructive/40 p-3" data-testid="review-conflict">
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-destructive"><AlertTriangle className="h-3.5 w-3.5" /> Conflict: not resolved by any attestation here</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {[current, ...sides.found].map(d => (
                <div key={d.id} className={cn('min-w-0 space-y-1 rounded border p-2 text-[11px]', d.id === current.id && 'border-foreground/30')}>
                  <div className="font-mono text-[10px] text-muted-foreground">{d.id}{d.id === current.id ? ' (this one)' : ''}</div>
                  <div className="font-medium">{d.title}</div>
                  <TierBadge d={d} />
                  <div className="text-muted-foreground">code {d.implementation} · evidence {d.evidence_status.toLowerCase()}</div>
                </div>
              ))}
            </div>
            {sides.missing.length > 0 && <p className="text-[10px] text-muted-foreground">Not in this checkout's file: {sides.missing.join(', ')}</p>}
            <p className="text-[11px] text-muted-foreground">Attesting one side does not choose a winner. Deciding which value stands is still open: the owner has to decide it.</p>
          </section>
        )}

        <section className="space-y-1.5">
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Evidence</h3>
          {current.files.length > 0 && (
            <p className="text-[11px] text-muted-foreground">Files: {current.files.map(f => <button key={f.path} onClick={() => onOpenFile(f.path)} className="mr-2 font-mono hover:text-foreground hover:underline">{f.path}</button>)}</p>
          )}
          {current.tests.length > 0 && <p className="text-[11px] text-muted-foreground">Tests (static reference, no result): {current.tests.map(t => t.path).join(', ')}</p>}
          {!evidence.length && <p className="text-[11px] text-muted-foreground">No cited evidence.</p>}
          {evidence.map((e, i) => (
            <details key={i} className="rounded border px-2 py-1 text-[11px]" open={i === 0}>
              <summary className="flex cursor-pointer flex-wrap items-center gap-1.5">
                <span className="rounded bg-muted px-1 uppercase text-muted-foreground">{e.type.replace('_', ' ')}</span>
                <button onClick={ev => { ev.preventDefault(); if (!e.ref.startsWith('@') && e.path) onOpenFile(e.path, e.lines?.[0]) }} className="truncate font-mono hover:underline">{e.ref}</button>
                <span className={cn('ml-auto text-[10px]', e.freshness === 'CURRENT' ? 'text-muted-foreground' : 'text-warning')} title={e.detail}>{FRESH_LABEL[e.freshness] ?? e.freshness} now</span>
              </summary>
              {e.note && <p className="mt-1 text-muted-foreground">{e.note}</p>}
              {e.excerpt.length > 0 && <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-1.5 font-mono text-[10px]">{e.excerpt.slice(0, 8).map(x => `${x.line}: ${x.text}`).join('\n')}</pre>}
            </details>
          ))}
        </section>

        <section className="space-y-2" data-testid="decision-assist">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Agent help · suggestions only</h3>
            {DECISION_ASSIST.map(a => (
              <button key={a.action} type="button" title={a.hint} disabled={!!busyAssist || sending}
                onClick={() => runAssist(a.action)} className={cn(btn, 'flex items-center gap-1')} data-testid={`decision-assist-${a.action}`}>
                {busyAssist === a.action && <Loader2 className="h-3 w-3 animate-spin" />}{a.label}
              </button>
            ))}
            <button type="button" onClick={askAgent} className={cn(btn, 'flex items-center gap-1')} data-testid="review-ask-agent"
              title="Open an agent session with this decision, its state, evidence and conflicts">
              <Sparkles className="h-3 w-3" />Ask agent
            </button>
          </div>
          {(() => {
            const sugg = suggestions[current.id]
            if (!sugg) return null
            if (suggestionStale(sugg.claimSha256, current)) {
              return (
                <Notice tone="warning" action={<button className="underline" onClick={() => setSuggestions(s => { const n = { ...s }; delete n[current.id]; return n })}>Discard</button>}>
                  This decision's text changed after this suggestion was made. Discard it and ask again before applying anything.
                </Notice>
              )
            }
            const changes = sugg.claim ? buildChanges([{ key: 'claim', label: 'Recorded text', kind: 'replace', current: current.claim, proposed: sugg.claim }]) : []
            const notes = [
              ...sugg.notes,
              ...(sugg.action === 'rephrase' ? [
                'Applying creates a new proposal that supersedes this decision. This decision and its approval are not changed.',
                ...(evidenceForProposal(current).length ? [] : ['This decision has no cited file evidence, so a rewritten proposal cannot be saved until evidence is added.']),
              ] : []),
            ]
            return (
              <SuggestionPanel key={`${current.id}:${sugg.action}:${sugg.claimSha256}`} testId="decision-suggestion"
                heading={ASSIST_HEADING[sugg.action] ?? 'Suggestion'} changes={changes} notes={notes}
                onApply={picks => applyRewrite(current, sugg, picks)}
                onDiscard={() => setSuggestions(s => { const n = { ...s }; delete n[current.id]; return n })} />
            )
          })()}
        </section>

        {confirm && (
          <section className="space-y-2 rounded-md border bg-background p-3" data-testid="attest-confirm">
            <p className="text-xs font-medium">{confirm === 'approved' ? `Attest ${current.id} locally` : `Revoke the local attestation of ${current.id}`}</p>
            <p className="text-[11px] text-muted-foreground">
              {confirm === 'approved'
                ? <>This records one entry in this installation's approval ledger for the exact text shown above (sha256 {current.claim_sha256.slice(0, 12)}…). It is stored outside the repository and is not proof of who clicked. Editing the text later lapses it. It does not change the decision file, and it does not resolve any conflict.</>
                : <>This records a revocation in the local ledger for the exact text shown above. The decision file is not changed.</>}
            </p>
            <label className="block text-[11px] text-muted-foreground">
              What was decided (required, stored with the attestation)
              <textarea value={quote} onChange={e => setQuote(e.target.value)} rows={2} data-testid="attest-quote"
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && quote.trim().length >= 3 && canWrite && !sending) send(confirm) }}
                className="mt-1 w-full resize-y rounded border bg-background p-1.5 text-xs" placeholder="e.g. Confirmed in review on 18 Nov; the owner accepts this value" />
            </label>
            {error && <p className="text-[11px] text-destructive" role="alert">{error}</p>}
            <div className="flex flex-wrap items-center gap-1.5">
              <button onClick={() => send(confirm)} disabled={quote.trim().length < 3 || !canWrite || sending} data-testid="attest-submit" className={cn(btn, confirm === 'approved' && 'border-success/60 text-success')}>
                {sending ? 'Recording…' : confirm === 'approved' ? 'Attest locally' : 'Revoke'}
              </button>
              <button onClick={() => { setConfirm(null); setError(null) }} className="ml-auto text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>
            </div>
          </section>
        )}
      </article>

      <div className="flex flex-wrap items-center gap-1.5" data-testid="review-actions">
        <button onClick={() => go(-1)} disabled={index === 0} className={cn(btn, 'flex items-center gap-1')} data-testid="review-prev"><ChevronLeft className="h-3 w-3" />Previous</button>
        <button onClick={() => go(1)} disabled={index >= queue.length - 1} className={cn(btn, 'flex items-center gap-1')} data-testid="review-next">Next<ChevronRight className="h-3 w-3" /></button>
        <span className="mx-1 h-4 w-px bg-border" />
        {!attested && <button onClick={skip} className={cn(btn, 'flex items-center gap-1')} data-testid="review-skip"><SkipForward className="h-3 w-3" />Skip for now</button>}
        {!attested && <button onClick={() => setConfirm('approved')} disabled={!canWrite} className={cn(btn, 'flex items-center gap-1 border-success/50 text-success')} data-testid="review-attest"><Check className="h-3 w-3" />Attest</button>}
        {attested && <button onClick={() => setConfirm('revoked')} disabled={!canWrite} className={cn(btn, 'flex items-center gap-1')} data-testid="review-revoke"><Undo2 className="h-3 w-3" />Revoke attestation</button>}
        <button onClick={() => copyText(briefing, 'Context')} className={cn(btn, 'flex items-center gap-1')} data-testid="review-request-changes"><Scale className="h-3 w-3" />Ask for changes (copy context)</button>
        <span className="ml-auto text-[10px] text-muted-foreground">Keys: ← → move · S skip · A attest</span>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Asking for changes copies the context for a task or agent. Nothing is created or sent; no lifecycle is changed. A decision that is not attested stays pending.
      </p>
    </div>
  )
}

function Notice({ tone, children, action }: { tone: 'warning'; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[11px]', tone === 'warning' && 'border-warning/50 bg-warning/10')} role="status">
      <span className="flex-1">{children}</span>
      {action}
    </div>
  )
}
