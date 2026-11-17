/**
 * Godot files are plain text. The file API used to class .gd/.tscn/.tres/.godot/.gdshader as
 * application/octet-stream (they were missing from TEXT_EXTENSIONS), so the explorer refused to
 * open them and PUT /files/content answered 400 "Cannot write binary files".
 * Real binaries (.res, .png) must keep that behaviour; untouched text must round-trip byte for byte.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures', 'godot')
const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-godot-data-'))
const project = mkdtempSync(join(tmpdir(), 'jabuti-godot-proj-'))
process.env.SHIPYARD_DATA_DIR = dataDir

// Generated here, not committed: git may normalise CRLF, and NUL bytes make a poor fixture file.
const CRLF = Buffer.from('[gd_scene format=3]\r\n\r\n[node name="Crlf" type="Node"]\r\nmetadata/note = "windows line endings"\r\n')
const RES = Buffer.from([0x52, 0x53, 0x52, 0x43, 0, 0, 0, 1, 0, 3, 0xff, 0xfe, 0, 0x62, 0x69, 0x6e])
const TEXT = [...readdirSync(fixtures).filter(f => !f.startsWith('.')), 'crlf.tscn']
let app: FastifyInstance
let id: string
let getMimeHint: (ext: string, name: string) => string

const get = (path: string) => app.inject({ method: 'GET', url: `/api/projects/${id}/files/content?path=${encodeURIComponent(path)}`, headers: { accept: 'application/json' } })
const put = (path: string, content: string) => app.inject({ method: 'PUT', url: `/api/projects/${id}/files/content`, payload: { path, content } })

before(async () => {
  for (const f of readdirSync(fixtures)) if (!f.startsWith('.')) copyFileSync(join(fixtures, f), join(project, f))
  writeFileSync(join(project, 'crlf.tscn'), CRLF)
  writeFileSync(join(project, 'packed.res'), RES)
  writeFileSync(join(project, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [] }))
  const projects = await (await import('../src/services/projectDiscovery.js')).addProjects([project])
  id = projects.find(p => p.path.toLowerCase() === project.toLowerCase())!.id
  const mod = await import('../src/routes/files.js')
  getMimeHint = mod.getMimeHint
  const Fastify = (await import('fastify')).default
  app = Fastify()
  await app.register(mod.fileRoutes)
})

after(async () => {
  await app?.close()
  for (const d of [dataDir, project]) rmSync(d, { recursive: true, force: true })
})

test('project.godot and every Godot text extension are text, not octet-stream', () => {
  for (const f of TEXT) assert.equal(getMimeHint(f.slice(f.lastIndexOf('.')), f), 'text/plain', f)
  for (const e of ['.gdshaderinc', '.gdextension', '.import']) assert.equal(getMimeHint(e, `x${e}`), 'text/plain', e)
})

test('real binaries stay binary: .res, .scn, unknown extensions, images', () => {
  assert.equal(getMimeHint('.res', 'packed.res'), 'application/octet-stream')
  assert.equal(getMimeHint('.scn', 'a.scn'), 'application/octet-stream')
  assert.equal(getMimeHint('.png', 'pixel.png'), 'image/png')
})

test('GET project.godot returns its text with a text mime hint', async () => {
  const r = await get('project.godot')
  assert.equal(r.statusCode, 200)
  const b = r.json()
  assert.equal(b.mimeHint, 'text/plain')
  assert.equal(b.content, readFileSync(join(fixtures, 'project.godot'), 'utf8'))
  assert.match(b.content, /^\[application\]/m)
})

test('opening and saving the content untouched is byte-identical (LF, CRLF, tabs)', async () => {
  for (const f of TEXT) {
    const original = readFileSync(join(project, f))
    const { content } = (await get(f)).json()
    const r = await put(f, content)
    assert.equal(r.statusCode, 200, f)
    assert.ok(readFileSync(join(project, f)).equals(original), `${f} changed on a no-op save`)
  }
  assert.ok(readFileSync(join(project, 'crlf.tscn')).equals(CRLF))
  assert.ok(readFileSync(join(project, 'player.gd'), 'utf8').includes('\n\t# tabs'))
})

test('an explicit edit is saved and read back; nothing else changes', async () => {
  const { content } = (await get('project.godot')).json()
  const edited = content.replace('"Incremental Demo"', '"Renamed Demo"')
  assert.notEqual(edited, content)
  assert.equal((await put('project.godot', edited)).statusCode, 200)
  const back = (await get('project.godot')).json().content
  assert.equal(back, edited)
  assert.equal(back.replace('"Renamed Demo"', '"Incremental Demo"'), content)
})

test('binary files still cannot be written and are left untouched', async () => {
  assert.equal((await put('packed.res', 'overwrite')).statusCode, 400)
  assert.equal((await put('pixel.png', 'x')).statusCode, 400)
  assert.ok(readFileSync(join(project, 'packed.res')).equals(RES))
  assert.equal((await get('packed.res')).json().mimeHint, 'application/octet-stream')
})

test('read errors are reported, not shown as empty text', async () => {
  assert.equal((await get('missing.godot')).statusCode, 500)
  assert.equal((await put('missing.tscn', 'x')).statusCode, 404)
  assert.equal((await get('../outside.godot')).statusCode, 403)
})
