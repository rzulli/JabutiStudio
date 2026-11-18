/**
 * Scope of the Godot/Harness close blockers and the way out of them. Real disposable repos; no process is stopped.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-enfs-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-enfs-'))
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

before(async () => {
  wt = await import('../src/services/worktreeService.js')
  tstore = await import('../src/services/taskStore.js')
  pd = await import('../src/services/projectDiscovery.js')
  lc = await import('../src/services/taskLifecycle.js')
  closer = await import('../src/services/worktreeClose.js')
  instances = await import('../src/services/godot/instances.js')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt') })
})
after(() => { for (const c of children) try { c.kill() } catch { /* gone */ } rmSync(parent, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }) })

const children: ChildProcess[] = []
function sleeper(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' })
  children.push(c)
  return c
}

// Integrated task with its own worktree, clean, no sessions.
async function integrated(p: any, title: string) {
  const t0 = await tstore.createTask(p.id, { title, description: 'scope', status: 'in_progress' } as any)
  const w = await wt.ensureTaskWorktree(p, t0)
  put(w.path!, `scripts/${title.replace(/\W+/g, '_')}.gd`, 'extends Node\n')
  commit(w.path!, `work ${title}`)
  await tstore.updateTask(p.id, t0.id, { status: 'done', resolution: 'test' } as any)
  const t = (await tstore.getTask(p.id, t0.id))!
  const head = git(w.path!, 'rev-parse', 'HEAD')
  await lc.accept(p, t, { targetBranch: 'main', expectedHeadSha: head, sessions: [] } as any)
  const integ = await lc.integrate(p, t, { targetBranch: 'main', expectedHeadSha: head, branch: w.branch, sessions: [] } as any)
  assert.equal((integ as any).ok, true, 'integrate')
  return (await tstore.getTask(p.id, t.id))!
}

test('a Godot window in one worktree does not block the close of an independent worktree of the same project', async () => {
  const p = await project(mkRepo())
  const a = await integrated(p, 'scope a')
  const b = await integrated(p, 'scope b')
  const proc = sleeper()
  instances.rememberInstance(a.worktreePath!, 'editor', proc.pid!)
  const prevB = await closer.previewClose(p, b, { sessions: [] } as any)
  assert.equal(prevB.checks.find(c => c.code === 'no-processes')?.ok, true, 'B is not blocked by A')
  const prevA = await closer.previewClose(p, a, { sessions: [] } as any)
  assert.equal(prevA.checks.find(c => c.code === 'no-processes')?.ok, false, 'A is blocked by its own window')
  proc.kill()
})

test('an unknown Harness record in one worktree does not block a different worktree', async () => {
  const p = await project(mkRepo())
  const a = await integrated(p, 'unknown a')
  const b = await integrated(p, 'unknown b')
  mkdirSync(join(dataDir, 'godot-runs'), { recursive: true })
  writeFileSync(join(dataDir, 'godot-runs', `${p.id}.json`), JSON.stringify({ runs: [{ runId: '20260101T000000Z-bbbbbbbb', projectId: p.id, action: 'test', checkout: { path: a.worktreePath! }, startedAt: '2026-01-01T00:00:00Z' }] }))
  const prevB = await closer.previewClose(p, b, { sessions: [] } as any)
  assert.equal(prevB.checks.find(c => c.code === 'process-unknown')?.ok, true)
  const prevA = await closer.previewClose(p, a, { sessions: [] } as any)
  assert.equal(prevA.checks.find(c => c.code === 'process-unknown')?.ok, false)
})

test('the explicit acknowledgement for an unknown Harness record closes the worktree; nothing else is skipped', async () => {
  const p = await project(mkRepo())
  const t = await integrated(p, 'ack close')
  mkdirSync(join(dataDir, 'godot-runs'), { recursive: true })
  writeFileSync(join(dataDir, 'godot-runs', `${p.id}.json`), JSON.stringify({ runs: [{ runId: '20260101T000000Z-cccccccc', projectId: p.id, action: 'scene', checkout: { path: t.worktreePath! }, startedAt: '2026-01-01T00:00:00Z' }] }))
  const prev = await closer.previewClose(p, t, { sessions: [] } as any)
  const refused = await closer.closeTask(p, t, { expectedToken: prev.token, sessions: [] } as any)
  assert.equal((refused as any).code, 'process-unknown')
  const ok = await closer.closeTask(p, t, { expectedToken: prev.token, acknowledgeUnknownProcesses: true, sessions: [] } as any)
  assert.equal((ok as any).ok, true)
  assert.equal(existsSync(t.worktreePath!), false)
})
