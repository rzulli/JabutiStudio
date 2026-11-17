/**
 * R2-A3: no destructive path outside the safe close.
 * The legacy "Clean worktrees" (POST /api/worktrees/clean), removeTaskWorktree (used by task delete),
 * the scheduled sweep and the file-delete route must never remove work the safe close would refuse.
 * Real disposable repositories; nothing touches a real project.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-wl-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-wl-proj-'))
const repo = join(parent, 'game')
const wtBase = join(parent, 'worktrees')
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim()
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
const UI = { host: 'localhost:5420', origin: 'http://localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }

let app: import('fastify').FastifyInstance
let project: any
let taskStore: typeof import('../src/services/taskStore.js')
let wt: typeof import('../src/services/worktreeService.js')

before(async () => {
  put(repo, 'project.godot', 'config_version=5\n'); put(repo, 'scripts/a.gd', 'extends Node\n')
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  project = (await (await import('../src/services/projectDiscovery.js')).addProjects([repo]))[0]
  taskStore = await import('../src/services/taskStore.js')
  wt = await import('../src/services/worktreeService.js')
  await wt.saveConfig({ enabled: true, basePath: wtBase })
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/taskLifecycle.js')).taskLifecycleRoutes)
  await app.register((await import('../src/routes/worktrees.js')).worktreeRoutes)
  await app.register((await import('../src/routes/files.js')).fileRoutes)
  await app.register((await import('../src/routes/tasks.js')).taskRoutes)
})
after(async () => { await app?.close(); for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true }) })

const base = () => `/api/projects/${project.id}`
const post = (url: string, body: any, headers: any = UI) => app.inject({ method: 'POST', url: base() + url, headers, payload: body })
const branchExists = (b: string) => git(repo, 'branch', '--list', b).includes(b)

async function delivered(title: string, file: string) {
  const created = await taskStore.createTask(project.id, { title, description: '', priority: 'medium', status: 'in_progress' } as any)
  const w = await wt.ensureTaskWorktree(project, created)
  assert.ok(w.created, w.reason)
  put(w.path, file, 'extends Node\n# x\n')
  git(w.path, 'add', '-A'); git(w.path, 'commit', '-qm', `work: ${title}`)
  await taskStore.updateTask(project.id, created.id, { status: 'done', resolution: 'implemented' })
  return { id: created.id, branch: w.branch!, path: w.path, head: git(w.path, 'rev-parse', 'HEAD') }
}
async function integrated(title: string, file: string) {
  const t = await delivered(title, file)
  assert.equal((await post(`/tasks/${t.id}/lifecycle/accept`, { targetBranch: 'main', expectedHeadSha: t.head })).statusCode, 200)
  const r = await post(`/tasks/${t.id}/lifecycle/integrate`, { targetBranch: 'main', expectedHeadSha: t.head, branch: t.branch })
  assert.equal(r.statusCode, 200, r.body)
  return t
}
const fresh = async (id: string) => (await taskStore.getTask(project.id, id))!

test('L1 legacy "Clean worktrees" (all: true) removes nothing: integrated-clean, dirty and unmerged worktrees all survive', async () => {
  const clean = await integrated('L1 clean integrated', 'scripts/l1a.gd')
  const dirty = await integrated('L1 dirty integrated', 'scripts/l1b.gd')
  appendFileSync(join(dirty.path, 'scripts/l1b.gd'), '# unsaved by hand\n')
  const unmerged = await delivered('L1 unmerged', 'scripts/l1c.gd')
  put(unmerged.path, 'notes/only-here.txt', 'irreplaceable')

  const res = await app.inject({ method: 'POST', url: '/api/worktrees/clean', headers: UI, payload: { all: true } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().removed, 0)
  for (const t of [clean, dirty, unmerged]) {
    assert.ok(existsSync(t.path), `worktree kept: ${t.path}`)
    assert.ok(branchExists(t.branch), `branch kept: ${t.branch}`)
    assert.ok((await fresh(t.id)).worktreePath, 'the task still points at its worktree')
  }
  assert.ok(readFileSync(join(dirty.path, 'scripts/l1b.gd'), 'utf-8').endsWith('# unsaved by hand\n'))
  assert.equal(readFileSync(join(unmerged.path, 'notes/only-here.txt'), 'utf-8'), 'irreplaceable')
  assert.equal(git(repo, 'rev-parse', unmerged.branch), unmerged.head)
})

test('L2 the old DELETE .../tasks/:tid/worktree route no longer exists', async () => {
  const t = await delivered('L2 route', 'scripts/l2.gd')
  const res = await app.inject({ method: 'DELETE', url: `${base()}/tasks/${t.id}/worktree`, headers: UI })
  assert.ok([404, 405].includes(res.statusCode), String(res.statusCode))
  assert.ok(existsSync(t.path))
})

test('L3 removeTaskWorktree is the safe close: it refuses unmerged and dirty work, and removes only what Git proves integrated', async () => {
  const unmerged = await delivered('L3 unmerged', 'scripts/l3a.gd')
  const r1 = await wt.removeTaskWorktree(await fresh(unmerged.id))
  assert.equal(r1.removed, false); assert.ok(r1.reason)
  assert.ok(existsSync(unmerged.path)); assert.equal(git(repo, 'rev-parse', unmerged.branch), unmerged.head)

  const dirty = await integrated('L3 dirty', 'scripts/l3b.gd')
  put(dirty.path, 'notes/wip.txt', 'wip')
  assert.equal((await wt.removeTaskWorktree(await fresh(dirty.id))).removed, false)
  assert.equal(readFileSync(join(dirty.path, 'notes/wip.txt'), 'utf-8'), 'wip')

  const ok = await integrated('L3 integrated', 'scripts/l3c.gd')
  const r3 = await wt.removeTaskWorktree(await fresh(ok.id))
  assert.equal(r3.removed, true, r3.reason)
  assert.equal(existsSync(ok.path), false); assert.equal(branchExists(ok.branch), false)
})

test('L4 deleting a task over HTTP never takes an unmerged worktree with it', async () => {
  const t = await delivered('L4 delete task', 'scripts/l4.gd')
  const res = await app.inject({ method: 'DELETE', url: `${base()}/tasks/${t.id}`, headers: UI })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(await taskStore.getTask(project.id, t.id), undefined)
  assert.ok(existsSync(t.path), 'the worktree is left in place (it shows as unlinked in the inventory)')
  assert.equal(git(repo, 'rev-parse', t.branch), t.head)
})

test('L6 the scheduled sweep only prunes: a worktree of a long-finished task stays', async () => {
  const t = await delivered('L6 old done', 'scripts/l6.gd')
  await taskStore.updateTask(project.id, t.id, { doneAt: new Date(Date.now() - 90 * 86400_000).toISOString() } as any)
  const out = await wt.cleanupWorktrees()
  assert.equal(out.removed, 0)
  assert.ok(existsSync(t.path)); assert.ok(branchExists(t.branch))
})

test('L7 a worktree changed between preview and confirmation is not closed with the stale token', async () => {
  const t = await integrated('L7 stale token', 'scripts/l7.gd')
  const p = (await app.inject({ method: 'GET', url: `${base()}/tasks/${t.id}/lifecycle/close-preview` })).json()
  assert.equal(p.allowed, true, JSON.stringify(p.blockers))
  put(t.path, 'notes/late.txt', 'appeared after the preview')
  const res = await post(`/tasks/${t.id}/lifecycle/close`, { expectedToken: p.token })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'state-changed')
  assert.ok(existsSync(join(t.path, 'notes/late.txt'))); assert.ok(branchExists(t.branch))
})

// Last: it leaves untracked worktree folders inside the main checkout, which would block integrations.
test('L5 the file-delete route refuses a folder that is, or holds, a linked worktree', async () => {
  const inner = join(repo, 'inner-wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'manual/inner', inner)
  put(inner, 'keep.txt', 'work in progress')
  for (const p of ['inner-wt']) {
    const res = await app.inject({ method: 'DELETE', url: `${base()}/files?path=${encodeURIComponent(p)}`, headers: UI })
    assert.equal(res.statusCode, 409, res.body)
  }
  assert.equal(readFileSync(join(inner, 'keep.txt'), 'utf-8'), 'work in progress')
  // a parent that contains it is refused too
  mkdirSync(join(repo, 'holder'), { recursive: true })
  const nested = join(repo, 'holder', 'nested-wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'manual/nested', nested)
  const res = await app.inject({ method: 'DELETE', url: `${base()}/files?path=holder`, headers: UI })
  assert.equal(res.statusCode, 409, res.body)
  assert.ok(existsSync(nested))
  // ordinary folders still delete
  put(repo, 'scratch/x.txt', 'x')
  assert.equal((await app.inject({ method: 'DELETE', url: `${base()}/files?path=scratch`, headers: UI })).statusCode, 200)
})
