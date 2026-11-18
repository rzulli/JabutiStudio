/**
 * RC1 Context-Aware Godot Execution.
 * Real disposable Git repos and worktrees (path with spaces on purpose). The Harness is a stub runner with the same
 * interface and receipt shape as the real one (doctor / run / cancel), so receipts and failures are exercised without
 * launching Godot; the real Harness is covered by the manual Electron run in docs/agent/godot-execution.md.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'jabuti godot '))
const dataDir = join(root, 'data dir')
const repo = join(root, 'My Game')
const wtBase = join(root, 'work trees')
const harnessDir = join(root, 'harness')
process.env.SHIPYARD_DATA_DIR = dataDir
process.env.GODOT_HARNESS_DIR = harnessDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim()
const put = (base: string, rel: string, text: string) => { mkdirSync(dirname(join(base, rel)), { recursive: true }); writeFileSync(join(base, rel), text) }
const UI = { host: 'localhost:5420', origin: 'http://localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }
const hasPwsh = (() => { try { execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe' }); return true } catch { return false } })()

// The stub keys its behaviour on the test scene's file name: *pass*, *fail*, *import*, *slow*, *crash*.
const STUB = `
param([Parameter(Position=0)][string]$Action,[string]$Project,[string]$Test,[string]$Mode,[string]$Profile,[string]$Marker,[string]$RunId)
$root=Split-Path -Parent $PSScriptRoot
if($Action -eq 'doctor'){ @{status='READY';godot='C:\\fake\\godot.exe';version='4.7.2.stable.fake'}|ConvertTo-Json; exit 0 }
if($Action -eq 'cancel'){ Write-Output '{"status":"CANCELLED"}'; exit 0 }
if($Action -ne 'run'){ throw 'unsupported' }
if($Test -match 'crash'){ [Console]::Error.WriteLine('runner blew up before any receipt'); exit 7 }
$dir=Join-Path $root "runs/$RunId"; New-Item -ItemType Directory -Force -Path (Join-Path $dir 'screenshots')|Out-Null
if($Test -match 'slow'){ Start-Sleep -Seconds 3 }
$status='PASS';$assert='PASS';$failed=@();$cause=$null;$exit=0;$klass=$null
if($Test -match 'fail'){ $status='FAIL';$assert='FAIL';$failed=@('STAIR_TOP_REACHED');$cause="Expected marker missing or script exception/assertion failure: $Marker";$exit=1;$klass='TEST_FAILED' }
elseif($Test -match 'import'){ $status='IMPORT_FAILED';$assert='NOT_PROVEN';$cause='Godot cold import failed with exit code 1';$exit=$null }
elseif($Test -match 'plain'){ $status='FAIL';$assert='FAIL';$klass='TEST_FAILED';$cause="Expected marker missing or script exception/assertion failure: $Marker";$exit=0 }
Set-Content -LiteralPath (Join-Path $dir 'stdout.log') -Value "stub stdout for $Test"
Set-Content -LiteralPath (Join-Path $dir 'stderr.log') -Value ''
$receipt=[ordered]@{schema='godot-harness/2';run_id=$RunId;project=$Project;checkout=$Project;test=$Test;mode=$Mode;status=$status;failure_class=$klass;import=@{status='SKIPPED'};assertions=@{status=$assert;marker=$Marker;passed_count=$(if($assert -eq 'PASS'){1}else{0});failed_count=$failed.Count;passed=@();failed=$failed};process=@{status='EXITED';exit_code=$exit};artifacts=@{status='PASS';required=@()};failure_cause=$cause;paths=@{run=$dir;receipt=(Join-Path $dir 'receipt.json')}}
$receipt|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $dir 'receipt.json') -Encoding utf8
if($status -ne 'PASS'){ exit 1 }
`

let app: import('fastify').FastifyInstance
let project: any
let taskStore: typeof import('../src/services/taskStore.js')
let wt: typeof import('../src/services/worktreeService.js')
let ctxMod: typeof import('../src/services/godot/context.js')
let cls: typeof import('../src/services/godot/classify.js')
let hz: typeof import('../src/services/godot/harness.js')
let taskWithWt: { id: string; path: string; branch: string }
let taskNoWt: string

before(async () => {
  put(harnessDir, 'runner/godot-harness.ps1', STUB)
  put(repo, 'project.godot', 'config_version=5\n')
  put(repo, 'scenes/stair_traversal.tscn', '[gd_scene format=3]\n[node name="S" type="Node"]\n')
  put(repo, 'scenes/player.tscn', '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scripts/traversal_player.gd" id="1"]\n[node name="Player" type="Node"]\nscript = ExtResource("1")\n')
  put(repo, 'scripts/traversal_player.gd', 'extends Node\n')
  put(repo, 'scripts/lonely.gd', 'extends Node\n')
  put(repo, 'tests/traversal_pass.tscn', '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://tests/traversal_pass.gd" id="1"]\n[node name="T" type="Node"]\nscript = ExtResource("1")\n')
  put(repo, 'tests/traversal_pass.gd', 'extends Node\nconst P := "res://scripts/traversal_player.gd"\nfunc _ready(): print("HARNESS_ASSERTIONS_PASS")\n')
  put(repo, 'tests/traversal_fail.tscn', '[gd_scene format=3]\n[node name="T" type="Node"]\n')
  put(repo, 'tests/traversal_import.tscn', '[gd_scene format=3]\n[node name="T" type="Node"]\n')
  put(repo, 'tests/traversal_slow.tscn', '[gd_scene format=3]\n[node name="T" type="Node"]\n')
  put(repo, 'tests/traversal_crash.tscn', '[gd_scene format=3]\n[node name="T" type="Node"]\n')
  put(repo, 'tests/orphan_plain.gd', 'extends Node\n') // same stem as nothing: no scene attaches it
  put(repo, 'tests/lonely.tscn', '[gd_scene format=3]\n[node name="T" type="Node"]\n') // same name as scripts/lonely.gd? no: suggestion target for tests/lonely.gd
  put(repo, 'tests/lonely.gd', 'extends Node\n')
  put(repo, 'scenes/plain.tscn', '[gd_scene format=3]\n[node name="S" type="Node"]\n')
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  project = (await (await import('../src/services/projectDiscovery.js')).addProjects([repo]))[0]
  taskStore = await import('../src/services/taskStore.js')
  wt = await import('../src/services/worktreeService.js')
  ctxMod = await import('../src/services/godot/context.js')
  cls = await import('../src/services/godot/classify.js')
  hz = await import('../src/services/godot/harness.js')
  await wt.saveConfig({ enabled: true, basePath: wtBase })
  const t1 = await taskStore.createTask(project.id, { title: 'Stairs', description: '', priority: 'medium', status: 'in_progress' } as any)
  const w = await wt.ensureTaskWorktree(project, t1)
  assert.ok(w.created, w.reason)
  taskWithWt = { id: t1.id, path: w.path, branch: w.branch! }
  taskNoWt = (await taskStore.createTask(project.id, { title: 'No tree', description: '', priority: 'low', status: 'todo' } as any)).id
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/godot.js')).godotRoutes)
})
after(async () => { await app?.close(); try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* a runner child may still hold its folder on Windows */ } })

const base = () => `/api/projects/${project.id}/godot`
const get = (url: string) => app.inject({ method: 'GET', url: base() + url })
const post = (url: string, body: any, headers: any = UI) => app.inject({ method: 'POST', url: base() + url, headers, payload: body })
async function finished(runId: string) {
  for (let i = 0; i < 80; i++) {
    const v = (await get(`/runs/${runId}`)).json()
    if (!v.running) return v
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('run did not finish')
}

// 1-4: context resolution -----------------------------------------------------------------------------

test('1. a project-level action uses the selected checkout (the project folder) and says so', async () => {
  const c: any = await ctxMod.resolveContext({ projectId: project.id })
  assert.equal(c.ok, true)
  assert.equal(c.source, 'project'); assert.equal(c.isMainCheckout, true)
  assert.equal(c.checkoutPath, project.path)
  assert.equal(c.origin, 'project'); assert.equal(c.branch, 'main'); assert.match(c.head, /^[0-9a-f]{40}$/)
  assert.equal(c.reproducibleFromSha, true)
})

test('2. a task with a worktree resolves to exactly that worktree, with its branch and dirty state', async () => {
  const c: any = await ctxMod.resolveContext({ projectId: project.id, taskId: taskWithWt.id })
  assert.equal(c.ok, true)
  assert.equal(c.source, 'task'); assert.equal(c.isMainCheckout, false)
  assert.equal(ctxMod.sameCheckout(c.checkoutPath, taskWithWt.path), true)
  assert.equal(c.branch, taskWithWt.branch)
  put(taskWithWt.path, 'scenes/new_scene.tscn', '[gd_scene format=3]\n')
  const dirty: any = await ctxMod.resolveContext({ projectId: project.id, taskId: taskWithWt.id })
  assert.equal(dirty.dirty.count, 1); assert.equal(dirty.reproducibleFromSha, false)
  assert.match(dirty.notes.join(' '), /does not reproduce/)
  rmSync(join(taskWithWt.path, 'scenes/new_scene.tscn'))
})

test('3. a task without a worktree is not given one; the main checkout needs an explicit choice and is labelled', async () => {
  const c: any = await ctxMod.resolveContext({ projectId: project.id, taskId: taskNoWt })
  assert.equal(c.ok, false); assert.equal(c.code, 'task-without-worktree')
  assert.equal(c.options[0].checkout, 'main')
  const t = await taskStore.getTask(project.id, taskNoWt); assert.equal(t?.worktreePath, undefined) // nothing was created or linked
  const ok: any = await ctxMod.resolveContext({ projectId: project.id, taskId: taskNoWt, checkout: 'main' })
  assert.equal(ok.ok, true); assert.equal(ok.isMainCheckout, true); assert.match(ok.notes.join(' '), /no worktree/)
})

test('4. conflicting or broken contexts never run somewhere else silently', async () => {
  assert.equal(((await ctxMod.resolveContext({ projectId: project.id, checkout: 'task' })) as any).code, 'bad-selection')
  assert.equal(((await ctxMod.resolveContext({ projectId: project.id, checkout: 'elsewhere' as any })) as any).code, 'bad-selection')
  assert.equal(((await ctxMod.resolveContext({ projectId: project.id, taskId: 'nope' })) as any).code, 'task-not-found')
  assert.equal(((await ctxMod.resolveContext({ projectId: 'nope' })) as any).code, 'project-not-found')
  // The recorded folder is a real Godot project that Git does not list as this project's worktree.
  const stray = join(root, 'stray'); put(stray, 'project.godot', 'config_version=5\n')
  const t = await taskStore.createTask(project.id, { title: 'Stray', description: '', priority: 'low', status: 'todo' } as any)
  await taskStore.updateTask(project.id, t.id, { worktreePath: stray, worktreeBranch: 'x' })
  const unreg: any = await ctxMod.resolveContext({ projectId: project.id, taskId: t.id })
  assert.equal(unreg.code, 'worktree-unregistered')
  // A worktree folder that vanished: refused, main checkout offered only as an explicit option.
  await taskStore.updateTask(project.id, t.id, { worktreePath: join(root, 'gone'), worktreeBranch: 'x' })
  const gone: any = await ctxMod.resolveContext({ projectId: project.id, taskId: t.id })
  assert.equal(gone.code, 'worktree-missing'); assert.match(gone.message, /NOT used as a fallback/)
  const run = await post('/runs', { taskId: t.id, file: 'scenes/plain.tscn', action: 'scene' })
  assert.equal(run.statusCode, 409)
})

// 5-8: what a file is ---------------------------------------------------------------------------------

test('5. an ordinary .tscn is a runnable scene, not a test', async () => {
  const c = await cls.classify(repo, 'scenes/stair_traversal.tscn')
  assert.equal(c.kind, 'scene'); assert.equal(c.actions.runScene, true); assert.equal(c.actions.runTest, false)
})

test('6. a .tscn under tests/ is a test scene (Run Test), with a warning when nothing prints the marker', async () => {
  const c = await cls.classify(repo, 'tests/traversal_pass.tscn')
  assert.equal(c.kind, 'test-scene'); assert.equal(c.actions.runTest, true); assert.equal(c.actions.runScene, false)
  assert.equal(c.warnings.length, 0)
  const noMarker = await cls.classify(repo, 'tests/traversal_fail.tscn')
  assert.match(noMarker.warnings.join(' '), /never PASS/)
})

test('7. a plain .gd is never executed; neither is a script inside tests/', async () => {
  for (const file of ['scripts/traversal_player.gd', 'tests/traversal_pass.gd']) {
    for (const action of ['scene', 'test']) {
      const r = await post('/runs', { file, action })
      assert.equal(r.statusCode, 400, `${file} ${action}`); assert.equal(r.json().code, 'not-a-scene')
    }
  }
  const g = await cls.classify(repo, 'scripts/traversal_player.gd')
  assert.equal(g.kind, 'gameplay-script'); assert.equal(g.actions.runTest, false); assert.equal(g.actions.runScene, false); assert.equal(g.actions.runRelatedTest, false)
  assert.ok(g.relatedScenes.some(r => r.rel === 'scenes/player.tscn' && r.verified))
  assert.ok(g.relatedTests.some(r => r.rel === 'tests/traversal_pass.tscn' && r.verified), 'a test script naming the script leads to its test scene')
})

test('8. a test script runs only through a scene that provably attaches it; a same-name match is only a suggestion', async () => {
  const proven = await cls.classify(repo, 'tests/traversal_pass.gd')
  assert.equal(proven.kind, 'test-script'); assert.equal(proven.actions.runRelatedTest, true)
  assert.deepEqual(proven.relatedTests.map(r => [r.rel, r.verified]), [['tests/traversal_pass.tscn', true]])
  const inferred = await cls.classify(repo, 'tests/lonely.gd')
  assert.equal(inferred.actions.runRelatedTest, false); assert.equal(inferred.relatedTests.length, 0)
  assert.deepEqual(inferred.suggestions.map(r => [r.rel, r.verified]), [['tests/lonely.tscn', false]])
  // Asking the server to run the suggestion as "related" is refused.
  if (hasPwsh) {
    const refused = await post('/runs', { file: 'tests/lonely.tscn', action: 'test', via: 'tests/lonely.gd' })
    assert.equal(refused.statusCode, 400); assert.equal(refused.json().code, 'unproven-relation')
  }
})

// 11: containment & UI-only --------------------------------------------------------------------------------

test('11. paths that leave the checkout, absolute paths and caller-supplied directories are refused', async () => {
  for (const file of ['../outside.tscn', 'res://../../x.tscn', 'C:/Windows/system.tscn', '/etc/passwd.tscn', 'scenes\\..\\..\\x.tscn', '.git/config', 'scenes/missing.tscn']) {
    const c: any = await ctxMod.resolveContext({ projectId: project.id, file })
    assert.equal(c.ok, false, file); assert.ok(['bad-file', 'file-missing'].includes(c.code), `${file} -> ${c.code}`)
  }
  const route = await get(`/context?file=${encodeURIComponent('../x.tscn')}`)
  assert.equal(route.json().context.ok, false)
  const r = await post('/runs', { file: 'scenes/plain.tscn', action: 'scene', worktreePath: root, checkoutPath: root, projectPath: root })
  if (hasPwsh) { assert.equal(r.statusCode, 200); assert.equal(ctxMod.sameCheckout(r.json().record.checkout.path, project.path), true, 'a directory sent by the client is ignored'); await finished(r.json().record.runId) }
})

test('only the app UI may open Godot or start/cancel a run; reads stay open', async () => {
  const noUi = { host: 'localhost:5420' }
  assert.equal((await post('/runs', { file: 'scenes/plain.tscn', action: 'scene' }, noUi)).statusCode, 403)
  assert.equal((await post('/open', { file: 'scenes/plain.tscn' }, noUi)).statusCode, 403)
  assert.equal((await post('/runs/20260101T000000Z-aaaaaaaa/cancel', {}, noUi)).statusCode, 403)
  assert.equal((await get('/context?file=scenes/plain.tscn')).statusCode, 200)
})

test('Open in Godot: editor arguments carry the resolved checkout and scene as separate arguments; a missing Godot is an explained error', async () => {
  const runs = await import('../src/services/godot/runs.js')
  const c: any = await ctxMod.resolveContext({ projectId: project.id, taskId: taskWithWt.id, file: 'tests/traversal_pass.tscn' })
  const { args, scene } = runs.editorArgs(c)
  assert.deepEqual(args, ['--path', c.checkoutPath, '--editor', 'tests/traversal_pass.tscn']); assert.equal(scene, 'tests/traversal_pass.tscn')
  assert.equal(ctxMod.sameCheckout(args[1], taskWithWt.path), true)
  const script: any = await ctxMod.resolveContext({ projectId: project.id, file: 'scripts/lonely.gd' })
  assert.deepEqual(runs.editorArgs(script).args, ['--path', project.path, '--editor'])
  // The stub doctor reports a godot that does not exist: the launch error is explained, nothing is retried elsewhere.
  if (hasPwsh) {
    const r = await post('/open', { taskId: taskWithWt.id, file: 'tests/traversal_pass.tscn' })
    assert.equal(r.statusCode, 500); assert.equal(r.json().code, 'launch-failed'); assert.match(r.json().message, /fake/)
  }
})

// 9, 10, 12: runs through the Harness --------------------------------------------------------------------------

test('9/10. a test runs in the task worktree (path with spaces) and its receipt stays tied to the run, task and checkout', { skip: !hasPwsh }, async () => {
  put(taskWithWt.path, 'notes.txt', 'uncommitted\n') // dirty at start
  const res = await post('/runs', { taskId: taskWithWt.id, file: 'tests/traversal_pass.tscn', action: 'test', via: 'tests/traversal_pass.gd', origin: 'editor' })
  assert.equal(res.statusCode, 200, res.body)
  const rec = res.json().record
  assert.match(rec.runId, /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/)
  assert.equal(rec.taskId, taskWithWt.id); assert.equal(rec.checkout.source, 'task'); assert.equal(rec.checkout.branch, taskWithWt.branch)
  assert.equal(ctxMod.sameCheckout(rec.checkout.path, taskWithWt.path), true)
  assert.equal(rec.checkout.dirtyAtStart.count, 1); assert.equal(rec.checkout.reproducibleFromSha, false)
  assert.equal(rec.via, 'tests/traversal_pass.gd'); assert.equal(rec.params.profile, 'smoke'); assert.equal(rec.params.marker, 'HARNESS_ASSERTIONS_PASS')
  const view = await finished(rec.runId)
  assert.equal(view.receipt.run_id, rec.runId)
  assert.equal(ctxMod.sameCheckout(view.receipt.checkout, taskWithWt.path), true, 'the receipt ran the worktree with spaces, not the main checkout')
  assert.ok(taskWithWt.path.includes(' '), 'fixture path has spaces')
  assert.equal(view.provenanceMismatch, null)
  assert.equal(view.verdict.outcome, 'PASS'); assert.equal(view.verdict.assertions, 'VERIFIED'); assert.equal(view.verdict.humanValidation, 'PENDING'); assert.equal(view.verdict.visualEvidence, 'NONE')
  // Results are reachable from the file that started them, and from a script related to it.
  const byFile = (await get(`/runs?file=${encodeURIComponent('tests/traversal_pass.tscn')}`)).json().runs
  assert.ok(byFile.some((r: any) => r.record.runId === rec.runId))
  const byScript = (await get(`/runs?file=${encodeURIComponent('tests/traversal_pass.gd')}`)).json().runs
  assert.ok(byScript.some((r: any) => r.record.runId === rec.runId))
  const log = await get(`/runs/${rec.runId}/evidence?name=stdout.log`)
  assert.match(log.body, /stub stdout/)
  assert.equal((await get(`/runs/${rec.runId}/evidence?name=${encodeURIComponent('../../etc/passwd')}`)).statusCode, 400)
  assert.equal((await get(`/runs/${rec.runId}/evidence?name=receipt.json`)).statusCode, 200)
  rmSync(join(taskWithWt.path, 'notes.txt'))
})

test('12. harness failures are never shown as PASS', { skip: !hasPwsh }, async () => {
  const expected: [string, string, string][] = [
    ['tests/traversal_fail.tscn', 'test', 'TEST_FAILED'],
    ['tests/traversal_import.tscn', 'test', 'IMPORT_FAILED'],
    ['tests/traversal_crash.tscn', 'test', 'NO_RECEIPT'],
    ['scenes/plain.tscn', 'scene', 'NO_ASSERTIONS'],
  ]
  for (const [file, action, outcome] of expected) {
    const res = await post('/runs', { file, action })
    assert.equal(res.statusCode, 200, res.body)
    const v = await finished(res.json().record.runId)
    assert.equal(v.verdict.outcome, outcome, file); assert.notEqual(v.verdict.outcome, 'PASS')
    assert.ok(v.verdict.reason, `${file} states a reason`)
    assert.notEqual(v.verdict.assertions, 'VERIFIED')
  }
  const failed = await finished((await post('/runs', { file: 'tests/traversal_fail.tscn', action: 'test' })).json().record.runId)
  assert.deepEqual(failed.receipt.assertions.failed, ['STAIR_TOP_REACHED']); assert.equal(failed.verdict.assertions, 'FAILED')
  const crashed = await finished((await post('/runs', { file: 'tests/traversal_crash.tscn', action: 'test' })).json().record.runId)
  assert.match(crashed.verdict.reason, /blew up/)
  assert.equal(crashed.receipt, null)
})

test('a second run in a checkout that is still running is refused', { skip: !hasPwsh }, async () => {
  const first = await post('/runs', { file: 'tests/traversal_slow.tscn', action: 'test' })
  assert.equal(first.statusCode, 200)
  const second = await post('/runs', { file: 'tests/traversal_pass.tscn', action: 'test' })
  assert.equal(second.statusCode, 409); assert.equal(second.json().code, 'run-active')
  // A different checkout is independent.
  const other = await post('/runs', { taskId: taskWithWt.id, file: 'scenes/plain.tscn', action: 'scene' })
  assert.equal(other.statusCode, 200)
  assert.equal((await finished(first.json().record.runId)).running, false)
  await finished(other.json().record.runId)
})

test('Run Test is refused for a plain scene, Run Scene for a test scene', async () => {
  const a = await post('/runs', { file: 'scenes/plain.tscn', action: 'test' }); assert.equal(a.json().code, 'not-a-test')
  const b = await post('/runs', { file: 'tests/traversal_pass.tscn', action: 'scene' }); assert.equal(b.json().code, 'not-a-plain-scene')
})

test('a missing Harness is an explained error and nothing starts', async () => {
  const keep = process.env.GODOT_HARNESS_DIR
  process.env.GODOT_HARNESS_DIR = join(root, 'no-such-harness')
  try {
    const r = await post('/runs', { file: 'scenes/plain.tscn', action: 'scene' })
    assert.equal(r.statusCode, 409); assert.equal(r.json().code, 'harness-missing'); assert.match(r.json().message, /no-such-harness/)
    assert.equal(((await get('/status')).json() as any).harness.ready, false)
  } finally { process.env.GODOT_HARNESS_DIR = keep }
})

test('verdict: PASS needs the receipt, its assertions and exit 0 together', () => {
  const v = (receipt: any, extra: any = {}) => hz.deriveVerdict({ receipt, running: false, action: 'test', screenshots: 0, ...extra })
  assert.equal(v({ status: 'PASS', assertions: { status: 'PASS' }, process: { exit_code: 0 } }).outcome, 'PASS')
  assert.notEqual(v({ status: 'PASS', assertions: { status: 'NOT_PROVEN' }, process: { exit_code: 0 } }).outcome, 'PASS')
  assert.notEqual(v({ status: 'PASS', assertions: { status: 'PASS' }, process: { exit_code: 1 } }).outcome, 'PASS')
  assert.equal(v({ status: 'SCRIPT_RUNTIME_FAILED', failure_cause: 'x' }).outcome, 'SCRIPT_FAILED')
  assert.equal(v({ status: 'FOCUS_BLOCKED' }).outcome, 'FOCUS_BLOCKED')
  assert.equal(v({ status: 'CANCELLED' }).outcome, 'CANCELLED')
  assert.equal(v({ status: 'TIMEOUT' }).outcome, 'TIMEOUT')
  assert.equal(v(null, { runner: { exitCode: null, error: 'spawn ENOENT' } }).outcome, 'LAUNCH_FAILED')
  assert.equal(v(null, { running: true }).outcome, 'RUNNING')
  assert.equal(v({ status: 'PASS', assertions: { status: 'PASS' }, process: { exit_code: 0 } }, { screenshots: 2 }).visualEvidence, 'AVAILABLE')
})

// Addendum: Play Game, duplicate-window guard, shared-checkout warnings ----------------------------------------

test('Play Game needs a main scene, is UI-only, and is never a Harness run', { skip: !hasPwsh }, async () => {
  const runs = await import('../src/services/godot/runs.js')
  assert.equal((await post('/play', {}, { host: 'localhost:5420' })).statusCode, 403)
  const none = await post('/play', {})
  assert.equal(none.statusCode, 409); assert.equal(none.json().code, 'no-main-scene')
  const pg = join(project.path, 'project.godot')
  const before = readFileSync(pg, 'utf-8')
  writeFileSync(pg, `${before}\n[application]\nrun/main_scene="res://scenes/plain.tscn"\n`)
  try {
    assert.equal(await runs.mainScene(project.path), 'res://scenes/plain.tscn')
    // The stub doctor reports a Godot that does not exist: explained error, no run record, no fallback.
    const r = await post('/play', {})
    assert.equal(r.statusCode, 500); assert.equal(r.json().code, 'launch-failed')
    assert.equal((await runs.listRecords(project.id)).filter(x => x.file === 'res://scenes/plain.tscn' && (x as any).action === 'play').length, 0)
  } finally { writeFileSync(pg, before) }
})

test('the same Godot window is not started twice for one checkout', { skip: !hasPwsh }, async () => {
  const inst = await import('../src/services/godot/instances.js')
  inst.rememberInstance(project.path, 'play', process.pid) // a live pid stands in for an open window
  try {
    const r = await post('/play', {})
    assert.equal(r.statusCode, 409); assert.equal(r.json().code, 'already-running'); assert.match(r.json().message, new RegExp(`pid ${process.pid}`))
    // The editor on the same checkout is a different window.
    assert.equal(inst.runningInstance(project.path, 'editor'), null)
    assert.equal(inst.runningInstance(taskWithWt.path, 'play'), null)
  } finally { inst.rememberInstance(project.path, 'play', 2 ** 22 + 7) } // a dead pid: the guard forgets it
  assert.equal(inst.runningInstance(project.path, 'play'), null)
})

test('warnings name agents that may change files, silent CLIs and other tasks sharing the checkout', async () => {
  const { sessionWarnings } = await import('../src/services/godot/instances.js')
  assert.deepEqual(sessionWarnings([], 't1'), [])
  assert.deepEqual(sessionWarnings([{ id: 's', state: 'idle', taskId: 't1' }], 't1'), [])
  const w = sessionWarnings([
    { id: 'a', state: 'busy', agent: 'claude', taskId: 't1' },
    { id: 'b', state: null, agent: 'codex', taskId: 't2', taskNumber: 2 },
  ], 't1')
  assert.equal(w.length, 3)
  assert.match(w[0], /working in this checkout right now \(claude\)/)
  assert.match(w[1], /do not report whether they are working \(codex\)/)
  assert.match(w[2], /shared with other task\(s\): #2/)
})
