#!/usr/bin/env node
/**
 * Legacy Design Knowledge -> jabutistudio.decisions.json, from the command line (R1-B2).
 *
 *   node scripts/design-migrate.mjs <project-path> [--data-dir <dir>]                 preview (writes nothing)
 *   node scripts/design-migrate.mjs <project-path> --apply <planSha256> [--data-dir]   write, after reviewing a preview
 *   node scripts/design-migrate.mjs <project-path> --rollback <manifestId> [--data-dir]
 *   add --keep-native <id> / --take-legacy <id> (repeatable) to resolve a divergent record explicitly
 *
 * The legacy records and dk.py are only ever read. Backups and manifests go to <data-dir>/design-migration/.
 * Never run it against a project you have not reviewed the preview of; always give --data-dir for a rehearsal.
 */
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const take = (flag) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === flag) out.push(args[i + 1]); return out; };
const project = args.find(a => !a.startsWith('--') && !take('--apply').includes(a) && !take('--rollback').includes(a) && !take('--data-dir').includes(a)
  && !take('--keep-native').includes(a) && !take('--take-legacy').includes(a));
if (!project) { console.error('usage: design-migrate.mjs <project-path> [--apply <planSha256> | --rollback <manifestId>] [--data-dir <dir>]'); process.exit(2); }

// Re-exec through tsx so the TypeScript services load; the child does the work.
if (!process.env.__DK_MIGRATE_CHILD) {
  const dataDir = take('--data-dir')[0];
  const r = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), ...args], {
    stdio: 'inherit', cwd: join(here, '..', 'server'),
    env: { ...process.env, __DK_MIGRATE_CHILD: '1', ...(dataDir ? { SHIPYARD_DATA_DIR: resolve(dataDir) } : {}) },
  });
  process.exit(r.status ?? 1);
}

const migration = await import(join(here, '..', 'server', 'src', 'services', 'designMigration.ts').replace(/\\/g, '/').replace(/^([a-z]):/i, 'file:///$1:'));
const projectPath = resolve(project);
const p = { id: 'cli', path: projectPath };
const resolutions = {};
for (const id of take('--keep-native')) resolutions[id] = 'keep-native';
for (const id of take('--take-legacy')) resolutions[id] = 'take-legacy';
const print = (o) => console.log(JSON.stringify(o, null, 2));

if (take('--rollback').length) { print(await migration.rollback(p, take('--rollback')[0])); }
else if (take('--apply').length) {
  const res = await migration.apply(p, { expectedPlanSha256: take('--apply')[0], resolutions });
  const { doc, ...plan } = res.plan ?? {};
  print({ ...res, plan: { state: plan.state, inventory: plan.inventory } });
  process.exit(res.ok ? 0 : 1);
} else {
  const { doc, ...plan } = await migration.plan(p, resolutions);
  print(plan);
}
