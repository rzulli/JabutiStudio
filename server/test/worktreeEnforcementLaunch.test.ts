/**
 * Enforcement at the launch points: the MCP `start_task` tool and the terminal route. A task that requires its worktree
 * and cannot get one must not be started and must not spawn a process in the project folder. Real disposable repos.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-enfl-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-enfl-'))
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim()
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }

let wt: typeof import('../src/services/worktreeService.js')
let tstore: typeof import('../src/services/taskStore.js')
let pd: typeof import('../src/services/projectDiscovery.js')
let mcp: typeof import('../src/services/mcpServer.js')

before(async () => {
  wt = await import('../src/services/worktreeService.js')
  tstore = await import('../src/services/taskStore.js')
  pd = await import('../src/services/projectDiscovery.js')
  mcp = await import('../src/services/mcpServer.js')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
})
after(() => { rmSync(parent, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }) })

// A repo whose task cannot get a worktree: the base folder sits under a regular file, so nothing can be created there.
async function blockedProject(name: string) {
  const dir = join(parent, name)
  put(dir, 'project.godot', 'config_version=5\n')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't')
  git(dir, 'add', '-A'); git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `base ${name}`)
  await pd.addProjects([dir])
  const p = (await pd.getProjects()).find(x => x.name === name)!
  const blocker = join(parent, `${name}-file`); writeFileSync(blocker, 'x')
  await wt.saveConfig({ enabled: true, basePath: join(blocker, 'sub') })
  return p
}

test('MCP start_task: a required worktree that cannot be created refuses the start and leaves the task untouched', async () => {
  const p = await blockedProject('mcp-blocked')
  const t = await tstore.createTask(p.id, { title: 'mcp launch', description: 'x', status: 'todo' } as any)
  const res = await mcp.startTask(p.id, t.id)
  assert.equal(res.isError, true)
  const text = res.content.map((c: any) => c.text).join('\n')
  assert.match(text, /was not started/)
  assert.doesNotMatch(text, /"cwd"|cwd:/, 'no working directory is handed to the agent')
  assert.equal((await tstore.getTask(p.id, t.id))!.status, 'todo', 'status did not move to in_progress')
})

test('terminal route: a required worktree that cannot be created answers 409 and spawns nothing', async t => {
  const pty = await import('../src/services/terminalService.js')
  if (!pty.isAvailable()) return t.skip('node-pty is not available in this environment')
  const p = await blockedProject('term-blocked')
  const task = await tstore.createTask(p.id, { title: 'terminal launch', description: 'x', status: 'todo' } as any)
  const Fastify = (await import('fastify')).default
  const app = Fastify()
  await app.register((await import('../src/routes/terminalWs.js')).terminalWsRoutes)
  // A plain shell, never a real agent CLI: the test must be safe to run repeatedly. If the guard ever regressed, the
  // session it would start is a shell inside a throwaway project folder, and it is killed below.
  const r = await app.inject({ method: 'POST', url: '/api/terminal/sessions', payload: { projectId: p.id, type: 'shell', taskId: task.id } })
  await app.close()
  const created = pty.listSessions(p.id)
  for (const s of created) pty.killSession(s.id)
  assert.equal(r.statusCode, 409, r.body)
  assert.equal(JSON.parse(r.body).code, 'create-failed')
  assert.equal(created.length, 0, 'no session was created in the project folder')
})

test('assertLaunchCheckout: a required task may only launch in the worktree it records', async () => {
  const base = { id: 't1', projectId: 'p', title: 'x', worktreePath: join(parent, 'wt-a') } as any
  await wt.saveConfig({ enabled: true, basePath: join(parent, 'wt') })
  assert.throws(() => wt.assertLaunchCheckout(base, join(parent, 'some-main')), (e: any) => wt.isCheckoutUnavailable(e) && e.code === 'checkout-mismatch')
  assert.doesNotThrow(() => wt.assertLaunchCheckout(base, join(parent, 'wt-a')))
  await wt.saveConfig({ enabled: false, basePath: join(parent, 'wt') })
  const direct = { id: 't2', projectId: 'p', title: 'y', checkoutMode: 'direct' } as any
  assert.doesNotThrow(() => wt.assertLaunchCheckout(direct, join(parent, 'anything')), 'Direct Checkout is unaffected')
  // A legacy task (no recorded mode) is refused whatever the setting says: it must be recorded first.
  const legacy = { id: 't3', projectId: 'p', title: 'z' } as any
  assert.throws(() => wt.assertLaunchCheckout(legacy, join(parent, 'anything')), (e: any) => wt.isCheckoutUnavailable(e) && e.code === 'checkout-unknown')
})
