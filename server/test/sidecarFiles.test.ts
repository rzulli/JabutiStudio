/**
 * Godot sidecars (`<script>.uid`, `<shader>.uid`) are one-line text files Godot generates.
 * They are hidden from the file tree and the filename palettes unless "show sidecar files"
 * asks for them, listed read-only when shown, and readable as text. Nothing on disk changes:
 * the rule lives in the listing, never in the file system. Other Godot files stay visible.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures', 'godot')
const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-sidecar-data-'))
const project = mkdtempSync(join(tmpdir(), 'jabuti-sidecar-proj-'))
process.env.SHIPYARD_DATA_DIR = dataDir

const SCRIPT_UID = 'uid://c3sidecar01\n'
const SHADER_UID = 'uid://c3sidecar02\n'

let app: FastifyInstance
let id: string
let projectRecord: { id: string; path: string; name: string }
let mod: typeof import('../src/routes/files.js')
let sidecars: typeof import('../src/services/sidecarFiles.js')
let search: typeof import('../src/services/fileSearch.js')

const tree = (path = '', query = '') =>
  app.inject({ method: 'GET', url: `/api/projects/${id}/files/tree?path=${encodeURIComponent(path)}${query}` })
const names = (r: { json(): any }) => r.json().entries.map((e: { name: string }) => e.name) as string[]
const put = (path: string, content: string) =>
  app.inject({ method: 'PUT', url: `/api/projects/${id}/files/content`, payload: { path, content } })
const get = (path: string) =>
  app.inject({ method: 'GET', url: `/api/projects/${id}/files/content?path=${encodeURIComponent(path)}`, headers: { accept: 'application/json' } })

before(async () => {
  for (const f of readdirSync(fixtures)) if (!f.startsWith('.')) copyFileSync(join(fixtures, f), join(project, f))
  writeFileSync(join(project, 'traversal_player.gd'), 'extends Node\n')
  writeFileSync(join(project, 'traversal_player.gd.uid'), SCRIPT_UID)
  writeFileSync(join(project, 'water.gdshader.uid'), SHADER_UID)
  writeFileSync(join(project, 'hero.tscn.import'), '[remap]\n')
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  const projects = await (await import('../src/services/projectDiscovery.js')).addProjects([project])
  projectRecord = projects.find(p => p.path.toLowerCase() === project.toLowerCase())!
  id = projectRecord.id
  mod = await import('../src/routes/files.js')
  sidecars = await import('../src/services/sidecarFiles.js')
  search = await import('../src/services/fileSearch.js')
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register(mod.fileRoutes)
})

after(async () => {
  await app?.close()
  for (const d of [dataDir, project]) rmSync(d, { recursive: true, force: true })
})

test('only *.gd.uid and *.gdshader.uid are sidecars; other Godot files are not', () => {
  for (const n of ['traversal_player.gd.uid', 'water.gdshader.uid', 'WATER.GDSHADER.UID']) {
    assert.equal(sidecars.isSidecarFile(n), true, n)
  }
  for (const n of ['player.gd', 'hero.tscn', 'hero.tres', 'hero.tscn.import', 'project.godot', 'x.uid', 'x.gd.uid.bak']) {
    assert.equal(sidecars.isSidecarFile(n), false, n)
  }
})

test('.uid is text, so a visible sidecar is readable instead of "Binary file"', () => {
  assert.equal(mod.getMimeHint('.uid', 'traversal_player.gd.uid'), 'text/plain')
  assert.equal(mod.getMimeHint('.uid', 'x.uid'), 'text/plain')
})

test('the tree hides sidecars by default and keeps every other Godot file', async () => {
  const r = await tree()
  assert.equal(r.statusCode, 200)
  const shown = names(r)
  assert.ok(!shown.includes('traversal_player.gd.uid'))
  assert.ok(!shown.includes('water.gdshader.uid'))
  assert.ok(shown.includes('traversal_player.gd'))
  assert.ok(shown.includes('hero.tscn.import'))
  assert.ok(shown.includes('project.godot'))
})

test('sidecars=show lists them, marked read-only, and nothing else changes', async () => {
  const shown = await tree('', '&sidecars=show')
  const byName = new Map<string, any>(shown.json().entries.map((e: any) => [e.name, e]))
  assert.equal(byName.get('traversal_player.gd.uid')?.readOnly, true)
  assert.equal(byName.get('water.gdshader.uid')?.readOnly, true)
  assert.equal(byName.get('traversal_player.gd')?.readOnly, undefined)
  assert.equal(byName.get('hero.tscn.import')?.readOnly, undefined)
})

test('a sidecar reads as text and cannot be written; its bytes stay on disk', async () => {
  const r = await get('traversal_player.gd.uid')
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().mimeHint, 'text/plain')
  assert.equal(r.json().content, SCRIPT_UID)

  const w = await put('traversal_player.gd.uid', 'uid://changed\n')
  assert.equal(w.statusCode, 403)
  assert.equal(readFileSync(join(project, 'traversal_player.gd.uid'), 'utf8'), SCRIPT_UID)
})

test('filename search hides sidecars unless asked, and the index is shared', async () => {
  const hidden = await search.searchFileNames([projectRecord as any], 'traversal', {
    limit: 30,
    filter: { ignore: new Set(), isVisibleDotfile: () => false },
  })
  assert.ok(!hidden.some(r => r.name === 'traversal_player.gd.uid'))
  assert.ok(hidden.some(r => r.name === 'traversal_player.gd'))

  const shown = await search.searchFileNames([projectRecord as any], 'traversal', {
    limit: 30,
    includeSidecars: true,
    filter: { ignore: new Set(), isVisibleDotfile: () => false },
  })
  assert.ok(shown.some(r => r.name === 'traversal_player.gd.uid'))
})
