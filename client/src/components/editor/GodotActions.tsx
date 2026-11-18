import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink, FlaskConical, Info, ListChecks, Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'
import { useTasks, type Task } from '@/hooks/useTasks'
import { godotKeys, useGodotContext, useGodotRuns, useGodotStatus } from '@/hooks/useGodot'
import { godotApi, GodotError, contextLabel, shortSha, type GodotContext, type GodotRefusal, type GodotSelection, type RunRecord } from '@/lib/godotApi'
import { GodotResults, OutcomeChip } from './GodotResults'

export const GODOT_EXTENSIONS = new Set(['tscn', 'gd'])

const storageKey = (projectId: string) => `shipyard:godot-checkout:${projectId}`
const read = (projectId: string): string => { try { return localStorage.getItem(storageKey(projectId)) || 'main' } catch { return 'main' } }
const write = (projectId: string, v: string) => { try { localStorage.setItem(storageKey(projectId), v) } catch { /* optional */ } }

interface Props { projectId: string; file: string }

/**
 * Contextual Godot actions for the open file. Nothing here runs on its own: every run/open is a click, and the
 * checkout it targets is always shown (and chosen) explicitly. The backend resolves and validates the context; this
 * only sends {task, checkout, file}, never a path.
 */
export function GodotActions({ projectId, file }: Props) {
  const qc = useQueryClient()
  const { data: status } = useGodotStatus(projectId)
  const { data: tasks } = useTasks(projectId)
  const [choice, setChoice] = useState(() => read(projectId))
  const [busy, setBusy] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<{ code: string; message: string; options?: GodotRefusal['options'] } | null>(null)
  const [resultsOpen, setResultsOpen] = useState(false)
  const [focusRun, setFocusRun] = useState<string | null>(null)
  const [showContext, setShowContext] = useState(false)

  useEffect(() => { setChoice(read(projectId)); setRefusal(null) }, [projectId])
  useEffect(() => { setRefusal(null) }, [file, choice])

  const worktreeTasks = useMemo(() => (tasks ?? []).filter((t: Task) => !!t.worktreePath), [tasks])
  // A remembered task whose worktree is gone stays selected on purpose: the backend then refuses explicitly.
  const task = choice === 'main' ? undefined : (tasks ?? []).find((t: Task) => t.id === choice)
  const selection: GodotSelection = choice === 'main' ? { checkout: 'main', origin: 'editor' } : { taskId: choice, checkout: 'task', origin: 'editor' }

  const enabled = !!status?.godotProject
  const { data: ctxData, error: ctxError, isFetching } = useGodotContext(projectId, { ...selection, file }, enabled)
  const ctx = ctxData?.context && ctxData.context.ok ? (ctxData.context as GodotContext) : null
  const ctxRefusal = ctxData?.context && !ctxData.context.ok ? (ctxData.context as GodotRefusal) : null
  const cls = ctxData?.classification ?? null
  const { data: runsData } = useGodotRuns(projectId, file, resultsOpen || !!busy, enabled)
  const runs = runsData?.runs ?? []
  const latest = runs[0]

  if (!status?.godotProject) return null

  const choose = (v: string) => { setChoice(v); write(projectId, v) }
  const label = ctx ? contextLabel(ctx) : choice === 'main' ? 'Main checkout' : `Task #${task?.number ?? '?'} worktree`

  const fail = (e: unknown) => {
    if (e instanceof GodotError) setRefusal({ code: e.code, message: e.message, options: e.options })
    else toast.error((e as Error).message)
  }

  const doOpen = async () => {
    setBusy('open'); setRefusal(null)
    try {
      const r = await godotApi.open(projectId, { ...selection, file })
      toast.success(`Opened in Godot: ${r.openedPath}`, { description: r.note })
    } catch (e) { fail(e) } finally { setBusy(null) }
  }

  const doRun = async (action: 'scene' | 'test', target: string, via?: string, sel: GodotSelection = selection) => {
    setBusy(action); setRefusal(null)
    try {
      const r = await godotApi.run(projectId, { ...sel, file: target, action, via })
      setFocusRun(r.record.runId); setResultsOpen(true)
      void qc.invalidateQueries({ queryKey: godotKeys.runs(projectId, file) })
    } catch (e) { fail(e) } finally { setBusy(null) }
  }

  const rerun = (r: RunRecord) => { void doRun(r.action, r.file, r.via) }
  const verifiedRelated = cls?.relatedTests.filter(r => r.verified) ?? []
  const a = cls?.actions
  const Btn = ({ onClick, disabled, icon, children, title }: { onClick: () => void; disabled?: boolean; icon: React.ReactNode; children: React.ReactNode; title?: string }) => (
    <button onClick={onClick} disabled={disabled || !!busy || !ctx} title={title}
      className="flex items-center gap-1.5 px-2 py-1 text-xs rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent">
      {icon}{children}
    </button>
  )

  return (
    <div className="border-b bg-card/50 shrink-0">
      <div className="flex flex-wrap items-center gap-1 px-2 py-1">
        <span className="text-xs text-muted-foreground">Godot on</span>
        <select value={choice} onChange={e => choose(e.target.value)} className="h-6 max-w-[220px] rounded border bg-background px-1 text-xs" title="The checkout every Godot action here uses">
          <option value="main">Main checkout</option>
          {worktreeTasks.map((t: Task) => <option key={t.id} value={t.id}>Task #{t.number ?? '?'} worktree — {t.title.slice(0, 32)}</option>)}
          {choice !== 'main' && !worktreeTasks.some((t: Task) => t.id === choice) && <option value={choice}>{task ? `Task #${task.number ?? '?'} (no worktree)` : 'Unknown task'}</option>}
        </select>
        {ctx && <button onClick={() => setShowContext(v => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground font-mono" title="Show the resolved execution context">
          {ctx.branch ?? (ctx.detached ? 'detached' : '?')}@{shortSha(ctx.head)}{ctx.dirty && ctx.dirty.count > 0 && <span className="text-warning"> · {ctx.dirty.count} dirty</span>}<Info className="h-3 w-3" />
        </button>}
        {isFetching && !ctx && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}

        <div className="ml-auto flex items-center gap-0.5">
          {a?.runScene && <Btn onClick={() => doRun('scene', file)} icon={busy === 'scene' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} title="Run this scene through the Godot Agent Harness">Run Scene</Btn>}
          {a?.runTest && <Btn onClick={() => doRun('test', file)} icon={busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />} title="Run this test scene through the Godot Agent Harness">Run Test</Btn>}
          {a?.runRelatedTest && verifiedRelated.map(r => (
            <Btn key={r.rel} onClick={() => doRun('test', r.rel, file)} icon={<FlaskConical className="h-3.5 w-3.5" />} title={r.reason}>Run Related Test: {r.rel.split('/').pop()}</Btn>
          ))}
          {a?.openInGodot && <Btn onClick={doOpen} icon={busy === 'open' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />} title="Open this checkout in the Godot editor">Open in Godot</Btn>}
          <button onClick={() => { setFocusRun(null); setResultsOpen(true) }} className="flex items-center gap-1.5 px-2 py-1 text-xs rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground" title="Runs of this file">
            <ListChecks className="h-3.5 w-3.5" />Results{latest && <OutcomeChip outcome={latest.verdict.outcome} label={runs.length > 1 ? `${runs.length}` : latest.verdict.headline} />}
          </button>
        </div>
      </div>

      {showContext && ctx && (
        <div className="px-2 pb-1.5 text-xs text-muted-foreground space-y-0.5">
          <div><span className="text-foreground">Checkout:</span> <span className="font-mono break-all">{ctx.checkoutPath}</span></div>
          <div>{ctx.reason}</div>
          {ctx.file && <div><span className="text-foreground">File:</span> <span className="font-mono">{ctx.file.res}</span></div>}
        </div>
      )}
      {cls && cls.kind === 'gameplay-script' && verifiedRelated.length === 0 && (
        <p className="px-2 pb-1 text-xs text-muted-foreground">Gameplay script: no test scene is verifiably tied to it, so no Run Test is offered.{cls.suggestions.length > 0 && ` Possible (unverified) matches: ${cls.suggestions.map(s => s.rel).join(', ')}.`}</p>
      )}
      {cls?.warnings.map(w => <p key={w} className="px-2 pb-1 text-xs text-warning">{w}</p>)}
      {ctx?.notes.map(n => <p key={n} className="px-2 pb-1 text-xs text-warning">{n}</p>)}
      {(refusal || ctxRefusal || ctxError) && (() => {
        const r = refusal ?? ctxRefusal ?? { code: 'error', message: (ctxError as Error).message, options: undefined }
        return (
          <div className="mx-2 mb-1.5 flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <div className="break-words">{r.message}</div>
              {r.options?.map(o => <button key={o.checkout} onClick={() => choose(o.checkout === 'main' ? 'main' : choice)} className="mt-1 mr-2 rounded border border-destructive/40 px-2 py-0.5 hover:bg-destructive/10">{o.label}</button>)}
            </div>
          </div>
        )
      })()}

      <GodotResults projectId={projectId} file={file} open={resultsOpen} onOpenChange={setResultsOpen} focusRunId={focusRun} rerunLabel={label} onRerun={rerun} />
    </div>
  )
}
