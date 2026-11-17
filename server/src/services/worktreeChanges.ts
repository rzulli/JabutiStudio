import { createHash } from 'crypto';
import * as git from './gitService.js';

/**
 * Why is this worktree dirty? (R2-A2)
 *
 * Built only on what Git reports. Nothing here decides that anything may be
 * thrown away: every file ends up in one of three assessments and none of them
 * is "discard".
 *   apparent-reserialization  the engine/script rewrote the file, but the same lines are still there
 *   material                  lines or resource references were really added/removed
 *   unknown                   nobody looked at (or could look at) this change
 * "Apparent reserialization" is information for a human, not authorization.
 */

export type Assessment = 'apparent-reserialization' | 'material' | 'unknown';

export interface ResourceFileReport {
  path: string;
  classification: 'reordered' | 'reserialized' | 'references-removed' | 'content-changed' | 'deleted' | 'untracked' | 'unreadable';
  assessment: Assessment;
  addedLines: number;
  removedLines: number;
  /** ext_resource declarations present before and gone now: a lost reference, never ignorable. */
  extResourcesRemoved: string[];
  extResourcesAdded: number;
}

export interface ChangeReport {
  ok: boolean;
  total: number;
  counts: Record<git.ChangeKind, number>;
  entries: (git.ChangeEntry & { assessment: Assessment; generated?: boolean })[];
  entriesTruncated: boolean;
  ignored: { total: number; sample: string[]; truncated: boolean };
  resources: {
    total: number;
    apparentReserialization: number;
    material: number;
    unknown: number;
    withReferenceRemovals: number;
    /** Same shape of change in several files: evidence of a generator, still only evidence. */
    pattern: string | null;
    files: ResourceFileReport[];
  };
  /** Changes nobody assessed (everything that is not a `.tres` we could diff). */
  unknownCount: number;
  /** Stable fingerprint of the change set (paths, codes, ignored entries): the close token includes it. */
  digest: string;
}

const MAX_ENTRIES = 500;
const MAX_RESOURCE_FILES = 300;
const EXT_RE = /^\s*\[ext_resource\b/;

const norm = (l: string) => l.replace(/\s+/g, ' ').trim();
/** Renumbering ids and load_steps is what a re-save does; compare modulo that. */
const loose = (l: string) => norm(l)
  .replace(/\bid="[^"]*"/g, 'id=_')
  .replace(/\bload_steps=\d+/g, 'load_steps=_')
  .replace(/\b(Ext|Sub)Resource\("[^"]*"\)/g, '$1Resource(_)');

function multiset(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}
function sameMultiset(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Classify one tracked, modified `.tres` from its diff against HEAD. Exported for tests. */
export function analyzeResourceDiff(path: string, diff: string): ResourceFileReport {
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
  }
  const addedSet = new Set(added.map(norm));
  const removedSet = new Set(removed.map(norm));
  const extRemoved = removed.filter(l => EXT_RE.test(l) && !addedSet.has(norm(l))).map(norm);
  const extAdded = added.filter(l => EXT_RE.test(l) && !removedSet.has(norm(l))).length;
  const base = { path, addedLines: added.length, removedLines: removed.length, extResourcesRemoved: extRemoved.slice(0, 8), extResourcesAdded: extAdded };

  if (!removed.length && !added.length) return { ...base, classification: 'reserialized', assessment: 'apparent-reserialization' };
  if (sameMultiset(multiset(removed.map(norm)), multiset(added.map(norm)))) return { ...base, classification: 'reordered', assessment: 'apparent-reserialization' };
  if (sameMultiset(multiset(removed.map(loose)), multiset(added.map(loose)))) return { ...base, classification: 'reserialized', assessment: 'apparent-reserialization' };
  // A lost reference outranks everything: even if the rest looks like noise it must be looked at.
  if (extRemoved.length) return { ...base, classification: 'references-removed', assessment: 'material' };
  return { ...base, classification: 'content-changed', assessment: 'material' };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const EMPTY = { addedLines: 0, removedLines: 0, extResourcesRemoved: [] as string[], extResourcesAdded: 0 };

export async function classifyChanges(cwd: string): Promise<ChangeReport> {
  const [st, ign] = await Promise.all([git.statusEntries(cwd), git.ignoredEntries(cwd)]);
  const counts: Record<git.ChangeKind, number> = { staged: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0 };
  for (const e of st.entries) for (const k of e.kinds) counts[k]++;

  const tresEntries = st.entries.filter(e => e.path.toLowerCase().endsWith('.tres'));
  const analyzable = tresEntries.filter(e => !e.kinds.includes('untracked') && !e.kinds.includes('deleted')).slice(0, MAX_RESOURCE_FILES);
  const reports = new Map<string, ResourceFileReport>();
  await mapLimit(analyzable, 6, async e => {
    const d = await git.diffAgainstHead(cwd, e.path);
    reports.set(e.path, !d.ok || d.truncated || d.binary
      ? { path: e.path, classification: 'unreadable', assessment: 'unknown', ...EMPTY }
      : analyzeResourceDiff(e.path, d.diff));
  });
  for (const e of tresEntries) {
    if (reports.has(e.path)) continue;
    const kind = e.kinds.includes('untracked') ? 'untracked' : e.kinds.includes('deleted') ? 'deleted' : 'unreadable';
    reports.set(e.path, { path: e.path, classification: kind, assessment: kind === 'deleted' ? 'material' : 'unknown', ...EMPTY });
  }
  const files = [...reports.values()];
  const apparent = files.filter(f => f.assessment === 'apparent-reserialization').length;
  const withRefs = files.filter(f => f.extResourcesRemoved.length > 0).length;
  // A "pattern" needs several files with the same shape; one file is not a pattern.
  const shapes = new Map<string, number>();
  for (const f of files) if (f.assessment === 'apparent-reserialization') shapes.set(f.classification, (shapes.get(f.classification) ?? 0) + 1);
  const top = [...shapes.entries()].sort((a, b) => b[1] - a[1])[0];
  const pattern = top && top[1] >= 3
    ? `${top[1]} of ${files.length} .tres files were only ${top[0] === 'reordered' ? 'reordered' : 're-saved (ids, order or header)'}`
    : null;

  const entries = st.entries.slice(0, MAX_ENTRIES).map(e => {
    const r = reports.get(e.path);
    const assessment: Assessment = r ? r.assessment : 'unknown';
    return { ...e, assessment, ...(r && r.assessment === 'apparent-reserialization' ? { generated: true } : {}) };
  });

  const digest = createHash('sha256')
    .update(JSON.stringify([st.entries.map(e => [e.xy, e.path, e.from ?? '']), ign.entries, ign.fingerprint]))
    .digest('hex');

  return {
    ok: st.ok && ign.ok,
    total: st.entries.length,
    counts,
    entries,
    entriesTruncated: st.entries.length > MAX_ENTRIES,
    ignored: { total: ign.entries.length, sample: ign.entries.slice(0, 40), truncated: ign.entries.length > 40 },
    resources: {
      total: files.length,
      apparentReserialization: apparent,
      material: files.filter(f => f.assessment === 'material').length,
      unknown: files.filter(f => f.assessment === 'unknown').length,
      withReferenceRemovals: withRefs,
      pattern,
      files: files.sort((a, b) => Number(b.extResourcesRemoved.length > 0) - Number(a.extResourcesRemoved.length > 0) || a.path.localeCompare(b.path)),
    },
    unknownCount: entries.filter(e => e.assessment === 'unknown').length,
    digest,
  };
}
