import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Search, Sparkles, RefreshCw, GitBranch, AlertTriangle, CheckCircle2, Pencil, Wand2, BookUp } from 'lucide-react'
import { api, type SystemView, type SystemSummary } from '@/lib/api'
import { cn } from '@/lib/utils'
import { extensionOf } from '@/lib/explorerView'
import { useEditorTabsContext } from '@/hooks/useEditorTabsContext'
import { EXPLORER_EDITOR_EVENT } from './ProjectExplorer'
import { StatusPill, baseName, type AskAgent, type SystemActions } from './system/parts'
import { OverviewTab, ImplementationTab, EvidenceTab } from './system/Tabs'
import { SystemMap } from './system/SystemMap'
import { RulesTab } from './system/RulesTab'
import { KnowledgePanel } from './system/KnowledgePanel'

/**
 * Systems: Project → Systems → one system → design, implementation, evidence, work.
 * Everything here is derived on demand by the server (git, Graphify, DK, tasks); the only stored data is
 * the semantic identity and the person's classification. See server/src/services/systemCatalog.ts.
 */

const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean)
const words = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean)

const ORIGIN_LABEL = { discovery: 'found by discovery', agent: 'proposed by an agent', user: 'created by you' } as const

export function SystemsExplorer({ projectId, onOpenInGraph }: { projectId: string; onOpenInGraph: (file: string) => void }) {
  const qc = useQueryClient()
  const editor = useEditorTabsContext()
  const key = `shipyard:systems-selected:${projectId}`
  const [selected, setSelected] = useState<string | null>(() => { try { return localStorage.getItem(key) } catch { return null } })
  const [query, setQuery] = useState('')
  const [worktree, setWorktree] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [busy, setBusy] = useState(false)

  const [view, setView] = useState<'systems' | 'knowledge'>('systems')
  const pick = (id: string) => { setView('systems'); setSelected(id); setReviewing(false); try { localStorage.setItem(key, id) } catch { /* ignore */ } }

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

  const ask = async (agent: AskAgent, sys: SystemView, areaId?: string, extra?: string) => {
    const goal = extra ?? (agent === 'design'
      ? 'Propose a design change for this system as a written proposal: what to change, why, which decisions/files are affected, what is still unknown. Do not edit code, do not record approvals, do not pick a side in an unresolved conflict.'
      : 'Explain how this system works today in the examined checkout, what is confirmed and what is not, and where design and implementation diverge. Read the real code before answering. Do not change anything until I ask.')
    try {
      const b = await api.getSystemBrief(projectId, sys.id, worktree || undefined, goal, areaId)
      window.dispatchEvent(new CustomEvent('shipyard:open-terminal', {
        detail: { projectId, type: 'claude', prompt: b.text, ...(agent === 'codex' ? { agent: 'codex' } : {}) },
      }))
      toast.success(`Sent ${sys.name}${areaId ? ` / ${areaId}` : ''} to ${agent === 'codex' ? 'Codex' : 'Claude'} (${b.head ?? 'no HEAD'})`)
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
          <button onClick={() => setView(view === 'knowledge' ? 'systems' : 'knowledge')} data-testid="systems-knowledge"
            title="Publish the knowledge to the repository, or recover it from there"
            className={cn('flex w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent', view === 'knowledge' && 'bg-accent')}>
            <BookUp className="h-3 w-3" /> Knowledge / Publish
          </button>
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
        {view === 'knowledge' ? (
          <KnowledgePanel projectId={projectId} worktree={worktree} onChanged={refresh} onOpenSystem={pick} />
        ) : !v ? (
          <p className="p-6 text-xs text-muted-foreground">{detailQ.error ? (detailQ.error as Error).message : current ? 'Loading…' : 'Select a system.'}</p>
        ) : (
          <SystemDetail
            v={v} projectId={projectId} reviewing={reviewing} setReviewing={setReviewing} allSystems={systems}
            onOpen={openFile} onGraph={onOpenInGraph} onAsk={(a, area, goal) => ask(a, v, area, goal)} onChanged={refresh}
            onPick={pick} refreshing={detailQ.isFetching}
          />
        )}
      </div>
    </div>
  )
}

const TABS = [['overview', 'Overview'], ['map', 'Map'], ['rules', 'Rules & decisions'], ['implementation', 'Implementation'], ['evidence', 'Evidence']] as const

function SystemDetail({ v, projectId, reviewing, setReviewing, allSystems, onOpen, onGraph, onAsk, onChanged, onPick, refreshing }: {
  v: SystemView; projectId: string; reviewing: boolean; setReviewing: (b: boolean) => void; allSystems: SystemSummary[]
  onOpen: (file: string, line?: number) => void; onGraph: (file: string) => void
  onAsk: (a: AskAgent, area?: string, goal?: string) => void; onChanged: () => void; onPick: (id: string) => void; refreshing: boolean
}) {
  const tabKey = `shipyard:system-tab:${projectId}`
  const [tab, setTabState] = useState<string>(() => { try { return localStorage.getItem(tabKey) || 'overview' } catch { return 'overview' } })
  const setTab = (t: string) => { setTabState(t); try { localStorage.setItem(tabKey, t) } catch { /* ignore */ } }
  const [area, setArea] = useState<string | null>(null)
  useEffect(() => { setArea(null) }, [v.id])
  const actions: SystemActions = { onOpen, onGraph, onAsk, onPickSystem: onPick }
  const c = v.checkout
  const m = v.maintenance
  const stale = m.needsReanalysis || m.vanished.length > 0 || m.unresolvedAnchors.length > 0
  const conflicts = v.comparisons.length
  return (
    <div className="mx-auto max-w-4xl space-y-3 p-4">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold" data-testid="system-name">{v.name}</h2>
          <span className="rounded bg-accent px-1.5 py-0.5 text-[10px]" data-testid="system-kind">{v.kind}</span>
          <StatusPill status={v.status} />
          <span className="text-[11px] text-muted-foreground">{ORIGIN_LABEL[v.origin]}</span>
          {refreshing && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        {v.summary
          ? <p className="text-sm" data-testid="system-summary">{v.summary}</p>
          : <p className="text-sm text-muted-foreground">No responsibility written yet. Ask an agent to describe it, or review it yourself.</p>}
        {v.status !== 'confirmed' && <p className="text-[11px] text-warning">Not confirmed: the grouping and the text above are a proposal, not a decision of the project.</p>}
        <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2 py-1.5 text-[11px]', c.isCanonical ? 'bg-card/40' : 'border-warning/50 bg-warning/10')} data-testid="system-checkout">
          <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" />{c.branch ?? '?'} <code className="font-mono">{c.head ?? ''}</code></span>
          <span>{c.isCanonical ? 'project checkout' : 'worktree'}</span>
          <span>{c.uncommitted ? `${c.uncommitted} uncommitted` : 'clean'}</span>
          <span className="text-muted-foreground">{c.integration}</span>
          <span className={cn('ml-auto', stale ? 'text-warning' : 'text-muted-foreground')} data-testid="analysis-state">
            {!m.graph.built ? 'code graph: not analyzed' : stale ? 'analysis out of date' : 'analysis current'}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => onAsk('claude')} data-testid="system-ask-claude" className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent"><Sparkles className="h-3 w-3" /> Ask Claude</button>
          <button onClick={() => onAsk('codex')} data-testid="system-ask-codex" className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent"><Sparkles className="h-3 w-3" /> Ask Codex</button>
          <button onClick={() => onAsk('design')} className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent"><Pencil className="h-3 w-3" /> Propose a design change</button>
          <button onClick={() => setReviewing(!reviewing)} data-testid="system-review" className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent"><CheckCircle2 className="h-3 w-3" /> Review classification</button>
        </div>
      </header>

      {reviewing && <ReviewPanel v={v} projectId={projectId} allSystems={allSystems} onChanged={() => { onChanged(); setReviewing(false) }} onPick={onPick} />}

      <nav className="flex gap-1 border-b" role="tablist" data-testid="system-tabs">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} data-testid={`tab-${id}`}
            className={cn('-mb-px border-b-2 px-2.5 py-1.5 text-xs', tab === id ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
            {id === 'rules' && conflicts > 0 && <span className="ml-1 rounded bg-destructive/15 px-1 text-[10px] text-destructive">{conflicts}</span>}
            {id === 'evidence' && stale && <AlertTriangle className="ml-1 inline h-3 w-3 text-warning" />}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <OverviewTab v={v} actions={actions} goTab={setTab} selectArea={setArea} />}
      {tab === 'map' && <SystemMap v={v} actions={actions} selectedArea={area} onSelectArea={setArea} />}
      {tab === 'rules' && <RulesTab v={v} actions={actions} projectId={projectId} />}
      {tab === 'implementation' && <ImplementationTab v={v} actions={actions} area={area} setArea={setArea} />}
      {tab === 'evidence' && <EvidenceTab v={v} actions={actions} projectId={projectId} onChanged={onChanged} onPick={onPick} />}
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
      {(v.areas.some(a => !a.inferred) || v.relations.some(r => r.direction !== 'incoming') || v.suggestions.length > 0) && (
        <div className="space-y-1 border-t pt-2 text-[11px]" data-testid="review-items">
          <p className="text-muted-foreground">Responsibilities and gameplay relations proposed here. Confirming says <b>you</b> accept the item; its evidence is still re-checked against the code every time.</p>
          {v.areas.filter(a => !a.inferred).map(a => (
            <div key={a.id} className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{a.name}</span><span className="text-muted-foreground">{a.kind} · {a.status}</span>
              {a.status !== 'confirmed' && <button className="rounded-md border px-1.5 hover:bg-accent" onClick={() => run(() => api.editSystem(projectId, v.id, { confirm: { areas: [a.id] } }), 'Area confirmed')}>Confirm</button>}
              <button className="rounded-md border px-1.5 hover:bg-accent" onClick={() => run(() => api.editSystem(projectId, v.id, { remove: { areas: [a.id] } }), 'Area removed')}>Remove</button>
            </div>
          ))}
          {v.relations.filter(r => r.direction !== 'incoming').map(r => (
            <div key={r.id} className="flex flex-wrap items-center gap-1.5">
              <span>{r.from.label} {r.label} {r.to.label}</span><span className="text-muted-foreground">{r.status} · {r.basis}</span>
              {r.status !== 'confirmed' && <button className="rounded-md border px-1.5 hover:bg-accent" onClick={() => run(() => api.editSystem(projectId, v.id, { confirm: { relations: [r.id] } }), 'Relation confirmed')}>Confirm</button>}
              <button className="rounded-md border px-1.5 hover:bg-accent" onClick={() => run(() => api.editSystem(projectId, v.id, { remove: { relations: [r.id] } }), 'Relation removed')}>Remove</button>
            </div>
          ))}
          {v.suggestions.map((sg, i) => (
            <div key={sg.at} className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">Pending suggestion ({sg.origin}, {sg.at.slice(0, 10)}): {sg.summary ?? ''}{sg.areas?.length ? ` · ${sg.areas.length} areas` : ''}{sg.relations?.length ? ` · ${sg.relations.length} relations` : ''}</span>
              <button className="rounded-md border px-1.5 hover:bg-accent" onClick={() => run(() => api.editSystem(projectId, v.id, { adoptSuggestion: i }), 'Suggestion adopted as proposed')}>Adopt as proposal</button>
            </div>
          ))}
        </div>
      )}
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
