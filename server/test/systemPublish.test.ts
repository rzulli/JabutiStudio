import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('R1-A3: publish + recover knowledge across checkouts and installations (no DK, no Graphify)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'systems-publish-'));
  const dataA = join(base, 'dataA'), dataB = join(base, 'dataB'), source = join(base, 'game'), clone = join(base, 'game-clone'), wt = join(base, 'wt');
  mkdirSync(dataA); mkdirSync(dataB); mkdirSync(source);
  process.env.SHIPYARD_DATA_DIR = dataA;
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], { stdio: 'pipe', encoding: 'utf8' });
  try {
    writeFileSync(join(source, 'reserve.gd'), 'extends Node\nvar reserve = 1\n');
    git(source, 'init', '-q'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'c1');
    const c1 = git(source, 'rev-parse', 'HEAD').trim();
    const svc = await import('../src/services/systemCatalog.js');
    const know = await import('../src/services/systemKnowledge.js');
    const project = { id: 'game', path: source };
    const file = join(source, 'jabutistudio.systems.json');
    let proposedId = '';

    // T9/T1: no DK anywhere. Opening / previewing never creates the file; export needs an explicit call.
    assert.equal((await know.previewExport(project)).canExport, false);   // nothing to publish yet
    const proposed = await svc.propose(project.id, { name: 'Reserve', summary: 'Holds matter', terms: ['reserve'], files: ['reserve.gd'],
      areas: [{ id: 'storage', name: 'Storage', files: ['reserve.gd'], evidence: [{ path: 'reserve.gd', needle: 'reserve' }] }] }, 'agent');
    proposedId = proposed.id;
    const exp = await know.previewExport(project);
    assert.equal(exp.canExport, true);
    assert.equal(exp.target, 'jabutistudio.systems.json');
    assert.deepEqual(exp.systems.map(s => [s.name, s.status, s.proposedItems]), [['Reserve', 'proposed', 1]]);
    assert.ok(!existsSync(file), 'previews must not write');
    assert.equal((await know.previewUpdate(project)).exists, false);
    assert.equal((await know.previewImport(project)).exists, false);
    await svc.exportPortable(project);
    assert.ok(existsSync(file));
    assert.equal((await know.previewExport(project)).canExport, false);   // already exists: no second initial export
    const sys = JSON.parse(readFileSync(file, 'utf8')).systems[0];
    assert.equal(sys.status, 'proposed');                                  // a proposal is not promoted by publishing
    assert.ok(!readFileSync(file, 'utf8').includes(base) && !readFileSync(file, 'utf8').includes('attest'));
    git(source, 'add', '.'); git(source, 'commit', '-qm', 'publish');

    // T8: published in HEAD / dirty in working tree / local only are three different things
    let r: any = await know.reconcile(project);
    assert.equal(r.systems[0].state, 'published');
    await sleep(5);
    await svc.review(project.id, proposed.id, { summary: 'Holds all matter' });
    r = await know.reconcile(project);
    assert.equal(r.systems[0].state, 'local-change');
    assert.equal(r.file.state, 'present');                                 // file itself is untouched

    // T2: update plan shows the field changes and the hash of what it saw
    let upd: any = await know.previewUpdate(project);
    assert.equal(upd.rows[0].action, 'update');
    assert.deepEqual(upd.rows[0].changes.map((c: any) => c.field), ['summary']);
    assert.equal(upd.sha256, r.file.expectedSha256);

    // T3: file changes after the preview -> the write is refused and nothing is replaced
    const ext = JSON.parse(readFileSync(file, 'utf8')); ext.systems[0].responsibilities = ['someone else'];
    writeFileSync(file, JSON.stringify(ext, null, 2));
    const extText = readFileSync(file, 'utf8');
    await assert.rejects(() => know.updatePortable(project, { expectedSha256: upd.sha256 }), /changed since/);
    assert.equal(readFileSync(file, 'utf8'), extText);

    // T4: the file value is newer: the plan says "needs-choice"; only an explicit takeLocal replaces it
    ext.systems[0].updatedAt = new Date(Date.now() + 60_000).toISOString(); ext.systems[0].summary = 'Elsewhere';
    writeFileSync(file, JSON.stringify(ext, null, 2));
    upd = await know.previewUpdate(project);
    assert.equal(upd.rows[0].action, 'needs-choice');
    assert.ok(upd.rows[0].changes.some((c: any) => c.field === 'summary' && c.published === 'Elsewhere' && c.local === 'Holds all matter'));
    await assert.rejects(() => know.updatePortable(project, { expectedSha256: upd.sha256 }), /explicit choice/);
    const done = await know.updatePortable(project, { expectedSha256: upd.sha256, takeLocal: [proposed.id] });
    assert.deepEqual(done.updated, [proposed.id]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).systems[0].summary, 'Holds all matter');
    r = await know.reconcile(project);
    assert.equal(r.file.state, 'modified');                                // written but NOT committed
    assert.equal(r.checkout.dirty, true);
    assert.equal(git(source, 'log', '--oneline').trim().split('\n').length, 2);   // no commit was made for us
    git(source, 'add', '.'); git(source, 'commit', '-qm', 'update knowledge');

    // T8: a worktree on the old revision does not show the later publication as published; integration is evidence-based
    git(source, 'worktree', 'add', '-q', '--detach', wt, c1);
    const old: any = await know.reconcile(project, { worktree: wt });
    assert.equal(old.file.state, 'absent');
    assert.equal(old.systems[0].state, 'unpublished-proposal');   // still only a local proposal there
    assert.equal(old.systems[0].published, null);
    assert.equal(old.file.integration, 'differs');                         // main has a file this worktree lacks... (absent here, present there)

    // T7/T5/T6: a clone, in ANOTHER installation (own data dir, own process), recovers the knowledge
    execFileSync('git', ['clone', '-q', source, clone], { stdio: 'pipe' });
    const script = `
      const { pathToFileURL } = await import('node:url');
      const svc = await import(pathToFileURL(process.env.SVC).href);
      const know = await import(pathToFileURL(process.env.KNOW).href);
      const project = { id: 'game-clone', path: process.env.CLONE };
      const out = {};
      out.before = (await svc.listStored(project.id, true)).length;
      out.rec = await know.reconcile(project);
      out.preview = await know.previewImport(project);
      await svc.exportPortable(project).catch(e => { out.exportRefused = String(e.message); });
      await svc.importPortable(project, { expectedSha256: 'a'.repeat(64) }).catch(e => { out.staleRefused = String(e.message); });
      out.imported = await svc.importPortable(project, { expectedSha256: out.preview.sha256 });
      out.stored = await svc.listStored(project.id, true);
      out.again = await know.previewImport(project);
      out.reimport = await svc.importPortable(project, { expectedSha256: out.again.sha256 });
      // a local reclassification, then the same file: same id, different content -> refused, nothing chosen for us
      await svc.review(project.id, out.stored[0].id, { summary: 'Clone-side wording' });
      out.conflict = await know.previewImport(project);
      out.conflictImport = await svc.importPortable(project, { expectedSha256: out.conflict.sha256 });
      out.afterConflict = (await svc.listStored(project.id, true))[0].summary;
      // same name, different id in another local catalog -> possible duplicate
      const dup = { id: 'game-dup', path: process.env.CLONE };
      await svc.propose(dup.id, { name: 'Reserve Core', terms: ['reserve'] }, 'user');
      out.dup = await know.previewImport(dup);
      out.dupImport = await svc.importPortable(dup);
      console.log('@@' + JSON.stringify(out));
    `;
    const raw = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, SHIPYARD_DATA_DIR: dataB, CLONE: clone, SVC: join(import.meta.dirname, '../src/services/systemCatalog.ts'), KNOW: join(import.meta.dirname, '../src/services/systemKnowledge.ts') },
    });
    const o = JSON.parse(raw.slice(raw.lastIndexOf('@@') + 2));
    assert.equal(o.before, 0);                                              // a fresh installation: nothing local
    assert.equal(o.rec.systems[0].state, 'published');                      // visible as published knowledge before importing
    assert.equal(o.preview.safe, true);
    assert.deepEqual(o.preview.items.map((i: any) => i.kind), ['new']);
    assert.match(o.exportRefused, /already exists/);                        // export never overwrites
    assert.match(o.staleRefused, /changed since the preview/);
    assert.deepEqual(o.imported, { added: 1, conflicts: [] });
    assert.equal(o.stored[0].id, proposedId);                               // same identity
    assert.equal(o.stored[0].status, 'proposed');                           // not promoted
    assert.equal(o.stored[0].areas?.[0]?.status, 'proposed');
    assert.deepEqual(o.again.items.map((i: any) => i.kind), ['identical']);
    assert.deepEqual(o.reimport, { added: 0, conflicts: [] });
    assert.deepEqual(o.conflict.items.map((i: any) => i.kind), ['changed']);
    assert.deepEqual(o.conflict.items[0].changes.map((c: any) => c.field), ['summary']);
    assert.equal(o.conflict.safe, false);
    assert.deepEqual(o.conflictImport, { added: 0, conflicts: [proposedId] });
    assert.equal(o.afterConflict, 'Clone-side wording');                    // the local classification was not overwritten
    assert.deepEqual(o.dup.items.map((i: any) => i.kind), ['duplicate']);
    assert.deepEqual(o.dupImport, { added: 0, conflicts: [proposedId] });
    assert.ok(!existsSync(join(clone, 'graphify')) && !existsSync(join(clone, 'data')));
  } finally {
    try { execFileSync('git', ['-C', source, 'worktree', 'remove', '--force', wt], { stdio: 'pipe' }); } catch { /* ignore */ }
    rmSync(base, { recursive: true, force: true });
  }
});

test('R1-A3: preview refuses unusable files and exports require complete history', async () => {
  const base = mkdtempSync(join(tmpdir(), 'systems-publish-bad-'));
  const data = join(base, 'data'), repo = join(base, 'repo');
  mkdirSync(data); mkdirSync(repo);
  process.env.SHIPYARD_DATA_DIR = data;
  try {
    execFileSync('git', ['-C', repo, 'init', '-q']);
    writeFileSync(join(repo, 'jabutistudio.systems.json'), '{ not json');
    const know = await import('../src/services/systemKnowledge.js');
    const project = { id: 'bad', path: repo };
    const imp: any = await know.previewImport(project);
    assert.equal(imp.exists, true);
    assert.ok(imp.error);                                                   // invalid file: reported, never guessed at
    assert.ok(((await know.previewExport(project)) as any).canExport === false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
