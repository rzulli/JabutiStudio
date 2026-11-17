import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

test('real Graphify reanalysis updates symbols and preserves system identity and evidence', { skip: !process.env.SHIPYARD_GRAPHIFY_PYTHON, timeout: 180_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'jabuti-real-graph-'))
  const root = join(parent, 'game'), data = join(parent, 'data')
  mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(data)
  process.env.SHIPYARD_DATA_DIR = data
  const put = (file: string, content: string) => writeFileSync(join(root, file), content)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', ...args], { stdio: 'pipe' })
  try {
    put('project.godot', 'config_version=5\n')
    const source = 'extends Node\nclass_name GrainStore\nfunc add_grain():\n\tpass\nfunc remove_grain():\n\tpass\n'
    put('scripts/GrainStore.gd', source)
    put('scripts/GrainMill.gd', 'extends Node\nconst Store = preload("res://scripts/GrainStore.gd")\nfunc grind_grain():\n\tpass\n')
    mkdirSync(join(root, 'docs/design_knowledge/records'), { recursive: true })
    mkdirSync(join(root, 'tools/design_knowledge'), { recursive: true })
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/dk/dk.py'), join(root, 'tools/design_knowledge/dk.py'))
    const record = (claim: string) => {
      const r = { id: 'DK-GRAIN-001', title: 'Grain storage', claim, decision_state: 'unknown', approval_state: 'unknown', implementation_state: 'implemented', implementation_sources: [], scope: ['grain'], evidence: [{ type: 'code', ref: 'scripts/GrainStore.gd#L1-L1', sha256: createHash('sha256').update(source).digest('hex') }], supersedes: [], conflicts_with: [], files: [{ role: 'storage', path: 'scripts/GrainStore.gd' }], tests: [], qps: [], tags: [] }
      put('docs/design_knowledge/records/grain.md', `<!-- dk-record\n${JSON.stringify(r)}\n-->\n# record\n`)
    }
    record('Grain storage before analysis')
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'initial')
    const graph = await import('../src/services/graphifyAdapter.js')
    const svc = await import('../src/services/systemCatalog.js')
    const project: any = { id: 'fixture', path: root, name: 'Fixture' }
    await graph.buildGraph(project.id, root)
    let g = (await graph.loadGraph(project.id))!
    assert.ok([...g.nodes.values()].some(n => n.file === 'scripts/GrainStore.gd' && n.label === 'remove_grain()'))
    const imports = (graph: typeof g) => [...graph.out.values()].flat().filter(e => e.relation === 'imports_from').map(e => [graph.nodes.get(e.from)?.file, graph.nodes.get(e.to)?.file])
    assert.ok(imports(g).some(([from, to]) => from === 'scripts/GrainMill.gd' && to === 'scripts/GrainStore.gd'), JSON.stringify(imports(g)))
    await svc.propose(project.id, { name: 'Grain', terms: ['grain'], areas: [{ id: 'store', name: 'Storage', files: ['scripts/GrainStore.gd'], evidence: [{ path: 'scripts/GrainStore.gd', needle: 'func remove_grain():' }] }], relations: [{ kind: 'stores', from: 'area:store', to: 'ent:grain', evidence: [{ path: 'scripts/GrainStore.gd', needle: 'func remove_grain():' }] }] }, 'agent')
    await svc.review(project.id, 'sys-grain', { status: 'confirmed', confirm: { areas: ['store'] } })
    const before: any = await svc.resolveSystem(project, 'sys-grain')
    assert.equal(before.relations[0].basis, 'demonstrated')
    assert.ok(before.design.decisions.some((d: any) => d.claim === 'Grain storage before analysis'))
    git('mv', 'scripts/GrainStore.gd', 'scripts/GrainReserve.gd')
    put('scripts/GrainReserve.gd', 'extends Node\nclass_name GrainStore\nfunc add_grain():\n\tpass\nfunc harvest_grain():\n\tpass\n')
    put('scripts/GrainMill.gd', 'extends Node\nconst Store = preload("res://scripts/GrainReserve.gd")\nfunc grind_grain():\n\tpass\n')
    record('Grain storage revised after analysis')
    await graph.buildGraph(project.id, root)
    await new Promise(resolve => setTimeout(resolve, 5100)) // DK has its own five-second cache.
    svc.resetCaches()
    g = (await graph.loadGraph(project.id))!
    assert.ok([...g.nodes.values()].some(n => n.file === 'scripts/GrainReserve.gd' && n.label === 'harvest_grain()'))
    assert.ok(![...g.nodes.values()].some(n => n.label === 'remove_grain()'))
    assert.ok(imports(g).some(([from, to]) => from === 'scripts/GrainMill.gd' && to === 'scripts/GrainReserve.gd'), JSON.stringify(imports(g)))
    assert.ok(!imports(g).some(([, to]) => to === 'scripts/GrainStore.gd'))
    const after: any = await svc.resolveSystem(project, 'sys-grain')
    assert.equal(after.id, before.id)
    assert.equal(after.status, 'confirmed')
    assert.equal(after.areas.find((a: any) => a.id === 'store').status, 'confirmed')
    assert.ok(after.design.decisions.some((d: any) => d.claim === 'Grain storage revised after analysis'))
    assert.notEqual(after.relations[0].basis, 'demonstrated')
    assert.notEqual(after.relations[0].evidence[0].state, 'verified')
    await svc.propose(project.id, { name: 'Grain', relations: [{ kind: 'controls', from: 'area:store', to: 'ent:grain', evidence: [{ path: 'scripts/GrainReserve.gd', needle: 'func harvest_grain():' }] }] }, 'agent')
    const final: any = await svc.resolveSystem(project, 'sys-grain')
    assert.equal(final.relations.length, 1, 'an agent cannot silently add a relation to a confirmed system')
    assert.ok(final.suggestions.length > 0)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})
