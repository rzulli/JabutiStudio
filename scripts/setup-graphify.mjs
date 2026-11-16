// Installs the Godot fork of Graphify (https://github.com/hidalgob/graphify-godot)
// into data/graphify/{src,venv}. Graphify stays an external engine: Shipyard only
// runs it and reads graph.json. Re-run to update.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.SHIPYARD_DATA_DIR ? join(process.env.SHIPYARD_DATA_DIR, 'graphify') : join(root, 'data', 'graphify');
const src = join(base, 'src');
const venv = join(base, 'venv');
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) { console.error(`failed: ${cmd} ${args.join(' ')}`); process.exit(1); }
};
mkdirSync(base, { recursive: true });
if (existsSync(join(src, '.git'))) run('git', ['-C', src, 'pull', '--ff-only']);
else run('git', ['clone', '--depth', '1', 'https://github.com/hidalgob/graphify-godot', src]);
const py = process.platform === 'win32' ? 'python' : 'python3';
if (!existsSync(venv)) run(py, ['-m', 'venv', venv]);
const vpy = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
run(vpy, ['-m', 'pip', 'install', '-q', '-e', src]);
console.log('Graphify (Godot fork) installed at', base);
