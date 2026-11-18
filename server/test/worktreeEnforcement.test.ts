/**
 * Worktree enforcement (audit follow-up to the R2 worktree work). Real, disposable Git repositories and the
 * real services; nothing touches a real project. Each test names the audit scenario it reproduces (S3, S4, S8, ...).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-enf-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-enf-'))
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim()
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
const commit = (cwd: string, msg: string) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg) }

let wt: typeof import('../src/services/worktreeService.js')
let tstore: typeof import('../src/services/taskStore.js')
let pd: typeof import('../src/services/projectDiscovery.js')
let lc: typeof import('../src/services/taskLifecycle.js')
let closer: typeof import('../src/services/worktreeClose.js')
let instances: typeof import('../src/services/godot/instances.js')

let seq = 0
function mkRepo(): string {
  const dir = join(parent, `repo${++seq}`)
  put(dir, 'project.godot', 'config_version=5\n')
  put(dir, 'scripts/a.gd', 'extends Node\n')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't')
  commit(dir, `base ${seq} ${Date.now()}`)
  return dir
}
async function project(dir: string) {
  await pd.addProjects([dir])
  const p = (await pd.getProjects()).find(x => x.name === dir.split(/[\\/]/).pop())
  if (!p) throw new Error('project not registered')
  return p
}
const task = async (projectId: string, title: string, status: any = 'in_progress') =>
  tstore.createTask(projectId, { title, description: 'enforcement test', status } as any)

before(async () => {
  wt = await import('../src/services/worktreeService.js')
  tstore = await import('../src/services/taskStore.js')
  pd = await import('../src/services/projectDiscovery.js')
  lc = await import('../src/services/taskLifecycle.js')
  closer = await import('../src/services/worktreeClose.js')
  instances = await import('../src/services/godot/instances.js')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
})
after(() => { rmSync(parent, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }) })

const children: ChildProcess[] = []
after(() => { for (const c of children) try { c.kill() } catch { /* already gone */ } })
function sleeper(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' })
  children.push(c)
  return c
}

// Creates a task, gives it a worktree, commits there, marks it done, accepts the commit and integrates it.
async function integratedTask(p: any, title: string) {
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt') })
  const t0 = await task(p.id, title)
  const w = await wt.ensureTaskWorktree(p, t0)
  put(w.path!, `scripts/${title.replace(/\W+/g, '_')}.gd`, 'extends Node\n')
  commit(w.path!, `work ${title}`)
  await tstore.updateTask(p.id, t0.id, { status: 'done', resolution: 'test' } as any)
  const t = (await tstore.getTask(p.id, t0.id))!
  const head = git(w.path!, 'rev-parse', 'HEAD')
  const acc = await lc.accept(p, t, { targetBranch: 'main', expectedHeadSha: head, sessions: [] } as any)
  assert.equal((acc as any).ok, true, 'accept')
  const integ = await lc.integrate(p, t, { targetBranch: 'main', expectedHeadSha: head, branch: w.branch, sessions: [] } as any)
  assert.equal((integ as any).ok, true, 'integrate')
  return (await tstore.getTask(p.id, t.id))!
}

// ---------- S3 / P0 1: the same task launched twice at once ----------
test('S3 concurrent launches of one task never get the main checkout', async () => {
  const p = await project(mkRepo())
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt-s3') })
  const t = await task(p.id, 'racy launch')
  // Both callers hold the task as it was before any worktree existed (the stale object the audit used).
  const results = await Promise.allSettled([wt.ensureTaskWorktree(p, t), wt.ensureTaskWorktree(p, t)])
  for (const r of results) {
    if (r.status === 'fulfilled') {
      assert.notEqual(r.value.path, p.path, 'a launch must never receive the main checkout when a worktree is required')
      assert.ok(r.value.path.includes('wt-s3'), 'launch goes to the task worktree')
    } else {
      assert.ok(wt.isCheckoutUnavailable(r.reason), `unexpected error: ${r.reason}`)
    }
  }
  const recorded = (await tstore.getTask(p.id, t.id))!.worktreePath
  assert.ok(recorded, 'the worktree was recorded')
  assert.equal(results.filter(r => r.status === 'fulfilled').length >= 1, true, 'at least one launch succeeds')
})

test('S3b the same task launched twice in sequence reuses one worktree', async () => {
  const p = await project(mkRepo())
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt-s3b') })
  const t = await task(p.id, 'sequential')
  const a = await wt.ensureTaskWorktree(p, t)
  const b = await wt.ensureTaskWorktree(p, (await tstore.getTask(p.id, t.id))!)
  assert.equal(a.path, b.path)
  assert.equal(b.created, false)
})

// ---------- P0 1: a required worktree that cannot be created fails, never falls back ----------
test('a required worktree that cannot be created fails explicitly instead of returning the main checkout', async () => {
  const p = await project(mkRepo())
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt-fail') })
  const t = await task(p.id, 'creation fails')
  // A recorded path that does not exist and no recovery requested: the launch must be refused, never run in main.
  const forced = await tstore.updateTask(p.id, t.id, { worktreePath: join(parent, 'wt-fail', 'nope') } as any)
  await assert.rejects(wt.ensureTaskWorktree(p, forced!), (e: any) => wt.isCheckoutUnavailable(e))
  // Creation that git refuses (base folder is a file) must also fail explicitly for a required worktree.
  const blocker = join(parent, 'not-a-dir'); writeFileSync(blocker, 'x')
  await wt.saveConfig({ enabled: true, basePath: join(blocker, 'sub') })
  const t2 = await task(p.id, 'cannot create')
  await assert.rejects(wt.ensureTaskWorktree(p, t2), (e: any) => wt.isCheckoutUnavailable(e))
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt') })
})

// ---------- P0 4: a recorded worktree that disappeared is not silently recreated ----------
test('S4 a recorded worktree that disappeared is not recreated silently', async () => {
  const p = await project(mkRepo())
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt-s4') })
  const t = await task(p.id, 'vanishing')
  const w = await wt.ensureTaskWorktree(p, t)
  writeFileSync(join(w.path, 'scripts/a.gd'), 'uncommitted edit\n')
  rmSync(w.path, { recursive: true, force: true })
  const err = await wt.ensureTaskWorktree(p, (await tstore.getTask(p.id, t.id))!).then(() => null, (e: any) => e)
  assert.ok(err && wt.isCheckoutUnavailable(err), 'launch must be refused with a checkout-unavailable error')
  assert.equal(err.code, 'worktree-missing')
  assert.equal(existsSync(w.path), false, 'the folder must not be recreated without an explicit recovery')
})

test('S4b explicit recovery recreates from the committed branch and says so; it promises no uncommitted work', async () => {
  const p = await project(mkRepo())
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt-s4b') })
  const t = await task(p.id, 'recover me')
  const w = await wt.ensureTaskWorktree(p, t)
  put(w.path, 'scripts/committed.gd', 'extends Node\n')
  commit(w.path, 'committed work')
  rmSync(w.path, { recursive: true, force: true })
  const r = await wt.ensureTaskWorktree(p, (await tstore.getTask(p.id, t.id))!, { recover: true })
  assert.equal(r.recovered, true)
  assert.equal(r.created, true)
  assert.equal(existsSync(join(r.path, 'scripts/committed.gd')), true, 'committed work is back')
  assert.match(r.recoveryNote ?? '', /uncommitted/i, 'the result warns that uncommitted changes are not recovered')
})

// ---------- policy preserved: Direct Checkout stays available ----------
test('P5 with worktrees off and no recorded worktree the task keeps using the project folder (Direct Checkout)', async () => {
  const p = await project(mkRepo())
  await wt.saveConfig({ enabled: false, basePath: join(parent, 'wt-off') })
  const t = await task(p.id, 'direct')
  const r = await wt.ensureTaskWorktree(p, t)
  assert.equal(r.path, p.path)
  assert.equal(r.reason, 'disabled')
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt') })
})

// ---------- P0 2: integration with unknown-activity sessions ----------
test('S8 a silent (state null) session on the task blocks integration until explicitly resolved; busy never ack-able', async () => {
  const p = await project(mkRepo())
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt-s8') })
  const t0 = await task(p.id, 'silent codex')
  const w = await wt.ensureTaskWorktree(p, t0)
  put(w.path!, 'scripts/codex.gd', 'extends Node\n'); commit(w.path!, 'codex work')
  await tstore.updateTask(p.id, t0.id, { status: 'done', resolution: 'x' } as any)
  const t = (await tstore.getTask(p.id, t0.id))!
  const head = git(w.path!, 'rev-parse', 'HEAD')
  await lc.accept(p, t, { targetBranch: 'main', expectedHeadSha: head, sessions: [] } as any)
  const silent = [{ id: 's-codex', taskId: t.id, agent: 'codex', type: 'codex', state: null, cwd: w.path! }]
  const refused = await lc.integrate(p, t, { targetBranch: 'main', expectedHeadSha: head, branch: w.branch, sessions: silent as any } as any)
  assert.equal((refused as any).ok, false, 'unknown activity must not integrate silently')
  assert.equal((refused as any).code, 'blocked')
  assert.match(JSON.stringify(refused), /activity-unknown|unknown activity/i)
  assert.equal(git(p.path, 'rev-parse', 'main') !== head, true, 'target untouched')

  const busy = [{ ...silent[0], state: 'busy' }]
  const busyRefused = await lc.integrate(p, t, { targetBranch: 'main', expectedHeadSha: head, branch: w.branch, sessions: busy as any, acknowledgeUnknownActivity: true } as any)
  assert.equal((busyRefused as any).ok, false, 'proven activity is never acknowledged away')

  const ok = await lc.integrate(p, t, { targetBranch: 'main', expectedHeadSha: head, branch: w.branch, sessions: silent as any, acknowledgeUnknownActivity: true } as any)
  assert.equal((ok as any).ok, true, 'an explicit acknowledgement lets an idle interactive session not block forever')
})

test('S8b integration revalidates the dirty state of the worktree right before merging', async () => {
  const p = await project(mkRepo())
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt-s8b') })
  const t0 = await task(p.id, 'dirty before merge')
  const w = await wt.ensureTaskWorktree(p, t0)
  put(w.path!, 'scripts/x.gd', 'extends Node\n'); commit(w.path!, 'x')
  await tstore.updateTask(p.id, t0.id, { status: 'done', resolution: 'x' } as any)
  const t = (await tstore.getTask(p.id, t0.id))!
  const head = git(w.path!, 'rev-parse', 'HEAD')
  await lc.accept(p, t, { targetBranch: 'main', expectedHeadSha: head, sessions: [] } as any)
  writeFileSync(join(w.path!, 'scripts/late.gd'), 'untracked after review\n')
  const before = git(p.path, 'rev-parse', 'main')
  const r = await lc.integrate(p, t, { targetBranch: 'main', expectedHeadSha: head, branch: w.branch, sessions: [] } as any)
  assert.equal((r as any).ok, false)
  assert.equal(git(p.path, 'rev-parse', 'main'), before, 'nothing merged')
})

// ---------- P0 3: Godot and Harness processes in the close preview ----------
test('S7 a Godot window tracked by Shipyard in the worktree blocks the close; it is listed as running', async () => {
  const p = await project(mkRepo())
  const t = await integratedTask(p, 'godot gui')
  const path = t.worktreePath!
  const proc = sleeper()
  instances.rememberInstance(path, 'editor', proc.pid!)
  const prev = await closer.previewClose(p, t, { sessions: [] } as any)
  assert.equal(prev.allowed, false)
  assert.ok(prev.checks.find(c => c.code === 'no-processes' && !c.ok), 'process check must fail')
  proc.kill()
  await new Promise(r => setTimeout(r, 200))
  const after = await closer.previewClose(p, t, { sessions: [] } as any)
  assert.equal(after.checks.find(c => c.code === 'no-processes')?.ok, true)
})

test('S7b a process that starts between review and close makes the close refuse with state-changed', async () => {
  const p = await project(mkRepo())
  const t = await integratedTask(p, 'late process')
  const reviewed = await closer.previewClose(p, t, { sessions: [] } as any)
  const proc = sleeper()
  instances.rememberInstance(reviewed.worktree.path!, 'play', proc.pid!)
  const res = await closer.closeTask(p, t, { expectedToken: reviewed.token, sessions: [] } as any)
  assert.equal((res as any).ok, false)
  assert.equal((res as any).code, 'state-changed')
  proc.kill()
})

test('S7c an unknown Harness run (persisted, no receipt, not tracked live) requires explicit acknowledgement to close', async () => {
  const p = await project(mkRepo())
  const t = await integratedTask(p, 'unknown run')
  // A run record written by an earlier server process: no receipt, and no live entry in this one.
  mkdirSync(join(dataDir, 'godot-runs'), { recursive: true })
  writeFileSync(join(dataDir, 'godot-runs', `${p.id}.json`), JSON.stringify({ runs: [{ runId: '20260101T000000Z-aaaaaaaa', projectId: p.id, action: 'scene', checkout: { path: t.worktreePath! }, startedAt: '2026-01-01T00:00:00Z' }] }))
  const prev = await closer.previewClose(p, t, { sessions: [] } as any)
  assert.equal(prev.allowed, false)
  assert.ok(prev.checks.find(c => c.code === 'process-unknown' && !c.ok), 'unknown process is reported, not declared absent')
})

test('Process check never says "none" when it cannot know: the message names what is not tracked', async () => {
  const p = await project(mkRepo())
  const t = await integratedTask(p, 'honest message')
  const prev = await closer.previewClose(p, t, { sessions: [] } as any)
  const check = prev.checks.find(c => c.code === 'no-processes')
  assert.ok(check?.ok)
  assert.match(check!.message, /not tracked|opened by hand|restart/i)
})
