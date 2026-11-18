import { FastifyInstance } from 'fastify';
import { readFile, stat, open } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getProjects } from '../services/projectDiscovery.js';
import { resolveForProject, type Origin } from '../services/godot/context.js';
import { classify } from '../services/godot/classify.js';
import * as harness from '../services/godot/harness.js';
import * as runs from '../services/godot/runs.js';
import { sessionsIn, sessionWarnings } from '../services/godot/instances.js';
import { fromAppUi } from './design.js';

/**
 * Godot execution routes. Reading (context, status, runs, evidence) is open. Opening the editor, starting a run and
 * cancelling one start processes on this machine, so — like acceptance and integration — they are only served to
 * requests that look like the app's own renderer, and there is deliberately no MCP tool for them. Nothing here runs
 * on open: every run is an explicit POST. No route takes a directory: the checkout is resolved from project/task.
 */

const MAX_EVIDENCE_BYTES = 256 * 1024;

interface Sel { taskId?: string; checkout?: string; file?: string; origin?: string }
const asSel = (q: Sel) => ({
  taskId: q.taskId || undefined,
  checkout: (q.checkout || undefined) as 'main' | 'task' | undefined,
  file: q.file || undefined,
  origin: (['project', 'task', 'editor'].includes(String(q.origin)) ? q.origin : undefined) as Origin | undefined,
});

export async function godotRoutes(app: FastifyInstance) {
  const project = async (id: string) => (await getProjects()).find(p => p.id === id);
  const uiOnly = (request: any, reply: any) => {
    if (fromAppUi(request.headers)) return true;
    reply.status(403).send({ ok: false, code: 'ui-only', message: 'Opening Godot and running scenes or tests can only be done from the JabutiStudio UI' });
    return false;
  };

  // Is this a Godot project at all, and can this machine run the Harness?
  app.get<{ Params: { id: string } }>('/api/projects/:id/godot/status', async (request, reply) => {
    const p = await project(request.params.id);
    if (!p) return reply.status(404).send({ error: 'Project not found' });
    const godotProject = existsSync(join(p.path, 'project.godot'));
    if (!godotProject) return { godotProject: false };
    const d = await harness.doctor();
    return d.ok
      ? { godotProject: true, harness: { ready: true, godot: d.godot, version: d.version, dir: d.harness.dir, source: d.harness.source } }
      : { godotProject: true, harness: { ready: false, code: d.code, message: d.message } };
  });

  // The resolved Execution Context for a selection, plus what the file is and which actions that justifies.
  app.get<{ Params: { id: string }; Querystring: Sel }>('/api/projects/:id/godot/context', async (request, reply) => {
    const p = await project(request.params.id);
    if (!p) return reply.status(404).send({ error: 'Project not found' });
    const ctx = await resolveForProject(p, { projectId: p.id, ...asSel(request.query) });
    if (!ctx.ok) return { context: ctx };
    const sessions = await sessionsIn(ctx.checkoutPath);
    return {
      context: ctx, classification: ctx.file ? await classify(ctx.checkoutPath, ctx.file.rel) : null,
      mainScene: await runs.mainScene(ctx.checkoutPath), tests: await runs.listTestScenes(ctx.checkoutPath), sessions, warnings: sessionWarnings(sessions, ctx.taskId),
    };
  });

  app.post<{ Params: { id: string }; Body: Sel }>('/api/projects/:id/godot/open', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const res = await runs.openInGodot({ projectId: request.params.id, ...asSel(request.body || {}) });
    return res.ok ? res : reply.status(res.status).send(res);
  });

  // Interactive game for a human playtest. Not a Harness run: no receipt, and nothing about it implies PASS or acceptance.
  app.post<{ Params: { id: string }; Body: Sel }>('/api/projects/:id/godot/play', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const res = await runs.playGame({ projectId: request.params.id, ...asSel(request.body || {}) });
    return res.ok ? res : reply.status(res.status).send(res);
  });

  app.post<{ Params: { id: string }; Body: Sel & { action?: string; via?: string; mode?: string; profile?: string } }>('/api/projects/:id/godot/runs', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const b = request.body || {};
    const res = await runs.startGodotRun({
      projectId: request.params.id, ...asSel(b), file: String(b.file ?? ''), action: b.action as 'scene' | 'test',
      via: b.via || undefined, mode: b.mode as any, profile: b.profile as any,
    });
    return res.ok ? res : reply.status(res.status).send(res);
  });

  // Runs of a file (and of the files provably related to it), newest first.
  app.get<{ Params: { id: string }; Querystring: { file?: string; taskId?: string; limit?: string } }>('/api/projects/:id/godot/runs', async (request, reply) => {
    const p = await project(request.params.id);
    if (!p) return reply.status(404).send({ error: 'Project not found' });
    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 30));
    const file = request.query.file ? (await resolveForProject(p, { projectId: p.id, file: request.query.file })) : null;
    if (file && !file.ok) return reply.status(400).send(file);
    const records = file?.ok ? await runs.recordsForFile(p.id, file.checkoutPath, file.file!.rel)
      : (await runs.listRecords(p.id)).filter(r => !request.query.taskId || r.taskId === request.query.taskId);
    const items = [];
    for (const r of records.slice(0, limit)) {
      const v = await runs.viewRun(r);
      items.push({ record: r, running: v.running, verdict: { outcome: v.verdict.outcome, headline: v.verdict.headline, harnessStatus: v.verdict.harnessStatus, reason: v.verdict.reason } });
    }
    return { runs: items };
  });

  app.get<{ Params: { id: string; runId: string } }>('/api/projects/:id/godot/runs/:runId', async (request, reply) => {
    const rec = await runs.getRecord(request.params.id, request.params.runId);
    if (!rec) return reply.status(404).send({ error: 'Run not found' });
    return runs.viewRun(rec);
  });

  // Logs, receipt and screenshots of a run: only files the runner is known to write, only for a recorded run.
  app.get<{ Params: { id: string; runId: string }; Querystring: { name?: string } }>('/api/projects/:id/godot/runs/:runId/evidence', async (request, reply) => {
    const rec = await runs.getRecord(request.params.id, request.params.runId);
    if (!rec) return reply.status(404).send({ error: 'Run not found' });
    const loc = harness.locateHarness();
    if (!loc.ok) return reply.status(409).send({ error: loc.message });
    const path = harness.evidencePath(loc, rec.runId, String(request.query.name ?? ''));
    if (!path) return reply.status(400).send({ error: 'Not an evidence file of a Harness run' });
    try {
      const st = await stat(path);
      if (path.endsWith('.png')) return reply.type('image/png').send(await readFile(path));
      // Logs can be large: the tail is what explains a failure.
      const fh = await open(path, 'r');
      try {
        const len = Math.min(st.size, MAX_EVIDENCE_BYTES);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, st.size - len);
        return reply.type('text/plain; charset=utf-8').header('X-Truncated', st.size > len ? '1' : '0').send(buf.toString('utf-8').replace(/^﻿/, ''));
      } finally { await fh.close(); }
    } catch {
      return reply.status(404).send({ error: 'That evidence file does not exist for this run' });
    }
  });

  app.post<{ Params: { id: string; runId: string } }>('/api/projects/:id/godot/runs/:runId/cancel', async (request, reply) => {
    if (!uiOnly(request, reply)) return;
    const res = await runs.cancel(request.params.id, request.params.runId);
    return res.ok ? res : reply.status(res.status).send(res);
  });
}
