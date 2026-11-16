// Regenerates test/fixtures/pnmg-slice.graph.json from a REAL Graphify graph.json
// (the PNMG analysis in data/graphify). Keeps the files below and every edge
// between kept nodes, untouched, so the tests run on what Graphify really emits.
//   node server/test/make-fixture.mjs [path/to/graph.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = process.argv[2] ?? join(here, '../../data/graphify/projects/repo/tree/graphify-out/graph.json')
const raw = JSON.parse(readFileSync(src, 'utf8'))

const funcOwners = new Set(
  raw.nodes.filter(n => ['_input()', '_try_fertilize_with_humus()'].includes(n.label)).map(n => n.source_file),
)
const keepFiles = new Set(['scripts/Boss.gd', 'Boss.tscn', 'scripts/BossRules.gd', ...funcOwners])
const keep = new Set(raw.nodes.filter(n => keepFiles.has(n.source_file) || !n.source_file).map(n => n.id))
const out = {
  ...raw,
  nodes: raw.nodes.filter(n => keep.has(n.id)),
  links: raw.links.filter(e => keep.has(e.source) && keep.has(e.target)),
  hyperedges: [],
}
mkdirSync(join(here, 'fixtures'), { recursive: true })
writeFileSync(join(here, 'fixtures/pnmg-slice.graph.json'), JSON.stringify(out))
console.log(`${out.nodes.length} nodes, ${out.links.length} links from ${[...keepFiles].join(', ')}`)
