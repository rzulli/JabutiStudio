/**
 * Design Knowledge bridge: dk.py (a copy lives in fixtures/dk — the real one belongs to the game project)
 * -> designKnowledge service -> HTTP routes -> MCP tool. Covers worktree-scoped freshness, graceful
 * degradation and the rule that only a browser-originated request can create an approval.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-dk-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-dk-proj-'))
const project = join(parent, 'dkproj')
const wt = join(parent, 'dkproj-wt')
process.env.SHIPYARD_DATA_DIR = dataDir

const PARAMS = 'extends RefCounted\n## provisional\nconst FIRST := 1000.0\n'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' })

function writeRecord(claim = 'First maturation costs 1000 matter') {
  const rec = {
    id: 'DK-T-001', title: 'First maturation cost', claim, decision_state: 'unknown', approval_state: 'unknown',
    implementation_state: 'implemented', implementation_sources: [], scope: ['first maturation'],
    evidence: [{ type: 'code', ref: 'scripts/params.gd#L3-L3', sha256: sha(PARAMS), note: 'constant' }],
    supersedes: [], conflicts_with: [], files: [{ role: 'param', path: 'scripts/params.gd' }], tests: [], qps: [], tags: ['humus'],
  }
  writeFileSync(join(project, 'docs/design_knowledge/records/r.md'), `<!-- dk-record\n${JSON.stringify(rec)}\n-->\n# r\n`)
}

let app: import('fastify').FastifyInstance
let svc: typeof import('../src/services/designKnowledge.js')

before(async () => {
  mkdirSync(join(project, 'scripts'), { recursive: true })
  mkdirSync(join(project, 'docs/design_knowledge/records'), { recursive: true })
  mkdirSync(join(project, 'tools/design_knowledge'), { recursive: true })
  copyFileSync(join(here, 'fixtures/dk/dk.py'), join(project, 'tools/design_knowledge/dk.py'))
  writeFileSync(join(project, 'scripts/params.gd'), PARAMS)
  writeFileSync(join(project, 'project.godot'), 'config_version=5\n')
  writeRecord()
  git(project, 'init', '-q'); git(project, 'add', '-A'); git(project, 'commit', '-qm', 'base')
  git(project, 'worktree', 'add', '-q', '-b', 'task-1', wt)
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [{ id: 'dkproj', path: project }] }))
  const projects = await (await import('../src/services/projectDiscovery.js')).addProjects([project])
  assert.equal(projects.find(p => p.path === project)?.id, 'dkproj')
  svc = await import('../src/services/designKnowledge.js')
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/design.js')).designRoutes)
})
after(async () => {
  await app?.close()
  for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true })
})

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json()

test('a file lists the decisions that cite it, with unknown approval and current evidence', async () => {
  const res = await get('/api/projects/dkproj/design?file=scripts/params.gd')
  assert.equal(res.available, true)
  assert.equal(res.examined.isCanonical, true)
  const d = res.decisions[0]
  assert.equal(d.id, 'DK-T-001')
  assert.equal(d.approval.state, 'unknown')
  assert.equal(d.evidence[0].freshness, 'CURRENT')
  assert.equal(d.evidence[0].excerpt[0].text, 'const FIRST := 1000.0')
})

test('a worktree is judged on its own code and never contaminates the canonical checkout', async () => {
  writeFileSync(join(wt, 'scripts/params.gd'), '# header\n' + PARAMS)
  svc.clearCache()
  const inWt = await get(`/api/projects/dkproj/design?file=scripts/params.gd&worktree=${encodeURIComponent(wt)}`)
  assert.equal(inWt.examined.isCanonical, false)
  assert.equal(inWt.decisions[0].evidence[0].freshness, 'MOVED')
  assert.deepEqual(inWt.decisions[0].evidence[0].lines, [4, 4])
  const canonical = await get('/api/projects/dkproj/design?file=scripts/params.gd')
  assert.equal(canonical.decisions[0].evidence[0].freshness, 'CURRENT')
})

test('removed or renamed evidence degrades the status instead of failing the query', async () => {
  renameSync(join(wt, 'scripts/params.gd'), join(wt, 'scripts/gone.gd'))
  svc.clearCache()
  const res = await get(`/api/projects/dkproj/design?q=${encodeURIComponent('first maturation')}&worktree=${encodeURIComponent(wt)}`)
  assert.equal(res.available, true)
  assert.equal(res.decisions[0].evidence_status, 'MISSING')
})

test('only git-listed worktrees can be examined', async () => {
  const res = await get(`/api/projects/dkproj/design?file=scripts/params.gd&worktree=${encodeURIComponent(parent)}`)
  assert.equal(res.available, false)
  assert.match(res.reason, /not a git worktree/i)
})

test('a project without a registry reports it, it does not error', async () => {
  const empty = mkdtempSync(join(parent, 'bare-'))
  const res = await svc.contextForQuery({ id: 'bare', path: empty }, 'anything')
  assert.equal(res.available, false)
})

test('approval needs a browser-originated request, and only then becomes attested', async () => {
  const body = { decisionId: 'DK-T-001', state: 'approved', quote: 'Owner: 1000 is fine for now' }
  const agent = await app.inject({ method: 'POST', url: '/api/projects/dkproj/design/approve', payload: body })
  assert.equal(agent.statusCode, 403)
  const curl = await app.inject({ method: 'POST', url: '/api/projects/dkproj/design/approve', payload: body, headers: { 'sec-fetch-site': 'none' } })
  assert.equal(curl.statusCode, 403)
  // sec-fetch headers alone (no Origin) are refused too; a forged Origin is NOT stopped — documented limit
  const noOrigin = await app.inject({ method: 'POST', url: '/api/projects/dkproj/design/approve', payload: body, headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' } })
  assert.equal(noOrigin.statusCode, 403)
  assert.equal((await get('/api/projects/dkproj/design?q=first%20maturation')).decisions[0].approval.state, 'unknown')

  const ui = await app.inject({
    method: 'POST', url: '/api/projects/dkproj/design/approve', payload: body,
    headers: { host: 'localhost:5420', origin: 'http://localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' },
  })
  assert.equal(ui.statusCode, 200, ui.body)
  const after = (await get('/api/projects/dkproj/design?q=first%20maturation')).decisions[0].approval
  assert.deepEqual([after.state, after.source, after.quote], ['approved', 'attested_local', body.quote])
})

test('editing the claim after approval lapses the attestation', async () => {
  writeRecord('First maturation costs 200 matter')
  svc.clearCache()
  const a = (await get('/api/projects/dkproj/design?q=first%20maturation')).decisions[0].approval
  assert.deepEqual([a.state, a.source], ['claimed', 'attestation-lapsed'])
})

test('the MCP tool exposes decisions but offers no way to approve', async () => {
  const mcp = await import('../src/services/mcpServer.js')
  assert.ok(mcp.MCP_TOOLS.some(t => t.name === 'get_design_context'))
  assert.ok(!mcp.MCP_TOOLS.some(t => /approve|attest/i.test(t.name)))
  svc.clearCache()
  const out = await mcp.getDesignContext('dkproj', 'scripts/params.gd')
  const text = out.content[0].text
  assert.match(text, /DK-T-001/)
  assert.match(text, /local UI attestation/)
})
