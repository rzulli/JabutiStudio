/**
 * Human actions (Accept / Reject on a system) must be accepted when they come from the app's own page,
 * whichever origin serves it: the backend itself, Vite's dev server (its proxy rewrites Host), or the
 * Electron window (127.0.0.1 in production). Agents and cross-site pages must still be refused.
 * The check is browser-only metadata: a page cannot forge Origin or Sec-Fetch-* headers.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-origin-data-'))
const parent = mkdtempSync(join(tmpdir(), 'jabuti-origin-proj-'))
const repo = join(parent, 'nodk')
process.env.SHIPYARD_DATA_DIR = dataDir

const put = (rel: string, text: string) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text) }

let app: FastifyInstance
let fromAppUi: (h: Record<string, unknown>) => boolean
const SYSTEM = '/api/projects/nodk/systems/sys-grain'

// Headers a real browser sends for a fetch() issued by the app's own page.
const sameOriginFetch = (origin: string, host: string) => ({ origin, host, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' })

before(async () => {
  put('project.godot', 'config_version=5\n')
  put('scripts/GrainStore.gd', 'extends Node\nfunc add():\n\tpass\n')
  put('scripts/Mill.gd', 'extends Node\nvar g = grain\n')
  execFileSync('git', ['-C', repo, 'init', '-q'])
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'])
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [{ id: 'nodk', path: repo }] }))

  const pd = await import('../src/services/projectDiscovery.js')
  await pd.addProjects([repo])
  const svc = await import('../src/services/systemCatalog.js')
  await svc.propose('nodk', { name: 'Grain', summary: 'Stores grain.', terms: ['grain'], files: ['scripts/Mill.gd'] }, 'agent')

  fromAppUi = (await import('../src/routes/design.js')).fromAppUi
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register((await import('../src/routes/systems.js')).systemRoutes)
})

after(async () => {
  await app?.close()
  for (const d of [dataDir, parent]) rmSync(d, { recursive: true, force: true })
})

test('fromAppUi: the app page is recognised from the backend, Vite dev and Electron origins', () => {
  assert.equal(fromAppUi(sameOriginFetch('http://localhost:5420', 'localhost:5420')), true, 'backend-served page')
  // Vite's proxy (changeOrigin) rewrites Host to the backend while Origin stays the dev page
  assert.equal(fromAppUi(sameOriginFetch('http://localhost:5421', 'localhost:5420')), true, 'Vite dev page via proxy')
  // Electron production window loads http://127.0.0.1:5430
  assert.equal(fromAppUi(sameOriginFetch('http://127.0.0.1:5430', '127.0.0.1:5430')), true, 'Electron window')
  assert.equal(fromAppUi(sameOriginFetch('http://localhost:5421', 'localhost:5420')), true)
})

test('fromAppUi: agents, scripts and cross-site pages are still refused', () => {
  assert.equal(fromAppUi({ host: 'localhost:5420' }), false, 'no Origin, no fetch metadata (agent/curl)')
  assert.equal(fromAppUi({ host: 'localhost:5420', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }), false, 'fetch metadata without Origin')
  assert.equal(fromAppUi({ ...sameOriginFetch('http://evil.example', 'localhost:5420') }), false, 'foreign page origin')
  assert.equal(fromAppUi({ ...sameOriginFetch('http://localhost:5420', 'localhost:5420'), 'sec-fetch-site': 'cross-site' }), false, 'cross-site request')
  assert.equal(fromAppUi({ ...sameOriginFetch('null', 'localhost:5420') }), false, 'sandboxed frame origin "null"')
  assert.equal(fromAppUi({ ...sameOriginFetch('http://localhost:5420', 'localhost:5420'), 'sec-fetch-dest': 'document' }), false, 'top-level document, not a fetch')
})

test('a classification from the Electron or Vite app succeeds; the agent path stays refused', async () => {
  const agent = await app.inject({ method: 'PATCH', url: SYSTEM, payload: { confirm: { areas: [] } }, headers: { host: '127.0.0.1:5420' } })
  assert.equal(agent.statusCode, 403)
  assert.match(agent.json().error, /Agents may propose/)

  const accept = await app.inject({ method: 'PATCH', url: SYSTEM, payload: { status: 'confirmed' }, headers: sameOriginFetch('http://127.0.0.1:5430', '127.0.0.1:5430') })
  assert.equal(accept.statusCode, 200, accept.body)
  assert.equal(accept.json().status, 'confirmed')

  const viteAccept = await app.inject({ method: 'PATCH', url: SYSTEM, payload: { summary: 'Human text' }, headers: sameOriginFetch('http://localhost:5421', 'localhost:5420') })
  assert.equal(viteAccept.statusCode, 200, viteAccept.body)
})
