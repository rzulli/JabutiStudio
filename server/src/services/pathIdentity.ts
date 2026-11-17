import { resolve } from 'path';
import { realpathSync } from 'fs';

/**
 * One identity for a folder, whatever spelling reached us: 8.3 short names (`JABUTI~1`), separators, case on
 * Windows, symlinked parents. Used wherever two paths are compared to decide "same project / same checkout".
 * It resolves through the filesystem (never a string comparison alone) and falls back to the lexical form for a
 * path that does not exist yet. It grants nothing: callers still check that a checkout is one Git lists.
 */
const cache = new Map<string, { at: number; key: string }>();
const TTL_MS = 30_000;

export function canonicalPath(p: string): string {
  const abs = resolve(p);
  const hit = cache.get(abs);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.key;
  let full = abs;
  try { full = realpathSync.native(abs); } catch { /* path may not exist (yet) */ }
  full = full.replace(/\\/g, '/').replace(/\/+$/, '');
  const key = process.platform === 'win32' ? full.toLowerCase() : full;
  if (cache.size > 2000) cache.clear();
  cache.set(abs, { at: Date.now(), key });
  return key;
}
