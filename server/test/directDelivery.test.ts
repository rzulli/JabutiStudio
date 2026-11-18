/**
 * Direct-checkout delivery (RC1 addendum): a task worked in an existing checkout, no worktree, no branch.
 * Reproduces the QP1 shape on a disposable repo: work committed straight on the target branch.
 * Git cannot say which commits belong to the task, so a person identifies them; nothing is attributed from timing.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-dd-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-dd-proj-'))
const repo = join(parent, 'game')
process.env.SHIPYARD_DATA_DIR = dataDir

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim()
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
const UI = { host: 'localhost:5420', origin: 'http://localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }
const commit = (file: string, text: string, msg: string) => { put(repo, file, text); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', msg); return git(repo, 'rev-parse', 'HEAD') }

let app: import('fastify').FastifyInstance
let project: any
let taskStore: typeof import('../src/services/taskStore.js')
let lc: typeof import('../src/services/taskLifecycle.js')
let base: string

before(async () => {
  put(repo, 'project.godot', 'config_version=5\n')
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  base = commit('README.md', '# game\n', 'base')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  project = (await (await import('../src/services/projectDiscovery.js')).addProjects([repo]))[0]
  taskStore = await import('../src/services/taskStore.js')
  lc = await import('../src/services/taskLifecycle.js')
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/taskLifecycle.js')).taskLifecycleRoutes)
})
after(async () => {
  await app?.close()
  for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true })
})

const mk = (title: string, status: any = 'in_progress') => taskStore.createTask(project.id, { title, description: '', priority: 'medium', status } as any)
const done = (id: string) => taskStore.updateTask(project.id, id, { status: 'done', resolution: 'implemented' })
const url = (id: string, tail = '') => `/api/projects/${project.id}/tasks/${id}/lifecycle${tail}`
const view = async (id: string) => (await app.inject({ method: 'GET', url: url(id) })).json()
const identify = (id: string, body: any, headers: any = UI) => app.inject({ method: 'POST', url: url(id, '/direct-delivery'), headers, payload: body })
const accept = (id: string, body: any, headers: any = UI) => app.inject({ method: 'POST', url: url(id, '/accept'), headers, payload: body })

test('1. a task done on the main checkout is "Direct checkout", not "Not tracked": the commits are candidates, never an attribution', async () => {
  const t = await mk('QP1-like')
  const c1 = commit('scenes/a.tscn', '[gd_scene]\n', 'feat: stairs')
  await done(t.id)
  const v = await view(t.id)
  assert.equal(v.delivery.mode, 'direct')
  assert.equal(v.stage, 'REVIEW')
  assert.equal(v.delivery.commits.length, 0, 'nothing attributed yet')
  assert.ok(v.delivery.direct.candidates.some((c: any) => c.sha === c1 && c.trailer === false))
  assert.ok(v.blockers.some((b: any) => b.code === 'unattributed'))
  assert.equal(v.canAccept, false)
  assert.match(v.delivery.direct.uncertainty.join(' '), /candidates by time only/)
  // Accepting without identifying is refused, not guessed.
  assert.ok((await accept(t.id, { targetBranch: 'master', expectedHeadSha: c1 })).statusCode >= 400)
})

test('10. once identified, the delivery in the target branch has no pending merge; acceptance is a separate, human, sha-bound step', async () => {
  const t = await mk('Identify me')
  const c = commit('scenes/b.tscn', '[gd_scene]\n', 'feat: b')
  await done(t.id)
  assert.equal((await identify(t.id, { baseSha: git(repo, 'rev-parse', `${c}~1`), headSha: c }, { host: 'localhost:5420' })).statusCode, 403)
  const r = await identify(t.id, { baseSha: git(repo, 'rev-parse', `${c}~1`), headSha: c })
  assert.equal(r.statusCode, 200)
  let v = r.json().view
  assert.equal(v.integration.state, 'in-target'); assert.equal(v.canIntegrate, false)
  assert.equal(v.delivery.commits.length, 1); assert.equal(v.delivery.head, c)
  assert.equal(v.acceptance.state, 'none'); assert.equal(v.stage, 'REVIEW')
  assert.equal(v.delivery.direct.claim.basis, 'person')
  assert.match(v.delivery.direct.uncertainty.join(' '), /attributed to the task by a person/)
  assert.equal(v.canAccept, true)
  // The acceptance binds the exact commit.
  assert.ok((await accept(t.id, { targetBranch: 'master', expectedHeadSha: base })).statusCode >= 400)
  const a = await accept(t.id, { targetBranch: 'master', expectedHeadSha: c })
  assert.equal(a.statusCode, 200)
  v = await view(t.id)
  assert.equal(v.acceptance.state, 'accepted'); assert.equal(v.stage, 'INTEGRATED'); assert.equal(v.integration.state, 'in-target')
  // There is nothing to merge, and the route says so instead of inventing a merge commit.
  const before = git(repo, 'rev-parse', 'HEAD')
  const m = await app.inject({ method: 'POST', url: url(t.id, '/integrate'), headers: UI, payload: { targetBranch: 'master', expectedHeadSha: c } })
  assert.ok(m.statusCode >= 400); assert.equal(m.json().code, 'direct-delivery')
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
  // Revoking acceptance does not touch Git.
  assert.equal((await app.inject({ method: 'DELETE', url: url(t.id, '/accept'), headers: UI })).statusCode, 200)
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
})

test('the range must be real: not in the target, reversed, or empty is refused', async () => {
  const t = await mk('Bad ranges')
  const c = commit('scenes/c.tscn', '[gd_scene]\n', 'feat: c')
  assert.equal((await identify(t.id, { baseSha: c, headSha: c })).json().code, 'bad-range')
  assert.equal((await identify(t.id, { baseSha: c, headSha: base })).json().code, 'bad-range')
  assert.equal((await identify(t.id, { baseSha: base, headSha: 'deadbeef' })).json().code, 'unknown-commit')
  assert.equal((await identify(t.id, { baseSha: base })).json().code, 'range-required')
  assert.equal((await identify(t.id, { baseSha: '--output=x', headSha: c })).json().code, 'bad-commit')
  assert.equal((await identify(t.id, { baseSha: 'master', headSha: c })).json().code, 'bad-commit')
  git(repo, 'branch', 'side', base); git(repo, 'checkout', '-q', 'side')
  const s = commit('side.txt', 'x', 'side'); git(repo, 'checkout', '-q', 'master')
  assert.equal((await identify(t.id, { baseSha: base, headSha: s })).json().code, 'not-in-target')
})

test('a trailer naming this task proves the attribution; another task\'s trailer proves nothing here', async () => {
  const t = await mk('With trailer'); const other = await mk('Other task')
  put(repo, 'scenes/d.tscn', '[gd_scene]\n'); git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'feat: d', '-m', `Shipyard-Task: ${t.id}`)
  const d = git(repo, 'rev-parse', 'HEAD')
  put(repo, 'scenes/e.tscn', '[gd_scene]\n'); git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'feat: e', '-m', `Shipyard-Task: ${other.id}`)
  const e = git(repo, 'rev-parse', 'HEAD')
  const v0 = await view(t.id)
  const byHash = Object.fromEntries(v0.delivery.direct.candidates.map((c: any) => [c.sha, c.trailer]))
  assert.equal(byHash[d], true); assert.equal(byHash[e], false)
  const r = await identify(t.id, { baseSha: git(repo, 'rev-parse', `${d}~1`), headSha: d })
  assert.equal(r.json().view.delivery.direct.claim.basis, 'trailer')
  const r2 = await identify(t.id, { baseSha: git(repo, 'rev-parse', `${d}~1`), headSha: e })
  assert.equal(r2.json().view.delivery.direct.claim.basis, 'person', 'one foreign trailer in the range breaks the proof')
})

test('5. two tasks sharing a checkout are flagged as such; the uncertainty is shown, not hidden', async () => {
  const a = await mk('Agent A'); const b = await mk('Agent B')
  const v = await view(a.id)
  assert.ok(v.delivery.direct.concurrentTasks.some((c: any) => c.id === b.id))
  assert.match(v.delivery.direct.uncertainty.join(' '), /also worked in this checkout/)
})

test('4. a task whose session is still active cannot be accepted and says why', async () => {
  const t = await mk('Still running', 'done')
  const c = commit('scenes/f.tscn', '[gd_scene]\n', 'feat: f')
  await identify(t.id, { baseSha: git(repo, 'rev-parse', `${c}~1`), headSha: c })
  const live = [{ id: 's1', taskId: t.id, agent: 'claude', state: 'busy' as const }]
  const task: any = await taskStore.getTask(project.id, t.id)
  const v = await lc.resolveLifecycle(project, task, { sessions: live })
  assert.equal(v.execution.sessionActive, true)
  assert.equal(v.canAccept, false); assert.ok(v.blockers.some((b: any) => b.code === 'session-active'))
  assert.match(v.delivery.direct!.uncertainty.join(' '), /still working/)
  // Once the session is no longer busy the same delivery is acceptable.
  const idle = await lc.resolveLifecycle(project, task, { sessions: [{ ...live[0], state: 'idle' }] })
  assert.equal(idle.canAccept, true)
})

test('rewriting history under an identified delivery invalidates it instead of trusting stale shas', async () => {
  const t = await mk('Rewritten', 'done')
  const c = commit('scenes/g.tscn', '[gd_scene]\n', 'feat: g')
  await identify(t.id, { baseSha: git(repo, 'rev-parse', `${c}~1`), headSha: c })
  await accept(t.id, { targetBranch: 'master', expectedHeadSha: c })
  git(repo, 'reset', '-q', '--hard', `${c}~1`) // the commit leaves the branch
  const v = await view(t.id)
  assert.ok(v.blockers.some((b: any) => b.code === 'claim-invalid'))
  assert.equal(v.acceptance.state, 'lapsed'); assert.equal(v.canAccept, false)
  assert.equal(v.stage, 'REVIEW')
})

test('a delivered task can be cleared only when it is not accepted', async () => {
  const t = await mk('Clear', 'done')
  const c = commit('scenes/h.tscn', '[gd_scene]\n', 'feat: h')
  await identify(t.id, { baseSha: git(repo, 'rev-parse', `${c}~1`), headSha: c })
  await accept(t.id, { targetBranch: 'master', expectedHeadSha: c })
  const blocked = await app.inject({ method: 'DELETE', url: url(t.id, '/direct-delivery'), headers: UI })
  assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().code, 'accepted')
  await app.inject({ method: 'DELETE', url: url(t.id, '/accept'), headers: UI })
  assert.equal((await app.inject({ method: 'DELETE', url: url(t.id, '/direct-delivery'), headers: UI })).statusCode, 200)
  assert.equal((await view(t.id)).delivery.direct.claim, undefined)
})
