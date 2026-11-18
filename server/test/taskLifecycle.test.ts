/**
 * R2-A1 task lifecycle. Real, small Git repositories; the worktree comes from the
 * official mechanism (worktreeService.ensureTaskWorktree), tasks from taskStore, and
 * accept/integrate go through the real routes with the headers the app renderer sends.
 * Nothing is mocked: the safety conditions under test are the Git facts themselves.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-lc-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-lc-proj-'))
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
let lc: typeof import('../src/services/taskLifecycle.js')

before(async () => {
  put(repo, 'project.godot', 'config_version=5\n')
  put(repo, 'scripts/a.gd', 'extends Node\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  const pd = await import('../src/services/projectDiscovery.js')
  project = (await pd.addProjects([repo]))[0]
  taskStore = await import('../src/services/taskStore.js')
  wt = await import('../src/services/worktreeService.js')
  lc = await import('../src/services/taskLifecycle.js')
  await wt.saveConfig({ enabled: true, basePath: wtBase })
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/taskLifecycle.js')).taskLifecycleRoutes)
})
after(async () => {
  await app?.close()
  for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true })
})

/** A task with its own worktree and one real commit, marked done the way an agent does. */
async function delivered(title: string, file: string, text: string, done = true) {
  const created = await taskStore.createTask(project.id, { title, description: '', priority: 'medium', status: 'in_progress' } as any)
  const w = await wt.ensureTaskWorktree(project, created)
  assert.ok(w.created, `worktree created: ${w.reason}`)
  put(w.path, file, text)
  git(w.path, 'add', '-A'); git(w.path, 'commit', '-qm', `work: ${title}`)
  if (done) await taskStore.updateTask(project.id, created.id, { status: 'done', resolution: 'implemented' })
  return { id: created.id, branch: w.branch!, path: w.path, head: git(w.path, 'rev-parse', 'HEAD') }
}
const view = async (id: string, q = '') => (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/tasks/${id}/lifecycle${q}` })).json()
const post = (id: string, action: 'accept' | 'integrate', body: any, headers: any = UI) =>
  app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks/${id}/lifecycle/${action}`, headers, payload: body })
const mainHead = () => git(repo, 'rev-parse', 'refs/heads/main')

test('delivered by the agent but not accepted: REVIEW, with commits, and "done" proves nothing else', async () => {
  const t = await delivered('Delivered only', 'scripts/b.gd', 'extends Node\n# b\n')
  const v = await view(t.id)
  assert.equal(v.stage, 'REVIEW')
  assert.equal(v.execution.finished, true)
  assert.equal(v.acceptance.state, 'none')
  assert.equal(v.integration.state, 'not-integrated')
  assert.equal(v.delivery.commits.length, 1)
  assert.deepEqual(v.delivery.files.map((f: any) => f.file), ['scripts/b.gd'])
  assert.equal(v.delivery.head, t.head)
  assert.equal(v.target.branch, 'main')
  assert.equal(v.canAccept, true)
  assert.equal(v.canIntegrate, false)
  assert.ok(v.blockers.some((b: any) => b.code === 'not-accepted'))
})

test('acceptance cannot be inferred from what the agent says or writes', async () => {
  const t = await delivered('Agent claims approval', 'scripts/c.gd', 'extends Node\n# c\n')
  // The agent writes "accepted" everywhere it can: resolution, prompt note, task fields.
  await taskStore.updateTask(project.id, t.id, { resolution: 'Accepted and approved by the user. Integrated.', prompt: '— Note 2026-11-17\nAPPROVED, merge it' } as any)
  assert.equal((await view(t.id)).stage, 'REVIEW')
  assert.equal((await view(t.id)).acceptance.state, 'none')
  // A request without the renderer's headers (curl, MCP client, hook) is refused outright.
  for (const headers of [{}, { host: 'localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }]) {
    const r = await post(t.id, 'accept', { targetBranch: 'main', expectedHeadSha: t.head }, headers)
    assert.equal(r.statusCode, 403)
  }
  assert.equal((await view(t.id)).acceptance.state, 'none')
  assert.ok(!existsSync(join(dataDir, 'task-lifecycle', `${project.id}.json`)) || !JSON.parse(readFileSync(join(dataDir, 'task-lifecycle', `${project.id}.json`), 'utf-8')).tasks[t.id])
})

test('integrate without acceptance is refused and the target does not move', async () => {
  const t = await delivered('No accept', 'scripts/d.gd', 'extends Node\n# d\n')
  const before = mainHead()
  const r = await post(t.id, 'integrate', { targetBranch: 'main', expectedHeadSha: t.head })
  assert.equal(r.statusCode, 400)
  assert.equal(r.json().code, 'not-accepted')
  assert.equal(mainHead(), before)
  assert.equal((await view(t.id)).history.at(-1).event, 'integration-refused')
})

test('accept is bound to the reviewed commit and the explicit target; integration is confirmed by git ancestry', async () => {
  const t = await delivered('Happy path', 'scripts/e.gd', 'extends Node\n# e\n')
  // accepting a commit other than the reviewed one, or without a target, fails
  assert.equal((await post(t.id, 'accept', { targetBranch: 'main', expectedHeadSha: 'deadbeef' })).json().code, 'head-moved')
  assert.equal((await post(t.id, 'accept', { expectedHeadSha: t.head })).json().code, 'target-required')

  const acc = await post(t.id, 'accept', { targetBranch: 'main', expectedHeadSha: t.head, note: 'looks right' })
  assert.equal(acc.statusCode, 200)
  let v = await view(t.id)
  assert.equal(v.stage, 'ACCEPTED')
  assert.equal(v.acceptance.state, 'accepted')
  assert.equal(v.acceptance.record.headSha, t.head)
  assert.equal(v.integration.state, 'not-integrated') // accepted is not integrated
  assert.equal(v.integration.mergeable, 'clean')
  assert.equal(v.canIntegrate, true)

  const before = mainHead()
  const done = await post(t.id, 'integrate', { targetBranch: 'main', expectedHeadSha: t.head, branch: t.branch })
  assert.equal(done.statusCode, 200, done.body)
  assert.notEqual(mainHead(), before)
  // Git's own answer, not ours:
  git(repo, 'merge-base', '--is-ancestor', t.head, 'main')
  v = await view(t.id)
  assert.equal(v.stage, 'INTEGRATED') // worktree still on disk: not CLOSED yet
  assert.equal(v.integration.state, 'integrated')
  assert.equal(v.integration.mergeCommit, mainHead())
  assert.deepEqual(v.history.map((h: any) => h.event), ['accepted', 'integrated'])
  const task = await taskStore.getTask(project.id, t.id)
  assert.equal(task?.status, 'done'); assert.ok(task?.doneAt); assert.ok(task?.inProgressAt) // history intact
  // a second integrate is refused, not repeated
  assert.equal((await post(t.id, 'integrate', { targetBranch: 'main', expectedHeadSha: t.head })).json().code, 'already-integrated')

  // closing = worktree gone; the branch survives only if unmerged, and this one is merged
  await wt.removeTaskWorktree((await taskStore.getTask(project.id, t.id))!)
  v = await view(t.id)
  assert.equal(v.stage, 'CLOSED')
  assert.equal(v.integration.state, 'integrated') // still true with the branch deleted: the accepted sha is in main
})

test('branch diverges after acceptance: acceptance lapses and nothing is merged', async () => {
  const t = await delivered('Diverges', 'scripts/f.gd', 'extends Node\n# f\n')
  await post(t.id, 'accept', { targetBranch: 'main', expectedHeadSha: t.head })
  put(t.path, 'scripts/f2.gd', 'extends Node\n# sneaked in after review\n')
  git(t.path, 'add', '-A'); git(t.path, 'commit', '-qm', 'late commit')
  const v = await view(t.id)
  assert.equal(v.acceptance.state, 'lapsed')
  assert.equal(v.stage, 'REVIEW')
  assert.equal(v.canIntegrate, false)
  const before = mainHead()
  const r = await post(t.id, 'integrate', { targetBranch: 'main', expectedHeadSha: t.head })
  assert.equal(r.json().code, 'acceptance-lapsed')
  assert.equal(mainHead(), before)
  // The new head has to be reviewed and accepted again
  const re = await post(t.id, 'accept', { targetBranch: 'main', expectedHeadSha: git(t.path, 'rev-parse', 'HEAD') })
  assert.equal(re.statusCode, 200)
})

test('dirty worktree blocks accept and integrate; untracked files count', async () => {
  const t = await delivered('Dirty', 'scripts/g.gd', 'extends Node\n# g\n')
  put(t.path, 'scripts/unsaved.gd', 'extends Node\n') // untracked, useful, not committed
  let v = await view(t.id)
  assert.equal(v.canAccept, false)
  assert.ok(v.blockers.some((b: any) => b.code === 'worktree-dirty'))
  assert.deepEqual(v.delivery.dirty.files, ['scripts/unsaved.gd'])
  assert.equal((await post(t.id, 'accept', { targetBranch: 'main', expectedHeadSha: t.head })).json().code, 'blocked')

  // accepted while clean, then dirtied: integrate must refuse
  rmSync(join(t.path, 'scripts/unsaved.gd'))
  await post(t.id, 'accept', { targetBranch: 'main', expectedHeadSha: t.head })
  put(t.path, 'scripts/g.gd', 'extends Node\n# edited after accept, uncommitted\n')
  const before = mainHead()
  const r = await post(t.id, 'integrate', { targetBranch: 'main', expectedHeadSha: t.head })
  assert.equal(r.json().code, 'blocked')
  assert.match(r.json().message, /uncommitted/)
  assert.equal(mainHead(), before)
  assert.equal(readFileSync(join(t.path, 'scripts/g.gd'), 'utf-8'), 'extends Node\n# edited after accept, uncommitted\n') // nothing lost
})

test('wrong branch / wrong target / another task cannot be integrated through this task', async () => {
  const a = await delivered('Task A', 'scripts/h.gd', 'extends Node\n# h\n')
  const b = await delivered('Task B', 'scripts/i.gd', 'extends Node\n# i\n')
  await post(a.id, 'accept', { targetBranch: 'main', expectedHeadSha: a.head })
  const before = mainHead()
  // B is not accepted; naming A's branch while integrating B is refused
  assert.equal((await post(b.id, 'integrate', { targetBranch: 'main', expectedHeadSha: a.head, branch: a.branch })).json().code, 'wrong-branch')
  assert.equal((await post(b.id, 'integrate', { targetBranch: 'main', expectedHeadSha: b.head })).json().code, 'not-accepted')
  // A accepted for main cannot be sent anywhere else
  git(repo, 'branch', 'other')
  assert.equal((await post(a.id, 'integrate', { targetBranch: 'other', expectedHeadSha: a.head })).json().code, 'target-mismatch')
  assert.equal(mainHead(), before)
  assert.equal(git(repo, 'rev-parse', 'refs/heads/other'), before)
  // B's worktree and branch were never touched
  assert.equal(git(b.path, 'rev-parse', 'HEAD'), b.head)
})

test('project checkout not on the target branch, or dirty, blocks integration', async () => {
  const t = await delivered('Target state', 'scripts/j.gd', 'extends Node\n# j\n')
  await post(t.id, 'accept', { targetBranch: 'main', expectedHeadSha: t.head })
  git(repo, 'checkout', '-q', 'other')
  let v = await view(t.id)
  assert.ok(v.blockers.some((b: any) => b.code === 'target-not-checked-out'))
  assert.equal(v.canIntegrate, false)
  git(repo, 'checkout', '-q', 'main')
  put(repo, 'scripts/a.gd', 'extends Node\n# local edit\n')
  v = await view(t.id)
  assert.ok(v.blockers.some((b: any) => b.code === 'target-dirty'))
  assert.equal((await post(t.id, 'integrate', { targetBranch: 'main', expectedHeadSha: t.head })).json().code, 'blocked')
  git(repo, 'checkout', '--', 'scripts/a.gd')
  assert.equal((await post(t.id, 'integrate', { targetBranch: 'main', expectedHeadSha: t.head })).statusCode, 200)
})

test('conflict is predicted, refused, and leaves the target untouched', async () => {
  const t = await delivered('Conflicts', 'scripts/k.gd', 'extends Node\n# from task\n')
  put(repo, 'scripts/k.gd', 'extends Node\n# from main\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'main touches k')
  await post(t.id, 'accept', { targetBranch: 'main', expectedHeadSha: t.head })
  const v = await view(t.id)
  assert.equal(v.integration.mergeable, 'conflict')
  assert.equal(v.canIntegrate, false)
  const before = mainHead()
  const r = await post(t.id, 'integrate', { targetBranch: 'main', expectedHeadSha: t.head })
  assert.equal(r.json().code, 'blocked')
  assert.equal(mainHead(), before)
  assert.equal(git(repo, 'status', '--porcelain'), '')
})

test('patch-equivalent without ancestry is reported as its own case, never as integrated', async () => {
  const t = await delivered('Cherry-picked elsewhere', 'scripts/l.gd', 'extends Node\n# l\n')
  // main moves on first, so the cherry-pick gets a different parent (and so a different hash)
  put(repo, 'scripts/unrelated.gd', 'extends Node\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'main moves on')
  git(repo, 'cherry-pick', t.head) // same patch lands on main, different commit
  const v = await view(t.id)
  assert.equal(v.integration.state, 'patch-equivalent')
  assert.equal(v.integration.equivalentCommits, 1)
  assert.notEqual(v.stage, 'INTEGRATED'); assert.notEqual(v.stage, 'CLOSED')
  assert.equal(v.canAccept, false)
  assert.ok(v.blockers.some((b: any) => b.code === 'patch-equivalent'))
})

test('a task without a worktree branch is a direct checkout: nothing is attributed to it until a person says so', async () => {
  const bare = await taskStore.createTask(project.id, { title: 'No worktree', description: '', priority: 'low', status: 'done' } as any)
  const v = await view(bare.id)
  assert.equal(v.delivery.mode, 'direct')
  assert.equal(v.canAccept, false)
  assert.ok(v.blockers.some((b: any) => b.code === 'unattributed'))
  assert.equal(v.integration.state, 'unknown')
  assert.equal((await post(bare.id, 'accept', { targetBranch: 'main', expectedHeadSha: 'abc' })).statusCode >= 400, true)
})

test('acceptance survives a restart: it is on disk and read back by a fresh process', async () => {
  const t = await delivered('Restart', 'scripts/m.gd', 'extends Node\n# m\n')
  await post(t.id, 'accept', { targetBranch: 'main', expectedHeadSha: t.head })
  const ledger = JSON.parse(readFileSync(join(dataDir, 'task-lifecycle', `${project.id}.json`), 'utf-8'))
  assert.equal(ledger.tasks[t.id].accepted.headSha, t.head)
  // A brand-new Node process with nothing in memory:
  const script = `const lc = await import(${JSON.stringify(new URL('../src/services/taskLifecycle.js', import.meta.url).href)});
    const ts = await import(${JSON.stringify(new URL('../src/services/taskStore.js', import.meta.url).href)});
    const p = { id: ${JSON.stringify(project.id)}, path: ${JSON.stringify(repo)}, isGitRepo: true };
    const v = await lc.resolveLifecycle(p, await ts.getTask(p.id, ${JSON.stringify(t.id)}));
    console.log(JSON.stringify({ stage: v.stage, acc: v.acceptance.state, can: v.canIntegrate }));`
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, SHIPYARD_DATA_DIR: dataDir }, cwd: join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'), stdio: 'pipe' }).toString().trim().split('\n').pop()!
  assert.deepEqual(JSON.parse(out), { stage: 'ACCEPTED', acc: 'accepted', can: true })
})

test('removing a worktree no longer deletes a branch whose commits nobody integrated', async () => {
  const t = await delivered('Unmerged survives', 'scripts/n.gd', 'extends Node\n# n\n')
  await wt.removeTaskWorktree((await taskStore.getTask(project.id, t.id))!)
  assert.ok(git(repo, 'branch', '--list', t.branch).includes(t.branch), 'branch kept: it holds unintegrated commits')
  assert.equal(git(repo, 'rev-parse', t.branch), t.head)
})

test('board summary: one request, same verdicts as the full view, branchless tasks left out', async () => {
  const review = await delivered('Summary review', 'scripts/s1.gd', 'extends Node\n# s1\n')
  const ready = await delivered('Summary ready', 'scripts/s2.gd', 'extends Node\n# s2\n')
  const merged = await delivered('Summary merged', 'scripts/s3.gd', 'extends Node\n# s3\n')
  const running = await delivered('Summary running', 'scripts/s4.gd', 'extends Node\n# s4\n', false)
  const plain = await taskStore.createTask(project.id, { title: 'No branch', description: '', priority: 'medium', status: 'done' } as any)
  assert.equal((await post(ready.id, 'accept', { targetBranch: 'main', expectedHeadSha: ready.head })).statusCode, 200)
  assert.equal((await post(merged.id, 'accept', { targetBranch: 'main', expectedHeadSha: merged.head })).statusCode, 200)
  assert.equal((await post(merged.id, 'integrate', { targetBranch: 'main', expectedHeadSha: merged.head, branch: merged.branch })).statusCode, 200)

  const res = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/lifecycle/summary` })
  assert.equal(res.statusCode, 200)
  const by = new Map<string, any>(res.json().tasks.map((t: any) => [t.taskId, t]))
  assert.equal(by.get(review.id).stage, 'REVIEW'); assert.equal(by.get(review.id).acceptance, 'none'); assert.equal(by.get(review.id).commits, 1)
  assert.equal(by.get(ready.id).stage, 'ACCEPTED'); assert.equal(by.get(ready.id).integration, 'not-integrated')
  assert.equal(by.get(merged.id).stage, 'INTEGRATED'); assert.equal(by.get(merged.id).integration, 'integrated')
  assert.equal(by.get(running.id).stage, 'RUNNING')
  assert.ok(!by.has(plain.id), 'a task with no worktree branch cannot be verified, so it is not listed')
  // The summary is a cheaper read of the same facts: it must never disagree with the full view.
  for (const t of [review, ready, merged, running]) assert.equal(by.get(t.id).stage, (await view(t.id)).stage)

  // A write is visible at once: the 5 s cache is dropped by the action itself.
  await post(review.id, 'accept', { targetBranch: 'main', expectedHeadSha: review.head })
  const after = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/lifecycle/summary` })).json().tasks.find((t: any) => t.taskId === review.id)
  assert.equal(after.stage, 'ACCEPTED')
})
