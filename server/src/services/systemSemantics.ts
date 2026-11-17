import { promises as fs } from 'fs';
import { join, basename, dirname } from 'path';

/**
 * Pure, deterministic helpers behind the System Explorer's semantic layer: how a file is classified, how
 * evidence given by a person/agent is re-verified against the examined checkout, how values in conflicting
 * design records are lined up. No I/O beyond reading the files a piece of evidence points at, no LLM, no state.
 */

// ---- file classification ------------------------------------------------------------------------

/** What a file is FOR in the game's architecture. Orthogonal to the tier (how strongly it belongs). */
export type Facet = 'logic' | 'data' | 'ui' | 'telemetry' | 'purchase' | 'requirement' | 'effect' | 'test' | 'other';

export const FACET_LABEL: Record<Facet, string> = {
  logic: 'Rules & logic', data: 'Data & parameters', ui: 'UI & presentation', telemetry: 'Telemetry',
  purchase: 'Purchase', requirement: 'Requirements', effect: 'Effects & modifiers', test: 'Tests', other: 'Other',
};

/** How strongly a file belongs to a system or responsibility. Derived, never stored. */
export type Tier = 'core' | 'participant' | 'candidate' | 'test' | 'historical' | 'related';

const posix = (p: string) => p.replace(/\\/g, '/');

export const isTestPath = (p: string) =>
  /(^|\/)(tests?|test_[^/]*|[^/]*_test)(\/|\.|$)/i.test(p) || /(^|\/)tests?\//i.test(p);

/**
 * Facet from the path alone. Words are language-level architectural vocabulary (Panel, Coordinator, Telemetry...),
 * never the vocabulary of one game.
 */
export function facetOf(path: string): Facet {
  const p = posix(path);
  if (isTestPath(p)) return 'test';
  const name = basename(p).replace(/\.[^.]+$/, '');
  if (/(^|\/)telemetry(\/|$)|telemetry|analytics|probe|metrics/i.test(p)) return 'telemetry';
  if (/(^|\/)(ui|visuals?|hud)\//i.test(p) || /(panel|screen|presenter|overlay|hud|tooltip|widget|canvas|toolbelt|indicator|feedback|heatmap|layer)/i.test(name) || /Node$/.test(name)) return 'ui';
  if (/(purchase|shop|checkout)/i.test(name)) return 'purchase';
  if (/(requirement|prerequisite)/i.test(name)) return 'requirement';
  if (/(effect|modifier|stats|buff)/i.test(name)) return 'effect';
  if (p.endsWith('.tres') || /(params|config|catalog|definition|profile|settings)/i.test(name) || /Def$/.test(name)) return 'data';
  if (/(coordinator|cycle|manager|service|rules|grid|field|controller|incubator|fertilizer|resolver|adapter|observer|clod)/i.test(name)) return 'logic';
  return p.endsWith('.gd') || p.endsWith('.tscn') ? 'logic' : 'other';
}

export interface Family { key: string; label: string; count: number; sample: string[]; paths: string[] }

/** `perks_v5/humus_farto_03.tres` → `perks_v5/humus_farto_*`. Only groups of 3+ become a family. */
export function familiesOf(paths: string[]): { families: Family[]; rest: string[] } {
  const by = new Map<string, string[]>();
  for (const p0 of paths) {
    const p = posix(p0);
    const stem = basename(p).replace(/\.[^.]+$/, '').replace(/[_-]?\d+$/, '');
    const key = `${dirname(p)}/${stem}${p.slice(p.lastIndexOf('.'))}`;
    (by.get(key) ?? by.set(key, []).get(key)!).push(p);
  }
  const families: Family[] = []; const rest: string[] = [];
  for (const [key, list] of by) {
    if (list.length >= 3) {
      const ext = key.slice(key.lastIndexOf('.'));
      families.push({ key, label: `${key.slice(0, key.length - ext.length)}_*${ext}`, count: list.length, sample: list.slice(0, 3).map(x => basename(x)), paths: list });
    } else rest.push(...list);
  }
  return { families: families.sort((a, b) => b.count - a.count), rest };
}

/** `tests/qp_a_economia_humus/x.gd` → group `tests/qp_a_economia_humus`. */
export function testGroups(paths: string[]): { dir: string; count: number; paths: string[] }[] {
  const by = new Map<string, string[]>();
  for (const p of paths) (by.get(dirname(posix(p))) ?? by.set(dirname(posix(p)), []).get(dirname(posix(p)))!).push(p);
  return [...by].map(([dir, list]) => ({ dir, count: list.length, paths: list })).sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
}

// ---- evidence given by people/agents, re-verified here ---------------------------------------------

export interface EvidenceRef { path: string; needle?: string; note?: string }
export type EvidenceState = 'verified' | 'file-only' | 'moved' | 'stale' | 'missing';
export interface ResolvedEvidence extends EvidenceRef { state: EvidenceState; line?: number; resolvedPath?: string }
export type Basis = 'demonstrated' | 'inferred' | 'candidate' | 'stale';

/**
 * Evidence is a pointer plus an optional text the code must still contain. It is looked up in the CHECKOUT
 * BEING EXAMINED on every call: nothing about it is trusted from the time it was written. A moved file is
 * followed by base name; a needle that is gone makes the evidence `stale`.
 */
export async function verifyEvidence(root: string, files: string[], ev: EvidenceRef): Promise<ResolvedEvidence> {
  const want = posix(ev.path);
  let path = want; let moved = false;
  if (!files.includes(want)) {
    const same = files.filter(f => basename(f) === basename(want));
    if (same.length === 1) { path = same[0]; moved = true; }
    else if (!(await exists(join(root, want)))) return { ...ev, state: 'missing' };
  }
  if (!ev.needle) return { ...ev, state: moved ? 'moved' : 'file-only', resolvedPath: path };
  let text: string;
  try { text = await fs.readFile(join(root, path), 'utf8'); } catch { return { ...ev, state: 'missing' }; }
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex(l => l.includes(ev.needle!));
  if (i < 0) return { ...ev, state: 'stale', resolvedPath: path };
  return { ...ev, state: moved ? 'moved' : 'verified', line: i + 1, resolvedPath: path };
}

async function exists(p: string) { try { await fs.access(p); return true; } catch { return false; } }

/** demonstrated = at least one needle verified now; inferred = only file-level pointers; stale = pointers that no longer hold. */
export function basisOf(ev: ResolvedEvidence[]): Basis {
  if (!ev.length) return 'candidate';
  if (ev.some(e => (e.state === 'verified' || e.state === 'moved') && !!e.needle)) return 'demonstrated';
  if (ev.some(e => e.state === 'file-only' || e.state === 'moved')) return 'inferred';
  return 'stale';
}

// ---- functional relations ---------------------------------------------------------------------------

export const RELATION_KINDS = ['produces', 'consumes', 'stores', 'modifies', 'unlocks', 'depends_on', 'controls', 'implemented_by', 'validated_by'] as const;
export type RelationKind = typeof RELATION_KINDS[number];
export const RELATION_LABEL: Record<RelationKind, string> = {
  produces: 'produces', consumes: 'consumes', stores: 'stores', modifies: 'modifies', unlocks: 'unlocks',
  depends_on: 'depends on', controls: 'controls', implemented_by: 'is implemented by', validated_by: 'is validated by',
};

// ---- design rule comparison ----------------------------------------------------------------------------

const DATE_RE = /\d{4}-\d{2}-\d{2}/g;
const NUM_RE = /(?<![\w.])-?\d+(?:[.,]\d+)?(?![\w])/g;
const num = (s: string) => Number(s.replace(',', '.'));

/** Numbers in a text, ignoring dates and identifiers. */
export function numbersIn(text: string): number[] {
  return [...text.replace(DATE_RE, ' ').matchAll(NUM_RE)].map(m => num(m[0])).filter(n => Number.isFinite(n));
}

const UNIT_STOP = new Set(['ao', 'a', 'de', 'do', 'da', 'dos', 'das', 'para', 'em', 'no', 'na', 'com', 'por', 'e', 'o', 'os', 'as', 'to', 'of', 'the', 'and', 'for', 'in']);
/** A unit only when a document states it right after the number ("200 de matéria"). Never guessed from code. */
export function unitAfter(text: string, value: number): string | undefined {
  const m = new RegExp(`(?<![\\w.])${String(value).replace('.', '[.,]')}(?:[.,]0+)?\\s+(?:de\\s+)?([A-Za-zÀ-ÿ]+)`).exec(text.replace(DATE_RE, ' '));
  const w = m?.[1];
  return w && !UNIT_STOP.has(w.toLowerCase()) ? w : undefined;
}

export type SourceKind = 'code' | 'code-comment' | 'document' | 'test';
export function sourceKindOf(type: string, ref: string): SourceKind {
  const path = ref.split('#')[0];
  if (type === 'test' || isTestPath(path)) return 'test';
  if (type === 'document_claim') return /\.(gd|tscn|tres)$/i.test(path) ? 'code-comment' : 'document';
  return 'code';
}
export const SOURCE_LABEL: Record<SourceKind, string> = {
  code: 'Implemented in code', 'code-comment': 'Comment in code', document: 'Declared in a document', test: 'Test expectation',
};

export interface CompareInput {
  id: string; title: string; claim: string; decisionState: string; approval?: { state?: string; source?: string };
  evidenceStatus: string; implementation: string;
  evidence: { type: string; ref: string; freshness?: string; note?: string; excerpt: string[] }[];
}
export interface CompareRow {
  kind: SourceKind; label: string; ref: string; freshness?: string; note?: string;
  value?: number; unit?: string; line?: string; ambiguous?: boolean; fromDecision: string;
}
export interface CompareColumn {
  /** the compared value, or the decision id when the conflict is not numeric */
  key: string; value?: number; unit?: string;
  /** decisions whose title/claim state this value */
  claimedBy: { id: string; title: string; decisionState: string; approval: string; evidenceStatus: string; implementation: string }[];
  rows: CompareRow[];
  /** behavior observed in code/tests vs only declared in text */
  implemented: boolean; declared: boolean;
  /** the value appears in a test file (a test fixture or assertion), which is not the same as the game doing it */
  inTests: boolean;
}
export interface Comparison {
  id: string; topic: string; numeric: boolean; decisions: string[];
  columns: CompareColumn[]; approvalNote: string; unitNote: string;
}

const refPath = (ref: string) => ref.split('#')[0].replace(/ \(was.*$/, '');

/**
 * Lines up two or more conflicting records. Numeric when the records' titles name different numbers
 * (the common "X costs 200 / X costs 1000" case); textual otherwise. Never picks a side and never turns
 * "CURRENT" into "approved": freshness and approval stay separate fields.
 */
export function compareDecisions(ds: CompareInput[]): Comparison {
  const titleNums = new Map<string, number[]>();
  for (const d of ds) titleNums.set(d.id, [...new Set(numbersIn(d.title))]);
  let values = [...new Set([...titleNums.values()].flat())];
  if (values.length < 2) {
    values = [...new Set(ds.flatMap(d => numbersIn(d.claim)))];
    for (const d of ds) titleNums.set(d.id, [...new Set(numbersIn(d.claim))].filter(v => values.includes(v)));
  }
  const numeric = values.length >= 2 && values.length <= 6;
  const apprOf = (d: CompareInput) => d.approval?.state && d.approval.state !== 'unknown' ? `${d.approval.state} (${d.approval.source ?? 'unknown source'})` : 'not located';
  const claim = (d: CompareInput) => ({ id: d.id, title: d.title, decisionState: d.decisionState, approval: apprOf(d), evidenceStatus: d.evidenceStatus, implementation: d.implementation });

  let columns: CompareColumn[];
  if (numeric) {
    columns = values.map(v => ({ key: String(v), value: v, claimedBy: ds.filter(d => (titleNums.get(d.id) ?? []).includes(v)).map(claim), rows: [] as CompareRow[], implemented: false, declared: false, inTests: false }));
    const seen = new Set<string>();
    for (const d of ds) for (const e of d.evidence) {
      const k = `${e.ref}`;
      const text = e.excerpt.map(x => x.replace(/^L\d+:\s*/, '')).join('\n');
      const hits = values.filter(v => numbersIn(text).includes(v));
      const kind = sourceKindOf(e.type, e.ref);
      for (const v of hits) {
        const col = columns.find(c => c.value === v)!;
        const dedupe = `${k}|${v}`;
        if (seen.has(dedupe)) continue; seen.add(dedupe);
        const line = e.excerpt.find(x => numbersIn(x.replace(/^L\d+:\s*/, '')).includes(v));
        col.rows.push({
          kind, label: SOURCE_LABEL[kind], ref: e.ref, freshness: e.freshness, note: e.note, value: v,
          unit: kind === 'document' || kind === 'code-comment' ? unitAfter(text, v) : undefined,
          line, ambiguous: hits.length > 1, fromDecision: d.id,
        });
      }
    }
  } else {
    columns = ds.map(d => ({
      key: d.id, claimedBy: [claim(d)], implemented: false, declared: false, inTests: false,
      rows: d.evidence.map(e => {
        const kind = sourceKindOf(e.type, e.ref);
        return { kind, label: SOURCE_LABEL[kind], ref: e.ref, freshness: e.freshness, note: e.note, line: e.excerpt[0], fromDecision: d.id };
      }),
    }));
  }
  for (const c of columns) {
    c.implemented = c.rows.some(r => r.kind === 'code');
    c.inTests = c.rows.some(r => r.kind === 'test');
    c.declared = c.rows.some(r => r.kind === 'document' || r.kind === 'code-comment') || c.claimedBy.length > 0;
    c.rows.sort((a, b) => ['code', 'test', 'code-comment', 'document'].indexOf(a.kind) - ['code', 'test', 'code-comment', 'document'].indexOf(b.kind) || refPath(a.ref).localeCompare(refPath(b.ref)));
  }
  const unapproved = ds.every(d => !d.approval?.state || d.approval.state === 'unknown');
  return {
    id: ds.map(d => d.id).sort().join('~'), topic: ds[0]?.title.replace(/[:\s]*-?\d+(?:[.,]\d+)?\s*$/, '') ?? '',
    numeric, decisions: ds.map(d => d.id),
    columns,
    approvalNote: unapproved
      ? 'No human approval was located for any side. "CURRENT" means the cited files still contain the cited text, not that the rule was approved. Nobody has chosen between these.'
      : 'At least one side has an approval record; check each side separately. Freshness is not approval.',
    unitNote: numeric ? 'A unit is shown only where a document states it next to the number; code constants carry no unit in the source.' : '',
  };
}
