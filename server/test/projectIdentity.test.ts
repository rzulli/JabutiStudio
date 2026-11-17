import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'jabuti-project-id-'))
const data = join(root, 'data')
const dirs = ['a', 'b', 'c'].map(p => join(root, p, 'same'))
for (const d of [data, ...dirs]) mkdirSync(d, { recursive: true })
process.env.SHIPYARD_DATA_DIR = data
writeFileSync(join(data, 'projects.json'), JSON.stringify({ projects: [{ id: 'same', path: dirs[0], name: 'Existing' }] }))
const settings = await import('../src/services/settingsStore.js')
const discovery = await import('../src/services/projectDiscovery.js')
after(() => rmSync(root, { recursive: true, force: true }))

test('legacy IDs survive reorder, removal, re-addition and restart; names do not collide', async () => {
  await settings.saveSettings({ selectedProjects: dirs })
  const first = await discovery.refreshProjects()
  assert.equal(first[0].id, 'same')
  assert.equal(new Set(first.map(p => p.id)).size, 3)
  const ids = new Map(first.map(p => [p.path, p.id]))
  mkdirSync(join(data, 'tasks'))
  writeFileSync(join(data, 'tasks', `${first[0].id}.json`), 'legacy data')
  await settings.saveSettings({ selectedProjects: [dirs[2], dirs[1]] })
  const removed = await discovery.refreshProjects()
  assert.deepEqual(removed.map(p => p.id), [ids.get(dirs[2]), ids.get(dirs[1])])
  await settings.saveSettings({ selectedProjects: [dirs[1], dirs[0], dirs[2]] })
  const readded = await discovery.refreshProjects()
  assert.deepEqual(readded.map(p => p.id), [ids.get(dirs[1]), ids.get(dirs[0]), ids.get(dirs[2])])
  assert.equal(readFileSync(join(data, 'tasks', 'same.json'), 'utf8'), 'legacy data')
  const script = `await (await import('./src/services/settingsStore.ts')).loadSettings(); const p = await (await import('./src/services/projectDiscovery.ts')).refreshProjects(); console.log(JSON.stringify(p.map(x => [x.path, x.id])))`
  const restarted = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, SHIPYARD_DATA_DIR: data } }))
  assert.deepEqual(restarted, readded.map(p => [p.path, p.id]))
  const concurrent = await Promise.all([discovery.refreshProjects(), discovery.refreshProjects()])
  assert.deepEqual(concurrent[0].map(p => p.id), concurrent[1].map(p => p.id))
})

test('ambiguous legacy IDs fail without overwriting the original cache', () => {
  const other = join(root, 'ambiguous'); mkdirSync(other)
  const original = JSON.stringify({ projects: dirs.slice(0, 2).map(path => ({ id: 'same', path })) })
  writeFileSync(join(other, 'projects.json'), original)
  const script = `try { await (await import('./src/services/projectDiscovery.ts')).refreshProjects(); process.exitCode=1 } catch (e) { if (!String(e).includes('Ambiguous project identity')) throw e }`
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, SHIPYARD_DATA_DIR: other } })
  assert.equal(readFileSync(join(other, 'projects.json'), 'utf8'), original)
})

test('workspace import remaps identity paths and retains IDs and task data', () => {
  const bundle = join(root, 'bundle'), bundleData = join(bundle, 'data')
  const destination = join(root, 'imported-projects'), importedData = join(root, 'imported-data')
  mkdirSync(join(bundleData, 'tasks'), { recursive: true })
  const old = 'C:\\Projects\\Same'
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({ createdAt: 'test', sourcePlatform: 'win32', projects: [{ id: 'same', name: 'Same', abs: old, rel: 'Same', repos: [] }] }))
  writeFileSync(join(bundleData, 'settings.json'), JSON.stringify({ selectedProjects: ['c:/projects/same'] }))
  writeFileSync(join(bundleData, 'projects.json'), JSON.stringify({ projects: [{ id: 'same', path: 'c:/projects/same' }] }))
  writeFileSync(join(bundleData, 'project-identities.json'), JSON.stringify({ version: 1, identities: [{ id: 'same', path: 'c:/projects/same' }] }))
  writeFileSync(join(bundleData, 'tasks', 'same.json'), 'legacy data')
  execFileSync(process.execPath, ['../scripts/workspace-import.mjs', bundle, '--root', destination, '--data-dir', importedData], { stdio: 'pipe' })
  const expected = join(destination, 'Same')
  const registry = JSON.parse(readFileSync(join(importedData, 'project-identities.json'), 'utf8'))
  assert.deepEqual(registry.identities, [{ id: 'same', path: expected }])
  assert.equal(readFileSync(join(importedData, 'tasks', 'same.json'), 'utf8'), 'legacy data')
  const script = `await (await import('./src/services/settingsStore.ts')).loadSettings(); const p = await (await import('./src/services/projectDiscovery.ts')).refreshProjects(); console.log(JSON.stringify(p.map(x => [x.path, x.id])))`
  const projects = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, SHIPYARD_DATA_DIR: importedData } }))
  assert.deepEqual(projects, [[expected, 'same']])
})

test('cloud project claims its remote ID but never reassigns a path already owned by another ID', async () => {
  const folder = join(root, 'a', 'cloud-game'); mkdirSync(folder)
  const cloud = await import('../src/services/cloud/cloudRecords.js')
  const remote = { folder: 'cloud-game', name: 'Cloud game' }
  const added = await cloud.applyRemote([{ key: 'project/cloud-id', deleted: false, data: remote }])
  assert.deepEqual(added.found, ['cloud-id'])
  assert.ok((await discovery.getProjects()).some(p => p.path === folder && p.id === 'cloud-id'))
  const conflict = await cloud.applyRemote([{ key: 'project/other-id', deleted: false, data: remote }])
  assert.ok(conflict.missing['other-id'])
  assert.equal((await discovery.getProjects()).find(p => p.path === folder)?.id, 'cloud-id')
  mkdirSync(join(root, 'a', 'duplicate')); mkdirSync(join(root, 'b', 'duplicate'))
  const ambiguous = await cloud.applyRemote([{ key: 'project/duplicate-id', deleted: false, data: { folder: 'duplicate', name: 'Duplicate' } }])
  assert.ok(ambiguous.missing['duplicate-id'])
  assert.ok(!(await discovery.getProjects()).some(p => p.id === 'duplicate-id'))
})
