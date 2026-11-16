import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Search, Sparkles, Code2, Network, RefreshCw, GitBranch, AlertTriangle, CheckCircle2, CircleDashed, Pencil, Wand2, ChevronRight,
} from 'lucide-react'
import { api, type SystemView, type SystemMember, type SystemDecision, type SystemSummary } from '@/lib/api'
import { cn } from '@/lib/utils'
import { extensionOf } from '@/lib/explorerView'
import { useEditorTabsContext } from '@/hooks/useEditorTabsContext'
import { EXPLORER_EDITOR_EVENT } from './ProjectExplorer'

/**
 * Systems: Project → Systems → one system → design, implementation, evidence, work.
 * Everything here is derived on demand by the server (git, Graphify, DK, tasks); the only stored data is
 * the semantic identity and the person's classification. See server/src/services/systemCatalog.ts.
 */

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean)
const words = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean)

const STATUS_LABEL = { proposed: 'proposed', confirmed: 'confirmed', dismissed: 'dismissed', merged: 'merged' } as const
const ORIGIN_LABEL = { discovery: 'found by discovery', agent: 'proposed by an agent', user: 'created by you' } as const

function StatusPill({ status }: { status: keyof typeof STATUS_LABEL }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
      status === 'confirmed' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning')}>
      {status === 'confirmed' ? <CheckCircle2 className="h-2.5 w-2.5" /> : <CircleDashed className="h-2.5 w-2.5" />}
      {STATUS_LABEL[status]}
    </span>
  )
}

function Section({ title, count, children, testId }: { title: string; count?: number; children: React.ReactNode; testId?: string }) {
  return (
    <section className="space-y-1.5" data-testid={testId}>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}{count !== undefined && <span className="ml-1.5 tabular-nums opacity-60">{count}</span>}
      </h3>
      {children}
    </section>
  )
}

export function SystemsExplorer({ projectId, onOpenInGraph }: { projectId: string; onOpenInGraph: (file: string) => void }) {
  const qc = useQueryClient()
  const editor = useEditorTabsContext()
  const key = `shipyard:systems-selected:${projectId}`
  const [selected, setSelected] = useState<string | null>(() => { try { return localStorage.getItem(key) } catch { return null } })
  const [query, setQuery] = useState('')
  const [worktree, setWorktree] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [busy, setBusy] = useState(false)

  const pick = (id: string) => { setSelected(id); setReviewing(false); try { localStorage.setItem(key, id) } catch { /* ignore */ } }

  const checkoutsQ = useQuery({ queryKey: ['design-checkouts', projectId], queryFn: () => api.getDesignCheckouts(projectId), staleTime: 30_000 })
  // The catalog is derived on demand: a poll while the tab is open is the whole "maintenance".
  const catalogQ = useQuery({
    queryKey: ['systems', projectId, worktree], queryFn: () => api.getSystems(projectId, worktree || undefined),
    refetchInterval: 10_000, placeholderData: p => p,
  })
  const systems = catalogQ.data?.systems ?? []
  const current = selected && systems.some(s => s.id === selected) ? selected : (systems[0]?.id ?? null)
  const detailQ = useQuery({
    queryKey: ['system', projectId, current, worktree], queryFn: () => api.getSystem(projectId, current!, worktree || undefined),
    enabled: !!current, refetchInterval: 10_000, retry: false, placeholderData: p => p,
  })
  const v = detailQ.data && detailQ.data.id === current ? detailQ.data : undefined

  const refresh = () => { qc.invalidateQueries({ queryKey: ['systems', projectId] }); qc.invalidateQueries({ queryKey: ['system', projectId] }) }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? systems.filter(s => `${s.name} ${s.summary} ${s.id}`.toLowerCase().includes(q)) : systems
  }, [systems, query])

  const openFile = useCallback((file: string, line?: number) => {
    editor.openFile(file, baseName(file), extensionOf(file), '', line ? { reveal: { line, column: 0, length: 0 } } : undefined)
    window.dispatchEvent(new CustomEvent(EXPLORER_EDITOR_EVENT, { detail: { open: true } }))
  }, [editor])

  const ask = async (agent: 'claude' | 'codex' | 'design', sys: SystemView) => {
    const goal = agent === 'design'
      ? 'Propose a design change for this system as a written proposal: what to change, why, which decisions/files are affected, what is still unknown. Do not edit code, do not record approvals, do not pick a side in an unresolved conflict.'
      : 'Explain how this system works today in the examined checkout, what is confirmed and what is not, and where design and implementation diverge. Read the real code before answering. Do not change anything until I ask.'
    try {
      const b = await api.getSystemBrief(projectId, sys.id, worktree || undefined, goal)
      window.dispatchEvent(new CustomEvent('shipyard:open-terminal', {
        detail: { projectId, type: 'claude', prompt: b.text, ...(agent === 'codex' ? { agent: 'codex' } : {}) },
      }))
      toast.success(`Sent ${sys.name} to ${agent === 'codex' ? 'Codex' : 'Claude'} (${b.head ?? 'no HEAD'})`)
    } catch (e: any) { toast.error(e.message || 'Could not build the brief') }
  }

  const discover = async () => {
    setBusy(true)
    try {
      const r = await api.discoverSystems(projectId, worktree || undefined)
      toast.success(r.added ? `${r.added} new candidate system${r.added > 1 ? 's' : ''}` : 'No new candidates')
      refresh()
    } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }

  const askAgentToDescribe = () => {
    const open = systems.filter(s => s.status === 'proposed')
    const prompt = [
      `Describe and refine the candidate systems of this project (${projectId}).`,
      'The candidates were grouped only by shared words in file names. For each one you can verify, call the MCP tool propose_system with a one or two sentence summary of what the system is responsible for, its responsibilities, the terms/files that belong to it and any DK decision ids. Use get_system, get_design_context and the real code to check.',
      'Rules: you may only PROPOSE. Do not invent design rules or approvals, do not resolve conflicts between decisions, do not mark anything confirmed (only the user can, in the UI). Say what you could not verify.',
      '', 'Candidates:', ...open.slice(0, 40).map(s => `- ${s.id}: ${s.name} — ${s.files} files`),
    ].join('\n')
    window.dispatchEvent(new CustomEvent('shipyard:open-terminal', { detail: { projectId, type: 'claude', prompt } }))
    toast.success('Sent the candidates to Claude')
  }

  const checkouts = checkoutsQ.data?.checkouts ?? []

  return (
    <div className="flex h-full min-h-0 w-full" data-testid="systems-explorer">
      <aside className="flex w-[270px] shrink-0 flex-col border-r bg-card/40">
        <div className="space-y-2 border-b p-2">
          <div className="flex items-center gap-1.5 rounded-md border bg-background px-2">
            <Search className="h-3 w-3 text-muted-foreground" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search systems" data-testid="systems-search"
              className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none" />
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={discover} disabled={busy} className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50" data-testid="systems-discover">
              <Wand2 className="h-3 w-3" /> Find systems
            </button>
            <button onClick={askAgentToDescribe} disabled={!systems.some(s => s.status === 'proposed')} title="Ask Claude to describe and refine the candidates (it can only propose)"
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40">
              <Sparkles className="h-3 w-3" /> Ask agent
            </button>
          </div>
          {checkouts.length > 1 && (
            <select value={worktree} onChange={e => setWorktree(e.target.value)} data-testid="systems-checkout"
              className="h-7 w-full rounded-md border bg-background px-1.5 text-[11px]">
              <option value="">Integrated checkout</option>
              {checkouts.slice(1).map(c => <option key={c.path} value={c.path}>worktree · {c.branch ?? baseName(c.path)}</option>)}
            </select>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-dark" data-testid="systems-list">
          {catalogQ.isLoading && <p className="p-3 text-xs text-muted-foreground">Loading…</p>}
          {!catalogQ.isLoading && !systems.length && (
            <p className="p-3 text-xs text-muted-foreground">No systems yet. “Find systems” proposes candidates from file names; nothing is confirmed until you do it.</p>
          )}
          {filtered.map((s: SystemSummary) => (
            <button key={s.id} onClick={() => pick(s.id)} data-testid="system-row"
              className={cn('w-full border-b border-border/40 px-2.5 py-2 text-left hover:bg-accent/60', current === s.id && 'bg-accent')}>
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium">{s.name}</span>
                <StatusPill status={s.status} />
              </div>
              {s.summary && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{s.summary}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="tabular-nums">{s.files} files</span>
                {s.decisions > 0 && <span className="tabular-nums">{s.decisions} decisions</span>}
                {s.flags.map(f => <span key={f} className="rounded bg-warning/15 px-1 text-warning">{f}</span>)}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto scrollbar-dark" data-testid="system-detail">
        {!v ? (
          <p className="p-6 text-xs text-muted-foreground">{detailQ.error ? (detailQ.error as Error).message : current ? 'Loading…' : 'Select a system.'}</p>
        ) : (
          <SystemDetail
            v={v} projectId={projectId} reviewing={reviewing} setReviewing={setReviewing} allSystems={systems}
            onOpen={openFile} onGraph={onOpenInGraph} onAsk={a => ask(a, v)} onChanged={refresh}
            onPick={pick} refreshing={detailQ.isFetching}
          />
        )}
      </div>
    </div>
  )
}

function SystemDetail({ v, projectId, reviewing, setReviewing, allSystems, onOpen, onGraph, onAsk, onChanged, onPick, refreshing }: {
  v: SystemView; projectId: string; reviewing: boolean; setReviewing: (b: boolean) => void; allSystems: SystemSummary[]
  onOpen: (file: string, line?: number) => void; onGraph: (file: string) => void
  onAsk: (a: 'claude' | 'codex' | 'design') => void; onChanged: () => void; onPick: (id: string) => void; refreshing: boolean
}) {
  const c = v.checkout
  const groups = (['code', 'scene', 'resource', 'test'] as const).map(r => [r, v.members.filter(m => m.role === r)] as const).filter(([, m]) => m.length)
  const m = v.maintenance
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold" data-testid="system-name">{v.name}</h2>
          <StatusPill status={v.status} />
          <span className="text-[11px] text-muted-foreground">{ORIGIN_LABEL[v.origin]}</span>
          {refreshing && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        {v.summary
          ? <p className="text-sm">{v.summary}</p>
          : <p className="text-sm text-muted-foreground">No responsibility written yet. Ask an agent to describe it, or review it yourself.</p>}
        {v.responsibilities.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">{v.responsibilities.map(r => <li key={r}>{r}</li>)}</ul>}
        {v.status !== 'confirmed' && (
          <p className="text-[11px] text-warning">Not confirmed: the grouping and the text above are a proposal, not a decision of the project.</p>
        )}
        <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2 py-1.5 text-[11px]', c.isCanonical ? 'bg-card/40' : 'border-warning/50 bg-warning/10')} data-testid="system-checkout">
          <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" />{c.branch ?? '?'} <code className="font-mono">{c.head ?? ''}</code></span>
          <span>{c.isCanonical ? 'integrated checkout' : 'worktree (not integrated code)'}</span>
          <span>{c.uncommitted ? `${c.uncommitted} uncommitted` : 'clean'}</span>
          <span className="text-muted-foreground">{c.integration}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => onAsk('claude')} data-testid="system-ask-claude" className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent"><Sparkles className="h-3 w-3" /> Ask Claude</button>
          <button onClick={() => onAsk('codex')} data-testid="system-ask-codex" className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent"><Sparkles className="h-3 w-3" /> Ask Codex</button>
          <button onClick={() => onAsk('design')} className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent"><Pencil className="h-3 w-3" /> Propose a design change</button>
          <button onClick={() => setReviewing(!reviewing)} data-testid="system-review" className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent"><CheckCircle2 className="h-3 w-3" /> Review classification</button>
        </div>
      </header>

      {reviewing && <ReviewPanel v={v} projectId={projectId} allSystems={allSystems} onChanged={() => { onChanged(); setReviewing(false) }} onPick={onPick} />}

      {(v.limitations.length > 0 || m.vanished.length > 0 || m.unresolvedAnchors.length > 0) && (
        <Section title="Maintenance and limits" testId="system-maintenance">
          <ul className="space-y-1 text-[11px] text-muted-foreground">
            {m.needsReanalysis && (
              <li className="flex gap-1.5 text-warning"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                Changed after the last Graphify analysis: {m.changedMembers.map(baseName).join(', ')}. Re-analyze in Files to refresh symbols and relations.</li>
            )}
            {m.vanished.length > 0 && (
              <li className="flex gap-1.5 text-warning" data-testid="system-vanished"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>Disappeared since earlier: {m.vanished.slice(0, 6).map(x => x.key.replace(/^(file|sym):/, '')).join('; ')}{m.vanished.length > 6 ? ` +${m.vanished.length - 6}` : ''}.{' '}
                  <button className="underline" onClick={async () => { await api.editSystem(projectId, v.id, { ackVanished: true }); onChanged() }}>Acknowledge</button></span>
              </li>
            )}
            {m.unresolvedAnchors.map(a => <li key={a.path} className="flex gap-1.5 text-warning"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />Anchored file no longer exists: <code>{a.path}</code></li>)}
            {v.limitations.map(l => <li key={l}>• {l}</li>)}
          </ul>
        </Section>
      )}

      <Section title="Design decisions" count={v.design.decisions.length} testId="system-decisions">
        {!v.design.available && <p className="text-[11px] text-muted-foreground">Not indexed for this project{v.design.reason ? `: ${v.design.reason}` : ''}.</p>}
        {v.design.available && !v.design.decisions.length && <p className="text-[11px] text-muted-foreground">No decisions found for this system.</p>}
        {v.design.conflicts.map(([a, b]) => (
          <p key={a + b} className="flex items-center gap-1.5 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1 text-[11px] text-destructive" data-testid="system-conflict">
            <AlertTriangle className="h-3 w-3" /> Unresolved conflict: {a} vs {b}. Nobody has decided; do not pick a side.
          </p>
        ))}
        {v.design.decisions.map(d => <DecisionCard key={d.id} d={d} onOpen={onOpen} />)}
      </Section>

      <Section title="Implementation" count={v.members.length + v.weakerMembers} testId="system-members">
        {groups.map(([role, ms]) => (
          <div key={role} className="space-y-0.5">
            <p className="text-[10px] uppercase text-muted-foreground">{role === 'code' ? 'Scripts' : role === 'scene' ? 'Scenes' : role === 'resource' ? 'Resources' : 'Tests'} · {ms.length}</p>
            {ms.map(mm => <MemberRow key={mm.path} m={mm} onOpen={onOpen} onGraph={onGraph} />)}
          </div>
        ))}
        {v.weakerMembers > 0 && <p className="text-[11px] text-muted-foreground">+ {v.weakerMembers} weaker references not listed.</p>}
      </Section>

      {v.neighbors.length > 0 && (
        <Section title="Possible participants (Graphify neighbours, not members)" count={v.neighbors.length}>
          <div className="space-y-0.5">
            {v.neighbors.map(n => (
              <div key={n.path} className="flex items-center gap-2 text-[11px]">
                <button onClick={() => onOpen(n.path)} className="truncate font-mono hover:underline">{n.path}</button>
                <span className={cn('shrink-0 rounded px-1 text-[10px]', n.confidence === 'EXTRACTED' ? 'bg-accent' : 'border border-dashed text-muted-foreground')}>
                  {n.confidence === 'EXTRACTED' ? 'extracted' : 'inferred'} · {n.relation} ×{n.edges}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {v.related.length > 0 && (
        <Section title="Related systems" count={v.related.length}>
          <div className="flex flex-wrap gap-1.5">
            {v.related.map(r => (
              <button key={r.id} onClick={() => onPick(r.id)} title={r.shared.join('\n')} className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent">
                {r.name}<span className="text-muted-foreground">{r.shared.length ? `${r.shared.length} shared` : 'declared'}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title="Related tasks" count={v.tasks.length}>
        {!v.tasks.length && <p className="text-[11px] text-muted-foreground">No task names a member file of this system.</p>}
        {v.tasks.map(t => <p key={t.id} className="text-[11px]"><span className="text-muted-foreground">{t.number ? `#${t.number}` : ''} {t.status}</span> {t.title} <span className="text-muted-foreground">· {t.matchedBy}</span></p>)}
      </Section>

      {v.suggestions.length > 0 && (
        <Section title="Pending suggestions (not applied)" count={v.suggestions.length}>
          {v.suggestions.map(s => <p key={s.at} className="text-[11px] text-muted-foreground">{s.origin} · {s.at.slice(0, 10)}: {s.summary ?? ''} {[...s.anchors.terms, ...s.anchors.files].join(', ')}</p>)}
          <p className="text-[11px] text-muted-foreground">Use “Review classification” to adopt them.</p>
        </Section>
      )}
    </div>
  )
}

function MemberRow({ m, onOpen, onGraph }: { m: SystemMember; onOpen: (f: string, l?: number) => void; onGraph: (f: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div data-testid="system-member" data-path={m.path}>
      <div className="group flex items-center gap-1.5 text-[11px]">
        {m.symbols.length > 0
          ? <button onClick={() => setOpen(!open)} aria-label="symbols"><ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} /></button>
          : <span className="w-3" />}
        <button onClick={() => onOpen(m.path)} className="truncate font-mono hover:underline" title="Open in the editor">{m.path}</button>
        <span className="shrink-0 text-[10px] text-muted-foreground" title={m.why.map(w => `${w.kind}: ${w.detail}`).join('\n')}>
          {m.confidence === 'declared' ? 'declared' : m.why[0]?.kind === 'name' ? 'by name' : 'by text'}
        </span>
        {m.state === 'moved' && <span className="shrink-0 rounded bg-warning/15 px-1 text-[10px] text-warning" title={`was ${m.movedFrom}`}>moved</span>}
        {m.uncommitted && <span className="shrink-0 rounded bg-warning/15 px-1 text-[10px] text-warning">uncommitted</span>}
        {m.changedSinceAnalysis && <span className="shrink-0 rounded bg-warning/15 px-1 text-[10px] text-warning" title="Changed after the last Graphify analysis">graph stale</span>}
        {m.role === 'code' && (
          <button onClick={() => onGraph(m.path)} title="Open in Graphify" aria-label="Open in Graphify" data-testid="member-graph"
            className="ml-auto shrink-0 opacity-0 group-hover:opacity-100"><Network className="h-3 w-3" /></button>
        )}
        <button onClick={() => onOpen(m.path)} title="Open in editor" aria-label="Open in editor" className={cn('shrink-0 opacity-0 group-hover:opacity-100', m.role !== 'code' && 'ml-auto')}><Code2 className="h-3 w-3" /></button>
      </div>
      {open && (
        <div className="ml-5 space-y-0.5 pb-1">
          {m.symbols.map(s => (
            <button key={s.id} onClick={() => onOpen(m.path, s.line || undefined)} className="block truncate font-mono text-[10px] text-muted-foreground hover:text-foreground">
              {s.label.replace(/\(\)$/, '')}{s.line ? ` :${s.line}` : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const EV_LABEL: Record<string, string> = { code: 'Implemented in code', document_claim: 'Declared in a document', test: 'Test expectation' }

function DecisionCard({ d, onOpen }: { d: SystemDecision; onOpen: (f: string, l?: number) => void }) {
  const approval = d.approval?.state ?? 'unknown'
  return (
    <div className="space-y-1.5 rounded-md border p-2" data-testid="system-decision" data-id={d.id}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] font-medium">{d.id}</span>
        <span className="text-xs">{d.title}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">{d.claim}</p>
      <div className="flex flex-wrap gap-1.5 text-[10px]">
        <span className="rounded bg-accent px-1.5 py-0.5">human approval: {approval === 'unknown' ? 'not located' : `${approval} (${d.approval?.source})`}</span>
        <span className="rounded bg-accent px-1.5 py-0.5">evidence: {d.evidenceStatus}</span>
        <span className="rounded bg-accent px-1.5 py-0.5">implementation: {d.implementation}</span>
        {d.relevance === 'touches-member' && <span className="rounded border border-dashed px-1.5 py-0.5 text-muted-foreground">touches a member file only</span>}
      </div>
      <div className="space-y-1">
        {d.evidence.map(e => (
          <div key={e.ref} className="text-[11px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{EV_LABEL[e.type] ?? e.type}</span>
              <button onClick={() => { const [f, l] = e.ref.split('#L'); onOpen(f.replace(/ \(was.*$/, ''), l ? parseInt(l, 10) : undefined) }} className="truncate font-mono text-muted-foreground hover:underline">{e.ref}</button>
              {e.freshness && <span className="text-[10px] text-muted-foreground">{e.freshness}</span>}
            </div>
            {e.excerpt.slice(0, 2).map(x => <pre key={x} className="overflow-x-auto rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">{x}</pre>)}
          </div>
        ))}
        {d.tests.length > 0 && <p className="text-[10px] text-muted-foreground">Tests referenced (static; no result available): {d.tests.map(baseName).join(', ')}</p>}
      </div>
    </div>
  )
}

function ReviewPanel({ v, projectId, allSystems, onChanged, onPick }: {
  v: SystemView; projectId: string; allSystems: SystemSummary[]; onChanged: () => void; onPick: (id: string) => void
}) {
  const [name, setName] = useState(v.name)
  const [summary, setSummary] = useState(v.summary)
  const [resp, setResp] = useState(v.responsibilities.join('\n'))
  const [terms, setTerms] = useState(v.anchors.terms.join(', '))
  const [files, setFiles] = useState(v.anchors.files.join('\n'))
  const [mergeId, setMergeId] = useState('')
  const [splitName, setSplitName] = useState('')
  const [splitTerms, setSplitTerms] = useState('')
  useEffect(() => { setName(v.name); setSummary(v.summary); setResp(v.responsibilities.join('\n')); setTerms(v.anchors.terms.join(', ')); setFiles(v.anchors.files.join('\n')) }, [v.id]) // eslint-disable-line
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast.success(ok); onChanged() } catch (e: any) { toast.error(e.message) } }
  const save = (status?: 'confirmed' | 'dismissed') => run(() => api.editSystem(projectId, v.id, {
    name, summary, responsibilities: lines(resp), anchors: { terms: words(terms), files: lines(files) }, ...(status ? { status } : {}),
  }), status === 'confirmed' ? 'Confirmed (recorded as a local UI classification)' : status === 'dismissed' ? 'Dismissed' : 'Saved')
  const field = 'w-full rounded-md border bg-background px-2 py-1 text-xs outline-none'
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="system-review-panel">
      <p className="text-[11px] text-muted-foreground">Confirming records that <b>you</b> accept this grouping and text, from this installation. It does not approve any design decision.</p>
      <input className={field} value={name} onChange={e => setName(e.target.value)} aria-label="name" />
      <textarea className={field} rows={2} value={summary} onChange={e => setSummary(e.target.value)} placeholder="What is this system responsible for?" aria-label="summary" />
      <textarea className={field} rows={3} value={resp} onChange={e => setResp(e.target.value)} placeholder="Responsibilities, one per line" aria-label="responsibilities" />
      <input className={field} value={terms} onChange={e => setTerms(e.target.value)} placeholder="Terms that appear in file names or code (comma separated)" aria-label="terms" />
      <textarea className={field} rows={2} value={files} onChange={e => setFiles(e.target.value)} placeholder="Files that always belong, one per line" aria-label="files" />
      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => save('confirmed')} data-testid="system-confirm" className="rounded-md border bg-primary px-2 py-1 text-[11px] text-primary-foreground">Confirm</button>
        <button onClick={() => save()} className="rounded-md border px-2 py-1 text-[11px] hover:bg-accent">Save as proposal</button>
        <button onClick={() => save('dismissed')} className="rounded-md border px-2 py-1 text-[11px] hover:bg-accent">Dismiss</button>
        {v.suggestions.length > 0 && <button onClick={() => run(() => api.editSystem(projectId, v.id, { clearSuggestions: true }), 'Suggestions cleared')} className="rounded-md border px-2 py-1 text-[11px] hover:bg-accent">Clear suggestions</button>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t pt-2 text-[11px]">
        <span className="text-muted-foreground">Merge into this:</span>
        <select value={mergeId} onChange={e => setMergeId(e.target.value)} className="h-6 rounded-md border bg-background px-1">
          <option value="">choose…</option>
          {allSystems.filter(s => s.id !== v.id).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button disabled={!mergeId} onClick={() => run(() => api.mergeSystems(projectId, v.id, [mergeId]), 'Merged')} className="rounded-md border px-2 py-0.5 hover:bg-accent disabled:opacity-40">Merge</button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-muted-foreground">Split out:</span>
        <input className="h-6 w-32 rounded-md border bg-background px-1.5" placeholder="new name" value={splitName} onChange={e => setSplitName(e.target.value)} />
        <input className="h-6 w-40 rounded-md border bg-background px-1.5" placeholder="terms to move" value={splitTerms} onChange={e => setSplitTerms(e.target.value)} />
        <button disabled={!splitName.trim()} onClick={async () => { try { const r = await api.splitSystem(projectId, v.id, { name: splitName, terms: words(splitTerms) }); toast.success('Split'); onChanged(); onPick(r.id) } catch (e: any) { toast.error(e.message) } }}
          className="rounded-md border px-2 py-0.5 hover:bg-accent disabled:opacity-40">Split</button>
      </div>
    </div>
  )
}
