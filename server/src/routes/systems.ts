import { FastifyInstance } from 'fastify';
import * as projectDiscovery from '../services/projectDiscovery.js';
import * as systems from '../services/systemCatalog.js';
import * as knowledge from '../services/systemKnowledge.js';
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
    // A catalog that cannot be read is reported as such (with its reason), never as an empty list.
    try { return await systems.catalog(project, request.query.worktree); }
    catch (e: any) { return reply.status(500).send({ error: String(e?.message ?? e) }); }
  });

  // Read-only: where this catalog lives (data dir, identity, last read) and any other catalog for the same project.
  app.get<Q>('/api/projects/:id/systems/catalog-source', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    try { return await systems.catalogSourceReport(project); }
    catch (e: any) { return reply.status(500).send({ error: String(e?.message ?? e) }); }
  });

  // Explicit, add-only import from another data dir on this machine (backup + manifest; conflicts block everything).
  app.post<{ Params: { id: string }; Body: { fromDir?: string; expectedSourceSha256?: string; expectedTargetSha256?: string | null } }>('/api/projects/:id/systems/catalog-source/import', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const b = request.body ?? {};
    if (!b.fromDir || !/^[a-f0-9]{64}$/.test(b.expectedSourceSha256 ?? '')) return reply.status(400).send({ error: 'fromDir and expectedSourceSha256 are required' });
    try {
      const r = await systems.importFromCatalog(project, { fromDir: b.fromDir, expectedSourceSha256: b.expectedSourceSha256!, expectedTargetSha256: b.expectedTargetSha256 ?? null });
      if (r.conflicts.length) return reply.status(409).send({ error: `Nothing was imported: ${r.conflicts.length} system(s) conflict with the active catalog`, conflicts: r.conflicts });
      return r;
    } catch (e: any) { return reply.status(409).send({ error: String(e?.message ?? e) }); }
  });

  // Candidates from file names only; idempotent, adds nothing that an existing system already owns.
  app.post<Q>('/api/projects/:id/systems/discover', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const res = await systems.discover(project, request.query.worktree);
    if ('error' in res) return reply.status(400).send(res);
    return res;
  });

  // Read-only: published (git revision) + local catalog + evidence of the examined checkout.
  app.get<{ Params: { id: string }; Querystring: { worktree?: string; revision?: string } }>('/api/projects/:id/systems/knowledge', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const r = await knowledge.reconcile(project, { worktree: request.query.worktree, revision: request.query.revision });
    if ('error' in r) return reply.status(400).send(r);
    return r;
  });

  // Explicit update of the existing portable file; refuses when the file changed since `expectedSha256`.
  app.post<{ Params: { id: string }; Body: knowledge.UpdateOptions }>('/api/projects/:id/systems/knowledge/update', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    try { return await knowledge.updatePortable(project, request.body ?? ({} as knowledge.UpdateOptions)); }
    catch (e: any) { return reply.status(409).send({ error: String(e?.message ?? e) }); }
  });

  // Read-only previews of the three explicit operations (nothing is written). Writes target the project's own
  // checkout; a worktree or a past revision can be inspected but not published from here.
  app.get<{ Params: { id: string } }>('/api/projects/:id/systems/knowledge/plan', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const [exportPlan, update, imp] = await Promise.all([knowledge.previewExport(project), knowledge.previewUpdate(project), knowledge.previewImport(project)]);
    return { export: exportPlan, update, import: imp };
  });

  // Bootstrap of a repository with no commits: one empty commit, no files staged. UI only; refuses otherwise.
  app.post<{ Params: { id: string } }>('/api/projects/:id/systems/knowledge/first-commit', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    try { return await knowledge.createFirstCommit(project); }
    catch (e: any) { return reply.status(409).send({ error: String(e?.message ?? e) }); }
  });

  // Initial export: refuses to overwrite (exportPortable). Never stages or commits.
  app.post<{ Params: { id: string }; Body: { systemIds?: string[] } }>('/api/projects/:id/systems/knowledge/export', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    try { await systems.exportPortable(project, { systemIds: request.body?.systemIds }); return { sha256: await knowledge.portableSha256(project) }; }
    catch (e: any) { return reply.status(409).send({ error: String(e?.message ?? e) }); }
  });

  // Import of a recovered file: all-or-nothing; any changed or duplicate system blocks it (no auto-resolution).
  app.post<{ Params: { id: string }; Body: { expectedSha256?: string } }>('/api/projects/:id/systems/knowledge/import', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    if (!/^[a-f0-9]{64}$/.test(request.body?.expectedSha256 ?? '')) return reply.status(400).send({ error: 'expectedSha256 is required' });
    try {
      const r = await systems.importPortable(project, { expectedSha256: request.body!.expectedSha256 });
      if (r.conflicts.length) return reply.status(409).send({ error: `Nothing was imported: ${r.conflicts.length} system(s) conflict with the local catalog`, conflicts: r.conflicts });
      return r;
    } catch (e: any) { return reply.status(409).send({ error: String(e?.message ?? e) }); }
  });

  app.get<{ Params: { id: string; sid: string }; Querystring: { worktree?: string } }>('/api/projects/:id/systems/:sid', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const v = await systems.resolveSystem(project, request.params.sid, request.query.worktree);
    if ('error' in v) return reply.status(404).send(v);
    return v;
  });

  app.get<{ Params: { id: string; sid: string }; Querystring: { worktree?: string; goal?: string; area?: string } }>('/api/projects/:id/systems/:sid/brief', async (request, reply) => {
    const project = await resolve(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const v = await systems.resolveSystem(project, request.params.sid, request.query.worktree);
    if ('error' in v) return reply.status(404).send(v);
    return { text: systems.brief(v, request.query.goal, request.query.area), head: v.checkout.head, root: v.checkout.root };
  });

  app.post<{ Params: { id: string }; Body: systems.ProposalInput }>('/api/projects/:id/systems', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const b = request.body;
    if (!b?.name?.trim()) return reply.status(400).send({ error: 'name is required' });
    return systems.propose(request.params.id, b, 'user');
  });

  app.patch<{ Params: { id: string; sid: string }; Body: systems.Edit }>('/api/projects/:id/systems/:sid', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    try {
      const s = await systems.review(request.params.id, request.params.sid, request.body ?? {});
      return s ?? reply.status(404).send({ error: 'System not found' });
    } catch (e: any) { return reply.status(400).send({ error: String(e?.message ?? e) }); }
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
