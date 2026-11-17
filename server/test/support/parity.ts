/**
 * Differential harness (R1-B2): the same question asked of the hardened legacy dk.py and of the native Design
 * Knowledge Core, compared field by field. Only representation is normalised (ordering, aggregate vocabulary,
 * excerpt length); a difference of meaning is reported as `different` and never smoothed over.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

type Json = Record<string, any>;
export interface Check { query: string; field: string; verdict: 'equal' | 'representation' | 'different'; legacy?: unknown; native?: unknown; note?: string }

export function runLegacy(python: string, dkPy: string, cmd: string[], root: string, records: string, approvals?: string): Json {
  const args = ['-I', dkPy, cmd[0], ...cmd.slice(1), '--root', root, '--records', records, '--json', ...(approvals ? ['--approvals', approvals] : [])];
  try { return JSON.parse(execFileSync(python, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })); }
  catch (e: any) {
    if (typeof e.stdout === 'string' && e.stdout.trim().startsWith('{')) return JSON.parse(e.stdout);
    throw e;
  }
}

const sortedJson = (v: unknown) => JSON.stringify(v);
const byId = (a: Json[]) => [...a].sort((x, y) => String(x.id).localeCompare(String(y.id)));

/** Legacy per-evidence states vs native: a whole-file mismatch with no cited lines is STALE there and CHANGED here. */
function evFreshnessVerdict(l: Json, n: Json): 'equal' | 'representation' | 'different' {
  if (l.freshness === n.freshness) return 'equal';
  const lineScoped = !!(l.ref && /#L\d+/.test(l.ref));
  if (!lineScoped && l.freshness === 'STALE' && n.freshness === 'CHANGED') return 'representation';
  return 'different';
}

export function compareDecision(query: string, l: Json, n: Json): Check[] {
  const out: Check[] = [];
  const add = (field: string, verdict: Check['verdict'], legacy?: unknown, native?: unknown, note?: string) => out.push({ query, field: `${l.id}.${field}`, verdict, legacy, native, note });
  const eq = (field: string, a: unknown, b: unknown) => add(field, sortedJson(a) === sortedJson(b) ? 'equal' : 'different', a, b);
  for (const f of ['id', 'title', 'claim', 'claim_sha256', 'decision_state', 'implementation', 'catalogued_implementation']) eq(f, l[f], n[f]);
  eq('scope', l.scope, n.scope);
  eq('supersedes', [...l.supersedes].sort(), [...n.supersedes].sort());
  eq('conflicts_with', [...l.conflicts_with].sort(), [...n.conflicts_with].sort());
  eq('approval.state', l.approval.state, n.approval.state);
  // The legacy source names; native tracks the same trust levels under its own source labels.
  const srcMap: Record<string, string> = { 'repository-claim': 'repository-claim', none: 'none', attested_local: 'attested_local', 'attestation-lapsed': 'attestation-lapsed' };
  add('approval.source', srcMap[l.approval.source] === n.approval.source ? ('equal') : 'different', l.approval.source, n.approval.source);
  eq('files', l.files.map((f: Json) => [f.path, f.role]).sort(), n.files.map((f: Json) => [f.path, f.role]).sort());
  eq('tests', l.tests.map((t: Json) => [t.path, t.direct]).sort(), n.tests.map((t: Json) => [t.path, t.direct]).sort());
  eq('qps', l.qps.map((t: Json) => [t.path, t.direct]).sort(), n.qps.map((t: Json) => [t.path, t.direct]).sort());
  // legacy aggregate vocabulary (MISSING/STALE/UNKNOWN/CURRENT) is computed natively as evidence_status_legacy
  eq('evidence_status', l.evidence_status, n.evidence_status_legacy);
  if (l.evidence.length !== n.evidence.length) add('evidence.length', 'different', l.evidence.length, n.evidence.length);
  l.evidence.forEach((le: Json, i: number) => {
    const ne = n.evidence[i];
    if (!ne) return;
    const tag = `evidence[${i}]`;
    eq(`${tag}.type`, le.type, ne.type); add(`${tag}.ref`, le.ref === ne.ref ? 'equal' : le.ref.replace(/#L(\d+)-L\1$/, '#L$1') === ne.ref ? 'representation' : 'different', le.ref, ne.ref, 'single-line range spelling'); eq(`${tag}.note`, le.note ?? '', ne.note ?? '');
    eq(`${tag}.candidate_only`, le.candidate_only, !!ne.candidate_only);
    add(`${tag}.freshness`, evFreshnessVerdict(le, ne), le.freshness, ne.freshness);
    if (le.freshness === ne.freshness) {
      eq(`${tag}.path`, le.path ?? null, ne.path ?? null);
      // native caps an excerpt at 6 lines (legacy 12); compare the lines both returned
      const k = Math.min(le.excerpt.length, ne.excerpt.length, 6);
      const same = JSON.stringify(le.excerpt.slice(0, k).map((x: Json) => [x.line, x.text.slice(0, 240)])) === JSON.stringify(ne.excerpt.slice(0, k).map((x: Json) => [x.line, x.text]));
      add(`${tag}.excerpt`, !same ? 'different' : le.excerpt.length === ne.excerpt.length ? 'equal' : 'representation', le.excerpt.length, ne.excerpt.length, 'excerpt length cap');
    }
  });
  return out;
}

export function compareQuery(query: string, legacy: Json, native: Json): Check[] {
  const out: Check[] = [];
  const lids = byId(legacy.decisions).map(d => d.id), nids = byId(native.decisions).map(d => d.id);
  out.push({ query, field: 'ids', verdict: sortedJson(lids) === sortedJson(nids) ? 'equal' : 'different', legacy: lids, native: nids });
  const nmap = new Map(native.decisions.map((d: Json) => [d.id, d]));
  for (const l of byId(legacy.decisions)) { const n = nmap.get(l.id); if (n) out.push(...compareDecision(query, l, n as Json)); }
  return out;
}

export function summarize(checks: Check[]) {
  const count = (v: Check['verdict']) => checks.filter(c => c.verdict === v).length;
  const byField = new Map<string, { equal: number; representation: number; different: number }>();
  for (const c of checks) {
    const key = c.field.replace(/^[^.]+\./, '').replace(/\[\d+\]/g, '[]');
    const row = byField.get(key) ?? { equal: 0, representation: 0, different: 0 };
    row[c.verdict]++; byField.set(key, row);
  }
  return { total: checks.length, equal: count('equal'), representation: count('representation'), different: count('different'),
    byField: Object.fromEntries([...byField.entries()].sort()), differences: checks.filter(c => c.verdict !== 'equal') };
}

export const dkPaths = (root: string) => ({ records: join(root, 'docs', 'design_knowledge', 'records') });
