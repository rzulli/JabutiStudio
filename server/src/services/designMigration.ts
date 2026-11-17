import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './dataDir.js';
import { writeJsonAtomic } from './atomicJson.js';
import * as store from './designDecisions.js';
import * as core from './designCore.js';
import { readLegacyRecords, LEGACY_RECORDS_REL, type LegacyRecord } from './legacyRecords.js';

/**
 * Legacy Design Knowledge -> native `jabutistudio.decisions.json` (R1-B2).
 *
 * Contract:
 *  - the legacy files are read, never written or deleted (the migrator has no code path that touches them);
 *  - ids, claims, conflicts, evidence (path, lines, fingerprint, note, type) and the record's own states are
 *    preserved verbatim; nothing is promoted: a legacy "approved"/human_decision stays a *claim*, and approval
 *    still exists only as a local attestation bound to the claim hash (sha256 of the stripped claim, same as dk.py,
 *    so an attestation made against the legacy record keeps applying to the migrated one, and lapses on edit);
 *  - anything the native schema cannot carry makes the record `blocked` instead of being dropped silently;
 *  - `plan()` writes nothing; `apply()` needs the hash of the plan the caller reviewed and refuses on any blocked
 *    record or divergence from an existing native decision (unless explicitly resolved);
 *  - running it twice changes nothing (`equivalent` records are skipped, no write, no backup).
 */

const run = promisify(execFile);
const KNOWN = new Set(['id', 'title', 'claim', 'decision_state', 'approval_state', 'implementation_state', 'implementation_sources',
  'scope', 'evidence', 'supersedes', 'conflicts_with', 'files', 'tests', 'qps', 'tags', 'system']);
const KNOWN_EVIDENCE = new Set(['type', 'ref', 'note', 'sha256', 'relation', 'approval_scope', 'approved_rule']);
const REF_RE = /^(.+?)(?:#L(\d+)(?:-L?(\d+))?)?$/;
const DECISION_STATES = new Set(['hypothesis', 'open', 'approved', 'superseded', 'rejected', 'unknown']);
const IMPLEMENTATION_STATES = new Set(['absent', 'partial', 'implemented', 'divergent', 'unknown']);
const APPROVAL_STATES = new Set(['unknown', 'claimed', 'approved', 'rejected', 'revoked']);
const EPOCH = '1970-01-01T00:00:00.000Z';

export interface Project { id: string; path: string }
export type Outcome = 'add' | 'equivalent' | 'divergent' | 'duplicate' | 'blocked';
export interface RecordPlan {
  id: string; sourceRecord: string; sourceSha256: string; outcome: Outcome;
  issues: string[];       // why it is blocked / divergent
  notes: string[];        // lossless-but-notable facts (e.g. external evidence the native engine cannot verify)
}
export interface Plan {
  state: 'ready' | 'nothing-to-do' | 'blocked' | 'no-legacy';
  reason?: string;
  target: { file: string; state: store.ReadResult['state']; sha256: string | null };
  records: RecordPlan[];
  inventory: { found: number; unreadable: number; add: number; equivalent: number; divergent: number; duplicate: number; blocked: number };
  unreadable: { file: string; message: string }[];
  planSha256: string | null;   // sha256 of the file apply() would write; what the caller must send back
  doc?: store.DecisionsDoc;    // the resulting document (not serialised by routes)
  divergent: { id: string; native: unknown; legacy: unknown }[]; // both sides, side by side — never merged
}

const sortKeys = (v: any): any => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
const canonical = (d: store.NativeDecision) => { const { createdAt, updatedAt, ...rest } = d; return JSON.stringify(sortKeys(rest)); };
const strArr = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');

async function firstCommitDate(root: string, rel: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', root, 'log', '--diff-filter=A', '--follow', '--format=%aI', '--', rel], { timeout: 20_000 });
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1];
    return last ? new Date(last).toISOString() : null;
  } catch { return null; }
}

interface Converted { decision?: store.NativeDecision; issues: string[]; notes: string[] }

/** Validate one record (what dk.py `validate` calls schema errors) and convert it. Never guesses a missing value. */
async function convert(root: string, lr: LegacyRecord, allIds: Set<string>): Promise<Converted> {
  const r = lr.record, issues: string[] = [], notes: string[] = [];
  const id = typeof r.id === 'string' ? r.id : '';
  for (const k of Object.keys(r)) if (!KNOWN.has(k)) issues.push(`field "${k}" has no native equivalent (would be lost)`);
  for (const k of ['id', 'title', 'claim', 'decision_state', 'approval_state', 'implementation_state', 'implementation_sources', 'scope', 'evidence', 'supersedes', 'conflicts_with', 'files', 'tests', 'qps', 'tags'])
    if (!(k in r)) issues.push(`missing field ${k}`);
  if (issues.some(i => i.startsWith('missing'))) return { issues, notes };
  if (typeof r.title !== 'string' || typeof r.claim !== 'string') issues.push('title and claim must be text');
  if (!DECISION_STATES.has(r.decision_state)) issues.push('invalid decision_state');
  if (!APPROVAL_STATES.has(r.approval_state)) issues.push('invalid approval_state');
  if (!IMPLEMENTATION_STATES.has(r.implementation_state)) issues.push('invalid implementation_state');
  if (![r.scope, r.supersedes, r.conflicts_with, r.tests, r.qps, r.tags].every(strArr)) issues.push('scope/supersedes/conflicts_with/tests/qps/tags must be lists of text');
  if (!Array.isArray(r.files) || !r.files.every((f: any) => f && typeof f.path === 'string' && typeof (f.role ?? '') === 'string')) issues.push('files must be {path, role} entries');
  if (!Array.isArray(r.implementation_sources) || !r.implementation_sources.every((s: any) => s && typeof s.path === 'string' && /^[0-9a-f]{64}$/.test(s.sha256 ?? ''))) issues.push('invalid implementation snapshot');
  if (!Array.isArray(r.evidence)) issues.push('evidence must be a list');
  for (const rel of [...(strArr(r.supersedes) ? r.supersedes : []), ...(strArr(r.conflicts_with) ? r.conflicts_with : [])])
    if (!allIds.has(rel)) issues.push(`unknown related decision ${rel}`);
  if (issues.length) return { issues, notes };

  const evidence: store.NativeEvidence[] = [];
  for (const e of r.evidence) {
    for (const k of Object.keys(e)) if (!KNOWN_EVIDENCE.has(k)) issues.push(`evidence field "${k}" has no native equivalent`);
    if (!(store.EVIDENCE_TYPES as readonly string[]).includes(e.type)) { issues.push(`invalid evidence type ${e.type}`); continue; }
    if (e.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(e.sha256)) { issues.push(`invalid evidence sha256 ${e.ref}`); continue; }
    const m = typeof e.ref === 'string' ? REF_RE.exec(e.ref) : null;
    if (!m) { issues.push(`invalid evidence ref ${e.ref}`); continue; }
    const startLine = m[2] ? Number(m[2]) : undefined, endLine = m[3] ? Number(m[3]) : startLine;
    if (startLine !== undefined && (startLine < 1 || (endLine ?? startLine) < startLine)) { issues.push(`invalid line range in ${e.ref}`); continue; }
    if (m[1].startsWith('@')) notes.push(`evidence ${e.ref} points outside the checkout: the native engine reports it UNKNOWN (dk.py could read it via PNMG_ECO_CSV)`);
    const note = typeof e.note === 'string' ? e.note : undefined;
    const ev: store.NativeEvidence = { type: e.type, path: m[1], ...(startLine ? { startLine } : {}), ...(endLine && startLine ? { endLine } : {}),
      ...(e.sha256 ? { sha256: e.sha256 } : {}), ...(note !== undefined ? { note } : {}),
      ...(note?.startsWith('CANDIDATE IMPACT ONLY:') ? { candidateOnly: true } : {}),
      ...(e.relation ? { relation: String(e.relation) } : {}), ...(e.approval_scope ? { approvalScope: String(e.approval_scope) } : {}),
      ...(e.approved_rule ? { approvedRule: String(e.approved_rule) } : {}) };
    evidence.push(ev);
  }
  if (issues.length) return { issues, notes };

  const created = await firstCommitDate(root, lr.file);
  const files = r.files.map((f: any) => ({ path: String(f.path), role: String(f.role ?? '') }));
  const decision = {
    id, title: r.title.trim() || r.title, claim: r.claim.trim(), scope: r.scope, systems: typeof r.system === 'string' && r.system ? [r.system] : [],
    files: [...new Set<string>(files.map((f: any) => f.path))], evidence, conflictsWith: r.conflicts_with, supersedes: r.supersedes,
    origin: 'legacy' as const, status: 'proposed' as const, createdAt: created ?? EPOCH, updatedAt: created ?? EPOCH,
    legacy: {
      sourceRecord: lr.file, sourceRecordSha256: lr.sha256, createdAtKnown: !!created,
      decisionState: r.decision_state, approvalState: r.approval_state, implementationState: r.implementation_state,
      implementationSources: r.implementation_sources.map((s: any) => ({ path: String(s.path), sha256: s.sha256 })),
      files, tests: r.tests, qps: r.qps, tags: r.tags,
    },
  };
  const parsed = store.decisionSchema.safeParse(decision);
  if (!parsed.success) return { issues: [`does not fit the native schema: ${parsed.error.issues[0]?.path?.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim()], notes };
  if (!created) notes.push('creation date unknown (record not committed); the epoch is stored with createdAtKnown=false');
  return { decision: parsed.data, issues, notes };
}

export interface Resolution { [id: string]: 'keep-native' | 'take-legacy' }

/** Read-only preview of the migration. */
export async function plan(project: Project, resolutions: Resolution = {}): Promise<Plan> {
  const root = project.path;
  const file = join(root, store.DECISIONS_FILE);
  const empty = (state: Plan['state'], reason: string | undefined, target: Plan['target'], extra: Partial<Plan> = {}): Plan => ({
    state, reason, target, records: [], inventory: { found: 0, unreadable: 0, add: 0, equivalent: 0, divergent: 0, duplicate: 0, blocked: 0 },
    unreadable: [], planSha256: null, divergent: [], ...extra });
  const cur = await store.readDecisions(root);
  const target = { file: store.DECISIONS_FILE, state: cur.state, sha256: cur.sha256 ?? null };
  const { records, issues: unreadable } = readLegacyRecords(root);
  if (!records.length && !unreadable.length) return empty('no-legacy', `No legacy records in ${LEGACY_RECORDS_REL}`, target);
  if (cur.state === 'invalid' || cur.state === 'incompatible') return empty('blocked', `The existing native file is ${cur.state}: ${cur.reason}`, target, { unreadable });

  const ids = new Set(records.map(r => String(r.record.id)));
  const seen = new Set<string>(), existing = cur.doc?.decisions ?? [];
  const byClaim = new Map(existing.map(d => [store.sha256(d.claim), d]));
  const out: RecordPlan[] = [], additions: store.NativeDecision[] = [], replacements = new Map<string, store.NativeDecision>();
  const divergent: Plan['divergent'] = [];
  for (const lr of records) {
    const id = String(lr.record.id);
    const base = { id, sourceRecord: lr.file, sourceSha256: lr.sha256 };
    if (seen.has(id)) { out.push({ ...base, outcome: 'blocked', issues: ['duplicate id among legacy records'], notes: [] }); continue; }
    seen.add(id);
    const c = await convert(root, lr, ids);
    if (!c.decision) { out.push({ ...base, outcome: 'blocked', issues: c.issues, notes: c.notes }); continue; }
    const d = c.decision, ex = existing.find(x => x.id === d.id);
    if (ex) {
      if (canonical(ex) === canonical(d)) { out.push({ ...base, outcome: 'equivalent', issues: [], notes: c.notes }); continue; }
      const choice = resolutions[d.id];
      if (choice === 'keep-native') { out.push({ ...base, outcome: 'equivalent', issues: [], notes: [...c.notes, 'differs from the native decision; the caller chose to keep the native one'] }); continue; }
      if (choice === 'take-legacy') { replacements.set(d.id, d); out.push({ ...base, outcome: 'add', issues: [], notes: [...c.notes, 'REPLACES the native decision of the same id by explicit choice (the previous file is backed up)'] }); continue; }
      divergent.push({ id: d.id, native: ex, legacy: d });
      out.push({ ...base, outcome: 'divergent', issues: ['a native decision with this id already exists with different content; both sides are kept apart, nothing is overwritten'], notes: c.notes });
      continue;
    }
    const dup = byClaim.get(store.sha256(d.claim));
    if (dup) { out.push({ ...base, outcome: 'duplicate', issues: [`the same claim text is already native decision ${dup.id}; not duplicated`], notes: c.notes }); continue; }
    additions.push(d);
    out.push({ ...base, outcome: 'add', issues: [], notes: c.notes });
  }
  const count = (o: Outcome) => out.filter(r => r.outcome === o).length;
  const inventory = { found: records.length + unreadable.length, unreadable: unreadable.length, add: count('add'), equivalent: count('equivalent'), divergent: count('divergent'), duplicate: count('duplicate'), blocked: count('blocked') };
  const base: Plan = { state: 'ready', target, records: out, inventory, unreadable, planSha256: null, divergent };
  if (inventory.blocked || inventory.divergent || inventory.duplicate || unreadable.length)
    return { ...base, state: 'blocked', reason: 'Some records cannot be migrated as they are; nothing will be written until they are resolved' };
  if (!additions.length && !replacements.size) return { ...base, state: 'nothing-to-do', planSha256: cur.sha256 ?? null };
  let roots: string[];
  try { roots = await store.historyRoots(root); } catch (e: any) { return { ...base, state: 'blocked', reason: e.message }; }
  const next = [...existing.map(d => replacements.get(d.id) ?? d), ...additions];
  const doc = store.decisionsSchema.safeParse({ version: 1, gitRoots: cur.doc?.gitRoots ?? roots, decisions: next });
  if (!doc.success) return { ...base, state: 'blocked', reason: `The resulting file would be invalid: ${doc.error.issues[0]?.message}` };
  return { ...base, doc: doc.data, planSha256: store.sha256(JSON.stringify(doc.data, null, 2)) };
}

const manifestDir = (projectId: string) => join(DATA_DIR, 'design-migration', projectId.replace(/[^a-zA-Z0-9_-]/g, '_'));

export interface Manifest {
  id: string; projectId: string; appliedAt: string; target: string; previousSha256: string | null; previousCopy: string | null;
  resultSha256: string; records: { id: string; sourceRecord: string; sourceSha256: string }[]; legacyFilesTouched: false;
  rollback: string;
}

/**
 * Write the migrated file. `expectedPlanSha256` must be the `planSha256` of the preview the caller reviewed; the
 * plan is recomputed and any drift (a record or the target changed since the preview) refuses the write.
 */
export async function apply(project: Project, input: { expectedPlanSha256: string; resolutions?: Resolution }) {
  return store.withLock(async () => {
    const p = await plan(project, input.resolutions ?? {});
    if (p.state === 'no-legacy') return { ok: false as const, error: p.reason!, plan: p };
    if (p.state === 'blocked') return { ok: false as const, error: p.reason!, plan: p };
    if (p.state === 'nothing-to-do') return { ok: true as const, changed: false as const, plan: p };
    if (!input.expectedPlanSha256 || input.expectedPlanSha256 !== p.planSha256)
      return { ok: false as const, error: 'The preview is out of date (a record or the decisions file changed); review the new preview', plan: p };
    const target = join(project.path, store.DECISIONS_FILE);
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${p.planSha256!.slice(0, 8)}`;
    const dir = join(manifestDir(project.id), id);
    await fs.mkdir(dir, { recursive: true });
    let previousCopy: string | null = null;
    if (p.target.state === 'present') { previousCopy = 'previous-decisions.json'; await fs.copyFile(target, join(dir, previousCopy)); }
    const manifest: Manifest = {
      id, projectId: project.id, appliedAt: new Date().toISOString(), target: store.DECISIONS_FILE, previousSha256: p.target.sha256, previousCopy,
      resultSha256: p.planSha256!, legacyFilesTouched: false,
      records: p.records.filter(r => r.outcome === 'add').map(r => ({ id: r.id, sourceRecord: r.sourceRecord, sourceSha256: r.sourceSha256 })),
      rollback: previousCopy ? `Restore ${previousCopy} over ${store.DECISIONS_FILE} (verified by sha256)` : `Delete ${store.DECISIONS_FILE} (it did not exist before)`,
    };
    await writeJsonAtomic(join(dir, 'manifest.json'), manifest);
    await writeJsonAtomic(target, p.doc);
    const written = store.sha256(await fs.readFile(target));
    if (written !== p.planSha256) return { ok: false as const, error: 'Written file does not match the plan; roll back with the manifest', manifest, plan: p };
    core.notifyDecisionsChanged();
    return { ok: true as const, changed: true as const, manifest, manifestPath: join(dir, 'manifest.json'), plan: p };
  });
}

/** Undo `apply`: only while the file is still exactly what apply wrote (later edits are never overwritten). */
export async function rollback(project: Project, manifestId: string) {
  return store.withLock(async () => {
    if (!/^[\w-]+$/.test(manifestId)) return { ok: false as const, error: 'Invalid manifest id' };
    const dir = join(manifestDir(project.id), manifestId);
    let m: Manifest;
    try { m = JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8')); } catch { return { ok: false as const, error: 'Manifest not found' }; }
    const target = join(project.path, store.DECISIONS_FILE);
    let current: string | null = null;
    try { current = store.sha256(await fs.readFile(target)); } catch { /* absent */ }
    if (current !== m.resultSha256) return { ok: false as const, error: 'The decisions file changed after the migration; rolling back would discard those edits. Restore it by hand from the manifest copy.' };
    if (m.previousCopy) {
      const prev = await fs.readFile(join(dir, m.previousCopy));
      if (store.sha256(prev) !== m.previousSha256) return { ok: false as const, error: 'The backup copy is corrupt' };
      await fs.writeFile(target, prev);
    } else await fs.unlink(target);
    core.notifyDecisionsChanged();
    return { ok: true as const, restored: m.previousCopy ? 'previous file' : 'file removed' };
  });
}
