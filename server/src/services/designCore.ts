import * as legacy from './designKnowledge.js';
const norm_ = legacy.norm;
import * as store from './designDecisions.js';
import { readLegacyRecords } from './legacyRecords.js';
import { parseExternalRef, resolveExternal } from './designSources.js';

/**
 * Design Knowledge Core — the one contract the Inspector, System Explorer, routes and MCP consume.
 *
 * One source: the native `jabutistudio.decisions.json` in the game repo. This app owns the engine; there is no
 * Python and no per-game tooling. The legacy dk.py registry of PNMG was migrated (R1-B2) and retired (R1-B3):
 * legacy records still lying around are reported as unmigrated, never read through another engine.
 *
 * Trust vocabulary, never collapsed:
 *   approval.state "unknown"  — nobody confirmed anything;
 *   approval.state "claimed"  — a document or record asserts a human decided (unverified);
 *   approval.source "attested_local" — a local UI attestation; NOT proof of who clicked.
 * `evidence_status` CURRENT never means approved; a proposal is never promoted automatically.
 * Field names stay snake_case so existing UI/MCP consumers keep working.
 */

export type Json = Record<string, any>;
export interface Project { id: string; path: string }
export interface QueryOpts { file?: string; q?: string; id?: string; system?: string; worktree?: string; revision?: string }

const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'how', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'what', 'which', 'with', 'qual', 'quais', 'que', 'como', 'e', 'de', 'da', 'do', 'dos', 'das', 'em', 'no', 'na', 'os', 'um', 'uma', 'para', 'por', 'sobre']);
const words = (s: string, dropStop = false) => new Set(s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9_]+/g)?.filter(w => w.length > 1 && !(dropStop && STOP.has(w))) ?? []);

async function nativeDecisions(project: Project, root: string, revision?: string) {
  const read = await store.readDecisions(root, revision);
  const out: Json[] = [];
  if (read.state !== 'present' || !read.doc) return { read, decisions: out };
  const ledger = await legacy.readLedger(project.id);
  // External files (@name:key) are machine-local configuration: they are never part of a revision.
  const reader = store.makeReader(root, revision, revision ? undefined : async ev => {
    const ref = parseExternalRef(ev.path);
    if (!ref) return { freshness: 'UNKNOWN' as const, detail: 'malformed external reference', external: { source: ev.path, key: '', status: 'unsupported' }, excerpt: [] };
    return resolveExternal(project.id, ref, ev.sha256);
  });
  const integration = await store.fileIntegration(root, norm_(root) === norm_(project.path), revision);
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
    if (att && att.claim_sha256 === claimSha && (att.state === 'approved' || att.state === 'rejected')) approval = { state: att.state, source: 'attested_local', at: att.at, quote: att.quote };
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
      record_integration: integration,
      files: lg ? lg.files : d.files.map(path => ({ role: 'declared', path })),
      tests: lg ? lg.tests.map(path => ({ path, direct: cited.has(path) })) : d.evidence.filter(e => e.type === 'test').map(e => ({ path: e.path, direct: true })),
      qps: lg ? lg.qps.map(path => ({ path, direct: cited.has(path) })) : [], tags: lg ? lg.tags : [],
      implementation_sources: lg ? lg.implementationSources.map(s => s.path) : [],
      evidence: evidence.map(e => ({ type: e.type, ref: e.ref, note: e.note, candidate_only: !!e.candidateOnly, freshness: e.freshness, detail: e.detail,
        external: e.external, path: e.resolvedPath ?? null, lines: e.freshness === 'MOVED' && e.excerpt.length ? [e.excerpt[0].line, e.excerpt[e.excerpt.length - 1].line] : e.startLine ? [e.startLine, e.endLine ?? e.startLine] : null, excerpt: e.excerpt })),
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
  const { read, decisions: native } = await nativeDecisions(project, root, opts.revision);
  const limitations: string[] = [];
  if (opts.revision && read.state === 'absent') limitations.push(`Revision ${opts.revision} has no ${store.DECISIONS_FILE}: the project had no native Design Knowledge then. Nothing was inferred from the working tree.`);
  if (!opts.revision) {
    // Records of the retired dk.py engine are never read here; say so when some were not migrated yet.
    const nativeIds = new Set(native.map(d => d.id));
    const unmigrated = readLegacyRecords(project.path).records.map(r => String(r.record.id)).filter(id => !nativeIds.has(id));
    if (unmigrated.length) limitations.push(`${unmigrated.length} legacy Design Knowledge record(s) are not in the native file and were not read (${unmigrated.slice(0, 5).join(', ')}); run the migration (design/migration).`);
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
  const decisions = picked;
  const ids = new Set(decisions.map(d => d.id));
  const pairs = new Map<string, { ids: string[] }>();
  for (const d of decisions) for (const c of d.conflicts_with ?? []) {
    if (ids.has(c)) { const pair = [d.id, c].sort(); pairs.set(pair.join('|'), { ids: pair }); }
  }
  const conflicts = [...pairs.values()];
  const sources = { native: { state: read.state, reason: read.reason, sha256: read.sha256, count: native.length } };
  const available = read.state === 'present' || read.state === 'absent';
  return {
    available, reason: available ? undefined : `Native decisions are ${read.state}: ${read.reason}`, decisions, conflicts, sources, limitations,
    graph: opts.file ? await legacy.graphRelations(project.id, opts.file) : undefined, branch: await store.gitBranch(root), head: await store.gitHead(root),
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

/**
 * Every native decision of a checkout, unfiltered: the project-wide review queue reads the same records as the
 * per-file panel (one source, nothing copied). Read-only.
 */
export async function listDecisions(project: Project, opts: { worktree?: string } = {}) {
  const root = await legacy.resolveRoot(project, opts.worktree);
  if (typeof root !== 'string') return { available: false as const, reason: root.error, decisions: [] as Json[] };
  const { read, decisions } = await nativeDecisions(project, root);
  const available = read.state === 'present' || read.state === 'absent';
  return { available, state: read.state, reason: read.reason, decisions };
}

/**
 * Local attestation of a native or legacy decision. The route must restrict this to the app's own UI.
 * `expectedClaimSha256` is the hash of the claim the person was looking at: if the decision was edited or replaced
 * since, nothing is written and the caller gets `claim-changed` (never an approval of a different text).
 */
export async function attest(project: Project, input: { decisionId: string; state: legacy.AttestState; quote: string; expectedClaimSha256?: string }) {
  const quote = input.quote.trim();
  if (quote.length < 3) return { ok: false as const, error: 'A quote of what was decided is required' };
  const { read, decisions } = await nativeDecisions(project, project.path);
  const found = decisions.find(d => d.id === input.decisionId);
  if (!found) return { ok: false as const, error: `Decision ${input.decisionId} is not in the native decisions file` };
  if (read.state !== 'present') return { ok: false as const, error: 'Native decisions are not readable' };
  if (input.expectedClaimSha256 !== undefined && input.expectedClaimSha256 !== found.claim_sha256) {
    return { ok: false as const, code: 'claim-changed' as const, error: `Decision ${input.decisionId} changed since it was shown; reload the review before attesting` };
  }
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
