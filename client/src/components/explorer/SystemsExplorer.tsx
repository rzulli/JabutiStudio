import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Search, Sparkles, RefreshCw, GitBranch, AlertTriangle, Pencil, Wand2, BookUp, Database, MoreHorizontal, Merge, Scissors, EyeOff, Plus } from 'lucide-react'
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
import { CatalogSourceBanner, useCatalogSource } from './system/CatalogSourcePanel'
import { EditSystemDialog, type EditStep, type Focus } from './system/EditSystemDialog'
import { NewSystemDialog, type Mode } from './system/NewSystemDialog'
import { openAgentSession, systemBasisKind, systemTargetRules } from '@/lib/terminalDispatch'
import { MergeDialog, SplitDialog } from './system/StructureDialogs'
import { AskMenu } from './system/AskMenu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/**
 * Systems: Project → Systems → one system → design, implementation, evidence, work.
 * Everything here is derived on demand by the server (git, Graphify, DK, tasks); the only stored data is
 * the semantic identity and the person's classification. See server/src/services/systemCatalog.ts.
 */

const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean)
const words = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean)

/** How long a sent request may wait for its proposal before the sidebar stops waiting and says so. */
const AWAIT_PROPOSAL_MS = 10 * 60_000
const ORIGIN_LABEL ={ discovery: 'found by discovery', agent: 'proposed by an agent', user: 'created by you' } as const

export function SystemsExplorer({ projectId, onOpenInGraph }: { projectId: string; onOpenInGraph: (file: string) => void }) {
  const qc = useQueryClient()
  const editor = useEditorTabsContext()
  const key = `shipyard:systems-selected:${projectId}`
  const [selected, setSelected] = useState<string | null>(() => { try { return localStorage.getItem(key) } catch { return null } })
  const [query, setQuery] = useState('')
  const [worktree, setWorktree] = useState('')
  const [busy, setBusy] = useState(false)

  const [newOpen, setNewOpen] = useState(false)
  const [newMode, setNewMode] = useState<Mode>('manual')
  const openNew = (m: Mode = 'manual') => { setNewMode(m); setNewOpen(true) }
  /**
   * An agent session was opened with a request for a new system. "Session opened" is all that is known at that point;
   * the proposal exists only once an agent-origin system that was not in the list shows up. Until then the sidebar
   * says so, and the catalog is polled faster.
   */
  const [awaiting, setAwaiting] = useState<{ label: string; since: number; known: string[] } | null>(null)
  const [view, setView] = useState<'systems' | 'knowledge'>('systems')
  const pick = (id: string) => { setView('systems'); setSelected(id); try { localStorage.setItem(key, id) } catch { /* ignore */ } }

  const checkoutsQ = useQuery({ queryKey: ['design-checkouts', projectId], queryFn: () => api.getDesignCheckouts(projectId), staleTime: 30_000 })
  // The catalog is derived on demand: a poll while the tab is open is the whole "maintenance".
  const catalogQ = useQuery({
    queryKey: ['systems', projectId, worktree], queryFn: () => api.getSystems(projectId, worktree || undefined),
    refetchInterval: awaiting ? 3_000 : 10_000, placeholderData: p => p,
  })
  const systems = catalogQ.data?.systems ?? []
  // A proposal counts only when it is an agent system created after this request was sent. A system that was already
  // in the list, or one created by another session before, is not this request's answer.
  useEffect(() => {
    if (!awaiting) return
    const fresh = systems.find(s => s.origin === 'agent' && !awaiting.known.includes(s.id)
      && Date.parse(s.createdAt) >= awaiting.since - 5_000)
    if (fresh) { toast.success(`${awaiting.label} proposed “${fresh.name}”. Review it before confirming anything.`); setAwaiting(null); pick(fresh.id) }
  }, [systems, awaiting]) // eslint-disable-line react-hooks/exhaustive-deps
  // Honest end of the wait: an answer that extends an existing system, or none at all, never shows up as a new system.
  useEffect(() => {
    if (!awaiting) return
    const left = AWAIT_PROPOSAL_MS - (Date.now() - awaiting.since)
    const t = window.setTimeout(() => {
      toast.warning(`No new proposal from ${awaiting.label} yet. Check its session; an answer that extended an existing system is in that system's Overview.`)
      setAwaiting(null)
    }, Math.max(0, left))
    return () => window.clearTimeout(t)
  }, [awaiting])
  const current = selected && systems.some(s => s.id === selected) ? selected : (systems[0]?.id ?? null)
  const detailQ = useQuery({
    queryKey: ['system', projectId, current, worktree], queryFn: () => api.getSystem(projectId, current!, worktree || undefined),
    enabled: !!current, refetchInterval: 10_000, retry: false, placeholderData: p => p,
  })
  const v = detailQ.data && detailQ.data.id === current ? detailQ.data : undefined

  const sourceQ = useCatalogSource(projectId)
  const siblingHasSystems = !!sourceQ.data?.others.some(o => o.systems > 0 && o.relation !== 'identical')
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['systems', projectId] }), qc.invalidateQueries({ queryKey: ['system', projectId] }), qc.invalidateQueries({ queryKey: ['catalog-source', projectId] })])

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
    const label = agent === 'codex' ? 'Codex' : 'Claude'
    try {
      const b = await api.getSystemBrief(projectId, sys.id, worktree || undefined, `${goal}

${systemTargetRules({ id: sys.id, name: sys.name, origin: sys.origin, planned: sys.planned, files: sys.tierCounts?.core })}`, areaId)
      const r = await openAgentSession({ projectId, agent: agent === 'codex' ? 'codex' : 'claude', prompt: b.text })
      if (r.ok) toast.success(`${label} session opened with “${sys.name}${areaId ? ` / ${areaId}` : ''}” (${b.head ?? 'no HEAD'}). Its answer is in the terminal tab; nothing changes here until you act on it.`)
      else toast.error(`Could not open ${label}: ${r.error}`)
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

  const askAgentToDescribe = async () => {
    const open = systems.filter(s => s.status === 'proposed')
    const prompt = [
      `Describe and refine the candidate systems of this project (${projectId}).`,
      'Each entry below carries its exact id and its basis. For each one you can verify, call the MCP tool propose_system with operation "extend" (or "correct" to replace/remove wrong content) and systemId set to THAT entry exact id, with a one or two sentence summary, its responsibilities, the terms/files that belong to it and any DK decision ids. Never create a system to refine an existing one, never use the id of another entry, and never rely on shared terms or similar names to choose the target: similar is not the same. If propose_system answers not-found or confirmed, skip that entry and say so. Use get_system, get_design_context and the real code to check.',
      'Basis matters: "code-derived" entries were only grouped from file names, so verify them against the code; "design-first" entries were conceived before the implementation, so missing code is not evidence the design is wrong.',
      'Rules: you may only PROPOSE. Do not invent design rules or approvals, do not resolve conflicts between decisions, do not mark anything confirmed (only the user can, in the UI). Say what you could not verify.',
      '', 'Candidates:', ...open.slice(0, 40).map(s => `- id ${s.id} | ${s.name} | ${s.files} files | ${systemBasisKind({ id: s.id, name: s.name, origin: s.origin, planned: s.planned, files: s.files })}`),
    ].join('\n')
    const r = await openAgentSession({ projectId, agent: 'claude', prompt })
    if (r.ok) toast.success('Claude session opened with the candidates. Its refinements arrive as proposals on those systems; the terminal tab shows its progress.')
    else toast.error(`Could not open Claude: ${r.error}`)
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
          <button onClick={() => openNew()} data-testid="systems-new" className="flex w-full items-center justify-center gap-1 rounded-md bg-primary px-2 py-1.5 text-xs text-primary-foreground"><Plus className="h-3.5 w-3.5" /> New system</button>
          <div className="flex flex-wrap items-center gap-x-1 text-[11px] text-muted-foreground" data-testid="systems-proposals">
            <span className="w-full text-[10px] uppercase tracking-wide opacity-70">Get proposals</span>
            <button onClick={discover} disabled={busy} title="Group the project's files by shared words in their names. The result is a set of proposals you correct." className="flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-1 hover:bg-accent hover:text-foreground disabled:opacity-50" data-testid="systems-discover">
              <Wand2 className="h-3 w-3" /> From the code
            </button>
            <button onClick={askAgentToDescribe} disabled={!systems.some(s => s.status === 'proposed')} title="Ask Claude to describe and refine the proposed systems (it can only propose)"
              className="flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-1 hover:bg-accent hover:text-foreground disabled:opacity-40" data-testid="systems-ask-agent">
              <Sparkles className="h-3 w-3" /> Ask an agent
            </button>
          </div>
          {checkouts.length > 1 && (
            <select value={worktree} onChange={e => setWorktree(e.target.value)} data-testid="systems-checkout"
              className="h-7 w-full rounded-md border bg-background px-1.5 text-[11px]">
              <option value="">Project checkout</option>
              {checkouts.slice(1).map(c => <option key={c.path} value={c.path}>worktree · {c.branch ?? baseName(c.path)}</option>)}
            </select>
          )}
        </div>
        {awaiting && (
          <div className="border-b bg-accent/40 p-2 text-[11px]" role="status" data-testid="systems-awaiting">
            <p className="flex items-center gap-1.5 font-medium"><RefreshCw className="h-3 w-3 animate-spin" />{awaiting.label} session opened. Waiting for its proposal…</p>
            <p className="mt-0.5 text-muted-foreground">Nothing has been proposed yet. If {awaiting.label} asks for permission or trust, answer in its terminal tab.</p>
            <button onClick={() => setAwaiting(null)} className="mt-1 underline" data-testid="systems-awaiting-stop">Stop waiting</button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-dark" data-testid="systems-list">
          {catalogQ.isLoading && <p className="p-3 text-xs text-muted-foreground">Loading…</p>}
          {/* A failed read is an error, never "No systems yet": the catalog may be fine and simply not readable right now. */}
          {catalogQ.isError && (
            <div className="m-2 space-y-1 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px]" role="alert" data-testid="systems-error">
              <p className="font-medium text-destructive">{systems.length ? 'Could not refresh the systems' : 'Could not load the systems'}</p>
              <p className="break-words text-muted-foreground">{(catalogQ.error as Error)?.message}</p>
              <p className="text-muted-foreground">{systems.length ? 'Showing the last result that loaded. ' : 'Your catalog was not changed. '}This is not an empty catalog.</p>
              <button onClick={() => catalogQ.refetch()} className="underline" data-testid="systems-retry">Retry</button>
            </div>
          )}
          {!!catalogQ.data?.loadErrors?.length && (
            <div className="m-2 space-y-1 rounded-md border border-warning/50 bg-warning/10 p-2 text-[11px]" role="alert" data-testid="systems-load-errors">
              <p className="font-medium text-warning">{catalogQ.data.loadErrors.length} system(s) could not be read</p>
              {catalogQ.data.loadErrors.map(e => <p key={e.id} className="break-words text-muted-foreground"><b>{e.name}</b>: {e.error}</p>)}
            </div>
          )}
          <CatalogSourceBanner projectId={projectId} onChanged={refresh} />
          {!catalogQ.isLoading && !catalogQ.isError && !systems.length && !catalogQ.data?.loadErrors?.length && <p className="p-3 text-xs text-muted-foreground">No systems in this catalog yet.</p>}
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

      <NewSystemDialog projectId={projectId} allSystems={systems} open={newOpen} initialMode={newMode} onOpenChange={setNewOpen} onOpenFile={openFile}
        onCreated={async id => { await refresh(); pick(id) }}
        onSent={s => setAwaiting({ label: s.label, since: Date.now(), known: systems.map(x => x.id) })} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ContextBar checkout={catalogQ.data?.checkout ?? null} worktree={worktree} view={view} onView={setView} />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto scrollbar-dark" data-testid="system-detail">
        {view === 'knowledge' ? (
          <KnowledgePanel projectId={projectId} worktree={worktree} onChanged={refresh} onOpenSystem={pick} />
        ) : !v && !current && !catalogQ.isLoading && catalogQ.isError ? (
          <p className="p-6 text-xs text-muted-foreground">The systems could not be loaded, so nothing is shown here. See the message in the list.</p>
        ) : !v && !current && !catalogQ.isLoading && !catalogQ.data?.loadErrors?.length ? (
          siblingHasSystems ? (
          <p className="p-6 text-xs text-muted-foreground" data-testid="systems-empty-sibling">This catalog is empty, but another catalog for this project exists on this machine. Review it in the banner on the left before starting over.</p>
        ) : <EmptyDesign onManual={() => openNew('manual')} onAgent={() => openNew('agent')} onDiscover={discover} busy={busy} />
        ) : !v ? (
          <p className="p-6 text-xs text-muted-foreground">{detailQ.error ? (detailQ.error as Error).message : 'Loading…'}</p>
        ) : (
          <SystemDetail
            v={v} projectId={projectId} allSystems={systems}
            onOpen={openFile} onGraph={onOpenInGraph} onAsk={(a, area, goal) => ask(a, v, area, goal)} onChanged={refresh}
            onPick={pick} refreshing={detailQ.isFetching}
          />
        )}
      </div>
      </div>
    </div>
  )
}

/**
 * Which knowledge the person is looking at, always visible. The catalog (systems, classification) is this installation's
 * local store, identical for every checkout; the checkout only decides where code evidence is read and which committed
 * file is compared. "Versions" is where anything that touches the repository file lives; the list is for design work.
 */
function ContextBar({ checkout, worktree, view, onView }: { checkout: import('@/lib/api').SystemCheckout | null; worktree: string; view: 'systems' | 'knowledge'; onView: (v: 'systems' | 'knowledge') => void }) {
  const tab = (id: 'systems' | 'knowledge', label: string, icon: React.ReactNode, title: string) => (
    <button onClick={() => onView(id)} title={title} data-testid={`systems-tab-${id}`} aria-pressed={view === id}
      className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] hover:bg-accent hover:text-foreground', view === id ? 'bg-accent text-foreground' : 'text-muted-foreground')}>{icon}{label}</button>
  )
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-card/40 px-3 py-1.5 text-[11px]" data-testid="systems-context">
      <div className="flex gap-0.5">
        {tab('systems', 'Systems', <Database className="h-3 w-3" />, 'Explore and author the systems of the game')}
        {tab('knowledge', 'Versions', <BookUp className="h-3 w-3" />, 'Publish to the repository file, compare with what is committed, recover from it')}
      </div>
      {checkout ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground" data-testid="systems-context-checkout">
          <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" />
            <span className="font-medium text-foreground">{checkout.branch ?? '?'}</span>
            {checkout.unborn ? <span className="rounded bg-warning/15 px-1 text-warning" data-testid="systems-context-unborn">no commits yet</span> : checkout.head && <code className="font-mono">{checkout.head}</code>}
          </span>
          <span>{worktree ? 'worktree' : 'project checkout'}{checkout.uncommitted ? ` · ${checkout.uncommitted} uncommitted` : ''}</span>
        </span>
      ) : <span className="text-muted-foreground">checkout unavailable</span>}
      <span className="ml-auto text-muted-foreground" title="Systems and their classification live in this installation's local catalog, not in Git. Every checkout and branch of this project shows the same catalog; switching checkout only changes where code evidence is read.">
        Catalog: local to this installation, shared by every checkout
      </span>
    </div>
  )
}

/** First screen of a project with no systems: design comes first, discovery from code is the secondary way in. */
function EmptyDesign({ onManual, onAgent, onDiscover, busy }: { onManual: () => void; onAgent: () => void; onDiscover: () => void; busy: boolean }) {
  return (
    <div className="mx-auto max-w-xl space-y-4 p-8" data-testid="systems-empty">
      <div>
        <h2 className="text-base font-semibold">Design the game before the code</h2>
        <p className="mt-1 text-xs text-muted-foreground">A system is a part of the game with a purpose, responsibilities and rules. You can describe one now, with no code behind it, and link files once they exist. Nothing here is confirmed until you confirm it.</p>
      </div>
      <div className="grid gap-2">
        <button onClick={onManual} data-testid="empty-manual" className="rounded-md border p-3 text-left hover:bg-accent/60"><span className="flex items-center gap-1.5 text-xs font-medium"><Plus className="h-3.5 w-3.5" />Describe a system yourself</span><span className="mt-0.5 block text-[11px] text-muted-foreground">A name, what it does for the player, its responsibilities. Mark it planned if it is not built.</span></button>
        <button onClick={onAgent} data-testid="empty-agent" className="rounded-md border p-3 text-left hover:bg-accent/60"><span className="flex items-center gap-1.5 text-xs font-medium"><Sparkles className="h-3.5 w-3.5" />Ask an agent to draft one</span><span className="mt-0.5 block text-[11px] text-muted-foreground">You describe the idea; the agent proposes a structure that you edit and review. It cannot confirm anything.</span></button>
        <button onClick={onDiscover} disabled={busy} data-testid="empty-discover" className="rounded-md border border-dashed p-3 text-left hover:bg-accent/60 disabled:opacity-50"><span className="flex items-center gap-1.5 text-xs font-medium"><Wand2 className="h-3.5 w-3.5" />The project already has code? Find systems in it</span><span className="mt-0.5 block text-[11px] text-muted-foreground">Groups files by shared words in their names. Noisy on purpose; you correct it.</span></button>
      </div>
    </div>
  )
}

const TABS = [['overview', 'Overview'], ['map', 'Map'], ['rules', 'Rules & decisions'], ['implementation', 'Implementation'], ['evidence', 'Evidence']] as const

function SystemDetail({ v, projectId, allSystems, onOpen, onGraph, onAsk, onChanged, onPick, refreshing }: {
  v: SystemView; projectId: string; allSystems: SystemSummary[]
  onOpen: (file: string, line?: number) => void; onGraph: (file: string) => void
  onAsk: (a: AskAgent, area?: string, goal?: string) => void; onChanged: () => void; onPick: (id: string) => void; refreshing: boolean
}) {
  const tabKey = `shipyard:system-tab:${projectId}`
  const [tab, setTabState] = useState<string>(() => { try { return localStorage.getItem(tabKey) || 'overview' } catch { return 'overview' } })
  const setTab = (t: string) => { setTabState(t); try { localStorage.setItem(tabKey, t) } catch { /* ignore */ } }
  const [area, setArea] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditStep | null>(null)
  const [focus, setFocus] = useState<Focus | null>(null)
  const [structure, setStructure] = useState<'merge' | 'split' | null>(null)
  useEffect(() => { setArea(null) }, [v.id])
  const actions: SystemActions = { onOpen, onGraph, onAsk, onPickSystem: onPick, onEdit: step => setEditing(step), onQuickEdit: f => setFocus(f), onChanged }
  const c = v.checkout
  const m = v.maintenance
  const stale = m.needsReanalysis || m.vanished.length > 0 || m.unresolvedAnchors.length > 0
  const conflicts = v.comparisons.length
  return (
    <div className="mx-auto max-w-4xl space-y-3 p-4">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold" data-testid="system-name">{v.name}</h2>
          <button onClick={() => setFocus({ type: 'identity' })} aria-label="Rename or retype" data-testid="system-rename" className="rounded p-0.5 text-muted-foreground hover:text-foreground"><Pencil className="h-3 w-3" /></button>
          <span className="rounded bg-accent px-1.5 py-0.5 text-[10px]" data-testid="system-kind">{v.kind}</span>
          {v.planned && <span className="rounded border border-dashed px-1.5 py-0.5 text-[10px] text-muted-foreground" data-testid="system-planned">planned</span>}
          <StatusPill status={v.status} />
          <span className="text-[11px] text-muted-foreground">{ORIGIN_LABEL[v.origin]}</span>
          {refreshing && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        {!v.summary && <p className="text-[11px] text-muted-foreground" data-testid="system-purpose">No description yet — write one in Overview, or ask an agent to propose it.</p>}
        {v.status !== 'confirmed' && <p className="text-[11px] text-warning">Not confirmed: the grouping and text here are a proposal, not a decision of the project.</p>}
        <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2 py-1.5 text-[11px]', c.isCanonical ? 'bg-card/40' : 'border-warning/50 bg-warning/10')} data-testid="system-checkout">
          <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" />{c.branch ?? '?'} <code className="font-mono">{c.head ?? ''}</code></span>
          <span>{c.isCanonical ? 'project checkout' : 'worktree'}</span>
          <span>{c.uncommitted ? `${c.uncommitted} uncommitted` : 'clean'}</span>
          {!c.isCanonical && <span className="text-muted-foreground">{c.integration.replace(/integrated checkout/g, 'project checkout')}</span>}
          <span className={cn('ml-auto', stale ? 'text-warning' : 'text-muted-foreground')} data-testid="analysis-state">
            {!m.graph.built ? 'code graph: not analyzed' : stale ? 'analysis out of date' : 'analysis current'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={() => setEditing('identity')} data-testid="system-edit" className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] text-primary-foreground"><Pencil className="h-3 w-3" /> Edit system</button>
          <AskMenu actions={actions} target={`the system “${v.name}”`} />
          <button onClick={() => onAsk('design')} className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent"><Sparkles className="h-3 w-3" /> Propose a design change</button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button aria-label="More actions" data-testid="system-more" className="rounded-md border p-1 hover:bg-accent"><MoreHorizontal className="h-3.5 w-3.5" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setStructure('merge')} data-testid="system-merge"><Merge className="mr-2 h-3.5 w-3.5" />Merge another system into this…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setStructure('split')} data-testid="system-split"><Scissors className="mr-2 h-3.5 w-3.5" />Split part into a new system…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={async () => { try { await api.editSystem(projectId, v.id, { status: 'dismissed' }); toast.success('Dismissed'); onChanged() } catch (e: any) { toast.error(e.message) } }}><EyeOff className="mr-2 h-3.5 w-3.5" />Dismiss this system</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <EditSystemDialog key={focus ? JSON.stringify(focus) : 'full'} v={v} projectId={projectId} allSystems={allSystems} open={!!editing || !!focus} initialStep={editing || undefined} focus={focus}
        onOpenChange={b => { if (!b) { setEditing(null); setFocus(null) } }} onChanged={onChanged} onOpenFile={onOpen} />
      <MergeDialog v={v} projectId={projectId} allSystems={allSystems} open={structure === 'merge'} onOpenChange={b => !b && setStructure(null)} onChanged={onChanged} />
      <SplitDialog v={v} projectId={projectId} open={structure === 'split'} onOpenChange={b => !b && setStructure(null)} onChanged={onChanged} onPick={onPick} />

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

      {tab === 'overview' && <OverviewTab v={v} actions={actions} goTab={setTab} selectArea={setArea} projectId={projectId} />}
      {tab === 'map' && <SystemMap v={v} actions={actions} selectedArea={area} onSelectArea={setArea} />}
      {tab === 'rules' && <RulesTab v={v} actions={actions} projectId={projectId} />}
      {tab === 'implementation' && <ImplementationTab v={v} actions={actions} area={area} setArea={setArea} />}
      {tab === 'evidence' && <EvidenceTab v={v} actions={actions} projectId={projectId} onChanged={onChanged} onPick={onPick} />}
    </div>
  )
}
