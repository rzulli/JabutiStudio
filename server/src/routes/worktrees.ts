import { FastifyInstance } from 'fastify';
import * as worktreeService from '../services/worktreeService.js';
import * as log from '../services/logService.js';

export async function worktreeRoutes(app: FastifyInstance) {
  // Config plus every worktree Shipyard currently tracks
  app.get('/api/worktrees', async () => {
    const [config, worktrees] = await Promise.all([
      worktreeService.getConfig(),
      worktreeService.listWorktrees(),
    ]);
    return {
      ...config,
      defaultBasePath: worktreeService.DEFAULT_WORKTREE_DIR,
      ttlDays: worktreeService.WORKTREE_TTL_DAYS,
      worktrees,
    };
  });

  app.put<{ Body: { enabled?: boolean; basePath?: string | null } }>(
    '/api/worktrees',
    async (request, reply) => {
      try {
        const config = await worktreeService.saveConfig(request.body || {});
        log.info('git', `Worktree per task ${config.enabled ? 'enabled' : 'disabled'}`, config.basePath);
        return { ...config, defaultBasePath: worktreeService.DEFAULT_WORKTREE_DIR, ttlDays: worktreeService.WORKTREE_TTL_DAYS };
      } catch (err: any) {
        return reply.status(400).send({ error: err.message });
      }
    }
  );

  // Legacy "Clean worktrees". It no longer removes anything (R2-A3): it only forgets git
  // records of folders that are already gone. Removal is the safe close, per task.
  app.post('/api/worktrees/clean', async () => {
    const result = await worktreeService.cleanupWorktrees();
    return {
      ...result,
      message: 'Nothing was removed. Close a worktree from its task (Review tab) or the "worktrees" badge in Source Control: it checks Git, files and sessions first.',
    };
  });
}
