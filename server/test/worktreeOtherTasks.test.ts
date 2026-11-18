/**
 * Creating or recovering one task's worktree must never drop the git record of another task's worktree whose folder
 * is only temporarily missing. Real disposable repo; the folders are moved or removed inside the temp dir only.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-others-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-others-'))
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim()
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
const commit = (cwd: string, msg: string) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg) }
/** Same spelling for a path that may be gone: real parent (resolves 8.3 short names) + basename. */
const norm = (p: string) => {
  let real = p
  try { real = join(realpathSync.native(dirname(p)), p.split(/[\\/]/).pop()!) } catch { /* parent missing */ }
  return real.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
const recorded = (repo: string) =>
  git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => norm(l.slice('worktree '.length)))

let wt: typeof import('../src/services/worktreeService.js')
let tstore: typeof import('../src/services/taskStore.js')
let pd: typeof import('../src/services/projectDiscovery.js')
let mainRoot: string
let project: any

before(async () => {
  wt = await import('../src/services/worktreeService.js')
  tstore = await import('../src/services/taskStore.js')
  pd = await import('../src/services/projectDiscovery.js')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt') })
  mainRoot = join(parent, 'Game')
  put(mainRoot, 'project.godot', 'config_version=5\n')
  git(mainRoot, 'init', '-q', '-b', 'main')
  commit(mainRoot, 'base')
  await pd.addProjects([mainRoot])
  project = (await pd.getProjects()).find(x => norm(x.path) === norm(mainRoot))
  if (!project) throw new Error('project not registered')
})

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(parent, { recursive: true, force: true })
})

async function newTask(title: string) {
  const t = await tstore.createTask(project.id, { title, description: 'other tasks', status: 'in_progress' } as any)
  const w = await wt.ensureTaskWorktree(project, t)
  put(w.path!, 'work.txt', `${title}\n`)
  return { id: t.id, path: w.path! }
}
const reload = async (id: string) => (await tstore.getTask(project.id, id))!

test('creating a new task while another task folder is missing keeps that task record', async () => {
  const a = await newTask('A')
  const moved = join(parent, 'A-away')
  renameSync(a.path, moved)
  try {
    const c = await newTask('C')
    assert.ok(existsSync(c.path), 'the new worktree was not created')
    assert.ok(recorded(mainRoot).includes(norm(a.path)), "A's record was dropped while C was created")
  } finally {
    renameSync(moved, a.path)
  }
})

test('recovering a missing task is refused while another task folder is missing, and drops nothing', async () => {
  const b = await newTask('B')
  rmSync(b.path, { recursive: true, force: true }) // B's folder is gone: its record is stale
  const a = await newTask('A2')
  const movedA = join(parent, 'A2-away')
  renameSync(a.path, movedA)
  try {
    await assert.rejects(
      wt.ensureTaskWorktree(project, await reload(b.id), { recover: true }),
      (e: any) => e.code === 'create-failed' && /another task's worktree is missing/.test(e.message),
    )
    const rec = recorded(mainRoot)
    assert.ok(rec.includes(norm(a.path)), "A's record was dropped while B was recovered")
    assert.ok(rec.includes(norm(b.path)), "B's own record was dropped by the refused recovery")
    assert.equal(existsSync(b.path), false, 'the refused recovery created a folder anyway')
  } finally {
    renameSync(movedA, a.path)
  }
})

test('once the other folder is back, the same recovery succeeds and the task is linked again', async () => {
  const b = await reload((await tstore.getAllTasks()).find(t => t.title === 'B')!.id)
  const r = await wt.ensureTaskWorktree(project, b, { recover: true })
  assert.equal(r.recovered, true)
  assert.equal(existsSync(join(b.worktreePath!, '.git')), true)
  assert.equal(recorded(mainRoot).includes(norm(b.worktreePath!)), true)
})
