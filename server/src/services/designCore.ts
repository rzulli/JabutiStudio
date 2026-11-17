import * as legacy from './designKnowledge.js';
import * as store from './designDecisions.js';

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
export interface QueryOpts { file?: string; q?: string; id?: string; system?: string; worktree?: string; revision?: string }

const words = (s: string) => new Set(s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9_]+/g)?.filter(w => w.length > 1) ?? []);

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
    let approval: Json = { state: 'unknown', source: 'none' };
    if (att && att.claim_sha256 === claimSha && (att.state === 'approved' || att.state === 'rejected')) approval = { state: att.state, source: 'attested_local', at: att.at };
    else if (att && att.claim_sha256 !== claimSha) approval = { state: 'unknown', source: 'none', lapsed: true };
    else if (d.evidence.some(e => e.type === 'human_decision')) approval = { state: 'claimed', source: 'native-file' };
    const codeEv = evidence.filter(e => e.type === 'code' && e.needle);
    const implementation = !codeEv.length ? 'unknown'
      : codeEv.some(e => e.freshness === 'STALE' || e.freshness === 'GONE') ? 'divergent' : 'implemented';
    const decisionState = approval.source === 'attested_local' ? (approval.state === 'approved' ? 'approved' : 'rejected')
      : d.status === 'withdrawn' ? 'rejected' : 'hypothesis';
    out.push({
      id: d.id, title: d.title, claim: d.claim, claim_sha256: claimSha, source: 'native',
      system: d.systems[0] ?? null, systems: d.systems, scope: d.scope, decision_state: decisionState, approval,
      evidence_status: store.worstFreshness(evidence), implementation, catalogued_implementation: implementation,
      supersedes: d.supersedes, conflicts_with: [...new Set([...d.conflictsWith, ...(inverse.get(d.id) ?? [])])],
      record_integration: revision ? 'revision' : 'working-tree',
      files: d.files.map(path => ({ role: 'declared', path })), tests: d.evidence.filter(e => e.type === 'test').map(e => ({ path: e.path, direct: true })),
      qps: [], tags: [],
      evidence: evidence.map(e => ({ type: e.type, ref: e.ref, note: e.note, candidate_only: false, freshness: e.freshness, detail: e.detail,
        path: e.resolvedPath ?? null, lines: e.startLine ? [e.startLine, e.endLine ?? e.startLine] : null, excerpt: e.excerpt })),
      provenance: { origin: d.origin, createdAt: d.createdAt, status: d.status },
    });
  }
  return { read, decisions: out };
}

function matches(d: Json, o: QueryOpts): string | null {
  if (o.id) return d.id === o.id ? 'id' : null;
  if (o.system) return (d.systems ?? [d.system]).includes(o.system) ? 'system' : null;
  if (o.file) {
    const f = o.file;
    return d.files.some((x: Json) => x.path === f) || d.evidence.some((e: Json) => (e.path ?? e.ref.split('#')[0]) === f || e.ref.split('#')[0] === f) ? 'file' : null;
  }
  if (o.q) {
    const q = words(o.q), hay = words([d.id, d.title, d.claim, ...(d.scope ?? []), ...(d.tags ?? [])].join(' '));
    return q.size && [...q].every(w => hay.has(w) || [...hay].some(h => h.startsWith(w))) ? 'text' : null;
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
  if (hasLegacy && !opts.system) {
    if (opts.revision) limitations.push('The legacy registry is read from the checkout, not from a revision.');
    const arg = opts.file ? await legacy.contextForFile(project, opts.file, opts.worktree)
      : opts.id ? await legacy.contextForQuery(project, opts.id, opts.worktree)
      : opts.q ? await legacy.contextForQuery(project, opts.q, opts.worktree) : legacyRes;
    legacyRes = arg as Json;
  }
  const picked: Json[] = [];
  for (const d of native) { const by = matches(d, opts); if (by) picked.push({ ...d, matched_by: d.matched_by ?? by }); }
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
    legacy: { available: !!legacyRes.available, reason: legacyRes.available ? undefined : legacyRes.reason },
  };
  const available = read.state === 'present' || !!legacyRes.available || read.state === 'absent';
  return {
    available, reason: available ? undefined : 'No usable source of decisions', decisions, conflicts, sources, limitations,
    indexed: legacyRes.indexed, note: legacyRes.note,
    graph: opts.file ? await legacy.graphRelations(project.id, opts.file) : undefined, branch: legacyRes.branch, head: legacyRes.head,
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
  if (!found) return legacy.attest(project, input);
  if (read.state !== 'present') return { ok: false as const, error: 'Native decisions are not readable' };
  const entry = { decision_id: input.decisionId, state: input.state, claim_sha256: found.claim_sha256, quote,
    channel: 'ui-request', trust: 'attested_local', at: new Date().toISOString(), projectId: project.id };
  await legacy.recordAttestation(project, entry);
  listeners.forEach(fn => fn());
  return { ok: true as const, entry };
}
