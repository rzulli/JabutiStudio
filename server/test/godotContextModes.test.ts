/**
 * Godot execution context for the three kinds of task that can reach Review without a worktree path:
 *  - Direct Checkout (worktrees off, none recorded): runs in the project folder, as it always did;
 *  - unknown checkout mode (worktrees on, none recorded): refused, the main checkout only by an explicit choice;
 *  - worktree recorded but its folder gone: refused, never served from the main checkout.
 * Real disposable repo; nothing outside the temp dirs is touched.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-godotmode-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-godotmode-'))
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim()
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
const commit = (cwd: string, msg: string) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg) }

let wt: typeof import('../src/services/worktreeService.js')
let tstore: typeof import('../src/services/taskStore.js')
let pd: typeof import('../src/services/projectDiscovery.js')
let ctxMod: typeof import('../src/services/godot/context.js')
let mainRoot: string
let project: any

before(async () => {
  wt = await import('../src/services/worktreeService.js')
  tstore = await import('../src/services/taskStore.js')
  pd = await import('../src/services/projectDiscovery.js')
  ctxMod = await import('../src/services/godot/context.js')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  await wt.saveConfig({ enabled: false, basePath: join(parent, 'wt') })
  mainRoot = join(parent, 'Game')
  put(mainRoot, 'project.godot', 'config_version=5\n')
  put(mainRoot, 'notes.txt', 'MAIN\n')
  git(mainRoot, 'init', '-q', '-b', 'main')
  commit(mainRoot, 'base')
  await pd.addProjects([mainRoot])
  project = (await pd.getProjects()).find(x => x.path.replace(/\\/g, '/').toLowerCase() === mainRoot.replace(/\\/g, '/').toLowerCase())
  if (!project) throw new Error('project not registered')
})

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(parent, { recursive: true, force: true })
})

const resolve = (taskId: string, checkout: 'task' | 'main' = 'task') =>
  ctxMod.resolveForProject(project, { projectId: project.id, taskId, checkout, origin: 'task', requireGodot: true } as any)

test('a Direct Checkout task (worktrees off, none recorded) runs in the project folder without a refusal', async () => {
  const t = await tstore.createTask(project.id, { title: 'direct', description: 'd', status: 'in_progress' } as any)
  const r: any = await resolve(t.id)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.checkoutPath.replace(/\\/g, '/').toLowerCase(), mainRoot.replace(/\\/g, '/').toLowerCase())
  assert.match(r.reason, /Direct Checkout/)
})

test('a task with no worktree while worktrees are on has an unknown mode: refused, main only by explicit choice', async () => {
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt') })
  const t = await tstore.createTask(project.id, { title: 'legacy', description: 'd', status: 'in_progress' } as any)
  const r: any = await resolve(t.id)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'task-without-worktree')
  assert.deepEqual(r.options.map((o: any) => o.checkout), ['main'])
  const explicit: any = await resolve(t.id, 'main')
  assert.equal(explicit.ok, true, JSON.stringify(explicit))
})

test('a recorded worktree whose folder is gone is refused (worktree-missing), never served from main', async () => {
  const t = await tstore.createTask(project.id, { title: 'lost', description: 'd', status: 'in_progress' } as any)
  const w = await wt.ensureTaskWorktree(project, t)
  put(w.path!, 'notes.txt', 'TASK\n')
  rmSync(w.path!, { recursive: true, force: true })
  assert.equal(existsSync(w.path!), false)
  const r: any = await resolve(t.id)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'worktree-missing')
  assert.ok(!r.checkoutPath, 'a refusal must not name a checkout to run in')
})
