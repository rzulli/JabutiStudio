/**
 * Builds a throwaway project + data dir for looking at the relation editor in a real browser:
 *   SHIPYARD_DATA_DIR=<dir> tsx scripts/seed-relation-fixture.ts <dir>
 * Then start the server with the same SHIPYARD_DATA_DIR. Touches nothing outside <dir>.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const dir = process.argv[2]
if (!dir || process.env.SHIPYARD_DATA_DIR !== dir + '/data') { console.error('usage: SHIPYARD_DATA_DIR=<dir>/data tsx seed-relation-fixture.ts <dir>'); process.exit(1) }
const repo = join(dir, 'repo'); mkdirSync(repo, { recursive: true }); mkdirSync(process.env.SHIPYARD_DATA_DIR, { recursive: true })
writeFileSync(join(repo, 'project.godot'), 'config_version=5\n')
const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' })
git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'base')
writeFileSync(join(process.env.SHIPYARD_DATA_DIR, 'projects.json'), JSON.stringify({ projects: [{ id: 'rel', path: repo }] }))
const { addProjects } = await import('../src/services/projectDiscovery.js')
await addProjects([repo])
const svc = await import('../src/services/systemCatalog.js')
const mom = await svc.propose('rel', { name: 'Momentum', kind: 'system', summary: 'How speed is conserved on stairs.', createOnly: true }, 'user')
const pdi = await svc.propose('rel', { name: 'PDI', kind: 'system', summary: 'Perks.', createOnly: true, areas: [{ name: 'Perk Progression', kind: 'mechanic' }] }, 'user')
await svc.review('rel', pdi.id, { upsertRelation: { kind: 'modifies', from: 'area:perk-progression', to: 'sys:' + mom.id, note: 'Design intent: perks change how speed is conserved on stairs.' } })
console.log('seeded', dir, mom.id, pdi.id)
process.exit(0)
