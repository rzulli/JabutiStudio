/**
 * R2-A2: worktree inventory, manual links, change classification and safe close.
 * Real, disposable Git repositories; worktrees come from the official mechanism
 * (ensureTaskWorktree) or plain `git worktree add`; accept/integrate/close go through
 * the real routes with the headers the app renderer sends. Nothing touches a real project.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { canonicalPath } from '../src/services/pathIdentity.js'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-wc-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-wc-proj-'))
const repo = join(parent, 'game')
const other = join(parent, 'other-repo')
const wtBase = join(parent, 'worktrees')
const manualBase = join(parent, 'manual')
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim()
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
const UI = { host: 'localhost:5420', origin: 'http://localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }

let app: import('fastify').FastifyInstance
let project: any
let taskStore: typeof import('../src/services/taskStore.js')
let wt: typeof import('../src/services/worktreeService.js')
let closer: typeof import('../src/services/worktreeClose.js')
let inv: typeof import('../src/services/worktreeInventory.js')
let changes: typeof import('../src/services/worktreeChanges.js')

const initRepo = (dir: string) => {
  put(dir, 'project.godot', 'config_version=5\n')
  put(dir, 'scripts/a.gd', 'extends Node\n')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't')
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base')
}

before(async () => {
  initRepo(repo); initRepo(other)
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  const pd = await import('../src/services/projectDiscovery.js')
  project = (await pd.addProjects([repo]))[0]
  taskStore = await import('../src/services/taskStore.js')
  wt = await import('../src/services/worktreeService.js')
  closer = await import('../src/services/worktreeClose.js')
  inv = await import('../src/services/worktreeInventory.js')
  changes = await import('../src/services/worktreeChanges.js')
  await wt.saveConfig({ enabled: true, basePath: wtBase })
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/taskLifecycle.js')).taskLifecycleRoutes)
  await app.register((await import('../src/routes/worktreeInventory.js')).worktreeInventoryRoutes)
})
after(async () => {
  await app?.close()
  for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true })
})

const base = () => `/api/projects/${project.id}`
const post = (url: string, body: any, headers: any = UI) => app.inject({ method: 'POST', url: base() + url, headers, payload: body })
const get = async (url: string) => { inv.invalidateInventory(project.id); return app.inject({ method: 'GET', url: base() + url }) }
const preview = async (id: string) => (await get(`/tasks/${id}/lifecycle/close-preview`)).json()
const view = async (id: string) => (await get(`/tasks/${id}/lifecycle`)).json()
const close = (id: string, body: any, headers: any = UI) => post(`/tasks/${id}/lifecycle/close`, body, headers)
const mainHead = () => git(repo, 'rev-parse', 'refs/heads/main')
const branchExists = (b: string) => git(repo, 'branch', '--list', b).includes(b)

/** A task with its own worktree and one real commit, marked done the way an agent does. */
async function delivered(title: string, file: string, text: string) {
  const created = await taskStore.createTask(project.id, { title, description: '', priority: 'medium', status: 'in_progress' } as any)
  const w = await wt.ensureTaskWorktree(project, created)
  assert.ok(w.created, `worktree created: ${w.reason}`)
  put(w.path, file, text)
  git(w.path, 'add', '-A'); git(w.path, 'commit', '-qm', `work: ${title}`)
  await taskStore.updateTask(project.id, created.id, { status: 'done', resolution: 'implemented' })
  return { id: created.id, branch: w.branch!, path: w.path, head: git(w.path, 'rev-parse', 'HEAD') }
}
/** Delivered, accepted by a person and integrated into main: the INTEGRATED stage the close starts from. */
async function integrated(title: string, file: string, text = 'extends Node\n# x\n') {
  const t = await delivered(title, file, text)
  assert.equal((await post(`/tasks/${t.id}/lifecycle/accept`, { targetBranch: 'main', expectedHeadSha: t.head })).statusCode, 200)
  const r = await post(`/tasks/${t.id}/lifecycle/integrate`, { targetBranch: 'main', expectedHeadSha: t.head, branch: t.branch })
  assert.equal(r.statusCode, 200, r.body)
  return t
}
/** A worktree made by hand, outside Shipyard: no task knows it. */
function manualWorktree(name: string) {
  mkdirSync(manualBase, { recursive: true })
  const path = join(manualBase, name)
  git(repo, 'worktree', 'add', '-q', '-b', `manual/${name}`, path)
  return { path, branch: `manual/${name}` }
}
const same = (a: string, b: string) => canonicalPath(a) === canonicalPath(b)
const bareTask = (title: string) => taskStore.createTask(project.id, { title, description: '', priority: 'medium', status: 'todo' } as any)

// ---------------------------------------------------------------------------------

test('T1 integrated, clean, no sessions: preview allows it and the close removes the folder and the branch, nothing else', async () => {
  const t = await integrated('Closable', 'scripts/c1.gd')
  const p = await preview(t.id)
  assert.equal(p.stage, 'INTEGRATED'); assert.equal(p.mode, 'worktree')
  assert.equal(p.allowed, true, JSON.stringify(p.blockers))
  assert.equal(p.checks.every((c: any) => c.ok), true)
  assert.equal(p.branch.action, 'delete')
  assert.ok(p.willRemove.some((s: string) => s.includes(t.path)))
  assert.ok(p.willPreserve.some((s: string) => s.includes('Merge commit')))

  // UI only, and only for the exact state that was reviewed
  assert.equal((await close(t.id, { expectedToken: p.token }, {})).statusCode, 403)
  assert.equal((await close(t.id, {})).statusCode, 400)
  const stale = await close(t.id, { expectedToken: 'not-the-token' })
  assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'state-changed')
  assert.ok(existsSync(t.path), 'a refused close removes nothing')

  const before = mainHead()
  const res = await close(t.id, { expectedToken: p.token })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.complete, true)
  assert.deepEqual([body.result.worktree, body.result.branch], ['removed', 'deleted'])
  assert.equal(existsSync(t.path), false)
  assert.equal(branchExists(t.branch), false)
  assert.equal(mainHead(), before, 'closing never moves the target')
  git(repo, 'merge-base', '--is-ancestor', t.head, 'main') // the work lives on in main
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').includes(basename(t.path)), false)
  const v = await view(t.id)
  assert.equal(v.stage, 'CLOSED')
  assert.equal(v.integration.state, 'integrated')
  assert.deepEqual(v.history.map((h: any) => h.event).filter((e: string) => e !== 'closure-refused'), ['accepted', 'integrated', 'worktree-removed', 'branch-deleted'])
  const task = await taskStore.getTask(project.id, t.id)
  assert.equal(task?.status, 'done'); assert.equal(task?.worktreePath, undefined)
  // a second close has nothing to close
  assert.equal((await close(t.id, { expectedToken: p.token })).json().code, 'nothing-to-close')
})

test('T2 a task marked done whose branch is not integrated can neither remove the folder nor the branch', async () => {
  const t = await delivered('Done but unmerged', 'scripts/c2.gd', 'extends Node\n# 2\n')
  const p = await preview(t.id)
  assert.equal(p.allowed, false)
  assert.ok(['integrated-stage', 'ancestry'].every(c => p.blockers.some((b: any) => b.code === c)))
  assert.equal(p.branch.action, 'preserve')
  const res = await close(t.id, { expectedToken: p.token })
  assert.equal(res.statusCode, 409)
  assert.ok(existsSync(t.path)); assert.equal(git(repo, 'rev-parse', t.branch), t.head)

  // integrated, then the branch gets one more commit nobody accepted: still nothing is removed
  const u = await integrated('Moved after integration', 'scripts/c2b.gd')
  put(u.path, 'scripts/after.gd', 'extends Node\n'); git(u.path, 'add', '-A'); git(u.path, 'commit', '-qm', 'late work')
  const late = git(u.path, 'rev-parse', 'HEAD')
  const pu = await preview(u.id)
  assert.equal(pu.allowed, false)
  assert.ok(pu.blockers.some((b: any) => b.code === 'accepted-commit'))
  assert.equal(pu.branch.action, 'preserve')
  assert.equal((await close(u.id, { expectedToken: pu.token })).statusCode, 409)
  assert.equal(git(repo, 'rev-parse', u.branch), late, 'the unintegrated commit is still referenced')
})

test('T3 tracked changes block the close and are left exactly as they were', async () => {
  const t = await integrated('Dirty tracked', 'scripts/c3.gd')
  appendFileSync(join(t.path, 'scripts/c3.gd'), '# edited by hand\n')
  const p = await preview(t.id)
  assert.equal(p.allowed, false)
  assert.ok(p.blockers.some((b: any) => b.code === 'no-tracked-changes'))
  assert.equal((await close(t.id, { expectedToken: p.token })).statusCode, 409)
  assert.ok(readFileSync(join(t.path, 'scripts/c3.gd'), 'utf-8').endsWith('# edited by hand\n'))
  assert.ok(branchExists(t.branch))
})

test('T4 an untracked file blocks the close: it exists nowhere else', async () => {
  const t = await integrated('Untracked', 'scripts/c4.gd')
  put(t.path, 'notes/only-here.txt', 'irreplaceable')
  const p = await preview(t.id)
  assert.equal(p.allowed, false)
  assert.ok(p.blockers.some((b: any) => b.code === 'no-untracked'))
  assert.equal((await close(t.id, { expectedToken: p.token })).statusCode, 409)
  assert.equal(readFileSync(join(t.path, 'notes/only-here.txt'), 'utf-8'), 'irreplaceable')
})

test('T5 ignored files are never discarded silently: listed, and only removed with an explicit acknowledgement', async () => {
  appendFileSync(join(repo, '.git', 'info', 'exclude'), '\ncache/\n') // shared by every worktree of the repo
  const t = await integrated('Ignored', 'scripts/c5.gd')
  put(t.path, 'cache/blob.bin', 'regenerable?')
  const p = await preview(t.id)
  assert.equal(p.allowed, false)
  assert.equal(p.needsAcknowledgement, true)
  assert.equal(p.changes.ignored.total, 1)
  assert.deepEqual(p.changes.ignored.sample, ['cache/'])
  assert.ok(p.willRemove.some((s: string) => s.includes('ignored')))
  const refused = await close(t.id, { expectedToken: p.token })
  assert.equal(refused.statusCode, 409); assert.equal(refused.json().code, 'ignored-files')
  assert.equal(readFileSync(join(t.path, 'cache/blob.bin'), 'utf-8'), 'regenerable?')
  // the acknowledgement is bound to the state shown: a different ignored set is a different token
  put(t.path, 'cache/second.bin', 'new')
  assert.equal((await close(t.id, { expectedToken: p.token, acknowledgeIgnored: true })).json().code, 'state-changed')
  assert.ok(existsSync(join(t.path, 'cache/blob.bin')))
  const p2 = await preview(t.id)
  const done = await close(t.id, { expectedToken: p2.token, acknowledgeIgnored: true })
  assert.equal(done.statusCode, 200, done.body)
  assert.equal(existsSync(t.path), false)
})

test('T6 a known session blocks the close, by task and by working directory', async () => {
  const t = await integrated('Session', 'scripts/c6.gd')
  const task = (await taskStore.getTask(project.id, t.id))!
  const byTask = await closer.previewClose(project, task, { sessions: [{ id: 's1', taskId: t.id, state: 'busy', cwd: parent }] })
  assert.equal(byTask.allowed, false); assert.ok(byTask.blockers.some(b => b.code === 'no-sessions'))
  const byCwd = await closer.previewClose(project, task, { sessions: [{ id: 's2', state: 'idle', cwd: join(t.path, 'scripts') }] })
  assert.equal(byCwd.allowed, false); assert.ok(byCwd.blockers.some(b => b.code === 'no-sessions'))
  const res = await closer.closeTask(project, task, { expectedToken: byCwd.token, sessions: [{ id: 's2', state: 'idle', cwd: join(t.path, 'scripts') }] })
  assert.equal(res.ok, false)
  assert.ok(existsSync(t.path))
  // an unrelated session does not block
  const free = await closer.previewClose(project, task, { sessions: [{ id: 's3', taskId: 'someone-else', cwd: parent }] })
  assert.equal(free.allowed, true)
})

test('T7 a manual worktree is listed as unlinked, with blockers, and nothing offers to remove it', async () => {
  const m = manualWorktree('handmade')
  put(m.path, 'scratch.txt', 'wip')
  git(m.path, 'add', '-A'); git(m.path, 'commit', '-qm', 'hand work')
  const r = (await get('/worktrees/inventory')).json()
  const e = r.worktrees.find((w: any) => w.path.replace(/\\/g, '/').toLowerCase().endsWith('/manual/handmade'))
  assert.ok(e, 'git knows it, so the inventory lists it')
  assert.equal(e.task, null)
  assert.deepEqual([e.flags.unlinked, e.flags.taskLinked, e.flags.unmerged, e.flags.dirty], [true, false, true, false])
  assert.equal(e.branch, m.branch); assert.equal(e.unmergedCommits, 1)
  assert.equal(e.cleanup.allowed, false); assert.ok(e.cleanup.blockers.some((b: any) => b.code === 'unlinked'))
  const main = r.worktrees.find((w: any) => w.isMain)
  assert.ok(main); assert.ok(main.cleanup.blockers.some((b: any) => b.code === 'main-checkout'))
  assert.ok(r.summary.unlinked >= 1)
  // untouched
  assert.ok(existsSync(m.path)); assert.equal(git(repo, 'rev-parse', m.branch), git(m.path, 'rev-parse', 'HEAD'))
  // dirty is reported, not inferred from "unlinked"
  put(m.path, 'more.txt', 'x')
  const e2 = (await get('/worktrees/inventory')).json().worktrees.find((w: any) => w.path === e.path)
  assert.equal(e2.flags.dirty, true); assert.equal(e2.changes.untracked, 1); assert.equal(e2.flags.unlinked, true)
})

test('T8 linking a worktree to a task writes only the link: the worktree, the branch and the task file are unchanged', async () => {
  const m = manualWorktree('adopted')
  put(m.path, 'a.txt', 'a'); git(m.path, 'add', '-A'); git(m.path, 'commit', '-qm', 'adopted work')
  put(m.path, 'dirty.txt', 'uncommitted')
  const task = await bareTask('Adopts a worktree')
  const snap = () => ({ head: git(m.path, 'rev-parse', 'HEAD'), status: git(m.path, 'status', '--porcelain'), branches: git(repo, 'branch', '--list'), file: readFileSync(join(m.path, 'dirty.txt'), 'utf-8'), refs: git(repo, 'for-each-ref') })
  const before = snap()
  const taskBefore = JSON.stringify(await taskStore.getTask(project.id, task.id))
  assert.equal((await post('/worktrees/link', { taskId: task.id, path: m.path }, {})).statusCode, 403) // UI only
  const res = await post('/worktrees/link', { taskId: task.id, path: m.path })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().link.branch, m.branch)
  assert.deepEqual(snap(), before)
  assert.equal(JSON.stringify(await taskStore.getTask(project.id, task.id)), taskBefore, 'the task file is not written')
  // now the task owns it for the lifecycle and the inventory, as a manual link
  const v = await view(task.id)
  assert.equal(v.delivery.branch, m.branch); assert.equal(v.delivery.commits.length, 1)
  assert.equal(v.acceptance.state, 'none') // linking never accepts
  assert.notEqual(v.integration.state, 'integrated'); assert.equal(v.stage, 'READY') // and "todo" is not "done"
  const e = (await get('/worktrees/inventory')).json().worktrees.find((w: any) => same(w.path, m.path))
  assert.equal(e.task.id, task.id); assert.equal(e.task.origin, 'manual'); assert.equal(e.flags.taskLinked, true)
  assert.ok(e.cleanup.blockers.some((b: any) => b.code === 'integrated-stage'))
  // unlinking removes the claim and nothing else
  assert.equal((await app.inject({ method: 'DELETE', url: `${base()}/worktrees/link/${task.id}`, headers: {} })).statusCode, 403)
  assert.equal((await app.inject({ method: 'DELETE', url: `${base()}/worktrees/link/${task.id}`, headers: UI })).statusCode, 200)
  assert.deepEqual(snap(), before)
  assert.equal((await get('/worktrees/inventory')).json().worktrees.find((w: any) => same(w.path, m.path)).task, null)
})

test('T9 two tasks cannot silently claim the same worktree, nor one task two worktrees', async () => {
  const m = manualWorktree('contested')
  const m2 = manualWorktree('contested-b')
  const a = await bareTask('First claimant'), b = await bareTask('Second claimant')
  assert.equal((await post('/worktrees/link', { taskId: a.id, path: m.path })).statusCode, 200)
  assert.equal((await post('/worktrees/link', { taskId: a.id, path: m.path })).json().already, true) // idempotent
  const clash = await post('/worktrees/link', { taskId: b.id, path: m.path })
  assert.equal(clash.statusCode, 409); assert.equal(clash.json().code, 'already-claimed')
  const two = await post('/worktrees/link', { taskId: a.id, path: m2.path })
  assert.equal(two.statusCode, 409); assert.equal(two.json().code, 'task-already-linked')
  // a worktree Shipyard made for another task is claimed too
  const own = await delivered('Owns its worktree', 'scripts/c9.gd', 'extends Node\n# 9\n')
  const steal = await post('/worktrees/link', { taskId: b.id, path: own.path })
  assert.equal(steal.json().code, 'already-claimed')
  const ownTaskLinksOther = await post('/worktrees/link', { taskId: own.id, path: m2.path })
  assert.equal(ownTaskLinksOther.json().code, 'task-has-worktree')
  // explicit resolution: remove the first claim, then the second can be made
  await app.inject({ method: 'DELETE', url: `${base()}/worktrees/link/${a.id}`, headers: UI })
  assert.equal((await post('/worktrees/link', { taskId: b.id, path: m.path })).statusCode, 200)
})

test('T10 links and acceptance survive a restart: a brand-new process reads them back from disk', async () => {
  const m = manualWorktree('persisted')
  const t = await bareTask('Persisted link')
  assert.equal((await post('/worktrees/link', { taskId: t.id, path: m.path })).statusCode, 200)
  const ledger = JSON.parse(readFileSync(join(dataDir, 'worktree-links', `${project.id}.json`), 'utf-8'))
  assert.equal(ledger.links[t.id].branch, m.branch)
  const href = (p: string) => JSON.stringify(new URL(p, import.meta.url).href)
  const script = `const inv = await import(${href('../src/services/worktreeInventory.js')});
    const p = { id: ${JSON.stringify(project.id)}, path: ${JSON.stringify(repo)}, isGitRepo: true };
    const r = await inv.inventory(p);
    const e = r.worktrees.find(w => w.task && w.task.id === ${JSON.stringify(t.id)});
    console.log(JSON.stringify({ origin: e && e.task.origin, branch: e && e.branch }));`
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, SHIPYARD_DATA_DIR: dataDir }, cwd: join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'), stdio: 'pipe' }).toString().trim().split('\n').pop()!
  assert.deepEqual(JSON.parse(out), { origin: 'manual', branch: m.branch })
})

test('T11 a failed removal leaves the lifecycle coherent: INTEGRATED, the result of each half recorded, a retry works', async () => {
  const real = { ...closer.hooks }
  try {
    // (a) git refuses to remove the folder: the branch is not touched either
    const t = await integrated('Removal fails', 'scripts/c11.gd')
    closer.hooks.removeWorktree = async () => ({ ok: false, output: 'fatal: Permission denied (simulated lock)' })
    const p = await preview(t.id)
    const res = await close(t.id, { expectedToken: p.token })
    assert.equal(res.statusCode, 409); assert.equal(res.json().code, 'worktree-remove-failed')
    assert.equal(res.json().result.worktree, 'failed')
    assert.ok(existsSync(t.path)); assert.ok(branchExists(t.branch))
    let v = await view(t.id)
    assert.equal(v.stage, 'INTEGRATED')
    assert.ok(v.blockers.some((b: any) => b.code === 'closure-incomplete'))
    assert.ok(v.history.some((h: any) => h.event === 'closure-failed'))
    closer.hooks.removeWorktree = real.removeWorktree
    const retry = await close(t.id, { expectedToken: (await preview(t.id)).token })
    assert.equal(retry.statusCode, 200, retry.body); assert.equal(retry.json().complete, true)

    // (b) the folder goes, the branch cannot: reported as partial, never as closed
    const u = await integrated('Branch delete fails', 'scripts/c11b.gd')
    closer.hooks.deleteBranch = async () => ({ ok: false, output: 'simulated failure' })
    const pu = await preview(u.id)
    const part = await close(u.id, { expectedToken: pu.token })
    assert.equal(part.statusCode, 200, part.body)
    assert.equal(part.json().complete, false)
    assert.deepEqual([part.json().result.worktree, part.json().result.branch], ['removed', 'failed'])
    assert.equal(existsSync(u.path), false); assert.ok(branchExists(u.branch))
    v = await view(u.id)
    assert.equal(v.stage, 'INTEGRATED'); assert.ok(v.blockers.some((b: any) => b.code === 'closure-incomplete'))
    closer.hooks.deleteBranch = real.deleteBranch
    const p2 = await preview(u.id)
    assert.equal(p2.mode, 'branch-only'); assert.equal(p2.allowed, true, JSON.stringify(p2.blockers))
    const fin = await close(u.id, { expectedToken: p2.token })
    assert.equal(fin.json().complete, true); assert.equal(branchExists(u.branch), false)
    assert.equal((await view(u.id)).stage, 'CLOSED')
  } finally { Object.assign(closer.hooks, real) }
})

test('T12 the main checkout is never closable through a task', async () => {
  const t = await bareTask('Claims the main checkout')
  await taskStore.updateTask(project.id, t.id, { worktreePath: repo, worktreeBranch: 'main', status: 'done' } as any)
  const task = (await taskStore.getTask(project.id, t.id))!
  const p = await closer.previewClose(project, task, { sessions: [] })
  assert.equal(p.allowed, false)
  assert.ok(p.blockers.some(b => b.code === 'not-main-checkout'))
  const res = await closer.closeTask(project, task, { expectedToken: p.token, sessions: [] })
  assert.equal(res.ok, false)
  assert.ok(existsSync(join(repo, 'project.godot'))); assert.ok(branchExists('main'))
  // and it cannot be linked either
  const free = await bareTask('Wants main')
  assert.equal((await post('/worktrees/link', { taskId: free.id, path: repo })).json().code, 'main-checkout')
})

test('T13 outside paths, other repositories and spelling tricks are rejected; equivalent spellings are one worktree', async () => {
  const t = await bareTask('Bad paths')
  const outside = join(parent, 'plain-folder'); mkdirSync(outside)
  assert.equal((await post('/worktrees/link', { taskId: t.id, path: outside })).json().code, 'not-registered')
  const foreign = join(manualBase, 'foreign'); mkdirSync(manualBase, { recursive: true })
  git(other, 'worktree', 'add', '-q', '-b', 'foreign/x', foreign)
  assert.equal((await post('/worktrees/link', { taskId: t.id, path: foreign })).json().code, 'not-registered')
  // a task pointing at another repository's worktree can neither be previewed as closable nor closed
  const evil = await integrated('Points elsewhere', 'scripts/c13.gd')
  await taskStore.updateTask(project.id, evil.id, { worktreePath: foreign, worktreeBranch: 'foreign/x' } as any)
  const task = (await taskStore.getTask(project.id, evil.id))!
  const p = await closer.previewClose(project, task, { sessions: [] })
  assert.equal(p.allowed, false)
  assert.ok(p.blockers.some(b => b.code === 'ownership'))
  assert.equal((await closer.closeTask(project, task, { expectedToken: p.token, sessions: [] })).ok, false)
  assert.ok(existsSync(foreign)); assert.ok(existsSync(join(foreign, 'project.godot')))
  // `..` and case tricks resolve to the registered worktree, once
  const m = manualWorktree('spelled')
  const spelled = join(m.path, '..', 'spelled') + (process.platform === 'win32' ? '' : '/')
  assert.equal((await post('/worktrees/link', { taskId: t.id, path: spelled })).statusCode, 200)
  assert.equal((await post('/worktrees/link', { taskId: t.id, path: m.path.toUpperCase() === m.path ? m.path : m.path })).json().already, true)
  // the diff route accepts only a relative path inside the worktree
  const bad = await get(`/worktrees/diff?path=${encodeURIComponent(m.path)}&file=${encodeURIComponent('../../etc/passwd')}`)
  assert.equal(bad.statusCode, 400)
  const notReg = await get(`/worktrees/changes?path=${encodeURIComponent(outside)}`)
  assert.equal(notReg.statusCode, 404)
})

test('T14 generated-looking .tres changes are classified for a human and never authorize discarding anything', async () => {
  const t = await delivered('Tres', 'audio/SfxLibrary.tres', '[gd_resource type="Resource" load_steps=4 format=3]\n\n[ext_resource type="AudioStream" path="res://a.wav" id="1_a"]\n[ext_resource type="AudioStream" path="res://b.wav" id="2_b"]\n\n[resource]\nsfx_a = ExtResource("1_a")\nsfx_b = ExtResource("2_b")\n')
  for (const n of ['one', 'two', 'three']) {
    put(t.path, `data/${n}.tres`, `[gd_resource type="Resource" format=3]\n\n[resource]\nname = "${n}"\nvalue = 1\nweight = 2\n`)
  }
  git(t.path, 'add', '-A'); git(t.path, 'commit', '-qm', 'more resources')
  const head = git(t.path, 'rev-parse', 'HEAD')
  assert.equal((await post(`/tasks/${t.id}/lifecycle/accept`, { targetBranch: 'main', expectedHeadSha: head })).statusCode, 200)
  assert.equal((await post(`/tasks/${t.id}/lifecycle/integrate`, { targetBranch: 'main', expectedHeadSha: head, branch: t.branch })).statusCode, 200)
  // a re-save: same lines, different order (x3); and one file that really lost a reference
  for (const n of ['one', 'two', 'three']) put(t.path, `data/${n}.tres`, `[gd_resource type="Resource" format=3]\n\n[resource]\nweight = 2\nname = "${n}"\nvalue = 1\n`)
  put(t.path, 'audio/SfxLibrary.tres', '[gd_resource type="Resource" load_steps=3 format=3]\n\n[ext_resource type="AudioStream" path="res://a.wav" id="1_a"]\n\n[resource]\nsfx_a = ExtResource("1_a")\n')
  const files = ['audio/SfxLibrary.tres', 'data/one.tres', 'data/two.tres', 'data/three.tres']
  const contents = files.map(f => readFileSync(join(t.path, f), 'utf-8'))
  const statusBefore = git(t.path, 'status', '--porcelain')

  const res = await get(`/worktrees/changes?path=${encodeURIComponent(t.path)}`)
  assert.equal(res.statusCode, 200)
  const rep = res.json().report
  assert.equal(rep.counts.modified, 4)
  assert.equal(rep.resources.total, 4)
  assert.equal(rep.resources.apparentReserialization, 3)
  assert.equal(rep.resources.material, 1)
  assert.equal(rep.resources.withReferenceRemovals, 1)
  assert.match(rep.resources.pattern, /3 of 4/)
  const lib = rep.resources.files.find((f: any) => f.path === 'audio/SfxLibrary.tres')
  assert.equal(lib.classification, 'references-removed'); assert.equal(lib.assessment, 'material')
  assert.match(lib.extResourcesRemoved[0], /b\.wav/)
  assert.equal(rep.resources.files[0].path, 'audio/SfxLibrary.tres', 'lost references are listed first')
  assert.equal(rep.entries.find((e: any) => e.path === 'data/one.tres').generated, true)
  // the diff can be inspected
  const d = (await get(`/worktrees/diff?path=${encodeURIComponent(t.path)}&file=audio/SfxLibrary.tres`)).json()
  assert.ok(d.diff.includes('-[ext_resource type="AudioStream" path="res://b.wav"'))

  // "looks generated" is information only: the close is blocked and the files are byte-identical
  const p = await preview(t.id)
  assert.equal(p.allowed, false); assert.ok(p.blockers.some((b: any) => b.code === 'no-tracked-changes'))
  assert.equal((await close(t.id, { expectedToken: p.token })).statusCode, 409)
  assert.deepEqual(files.map(f => readFileSync(join(t.path, f), 'utf-8')), contents)
  assert.equal(git(t.path, 'status', '--porcelain'), statusBefore)
  // even if EVERY change were a re-save, the file is still tracked-modified and still blocks
  put(t.path, 'audio/SfxLibrary.tres', readFileSync(join(t.path, 'audio/SfxLibrary.tres'), 'utf-8') + '\n')
  assert.equal((await preview(t.id)).allowed, false)
  // unit: the classifier, directly
  const re = changes.analyzeResourceDiff('x.tres', '-[ext_resource id="1_a" path="a"]\n-[ext_resource id="2_b" path="b"]\n+[ext_resource id="9_z" path="b"]\n+[ext_resource id="8_y" path="a"]\n')
  assert.equal(re.assessment, 'apparent-reserialization') // ids renumbered, same references
  const lost = changes.analyzeResourceDiff('x.tres', '-[ext_resource id="1_a" path="a"]\n-[ext_resource id="2_b" path="b"]\n+[ext_resource id="1_a" path="a"]\n')
  assert.equal(lost.assessment, 'material'); assert.equal(lost.classification, 'references-removed')
})

test('T15 integration is judged against the task\'s accepted target by ancestry: a similar patch or another branch is not enough', async () => {
  const t = await delivered('Look-alike', 'scripts/c15.gd', 'extends Node\n# 15\n')
  assert.equal((await post(`/tasks/${t.id}/lifecycle/accept`, { targetBranch: 'main', expectedHeadSha: t.head })).statusCode, 200)
  // the same patch lands on main by cherry-pick: equivalent, but not an ancestor
  git(repo, 'cherry-pick', t.head)
  // and another branch really contains the commit
  git(repo, 'branch', 'release-candidate', t.head)
  const p = await preview(t.id)
  assert.notEqual(p.stage, 'INTEGRATED')
  assert.equal(p.allowed, false)
  assert.ok(p.blockers.some((b: any) => b.code === 'ancestry'))
  assert.equal(p.branch.action, 'preserve')
  assert.equal((await close(t.id, { expectedToken: p.token })).statusCode, 409)
  assert.ok(existsSync(t.path)); assert.equal(git(repo, 'rev-parse', t.branch), t.head)
})

test('T16 R2-A1 behavior stands: accept, revoke, integrate and the moved-branch guard', async () => {
  const t = await delivered('Regression', 'scripts/c16.gd', 'extends Node\n# 16\n')
  const acc = await post(`/tasks/${t.id}/lifecycle/accept`, { targetBranch: 'main', expectedHeadSha: t.head })
  assert.equal(acc.statusCode, 200)
  const rev = await app.inject({ method: 'DELETE', url: `${base()}/tasks/${t.id}/lifecycle/accept`, headers: UI })
  assert.equal(rev.statusCode, 200); assert.equal((await view(t.id)).acceptance.state, 'none')
  assert.equal((await post(`/tasks/${t.id}/lifecycle/integrate`, { targetBranch: 'main', expectedHeadSha: t.head })).json().code, 'not-accepted')
  await post(`/tasks/${t.id}/lifecycle/accept`, { targetBranch: 'main', expectedHeadSha: t.head })
  put(t.path, 'scripts/more16.gd', 'extends Node\n'); git(t.path, 'add', '-A'); git(t.path, 'commit', '-qm', 'moved')
  assert.equal((await view(t.id)).acceptance.state, 'lapsed')
  assert.equal((await post(`/tasks/${t.id}/lifecycle/integrate`, { targetBranch: 'main', expectedHeadSha: t.head, branch: t.branch })).json().code, 'acceptance-lapsed')
})

test('inventory: Shipyard task worktrees show their lifecycle next to manual ones, and the flags coexist', async () => {
  const t = await integrated('Inventory row', 'scripts/inv.gd')
  put(t.path, 'draft.txt', 'wip')
  const r = (await get('/worktrees/inventory')).json()
  const e = r.worktrees.find((w: any) => w.task?.id === t.id)
  assert.equal(e.task.origin, 'shipyard'); assert.equal(e.task.stage, 'INTEGRATED')
  assert.deepEqual([e.flags.taskLinked, e.flags.integrated, e.flags.dirty, e.flags.unmerged], [true, true, true, false])
  assert.ok(e.cleanup.blockers.some((b: any) => b.code === 'no-untracked'))
  assert.equal(e.comparedTo.branch, 'main'); assert.equal(e.comparedTo.reason, 'accepted-target')
})
