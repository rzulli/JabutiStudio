import { FastifyInstance } from 'fastify';
import * as projectDiscovery from '../services/projectDiscovery.js';
import * as godotIndex from '../services/godotIndex.js';

export async function explorerRoutes(app: FastifyInstance) {
  // Read-only: the index is derived from the project's files on every call
  // (cached 30s; `?refresh=1` rebuilds).
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/api/projects/:id/explorer',
    async (request, reply) => {
      const projects = await projectDiscovery.getProjects();
      const project = projects.find(p => p.id === request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      const godot = await godotIndex.isGodotProject(project.path);
      if (!godot) return { godot: false, root: project.path };
      const index = await godotIndex.getIndex(project.path, request.query.refresh === '1');
      return { godot: true, ...index };
    }
  );
}
