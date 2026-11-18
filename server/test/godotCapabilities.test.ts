/**
 * Godot Harness discovery: the capabilities contract, plan validation, run report and the link from an agent's run
 * to the task. The Harness is a stub runner whose `param()` block, `doctor -Deep` output and receipts have the same
 * shape as the real one, so the contract is READ from it (an invented action in its ValidateSet must show up). The
 * real Harness + real Godot are covered by the manual run recorded in docs/agent/godot-execution.md.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'jabuti caps '))
const dataDir = join(root, 'data dir')
const repo = join(root, 'My Game')
const wtBase = join(root, 'work trees')
const harnessDir = join(root, 'harness')
process.env.SHIPYARD_DATA_DIR = dataDir
process.env.GODOT_HARNESS_DIR = harnessDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim()
const put = (base: string, rel: string, text: string) => { mkdirSync(dirname(join(base, rel)), { recursive: true }); writeFileSync(join(base, rel), text) }
const hasPwsh = (() => { try { execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe' }); return true } catch { return false } })()

const STUB = `
param(
  [Parameter(Position=0)][ValidateSet('doctor','run','result','cancel','frobnicate')][string]$Action='doctor',
  [string]$Project,[string]$Test,
  [ValidateSet('STATIC','HEADLESS','RENDER_BACKGROUND','INTERACTIVE')][string]$Mode='HEADLESS',
  [ValidateSet('probe','smoke','integration','long_playtest')][string]$Profile='smoke',
  [int]$TimeoutSec,[int]$MaxTimeoutSec=1800,[string]$RunId,[string]$Marker='HARNESS_ASSERTIONS_PASS',[string]$OverrideReason,[switch]$NoDefaultScreenshot,[switch]$Deep
)
$root=Split-Path -Parent $PSScriptRoot
if($Action -eq 'doctor'){
  $o=[ordered]@{status='READY';godot='C:\\fake\\godot.exe';version='4.7.2.stable.fake'}
  if($Deep){ $o.deep=[ordered]@{status='REPRODUCIBLE';checks=[ordered]@{profiles=[ordered]@{probe=15;smoke=45;integration=90};long_override=[ordered]@{max_without_long_playtest_sec=300;max_timeout_sec=1800}}} }
  $o|ConvertTo-Json -Depth 6; exit 0 }
if($Action -ne 'run'){ throw 'unsupported' }
if($Test -match 'crash'){ [Console]::Error.WriteLine('runner blew up before any receipt'); exit 7 }
$dir=Join-Path $root "runs/$RunId"; New-Item -ItemType Directory -Force -Path (Join-Path $dir 'screenshots')|Out-Null
$status='PASS';$assert='PASS';$failed=@();$cause=$null;$exit=0;$klass=$null
if($Test -match 'fail'){ $status='FAIL';$assert='FAIL';$failed=@('STAIR_TOP_REACHED');$cause='assertion failed';$exit=1;$klass='TEST_FAILED' }
elseif($Test -match 'infra'){ $status='INFRA_BLOCKED';$assert='NOT_PROVEN';$cause='display unavailable';$exit=$null }
Set-Content -LiteralPath (Join-Path $dir 'stdout.log') -Value "stub $Test"
$receipt=[ordered]@{schema='godot-harness/2';run_id=$RunId;project=$Project;checkout=$Project;test=$Test;mode=$Mode;started_utc=[DateTime]::UtcNow.ToString('o');finished_utc=[DateTime]::UtcNow.ToString('o');duration_sec=0.2;timeout=@{profile=$Profile;operation_sec=45;override=[bool]$OverrideReason;override_reason=$OverrideReason};status=$status;failure_class=$klass;failure_cause=$cause;assertions=@{status=$assert;marker=$Marker;passed_count=$(if($status -eq 'PASS'){1}else{0});failed_count=$failed.Count;failed=$failed};process=@{status='EXITED';exit_code=$exit}}
$receipt|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $dir 'receipt.json') -Encoding utf8
if($status -ne 'PASS'){ exit 1 }
`

let project: any, taskId: string, wtPath: string, wtBranch: string
let caps: typeof import('../src/services/godot/capabilities.js')
let runs: typeof import('../src/services/godot/runs.js')
let hz: typeof import('../src/services/godot/harness.js')
let ctxMod: typeof import('../src/services/godot/context.js')

function runStub(checkout: string, testRes: string, runId: string, extra: string[] = []) {
  try {
    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-File', join(harnessDir, 'runner', 'godot-harness.ps1'), 'run', '-Project', checkout, '-Test', testRes, '-RunId', runId, ...extra], { stdio: 'pipe' })
  } catch { /* a failing test exits 1 on purpose */ }
}

before(async () => {
  put(harnessDir, 'runner/godot-harness.ps1', STUB)
  put(repo, 'project.godot', 'config_version=5\n[application]\nrun/main_scene="res://scenes/main.tscn"\n')
  put(repo, 'scenes/main.tscn', '[gd_scene format=3]\n[node name="M" type="Node"]\n')
  for (const n of ['pass', 'fail', 'infra', 'crash']) put(repo, `tests/stairs_${n}.tscn`, '[gd_scene format=3]\n[node name="T" type="Node"]\n')
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  project = (await (await import('../src/services/projectDiscovery.js')).addProjects([repo]))[0]
  const taskStore = await import('../src/services/taskStore.js')
  const wt = await import('../src/services/worktreeService.js')
  caps = await import('../src/services/godot/capabilities.js')
  runs = await import('../src/services/godot/runs.js')
  hz = await import('../src/services/godot/harness.js')
  ctxMod = await import('../src/services/godot/context.js')
  await wt.saveConfig({ enabled: true, basePath: wtBase })
  const t = await taskStore.createTask(project.id, { title: 'Stairs', description: '', priority: 'medium', status: 'in_progress' } as any)
  const w = await wt.ensureTaskWorktree(project, t)
  assert.ok(w.created, w.reason)
  taskId = t.id; wtPath = w.path; wtBranch = w.branch!
})
after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* Windows may hold a folder briefly */ } })

const skip = { skip: hasPwsh ? false : 'pwsh not available' }
const capsOf = async (plan?: any) => (await caps.getCapabilities({ projectId: project.id, taskId, plan })) as any

test('the contract is read from the Harness: its own actions (even an invented one), profiles, defaults and budgets', skip, async () => {
  const c = await capsOf()
  assert.equal(c.ok, true); assert.equal(c.ready, true, JSON.stringify(c.blockers))
  assert.deepEqual(c.actions.supported, ['doctor', 'run', 'result', 'cancel', 'frobnicate'])
  assert.equal(c.actions.supported.includes('playtest'), false)
  assert.deepEqual(c.run.profiles.map((p: any) => [p.name, p.defaultTimeoutSec]), [['probe', 15], ['smoke', 45], ['integration', 90], ['long_playtest', null]])
  assert.equal(c.run.timeouts.ceilingWithoutLongPlaytestSec, 300); assert.equal(c.run.timeouts.maxTimeoutSec, 1800)
  assert.deepEqual(c.run.usableModes, ['HEADLESS', 'RENDER_BACKGROUND'])
  assert.equal(c.run.optional.find((p: any) => p.name === 'Marker').default, 'HARNESS_ASSERTIONS_PASS')
  assert.match(c.sources.params, /param\(\) block/); assert.match(c.sources.budgets, /doctor -Deep/)
  assert.equal(c.harness.godot.version, '4.7.2.stable.fake')
})

test('the checkout is the task worktree, with its branch and the tests found there', skip, async () => {
  const c = await capsOf()
  assert.equal(ctxMod.sameCheckout(c.checkout.path, wtPath), true)
  assert.equal(c.checkout.branch, wtBranch); assert.equal(c.checkout.source, 'task')
  assert.deepEqual(c.tests.scenes.map((s: any) => s.res), ['res://tests/stairs_crash.tscn', 'res://tests/stairs_fail.tscn', 'res://tests/stairs_infra.tscn', 'res://tests/stairs_pass.tscn'])
  assert.equal(c.tests.mainScene, 'res://scenes/main.tscn')
  assert.match(c.evidence.howToLink, /record_godot_run/)
})

test('a valid plan yields the exact command: this checkout, a run id, the profile default and no override', skip, async () => {
  const p = (await capsOf({ test: 'tests/stairs_pass.tscn' })).plan
  assert.equal(p.ok, true, JSON.stringify(p.problems))
  assert.match(p.runId, hz.RUN_ID_RE)
  assert.equal(ctxMod.sameCheckout(p.checkout, wtPath), true)
  for (const a of ['run', '-Project', p.checkout, '-Test', 'res://tests/stairs_pass.tscn', '-Profile', 'smoke', '-RunId', p.runId]) assert.ok(p.command.includes(a), a)
  assert.equal(p.command.includes('-OverrideReason'), false); assert.equal(p.command.includes('-TimeoutSec'), false)
})

test('an invented action is refused up front with the real list; a non-test action is not planned as a test', skip, async () => {
  const p = (await capsOf({ action: 'playtest', test: 'tests/stairs_pass.tscn' })).plan
  assert.equal(p.ok, false); assert.equal(p.problems[0].code, 'unsupported-action')
  assert.match(p.problems[0].options[0], /doctor, run, result, cancel, frobnicate/)
  assert.equal((await capsOf({ action: 'frobnicate', test: 'tests/stairs_pass.tscn' })).plan.problems[0].code, 'not-a-test-action')
})

test('a missing or wrong test says what exists', skip, async () => {
  const none = (await capsOf({ action: 'run' })).plan.problems[0]
  assert.equal(none.code, 'test-required'); assert.match(none.options[0], /stairs_pass/)
  const gone = (await capsOf({ test: 'tests/nope.tscn' })).plan.problems[0]
  assert.equal(gone.code, 'test-not-found'); assert.match(gone.options[0], /stairs_fail/)
  assert.equal((await capsOf({ test: '../outside.tscn' })).plan.problems[0].code, 'bad-test-path')
})

test('a timeout above the profile budget needs a real reason; above the ceiling, long_playtest; nothing is overridden for the agent', skip, async () => {
  const no = (await capsOf({ test: 'tests/stairs_pass.tscn', timeoutSec: 120 })).plan
  assert.equal(no.ok, false); assert.equal(no.problems[0].code, 'override-required'); assert.equal(no.problems[0].kind, 'budget')
  assert.match(no.problems[0].message, /smoke budget \(45s\)/)
  assert.match((await capsOf({ test: 'tests/stairs_pass.tscn', timeoutSec: 80 })).plan.problems[0].options[0], /integration: 90s/) // a profile that already fits is offered first
  assert.equal((await capsOf({ test: 'tests/stairs_pass.tscn', timeoutSec: 120, overrideReason: 'short' })).plan.problems[0].code, 'override-required')
  const yes = (await capsOf({ test: 'tests/stairs_pass.tscn', timeoutSec: 120, overrideReason: 'cold import measured at 100s' })).plan
  assert.equal(yes.ok, true); assert.ok(yes.command.includes('-OverrideReason'))
  assert.equal((await capsOf({ test: 'tests/stairs_pass.tscn', timeoutSec: 30 })).plan.ok, true) // under budget: no reason needed
  assert.equal((await capsOf({ test: 'tests/stairs_pass.tscn', timeoutSec: 400, overrideReason: 'a long and honest reason' })).plan.problems[0].code, 'long-profile-required')
  assert.equal((await capsOf({ test: 'tests/stairs_pass.tscn', profile: 'long_playtest' })).plan.problems[0].code, 'timeout-explicit-required')
  assert.equal((await capsOf({ test: 'tests/stairs_pass.tscn', profile: 'nope' })).plan.problems[0].code, 'unknown-profile')
  assert.equal((await capsOf({ test: 'tests/stairs_pass.tscn', mode: 'STATIC' })).plan.problems[0].code, 'unsupported-mode')
})

test('a task whose worktree is gone is refused, not answered with the main checkout', skip, async () => {
  const taskStore = await import('../src/services/taskStore.js')
  const t2 = await taskStore.createTask(project.id, { title: 'No tree', description: '', priority: 'low', status: 'todo' } as any)
  const r: any = await caps.getCapabilities({ projectId: project.id, taskId: t2.id })
  assert.equal(r.ok, false); assert.match(r.code, /worktree|checkout/)
})

test('record + report: an agent run is linked to the task in the index Testing reads, and its verdict comes from the receipt', skip, async () => {
  const id = hz.newRunId()
  runStub(wtPath, 'res://tests/stairs_pass.tscn', id)
  const unrecorded: any = await caps.getRunReport(project.id, id)
  assert.equal(unrecorded.recorded, false); assert.equal(unrecorded.verdict.outcome, 'PASS'); assert.equal(unrecorded.usableAsCurrentEvidence, false)

  const rec: any = await caps.recordAgentRun({ projectId: project.id, taskId, runId: id })
  assert.equal(rec.ok, true); assert.equal(rec.alreadyRecorded, false)
  assert.equal((await runs.listRecords(project.id)).filter(r => r.runId === id).length, 1)
  assert.equal((await caps.recordAgentRun({ projectId: project.id, taskId, runId: id }) as any).alreadyRecorded, true) // idempotent, no duplicate
  assert.equal((await runs.listRecords(project.id)).filter(r => r.runId === id).length, 1)

  const rep: any = await caps.getRunReport(project.id, id)
  assert.equal(rep.recorded, true); assert.equal(rep.record.taskId, taskId); assert.equal(rep.record.registered.by, 'agent-report')
  assert.equal(rep.record.checkout.branch, wtBranch); assert.match(rep.record.checkout.head, /^[0-9a-f]{40}$/)
  assert.equal(rep.verdict.outcome, 'PASS'); assert.equal(rep.diagnosis.class, 'passed'); assert.equal(rep.verdict.humanValidation, 'PENDING')
  assert.equal(rep.freshness.state, 'current'); assert.equal(rep.usableAsCurrentEvidence, true)
  assert.ok(rep.evidence.files.some((f: any) => f.name === 'receipt.json'))
  assert.equal(rep.receipt.timeout.profile, 'smoke')

  // the result is about the commit it was recorded on: a later commit makes it stale
  put(wtPath, 'scenes/new.tscn', '[gd_scene format=3]\n'); git(wtPath, 'add', '-A'); git(wtPath, 'commit', '-qm', 'later work')
  const stale: any = await caps.getRunReport(project.id, id)
  assert.equal(stale.freshness.state, 'stale'); assert.equal(stale.usableAsCurrentEvidence, false); assert.match(stale.freshness.reason, /run again/i)
})

test('failing assertions, a blocked environment and a missing receipt are three different answers, never a pass', skip, async () => {
  const fail = hz.newRunId(); runStub(wtPath, 'res://tests/stairs_fail.tscn', fail)
  assert.equal((await caps.recordAgentRun({ projectId: project.id, taskId, runId: fail }) as any).ok, true)
  const f: any = await caps.getRunReport(project.id, fail)
  assert.equal(f.verdict.outcome, 'TEST_FAILED'); assert.equal(f.diagnosis.class, 'test-problem'); assert.equal(f.usableAsCurrentEvidence, false)

  const infra = hz.newRunId(); runStub(wtPath, 'res://tests/stairs_infra.tscn', infra)
  assert.equal((await caps.recordAgentRun({ projectId: project.id, taskId, runId: infra }) as any).ok, true)
  const i: any = await caps.getRunReport(project.id, infra)
  assert.equal(i.verdict.outcome, 'INFRA_BLOCKED'); assert.equal(i.diagnosis.class, 'infrastructure'); assert.match(i.diagnosis.nextStep, /nothing about the test|says nothing about the test/)

  const crash = hz.newRunId(); runStub(wtPath, 'res://tests/stairs_crash.tscn', crash)
  const r: any = await caps.recordAgentRun({ projectId: project.id, taskId, runId: crash })
  assert.equal(r.ok, false); assert.equal(r.code, 'no-receipt'); assert.match(r.message, /NOT proven/)
  const view: any = await caps.getRunReport(project.id, crash)
  assert.equal(view.verdict.outcome, 'NO_RECEIPT'); assert.equal(view.diagnosis.class, 'evidence-incomplete')
})

test('a run of another checkout is not evidence for the task: recording is refused', skip, async () => {
  const id = hz.newRunId(); runStub(repo, 'res://tests/stairs_pass.tscn', id) // the main checkout, not the task worktree
  const r: any = await caps.recordAgentRun({ projectId: project.id, taskId, runId: id })
  assert.equal(r.ok, false); assert.equal(r.code, 'wrong-checkout'); assert.match(r.message, /re-run with -Project/)
  assert.equal((await runs.listRecords(project.id)).some(x => x.runId === id), false)
})

test('malformed ids and unknown runs are refused clearly', skip, async () => {
  assert.equal(((await caps.getRunReport(project.id, '../../etc')) as any).code, 'bad-run-id')
  assert.equal(((await caps.recordAgentRun({ projectId: project.id, taskId, runId: 'x' })) as any).code, 'bad-run-id')
  assert.equal(((await caps.recordAgentRun({ projectId: project.id, taskId, runId: '20200101T000000Z-00000000' })) as any).code, 'no-receipt')
})

test('a Harness that is not configured is reported as infrastructure, with no guessed actions', skip, async () => {
  const keep = process.env.GODOT_HARNESS_DIR
  process.env.GODOT_HARNESS_DIR = join(root, 'does-not-exist')
  try {
    const c: any = await capsOf({ test: 'tests/stairs_pass.tscn' })
    assert.equal(c.ok, true); assert.equal(c.ready, false); assert.equal(c.actions, null); assert.equal(c.run, null)
    assert.match(c.blockers.join(' '), /harness-missing/)
    assert.equal(c.plan.problems[0].code, 'harness-unavailable'); assert.equal(c.plan.problems[0].kind, 'infrastructure')
    assert.ok(c.tests.scenes.length > 0) // test discovery does not depend on the Harness
  } finally { process.env.GODOT_HARNESS_DIR = keep }
})

test('the agent brief for a Godot project points at the contract tools; a non-Godot project gets nothing', async () => {
  const { buildAiResolvePrompt } = await import('../src/services/aiResolvePrompt.js')
  const task: any = { id: 't', title: 'x', description: '', priority: 'low', projectId: project.id }
  const godot = buildAiResolvePrompt(task, { ...project, path: repo }, 5420, undefined, repo)
  for (const s of ['get_godot_capabilities', 'get_godot_run', 'record_godot_run', 'Never invent an -OverrideReason', 'not gameplay approval']) assert.ok(godot.includes(s), s)
  assert.equal(godot.includes('-Action playtest'), false)
  const plain = buildAiResolvePrompt(task, { ...project, path: root }, 5420, undefined, root)
  assert.equal(plain.includes('get_godot_capabilities'), false)
})

test('the MCP server exposes the three tools; the two readers are read-only', async () => {
  const { MCP_TOOLS } = await import('../src/services/mcpServer.js')
  const by = (n: string) => MCP_TOOLS.find((t: any) => t.name === n) as any
  assert.equal(by('get_godot_capabilities').annotations.readOnlyHint, true)
  assert.equal(by('get_godot_run').annotations.readOnlyHint, true)
  assert.ok(by('record_godot_run')); assert.equal(by('record_godot_run').annotations.readOnlyHint, undefined)
  assert.equal(MCP_TOOLS.some((t: any) => /accept|approve|integrate|run_godot|start_godot/.test(t.name)), false) // still no tool that starts or accepts
})

test('MCP notifications get 202 and no body (Codex drops a server that answers 200 "null")', async () => {
  const { saveMcpConfig } = await import('../src/services/mcpConfig.js')
  await saveMcpConfig({ enabled: true, requireAuth: false })
  const Fastify = (await import('fastify')).default
  const app = Fastify()
  await app.register((await import('../src/routes/mcp.js')).mcpRoutes)
  const post = (payload: any) => app.inject({ method: 'POST', url: '/mcp', payload })
  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(note.statusCode, 202); assert.equal(note.body, '')
  const call = await post({ jsonrpc: '2.0', id: 1, method: 'ping' })
  assert.equal(call.statusCode, 200); assert.equal(call.json().id, 1)
  const mixed = await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'ping' }])
  assert.deepEqual(mixed.json().map((r: any) => r.id), [2])
  await app.close()
})
