import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink, FlaskConical, FolderGit2, Gamepad2, GitBranch, Info, Loader2, Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import { useTasks, type Task } from '@/hooks/useTasks'
import { godotKeys, useGodotContext, useGodotRuns, useGodotStatus } from '@/hooks/useGodot'
import { useEditorTabsContext } from '@/hooks/useEditorTabsContext'
import { godotApi, GodotError, contextLabel, shortSha, type GodotContext, type GodotRefusal, type GodotSelection, type RunListItem, type RunRecord } from '@/lib/godotApi'
import { OutcomeChip, RunDetail, when } from '@/components/editor/GodotResults'
import { cn } from '@/lib/utils'

/**
 * Testing workspace (RC2). A global view over the SAME Godot execution state the Editor and the task Review use:
 * the same context resolver, the same run endpoints and the same run index. It keeps no runs of its own and never runs
 * anything on open; every run, open or play is an explicit click on the checkout shown in section A.
 */

const storageKey = (projectId: string) => `shipyard:testing-checkout:${projectId}`
const readChoice = (projectId: string): string => { try { return localStorage.getItem(storageKey(projectId)) || 'main' } catch { return 'main' } }
const writeChoice = (projectId: string, v: string) => { try { localStorage.setItem(storageKey(projectId), v) } catch { /* optional */ } }

const basename = (rel: string) => rel.split('/').pop() ?? rel
const extOf = (rel: string) => rel.split('.').pop() ?? ''

function duration(item: RunListItem): string {
  const start = Date.parse(item.record.startedAt)
  const end = item.record.runner?.endedAt ? Date.parse(item.record.runner.endedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—'
  const s = Math.max(0, Math.round((end - start) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const lastActivity = (r: RunRecord) => when(r.runner?.endedAt ?? r.startedAt)

function Section({ letter, title, hint, children }: { letter: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border bg-card/40">
      <header className="flex items-baseline gap-2 border-b px-3 py-2">
        <span className="font-mono text-[10px] text-muted-foreground">{letter}</span>
        <h3 className="text-xs font-medium">{title}</h3>
        {hint && <span className="ml-auto truncate text-[11px] text-muted-foreground">{hint}</span>}
      </header>
      <div className="p-3 text-xs">{children}</div>
    </section>
  )
}

export function TestingPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: status } = useGodotStatus(projectId)
  const { data: tasks } = useTasks(projectId)
  const editor = useEditorTabsContext()
  const [choice, setChoice] = useState(() => readChoice(projectId))
  const [busy, setBusy] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<{ code: string; message: string; options?: GodotRefusal['options'] } | null>(null)
  const [selectedRun, setSelectedRun] = useState<string | null>(null)

  useEffect(() => { setChoice(readChoice(projectId)); setRefusal(null); setSelectedRun(null) }, [projectId])

  const worktreeTasks = useMemo(() => (tasks ?? []).filter((t: Task) => !!t.worktreePath), [tasks])
  const task = choice === 'main' ? undefined : (tasks ?? []).find((t: Task) => t.id === choice)
  // Same selection shape the Editor bar uses: the Testing tab never picks a checkout on its own.
  const selection: GodotSelection = choice === 'main' ? { checkout: 'main', origin: 'project' } : { taskId: choice, checkout: 'task', origin: 'project' }

  const enabled = !!status?.godotProject
  const { data: ctxData, error: ctxError, isFetching } = useGodotContext(projectId, selection, enabled)
  const ctx = ctxData?.context && ctxData.context.ok ? (ctxData.context as GodotContext) : null
  const ctxRefusal = ctxData?.context && !ctxData.context.ok ? (ctxData.context as GodotRefusal) : null
  const { data: runsData, isLoading: runsLoading } = useGodotRuns(projectId, undefined, enabled, enabled)
  const runs = runsData?.runs ?? []
  const tests = ctxData?.tests ?? []
  const testScripts = ctxData?.testScripts ?? []
  const label = ctx ? contextLabel(ctx) : choice === 'main' ? 'Main checkout' : `Task #${task?.number ?? '?'} worktree`
  const onMain = choice === 'main'

  if (!status) return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
  if (!status.godotProject) {
    return (
      <div className="m-auto max-w-md p-6 text-center text-xs text-muted-foreground">
        <p className="text-foreground">This project is not a Godot project.</p>
        <p className="mt-1">Testing needs a <span className="font-mono">project.godot</span> at the project root.</p>
      </div>
    )
  }

  const choose = (v: string) => { setChoice(v); writeChoice(projectId, v); setRefusal(null) }
  const fail = (e: unknown) => {
    if (e instanceof GodotError) setRefusal({ code: e.code, message: e.message, options: e.options })
    else toast.error((e as Error).message)
  }

  const runOn = async (action: 'scene' | 'test', file: string, via?: string) => {
    setBusy(`${action}:${file}`); setRefusal(null)
    try {
      const r = await godotApi.run(projectId, { ...selection, file, action, via })
      setSelectedRun(r.record.runId)
      void qc.invalidateQueries({ queryKey: godotKeys.runs(projectId) })
    } catch (e) { fail(e) } finally { setBusy(null) }
  }

  const openInGodot = async (file?: string) => {
    setBusy(`open:${file ?? ''}`); setRefusal(null)
    try {
      const r = await godotApi.open(projectId, { ...selection, file })
      toast.success(`Opened in Godot: ${r.openedPath}`, { description: r.note })
    } catch (e) { fail(e) } finally { setBusy(null) }
  }

  const play = async () => {
    setBusy('play'); setRefusal(null)
    try {
      await godotApi.play(projectId, selection)
      toast.success(`Game started on ${label}`, { description: 'Interactive play: no receipt and no verdict. Nothing here is a PASS.' })
    } catch (e) { fail(e) } finally { setBusy(null) }
  }

  // The Editor shows the project checkout only, so opening a file "from" a task worktree would show other content.
  const openInEditor = (rel: string) => editor.openFileForProject(projectId, rel, basename(rel), extOf(rel))

  const lastRunOf = (rel: string) => runs.find(r => r.record.file === rel)
  const current = selectedRun ?? runs[0]?.record.runId ?? null
  const running = runs.some(r => r.running)
  const refusalNow = refusal ?? (ctxRefusal ? { code: ctxRefusal.code, message: ctxRefusal.message, options: ctxRefusal.options } : null)
  const blocked = !ctx || !!busy

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 scrollbar-dark" data-testid="testing-panel">
      {/* A. Execution context */}
      <Section letter="A" title="Execution context" hint={isFetching && !ctx ? 'resolving…' : `Actions here use: ${label}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Checkout</span>
          <select value={choice} onChange={e => choose(e.target.value)} className="h-6 max-w-[260px] rounded border bg-background px-1" title="The checkout every action in this tab uses">
            <option value="main">Main checkout (project folder)</option>
            {worktreeTasks.map((t: Task) => <option key={t.id} value={t.id}>Task #{t.number ?? '?'} worktree — {t.title.slice(0, 32)}</option>)}
            {choice !== 'main' && !worktreeTasks.some((t: Task) => t.id === choice) && <option value={choice}>{task ? `Task #${task.number ?? '?'} (no worktree)` : 'Unknown task'}</option>}
          </select>
        </div>

        {ctx ? (
          <dl className="mt-2 grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
            <dt className="text-muted-foreground">Project</dt><dd>{ctx.projectName}</dd>
            <dt className="text-muted-foreground">Checkout</dt>
            <dd className="min-w-0"><span className="inline-flex items-start gap-1 font-mono break-all"><FolderGit2 className="mt-px h-3 w-3 shrink-0" />{ctx.checkoutPath}</span>
              <div className="text-muted-foreground">{ctx.reason}</div></dd>
            <dt className="text-muted-foreground">Branch @ commit</dt>
            <dd className="font-mono"><span className="inline-flex items-center gap-1"><GitBranch className="h-3 w-3" />{ctx.branch ?? (ctx.detached ? 'detached' : 'unknown')} @ {shortSha(ctx.head)}</span></dd>
            <dt className="text-muted-foreground">Uncommitted</dt>
            <dd>{ctx.dirty == null ? 'Unknown (not a Git checkout)' : ctx.dirty.count === 0 ? 'None — the commit matches the working tree' : (
              <span className="text-warning">{ctx.dirty.count} change(s): results describe the working tree, not the commit alone
                <span className="block font-mono text-muted-foreground break-all">{ctx.dirty.files.slice(0, 6).join(', ')}{ctx.dirty.files.length > 6 ? ' …' : ''}</span></span>
            )}</dd>
            <dt className="text-muted-foreground">Task</dt>
            <dd>{ctx.taskId ? `Task #${ctx.taskNumber ?? '?'} ${ctx.taskTitle ?? ''}` : 'None — project-level'}</dd>
            <dt className="text-muted-foreground">Harness</dt>
            <dd>{status.harness?.ready ? <span>Ready · Godot {status.harness.version ?? 'version unknown'}</span> : <span className="text-destructive">{status.harness?.message ?? 'Unavailable'}</span>}</dd>
          </dl>
        ) : (
          <p className="mt-2 text-muted-foreground">{ctxError ? (ctxError as Error).message : ctxRefusal ? ctxRefusal.message : 'Resolving the checkout…'}</p>
        )}
        {ctx && !ctx.reproducibleFromSha && <p className="mt-1 text-warning">The commit alone does not reproduce what would run here.</p>}
        {ctxData?.warnings?.map(w => <p key={w} className="mt-1 text-warning">{w}</p>)}
        {ctx?.notes.map(n => <p key={n} className="mt-1 text-warning">{n}</p>)}

        {refusalNow && (
          <div className="mt-2 flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 p-2 text-destructive">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <div className="break-words">{refusalNow.message}</div>
              {refusalNow.options?.map(o => <button key={o.checkout} onClick={() => choose('main')} className="mt-1 mr-2 rounded border border-destructive/40 px-2 py-0.5 hover:bg-destructive/10">{o.label}</button>)}
            </div>
          </div>
        )}

        <div className="mt-2 flex flex-wrap gap-1">
          <button onClick={() => void openInGodot()} disabled={blocked} className="flex items-center gap-1.5 rounded border px-2 py-1 hover:bg-accent/50 disabled:opacity-40">
            {busy === 'open:' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}Open project in Godot
          </button>
          <button onClick={() => void play()} disabled={blocked} title="Interactive play. Not a Harness run: no receipt, no PASS." className="flex items-center gap-1.5 rounded border px-2 py-1 hover:bg-accent/50 disabled:opacity-40">
            {busy === 'play' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Gamepad2 className="h-3 w-3" />}Play Game (interactive)
          </button>
        </div>
      </Section>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* B. Available tests */}
        <Section letter="B" title="Available tests" hint={`${tests.length} discovered`}>
          {tests.length === 0 && !isFetching && <p className="text-muted-foreground">No test scenes under <span className="font-mono">tests/</span> in this checkout. Nothing to run.</p>}
          <ul className="space-y-1.5">
            {tests.map(rel => {
              const last = lastRunOf(rel)
              return (
                <li key={rel} className="rounded border bg-background/50 p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <FlaskConical className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-mono break-all">{rel}</span>
                    <span className="rounded border px-1 text-[10px] text-muted-foreground" title="Found on disk: a .tscn under tests/">discovered</span>
                    {last ? <OutcomeChip outcome={last.verdict.outcome} label={last.verdict.headline} /> : <span className="text-muted-foreground">no run yet</span>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <button onClick={() => void runOn('test', rel)} disabled={blocked} className="flex items-center gap-1 rounded border px-2 py-0.5 hover:bg-accent/50 disabled:opacity-40">
                      {busy === `test:${rel}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}Run Test
                    </button>
                    <button onClick={() => void openInGodot(rel)} disabled={blocked} className="flex items-center gap-1 rounded border px-2 py-0.5 hover:bg-accent/50 disabled:opacity-40">
                      <ExternalLink className="h-3 w-3" />Open in Godot
                    </button>
                    <button onClick={() => openInEditor(rel)} disabled={!onMain} title={onMain ? 'Open in the Editor' : 'The Editor shows the project checkout only; switch the checkout to Main to open it there'} className="flex items-center gap-1 rounded border px-2 py-0.5 hover:bg-accent/50 disabled:opacity-40">
                      Open in Editor
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
          {testScripts.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] text-muted-foreground">Candidates — scripts under tests/ that no test scene attaches. Not runnable.</div>
              <ul className="space-y-1">
                {testScripts.map(rel => (
                  <li key={rel} className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    <span className="font-mono break-all text-foreground/80">{rel}</span>
                    <button onClick={() => openInEditor(rel)} disabled={!onMain} className="rounded border px-1.5 py-0.5 hover:bg-accent/50 disabled:opacity-40">Open in Editor</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-3 text-[11px] text-muted-foreground">Run All is not offered: this project declares no test suite. Last results come from the 30 most recent runs.</p>
        </Section>

        {/* C. Executions */}
        <Section letter="C" title="Executions" hint={running ? 'a run is in progress' : runs.length ? `${runs.length} recent` : undefined}>
          <p className="mb-2 text-[11px] text-muted-foreground">Harness runs only. Play Game is interactive and leaves no record; a human check is never recorded here as PASS.</p>
          {runs.length === 0 && !runsLoading && <p className="text-muted-foreground">No runs yet. Nothing runs automatically.</p>}
          <ul className="space-y-1">
            {runs.map(item => {
              const r = item.record
              return (
                <li key={r.runId}>
                  <button
                    onClick={() => setSelectedRun(r.runId)}
                    className={cn('w-full rounded border p-2 text-left hover:bg-accent/40', current === r.runId && 'bg-accent/60')}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <OutcomeChip outcome={item.verdict.outcome} label={item.verdict.headline} />
                      <span className="font-mono break-all">{r.file}</span>
                      <span className="rounded border px-1 text-[10px] text-muted-foreground">Harness · {r.action}</span>
                    </div>
                    <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[11px] text-muted-foreground">
                      <span>Checkout</span><span className="font-mono">{r.checkout.isMainCheckout ? 'Main' : `Task #${r.taskNumber ?? '?'}`} · {r.checkout.branch ?? 'detached'} @ {shortSha(r.checkout.head)}{r.checkout.dirtyAtStart?.count ? ` · ${r.checkout.dirtyAtStart.count} uncommitted` : ''}</span>
                      <span>Task</span><span>{r.taskId ? `#${r.taskNumber ?? '?'} ${r.taskTitle ?? ''}` : 'none'}{r.via ? ` · via ${basename(r.via)}` : ''}</span>
                      <span>Duration</span><span>{item.running ? `${duration(item)} · running` : duration(item)}</span>
                      <span>Last activity</span><span>{lastActivity(r)}</span>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        </Section>
      </div>

      {/* D. Results */}
      <Section letter="D" title="Results" hint={current ? 'selected execution' : undefined}>
        {current ? (
          <RunDetail key={current} projectId={projectId} runId={current} rerunLabel={label}
            onRerun={(r: RunRecord) => void runOn(r.action, r.file, r.via)} />
        ) : (
          <p className="text-muted-foreground flex items-center gap-1.5"><Info className="h-3.5 w-3.5" />Select an execution in C, or run a test in B.</p>
        )}
        {current && runs.find(r => r.record.runId === current)?.running && (
          <p className="mt-2 flex items-center gap-1 text-muted-foreground"><Square className="h-3 w-3" />Cancel is available in the result above while the run is in progress.</p>
        )}
      </Section>
    </div>
  )
}
