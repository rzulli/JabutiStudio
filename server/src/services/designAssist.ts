/**
 * Agent assistance for Design decisions. Two jobs, both advisory:
 *   - assistDecision: on one existing decision, rewrite its wording, investigate its cited evidence, compare it with
 *     conflicting decisions, or compare the claim with the code. Returns text and findings only.
 *   - structureDecision: turn a natural-language description into a proposal draft. The evidence it returns is found
 *     in the checkout by a literal search, never invented by the model; saving still goes through addProposal, which
 *     re-checks every file and needle.
 * Nothing here approves, rejects, revokes, publishes or writes the decisions file. Approval state is only read.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as aiBackend from './aiBackend.js';
import { parseJsonResponse } from './aiJson.js';
import * as dk from './designKnowledge.js';

const execFileAsync = promisify(execFile);

export const ASSIST_ACTIONS = ['rephrase', 'evidence', 'conflicts', 'compare'] as const;
export type AssistAction = typeof ASSIST_ACTIONS[number];

export class AssistError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Dec = Record<string, any>;

/** Same three-way reading the client uses (designReview.tierOf), computed here so the prompt states the real state. */
export function approvalTier(d: Dec): 'attested_local' | 'claimed' | 'proposed' | 'lapsed' | 'rejected' {
  const a = d.approval ?? {};
  if (a.state === 'approved' && a.source === 'attested_local' && !a.lapsed) return 'attested_local';
  if (a.state === 'rejected' || a.state === 'revoked') return 'rejected';
  if (a.lapsed || a.source === 'attestation-lapsed') return 'lapsed';
  if (a.state === 'claimed') return 'claimed';
  return 'proposed';
}

const TIER_TEXT: Record<ReturnType<typeof approvalTier>, string> = {
  attested_local: 'attested locally for this exact text (a local record, not proof of who clicked)',
  claimed: 'claimed by a document or migrated record, not confirmed here',
  proposed: 'proposed; no approval exists',
  lapsed: 'an earlier approval lapsed because the text changed; no approval applies now',
  rejected: 'rejected or revoked locally',
};

const RULES = [
  'You assist a person who reviews a design decision. You may only suggest text and findings. You cannot approve, reject, revoke, publish, or mark anything as implemented.',
  'Do not state that the whole decision is implemented from partial evidence. Say which parts the cited evidence supports and which it does not.',
  'Use only the decision text and the evidence excerpts given. If something cannot be verified from them, say so.',
  'Respond ONLY with a JSON object containing the keys requested below. No markdown fences.',
];

const FOCUS: Record<AssistAction, string> = {
  rephrase: 'Rewrite the recorded claim so it is clearer and more precise. Keep the same meaning and scope; do not add requirements and do not state implementation status. Return {"claim": string, "notes": [string]} where notes list what you changed.',
  evidence: 'For each cited evidence item, say whether its excerpt supports the claim, supports it only partly, contradicts it, or is unclear. Return {"notes": [string]} with one note per item, starting with the reference.',
  conflicts: 'Compare this claim with each conflicting decision given. Say where they disagree and what would decide between them. Do not pick a side. Return {"notes": [string]}.',
  compare: 'Compare the claim with what the cited code and evidence show: what matches, and what is missing or not evidenced. Return {"notes": [string]}.',
};

function evidenceOf(d: Dec): Dec[] {
  return (d.evidence ?? []).filter((e: Dec) => !e.candidate_only);
}

function decisionBlock(d: Dec, tier: string, conflicts: Dec[]): string {
  const ev = evidenceOf(d).map((e: Dec) => {
    const head = (e.excerpt ?? []).slice(0, 8).map((x: Dec) => `    ${x.line}: ${x.text}`).join('\n');
    return `- [${e.type}] ${e.ref} (${e.freshness})${e.note ? ` — ${e.note}` : ''}${head ? `\n${head}` : ''}`;
  });
  const conf = conflicts.map(c => `- ${c.id}: ${c.title} — claim: ${c.claim}`);
  return [
    `Decision ${d.id}: ${d.title}`,
    `Recorded claim (text, not approval): ${d.claim}`,
    `Approval state: ${TIER_TEXT[tier as keyof typeof TIER_TEXT]}`,
    `Implementation reads "${d.implementation}"; evidence "${d.evidence_status}".`,
    `Systems: ${(d.systems ?? []).join(', ') || 'none'}`,
    `Cited evidence:${ev.length ? `\n${ev.join('\n')}` : ' none'}`,
    `Conflicting decisions:${conf.length ? `\n${conf.join('\n')}` : ' none recorded'}`,
  ].join('\n');
}

/** Keeps only the keys an action asked for, trimmed and capped. A non-JSON or empty answer is an error, never a silent edit. */
export function normalizeAssist(action: AssistAction, parsed: unknown): { claim?: string; notes: string[] } {
  const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Dec;
  const notes = (Array.isArray(p.notes) ? p.notes : [])
    .filter((n: unknown): n is string => typeof n === 'string')
    .map((n: string) => n.trim()).filter(Boolean).slice(0, 12);
  if (action !== 'rephrase') return { notes };
  const claim = typeof p.claim === 'string' ? p.claim.trim().slice(0, 4000) : '';
  return claim ? { claim, notes } : { notes };
}

/** Runs one assist action on an existing decision. Read-only with respect to decisions and approvals. */
export async function assistDecision(d: Dec, action: AssistAction, all: Dec[]): Promise<{ action: AssistAction; claim?: string; notes: string[] }> {
  const tier = approvalTier(d);
  const conflicts = (d.conflicts_with ?? []).map((id: string) => all.find(x => x.id === id)).filter(Boolean) as Dec[];
  // Answers the question locally when there is nothing to ask the model about. No AI call is made.
  if (action === 'conflicts' && !conflicts.length) return { action, notes: ['No conflicting decision is recorded for this one.'] };
  if (action === 'evidence' && !evidenceOf(d).length) return { action, notes: ['No cited evidence to investigate.'] };
  if (action === 'compare' && !evidenceOf(d).length) return { action, notes: ['No cited code or evidence to compare with the claim.'] };

  const system = [`Review help for design decision ${d.id}.`, FOCUS[action], ...RULES].join('\n');
  const result = await aiBackend.generateText(system, decisionBlock(d, tier, conflicts), { maxTokens: 1024, timeout: 60_000 });
  let parsed: unknown;
  try { parsed = parseJsonResponse(result.text); } catch {
    throw new AssistError(502, 'The agent answered, but not in the expected format. Nothing was changed.');
  }
  return { action, ...normalizeAssist(action, parsed) };
}

// ---- Structuring a new decision from a description -------------------------------------------------------------

export interface StructureResult {
  title: string;
  claim: string;
  systems: string[];
  evidence: { type: string; path: string; startLine: number; needle: string; note: string }[];
  conflicts: { id: string; title: string }[];
  limitations: string[];
  notes: string[];
}

const STRUCTURE_FOCUS = [
  'Turn the description into one design decision draft.',
  'Return {"title": string, "claim": string, "systems": [string], "searchTerms": [string], "limitations": [string]}.',
  'claim: one or two sentences stating the intended behaviour. Do not say it is implemented.',
  'searchTerms: up to 6 literal identifiers, constants or exact phrases that would appear in the code or docs that show this behaviour. Only words from the description; do not invent names.',
  'limitations: what the description does not settle, and what you could not verify.',
].join('\n');

/** Literal search over tracked files. Returns only what is really there: path, line and the matched text. */
export async function findEvidence(root: string, terms: string[]): Promise<{ term: string; path: string; line: number; text: string }[]> {
  const out: { term: string; path: string; line: number; text: string }[] = [];
  const seen = new Set<string>();
  for (const term of terms.slice(0, 6)) {
    if (term.length < 4) continue;
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('git', ['grep', '-n', '-I', '-F', '-e', term, '--', '.'], {
        cwd: root, timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      }));
    } catch {
      continue; // no match (exit 1) or not a git checkout: nothing to add for this term
    }
    let hits = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^(.+?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      const [, path, lineNo, text] = m;
      if (path.startsWith('.git')) continue;
      const key = `${path}:${lineNo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ term, path, line: Number(lineNo), text: text.trim().slice(0, 200) });
      if (++hits >= 3) break;
    }
  }
  return out;
}

/** Evidence type from the path, using the existing vocabulary (designDecisions EVIDENCE_TYPES). */
export function evidenceTypeFor(path: string): string {
  if (/\.(md|txt)$/i.test(path)) return 'document_claim';
  if (/test/i.test(path)) return 'test';
  return 'code';
}

const words = (s: string) => new Set(s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w.length >= 4));

/** Possible conflict by shared title words. A hint for the person to check, not a finding. */
export function possibleConflicts(title: string, existing: Dec[]): { id: string; title: string }[] {
  const mine = words(title);
  return existing
    .filter(d => { let n = 0; for (const w of words(String(d.title ?? ''))) if (mine.has(w)) n++; return n >= 2; })
    .map(d => ({ id: String(d.id), title: String(d.title ?? '') }))
    .slice(0, 8);
}

export async function structureDecision(root: string, text: string, existing: Dec[]): Promise<StructureResult> {
  // AI failures (rate limit, no backend) propagate to the route, which maps them. Only a bad answer is handled here.
  const system = [
    'You structure a design decision from a person\'s description. You only draft text; you cannot approve anything.',
    STRUCTURE_FOCUS,
    'Respond ONLY with JSON. No markdown fences.',
  ].join('\n');
  const r = await aiBackend.generateText(system, text, { maxTokens: 1024, timeout: 60_000 });
  let parsed: Dec;
  try { parsed = parseJsonResponse(r.text) as Dec; } catch {
    throw new AssistError(502, 'The agent did not return a structured draft. Nothing was saved.');
  }
  const strs = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean).slice(0, max) : []);
  const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 160) : '';
  const claim = typeof parsed.claim === 'string' ? parsed.claim.trim().slice(0, 2000) : '';
  const terms = strs(parsed.searchTerms, 6);
  const found = await findEvidence(root, terms);
  const evidence = found.map(f => ({
    type: evidenceTypeFor(f.path), path: f.path, startLine: f.line, needle: f.term,
    note: `found by searching for "${f.term}"`,
  }));
  return {
    title, claim, systems: strs(parsed.systems, 6),
    evidence,
    conflicts: possibleConflicts(title, existing),
    limitations: strs(parsed.limitations, 8),
    notes: terms.length && !found.length ? ['None of the search terms was found in the checkout. Add evidence by hand or describe the code more specifically.'] : [],
  };
}

/** Resolves the checkout a request is about (same rule as the decisions list). */
export async function checkoutRoot(project: { id: string; path: string }, worktree?: string): Promise<string | null> {
  const r = await dk.resolveRoot(project as any, worktree);
  return typeof r === 'string' ? r : null;
}
