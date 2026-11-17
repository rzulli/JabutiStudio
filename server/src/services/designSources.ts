import { promises as fs } from 'fs';
import { isAbsolute, join } from 'path';
import { createHash } from 'crypto';
import { DATA_DIR } from './dataDir.js';
import { writeJsonAtomic } from './atomicJson.js';

/**
 * External evidence sources for Design Knowledge. A decision may cite `@<name>:<key>` — a file that lives outside the
 * game's repository (e.g. an economy spreadsheet). The repository only carries the *name*; where that name points on
 * this machine is explicit local configuration, never guessed and never taken from the repository:
 *
 *   - `data/design-sources.json`  { version: 1, projects: { [projectId]: { [name]: "<absolute file>" } } }
 *   - or the environment variable SHIPYARD_DK_SOURCE_<NAME> (name upper-cased), for every project.
 *
 * Only a configured, absolute, regular file is ever read, and only to fingerprint it and quote the cited row.
 * Verdicts stay honest: unconfigured/inaccessible => UNKNOWN (nothing was verified), missing => GONE,
 * fingerprint differs => CHANGED (row still there) or STALE (row gone), fingerprint equal => CURRENT.
 */

const REF = /^@([a-z][a-z0-9_]{0,40}):(.+)$/;
const MAX_BYTES = 8 * 1024 * 1024;
const file = () => join(DATA_DIR, 'design-sources.json');
type Config = { version: 1; projects: Record<string, Record<string, string>> };

export type ExternalStatus = 'unconfigured' | 'inaccessible' | 'missing' | 'present' | 'unsupported';
export interface ExternalVerdict {
  freshness: 'CURRENT' | 'CHANGED' | 'STALE' | 'GONE' | 'UNKNOWN'; detail: string;
  external: { source: string; key: string; status: ExternalStatus; origin?: 'config' | 'env' };
  excerpt: { line: number; text: string }[];
}

export const parseExternalRef = (path: string) => { const m = REF.exec(path); return m ? { source: m[1], key: m[2] } : null; };

async function readConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf8'));
    return { version: 1, projects: raw && typeof raw.projects === 'object' && raw.projects ? raw.projects : {} };
  } catch { return { version: 1, projects: {} }; }
}

export async function configuredSources(projectId: string): Promise<Record<string, { path: string; origin: 'config' | 'env' }>> {
  const out: Record<string, { path: string; origin: 'config' | 'env' }> = {};
  for (const [name, p] of Object.entries((await readConfig()).projects[projectId] ?? {})) if (typeof p === 'string') out[name] = { path: p, origin: 'config' };
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^SHIPYARD_DK_SOURCE_([A-Z][A-Z0-9_]*)$/.exec(k);
    if (m && v) out[m[1].toLowerCase()] = { path: v, origin: 'env' };
  }
  return out;
}

/** Explicit configuration (UI only at the route). The path must be absolute; whether it exists is judged at read time. */
export async function setSource(projectId: string, name: string, path: string | null) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(name)) return { ok: false as const, error: 'Invalid source name' };
  if (path !== null && (!isAbsolute(path) || path.startsWith('\\\\') || path.startsWith('//'))) return { ok: false as const, error: 'The source must be an absolute local file path' };
  const cfg = await readConfig();
  const mine = { ...(cfg.projects[projectId] ?? {}) };
  if (path === null) delete mine[name]; else mine[name] = path;
  cfg.projects[projectId] = mine;
  await writeJsonAtomic(file(), cfg);
  return { ok: true as const };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export async function resolveExternal(projectId: string, ref: { source: string; key: string }, expectedSha?: string): Promise<ExternalVerdict> {
  const base = { source: ref.source, key: ref.key };
  const unknown = (status: ExternalStatus, detail: string, origin?: 'config' | 'env'): ExternalVerdict =>
    ({ freshness: 'UNKNOWN', detail, external: { ...base, status, origin }, excerpt: [] });
  const cfg = (await configuredSources(projectId))[ref.source];
  if (!cfg) return unknown('unconfigured', `external source "${ref.source}" is not configured on this machine (design-sources.json or SHIPYARD_DK_SOURCE_${ref.source.toUpperCase()}); nothing was verified`);
  if (!isAbsolute(cfg.path) || cfg.path.startsWith('\\\\') || cfg.path.startsWith('//')) return unknown('inaccessible', `external source "${ref.source}" is not an absolute local file path`, cfg.origin);
  let st;
  try { st = await fs.stat(cfg.path); }
  catch (e: any) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { freshness: 'GONE', detail: `external source "${ref.source}" is configured but the file does not exist`, external: { ...base, status: 'missing', origin: cfg.origin }, excerpt: [] };
    return unknown('inaccessible', `external source "${ref.source}" cannot be read (${e.code ?? 'error'}); nothing was verified`, cfg.origin);
  }
  if (!st.isFile() || st.size > MAX_BYTES) return unknown('inaccessible', `external source "${ref.source}" is not a regular file under ${MAX_BYTES / 1024 / 1024} MB`, cfg.origin);
  let bytes: Buffer;
  try { bytes = await fs.readFile(cfg.path); } catch (e: any) { return unknown('inaccessible', `external source "${ref.source}" cannot be read (${e.code ?? 'error'}); nothing was verified`, cfg.origin); }
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(l => l.startsWith(ref.key + ';') || l.startsWith(ref.key + ',') || l.startsWith(ref.key + '\t'));
  const excerpt = at >= 0 ? [{ line: at + 1, text: lines[at].slice(0, 240) }] : [];
  const meta = { ...base, status: 'present' as const, origin: cfg.origin };
  if (!expectedSha) return { freshness: 'UNKNOWN', detail: 'external evidence has no recorded fingerprint to compare', external: meta, excerpt };
  if (sha(bytes) === expectedSha) return { freshness: 'CURRENT', detail: 'external source fingerprint matches', external: meta, excerpt };
  return at >= 0
    ? { freshness: 'CHANGED', detail: 'external source changed since registered; the cited row is still present', external: meta, excerpt }
    : { freshness: 'STALE', detail: 'external source changed and the cited row is no longer present', external: meta, excerpt };
}
