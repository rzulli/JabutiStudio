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

export interface Graph {
  builtAt: number;
  nodes: Map<string, GNode>;
  out: Map<string, GEdge[]>;
  inn: Map<string, GEdge[]>;
  relations: Record<string, number>;
  edgeCount: number;
}

const GODOT_FILE_RE = /\.(gd|tscn|tres)$/i;
// Third-party code, engine cache and build output are not "the project".
export const STAGE_SKIP_DIRS = new Set([
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
  // Files edited after this instant are "newer than the analysis" (see staleness).
  await fs.mkdir(projectDir(projectId), { recursive: true }); // first build on a fresh data dir
  await fs.writeFile(join(projectDir(projectId), 'meta.json'), JSON.stringify({ startedAt: started, root }));
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
  staleness?: Staleness;
}

/**
 * How many Godot sources changed on disk after the analysis started. Reliable
 * because staging copies the same file set the walk below looks at: any file
 * with an mtime later than the start of the build was not (fully) in it, and a
 * file in the walk that the graph has no node for is new. Deleted files are
 * counted from graph file nodes with no file on disk. Cached briefly: it walks
 * the project.
 */
export interface Staleness { changed: number; added: number; removed: number; checkedAt: number }
const staleCache = new Map<string, { at: number; builtAt: number; value: Staleness }>();
const STALE_TTL_MS = 30_000;

export async function getStaleness(projectId: string, root: string, g: Graph): Promise<Staleness | null> {
  const hit = staleCache.get(projectId);
  if (hit && hit.builtAt === g.builtAt && Date.now() - hit.at < STALE_TTL_MS) return hit.value;
  let startedAt: number;
  try {
    startedAt = JSON.parse(await fs.readFile(join(projectDir(projectId), 'meta.json'), 'utf8')).startedAt;
    if (typeof startedAt !== 'number') return null;
  } catch { return null; } // built before meta.json existed: cannot tell reliably
  const known = new Set<string>();
  for (const n of g.nodes.values()) if (n.kind === 'file') known.add(n.file);
  const onDisk = new Set<string>();
  let changed = 0, added = 0;
  const walk = async (dir: string) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async e => {
      const abs = join(dir, e.name);
      if (e.isDirectory()) { if (!STAGE_SKIP_DIRS.has(e.name)) await walk(abs); return; }
      if (!e.isFile() || !GODOT_FILE_RE.test(e.name)) return;
      const rel = posix(relative(root, abs));
      onDisk.add(rel);
      if (!known.has(rel)) { added++; return; }
      try { if ((await fs.stat(abs)).mtimeMs > startedAt) changed++; } catch { /* vanished */ }
    }));
  };
  await walk(root);
  let removed = 0;
  for (const f of known) if (!onDisk.has(f)) removed++;
  const value = { changed, added, removed, checkedAt: Date.now() };
  staleCache.set(projectId, { at: Date.now(), builtAt: g.builtAt, value });
  return value;
}

export async function getStatus(projectId: string, root?: string): Promise<Status> {
  const installed = !!graphifyPython();
  const building = isBuilding(projectId);
  const g = await loadGraph(projectId);
  if (!g) return { installed, building, built: false };
  const staleness = root ? await getStaleness(projectId, root, g).catch(() => null) : null;
  const confidence: Record<string, number> = {};
  for (const list of g.out.values()) for (const e of list) confidence[e.confidence] = (confidence[e.confidence] ?? 0) + 1;
  let files = 0;
  for (const n of g.nodes.values()) if (n.kind === 'file') files++;
  return {
    installed, building, built: true, builtAt: new Date(g.builtAt).toISOString(),
    summary: { nodes: g.nodes.size, edges: g.edgeCount, files, relations: g.relations, confidence },
    staleness: staleness ?? undefined,
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

export interface SearchResult {
  total: number;
  nodes: GNode[];
  /** Nodes of each kind in the whole graph, ignoring the query. Lets the UI tell
   *  'this graph has no signals' from 'no signal matches your text'. */
  counts: Record<NodeKind, number>;
}

export function searchGraph(g: Graph, query: string, kind: string | undefined, limit = 80): SearchResult {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const counts: Record<NodeKind, number> = { file: 0, func: 0, signal: 0, class: 0, external: 0 };
  for (const n of g.nodes.values()) counts[n.kind]++;
  const scored: { n: GNode; s: number }[] = [];
  for (const n of g.nodes.values()) {
    if (kind && kind !== 'all' && n.kind !== kind) continue;
    if (!terms.length) {
      // Browsing without text: the 'all' view lists files only (functions would
      // bury them 4 to 1), but a kind tab lists what it says it lists.
      if (kind && kind !== 'all') scored.push({ n, s: 1 });
      else if (n.kind === 'file') scored.push({ n, s: 1 });
      continue;
    }
    const s = score(n, terms);
    if (s > 0) scored.push({ n, s });
  }
  const browse = !terms.length;
  scored.sort((a, b) => browse
    ? a.n.file.localeCompare(b.n.file) || a.n.line - b.n.line || a.n.label.localeCompare(b.n.label)
    : b.s - a.s || a.n.file.localeCompare(b.n.file) || a.n.label.localeCompare(b.n.label));
  return { total: scored.length, nodes: scored.slice(0, limit).map(x => x.n), counts };
}

export async function search(projectId: string, query: string, kind: string | undefined, limit = 80): Promise<SearchResult | null> {
  const g = await loadGraph(projectId);
  return g ? searchGraph(g, query, kind, limit) : null;
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

/** When the last analysis started (ms), or null for an analysis made before meta.json existed. */
export async function buildStartedAt(projectId: string): Promise<number | null> {
  try {
    const v = JSON.parse(await fs.readFile(join(projectDir(projectId), 'meta.json'), 'utf8')).startedAt;
    return typeof v === 'number' ? v : null;
  } catch { return null; }
}
