import { FastifyInstance } from 'fastify';
import { getProjects } from '../services/projectDiscovery.js';
import * as inv from '../services/worktreeInventory.js';
import { fromAppUi } from './design.js';
import * as log from '../services/logService.js';

/**
 * Worktree inventory routes (R2-A2). Everything is read-only except linking and
 * unlinking, which only write the link file and are served — like accepting and
 * integrating — to requests that look like the app renderer. No route here removes
 * anything: closing lives with the task lifecycle (`/lifecycle/close`).
 */
export async function worktreeInventoryRoutes(app: FastifyInstance) {
  const find = async (id: string) => (await getProjects()).find(p => p.id === id);
  const uiOnly = (request: any, reply: any) => {
    if (fromAppUi(request.headers)) return true;
    reply.status(403).send({ ok: false, code: 'ui-only', message: 'Linking worktrees can only be done from the JabutiStudio UI' });
    return false;
  };

  app.get<{ Params: { id: string } }>('/api/projects/:id/worktrees/inventory', async (request, reply) => {
    const project = await find(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return inv.inventory(project);
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/projects/:id/worktrees/changes', async (request, reply) => {
    const project = await find(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    if (!request.query.path) return reply.status(400).send({ ok: false, code: 'path-required', message: 'path is required' });
    const res = await inv.worktreeChanges(project, request.query.path);
    return res.ok ? res : reply.status(res.code === 'not-registered' ? 404 : 409).send(res);
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string; file?: string } }>('/api/projects/:id/worktrees/diff', async (request, reply) => {
    const project = await find(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const { path, file } = request.query;
    if (!path || !file) return reply.status(400).send({ ok: false, code: 'path-required', message: 'path and file are required' });
    const res = await inv.worktreeDiff(project, path, file);
    return res.ok ? res : reply.status(res.code === 'not-registered' ? 404 : 400).send(res);
  });

  app.post<{ Params: { id: string }; Body: { taskId?: string; path?: string } }>('/api/projects/:id/worktrees/link', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const project = await find(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const { taskId, path } = request.body || {};
    if (!taskId || !path) return reply.status(400).send({ ok: false, code: 'bad-request', message: 'taskId and path are required' });
    const res = await inv.linkWorktree(project, taskId, path);
    if (!res.ok) return reply.status(res.code === 'task-not-found' ? 404 : 409).send(res);
    if (!res.already) log.info('git', `Worktree linked to task ${taskId}`, `${res.link.branch} -> ${res.link.path}`, project.id);
    return res;
  });

  app.delete<{ Params: { id: string; taskId: string } }>('/api/projects/:id/worktrees/link/:taskId', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const project = await find(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const res = await inv.unlinkWorktree(project, request.params.taskId);
    if (res.removed) log.info('git', `Worktree unlinked from task ${request.params.taskId}`, 'the worktree itself was not touched', project.id);
    return res;
  });
}
