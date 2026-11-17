import { FastifyInstance } from 'fastify';
import * as taskStore from '../services/taskStore.js';
import { getProjects } from '../services/projectDiscovery.js';
import * as lifecycle from '../services/taskLifecycle.js';
import * as closer from '../services/worktreeClose.js';
import { withLink } from '../services/worktreeLinks.js';
import { invalidateInventory } from '../services/worktreeInventory.js';
import { fromAppUi } from './design.js';
import { triggerAutoSync } from '../services/sync/syncEngine.js';
import * as log from '../services/logService.js';

async function sessionsFor(projectId: string, taskId: string): Promise<lifecycle.SessionLite[]> {
  try {
    const { listSessions } = await import('../services/terminalService.js');
    return listSessions(projectId)
      .filter(s => s.taskId === taskId)
      .map(s => ({ id: s.id, taskId: s.taskId, agent: s.agent, type: s.type, state: s.state ?? null, cwd: s.cwd, claudeSessionId: s.claudeSessionId }));
  } catch {
    return []; // terminal layer unavailable: no live sessions to report
  }
}

/**
 * Task lifecycle routes. Reads are open. Accepting, revoking and integrating
 * change what the project's history says, so — like the design approvals —
 * they are only served to requests that look like the app's own renderer. An
 * MCP client, hook or plain curl gets 403; there is deliberately no MCP tool
 * for them. Forgeable by any local process (see taskLifecycleStore.ts).
 */
export async function taskLifecycleRoutes(app: FastifyInstance) {
  const load = async (projectId: string, taskId: string) => {
    const project = (await getProjects()).find(p => p.id === projectId);
    const raw = project ? await taskStore.getTask(projectId, taskId) : undefined;
    // A worktree a person linked by hand is seen by the lifecycle as if the task owned it; the task file is not written.
    const task = raw ? await withLink(raw) : undefined;
    return { project, task, raw };
  };
  const uiOnly = (request: any, reply: any) => {
    if (fromAppUi(request.headers)) return true;
    reply.status(403).send({ ok: false, code: 'ui-only', message: 'Accepting and integrating can only be done from the JabutiStudio UI' });
    return false;
  };
  const status = (code: string) => (code === 'not-accepted' || code === 'target-required' || code === 'head-required' || code === 'token-required' ? 400 : 409);

  app.get<{ Params: { id: string; taskId: string }; Querystring: { target?: string } }>(
    '/api/projects/:id/tasks/:taskId/lifecycle',
    async (request, reply) => {
      const { project, task } = await load(request.params.id, request.params.taskId);
      if (!project || !task) return reply.status(404).send({ error: 'Task not found' });
      return lifecycle.resolveLifecycle(project, task, { target: request.query.target, sessions: await sessionsFor(project.id, task.id) });
    },
  );

  // One call for the whole board: the stage of every task that has a worktree branch.
  app.get<{ Params: { id: string } }>('/api/projects/:id/lifecycle/summary', async (request, reply) => {
    const project = (await getProjects()).find(p => p.id === request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return { tasks: await lifecycle.summarizeProject(project) };
  });

  // A write changes what the summary says; do not serve the 5 s cache after it.
  app.addHook('onResponse', async (request) => {
    if (request.method !== 'GET') {
      const id = (request.params as { id?: string })?.id ?? '';
      lifecycle.invalidateSummary(id);
      invalidateInventory(id);
    }
  });

  app.post<{ Params: { id: string; taskId: string }; Body: { targetBranch?: string; expectedHeadSha?: string; note?: string } }>(
    '/api/projects/:id/tasks/:taskId/lifecycle/accept',
    async (request, reply) => {
      if (!uiOnly(request, reply)) return;
      const { project, task } = await load(request.params.id, request.params.taskId);
      if (!project || !task) return reply.status(404).send({ error: 'Task not found' });
      const res = await lifecycle.accept(project, task, { ...(request.body || {}), sessions: await sessionsFor(project.id, task.id) });
      if (!res.ok) return reply.status(status(res.code)).send(res);
      log.info('git', `Task #${task.number ?? task.id} accepted`, res.view.acceptance.record?.headSha, project.id);
      return res;
    },
  );

  app.delete<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId/lifecycle/accept',
    async (request, reply) => {
      if (!uiOnly(request, reply)) return;
      const { project, task } = await load(request.params.id, request.params.taskId);
      if (!project || !task) return reply.status(404).send({ error: 'Task not found' });
      const res = await lifecycle.revokeAcceptance(project, task, await sessionsFor(project.id, task.id));
      return res.ok ? res : reply.status(status(res.code)).send(res);
    },
  );

  app.post<{ Params: { id: string; taskId: string }; Body: { targetBranch?: string; expectedHeadSha?: string; branch?: string } }>(
    '/api/projects/:id/tasks/:taskId/lifecycle/integrate',
    async (request, reply) => {
      if (!uiOnly(request, reply)) return;
      const { project, task } = await load(request.params.id, request.params.taskId);
      if (!project || !task) return reply.status(404).send({ error: 'Task not found' });
      const res = await lifecycle.integrate(project, task, { ...(request.body || {}), sessions: await sessionsFor(project.id, task.id) });
      if (!res.ok) return reply.status(status(res.code)).send(res);
      log.info('git', `Task #${task.number ?? task.id} integrated`, res.view.integration.mergeCommit, project.id);
      triggerAutoSync(project.id);
      return res;
    },
  );

  // What closing would do, and why not when it cannot. Read-only; the token names the exact state shown.
  app.get<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId/lifecycle/close-preview',
    async (request, reply) => {
      const { project, raw } = await load(request.params.id, request.params.taskId);
      if (!project || !raw) return reply.status(404).send({ error: 'Task not found' });
      return closer.previewClose(project, raw);
    },
  );

  // Remove the worktree and, if proven integrated, the branch. UI-only; every precondition is re-read from Git.
  app.post<{ Params: { id: string; taskId: string }; Body: { expectedToken?: string; acknowledgeIgnored?: boolean } }>(
    '/api/projects/:id/tasks/:taskId/lifecycle/close',
    async (request, reply) => {
      if (!uiOnly(request, reply)) return;
      const { project, raw } = await load(request.params.id, request.params.taskId);
      if (!project || !raw) return reply.status(404).send({ error: 'Task not found' });
      const res = await closer.closeTask(project, raw, { expectedToken: request.body?.expectedToken, acknowledgeIgnored: request.body?.acknowledgeIgnored === true });
      invalidateInventory(project.id);
      if (!res.ok) return reply.status(status(res.code)).send(res);
      log.info('git', `Task #${raw.number ?? raw.id} closed (${res.complete ? 'complete' : 'partial'})`, JSON.stringify(res.result), project.id);
      triggerAutoSync(project.id);
      return res;
    },
  );
}
