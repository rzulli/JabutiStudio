import { join } from 'path';
import { mkdir, readFile, readdir } from 'fs/promises';
import { spawn } from 'child_process';
import { DATA_DIR } from '../dataDir.js';
import { writeJsonAtomic } from '../atomicJson.js';
import { getProjects } from '../projectDiscovery.js';
import * as log from '../logService.js';
import { resolveForProject, sameCheckout, type ContextRequest, type ExecutionContext, type Refusal } from './context.js';
import { classify, isVerifiedRelated, scriptsOfScene, DEFAULT_MARKER } from './classify.js';
import * as harness from './harness.js';
import { runningInstance, rememberInstance, sessionsIn, sessionWarnings, type GuiKind, type SessionInCheckout } from './instances.js';

/**
 * Godot runs, tied to what started them.
 *
 * The Harness owns every artifact (receipt, logs, screenshots) under its own `runs/<id>/`. A receipt does not say which
 * task, worktree or editor file a run came from, so this file keeps ONE small index entry per run: the provenance
 * captured at launch plus the Harness run id. The receipt is never copied or converted; results are read from it.
 */

export interface RunRecord {
  runId: string;
  projectId: string;
  action: 'scene' | 'test';
  /** Project-relative file that was run, and the script it was reached from (Run Related Test). */
  file: string;
  res: string;
  via?: string;
  taskId?: string;
  taskNumber?: number;
  taskTitle?: string;
  origin: ExecutionContext['origin'];
  checkout: {
    path: string; source: 'project' | 'task'; isMainCheckout: boolean; reason: string;
    branch: string | null; head: string | null; detached: boolean;
    dirtyAtStart: { count: number; files: string[] } | null;
    reproducibleFromSha: boolean;
    notes: string[];
  };
  params: { mode: string; profile: string; marker: string };
  harness: { dir: string; script: string; source: string; godot: string; godotVersion: string | null };
  command: string[];
  startedAt: string;
  runner?: { exitCode: number | null; endedAt: string; stderrTail?: string; error?: string };
}

interface Store { version: 1; runs: RunRecord[] }
export const MAX_RECORDS = 300;
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9._-]/g, '_');
const storePath = (projectId: string) => join(DATA_DIR, 'godot-runs', `${safeId(projectId)}.json`);

const chains = new Map<string, Promise<unknown>>();
function withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(projectId) ?? Promise.resolve()).then(fn, fn);
  chains.set(projectId, run.catch(() => undefined));
  return run;
}

async function read(projectId: string): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(storePath(projectId), 'utf-8'));
    if (parsed && Array.isArray(parsed.runs)) return parsed as Store;
  } catch { /* none yet */ }
  return { version: 1, runs: [] };
}

function mutate<T>(projectId: string, fn: (s: Store) => T): Promise<T> {
  return withLock(projectId, async () => {
    const s = await read(projectId);
    const out = fn(s);
    s.runs = s.runs.slice(0, MAX_RECORDS); // newest first; only index lines age out, never Harness artifacts
    await mkdir(join(DATA_DIR, 'godot-runs'), { recursive: true });
    await writeJsonAtomic(storePath(projectId), s);
    return out;
  });
}

export const listRecords = async (projectId: string) => (await read(projectId)).runs;
export async function getRecord(projectId: string, runId: string) { return (await read(projectId)).runs.find(r => r.runId === runId); }

export type Failure = { ok: false; status: number; code: string; message: string; options?: Refusal['options'] };
const fail = (status: number, code: string, message: string, options?: Refusal['options']): Failure => ({ ok: false, status, code, message, options });
const fromRefusal = (r: Refusal): Failure => ({ ok: false, status: r.code === 'project-not-found' || r.code === 'task-not-found' ? 404 : r.code === 'task-without-worktree' || r.code === 'worktree-missing' || r.code === 'worktree-unregistered' ? 409 : 400, code: r.code, message: r.message, options: r.options });

// -- Open in Godot / Play Game ---------------------------------------------------------------------------

export interface OpenInput extends ContextRequest { }
export interface OpenResult {
  ok: true; kind: GuiKind; context: ExecutionContext; godot: string; version: string | null; pid: number | null; args: string[];
  openedPath: string; scene?: string; note?: string; warnings: string[]; sessions: SessionInCheckout[];
}

/** Same navigation the Harness `editor` action uses: `--path <checkout> --editor [scene relative to res://]`. */
export function editorArgs(ctx: ExecutionContext): { args: string[]; scene?: string } {
  const args = ['--path', ctx.checkoutPath, '--editor'];
  if (ctx.file?.ext === '.tscn') { args.push(ctx.file.rel); return { args, scene: ctx.file.rel }; }
  return { args };
}

/** `run/main_scene` of the checkout's own project.godot (the game a person would press Play on). */
export async function mainScene(checkoutPath: string): Promise<string | null> {
  try {
    const text = await readFile(join(checkoutPath, 'project.godot'), 'utf-8');
    const m = /^\s*run\/main_scene\s*=\s*"([^"]+)"/m.exec(text);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * Start a graphical Godot window on the resolved checkout, detached, argument array, no shell. `editor` opens the
 * editor (never runs the game); `play` runs the game interactively for a human. Neither writes a Harness receipt, so
 * neither can ever read as a PASS. A window this server already started for the same checkout is not duplicated.
 */
async function launchGui(kind: GuiKind, input: OpenInput): Promise<OpenResult | Failure> {
  const project = (await getProjects()).find(p => p.id === input.projectId);
  if (!project) return fail(404, 'project-not-found', 'Project not found.');
  const ctx = await resolveForProject(project, input);
  if (!ctx.ok) return fromRefusal(ctx);
  const d = await harness.doctor();
  if (!d.ok) return fail(409, d.code, d.message);

  const running = runningInstance(ctx.checkoutPath, kind);
  if (running) return fail(409, 'already-running', `Godot (${kind === 'play' ? 'game' : 'editor'}) is already open on ${ctx.checkoutPath} (pid ${running.pid}, started ${running.startedAt}). Close that window first; nothing new was started.`);

  let args: string[]; let scene: string | undefined; let note: string | undefined;
  if (kind === 'editor') {
    ({ args, scene } = editorArgs(ctx));
    note = ctx.file && !scene ? `${ctx.file.rel} is not a scene: the editor opened on the project. Open the file from Godot's FileSystem dock.` : undefined;
  } else {
    const main = await mainScene(ctx.checkoutPath);
    if (!main) return fail(409, 'no-main-scene', `project.godot in ${ctx.checkoutPath} sets no run/main_scene, so there is no main scene to play. Open the editor and choose one, or run a specific scene.`);
    args = ['--path', ctx.checkoutPath];
    scene = main;
    note = `Interactive session of ${main}. It is not a Harness run: no receipt, no assertions, no acceptance.`;
  }

  const started = await new Promise<{ pid: number | null; error?: string; earlyExit?: number | null }>(resolveP => {
    let settled = false;
    const done = (v: { pid: number | null; error?: string; earlyExit?: number | null }) => { if (!settled) { settled = true; resolveP(v); } };
    const child = spawn(d.godot, args, { cwd: ctx.checkoutPath, detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    child.on('error', e => done({ pid: null, error: e.message }));
    child.on('exit', code => done({ pid: child.pid ?? null, earlyExit: code }));
    setTimeout(() => { child.unref(); done({ pid: child.pid ?? null }); }, 1500);
  });
  if (started.error) return fail(500, 'launch-failed', `Could not start Godot (${d.godot}): ${started.error}`);
  if (started.earlyExit !== undefined) return fail(500, 'launch-failed', `Godot exited immediately with code ${started.earlyExit} while starting on ${ctx.checkoutPath}.`);
  if (started.pid) rememberInstance(ctx.checkoutPath, kind, started.pid);

  const sessions = await sessionsIn(ctx.checkoutPath);
  const warnings = sessionWarnings(sessions, ctx.taskId);
  if (ctx.dirty && ctx.dirty.count > 0) warnings.push(`${ctx.dirty.count} uncommitted change(s) were present at start; what runs is not what the commit contains.`);
  log.info('files', kind === 'play' ? 'Started Godot game' : 'Opened Godot editor', `${ctx.checkoutPath}${scene ? ` @ ${scene}` : ''}`, project.id);
  return { ok: true, kind, context: ctx, godot: d.godot, version: d.version, pid: started.pid, args, openedPath: ctx.checkoutPath, scene, note, warnings, sessions };
}

export const openInGodot = (input: OpenInput) => launchGui('editor', input);
export const playGame = (input: OpenInput) => launchGui('play', input);

/** Test scenes a checkout declares by location (`tests/**.tscn`), project-relative. A scene is only a test by being there. */
export async function listTestScenes(checkoutPath: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string, depth: number) => {
    if (depth > 4 || out.length >= 100) return;
    let entries;
    try { entries = await readdir(join(checkoutPath, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== '.godot' && e.name !== 'addons') await walk(r, depth + 1); }
      else if (e.isFile() && e.name.endsWith('.tscn')) out.push(r);
    }
  };
  await walk('tests', 0);
  return out.sort();
}

/**
 * Scripts under tests/ that no test scene under tests/ attaches. They are candidates for a human to look at, never
 * runnable: a .gd is not a Harness target, and nothing proves which scene (if any) would exercise it.
 */
export async function listUnattachedTestScripts(checkoutPath: string, testScenes: string[]): Promise<string[]> {
  const attached = new Set<string>();
  for (const scene of testScenes) {
    try { for (const s of scriptsOfScene(await readFile(join(checkoutPath, scene), 'utf-8'))) attached.add(s); } catch { /* unreadable scene: nothing attached */ }
  }
  const out: string[] = [];
  const walk = async (rel: string, depth: number) => {
    if (depth > 4 || out.length >= 100) return;
    let entries;
    try { entries = await readdir(join(checkoutPath, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== '.godot' && e.name !== 'addons') await walk(r, depth + 1); }
      else if (e.isFile() && e.name.endsWith('.gd') && !attached.has(r)) out.push(r);
    }
  };
  await walk('tests', 0);
  return out.sort();
}

// -- Run Scene / Run Test -----------------------------------------------------------------------------

export interface RunInput extends ContextRequest {
  file: string;
  action: 'scene' | 'test';
  /** The script the person started from ("Run Related Test"); must be proven to attach this test scene. */
  via?: string;
  mode?: 'HEADLESS' | 'RENDER_BACKGROUND';
  profile?: 'probe' | 'smoke' | 'integration';
}

export async function startGodotRun(input: RunInput): Promise<{ ok: true; record: RunRecord } | Failure> {
  if (input.action !== 'scene' && input.action !== 'test') return fail(400, 'bad-action', 'action must be "scene" or "test".');
  if (!input.file) return fail(400, 'bad-file', 'file is required.');
  const mode = input.mode ?? 'HEADLESS';
  if (mode !== 'HEADLESS' && mode !== 'RENDER_BACKGROUND') return fail(400, 'bad-mode', 'mode must be HEADLESS or RENDER_BACKGROUND.');
  const profile = input.profile ?? (input.action === 'test' ? 'smoke' : 'probe');
  if (!['probe', 'smoke', 'integration'].includes(profile)) return fail(400, 'bad-profile', 'profile must be probe, smoke or integration.');

  const project = (await getProjects()).find(p => p.id === input.projectId);
  if (!project) return fail(404, 'project-not-found', 'Project not found.');
  const ctx = await resolveForProject(project, input);
  if (!ctx.ok) return fromRefusal(ctx);
  const file = ctx.file!;
  if (file.ext !== '.tscn') return fail(400, 'not-a-scene', `${file.rel} is not a scene. Scripts are never executed on their own.`);

  const cls = await classify(ctx.checkoutPath, file.rel);
  if (input.action === 'test' && cls.kind !== 'test-scene') return fail(400, 'not-a-test', `${file.rel} is not a test scene (no tests/ location evidence), so Run Test is refused.`);
  if (input.action === 'scene' && cls.kind !== 'scene') return fail(400, 'not-a-plain-scene', `${file.rel} is a test scene: use Run Test.`);
  let via: string | undefined;
  if (input.via) {
    if (input.action !== 'test') return fail(400, 'bad-via', 'via only applies to Run Related Test.');
    const viaCtx = await resolveForProject(project, { ...input, file: input.via });
    if (!viaCtx.ok) return fromRefusal(viaCtx);
    if (!(await isVerifiedRelated(ctx.checkoutPath, viaCtx.file!.rel, file.rel))) {
      return fail(400, 'unproven-relation', `${file.rel} is not provably related to ${viaCtx.file!.rel} (no scene attaches that script). Open the scene and run it from there.`);
    }
    via = viaCtx.file!.rel;
  }

  const d = await harness.doctor();
  if (!d.ok) return fail(409, d.code, d.message);

  // Two runs in one checkout would fight over the same .godot import cache.
  for (const [id, path] of activeCheckout) {
    if (harness.live.get(id)?.exited === false && sameCheckout(path, ctx.checkoutPath)) {
      return fail(409, 'run-active', `Run ${id} is still using ${ctx.checkoutPath}. Wait for it or cancel it first.`);
    }
  }

  const runId = harness.newRunId();
  const spec: harness.RunSpec = { runId, projectRoot: ctx.checkoutPath, testRes: file.res, mode, profile, marker: DEFAULT_MARKER };
  const record: RunRecord = {
    runId, projectId: project.id, action: input.action, file: file.rel, res: file.res, via,
    taskId: ctx.taskId, taskNumber: ctx.taskNumber, taskTitle: ctx.taskTitle, origin: ctx.origin,
    checkout: {
      path: ctx.checkoutPath, source: ctx.source, isMainCheckout: ctx.isMainCheckout, reason: ctx.reason,
      branch: ctx.branch, head: ctx.head, detached: ctx.detached, dirtyAtStart: ctx.dirty, reproducibleFromSha: ctx.reproducibleFromSha, notes: ctx.notes,
    },
    params: { mode, profile, marker: DEFAULT_MARKER },
    harness: { dir: d.harness.dir, script: d.harness.script, source: d.harness.source, godot: d.godot, godotVersion: d.version },
    command: [], startedAt: new Date().toISOString(),
  };
  // The record exists before the runner does: a run is never launched without its provenance.
  await mutate(project.id, s => { s.runs.unshift(record); });
  activeCheckout.set(runId, ctx.checkoutPath);

  const { command } = harness.startRun(d, spec, exit => {
    void mutate(project.id, s => {
      const r = s.runs.find(x => x.runId === runId);
      if (r) r.runner = { exitCode: exit.exitCode, endedAt: new Date().toISOString(), stderrTail: exit.stderrTail || undefined, error: exit.error };
    }).catch(() => {});
  });
  record.command = command;
  await mutate(project.id, s => { const r = s.runs.find(x => x.runId === runId); if (r) r.command = command; });
  log.info('files', `Godot ${input.action} started`, `${file.rel} @ ${ctx.checkoutPath} (${runId})`, project.id);
  return { ok: true, record };
}

/** Checkout of each run started by this server process; entries only count while the runner is alive. */
const activeCheckout = new Map<string, string>();

// -- reading results ----------------------------------------------------------------------------------

export interface RunView {
  record: RunRecord;
  running: boolean;
  verdict: harness.Verdict;
  receipt: any | null;
  /** The receipt names a different checkout than the record: something is off, shown loudly. */
  provenanceMismatch: string | null;
  evidence: harness.EvidenceFile[];
  session: any | null;
  stdoutTail: string | null;
}

export async function viewRun(record: RunRecord): Promise<RunView> {
  const loc = harness.locateHarness();
  const liveEntry = harness.live.get(record.runId);
  const running = !!liveEntry && !liveEntry.exited;
  if (!loc.ok) {
    return { record, running, verdict: harness.deriveVerdict({ receipt: null, running, runner: record.runner, action: record.action, screenshots: 0 }), receipt: null, provenanceMismatch: null, evidence: [], session: null, stdoutTail: null };
  }
  const receipt = await harness.readReceipt(loc, record.runId);
  const evidence = await harness.listEvidence(loc, record.runId);
  const session = await harness.readSession(loc, record.runId);
  const verdict = harness.deriveVerdict({
    receipt, running: running && !receipt, runner: record.runner ?? (liveEntry?.exited ? { exitCode: liveEntry.exitCode, stderrTail: liveEntry.stderr, error: liveEntry.error } : null),
    action: record.action, screenshots: evidence.filter(e => e.kind === 'screenshot').length,
  });
  let provenanceMismatch: string | null = null;
  if (receipt?.checkout && !sameCheckout(String(receipt.checkout), record.checkout.path)) {
    provenanceMismatch = `The receipt ran ${receipt.checkout} but this run was recorded for ${record.checkout.path}.`;
  }
  return { record, running: running && !receipt, verdict, receipt, provenanceMismatch, evidence, session, stdoutTail: null };
}

export async function cancel(projectId: string, runId: string): Promise<{ ok: true; output: string } | Failure> {
  const rec = await getRecord(projectId, runId);
  if (!rec) return fail(404, 'run-not-found', 'Run not found for this project.');
  const d = await harness.doctor();
  if (!d.ok) return fail(409, d.code, d.message);
  const r = await harness.cancelRun(d, runId);
  if (!r.ok) return fail(409, 'cancel-refused', `The Harness did not cancel the run: ${r.output || 'no detail'}`);
  return { ok: true, output: r.output };
}

/** Records for a file, including runs reached through it and runs of files provably related to it. */
export async function recordsForFile(projectId: string, root: string, rel: string): Promise<RunRecord[]> {
  const cls = await classify(root, rel);
  const related = new Set([rel, ...cls.relatedTests.map(r => r.rel), ...cls.relatedScenes.map(r => r.rel)]);
  return (await listRecords(projectId)).filter(r => (related.has(r.file) || r.via === rel));
}

