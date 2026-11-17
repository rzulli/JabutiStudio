import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('portable catalog round trip, clone, conflicts and invalid inputs', async () => {
  const base = mkdtempSync(join(tmpdir(), 'systems-portable-'));
  const data = join(base, 'data'), source = join(base, 'source'), clone = join(base, 'clone');
  process.env.SHIPYARD_DATA_DIR = data;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' });
  try {
    mkdirSync(source); mkdirSync(data);
    writeFileSync(join(source, 'game.gd'), 'extends Node\nvar reserve = 1\n');
    git(source, 'init', '-q'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'initial');
    const svc = await import('../src/services/systemCatalog.js');
    const a = { id: 'source', path: source }, b = { id: 'clone', path: clone };
    const created = await svc.propose(a.id, { name: 'Reserve', terms: ['reserve'], files: ['game.gd'],
      areas: [{ id: 'storage', name: 'Storage', files: ['game.gd'], evidence: [{ path: 'game.gd', needle: 'reserve' }] }],
      relations: [{ id: 'stores', kind: 'stores', from: 'area:storage', to: 'ent:Matter', evidence: [{ path: 'game.gd', needle: 'reserve' }] }],
    }, 'agent');
    await svc.review(a.id, created.id, { status: 'confirmed', confirm: { areas: ['storage'] } });
    await svc.propose(a.id, { name: 'Reserve', summary: 'Pending suggestion', areas: [{ name: 'Candidate' }] }, 'agent');
    const localFile = join(data, 'systems', 'source.json');
    const local = JSON.parse(readFileSync(localFile, 'utf8'));
    local.systems[0].seen = { at: 'now', keys: ['graphify-cache'] };
    local.systems[0].vanished = [{ key: 'local-attestation', since: 'now' }];
    writeFileSync(localFile, JSON.stringify(local));
    svc.resetCaches();
    const original = JSON.parse(JSON.stringify(await svc.getStored(a.id, created.id)));
    delete original.seen; delete original.vanished;
    await svc.exportPortable(a);
    const file = join(source, 'jabutistudio.systems.json');
    const serialized = readFileSync(file, 'utf8');
    assert.ok(!serialized.includes(base));
    for (const excluded of ['"seen"', '"vanished"', 'graphify', '.tmp']) assert.ok(!serialized.includes(excluded));
    await assert.rejects(() => svc.exportPortable(a), /already exists/);
    git(source, 'add', '.'); git(source, 'commit', '-qm', 'portable');
    execFileSync('git', ['clone', '-q', source, clone], { stdio: 'pipe' });
    assert.deepEqual(await svc.importPortable(b), { added: 1, conflicts: [] });
    assert.deepEqual(await svc.getStored(b.id, created.id), original);
    assert.equal((await svc.getStored(b.id, created.id))!.relations![0].status, 'proposed');
    assert.equal((await svc.getStored(b.id, created.id))!.areas![0].status, 'confirmed');
    assert.deepEqual(await svc.importPortable(b), { added: 0, conflicts: [] });
    await svc.propose('collision', { name: 'Other', terms: ['reserve'] }, 'user');
    assert.deepEqual(await svc.importPortable({ id: 'collision', path: clone }), { added: 0, conflicts: [created.id] });
    assert.equal((await svc.listStored('collision')).length, 1);
    await svc.review(b.id, created.id, { summary: 'Local edit' });
    assert.deepEqual(await svc.importPortable(b), { added: 0, conflicts: [created.id] });
    assert.equal((await svc.getStored(b.id, created.id))!.summary, 'Local edit');
    const cloneFile = join(clone, 'jabutistudio.systems.json');
    const corrupt = JSON.parse(serialized);
    corrupt.systems[0].anchors.files = ['../outside.gd'];
    writeFileSync(cloneFile, JSON.stringify(corrupt));
    await assert.rejects(() => svc.importPortable(b));
    corrupt.systems[0].anchors.files = ['C:\\outside.gd'];
    writeFileSync(cloneFile, JSON.stringify(corrupt));
    await assert.rejects(() => svc.importPortable(b));
    corrupt.version = 99;
    writeFileSync(cloneFile, JSON.stringify(corrupt));
    await assert.rejects(() => svc.importPortable(b));
    const incompatible = JSON.parse(serialized);
    incompatible.gitRoots = ['a'.repeat(40)];
    writeFileSync(cloneFile, JSON.stringify(incompatible));
    await assert.rejects(() => svc.importPortable(b), /different Git history/);
    writeFileSync(cloneFile, '{broken');
    await assert.rejects(() => svc.importPortable(b));
    writeFileSync(cloneFile, serialized);
    writeFileSync(join(data, 'systems', 'broken.json'), '{broken');
    await assert.rejects(() => svc.importPortable({ id: 'broken', path: clone }));
    assert.equal(readFileSync(join(data, 'systems', 'broken.json'), 'utf8'), '{broken');
    assert.ok(!existsSync(join(clone, 'jabutistudio.systems.json.tmp')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
