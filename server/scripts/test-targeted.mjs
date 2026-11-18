// Targeted test runner (PERF-TEST-SUITE-01). It runs the SAME catalog as `pnpm test`:
// the test file list is read from the `test` script in package.json, so nothing is duplicated.
//
//   pnpm test:targeted                      -> tests that reach the src files changed in git (HEAD diff + untracked)
//   pnpm test:targeted test/worktreeClose.test.ts   -> exactly these catalog files
//
// A changed src module selects every catalog test whose import graph reaches it (transitively).
// A changed test file selects itself. When nothing is selected, it says so and runs nothing.
// The full suite (`pnpm test` / `pnpm test:full`) stays mandatory before integration.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'));
const catalog = [...pkg.scripts.test.matchAll(/test\/[\w.-]+\.test\.ts/g)].map(m => m[0]);
const posix = (p) => p.split(sep).join('/');

function listSrc(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSrc(p));
    else if (name.endsWith('.ts')) out.push(resolve(p));
  }
  return out;
}

// Resolve a relative import specifier (./x.js, ../src/services/x.js) to a .ts file under server/.
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ''));
  for (const cand of [base + '.ts', join(base, 'index.ts')]) { try { if (statSync(cand).isFile()) return cand; } catch { /* next */ } }
  return null;
}
const importsOf = (file) => {
  const text = readFileSync(file, 'utf8');
  const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map(m => m[1]);
  return specs.map(s => resolveSpec(file, s)).filter(Boolean).map(f => resolve(f));
};

// Changed files (tracked diff vs HEAD + untracked), relative to server/.
function changedFiles() {
  const repo = resolve(serverDir, '..');
  const tracked = execFileSync('git', ['-C', repo, 'diff', '--name-only', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
  const untracked = execFileSync('git', ['-C', repo, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
  return [...tracked, ...untracked].filter(Boolean)
    .map(f => resolve(repo, f)).filter(f => f.startsWith(serverDir + sep) && f.endsWith('.ts'));
}

const args = process.argv.slice(2).map(a => posix(a).replace(/^\.\//, ''));
let selected;
if (args.length) {
  const unknown = args.filter(a => !catalog.includes(a));
  if (unknown.length) { console.error(`Not in the catalog (package.json test script): ${unknown.join(', ')}`); process.exit(2); }
  selected = args;
} else {
  const changed = changedFiles();
  const srcChanged = new Set(changed.filter(f => f.includes(sep + 'src' + sep)));
  const testChanged = new Set(changed.filter(f => f.includes(sep + 'test' + sep)).map(f => posix(relative(serverDir, f))));
  // Reverse import graph over src + the catalog tests.
  const files = [...listSrc(join(serverDir, 'src')), ...catalog.map(c => resolve(serverDir, c))];
  const reverse = new Map();
  for (const f of files) for (const dep of importsOf(f)) { if (!reverse.has(dep)) reverse.set(dep, []); reverse.get(dep).push(f); }
  const reach = new Set(); const stack = [...srcChanged];
  while (stack.length) { const f = stack.pop(); if (reach.has(f)) continue; reach.add(f); for (const parent of reverse.get(f) ?? []) stack.push(parent); }
  selected = catalog.filter(c => testChanged.has(c) || reach.has(resolve(serverDir, c)));
  console.log(`changed src: ${srcChanged.size}, changed tests: ${testChanged.size}`);
}

if (process.env.TARGETED_DRY) { console.log("dry:", selected.join(" ") || "(none)"); process.exit(0); }
if (!selected.length) { console.log('No catalog test reaches the changed files. Nothing run. Use `pnpm test:full` before integrating.'); process.exit(0); }
console.log(`running ${selected.length} of ${catalog.length} catalog files:\n  ${selected.join('\n  ')}`);
const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-force-exit', ...selected], { cwd: serverDir, stdio: 'inherit' });
process.exit(r.status ?? 1);
