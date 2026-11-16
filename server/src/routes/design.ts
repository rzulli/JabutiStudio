import { FastifyInstance } from 'fastify';
import * as projectDiscovery from '../services/projectDiscovery.js';
import * as dk from '../services/designKnowledge.js';

export async function designRoutes(app: FastifyInstance) {
  const resolve = async (id: string) => (await projectDiscovery.getProjects()).find(p => p.id === id);

  // Read-only. `file` or `q`; `worktree` selects which checkout's code is judged (default: the project's own).
  app.get<{ Params: { id: string }; Querystring: { file?: string; q?: string; worktree?: string } }>(
    '/api/projects/:id/design',
    async (request, reply) => {
      const project = await resolve(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const { file, q, worktree } = request.query;
      if (file) return dk.contextForFile(project, file, worktree);
      if (q) return dk.contextForQuery(project, q, worktree);
      return reply.status(400).send({ error: 'file or q is required' });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { worktree?: string } }>('/api/projects/:id/design/validate', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return dk.validateRegistry(project, request.query.worktree);
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
      const h = request.headers;
      const sameOrigin = typeof h.origin === 'string' && h.origin.replace(/^https?:\/\//, '') === h.host;
      if (!sameOrigin || h['sec-fetch-site'] !== 'same-origin' || h['sec-fetch-dest'] !== 'empty') {
        return reply.status(403).send({ error: 'Approvals can only be recorded from the JabutiStudio UI' });
      }
      const project = await resolve(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const { decisionId, state, quote } = request.body ?? {};
      if (!decisionId || !['approved', 'rejected', 'revoked'].includes(state ?? '')) {
        return reply.status(400).send({ error: 'decisionId and state (approved|rejected|revoked) are required' });
      }
      const res = await dk.attest(project, { decisionId, state: state as dk.AttestState, quote: quote ?? '' });
      if (!res.ok) return reply.status(400).send({ error: res.error });
      return res.entry;
    },
  );
}
