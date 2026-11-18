import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FileSearch, PenLine, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { AgentRunChoice, SystemSummary, SystemView } from '@/lib/api'
import { RunConfigSelect, readRunChoice, saveRunChoice } from '@/components/tasks/RunConfigSelect'
import { useAgents } from '@/hooks/useAgents'
import { buildSystemProposalPrompt, openAgentSession } from '@/lib/terminalDispatch'
import { useMcpStatus } from '@/hooks/useMcp'
import { cn } from '@/lib/utils'
import { EditSystemDialog, blankView } from './EditSystemDialog'
import { FilePicker, TermChips, field, KIND_HELP, Label } from './EditSteps'

const RUN_KEY = 'shipyard:systems-assist-run'

export type Mode = 'manual' | 'project' | 'agent'
type Kind = SystemView['kind']
const MODES: { id: Mode; label: string; icon: typeof PenLine; help: string }[] = [
  { id: 'manual', label: 'Manual', icon: PenLine, help: 'Start from a name, a purpose and a type. Nothing is needed from the code, so it can describe something not built yet.' },
  { id: 'project', label: 'From the project', icon: FileSearch, help: 'Start from files, symbols or a candidate that discovery found.' },
  { id: 'agent', label: 'Ask an agent', icon: Sparkles, help: 'Describe what you want. Claude or Codex answers with an editable proposal; it cannot confirm anything.' },
]

/**
 * Three ways in, one editor out. Manual and From-the-project fill a starting point and open the same editor that
 * edits an existing system; the editor creates the system with the same calls it uses for every other edit. The
 * agent path hands a brief to an agent, whose answer returns as an ordinary proposal to open in that same editor.
 */
export function NewSystemDialog({ projectId, allSystems, open, initialMode = 'manual', onOpenChange, onCreated, onSent, onOpenFile }: {
  projectId: string; allSystems: SystemSummary[]; open: boolean; initialMode?: Mode; onOpenChange: (b: boolean) => void; onCreated: (id: string) => void | Promise<unknown>
  /** The agent session opened with the description. This is NOT a proposal: the parent watches the list for the real one. */
  onSent?: (s: { agent: string; label: string }) => void; onOpenFile?: (f: string) => void
}) {
  const [mode, setMode] = useState<Mode>('manual')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Kind>('system')
  const [summary, setSummary] = useState('')
  const [planned, setPlanned] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [terms, setTerms] = useState<string[]>([])
  const [cands, setCands] = useState<string[]>([])
  const [ask, setAsk] = useState('')
  const [run, setRun] = useState<AgentRunChoice>(() => readRunChoice(RUN_KEY))
  const agent = run.agent || 'claude'
  const { data: agentData } = useAgents()
  const agentName = agentData?.agents.find(a => a.id === agent)?.name || agent
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  // The agent reaches Knowledge only through the MCP server: say so here, before a prompt is sent.
  const mcp = useMcpStatus()
  const knowledge = mcp.data?.state
  useEffect(() => { if (open) void mcp.refetch() }, [open])
  const [editor, setEditor] = useState<{ prefill: Parameters<typeof blankView>[0]; step: 'identity' | 'responsibilities' | 'members' } | null>(null)
  useEffect(() => { if (open) { setMode(initialMode); setName(''); setKind('system'); setSummary(''); setPlanned(false); setFiles([]); setTerms([]); setCands([]); setAsk('') } }, [open])

  const candidates = useMemo(() => allSystems.filter(s => s.origin === 'discovery' && s.status === 'proposed').slice(0, 30), [allSystems])
  const continueToEditor = () => {
    if (!name.trim()) { toast.error('Give the system a name'); return }
    const t = mode === 'project' ? uniqTerms([...terms, ...cands.map(id => candidates.find(c => c.id === id)?.name.toLowerCase() ?? '')]) : []
    setEditor({ prefill: { name: name.trim(), kind, summary, planned, terms: t, files: mode === 'project' ? files : [] }, step: mode === 'manual' ? 'responsibilities' : 'members' })
    onOpenChange(false)
  }
  /**
   * Opens an agent session with the description as its first message. The dialog stays open, with the text,
   * until the terminal reports that the session took the prompt; a failure keeps the text for a retry.
   */
  const sendToAgent = async () => {
    const description = ask.trim()
    if (!description) { toast.error('Describe the system first'); return }
    if (sendingRef.current) return
    if (knowledge !== 'ready') { toast.error('The Knowledge tools are not ready. See the note above the button.'); return }
    const label = agentName
    sendingRef.current = true
    setSending(true)
    const r = await openAgentSession({ projectId, agent, model: run.model, effort: run.effort, prompt: buildSystemProposalPrompt(projectId, description) })
    sendingRef.current = false
    setSending(false)
    if (r.ok) {
      onSent?.({ agent, label })
      onOpenChange(false)
    } else {
      toast.error(`Could not send to ${label}: ${r.error}. Your description is still here; try again.`)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl" data-testid="new-system-dialog">
          <DialogHeader>
            <DialogTitle className="text-sm">New system</DialogTitle>
            <DialogDescription className="text-[11px]">Three ways to start; all of them end in the same editor and the same saved proposal. Nothing is confirmed.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="how to start">
            {MODES.map(m => (
              <button key={m.id} role="tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)} data-testid={`new-mode-${m.id}`}
                className={cn('rounded-md border p-2 text-left hover:bg-accent/60', mode === m.id && 'border-foreground bg-accent')}>
                <span className="flex items-center gap-1.5 text-xs font-medium"><m.icon className="h-3.5 w-3.5" />{m.label}</span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">{m.help}</span>
              </button>
            ))}
          </div>

          <div className="min-h-[300px]">
          {mode !== 'agent' && (
            <div className="space-y-3">
              <div><Label>Name</Label><input className={field} value={name} onChange={e => setName(e.target.value)} placeholder="the word the team uses for it" aria-label="new system name" data-testid="new-name" autoFocus /></div>
              <div>
                <Label>What is it?</Label>
                <div className="grid grid-cols-4 gap-1.5">
                  {(['system', 'subsystem', 'mechanic', 'entity'] as const).map(k => (
                    <button key={k} onClick={() => setKind(k)} aria-pressed={kind === k} title={KIND_HELP[k]} data-testid={`new-kind-${k}`}
                      className={cn('rounded-md border px-2 py-1.5 text-xs capitalize hover:bg-accent/60', kind === k && 'border-foreground bg-accent')}>{k}</button>
                  ))}
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">{KIND_HELP[kind]}</p>
              </div>
              <div><Label hint="what does it do for the player and the game?">Purpose</Label>
                <textarea className={field} rows={3} value={summary} onChange={e => setSummary(e.target.value)} aria-label="new system purpose" data-testid="new-summary" /></div>
              {mode === 'manual' && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={planned} onChange={e => setPlanned(e.target.checked)} className="mt-0.5" data-testid="new-planned" /><span><b>Planned</b> — not built yet; no files expected.</span></label>}
              {mode === 'project' && (
                <div className="space-y-3">
                  <FilePicker label="Files and symbols that belong to it" projectId={projectId} value={files} onChange={setFiles} symbols onOpen={onOpenFile} />
                  <TermChips label="Name terms" hint="files whose name contains one of these are counted as participants" value={terms} onChange={setTerms} />
                  <div>
                    <Label hint="found from file names only; picking one only borrows its name as a term">Candidates found by discovery</Label>
                    {!candidates.length && <p className="text-[11px] text-muted-foreground">No candidates. Use “Find systems” first, or pick files above.</p>}
                    <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                      {candidates.map(c => (
                        <button key={c.id} onClick={() => setCands(cands.includes(c.id) ? cands.filter(x => x !== c.id) : [...cands, c.id])} aria-pressed={cands.includes(c.id)} data-testid="new-candidate"
                          className={cn('rounded-full border px-2 py-0.5 text-[11px] hover:bg-accent', cands.includes(c.id) && 'border-foreground bg-accent')}>{c.name} <span className="text-muted-foreground">{c.files}</span></button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {mode === 'agent' && (
            <div className="space-y-3">
              <div><Label hint="in game terms; mention what is planned and what already exists">What should the system be?</Label>
                <textarea className={field} rows={5} value={ask} onChange={e => setAsk(e.target.value)} aria-label="describe the system" data-testid="new-ask" placeholder="e.g. A system that manages the currency the player earns and spends…" /></div>
              <p className="flex items-center gap-1.5 text-[11px]">Run with:
                <RunConfigSelect value={run} onChange={v => { setRun(v); saveRunChoice(RUN_KEY, v) }} />
              </p>
              <KnowledgeNote state={knowledge} endpoint={mcp.data?.endpoint} />
              <p className="rounded-md bg-accent/50 p-2 text-[10px] text-muted-foreground">The agent proposes through propose_system. Its answer arrives as a system “proposed by an agent” that you open, edit and confirm here. It cannot confirm anything.</p>
            </div>
          )}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => onOpenChange(false)} className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent">Cancel</button>
            {mode === 'agent'
              ? <button onClick={sendToAgent} disabled={sending || knowledge !== 'ready'} data-testid="new-send-agent" className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-60">{sending ? 'Sending…' : `Send to ${agentName}`}</button>
              : <button onClick={continueToEditor} data-testid="new-continue" className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground">Continue to the editor</button>}
          </div>
        </DialogContent>
      </Dialog>
      {editor && (
        <EditSystemDialog draft v={blankView(editor.prefill)} projectId={projectId} allSystems={allSystems} open initialStep={editor.step}
          onOpenChange={b => { if (!b) setEditor(null) }} onChanged={id => id ? onCreated(id) : undefined} onOpenFile={onOpenFile} />
      )}
    </>
  )
}

/** What the agent will and will not reach, shown before the prompt is sent. */
function KnowledgeNote({ state, endpoint }: { state?: 'disabled' | 'needs-authorization' | 'ready'; endpoint?: string }) {
  if (state === 'ready') return <p className="rounded-md border p-2 text-[10px]" data-testid="knowledge-state">Knowledge tools are available to the agent (shipyard MCP{endpoint ? `, ${endpoint}` : ''}).</p>
  if (state === 'needs-authorization') return <p className="rounded-md border border-amber-500/60 p-2 text-[10px]" data-testid="knowledge-state">Knowledge tools need a one-time approval. In a Claude session run <b>/mcp</b>, choose <b>shipyard</b>, and approve in the browser page. Then this note turns green.</p>
  if (state === 'disabled') return <p className="rounded-md border border-amber-500/60 p-2 text-[10px]" data-testid="knowledge-state">Knowledge tools are off, so the agent could not propose a system. Turn on <b>MCP Server</b> in Settings, then approve the connection.</p>
  return <p className="text-[10px] text-muted-foreground">Checking the Knowledge tools…</p>
}

const uniqTerms = (xs: string[]) => [...new Set(xs.map(x => x.trim().toLowerCase()).filter(Boolean))]
