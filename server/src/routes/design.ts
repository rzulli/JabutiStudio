import { FastifyInstance } from 'fastify';
import * as projectDiscovery from '../services/projectDiscovery.js';
import * as dk from '../services/designKnowledge.js';
import * as core from '../services/designCore.js';
import { EVIDENCE_TYPES } from '../services/designDecisions.js';
import * as migration from '../services/designMigration.js';
import * as sources from '../services/designSources.js';
import * as assist from '../services/designAssist.js';
import * as aiBackend from '../services/aiBackend.js';
import { readLegacyRecords } from '../services/legacyRecords.js';
import { isLoopbackOrigin } from '../services/localAccess.js';

/**
 * The browser sets Origin and Sec-Fetch-* on its own fetches and page script cannot change them; an agent,
 * MCP client or plain curl normally sends none. The page may be served by the backend, by Vite (its proxy
 * rewrites Host, so Host is not compared), or by the Electron window on 127.0.0.1. Every request still passes
 * the Host and Origin allow-list in localAccess before it reaches a route.
 */
export function fromAppUi(h: Record<string, unknown>) {
  const origin = h.origin;
  if (typeof origin !== 'string' || !isLoopbackOrigin(origin)) return false;
  return h['sec-fetch-site'] === 'same-origin' && h['sec-fetch-dest'] === 'empty';
}

export async function designRoutes(app: FastifyInstance) {
  const resolve = async (id: string) => (await projectDiscovery.getProjects()).find(p => p.id === id);

  // Read-only. `file`, `q`, `id` or `system`; `worktree` selects which checkout's code is judged and
  // `revision` reads native decisions as of a commit. Works for projects with no decisions at all.
  app.get<{ Params: { id: string }; Querystring: { file?: string; q?: string; id?: string; system?: string; worktree?: string; revision?: string } }>(
    '/api/projects/:id/design',
    async (request, reply) => {
      const project = await resolve(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const { file, q, id, system, worktree, revision } = request.query;
      if (!file && !q && !id && !system) return reply.status(400).send({ error: 'file, q, id or system is required' });
      return core.query(project, { file, q, id, system, worktree, revision });
    },
  );

  // Project-wide list of native decisions (the review queue and feed). Read-only; same records as `GET /design`.
  app.get<{ Params: { id: string }; Querystring: { worktree?: string } }>('/api/projects/:id/design/decisions', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return core.listDecisions(project, { worktree: request.query.worktree });
  });

  // A proposal only: it is stored as `proposed` and can never carry an approval. From the UI the origin is
  // "user", from anything else "agent" — a statement of who wrote it, not a verification.
  app.post<{ Params: { id: string }; Body: Record<string, any> }>('/api/projects/:id/design/proposals', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const b = request.body ?? {};
    const strs = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    const evidence = Array.isArray(b.evidence) ? b.evidence.filter((e: any) => e && typeof e.path === 'string' && EVIDENCE_TYPES.includes(e.type)) : [];
    const res = await core.propose(project, {
      title: String(b.title ?? ''), claim: String(b.claim ?? ''), scope: strs(b.scope), systems: strs(b.systems), files: strs(b.files),
      conflictsWith: strs(b.conflictsWith), supersedes: strs(b.supersedes), evidence,
      origin: fromAppUi(request.headers) ? 'user' : 'agent',
    });
    if (!res.ok) return reply.status(400).send({ error: res.error });
    return res.decision;
  });

  // Agent help for decisions. Advisory only: it returns text and findings, never an approval, a status or a write.
  // `structure` drafts a new proposal from a description (its evidence is a literal search of the checkout). Input is
  // checked before the project lookup and before any AI call.
  app.post<{ Params: { id: string }; Body: { action?: string; decisionId?: string; text?: string; worktree?: string } }>(
    '/api/projects/:id/design/assist',
    async (request, reply) => {
      const b = request.body ?? {};
      const worktree = typeof b.worktree === 'string' && b.worktree ? b.worktree : undefined;
      if (b.action === 'structure') {
        const text = typeof b.text === 'string' ? b.text.trim() : '';
        if (text.length < 10 || text.length > 4000) return reply.status(400).send({ error: 'Describe the decision in 10 to 4000 characters.' });
      } else if (!(assist.ASSIST_ACTIONS as readonly string[]).includes(String(b.action))) {
        return reply.status(400).send({ error: 'action must be structure, rephrase, evidence, conflicts or compare' });
      } else if (typeof b.decisionId !== 'string' || !b.decisionId) {
        return reply.status(400).send({ error: 'decisionId is required for this action' });
      }
      const project = await resolve(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      try {
        const listed = await core.listDecisions(project, { worktree });
        if (!listed.available) return reply.status(409).send({ error: listed.reason ?? 'Decisions are not available for this checkout' });
        if (b.action === 'structure') {
          const root = await assist.checkoutRoot(project, worktree);
          if (!root) return reply.status(409).send({ error: 'The checkout could not be resolved' });
          return await assist.structureDecision(root, String(b.text).trim(), listed.decisions);
        }
        const d = listed.decisions.find((x: any) => x.id === b.decisionId);
        if (!d) return reply.status(404).send({ error: `Decision ${b.decisionId} is not in this checkout` });
        return await assist.assistDecision(d, b.action as assist.AssistAction, listed.decisions);
      } catch (err: any) {
        if (err instanceof assist.AssistError) return reply.status(err.status).send({ error: err.message });
        if (err?.status === 429) return reply.status(429).send({ error: 'Rate limit reached. Nothing was changed; try again in a moment.' });
        if (err instanceof aiBackend.NoAiAvailableError) return reply.status(503).send({ error: err.message });
        return reply.status(500).send({ error: err?.message || 'The agent did not answer. Nothing was changed.' });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { worktree?: string } }>('/api/projects/:id/design/validate', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return core.validateNative(project, request.query.worktree);
  });

  // External evidence sources (@name:key): where each name points on THIS machine. Reading is open; configuring
  // is UI-only, and only an absolute local file is accepted. Nothing outside a configured file is ever read.
  app.get<{ Params: { id: string } }>('/api/projects/:id/design/sources', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return { sources: Object.entries(await sources.configuredSources(project.id)).map(([name, v]) => ({ name, path: v.path, origin: v.origin })) };
  });
  app.put<{ Params: { id: string; name: string }; Body: { path?: string | null } }>('/api/projects/:id/design/sources/:name', async (request, reply) => {
    if (!fromAppUi(request.headers)) return reply.status(403).send({ error: 'External sources can only be configured from the JabutiStudio UI' });
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const p = request.body?.path;
    const res = await sources.setSource(project.id, request.params.name, typeof p === 'string' ? p : null);
    if (!res.ok) return reply.status(400).send({ error: res.error });
    core.notifyDecisionsChanged();
    return { ok: true };
  });

  // Legacy dk.py records -> jabutistudio.decisions.json. The preview writes nothing; apply and rollback are UI-only
  // and apply needs the hash of the preview that was reviewed.
  app.get<{ Params: { id: string } }>('/api/projects/:id/design/migration', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const { doc, ...plan } = await migration.plan(project);
    return plan;
  });
  app.post<{ Params: { id: string }; Body: { expectedPlanSha256?: string; resolutions?: migration.Resolution } }>('/api/projects/:id/design/migration/apply', async (request, reply) => {
    if (!fromAppUi(request.headers)) return reply.status(403).send({ error: 'Migration can only be applied from the JabutiStudio UI' });
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const res = await migration.apply(project, { expectedPlanSha256: String(request.body?.expectedPlanSha256 ?? ''), resolutions: request.body?.resolutions });
    const { doc, ...plan } = res.plan ?? ({} as any);
    if (!res.ok) return reply.status(409).send({ error: res.error, plan });
    return { ...res, plan };
  });
  app.post<{ Params: { id: string }; Body: { manifestId?: string } }>('/api/projects/:id/design/migration/rollback', async (request, reply) => {
    if (!fromAppUi(request.headers)) return reply.status(403).send({ error: 'Rollback can only be done from the JabutiStudio UI' });
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const res = await migration.rollback(project, String(request.body?.manifestId ?? ''));
    return res.ok ? res : reply.status(409).send(res);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/design/checkouts', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return { legacyRecords: readLegacyRecords(project.path).records.length, checkouts: await dk.listCheckouts(project.path) };
  });

  // The only way an approval comes to exist. The Origin/Sec-Fetch check stops an agent or a script that
  // does not know to forge it (MCP has no such tool, curl is refused), and the browser sets them on the
  // renderer's fetch. It is NOT proof of a person: any local process can send the same headers (verified
  // with curl). The result is therefore recorded as `attested_local`, never as a verified human approval.
  app.post<{ Params: { id: string }; Body: { decisionId?: string; state?: string; quote?: string; claimSha256?: string } }>(
    '/api/projects/:id/design/approve',
    async (request, reply) => {
      if (!fromAppUi(request.headers)) {
        return reply.status(403).send({ error: 'Approvals can only be recorded from the JabutiStudio UI' });
      }
      const project = await resolve(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const { decisionId, state, quote, claimSha256 } = request.body ?? {};
      if (!decisionId || !['approved', 'rejected', 'revoked'].includes(state ?? '')) {
        return reply.status(400).send({ error: 'decisionId and state (approved|rejected|revoked) are required' });
      }
      if (claimSha256 !== undefined && typeof claimSha256 !== 'string') {
        return reply.status(400).send({ error: 'claimSha256 must be a string when given' });
      }
      const res = await core.attest(project, { decisionId, state: state as dk.AttestState, quote: quote ?? '', expectedClaimSha256: claimSha256 });
      if (!res.ok) return reply.status(res.code === 'claim-changed' ? 409 : 400).send({ error: res.error, code: res.code });
      return res.entry;
    },
  );
}
