/**
 * The checkout mode of a task is decided when the task is created and kept on the task. Changing the global
 * worktree setting later must not reclassify it, and a legacy task (no recorded mode) must never run in the main
 * checkout just because the setting was turned off. Real disposable repo; nothing outside the temp dirs is touched.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-identity-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-identity-'))
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

const setWorktrees = (enabled: boolean) => wt.saveConfig({ enabled, basePath: join(parent, 'wt') })
const same = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
const godot = (taskId: string, checkout: 'task' | 'main' = 'task') =>
  ctxMod.resolveForProject(project, { projectId: project.id, taskId, checkout, origin: 'task', requireGodot: true } as any) as Promise<any>

/** Strip the recorded mode from a task on disk: what a task created before the field looks like. */
function makeLegacy(taskId: string) {
  const file = join(dataDir, 'tasks', `${project.id}.json`)
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const t = data.tasks.find((x: any) => x.id === taskId)
  delete t.checkoutMode
  writeFileSync(file, JSON.stringify(data))
}

test('a task created while worktrees are on stays isolated when the setting is turned off', async () => {
  await setWorktrees(true)
  const t = await tstore.createTask(project.id, { title: 'made on', description: 'd', status: 'in_progress' } as any)
  assert.equal(t.checkoutMode, 'isolated')
  await setWorktrees(false)
  // Before any launch the task has no worktree: Godot must refuse, not fall back to the main checkout.
  const before = await godot(t.id)
  assert.equal(before.ok, false)
  assert.equal(before.code, 'task-without-worktree', 'an isolated task with no worktree was given the main checkout silently')
  // Launching still builds its isolated worktree, not the project folder.
  const w = await wt.ensureTaskWorktree(project, (await tstore.getTask(project.id, t.id))!)
  assert.equal(w.created, true, 'the isolated task was sent to the project folder when the setting went off')
  assert.equal(same(w.path, mainRoot), false)
  const after2 = await godot(t.id)
  assert.equal(after2.ok, true)
  assert.equal(realpathSync.native(after2.checkoutPath).toLowerCase(), realpathSync.native(w.path).toLowerCase(), 'after launch Godot must use the task worktree')
})

test('a task created while worktrees are off stays direct when the setting is turned on', async () => {
  await setWorktrees(false)
  const t = await tstore.createTask(project.id, { title: 'made off', description: 'd', status: 'in_progress' } as any)
  assert.equal(t.checkoutMode, 'direct')
  await setWorktrees(true)
  const w = await wt.ensureTaskWorktree(project, (await tstore.getTask(project.id, t.id))!)
  assert.equal(w.created, false)
  assert.equal(same(w.path, mainRoot), true)
  const r = await godot(t.id)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal((await tstore.getTask(project.id, t.id))?.worktreePath, undefined, 'a direct task got a worktree')
})

test('a legacy task (no recorded mode) with worktrees off is refused by launch and Godot, never run in main', async () => {
  await setWorktrees(true)
  const t = await tstore.createTask(project.id, { title: 'legacy off', description: 'd', status: 'in_progress' } as any)
  makeLegacy(t.id)
  await setWorktrees(false)
  await assert.rejects(
    wt.ensureTaskWorktree(project, (await tstore.getTask(project.id, t.id))!),
    (e: any) => e.code === 'checkout-unknown',
  )
  assert.equal(readFileSync(join(mainRoot, 'notes.txt'), 'utf8'), 'MAIN\n')
  assert.equal((await tstore.getTask(project.id, t.id))?.worktreePath, undefined, 'the refused legacy task got a worktree')
  const r = await godot(t.id)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'task-without-worktree')
  assert.equal(r.options[0].checkout, 'main')
  const explicit = await godot(t.id, 'main')
  assert.equal(explicit.ok, true, 'the explicit main choice must still work')
  assert.equal((await tstore.getTask(project.id, t.id))?.checkoutMode, undefined, 'a refusal must not decide the mode')
})

test('a legacy task with worktrees on is refused and gets no worktree: the setting does not decide it', async () => {
  await setWorktrees(true)
  const t = await tstore.createTask(project.id, { title: 'legacy on', description: 'd', status: 'in_progress' } as any)
  makeLegacy(t.id)
  await assert.rejects(
    wt.ensureTaskWorktree(project, (await tstore.getTask(project.id, t.id))!),
    (e: any) => e.code === 'checkout-unknown',
  )
  const untouched = await tstore.getTask(project.id, t.id)
  assert.equal(untouched?.worktreePath, undefined, 'a legacy task was given a worktree by the setting')
  assert.equal(untouched?.checkoutMode, undefined)
  const r = await godot(t.id)
  assert.equal(r.code, 'task-without-worktree')
  assert.deepEqual(r.options.map((o: any) => o.checkout ?? o.checkoutMode), ['main', 'direct', 'isolated'])
  // The person's explicit choice is what creates the worktree, and it is recorded once.
  const chosen = await wt.recordCheckoutChoice(project, t.id, 'isolated')
  assert.equal(chosen.ok, true)
  const w = await wt.ensureTaskWorktree(project, (await tstore.getTask(project.id, t.id))!)
  assert.equal(w.created, true)
  assert.equal(same(w.path, mainRoot), false)
  const after1 = await tstore.getTask(project.id, t.id)
  assert.equal(after1?.checkoutMode, 'isolated')
  await setWorktrees(false)
  assert.equal(wt.checkoutModeOf(after1!), 'isolated')
  assert.equal(wt.requiresWorktree(after1!), true)
})

test('a person records Direct Checkout for a legacy task: it stays in the project folder whatever the setting becomes', async () => {
  await setWorktrees(false)
  const t = await tstore.createTask(project.id, { title: 'legacy direct', description: 'd', status: 'in_progress' } as any)
  makeLegacy(t.id)
  const first = await wt.recordCheckoutChoice(project, t.id, 'direct')
  assert.deepEqual(first, { ok: true, checkoutMode: 'direct', changed: true })
  assert.deepEqual(await wt.recordCheckoutChoice(project, t.id, 'direct'), { ok: true, checkoutMode: 'direct', changed: false })
  const conflicting = await wt.recordCheckoutChoice(project, t.id, 'isolated')
  assert.equal(conflicting.ok, false)
  assert.equal((conflicting as any).code, 'already-recorded')
  await setWorktrees(true)
  const w = await wt.ensureTaskWorktree(project, (await tstore.getTask(project.id, t.id))!)
  assert.equal(w.created, false)
  assert.equal(same(w.path, mainRoot), true, 'a recorded direct task was sent to a worktree by the setting')
  const r = await godot(t.id)
  assert.equal(r.ok, true, JSON.stringify(r))
  const now = await tstore.getTask(project.id, t.id)
  assert.equal(now?.checkoutMode, 'direct')
  assert.equal(now?.worktreePath, undefined)
  const lifecycle = await import('../src/services/taskLifecycleStore.js')
  const events = (await lifecycle.getEntry(project.id, t.id))?.history.filter(h => h.event === 'checkout-mode-recorded') ?? []
  assert.equal(events.length, 1, 'the choice is audited once')
  assert.equal((events[0].detail as any).by, 'ui')
  await setWorktrees(false)
})

test('a legacy task that owns a worktree cannot be recorded as Direct Checkout', async () => {
  await setWorktrees(true)
  const t = await tstore.createTask(project.id, { title: 'legacy owns wt', description: 'd', status: 'in_progress' } as any)
  await wt.ensureTaskWorktree(project, (await tstore.getTask(project.id, t.id))!)
  makeLegacy(t.id)
  const r = await wt.recordCheckoutChoice(project, t.id, 'direct')
  assert.equal(r.ok, false)
  assert.equal((r as any).code, 'has-worktree')
  assert.equal((await tstore.getTask(project.id, t.id))?.checkoutMode, undefined, 'a refused choice wrote a mode')
  await setWorktrees(false)
})

test('a legacy task whose worktree is a trusted manual link is recognised as isolated, not refused', async () => {
  await setWorktrees(true)
  const linkedPath = join(parent, 'linked-wt')
  git(mainRoot, 'worktree', 'add', '-q', '-b', 'legacy-linked', linkedPath)
  const t = await tstore.createTask(project.id, { title: 'legacy linked', description: 'd', status: 'in_progress' } as any)
  makeLegacy(t.id)
  const links = await import('../src/services/worktreeLinks.js')
  await links.mutateLinks(project.id, l => { l[t.id] = { taskId: t.id, path: linkedPath, branch: 'legacy-linked', headAtLink: git(linkedPath, 'rev-parse', 'HEAD'), at: new Date().toISOString(), by: 'ui' } })
  const w = await wt.ensureTaskWorktree(project, (await tstore.getTask(project.id, t.id))!)
  assert.equal(w.created, false)
  assert.equal(same(w.path, linkedPath), true, 'the linked worktree was not used')
  assert.equal((await tstore.getTask(project.id, t.id))?.checkoutMode, undefined, 'a link does not write a mode onto the task')
  await setWorktrees(false)
})

test('migration: evidence decides each legacy task; nothing is migrated by the setting or in bulk', async () => {
  await setWorktrees(true)
  const direct = await tstore.createTask(project.id, { title: 'mig direct', description: 'd', status: 'in_progress' } as any)
  const owned = await tstore.createTask(project.id, { title: 'mig owned', description: 'd', status: 'in_progress' } as any)
  await wt.ensureTaskWorktree(project, (await tstore.getTask(project.id, owned.id))!)
  const unknown = await tstore.createTask(project.id, { title: 'mig unknown', description: 'd', status: 'in_progress' } as any)
  for (const t of [direct, owned, unknown]) makeLegacy(t.id)
  const lifecycle = await import('../src/services/taskLifecycleStore.js')
  await lifecycle.mutate(project.id, direct.id, e => {
    e.direct = { at: new Date().toISOString(), by: 'ui', targetBranch: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), basis: 'person' }
  })
  makeLegacy(owned.id)
  const mig = await import('../src/services/checkoutMigration.js')
  const plan = await mig.planCheckoutMigration(project)
  const itemOf = (id: string) => plan.items.find(i => i.taskId === id)
  assert.equal(itemOf(direct.id)?.checkoutMode, 'direct')
  assert.equal(itemOf(owned.id)?.checkoutMode, 'isolated')
  assert.equal(itemOf(unknown.id), undefined, 'a task with no evidence was classified')
  assert.ok(plan.ambiguous.some(a => a.taskId === unknown.id))

  const onlyDirect = await mig.applyCheckoutMigration(project, [direct.id])
  assert.deepEqual(onlyDirect.applied, [{ taskId: direct.id, checkoutMode: 'direct' }])
  assert.equal((await tstore.getTask(project.id, direct.id))?.checkoutMode, 'direct')
  assert.equal((await tstore.getTask(project.id, owned.id))?.checkoutMode, undefined, 'a limited apply touched another task')
  assert.equal((await tstore.getTask(project.id, unknown.id))?.checkoutMode, undefined, 'an ambiguous task was migrated')

  const all = await mig.applyCheckoutMigration(project)
  assert.ok(all.applied.some(a => a.taskId === owned.id && a.checkoutMode === 'isolated'))
  assert.equal((await tstore.getTask(project.id, owned.id))?.checkoutMode, 'isolated')
  const evidence = ((await lifecycle.getEntry(project.id, direct.id))?.history ?? []).find(h => h.event === 'checkout-mode-recorded')
  assert.equal((evidence?.detail as any).by, 'migration')
  assert.match(String((evidence?.detail as any).evidence), /identified by a person/)
  await setWorktrees(false)
})
