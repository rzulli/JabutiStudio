import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink, FlaskConical, FolderGit2, GitBranch, Gamepad2, ListChecks, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Task } from '@/hooks/useTasks'
import { godotKeys, useGodotContext, useGodotRuns, useGodotStatus } from '@/hooks/useGodot'
import { godotApi, GodotError, shortSha, type GodotContext, type GodotRefusal, type GodotSelection, type RunRecord } from '@/lib/godotApi'
import { GodotResults, OutcomeChip } from '@/components/editor/GodotResults'

/**
 * Godot actions in a task's Review. The checkout comes from the task itself: its own worktree when it has one, the
 * project's checkout when it was worked "directly". A task whose worktree is gone is refused, never moved to the main
 * checkout behind the person's back; the only way to the main checkout is a visible button that says so.
 * Running or playing is evidence about this checkout at this commit — never acceptance.
 */
export function TaskGodotReview({ task }: { task: Task }) {
  const qc = useQueryClient()
  const projectId = task.projectId
  const { data: status } = useGodotStatus(projectId)
  const [forceMain, setForceMain] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [test, setTest] = useState('')
  const [results, setResults] = useState<{ open: boolean; focus: string | null }>({ open: false, focus: null })
  const [launchWarnings, setLaunchWarnings] = useState<string[]>([])
  const [failure, setFailure] = useState<{ message: string; options?: GodotRefusal['options'] } | null>(null)

  const hasWorktree = !!task.worktreePath
  const selection: GodotSelection = forceMain || !hasWorktree ? { taskId: task.id, checkout: 'main', origin: 'task' } : { taskId: task.id, checkout: 'task', origin: 'task' }
  const enabled = !!status?.godotProject
  const { data } = useGodotContext(projectId, selection, enabled)
  const { data: runsData } = useGodotRuns(projectId, undefined, !!busy, enabled, task.id)
  if (!enabled) return null

  const ctx = data?.context && data.context.ok ? (data.context as GodotContext) : null
  const refusal = data?.context && !data.context.ok ? (data.context as GodotRefusal) : null
  const tests = data?.tests ?? []
  const chosenTest = test && tests.includes(test) ? test : tests.find(t => /playtest/i.test(t)) ?? tests[0] ?? ''
  const warnings = [...(data?.warnings ?? []), ...launchWarnings]
  const runs = runsData?.runs ?? []
  const latest = runs[0]
  const problem = failure ?? (refusal ? { message: refusal.message, options: refusal.options } : null)

  const guard = async (what: string, fn: () => Promise<void>) => {
    setBusy(what); setFailure(null)
    try { await fn() } catch (e) { setFailure({ message: (e as Error).message, options: e instanceof GodotError ? e.options : undefined }) } finally { setBusy(null) }
  }
  const launch = (kind: 'open' | 'play') => guard(kind, async () => {
    const r = kind === 'open' ? await godotApi.open(projectId, selection) : await godotApi.play(projectId, selection)
    setLaunchWarnings(r.warnings)
    toast.success(kind === 'open' ? `Godot editor opened on ${r.openedPath}` : `Playing ${r.scene ?? 'the main scene'} from ${r.openedPath}`, { description: r.note })
  })
  const runTest = (file: string) => guard('test', async () => {
    const r = await godotApi.run(projectId, { ...selection, file, action: 'test' })
    setResults({ open: true, focus: r.record.runId })
    void qc.invalidateQueries({ queryKey: godotKeys.runs(projectId, undefined, task.id) })
  })
  const rerun = (r: RunRecord) => { if (r.action === 'test') void runTest(r.file) }

  const mode = hasWorktree && !forceMain ? 'Isolated worktree' : forceMain && hasWorktree ? 'Main checkout (chosen instead of the task worktree)' : 'Direct checkout'
  const BtnCls = 'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent/50 disabled:opacity-40'

  return (
    <section aria-label="Godot" className="rounded-lg border bg-card p-3 space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <h3 className="font-medium uppercase tracking-wider text-muted-foreground">Godot</h3>
        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{mode}</span>
        {latest && <button onClick={() => setResults({ open: true, focus: null })} className="ml-auto"><OutcomeChip outcome={latest.verdict.outcome} label={`Last run: ${latest.verdict.headline}`} /></button>}
      </div>

      {ctx ? (
        <div className="space-y-0.5 text-muted-foreground">
          <div className="flex items-start gap-1.5 font-mono break-all"><FolderGit2 className="mt-px h-3.5 w-3.5 shrink-0" />{ctx.checkoutPath}</div>
          <div className="flex items-center gap-1.5 font-mono"><GitBranch className="h-3.5 w-3.5" />{ctx.branch ?? (ctx.detached ? 'detached' : '?')} @ {shortSha(ctx.head)}
            {ctx.dirty && (ctx.dirty.count > 0 ? <span className="text-warning"> · {ctx.dirty.count} uncommitted change(s)</span> : <span> · clean</span>)}</div>
          <div>{ctx.reason}</div>
          <div>This is the checkout every action below uses. Nothing runs until you click.</div>
        </div>
      ) : !problem && <div className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Resolving where this task lives…</div>}

      {warnings.map(w => <p key={w} className="flex items-start gap-1.5 text-warning"><AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />{w}</p>)}
      {ctx?.notes.map(n => <p key={n} className="text-warning">{n}</p>)}

      {problem && (
        <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 p-2 text-destructive">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="break-words">{problem.message}</div>
            {problem.options?.map(o => <button key={o.checkout} onClick={() => { setForceMain(o.checkout === 'main'); setFailure(null) }} className="mt-1 mr-2 rounded border border-destructive/40 px-2 py-0.5 hover:bg-destructive/10">{o.label}</button>)}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <button className={BtnCls} disabled={!ctx || !!busy} onClick={() => launch('open')} title="Open the Godot editor on this checkout">
          {busy === 'open' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}Open Editor
        </button>
        <button className={BtnCls} disabled={!ctx || !!busy || !data?.mainScene} onClick={() => launch('play')} title={data?.mainScene ? `Play ${data.mainScene} interactively. Not a Harness run: it proves nothing by itself.` : 'This project sets no main scene'}>
          {busy === 'play' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Gamepad2 className="h-3.5 w-3.5" />}Play Game
        </button>
        {tests.length > 0 && (
          <>
            <select value={chosenTest} onChange={e => setTest(e.target.value)} className="h-7 max-w-[240px] rounded border bg-background px-1" title="Test scenes under tests/">
              {tests.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button className={BtnCls} disabled={!ctx || !!busy || !chosenTest} onClick={() => runTest(chosenTest)} title="Run through the Godot Agent Harness">
              {busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}Run Test
            </button>
          </>
        )}
        {tests.length === 0 && ctx && <span className="text-muted-foreground">No test scenes under tests/ in this checkout.</span>}
        <button className={BtnCls} onClick={() => setResults({ open: true, focus: null })}><ListChecks className="h-3.5 w-3.5" />View Results{runs.length > 0 && ` (${runs.length})`}</button>
      </div>
      <p className="text-muted-foreground">Playing or a passing test is evidence, not acceptance: Accept stays a separate, human step.</p>

      <GodotResults
        projectId={projectId} taskId={task.id} open={results.open} onOpenChange={o => setResults(r => ({ ...r, open: o }))} focusRunId={results.focus}
        rerunLabel={ctx ? `${mode.toLowerCase()} (${shortSha(ctx.head)})` : 'this task'} onRerun={rerun}
      />
    </section>
  )
}
