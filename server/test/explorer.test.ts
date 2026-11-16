/**
 * Boundary tests for the Project Explorer: Graphify's real graph.json (a slice
 * of the PNMG analysis, see make-fixture.mjs) -> graphifyAdapter -> HTTP route
 * -> the client's view logic. Run: `pnpm --filter shipyard-server test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = mkdtempSync(join(tmpdir(), 'jabuti-explorer-'))
const projectParent = mkdtempSync(join(tmpdir(), 'jabuti-godot-'))
const projectRoot = join(projectParent, 'pnmg') // folder name = project id
process.env.SHIPYARD_DATA_DIR = dataDir

let adapter: typeof import('../src/services/graphifyAdapter.js')
let app: import('fastify').FastifyInstance

before(async () => {
  const out = join(dataDir, 'graphify/projects/pnmg/tree/graphify-out')
  mkdirSync(out, { recursive: true })
  copyFileSync(join(here, 'fixtures/pnmg-slice.graph.json'), join(out, 'graph.json'))
  mkdirSync(projectRoot)
  writeFileSync(join(projectRoot, 'project.godot'), 'config_version=5\n')
  adapter = await import('../src/services/graphifyAdapter.js')
  const projects = await (await import('../src/services/projectDiscovery.js')).addProjects([projectRoot])
  assert.equal(projects.find(p => p.path === projectRoot)?.id, 'pnmg')
  const Fastify = (await import('fastify')).default
  const { explorerRoutes } = await import('../src/routes/explorer.js')
  app = Fastify()
  await app.register(explorerRoutes)
})
after(async () => {
  await app?.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(projectParent, { recursive: true, force: true })
})

// ── Graphify -> adapter ──────────────────────────────────────────

test('adapter reads functions, signals and classes out of the real graph', async () => {
  const g = (await adapter.loadGraph('pnmg'))!
  const kinds: Record<string, number> = {}
  for (const n of g.nodes.values()) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1
  assert.ok(kinds.func > 100, `functions: ${kinds.func}`)
  assert.equal(kinds.signal, 28)
  assert.equal(kinds.class, 6)
  assert.equal(kinds.file, 19)
})

test('edge direction comes from _src/_tgt, not the swapped source/target', async () => {
  const g = (await adapter.loadGraph('pnmg'))!
  const inherits = (g.out.get('scripts_appshellinput_gd') ?? []).filter(e => e.relation === 'inherits')
  assert.ok(inherits.some(e => e.to === 'node'), 'AppShellInput.gd -inherits-> Node')
  const imports = (g.out.get('boss_tscn') ?? []).find(e => e.relation === 'imports_from' && e.to === 'scripts_boss_gd')
  assert.ok(imports, 'Boss.tscn -imports_from-> Boss.gd')
})

test('inferred and extracted edges stay distinguishable', async () => {
  const st = await adapter.getStatus('pnmg')
  const c = st.summary!.confidence
  assert.ok(c.EXTRACTED > 0 && c.INFERRED > 0, JSON.stringify(c))
})

// ── adapter search: the Functions/Signals/Classes bug ───────────

test('kind tabs list their nodes with an empty query (used to return nothing)', async () => {
  for (const [kind, min] of [['func', 100], ['signal', 28], ['class', 6]] as const) {
    const r = (await adapter.search('pnmg', '', kind))!
    assert.ok(r.total >= min, `${kind}: ${r.total}`)
    assert.ok(r.nodes.length > 0 && r.nodes.every(n => n.kind === kind), `${kind} nodes of other kinds`)
  }
  const all = (await adapter.search('pnmg', '', 'all'))!
  assert.ok(all.nodes.every(n => n.kind === 'file'), '"all" browse stays files-only')
})

test('browse order is by file then line', async () => {
  const r = (await adapter.search('pnmg', '', 'signal', 200))!
  const bossSignals = r.nodes.filter(n => n.file === 'scripts/Boss.gd')
  assert.deepEqual(bossSignals.map(n => n.line), [...bossSignals.map(n => n.line)].sort((a, b) => a - b))
  assert.ok(bossSignals.some(n => n.label === 'defeated(signal)'))
})

test('text search filters inside each kind and finds known functions', async () => {
  const input = (await adapter.search('pnmg', '_input', 'func', 200))!
  assert.ok(input.nodes.some(n => n.label === '_input()' && n.file === 'scripts/Boss.gd' && n.line === 166))
  assert.equal(input.nodes[0].label, '_input()', 'exact match ranks first')

  const humus = (await adapter.search('pnmg', '_try_fertilize_with_humus', 'func'))!
  assert.equal(humus.nodes.length, 1)
  assert.equal(humus.nodes[0].file, 'scripts/Main.gd')
  assert.equal(humus.nodes[0].line, 2043)

  const sig = (await adapter.search('pnmg', 'defeated', 'signal'))!
  assert.ok(sig.nodes.length > 0 && sig.nodes.every(n => n.kind === 'signal'))
  const none = (await adapter.search('pnmg', 'defeated', 'class'))!
  assert.equal(none.total, 0)
})

test('counts describe the whole graph regardless of query', async () => {
  const r = (await adapter.search('pnmg', 'zzz-no-such-thing', 'signal'))!
  assert.equal(r.total, 0)
  assert.equal(r.counts.signal, 28)
  assert.ok(r.counts.func > 100)
})

test('node detail resolves a function with its container and relations', async () => {
  const hit = (await adapter.search('pnmg', '_try_fertilize_with_humus', 'func'))!.nodes[0]
  const d = (await adapter.getNode('pnmg', hit.id))!
  assert.equal(d.node.line, 2043)
  assert.equal(d.container?.label, 'Main.gd')
})

// ── HTTP route boundary ─────────────────────────────────────────

test('GET search?kind=func&q= returns functions plus counts', async () => {
  const res = await app.inject({ url: '/api/projects/pnmg/explorer/search?q=&kind=func' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(body.total > 100 && body.nodes[0].kind === 'func')
  assert.equal(body.counts.signal, 28)
})

test('GET search finds _input() through the API', async () => {
  const res = await app.inject({ url: '/api/projects/pnmg/explorer/search?q=_input&kind=func' })
  assert.ok(res.json().nodes.some((n: any) => n.label === '_input()' && n.line === 166))
})

test('search on a project without a graph says so (409), not "empty"', async () => {
  const res = await app.inject({ url: '/api/projects/nobody/explorer/search?q=&kind=func' })
  assert.equal(res.statusCode, 409)
})

test('status reports the project root; staleness needs a build marker', async () => {
  const res = await app.inject({ url: '/api/projects/pnmg/explorer' })
  const body = res.json()
  assert.equal(body.godot, true)
  assert.equal(body.built, true)
  assert.equal(body.root, projectRoot)
  assert.equal(body.staleness, undefined, 'no meta.json (built before the marker existed): unknown, not "fresh"')
})

test('staleness counts edited, new and removed sources after the build marker', async () => {
  const dir = join(dataDir, 'graphify/projects/pnmg')
  const startedAt = Date.now() - 60_000
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ startedAt, root: projectRoot }))
  // Boss.tscn exists in the graph; on disk: Boss.tscn edited now, a brand-new file, the rest missing.
  writeFileSync(join(projectRoot, 'Boss.tscn'), '[gd_scene format=3]\n')
  writeFileSync(join(projectRoot, 'Fresh.gd'), 'extends Node\n')
  const g = (await adapter.loadGraph('pnmg'))!
  const s = (await adapter.getStaleness('pnmg', projectRoot, g))!
  assert.equal(s.changed, 1)
  assert.equal(s.added, 1)
  assert.equal(s.removed, 18)
})

// ── client view logic (the frontend side of the boundary) ───────

test('client: empty-state kinds are distinct', async () => {
  const v = await import('../../client/src/lib/explorerView.ts')
  const counts = { file: 19, func: 860, signal: 0, class: 6, external: 21 }
  assert.equal(v.listState({ loading: false, resultCount: 0, query: '', filter: 'signal', counts }).kind, 'index-empty')
  assert.equal(v.listState({ loading: false, resultCount: 0, query: 'xyz', filter: 'func', counts }).kind, 'no-match')
  assert.equal(v.listState({ loading: false, error: 'boom', resultCount: 0, query: '', filter: 'func', counts }).kind, 'error')
  assert.equal(v.listState({ loading: true, resultCount: 0, query: '', filter: 'func' }).kind, 'loading')
  assert.equal(v.listState({ loading: false, resultCount: 3, query: '', filter: 'func', counts }).kind, 'ok')
  assert.match(v.listStateMessage(v.listState({ loading: false, resultCount: 0, query: '', filter: 'signal', counts }))!, /no signals/)
})

test('client: Ask-agent prompt carries project, checkout, file and line from the real API', async () => {
  const v = await import('../../client/src/lib/explorerView.ts')
  const hit = (await adapter.search('pnmg', '_try_fertilize_with_humus', 'func'))!.nodes[0]
  const detail = JSON.parse(JSON.stringify((await adapter.getNode('pnmg', hit.id))!))
  const prompt = v.buildAgentPrompt(detail, { projectId: 'pnmg', projectName: 'PNMG', root: 'C:/dev/GAMEDEV_V2/PNMG/repo' })
  assert.match(prompt, /`_try_fertilize_with_humus\(\)` in `scripts\/Main\.gd:2043`/)
  assert.match(prompt, /Project: PNMG \(id pnmg\)/)
  assert.match(prompt, /Checkout: C:\/dev\/GAMEDEV_V2\/PNMG\/repo/)
  assert.match(prompt, /Location: scripts\/Main\.gd:2043/)
  assert.match(prompt, /\(inferred\)|Depends on \(\d+\)/)
  assert.equal(v.extensionOf('scripts/Main.gd'), '.gd')
  assert.equal(v.extensionOf('Boss.tscn'), '.tscn')
})

test('client: staleness label', async () => {
  const v = await import('../../client/src/lib/explorerView.ts')
  assert.equal(v.stalenessLabel({ changed: 0, added: 0, removed: 0 }), null)
  assert.match(v.stalenessLabel({ changed: 2, added: 1, removed: 0 })!, /3 files changed .*2 edited, 1 new/)
})

// ── Godot highlighting (token-level) ─────────────────────────────

async function tokens(lang: 'gdscript' | 'godotResource', text: string) {
  const m = await import('../../client/src/lib/godotLanguage.ts')
  const tree = m[lang].parser.parse(text)
  const out: { name: string; text: string }[] = []
  tree.iterate({ enter(n: any) { if (n.name && n.from < n.to && n.node.firstChild == null) out.push({ name: n.name, text: text.slice(n.from, n.to) }) } })
  return out
}
// Adjacent tokens of one kind are merged into one node ("[" + "node" -> "[node"), so
// match by name and by the token text being contained in the node's text.
const has = (t: { name: string; text: string }[], name: string, text: string) =>
  assert.ok(t.some(x => x.name === name && x.text.includes(text)), `${name} "${text}" in ${JSON.stringify(t)}`)

test('GDScript: keywords, annotations, comments, strings, types, calls', async () => {
  const t = await tokens('gdscript', [
    'class_name Boss',
    'extends CharacterBody2D',
    'signal defeated(who: String)',
    '@export var hp: int = 10 # health',
    '@onready var sprite := $Sprite2D',
    'const MAX_HP = 0x1F',
    'func _ready() -> void:',
    '\tprint("hi %s" % name)',
    '\tdefeated.emit(self)',
  ].join('\n'))
  for (const k of ['class_name', 'extends', 'signal', 'var', 'const', 'func']) has(t, 'keyword', k)
  has(t, 'meta', '@export'); has(t, 'meta', '@onready')
  has(t, 'comment', '# health')
  has(t, 'string', '"hi %s"')
  has(t, 'typeName', 'CharacterBody2D'); has(t, 'typeName', 'int')
  has(t, 'variableName.definition', '_ready'); has(t, 'variableName.definition', 'defeated')
  has(t, 'number', '0x1F')
  has(t, 'atom', '$Sprite2D')
})

test('GDScript: triple-quoted strings span lines', async () => {
  const t = await tokens('gdscript', '"""doc\nmore"""\nvar x')
  assert.ok(t.filter(x => x.name === 'string').map(x => x.text).join('').includes('more'))
})

test('.tscn: sections, properties, ExtResource/SubResource, paths, uids, numbers, comments', async () => {
  const t = await tokens('godotResource', [
    '[gd_scene load_steps=3 format=3 uid="uid://abc123"]',
    '',
    '; a comment',
    '[ext_resource type="Script" path="res://scripts/Boss.gd" id="1_abc"]',
    '[sub_resource type="RectangleShape2D" id="Rect_1"]',
    'size = Vector2(32, 48.5)',
    '[node name="Boss" type="CharacterBody2D"]',
    'script = ExtResource("1_abc")',
    'shape = SubResource("Rect_1")',
    'visible = true',
  ].join('\n'))
  has(t, 'comment', '; a comment')
  has(t, 'keyword', 'ExtResource'); has(t, 'keyword', 'SubResource')
  has(t, 'link', '"res://scripts/Boss.gd"'); has(t, 'link', '"uid://abc123"')
  has(t, 'propertyName', 'size'); has(t, 'propertyName', 'script')
  has(t, 'attributeName', 'name'); has(t, 'attributeName', 'path')
  has(t, 'string', '"Boss"')
  has(t, 'number', '48.5')
  has(t, 'typeName', 'Vector2')
  has(t, 'atom', 'true')
  has(t, 'keyword', 'node'); has(t, 'keyword', 'gd_scene'); has(t, 'keyword', 'ext_resource'); has(t, 'keyword', 'sub_resource')
})

test('.tres: gd_resource header and resource properties', async () => {
  const t = await tokens('godotResource', '[gd_resource type="Resource" format=3]\n\n[resource]\nname = "humus"\nvalue = -3\n')
  has(t, 'keyword', 'gd_resource'); has(t, 'keyword', 'resource')
  has(t, 'propertyName', 'name'); has(t, 'string', '"humus"'); has(t, 'number', '-3')
})
