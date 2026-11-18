/**
 * File API with a taskId: reads and writes go to that task's worktree, never to the main checkout, and a missing or
 * unknown worktree is refused (409) instead of falling back to main. Real disposable repos; nothing is spawned.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-filescope-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-filescope-'))
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim()
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
const commit = (cwd: string, msg: string) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg) }

let wt: typeof import('../src/services/worktreeService.js')
let tstore: typeof import('../src/services/taskStore.js')
let pd: typeof import('../src/services/projectDiscovery.js')
let app: FastifyInstance
let projectId: string
let mainRoot: string
let taskA: { id: string; path: string }
let taskB: { id: string; path: string }

before(async () => {
  wt = await import('../src/services/worktreeService.js')
  tstore = await import('../src/services/taskStore.js')
  pd = await import('../src/services/projectDiscovery.js')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt') })

  mainRoot = join(parent, 'Game')
  put(mainRoot, 'project.godot', 'config_version=5\n')
  put(mainRoot, 'notes.txt', 'MAIN\n')
  git(mainRoot, 'init', '-q', '-b', 'main')
  git(mainRoot, 'config', 'user.email', 't@t'); git(mainRoot, 'config', 'user.name', 't')
  commit(mainRoot, 'base')

  await pd.addProjects([mainRoot])
  const p = (await pd.getProjects()).find(x => x.path.replace(/\\/g, '/') === mainRoot.replace(/\\/g, '/'))
  if (!p) throw new Error('project not registered')
  projectId = p.id

  const mk = async (title: string, note: string) => {
    const t = await tstore.createTask(projectId, { title, description: 'files', status: 'in_progress' } as any)
    const w = await wt.ensureTaskWorktree(p as any, t)
    put(w.path!, 'notes.txt', note)
    return { id: t.id, path: w.path! }
  }
  taskA = await mk('scope A', 'TASK-A\n')
  taskB = await mk('scope B', 'TASK-B\n')

  const mod = await import('../src/routes/files.js')
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register(mod.fileRoutes)
})

after(async () => {
  await app?.close()
  for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true })
})

const get = (path: string, taskId?: string) =>
  app.inject({ method: 'GET', url: `/api/projects/${projectId}/files/content?path=${encodeURIComponent(path)}${taskId ? `&taskId=${taskId}` : ''}` })
const put_ = (path: string, content: string, taskId?: string) =>
  app.inject({ method: 'PUT', url: `/api/projects/${projectId}/files/content`, payload: { path, content, ...(taskId ? { taskId } : {}) } })

test('no taskId reads and writes the main checkout (unchanged behaviour)', async () => {
  assert.equal(get_(await get('notes.txt')), 'MAIN\n')
  assert.equal((await put_('notes.txt', 'MAIN-2\n')).statusCode, 200)
  assert.equal(readFileSync(join(mainRoot, 'notes.txt'), 'utf8'), 'MAIN-2\n')
  await put_('notes.txt', 'MAIN\n')
})

test('a read with taskId returns that task worktree, not main', async () => {
  assert.equal(get_(await get('notes.txt', taskA.id)), 'TASK-A\n')
  assert.equal(get_(await get('notes.txt', taskB.id)), 'TASK-B\n')
})

test('a write with taskId lands only in that worktree; main and the other task are untouched', async () => {
  const r = await put_('notes.txt', 'EDITED-A\n', taskA.id)
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(readFileSync(join(taskA.path, 'notes.txt'), 'utf8'), 'EDITED-A\n')
  assert.equal(readFileSync(join(mainRoot, 'notes.txt'), 'utf8'), 'MAIN\n', 'main changed')
  assert.equal(readFileSync(join(taskB.path, 'notes.txt'), 'utf8'), 'TASK-B\n', 'other task changed')
  assert.equal(get_(await get('notes.txt', taskA.id)), 'EDITED-A\n')
})

test('an unknown taskId is refused with 409 and nothing is written', async () => {
  const r = await put_('notes.txt', 'NOPE\n', 'no-such-task')
  assert.equal(r.statusCode, 409, r.body)
  assert.equal(JSON.parse(r.body).code !== undefined, true)
  assert.equal(readFileSync(join(mainRoot, 'notes.txt'), 'utf8'), 'MAIN\n')
})

test('a missing task worktree is refused with 409 (read and write), never served from main', async () => {
  const moved = join(parent, 'moved-B')
  renameSync(taskB.path, moved)
  try {
    const rd = await get('notes.txt', taskB.id)
    assert.equal(rd.statusCode, 409, rd.body)
    assert.equal(JSON.parse(rd.body).code, 'worktree-missing')
    assert.doesNotMatch(rd.body, /MAIN/)
    const wr = await put_('notes.txt', 'SHOULD-NOT-LAND\n', taskB.id)
    assert.equal(wr.statusCode, 409, wr.body)
    assert.equal(readFileSync(join(mainRoot, 'notes.txt'), 'utf8'), 'MAIN\n', 'main was written while the worktree was missing')
    assert.equal(existsSync(taskB.path), false)
  } finally {
    renameSync(moved, taskB.path)
  }
  assert.equal(get_(await get('notes.txt', taskB.id)), 'TASK-B\n')
})

test('path traversal is still refused inside a task worktree', async () => {
  const r = await get('../../Game/notes.txt', taskA.id)
  assert.notEqual(r.statusCode, 200, r.body)
})

function get_(r: { statusCode: number; body: string }): string {
  assert.equal(r.statusCode, 200, r.body)
  return JSON.parse(r.body).content
}
