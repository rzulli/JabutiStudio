import { FastifyInstance } from 'fastify';
import * as projectDiscovery from '../services/projectDiscovery.js';
import * as systems from '../services/systemCatalog.js';
import { fromAppUi } from './design.js';

export async function systemRoutes(app: FastifyInstance) {
  const resolve = async (id: string) => (await projectDiscovery.getProjects()).find(p => p.id === id);
  const uiOnly = (request: any, reply: any) => {
    if (fromAppUi(request.headers)) return true;
    reply.status(403).send({ error: 'Classifying a system can only be done from the JabutiStudio UI. Agents may propose (MCP propose_system).' });
    return false;
  };
  type Q = { Params: { id: string }; Querystring: { worktree?: string } };

  app.get<Q>('/api/projects/:id/systems', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return systems.catalog(project, request.query.worktree);
  });

  // Candidates from file names only; idempotent, adds nothing that an existing system already owns.
  app.post<Q>('/api/projects/:id/systems/discover', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const res = await systems.discover(project, request.query.worktree);
    if ('error' in res) return reply.status(400).send(res);
    return res;
  });

  app.get<{ Params: { id: string; sid: string }; Querystring: { worktree?: string } }>('/api/projects/:id/systems/:sid', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const v = await systems.resolveSystem(project, request.params.sid, request.query.worktree);
    if ('error' in v) return reply.status(404).send(v);
    return v;
  });

  app.get<{ Params: { id: string; sid: string }; Querystring: { worktree?: string; goal?: string } }>('/api/projects/:id/systems/:sid/brief', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const v = await systems.resolveSystem(project, request.params.sid, request.query.worktree);
    if ('error' in v) return reply.status(404).send(v);
    return { text: systems.brief(v, request.query.goal), head: v.checkout.head, root: v.checkout.root };
  });

  app.post<{ Params: { id: string }; Body: systems.ProposalInput }>('/api/projects/:id/systems', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const b = request.body;
    if (!b?.name?.trim()) return reply.status(400).send({ error: 'name is required' });
    return systems.propose(request.params.id, b, 'user');
  });

  app.patch<{ Params: { id: string; sid: string }; Body: systems.Edit }>('/api/projects/:id/systems/:sid', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const s = await systems.review(request.params.id, request.params.sid, request.body ?? {});
    return s ?? reply.status(404).send({ error: 'System not found' });
  });

  app.post<{ Params: { id: string; sid: string }; Body: { from?: string[] } }>('/api/projects/:id/systems/:sid/merge', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const s = await systems.merge(request.params.id, request.params.sid, request.body?.from ?? []);
    return s ?? reply.status(404).send({ error: 'System not found' });
  });

  app.post<{ Params: { id: string; sid: string }; Body: { name?: string; terms?: string[]; files?: string[] } }>('/api/projects/:id/systems/:sid/split', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const b = request.body;
    if (!b?.name?.trim()) return reply.status(400).send({ error: 'name is required' });
    const s = await systems.split(request.params.id, request.params.sid, { name: b.name, terms: b.terms, files: b.files });
    return s ?? reply.status(404).send({ error: 'System not found' });
  });
}
