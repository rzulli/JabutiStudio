import { FastifyInstance } from 'fastify';
import * as projectDiscovery from '../services/projectDiscovery.js';
import * as dk from '../services/designKnowledge.js';
import * as core from '../services/designCore.js';
import { EVIDENCE_TYPES } from '../services/designDecisions.js';
import * as migration from '../services/designMigration.js';

/** The browser renderer sets these on its own fetches; an agent, MCP client or plain curl does not. */
export function fromAppUi(h: Record<string, unknown>) {
  const sameOrigin = typeof h.origin === 'string' && h.origin.replace(/^https?:\/\//, '') === h.host;
  return sameOrigin && h['sec-fetch-site'] === 'same-origin' && h['sec-fetch-dest'] === 'empty';
}

export async function designRoutes(app: FastifyInstance) {
  const resolve = async (id: string) => (await projectDiscovery.getProjects()).find(p => p.id === id);

  // Read-only. `file`, `q`, `id` or `system`; `worktree` selects which checkout's code is judged and
  // `revision` reads native decisions as of a commit. Works for projects with no decisions at all.
  app.get<{ Params: { id: string }; Querystring: { file?: string; q?: string; id?: string; system?: string; worktree?: string; revision?: string; nativeOnly?: string } }>(
    '/api/projects/:id/design',
    async (request, reply) => {
      const project = await resolve(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const { file, q, id, system, worktree, revision, nativeOnly } = request.query;
      if (!file && !q && !id && !system) return reply.status(400).send({ error: 'file, q, id or system is required' });
      return core.query(project, { file, q, id, system, worktree, revision, nativeOnly: nativeOnly === '1' || nativeOnly === 'true' });
    },
  );

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

  app.get<{ Params: { id: string }; Querystring: { worktree?: string; engine?: 'native' | 'legacy' } }>('/api/projects/:id/design/validate', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    // The native engine validates whenever the project has a native file (or when asked); dk.py only for a
    // project that still has nothing but its legacy registry.
    const engine = request.query.engine;
    if (engine !== 'legacy') {
      const native = await core.validateNative(project, request.query.worktree);
      if (native.available || engine === 'native') return native;
    }
    return dk.validateRegistry(project, request.query.worktree);
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
    return { registry: dk.hasRegistry(project.path), checkouts: await dk.listCheckouts(project.path) };
  });

  // The only way an approval comes to exist. The Origin/Sec-Fetch check stops an agent or a script that
  // does not know to forge it (MCP has no such tool, curl is refused), and the browser sets them on the
  // renderer's fetch. It is NOT proof of a person: any local process can send the same headers (verified
  // with curl). The result is therefore recorded as `attested_local`, never as a verified human approval.
  app.post<{ Params: { id: string }; Body: { decisionId?: string; state?: string; quote?: string } }>(
    '/api/projects/:id/design/approve',
    async (request, reply) => {
      if (!fromAppUi(request.headers)) {
        return reply.status(403).send({ error: 'Approvals can only be recorded from the JabutiStudio UI' });
      }
      const project = await resolve(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const { decisionId, state, quote } = request.body ?? {};
      if (!decisionId || !['approved', 'rejected', 'revoked'].includes(state ?? '')) {
        return reply.status(400).send({ error: 'decisionId and state (approved|rejected|revoked) are required' });
      }
      const res = await core.attest(project, { decisionId, state: state as dk.AttestState, quote: quote ?? '' });
      if (!res.ok) return reply.status(400).send({ error: res.error });
      return res.entry;
    },
  );
}
