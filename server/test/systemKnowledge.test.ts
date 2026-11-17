import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('R1-A2: per-checkout reconciliation and guarded update (no DK, no Graphify)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'systems-knowledge-'));
  const data = join(base, 'data'), source = join(base, 'source'), wt = join(base, 'wt-old');
  process.env.SHIPYARD_DATA_DIR = data;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe', encoding: 'utf8' });
  try {
    mkdirSync(source); mkdirSync(data);
    writeFileSync(join(source, 'game.gd'), 'extends Node\nvar reserve = 1\n');
    git(source, 'init', '-q'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'c1');
    const c1 = git(source, 'rev-parse', 'HEAD').trim();
    const svc = await import('../src/services/systemCatalog.js');
    const know = await import('../src/services/systemKnowledge.js');
    const project = { id: 'source', path: source };
    const created = await svc.propose(project.id, { name: 'Reserve', terms: ['reserve'], files: ['game.gd'],
      areas: [{ id: 'storage', name: 'Storage', files: ['game.gd'], evidence: [{ path: 'game.gd', needle: 'reserve' }] }],
      relations: [{ id: 'stores', kind: 'stores', from: 'area:storage', to: 'ent:Matter', evidence: [{ path: 'game.gd', needle: 'reserve' }] }],
    }, 'agent');
    await svc.review(project.id, created.id, { status: 'confirmed', confirm: { areas: ['storage'] } });
    await svc.exportPortable(project);
    git(source, 'add', '.'); git(source, 'commit', '-qm', 'publish knowledge');
    git(source, 'worktree', 'add', '-q', '--detach', wt, c1);
    const file = join(source, 'jabutistudio.systems.json');
    const sysOf = (r: any) => r.systems.find((s: any) => s.id === created.id);

    // T1/T3: the older checkout does not see the later publication; identity is stable; no writes happened
    const before = readFileSync(file, 'utf8');
    const old: any = await know.reconcile(project, { worktree: wt });
    assert.equal(old.file.state, 'absent');
    assert.equal(sysOf(old).state, 'unavailable');
    assert.equal(sysOf(old).published, null);
    assert.equal(old.checkout.isCanonical, false);
    assert.equal(old.revision.commit, c1);
    const head: any = await know.reconcile(project);
    assert.equal(head.file.state, 'present');
    assert.equal(sysOf(head).state, 'published');
    assert.equal(sysOf(head).id, sysOf(old).id);
    assert.equal(sysOf(head).relations?.length ?? sysOf(head).published.relations.length, 1);
    const atOld: any = await know.reconcile(project, { revision: c1 });
    assert.equal(atOld.file.state, 'absent');
    assert.equal(sysOf(atOld).state, 'unavailable');
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.ok(head.limitations.length > 0 && !JSON.stringify(head).includes('graphify-cache'));
    assert.equal(await know.reconcile(project, { revision: 'nope-branch' }).then((r: any) => !!r.error), true);

    // T2: local classification diverges; both values stay identifiable
    await sleep(5);
    await svc.review(project.id, created.id, { summary: 'Local summary' });
    const local: any = await know.reconcile(project);
    assert.equal(sysOf(local).state, 'local-change');
    assert.notEqual(sysOf(local).published.summary, 'Local summary');
    assert.equal(sysOf(local).local.summary, 'Local summary');
    assert.deepEqual(sysOf(local).changes.map((c: any) => c.field), ['summary']);
    assert.equal(readFileSync(file, 'utf8'), before);

    // T4/T6: external edit of the file + local change => diverged; stale/unchosen updates write nothing
    const external = JSON.parse(before);
    external.systems[0].summary = 'External summary';
    external.systems[0].updatedAt = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(file, JSON.stringify(external, null, 2));
    const div: any = await know.reconcile(project);
    assert.equal(div.file.state, 'modified');
    assert.equal(sysOf(div).state, 'diverged');
    assert.equal(sysOf(div).workingFile.summary, 'External summary');
    assert.equal(sysOf(div).published.summary !== 'External summary', true);
    assert.equal(sysOf(div).local.summary, 'Local summary');
    const externalText = readFileSync(file, 'utf8');
    await assert.rejects(() => know.updatePortable(project, { expectedSha256: 'a'.repeat(64) }), /changed since/);
    await assert.rejects(() => know.updatePortable(project, { expectedSha256: div.file.expectedSha256 }), /explicit choice/);
    assert.equal(readFileSync(file, 'utf8'), externalText);

    // T5/T7: restore the file, then update with the hash the caller saw; proposals stay proposals
    git(source, 'checkout', '--', 'jabutistudio.systems.json');
    await svc.propose(project.id, { name: 'Pending', summary: 'Needs review', terms: ['pending'] }, 'agent');
    const ready: any = await know.reconcile(project);
    assert.equal(ready.systems.find((s: any) => s.name === 'Pending').state, 'unpublished-proposal');
    // a concurrent external write lands before our write: rejected, external content intact
    const raced = JSON.parse(readFileSync(file, 'utf8')); raced.systems[0].responsibilities = ['external'];
    writeFileSync(file, JSON.stringify(raced, null, 2));
    const racedText = readFileSync(file, 'utf8');
    await assert.rejects(() => know.updatePortable(project, { expectedSha256: ready.file.expectedSha256 }), /changed since/);
    assert.equal(readFileSync(file, 'utf8'), racedText);
    git(source, 'checkout', '--', 'jabutistudio.systems.json');
    const res = await know.updatePortable(project, { expectedSha256: ready.file.expectedSha256 });
    assert.ok(res.updated.includes(created.id));
    const after = JSON.parse(readFileSync(file, 'utf8'));
    const pub = after.systems.find((s: any) => s.id === created.id);
    assert.equal(pub.summary, 'Local summary');
    assert.equal(pub.status, 'confirmed');
    assert.equal(pub.relations[0].status, 'proposed');
    assert.equal(after.systems.find((s: any) => s.name === 'Pending').status, 'proposed');
    assert.ok(!existsSync(`${file}.tmp`));
    assert.ok(!readFileSync(file, 'utf8').includes(base));
    const post: any = await know.reconcile(project);
    assert.equal(post.file.state, 'modified');            // uncommitted until the user commits it
    assert.equal(sysOf(post).state, 'local-change');       // file edit equal to local value, over the revision
    assert.equal(sysOf(post).workingFile.summary, 'Local summary');

    // T8: evidence that no longer holds in this checkout is flagged
    assert.equal(sysOf(post).evidenceStale, false);
    writeFileSync(join(source, 'game.gd'), 'extends Node\nvar other = 1\n');
    const stale: any = await know.reconcile(project);
    assert.equal(sysOf(stale).evidenceStale, true);
    assert.ok(sysOf(stale).evidence.some((e: any) => e.state === 'stale'));
    rmSync(join(source, 'game.gd'));
    assert.ok(sysOf(await know.reconcile(project) as any).evidence.some((e: any) => e.state === 'missing'));
    // the same evidence, read at the old revision, still holds
    assert.equal(sysOf(await know.reconcile(project, { revision: c1 }) as any).evidenceStale, false);

    // update refuses a missing file and invalid input
    await assert.rejects(() => know.updatePortable(project, { expectedSha256: 'x' }), /required/);
  } finally {
    try { execFileSync('git', ['-C', source, 'worktree', 'remove', '--force', wt], { stdio: 'pipe' }); } catch { /* ignore */ }
    rmSync(base, { recursive: true, force: true });
  }
});
