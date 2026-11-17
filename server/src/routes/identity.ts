import type { FastifyInstance } from 'fastify';

/**
 * Version of the identity contract between this server and the Electron bootstrap. Electron reuses a
 * backend that is already listening on the port only when this number matches its own. Bump it when
 * either side stops understanding the other.
 */
export const SERVER_PROTOCOL = 1;

/**
 * Lets a launcher tell a JabutiStudio backend from any other process on the port. Answering at all means
 * the server is listening and its routes are registered, which is what "healthy" means here.
 */
export async function identityRoutes(app: FastifyInstance, opts: { serveClient: boolean }) {
  app.get('/api/identity', async () => ({
    app: 'jabutistudio',
    protocol: SERVER_PROTOCOL,
    serveClient: opts.serveClient,
    status: 'ok',
  }));
}
