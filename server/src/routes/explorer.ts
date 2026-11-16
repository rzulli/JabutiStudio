import { FastifyInstance } from 'fastify';
import * as projectDiscovery from '../services/projectDiscovery.js';
import * as graphify from '../services/graphifyAdapter.js';

export async function explorerRoutes(app: FastifyInstance) {
  async function resolve(id: string) {
    const projects = await projectDiscovery.getProjects();
    return projects.find(p => p.id === id);
  }

  // Read-only except POST build. The graph is produced by Graphify (external
  // engine) on a staged copy of the Godot sources; see services/graphifyAdapter.ts.
  app.get<{ Params: { id: string } }>('/api/projects/:id/explorer', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    if (!(await graphify.isGodotProject(project.path))) return { godot: false, root: project.path };
    return { godot: true, root: project.path, ...(await graphify.getStatus(project.id, project.path)) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/explorer/build', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    if (!(await graphify.isGodotProject(project.path))) return reply.status(400).send({ error: 'Not a Godot project' });
    try {
      return await graphify.buildGraph(project.id, project.path);
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Graphify failed' });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string; kind?: string; limit?: string } }>(
    '/api/projects/:id/explorer/search',
    async (request, reply) => {
      const limit = Math.min(200, Math.max(1, parseInt(request.query.limit ?? '80', 10) || 80));
      const res = await graphify.search(request.params.id, request.query.q ?? '', request.query.kind, limit);
      if (!res) return reply.status(409).send({ error: 'Graph not built yet' });
      return res;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { node?: string } }>(
    '/api/projects/:id/explorer/node',
    async (request, reply) => {
      const res = request.query.node ? await graphify.getNode(request.params.id, request.query.node) : null;
      if (!res) return reply.status(404).send({ error: 'Node not found' });
      return res;
    },
  );
}
