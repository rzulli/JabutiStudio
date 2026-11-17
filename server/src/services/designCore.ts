import * as legacy from './designKnowledge.js';
import * as store from './designDecisions.js';
import { readLegacyRecords } from './legacyRecords.js';

/**
 * Design Knowledge Core — the one contract the Inspector, System Explorer, routes and MCP consume.
 *
 * Two sources feed it, behind the same `Decision` shape:
 *   native  — `jabutistudio.decisions.json` in the game repo (this app owns the engine; no Python);
 *   legacy  — a project's own dk.py registry (PNMG), read through designKnowledge.ts. Temporary: it is
 *             removed when R1-B3 retires dk.py. Legacy records are never converted or rewritten.
 *
 * Trust vocabulary, never collapsed:
 *   approval.state "unknown"  — nobody confirmed anything;
 *   approval.state "claimed"  — a document or record asserts a human decided (unverified);
 *   approval.source "attested_local" — a local UI attestation; NOT proof of who clicked.
 * `evidence_status` CURRENT never means approved; a proposal is never promoted automatically.
 * Field names stay snake_case (the legacy dk.py shape) so existing UI/MCP consumers keep working.
 */

export type Json = Record<string, any>;
export interface Project { id: string; path: string }
export interface QueryOpts { file?: string; q?: string; id?: string; system?: string; worktree?: string; revision?: string; nativeOnly?: boolean }

const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'how', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'what', 'which', 'with', 'qual', 'quais', 'que', 'como', 'e', 'de', 'da', 'do', 'dos', 'das', 'em', 'no', 'na', 'os', 'um', 'uma', 'para', 'por', 'sobre']);
const words = (s: string, dropStop = false) => new Set(s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9_]+/g)?.filter(w => w.length > 1 && !(dropStop && STOP.has(w))) ?? []);

async function nativeDecisions(project: Project, root: string, revision?: string) {
  const read = await store.readDecisions(root, revision);
  const out: Json[] = [];
  if (read.state !== 'present' || !read.doc) return { read, decisions: out };
  const ledger = await legacy.readLedger(project.id);
  const reader = store.makeReader(root, revision);
  const inverse = new Map<string, string[]>();
  for (const d of read.doc.decisions) for (const c of d.conflictsWith) inverse.set(c, [...(inverse.get(c) ?? []), d.id]);
  for (const d of read.doc.decisions) {
    const evidence = await Promise.all(d.evidence.map(e => store.resolveEvidence(reader, e)));
    const claimSha = store.sha256(d.claim);
    const att = ledger.approvals.find(a => a.decision_id === d.id);
    const lg = d.legacy;
    // A migrated record's own words ("approved", a human_decision citation) are an unverified claim, never approval.
    const claimsApproval = !!lg && (['approved', 'rejected', 'revoked'].includes(lg.approvalState) || ['approved', 'superseded', 'rejected'].includes(lg.decisionState));
    let approval: Json = { state: 'unknown', source: 'none' };
    if (att && att.claim_sha256 === claimSha && (att.state === 'approved' || att.state === 'rejected')) approval = { state: att.state, source: 'attested_local', at: att.at };
    else if (att && att.claim_sha256 !== claimSha) approval = lg ? { state: 'claimed', source: 'attestation-lapsed', lapsed: true } : { state: 'unknown', source: 'none', lapsed: true };
    else if (claimsApproval || d.evidence.some(e => e.type === 'human_decision')) approval = { state: 'claimed', source: lg ? 'repository-claim' : 'native-file' };
    const codeEv = evidence.filter(e => e.type === 'code' && e.needle);
    let implementation = !codeEv.length ? 'unknown'
      : codeEv.some(e => e.freshness === 'STALE' || e.freshness === 'GONE') ? 'divergent' : 'implemented';
    if (lg) {
      // Same rule as dk.py: the catalogued classification only stands while every recorded code snapshot still matches.
      let intact = true;
      for (const s of lg.implementationSources) { const c = await reader.read(s.path); if (c === null || store.sha256(c) !== s.sha256) { intact = false; break; } }
      implementation = intact ? lg.implementationState : 'unknown';
    }
    const decisionState = approval.source === 'attested_local' && !lg ? (approval.state === 'approved' ? 'approved' : 'rejected')
      : lg ? (['approved', 'superseded', 'rejected'].includes(lg.decisionState) ? 'unknown' : lg.decisionState)
      : d.status === 'withdrawn' ? 'rejected' : 'hypothesis';
    // dk.py also judges the recorded implementation snapshots when it aggregates evidence freshness.
    const implRows = lg ? await Promise.all(lg.implementationSources.map(x => store.resolveEvidence(reader, { type: 'code', path: x.path, sha256: x.sha256 }))) : [];
    const cited = new Set(d.evidence.filter(e => !e.candidateOnly).map(e => e.path));
    out.push({
      id: d.id, title: d.title, claim: d.claim, claim_sha256: claimSha, source: 'native',
      system: d.systems[0] ?? null, systems: d.systems, scope: d.scope, decision_state: decisionState, approval,
      evidence_status: store.worstFreshness([...evidence, ...implRows]), evidence_status_legacy: legacyEvidenceStatus([...evidence, ...implRows].map(e => e.freshness)), implementation, catalogued_implementation: lg ? lg.implementationState : implementation,
      supersedes: d.supersedes, conflicts_with: [...new Set([...d.conflictsWith, ...(inverse.get(d.id) ?? [])])],
      record_integration: revision ? 'revision' : 'working-tree',
      files: lg ? lg.files : d.files.map(path => ({ role: 'declared', path })),
      tests: lg ? lg.tests.map(path => ({ path, direct: cited.has(path) })) : d.evidence.filter(e => e.type === 'test').map(e => ({ path: e.path, direct: true })),
      qps: lg ? lg.qps.map(path => ({ path, direct: cited.has(path) })) : [], tags: lg ? lg.tags : [],
      implementation_sources: lg ? lg.implementationSources.map(s => s.path) : [],
      evidence: evidence.map(e => ({ type: e.type, ref: e.ref, note: e.note, candidate_only: !!e.candidateOnly, freshness: e.freshness, detail: e.detail,
        path: e.resolvedPath ?? null, lines: e.freshness === 'MOVED' && e.excerpt.length ? [e.excerpt[0].line, e.excerpt[e.excerpt.length - 1].line] : e.startLine ? [e.startLine, e.endLine ?? e.startLine] : null, excerpt: e.excerpt })),
      provenance: lg
        ? { origin: 'legacy-migration', createdAt: d.createdAt, createdAtKnown: lg.createdAtKnown, status: d.status, sourceRecord: lg.sourceRecord, sourceRecordSha256: lg.sourceRecordSha256 }
        : { origin: d.origin, createdAt: d.createdAt, status: d.status },
    });
  }
  return { read, decisions: out };
}

function matches(d: Json, o: QueryOpts): string | null {
  if (o.id) return d.id === o.id ? 'id' : null;
  if (o.system) return (d.systems ?? [d.system]).includes(o.system) ? 'system' : null;
  if (o.file) {
    const f = o.file.replace(/\\/g, '/').replace(/^\.\//, '');
    const impact = [...(d.files ?? []), ...(d.tests ?? []), ...(d.qps ?? [])].some((x: Json) => x.path === f);
    return impact || (d.implementation_sources ?? []).includes(f) || d.evidence.some((e: Json) => (e.path ?? e.ref.split('#')[0]) === f || e.ref.split('#')[0] === f) ? 'file' : null;
  }
  if (o.q) {
    // Same rule as the legacy selector: stop words dropped, at least min(2, terms) of the query words present
    // (exact or prefix) — so a natural-language question still finds its records.
    const q = words(o.q, true), hay = words([d.id, d.title, d.claim, ...(d.scope ?? []), ...(d.tags ?? [])].join(' '));
    if (!q.size) return null;
    const exact = d.provenance?.origin === 'legacy-migration'; // dk.py compares whole words; prefixes are only for native records
    const overlap = [...q].filter(w => hay.has(w) || (!exact && [...hay].some(h => h.startsWith(w)))).length;
    return overlap >= Math.min(2, q.size) ? 'text' : null;
  }
  return null;
}

/**
 * Query decisions from every available source, judged in the requested checkout (and revision for native
 * decisions). A project with no decisions, no Python and no legacy registry still answers: `decisions: []`.
 */
export async function query(project: Project, opts: QueryOpts) {
  const root = await legacy.resolveRoot(project, opts.worktree);
  if (typeof root !== 'string') return { available: false as const, reason: root.error } as Json;
  const [{ read, decisions: native }, hasLegacy] = [await nativeDecisions(project, root, opts.revision), legacy.hasRegistry(project.path)];
  let legacyRes: Json = { available: false, reason: 'No legacy Design Knowledge registry' };
  const limitations: string[] = [];
  // Source selection. Legacy records already present in the native file (a migrated project) are never asked of
  // dk.py again — that would show every decision twice. `nativeOnly` (or SHIPYARD_DK_NATIVE_ONLY=1) forces the
  // native engine alone, even for a project that is only partly migrated, and says what it left unread.
  const nativeIds = new Set(native.map(d => d.id));
  const legacyIds = hasLegacy ? readLegacyRecords(project.path).records.map(r => String(r.record.id)) : [];
  const unmigrated = legacyIds.filter(id => !nativeIds.has(id));
  const forceNative = !!opts.nativeOnly || process.env.SHIPYARD_DK_NATIVE_ONLY === '1';
  const migrated = hasLegacy && legacyIds.length > 0 && unmigrated.length === 0;
  const useLegacy = hasLegacy && !opts.system && !forceNative && !migrated;
  if (hasLegacy && !useLegacy) {
    legacyRes = { available: false, skipped: true, migrated,
      reason: migrated ? 'All legacy records are in the native file; dk.py was not consulted'
        : forceNative ? 'Native-only mode; dk.py was not consulted' : legacyRes.reason };
    if (forceNative && unmigrated.length) limitations.push(`Native-only mode: ${unmigrated.length} legacy record(s) are not migrated and were not read (${unmigrated.slice(0, 5).join(', ')}).`);
  }
  if (useLegacy) {
    if (opts.revision) limitations.push('The legacy registry is read from the checkout, not from a revision.');
    const arg = opts.file ? await legacy.contextForFile(project, opts.file, opts.worktree)
      : opts.id ? await legacy.contextForQuery(project, opts.id, opts.worktree)
      : opts.q ? await legacy.contextForQuery(project, opts.q, opts.worktree) : legacyRes;
    legacyRes = arg as Json;
  }
  const picked: Json[] = [];
  for (const d of native) { const by = matches(d, opts); if (by) picked.push({ ...d, matched_by: d.matched_by ?? by }); }
  if (opts.q || opts.file) {
    // Contradictions and supersessions travel with a hit (as in the legacy selector): never show one side alone.
    const have = new Set(picked.map(d => d.id));
    for (const d of [...picked]) for (const rel of [...(d.conflicts_with ?? []), ...(d.supersedes ?? [])]) {
      const other = native.find(n => n.id === rel);
      if (other && !have.has(rel)) { have.add(rel); picked.push({ ...other, matched_by: 'linked' }); }
    }
  }
  const legacyDecisions: Json[] = (legacyRes.available ? legacyRes.decisions ?? [] : [])
    .filter((d: Json) => !opts.id || d.id === opts.id)
    .map((d: Json) => ({ ...d, source: 'legacy', systems: d.system ? [d.system] : [], provenance: { origin: 'legacy-registry' } }));
  const seen = new Set(picked.map(d => d.id));
  for (const d of legacyDecisions) {
    if (seen.has(d.id)) { limitations.push(`Decision id ${d.id} exists in both sources; the native entry is shown.`); continue; }
    picked.push(d);
  }
  const decisions = picked;
  const ids = new Set(decisions.map(d => d.id));
  const pairs = new Map<string, { ids: string[] }>();
  for (const d of decisions) for (const c of d.conflicts_with ?? []) {
    if (ids.has(c)) { const pair = [d.id, c].sort(); pairs.set(pair.join('|'), { ids: pair }); }
  }
  const conflicts = [...pairs.values()];
  const sources = {
    native: { state: read.state, reason: read.reason, sha256: read.sha256, count: native.length },
    legacy: { available: !!legacyRes.available, skipped: !!legacyRes.skipped, migrated: !!legacyRes.migrated, reason: legacyRes.available ? undefined : legacyRes.reason },
  };
  const available = read.state === 'present' || !!legacyRes.available || read.state === 'absent';
  return {
    available, reason: available ? undefined : 'No usable source of decisions', decisions, conflicts, sources, limitations,
    indexed: legacyRes.indexed, note: legacyRes.note,
    graph: opts.file ? await legacy.graphRelations(project.id, opts.file) : undefined, branch: legacyRes.branch ?? await store.gitBranch(root), head: legacyRes.head ?? await store.gitHead(root),
    examined: { root, isCanonical: legacy.norm(root) === legacy.norm(project.path), registry: project.path, revision: opts.revision },
  } as Json;
}

/** Decisions for a system: by declared id, plus anchor terms and decision ids it already lists. */
export async function forSystem(project: Project, system: { id: string; anchors: { terms: string[]; decisions: string[] } }, worktree?: string) {
  const byId = new Map<string, Json>();
  let reason: string | undefined, available = false;
  const jobs = [query(project, { system: system.id, worktree }), ...[...new Set([...system.anchors.terms, ...system.anchors.decisions])].map(q => query(project, { q, worktree }))];
  for (const r of await Promise.all(jobs)) {
    if (r.available) available = true; else reason = r.reason;
    for (const d of r.decisions ?? []) byId.set(d.id, d);
  }
  return { available, reason, decisions: [...byId.values()] };
}

const listeners: (() => void)[] = [];
/** Derived views (system catalog) subscribe so a new proposal shows up at once instead of after their TTL. */
export const onDecisionsChanged = (fn: () => void) => { listeners.push(fn); };

export async function propose(project: Project, input: store.ProposalInput) {
  const res = await store.addProposal(project.path, input, async id => {
    const r = await query(project, { id });
    return !!r.decisions?.some((d: Json) => d.id === id);
  });
  if (res.ok) listeners.forEach(fn => fn());
  return res;
}

/** Local attestation of a native or legacy decision. The route must restrict this to the app's own UI. */
export async function attest(project: Project, input: { decisionId: string; state: legacy.AttestState; quote: string }) {
  const quote = input.quote.trim();
  if (quote.length < 3) return { ok: false as const, error: 'A quote of what was decided is required' };
  const { read, decisions } = await nativeDecisions(project, project.path);
  const found = decisions.find(d => d.id === input.decisionId);
  if (!found) {
    if (process.env.SHIPYARD_DK_NATIVE_ONLY === '1') return { ok: false as const, error: `Decision ${input.decisionId} is not in the native file (native-only mode)` };
    return legacy.attest(project, input);
  }
  if (read.state !== 'present') return { ok: false as const, error: 'Native decisions are not readable' };
  const entry = { decision_id: input.decisionId, state: input.state, claim_sha256: found.claim_sha256, quote,
    channel: 'ui-request', trust: 'attested_local', at: new Date().toISOString(), projectId: project.id };
  await legacy.recordAttestation(project, entry);
  listeners.forEach(fn => fn());
  return { ok: true as const, entry };
}

export const notifyDecisionsChanged = () => listeners.forEach(fn => fn());

/** Legacy-vocabulary aggregate (dk.py `evidence_status`): MISSING beats STALE beats UNKNOWN; MOVED still counts as current. */
export function legacyEvidenceStatus(states: string[]): 'CURRENT' | 'STALE' | 'MISSING' | 'UNKNOWN' {
  if (!states.length) return 'UNKNOWN';
  if (states.includes('GONE')) return 'MISSING';
  if (states.some(s => s === 'CHANGED' || s === 'AMBIGUOUS' || s === 'STALE')) return 'STALE';
  return states.includes('UNKNOWN') ? 'UNKNOWN' : 'CURRENT';
}

/**
 * Registry validation by the native engine alone (the counterpart of `dk.py validate`): schema errors block,
 * drifting evidence only warns. Needs neither Python nor `docs/design_knowledge`.
 */
export async function validateNative(project: Project, worktree?: string): Promise<Json> {
  const root = await legacy.resolveRoot(project, worktree);
  if (typeof root !== 'string') return { available: false, reason: root.error };
  const read = await store.readDecisions(root);
  if (read.state === 'absent') return { available: false, engine: 'native', reason: 'No native decisions file' };
  if (read.state !== 'present' || !read.doc) return { available: true, engine: 'native', valid: false, records: 0, errors: [`decisions file is ${read.state}: ${read.reason}`], warnings: [], unresolved_conflicts: [], evidence_statuses: {} };
  const { decisions } = await nativeDecisions(project, root);
  const ids = new Set(read.doc.decisions.map(d => d.id));
  const errors: string[] = [], warnings: string[] = [];
  for (const d of read.doc.decisions) {
    for (const r of [...d.conflictsWith, ...d.supersedes]) if (!ids.has(r)) errors.push(`${d.id}: unknown related decision ${r}`);
    for (const c of d.conflictsWith) {
      const other = read.doc.decisions.find(x => x.id === c);
      if (other && !other.conflictsWith.includes(d.id)) warnings.push(`${d.id}: conflict with ${c} is declared on one side only (the inverse is derived)`);
    }
    if (d.legacy && (['approved', 'rejected', 'revoked'].includes(d.legacy.approvalState) || ['approved', 'superseded', 'rejected'].includes(d.legacy.decisionState))
      && !decisions.find(x => x.id === d.id)?.approval.source.startsWith('attested'))
      warnings.push(`${d.id}: the legacy record asserts an approval that no local attestation backs; it is shown as "claimed"`);
  }
  for (const d of decisions) for (const e of d.evidence) {
    if (['GONE', 'CHANGED', 'AMBIGUOUS', 'STALE'].includes(e.freshness)) warnings.push(`${d.id}: evidence ${e.ref} is ${e.freshness}: ${e.detail}`);
  }
  const pairs = new Set<string>();
  for (const d of decisions) for (const c of d.conflicts_with) pairs.add([d.id, c].sort().join('|'));
  const statuses: Record<string, number> = { CURRENT: 0, STALE: 0, MISSING: 0, UNKNOWN: 0 };
  for (const d of decisions) statuses[legacyEvidenceStatus(d.evidence.map((e: Json) => e.freshness))]++;
  return { available: true, engine: 'native', valid: !errors.length, records: decisions.length, errors, warnings,
    unresolved_conflicts: [...pairs].map(p => p.split('|')), evidence_statuses: statuses };
}
