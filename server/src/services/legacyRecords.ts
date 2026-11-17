import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

/**
 * Pure-TypeScript reader of the legacy Design Knowledge records (`docs/design_knowledge/records/*.md`, each a
 * `<!-- dk-record {json} -->` header). It never runs Python and never writes: it is what lets the native engine
 * know which legacy records exist (and whether they were migrated) and what the migrator converts.
 */

export const LEGACY_RECORDS_REL = 'docs/design_knowledge/records';

export interface LegacyRecord {
  file: string;            // posix path relative to the project
  sha256: string;          // of the record file, as found
  record: Record<string, any>;
}
export interface LegacyReadIssue { file: string; message: string }

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const HEADER = '<!-- dk-record\n';

export function parseLegacyRecord(raw: Buffer): Record<string, any> {
  const text = raw.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const end = text.indexOf('\n-->');
  if (!text.startsWith(HEADER) || end < 0) throw new Error('missing dk-record JSON header');
  const parsed = JSON.parse(text.slice(HEADER.length, end));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('dk-record header is not an object');
  return parsed;
}

const cache = new Map<string, { at: number; stamp: string; value: { records: LegacyRecord[]; issues: LegacyReadIssue[] } }>();

/** Records in file-name order (the order dk.py reads them). Read-only; cached for a moment per directory stamp. */
export function readLegacyRecords(projectPath: string): { records: LegacyRecord[]; issues: LegacyReadIssue[] } {
  const dir = join(projectPath, LEGACY_RECORDS_REL);
  let names: string[];
  try { names = readdirSync(dir).filter(n => n.endsWith('.md')).sort(); } catch { return { records: [], issues: [] }; }
  const stamp = names.map(n => { try { const s = statSync(join(dir, n)); return `${n}:${s.size}:${s.mtimeMs}`; } catch { return n; } }).join('|');
  const hit = cache.get(dir);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < 5000) return hit.value;
  const records: LegacyRecord[] = [], issues: LegacyReadIssue[] = [];
  for (const n of names) {
    const file = `${LEGACY_RECORDS_REL}/${n}`;
    try {
      const raw = readFileSync(join(dir, n));
      records.push({ file, sha256: sha(raw), record: parseLegacyRecord(raw) });
    } catch (e: any) { issues.push({ file, message: String(e?.message ?? e).slice(0, 200) }); }
  }
  const value = { records, issues };
  cache.set(dir, { at: Date.now(), stamp, value });
  return value;
}

export const clearLegacyRecordCache = () => cache.clear();
