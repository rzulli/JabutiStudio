/**
 * Project Explorer adapter for Graphify (Godot fork:
 * https://github.com/hidalgob/graphify-godot).
 *
 * Graphify is the extraction engine and stays external: this file only
 *  1. stages the project's Godot sources (so the checkout never gets a
 *     `graphify-out/` folder),
 *  2. runs `python -m graphify update` on the staged copy, and
 *  3. reads the resulting `graph.json` into a queryable in-memory graph.
 * There is deliberately no GDScript parsing here. Install the engine with
 * `pnpm graphify:setup` (or point SHIPYARD_GRAPHIFY_PYTHON at an interpreter
 * that has it).
 */
import { spawn } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import { join, relative, sep } from 'path';
import { DATA_DIR } from './dataDir.js';

export type NodeKind = 'file' | 'func' | 'signal' | 'class' | 'external';

export interface GNode {
  id: string;
  label: string;
  kind: NodeKind;
  file: string;          // project-relative path ('' for engine classes / unresolved refs)
  line: number;          // 1-based, 0 when unknown
  community: number;
}

export interface GEdge {
  from: string;
  to: string;
  relation: string;
  confidence: 'EXTRACTED' | 'INFERRED' | string;
  file: string;          // file the relation was found in
  line: number;
  count: number;         // identical (from,to,relation) edges collapsed into this one
}

interface Graph {
  builtAt: number;
  nodes: Map<string, GNode>;
  out: Map<string, GEdge[]>;
  inn: Map<string, GEdge[]>;
  relations: Record<string, number>;
  edgeCount: number;
}

const GODOT_FILE_RE = /\.(gd|tscn|tres)$/i;
// Third-party code, engine cache and build output are not "the project".
const STAGE_SKIP_DIRS = new Set([
  '.git', '.godot', '.import', 'addons', 'node_modules', 'worktrees', 'artifacts', 'release',
  '.release-staging', 'playtest_data', 'build', 'dist', 'out', 'bin', '.claude', '.codex',
]);

const baseDir = () => join(DATA_DIR, 'graphify');
const projectDir = (projectId: string) => join(baseDir(), 'projects', projectId.replace(/[^a-zA-Z0-9_-]/g, '_'));

export function graphifyPython(): string | null {
  const env = process.env.SHIPYARD_GRAPHIFY_PYTHON;
  if (env && existsSync(env)) return env;
  const venv = join(baseDir(), 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return existsSync(venv) ? venv : null;
}

export async function isGodotProject(root: string): Promise<boolean> {
  return existsSync(join(root, 'project.godot'));
}

// ── Staging + run ──────────────────────────────────────────────

async function stage(root: string, dest: string): Promise<number> {
  // Wipe everything except Graphify's own output (its cache keeps reruns fast).
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(dest)) {
    if (entry === 'graphify-out') continue;
    await fs.rm(join(dest, entry), { recursive: true, force: true });
  }
  let copied = 0;
  const walk = async (dir: string) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (STAGE_SKIP_DIRS.has(e.name)) continue;
        await walk(abs);
      } else if (e.isFile() && (GODOT_FILE_RE.test(e.name) || (dir === root && e.name === 'project.godot'))) {
        const out = join(dest, relative(root, abs));
        await fs.mkdir(join(out, '..'), { recursive: true });
        await fs.copyFile(abs, out);
        copied++;
      }
    }
  };
  await walk(root);
  return copied;
}

const inflightBuilds = new Map<string, Promise<BuildResult>>();
export interface BuildResult { files: number; nodes: number; edges: number; tookMs: number }

export function buildGraph(projectId: string, root: string): Promise<BuildResult> {
  const running = inflightBuilds.get(projectId);
  if (running) return running;
  const p = doBuild(projectId, root).finally(() => inflightBuilds.delete(projectId));
  inflightBuilds.set(projectId, p);
  return p;
}

export const isBuilding = (projectId: string) => inflightBuilds.has(projectId);

async function doBuild(projectId: string, root: string): Promise<BuildResult> {
  const python = graphifyPython();
  if (!python) throw new Error('Graphify is not installed. Run `pnpm graphify:setup`.');
  const started = Date.now();
  const tree = join(projectDir(projectId), 'tree');
  const files = await stage(root, tree);
  // A stale graph would keep nodes of deleted files; Graphify's cache still
  // makes the re-extraction cheap.
  await fs.rm(join(tree, 'graphify-out', 'graph.json'), { force: true });

  await new Promise<void>((resolve, reject) => {
    // -I: do not import from the cwd/script dir.
    const child = spawn(python, ['-I', '-m', 'graphify', 'update', tree], {
      cwd: projectDir(projectId),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let tail = '';
    const keep = (b: Buffer) => { tail = (tail + b.toString()).slice(-2000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Graphify timed out after 10 min')); }, 10 * 60_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Graphify exited with ${code}: ${tail.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });

  cache.delete(projectId);
  const g = await loadGraph(projectId);
  if (!g) throw new Error('Graphify finished without producing graph.json');
  return { files, nodes: g.nodes.size, edges: g.edgeCount, tookMs: Date.now() - started };
}

// ── Reading graph.json ─────────────────────────────────────────

const cache = new Map<string, { mtime: number; graph: Graph }>();

function classify(label: string, file: string): NodeKind {
  if (GODOT_FILE_RE.test(label)) return 'file';
  if (label.endsWith('(signal)')) return 'signal';
  if (label.endsWith('()')) return 'func';
  return file ? 'class' : 'external';
}

const parseLine = (loc: unknown) => {
  const m = /L(\d+)/.exec(String(loc ?? ''));
  return m ? parseInt(m[1], 10) : 0;
};
const posix = (p: string) => p.split(sep).join('/').replace(/\\/g, '/');

export async function loadGraph(projectId: string): Promise<Graph | null> {
  const file = join(projectDir(projectId), 'tree', 'graphify-out', 'graph.json');
  let stat;
  try { stat = await fs.stat(file); } catch { return null; }
  const hit = cache.get(projectId);
  if (hit && hit.mtime === stat.mtimeMs) return hit.graph;

  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  const nodes = new Map<string, GNode>();
  for (const n of raw.nodes ?? []) {
    const label = String(n.label ?? n.id);
    const f = posix(String(n.source_file ?? ''));
    nodes.set(n.id, { id: n.id, label, kind: classify(label, f), file: f, line: parseLine(n.source_location), community: n.community ?? -1 });
  }
  const out = new Map<string, GEdge[]>();
  const inn = new Map<string, GEdge[]>();
  const seen = new Map<string, GEdge>();
  const relations: Record<string, number> = {};
  let edgeCount = 0;
  for (const e of raw.links ?? raw.edges ?? []) {
    // graph.json is written through an undirected-style normalisation: for about
    // half of the edges `source`/`target` are swapped (e.g. `RefCounted -inherits->
    // File.gd`). `_src`/`_tgt` keep the direction the extractor emitted.
    const from = e._src ?? e.source, to = e._tgt ?? e.target;
    if (!nodes.has(from) || !nodes.has(to)) continue;
    const key = `${from}|${to}|${e.relation}`;
    const dup = seen.get(key);
    if (dup) { dup.count++; continue; }
    const edge: GEdge = {
      from, to, relation: e.relation, confidence: e.confidence ?? 'EXTRACTED',
      file: posix(String(e.source_file ?? '')), line: parseLine(e.source_location), count: 1,
    };
    seen.set(key, edge);
    edgeCount++;
    relations[e.relation] = (relations[e.relation] ?? 0) + 1;
    (out.get(from) ?? out.set(from, []).get(from)!).push(edge);
    (inn.get(to) ?? inn.set(to, []).get(to)!).push(edge);
  }
  const graph: Graph = { builtAt: stat.mtimeMs, nodes, out, inn, relations, edgeCount };
  cache.set(projectId, { mtime: stat.mtimeMs, graph });
  return graph;
}

// ── Queries ────────────────────────────────────────────────────

export interface Status {
  installed: boolean;
  building: boolean;
  built: boolean;
  builtAt?: string;
  summary?: { nodes: number; edges: number; files: number; relations: Record<string, number>; confidence: Record<string, number> };
}

export async function getStatus(projectId: string): Promise<Status> {
  const installed = !!graphifyPython();
  const building = isBuilding(projectId);
  const g = await loadGraph(projectId);
  if (!g) return { installed, building, built: false };
  const confidence: Record<string, number> = {};
  for (const list of g.out.values()) for (const e of list) confidence[e.confidence] = (confidence[e.confidence] ?? 0) + 1;
  let files = 0;
  for (const n of g.nodes.values()) if (n.kind === 'file') files++;
  return {
    installed, building, built: true, builtAt: new Date(g.builtAt).toISOString(),
    summary: { nodes: g.nodes.size, edges: g.edgeCount, files, relations: g.relations, confidence },
  };
}

function score(n: GNode, terms: string[]): number {
  const label = n.label.toLowerCase().replace(/\(signal\)$|\(\)$/, '');
  const file = n.file.toLowerCase();
  let total = 0;
  for (const t of terms) {
    let s = 0;
    if (label === t) s = 100;
    else if (label.startsWith(t) || label.startsWith('_' + t)) s = 60;
    else if (label.includes(t)) s = 40;
    else if (file.includes(t)) s = 15;
    if (!s) return 0;
    total += s;
  }
  // Files and classes first, then signals, then functions; engine classes last.
  // .tres are data rows (hundreds of near-identical names): keep them below code.
  const fileBonus = /\.gd$/i.test(n.label) ? 10 : /\.tscn$/i.test(n.label) ? 8 : 4;
  const bonus = { file: fileBonus, class: 6, signal: 3, func: 0, external: -20 }[n.kind];
  return total + bonus - Math.min(n.label.length, 40) / 100;
}

export async function search(projectId: string, query: string, kind: string | undefined, limit = 80): Promise<{ total: number; nodes: GNode[] } | null> {
  const g = await loadGraph(projectId);
  if (!g) return null;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { n: GNode; s: number }[] = [];
  for (const n of g.nodes.values()) {
    if (kind && kind !== 'all' && n.kind !== kind) continue;
    if (!terms.length) { if (n.kind === 'file') scored.push({ n, s: 1 }); continue; }
    const s = score(n, terms);
    if (s > 0) scored.push({ n, s });
  }
  scored.sort((a, b) => b.s - a.s || a.n.file.localeCompare(b.n.file) || a.n.label.localeCompare(b.n.label));
  return { total: scored.length, nodes: scored.slice(0, limit).map(x => x.n) };
}

export interface Neighbor { edge: GEdge; node: GNode }

export async function getNode(projectId: string, id: string): Promise<{
  node: GNode;
  outgoing: Neighbor[];
  incoming: Neighbor[];
  contains: GNode[];
  container?: GNode;
} | null> {
  const g = await loadGraph(projectId);
  const node = g?.nodes.get(id);
  if (!g || !node) return null;
  const pair = (list: GEdge[] | undefined, side: 'to' | 'from'): Neighbor[] =>
    (list ?? []).filter(e => e.relation !== 'contains' && e.relation !== 'method')
      .map(edge => ({ edge, node: g.nodes.get(edge[side])! }))
      .sort((a, b) => a.edge.relation.localeCompare(b.edge.relation)
        || (a.edge.confidence === b.edge.confidence ? 0 : a.edge.confidence === 'EXTRACTED' ? -1 : 1)
        || a.node.label.localeCompare(b.node.label));
  const contains = (g.out.get(id) ?? []).filter(e => e.relation === 'contains' || e.relation === 'method')
    .map(e => g.nodes.get(e.to)!).sort((a, b) => a.line - b.line);
  const containerEdge = (g.inn.get(id) ?? []).find(e => e.relation === 'contains' || e.relation === 'method');
  return {
    node,
    outgoing: pair(g.out.get(id), 'to'),
    incoming: pair(g.inn.get(id), 'from'),
    contains,
    container: containerEdge ? g.nodes.get(containerEdge.from) : undefined,
  };
}
