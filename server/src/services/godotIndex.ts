import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Project Explorer index for Godot projects.
 *
 * Derived on demand from the files on disk; nothing is persisted and nothing is
 * a second source of truth. Only deterministic relations are extracted — each
 * one is a literal in the source (`extends "res://..."`, `preload("res://...")`,
 * an `[ext_resource]` line) and carries the file and line it came from.
 * `extends ClassName` is resolved only against a `class_name` declared in the
 * project; engine classes are recorded as `base`, never as an edge.
 */

export type NodeKind = 'gd' | 'tscn' | 'tres' | 'missing';
export type EdgeKind = 'extends' | 'preload' | 'load' | 'literal' | 'script' | 'scene' | 'resource';

export interface Symbol {
  name: string;
  kind: 'class' | 'func' | 'signal' | 'id' | 'title' | 'script_class';
  line: number;
}

export interface ExplorerNode {
  id: string;            // res:// path (the identity Godot itself uses)
  kind: NodeKind;
  name: string;          // file name
  path: string;          // path relative to the project root (forward slashes)
  dir: string;
  size: number;
  base?: string;         // engine/base class from `extends`, when not a project file
  symbols: Symbol[];
  error?: string;        // read/parse problem; the node still exists
}

export interface ExplorerEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  line: number;
  snippet: string;       // the source line, trimmed
  resolved: boolean;     // false: target file does not exist (to is a `missing` node)
}

export interface ExplorerIndex {
  root: string;
  indexedAt: string;
  tookMs: number;
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  summary: {
    gd: number; tscn: number; tres: number; missing: number;
    edges: number; unresolved: number; errors: number; skippedDirs: string[];
  };
}

export const GODOT_EXTENSIONS = new Set(['.gd', '.tscn', '.tres']);

/** Directories that hold generated, vendored or copied content, not the project. */
const SKIP_DIRS = new Set([
  '.git', '.godot', '.import', 'node_modules', 'worktrees', '.release-staging',
  'release', 'artifacts', '.claude', '.codex',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function posix(p: string): string {
  return p.split(path.sep).join('/');
}

async function walk(root: string, dir: string, out: string[], skipped: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) {
        if (dir === root) skipped.add(e.name);
        continue;
      }
      subdirs.push(path.join(dir, e.name));
    } else if (e.isFile() && GODOT_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      out.push(path.join(dir, e.name));
    }
  }
  for (const d of subdirs) await walk(root, d, out, skipped);
}

interface Parsed {
  node: ExplorerNode;
  refs: { to: string; kind: EdgeKind; line: number; snippet: string }[];
  extendsClass?: { name: string; line: number; snippet: string };
}

function parseGd(text: string, node: ExplorerNode): Parsed {
  const refs: Parsed['refs'] = [];
  let extendsClass: Parsed['extendsClass'];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const line = i + 1;

    const ext = /^extends\s+(?:"(res:\/\/[^"]+)"|'(res:\/\/[^']+)'|([A-Za-z_]\w*))/.exec(t);
    if (ext) {
      const p = ext[1] || ext[2];
      if (p) refs.push({ to: p, kind: 'extends', line, snippet: t });
      else if (ext[3]) extendsClass = { name: ext[3], line, snippet: t };
      continue;
    }
    const cn = /^class_name\s+([A-Za-z_]\w*)/.exec(t);
    if (cn) node.symbols.push({ name: cn[1], kind: 'class', line });
    const fn = /^(?:static\s+)?func\s+([A-Za-z_]\w*)/.exec(t);
    if (fn) node.symbols.push({ name: fn[1], kind: 'func', line });
    const sg = /^signal\s+([A-Za-z_]\w*)/.exec(t);
    if (sg) node.symbols.push({ name: sg[1], kind: 'signal', line });

    const seen = new Set<string>();
    const re = /\b(preload|load)\s*\(\s*["'](res:\/\/[^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      seen.add(m[2]);
      refs.push({ to: m[2], kind: m[1] as EdgeKind, line, snippet: t });
    }
    const lit = /["'](res:\/\/[^"'\s]+)["']/g;
    while ((m = lit.exec(t))) {
      // Format strings and globs are not file references.
      if (seen.has(m[1]) || /[%*{]/.test(m[1])) continue;
      seen.add(m[1]);
      refs.push({ to: m[1], kind: 'literal', line, snippet: t });
    }
  }
  return { node, refs, extendsClass };
}

function parseResourceText(text: string, node: ExplorerNode): Parsed {
  const refs: Parsed['refs'] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const line = i + 1;
    if (t.startsWith('[ext_resource')) {
      const p = /path="(res:\/\/[^"]+)"/.exec(t);
      if (!p) continue;
      const type = /type="([^"]+)"/.exec(t)?.[1] ?? '';
      const kind: EdgeKind = type === 'Script' ? 'script' : type === 'PackedScene' ? 'scene' : 'resource';
      refs.push({ to: p[1], kind, line, snippet: t });
      continue;
    }
    if (line <= 3) {
      const sc = /script_class="([^"]+)"/.exec(t);
      if (sc) node.symbols.push({ name: sc[1], kind: 'script_class', line });
    }
    // Data resources identify themselves with `id = &"..."` and `title = "..."`.
    const id = /^id\s*=\s*&?"([^"]+)"/.exec(t);
    if (id) node.symbols.push({ name: id[1], kind: 'id', line });
    const title = /^(?:title|display_name)\s*=\s*"([^"]+)"/.exec(t);
    if (title) node.symbols.push({ name: title[1], kind: 'title', line });
  }
  return { node, refs };
}

function resPath(rel: string): string {
  return `res://${rel}`;
}

async function build(root: string): Promise<ExplorerIndex> {
  const started = Date.now();
  const files: string[] = [];
  const skipped = new Set<string>();
  await walk(root, root, files, skipped);

  const parsed: Parsed[] = [];
  const queue = [...files];
  const worker = async () => {
    for (let f = queue.pop(); f !== undefined; f = queue.pop()) {
      const rel = posix(path.relative(root, f));
      const ext = path.extname(f).toLowerCase();
      const node: ExplorerNode = {
        id: resPath(rel),
        kind: ext === '.gd' ? 'gd' : ext === '.tscn' ? 'tscn' : 'tres',
        name: path.basename(f),
        path: rel,
        dir: posix(path.dirname(rel)) === '.' ? '' : posix(path.dirname(rel)),
        size: 0,
        symbols: [],
      };
      try {
        const st = await fs.stat(f);
        node.size = st.size;
        if (st.size > MAX_FILE_BYTES) {
          node.error = `Not analyzed: file is ${(st.size / 1024 / 1024).toFixed(1)} MB`;
          parsed.push({ node, refs: [] });
          continue;
        }
        const text = await fs.readFile(f, 'utf8');
        parsed.push(node.kind === 'gd' ? parseGd(text, node) : parseResourceText(text, node));
      } catch (err: any) {
        node.error = `Read failed: ${err?.message || err}`;
        parsed.push({ node, refs: [] });
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));

  parsed.sort((a, b) => a.node.path.localeCompare(b.node.path));

  const byId = new Map<string, ExplorerNode>();
  const classes = new Map<string, string>(); // class_name -> node id
  for (const p of parsed) {
    byId.set(p.node.id, p.node);
    for (const s of p.node.symbols) if (s.kind === 'class') classes.set(s.name, p.node.id);
  }

  const nodes: ExplorerNode[] = parsed.map(p => p.node);
  const edges: ExplorerEdge[] = [];
  const missing = new Map<string, ExplorerNode>();

  const dirs = new Set<string>();
  const link = (from: string, to: string, kind: EdgeKind, line: number, snippet: string) => {
    const exists = byId.has(to);
    if (!exists && dirs.has(to)) return; // a folder, not a file
    // Files Godot knows but this index does not parse (png, wav, ...) still
    // exist; only a path that is not on disk is reported as unresolved.
    edges.push({ from, to, kind, line, snippet: snippet.slice(0, 240), resolved: exists });
    if (!exists && !missing.has(to)) {
      missing.set(to, {
        id: to, kind: 'missing', name: to.split('/').pop() || to,
        path: to.replace(/^res:\/\//, ''), dir: '', size: 0, symbols: [],
      });
    }
  };

  // Non-Godot targets (textures, audio...) are checked on disk once.
  const diskCache = new Map<string, boolean>();
  const onDisk = async (to: string): Promise<boolean> => {
    if (diskCache.has(to)) return diskCache.get(to)!;
    const rel = to.replace(/^res:\/\//, '');
    let ok = false;
    try {
      const st = await fs.stat(path.join(root, rel));
      ok = st.isFile();
      if (st.isDirectory()) dirs.add(to);
    } catch { /* missing */ }
    diskCache.set(to, ok);
    return ok;
  };

  const assets = new Map<string, ExplorerNode>();
  for (const p of parsed) {
    for (const r of p.refs) {
      if (!byId.has(r.to) && !assets.has(r.to) && await onDisk(r.to)) {
        const rel = r.to.replace(/^res:\/\//, '');
        const ext = path.extname(rel).toLowerCase();
        // Asset nodes keep the graph honest without parsing binaries.
        assets.set(r.to, {
          id: r.to, kind: 'tres', name: path.basename(rel), path: rel,
          dir: posix(path.dirname(rel)) === '.' ? '' : posix(path.dirname(rel)),
          size: 0, symbols: [], base: ext ? `asset ${ext}` : 'asset',
        });
      }
    }
  }
  for (const a of assets.values()) { byId.set(a.id, a); nodes.push(a); }

  for (const p of parsed) {
    if (p.extendsClass) {
      const target = classes.get(p.extendsClass.name);
      if (target && target !== p.node.id) link(p.node.id, target, 'extends', p.extendsClass.line, p.extendsClass.snippet);
      else if (!target) p.node.base = p.extendsClass.name;
    }
    for (const r of p.refs) link(p.node.id, r.to, r.kind, r.line, r.snippet);
  }

  for (const m of missing.values()) nodes.push(m);

  const count = (k: NodeKind) => nodes.filter(n => n.kind === k && !n.base?.startsWith('asset')).length;
  return {
    root,
    indexedAt: new Date().toISOString(),
    tookMs: Date.now() - started,
    nodes,
    edges,
    summary: {
      gd: count('gd'), tscn: count('tscn'),
      tres: nodes.filter(n => n.kind === 'tres' && !n.base?.startsWith('asset')).length,
      missing: missing.size,
      edges: edges.length,
      unresolved: edges.filter(e => !e.resolved).length,
      errors: nodes.filter(n => n.error).length,
      skippedDirs: [...skipped].sort(),
    },
  };
}

// Short cache so tab switches and the inspector do not re-walk the project.
// `refresh` always rebuilds; the files on disk stay the only truth.
const cache = new Map<string, { at: number; index: ExplorerIndex }>();
const inflight = new Map<string, Promise<ExplorerIndex>>();
const TTL_MS = 30_000;

export async function getIndex(root: string, refresh = false): Promise<ExplorerIndex> {
  const hit = cache.get(root);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.index;
  const pending = inflight.get(root);
  if (pending) return pending;
  const p = build(root).then(index => {
    cache.set(root, { at: Date.now(), index });
    return index;
  }).finally(() => inflight.delete(root));
  inflight.set(root, p);
  return p;
}

export async function isGodotProject(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, 'project.godot'));
    return true;
  } catch {
    return false;
  }
}
