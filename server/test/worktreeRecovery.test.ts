/**
 * The scheduled sweep must not forget a task worktree whose folder is only moved or temporarily absent:
 * its git record is what lets the folder come back with its history and link. Orphan records (no task
 * behind them) are still pruned. Real disposable repos; nothing outside the temp dirs is touched.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, renameSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-recover-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-recover-'))
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
const recordedPaths = (repo: string) =>
  git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => norm(l.slice('worktree '.length)))

let wt: typeof import('../src/services/worktreeService.js')
let tstore: typeof import('../src/services/taskStore.js')
let pd: typeof import('../src/services/projectDiscovery.js')
let mainRoot: string

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
})

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(parent, { recursive: true, force: true })
})

async function projectAndTask(title: string) {
  await pd.addProjects([mainRoot])
  const p = (await pd.getProjects()).find(x => norm(x.path) === norm(mainRoot))
  if (!p) throw new Error('project not registered')
  const t = await tstore.createTask(p.id, { title, description: 'recover', status: 'in_progress' } as any)
  const w = await wt.ensureTaskWorktree(p as any, t)
  put(w.path!, 'work.txt', `${title}\n`)
  commit(w.path!, `${title}: work`)
  const sha = git(w.path!, 'rev-parse', 'HEAD')
  return { project: p, task: t, path: w.path!, sha }
}

test('a moved task worktree survives the sweep and comes back with its history and link', async () => {
  const { project, task, path, sha } = await projectAndTask('moved')
  const elsewhere = join(parent, 'elsewhere', 'moved-task')
  mkdirSync(dirname(elsewhere), { recursive: true })
  renameSync(path, elsewhere)
  try {
    const out = await wt.cleanupWorktrees()
    assert.ok(out.kept.some(p => norm(p) === norm(path)), `sweep did not keep the record: ${JSON.stringify(out)}`)
    assert.ok(recordedPaths(mainRoot).includes(norm(path)), 'git record was pruned while the task still points at it')
  } finally {
    renameSync(elsewhere, path)
  }
  assert.equal(existsSync(join(path, 'work.txt')), true)
  assert.equal(git(path, 'rev-parse', 'HEAD'), sha, 'history changed after restore')
  assert.equal(readFileSync(join(path, 'work.txt'), 'utf8'), 'moved\n')
  const again = await wt.ensureTaskWorktree(project as any, (await tstore.getTask(project.id, task.id))!)
  assert.equal(again.created, false, 'the restored worktree is not linked back to its task')
  assert.equal(norm(again.path), norm(path))
})

test('a worktree moved, swept and moved again is still restorable from the new place', async () => {
  const { task, path, sha } = await projectAndTask('moved twice')
  const first = join(parent, 'moved-twice-1')
  const second = join(parent, 'moved-twice-2')
  renameSync(path, first)
  await wt.cleanupWorktrees()
  renameSync(first, second)
  await wt.cleanupWorktrees()
  assert.ok(recordedPaths(mainRoot).includes(norm(path)), 'record lost after the second sweep')
  renameSync(second, path)
  assert.equal(git(path, 'rev-parse', 'HEAD'), sha)
  assert.ok(existsSync(join(path, 'work.txt')))
  void task
})

test('an orphan record (folder gone, no task behind it) is still pruned by the sweep', async () => {
  await projectAndTask('keeper')
  const orphan = join(parent, 'orphan-wt')
  git(mainRoot, 'worktree', 'add', '-q', '-b', 'manual/orphan', orphan)
  assert.ok(recordedPaths(mainRoot).includes(norm(orphan)))
  rmSync(orphan, { recursive: true, force: true })
  const out = await wt.cleanupWorktrees()
  assert.equal(out.pruned, 1, JSON.stringify(out))
  assert.equal(recordedPaths(mainRoot).includes(norm(orphan)), false, 'orphan record was not pruned')
})
