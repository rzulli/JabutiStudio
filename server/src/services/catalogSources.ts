import { promises as fs } from 'fs';
import { join, resolve, delimiter } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { DATA_DIR } from './dataDir.js';
import { canonicalPath } from './pathIdentity.js';

/**
 * Where the system catalog of a project lives, and whether another installation of JabutiStudio on this machine
 * holds a different catalog for the same project id.
 *
 * Why this exists: the dev Electron (`pnpm dev:electron`) keeps its data in `<repo>/data`, the installed app in
 * `%APPDATA%/JabutiStudio/data`. The project id is derived from the project path, so both use the same id and the
 * same file name, but the files are different. Everything here is read-only: nothing is copied, merged or chosen.
 */

export interface CatalogProbe {
  dir: string;
  file: string;
  exists: boolean;
  sha256: string | null;
  systems: number;
  ids: string[];
  modifiedAt: string | null;
  error?: string;
}

export interface ActiveSource {
  dataDir: string;
  /** How the data dir was selected: an explicit env var (Electron always sets it) or the repo-relative default. */
  selectedBy: 'SHIPYARD_DATA_DIR' | 'repo default (<repo>/data)';
  mode: 'electron' | 'standalone server';
  port: string | null;
  pid: number;
}

export function activeSource(): ActiveSource {
  return {
    dataDir: DATA_DIR,
    selectedBy: process.env.SHIPYARD_DATA_DIR ? 'SHIPYARD_DATA_DIR' : 'repo default (<repo>/data)',
    mode: process.env.SHIPYARD_ELECTRON === '1' ? 'electron' : 'standalone server',
    port: process.env.SHIPYARD_PORT ?? null,
    pid: process.pid,
  };
}

const safe = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Data dirs another JabutiStudio instance on this machine would use (never arbitrary paths). */
export function siblingDataDirs(): string[] {
  const out: string[] = [];
  out.push(resolve(import.meta.dirname, '../../../data'));
  const appData = process.env.APPDATA
    ?? (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : join(homedir(), '.config'));
  out.push(join(appData, 'JabutiStudio', 'data'));
  for (const extra of (process.env.SHIPYARD_SIBLING_DATA_DIRS ?? '').split(delimiter).filter(Boolean)) out.push(resolve(extra));
  const seen = new Set([canonicalPath(DATA_DIR)]);
  return out.filter(d => { const k = canonicalPath(d); if (seen.has(k)) return false; seen.add(k); return true; });
}

export async function probe(dir: string, projectId: string): Promise<CatalogProbe> {
  const file = join(dir, 'systems', `${safe(projectId)}.json`);
  const base: CatalogProbe = { dir, file, exists: false, sha256: null, systems: 0, ids: [], modifiedAt: null };
  try {
    const [raw, st] = await Promise.all([fs.readFile(file), fs.stat(file)]);
    base.exists = true;
    base.sha256 = createHash('sha256').update(raw).digest('hex');
    base.modifiedAt = st.mtime.toISOString();
    const data = JSON.parse(raw.toString('utf8'));
    if (!data || !Array.isArray(data.systems)) throw new Error('unexpected shape');
    base.systems = data.systems.length;
    base.ids = data.systems.map((s: any) => String(s?.id));
  } catch (e: any) {
    if (e.code !== 'ENOENT') base.error = String(e?.message ?? e);
  }
  return base;
}

/** Sibling catalogs that hold systems for this project and are not the active one. */
export async function otherCatalogs(projectId: string): Promise<CatalogProbe[]> {
  const probes = await Promise.all(siblingDataDirs().map(d => probe(d, projectId)));
  return probes.filter(p => p.exists);
}

export function isKnownSibling(dir: string): string | null {
  const k = canonicalPath(dir);
  return siblingDataDirs().find(d => canonicalPath(d) === k) ?? null;
}
