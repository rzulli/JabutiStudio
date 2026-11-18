import { spawn } from 'child_process';
import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { delimiter, join, resolve } from 'path';
import { getSettings } from '../settingsStore.js';

/**
 * Bridge to the existing Godot Agent Harness (runner/godot-harness.ps1). It only calls the runner's real
 * interface (`doctor`, `run`, `cancel`) with an argument array and no shell, and reads the receipts it wrote.
 * It does not judge a run itself: the verdict is derived from the receipt, and anything the runner does not
 * report stays "not proven".
 */

const DEFAULT_HARNESS_DIRS = process.platform === 'win32' ? ['C:\\dev\\PROJETOS\\GODOT_AGENT_HARNESS'] : [];
export const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/;

export interface HarnessLocation { dir: string; script: string; runs: string; source: 'settings' | 'env' | 'default-location' }
export interface HarnessProblem { ok: false; code: 'harness-missing' | 'powershell-missing' | 'godot-missing'; message: string }

export function findOnPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  for (const d of dirs) for (const n of names) { const p = join(d, n); if (existsSync(p)) return p; }
  return null;
}

export function locateHarness(): ({ ok: true } & HarnessLocation) | HarnessProblem {
  const candidates: { dir: string; source: HarnessLocation['source'] }[] = [];
  const set = getSettings().godotHarnessDir?.trim();
  if (set) candidates.push({ dir: set, source: 'settings' });
  if (process.env.GODOT_HARNESS_DIR?.trim()) candidates.push({ dir: process.env.GODOT_HARNESS_DIR.trim(), source: 'env' });
  // An explicit setting is authoritative: a wrong one is an error, never a silent switch to another Harness.
  if (!candidates.length) for (const d of DEFAULT_HARNESS_DIRS) candidates.push({ dir: d, source: 'default-location' });
  for (const c of candidates) {
    const dir = resolve(c.dir);
    const script = join(dir, 'runner', 'godot-harness.ps1');
    if (existsSync(script)) return { ok: true, dir, script, runs: join(dir, 'runs'), source: c.source };
  }
  return {
    ok: false, code: 'harness-missing',
    message: `Godot Agent Harness not found (looked for runner/godot-harness.ps1 in: ${candidates.map(c => c.dir).join(', ') || 'no configured location'}). Set godotHarnessDir in settings or GODOT_HARNESS_DIR.`,
  };
}

export function findPwsh(): string | null {
  // The runner needs PowerShell 7 (ConvertFrom-Json -AsHashtable, Process.Kill(tree)); Windows PowerShell 5 is not enough.
  return findOnPath(process.platform === 'win32' ? ['pwsh.exe'] : ['pwsh']);
}

export interface Spawned { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }

export function runPwsh(pwsh: string, args: string[], cwd: string, timeoutMs: number): Promise<Spawned> {
  return new Promise(resolveP => {
    let stdout = '', stderr = '', done = false, timedOut = false;
    const child = spawn(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code: number | null, error?: string) => { if (done) return; done = true; clearTimeout(timer); resolveP({ code, stdout, stderr, timedOut, error }); };
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 1_000_000) stdout = stdout.slice(-500_000); });
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000); });
    child.on('error', e => finish(null, e.message));
    child.on('close', code => finish(code));
  });
}

export interface Doctor { ok: true; godot: string; version: string | null; harness: HarnessLocation; pwsh: string }
let doctorCache: { at: number; value: Doctor | HarnessProblem } | null = null;

/** `doctor` finds `godot` the way the runner does (PATH) and proves it starts. Cached briefly. */
export async function doctor(force = false): Promise<Doctor | HarnessProblem> {
  const loc = locateHarness();
  if (!loc.ok) return loc;
  // Reuse only for the same runner script: a changed setting must never be answered from the old Harness.
  if (!force && doctorCache && Date.now() - doctorCache.at < 20_000 && doctorCache.value.ok && doctorCache.value.harness.script === loc.script) return doctorCache.value;
  const pwsh = findPwsh();
  if (!pwsh) return { ok: false, code: 'powershell-missing', message: 'PowerShell 7 (pwsh) is not on PATH; the Harness runner needs it.' };
  const r = await runPwsh(pwsh, ['-File', loc.script, 'doctor'], loc.dir, 20_000);
  let parsed: any = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* not JSON */ }
  if (!parsed || parsed.status !== 'READY' || !parsed.godot) {
    return { ok: false, code: 'godot-missing', message: `Harness doctor is not READY${parsed?.failure ? `: ${parsed.failure}` : ''}${!parsed ? `: ${(r.error || r.stderr || r.stdout || 'no output').slice(0, 300)}` : ' (godot not found on PATH?)'}` };
  }
  const value: Doctor = { ok: true, godot: String(parsed.godot), version: parsed.version ? String(parsed.version) : null, harness: { dir: loc.dir, script: loc.script, runs: loc.runs, source: loc.source }, pwsh };
  doctorCache = { at: Date.now(), value };
  return value;
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const rand = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${stamp}-${rand}`;
}

export interface RunSpec {
  runId: string;
  projectRoot: string;
  testRes: string;
  mode: 'HEADLESS' | 'RENDER_BACKGROUND';
  profile: 'probe' | 'smoke' | 'integration';
  marker: string;
}

export function buildRunArgs(h: HarnessLocation, s: RunSpec): string[] {
  const a = ['-File', h.script, 'run', '-Project', s.projectRoot, '-Test', s.testRes, '-Mode', s.mode, '-Profile', s.profile, '-Marker', s.marker, '-RunId', s.runId];
  if (s.mode === 'RENDER_BACKGROUND') a.push('-NoDefaultScreenshot');
  return a;
}

export interface LiveRun { child: ReturnType<typeof spawn>; stderr: string; stdout: string; exited: boolean; exitCode: number | null; error?: string; /** Checkout the runner works in: a close must see that a run still uses it. */ projectRoot: string }
export const live = new Map<string, LiveRun>();

/** Start the runner for one run. Returns immediately; `onExit` fires with the runner's own exit facts. */
export function startRun(d: Doctor, spec: RunSpec, onExit: (r: { exitCode: number | null; stderrTail: string; stdoutTail: string; error?: string }) => void): { pid: number | null; command: string[] } {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...buildRunArgs(d.harness, spec)];
  const child = spawn(d.pwsh, args, { cwd: d.harness.dir, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry: LiveRun = { child, stderr: '', stdout: '', exited: false, exitCode: null, projectRoot: spec.projectRoot };
  live.set(spec.runId, entry);
  child.stdout?.on('data', x => { entry.stdout = (entry.stdout + x).slice(-20_000); });
  child.stderr?.on('data', x => { entry.stderr = (entry.stderr + x).slice(-20_000); });
  const end = (code: number | null, error?: string) => {
    if (entry.exited) return;
    entry.exited = true; entry.exitCode = code; entry.error = error;
    onExit({ exitCode: code, stderrTail: entry.stderr.slice(-4000), stdoutTail: entry.stdout.slice(-2000), error });
    setTimeout(() => live.delete(spec.runId), 60_000).unref?.();
  };
  child.on('error', e => end(null, e.message));
  child.on('close', code => end(code));
  return { pid: child.pid ?? null, command: [d.pwsh, ...args] };
}

export async function cancelRun(d: Doctor, runId: string): Promise<{ ok: boolean; output: string }> {
  if (!RUN_ID_RE.test(runId)) return { ok: false, output: 'Invalid run id' };
  const r = await runPwsh(d.pwsh, ['-File', d.harness.script, 'cancel', '-RunId', runId], d.harness.dir, 30_000);
  return { ok: r.code === 0, output: (r.stdout || r.stderr || r.error || '').slice(0, 2000) };
}

// -- reading what the runner wrote --------------------------------------------------------------------

export function runDir(h: HarnessLocation, runId: string): string | null {
  if (!RUN_ID_RE.test(runId)) return null;
  return join(h.runs, runId);
}

export async function readReceipt(h: HarnessLocation, runId: string): Promise<any | null> {
  const dir = runDir(h, runId);
  if (!dir) return null;
  try { return JSON.parse((await readFile(join(dir, 'receipt.json'), 'utf-8')).replace(/^\uFEFF/, '')); } catch { return null; }
}

export async function readSession(h: HarnessLocation, runId: string): Promise<any | null> {
  const dir = runDir(h, runId);
  if (!dir) return null;
  try { return JSON.parse((await readFile(join(dir, 'session.json'), 'utf-8')).replace(/^\uFEFF/, '')); } catch { return null; }
}

export const LOG_FILES = ['stdout.log', 'stderr.log', 'import.stdout.log', 'import.stderr.log', 'events.jsonl', 'focus.jsonl', 'receipt.json', 'session.json'];
const SHOT_RE = /^[A-Za-z0-9._-]{1,120}\.png$/;

export interface EvidenceFile { name: string; kind: 'log' | 'receipt' | 'screenshot'; bytes: number }

export async function listEvidence(h: HarnessLocation, runId: string): Promise<EvidenceFile[]> {
  const dir = runDir(h, runId);
  if (!dir) return [];
  const out: EvidenceFile[] = [];
  for (const n of LOG_FILES) {
    try { const st = await stat(join(dir, n)); if (st.isFile()) out.push({ name: n, kind: n === 'receipt.json' ? 'receipt' : 'log', bytes: st.size }); } catch { /* absent */ }
  }
  try {
    for (const e of await readdir(join(dir, 'screenshots'), { withFileTypes: true })) {
      if (e.isFile() && SHOT_RE.test(e.name)) out.push({ name: `screenshots/${e.name}`, kind: 'screenshot', bytes: (await stat(join(dir, 'screenshots', e.name))).size });
    }
  } catch { /* none */ }
  return out;
}

/** Absolute path of one evidence file of a run, only for names the runner is known to write. */
export function evidencePath(h: HarnessLocation, runId: string, name: string): string | null {
  const dir = runDir(h, runId);
  if (!dir) return null;
  if (LOG_FILES.includes(name)) return join(dir, name);
  const m = /^screenshots\/([^/]+)$/.exec(name);
  if (m && SHOT_RE.test(m[1])) return join(dir, 'screenshots', m[1]);
  return null;
}

// -- verdict -------------------------------------------------------------------------------------------

export type Outcome =
  | 'RUNNING' | 'PASS' | 'TEST_FAILED' | 'NO_ASSERTIONS' | 'IMPORT_FAILED' | 'SCRIPT_FAILED' | 'TIMEOUT' | 'CANCELLED'
  | 'FOCUS_BLOCKED' | 'INFRA_BLOCKED' | 'STARTUP_FAILED' | 'ARTIFACT_MISSING' | 'LAUNCH_FAILED' | 'NO_RECEIPT' | 'FAILED';

export interface Verdict {
  outcome: Outcome;
  /** The runner's own status string, untouched. */
  harnessStatus: string | null;
  headline: string;
  /** The runner's stated cause, or ours when the runner never wrote a receipt. */
  reason: string | null;
  /** The four things a PASS could mean, kept apart. */
  executionCompleted: boolean;
  assertions: 'VERIFIED' | 'FAILED' | 'NOT_PROVEN';
  visualEvidence: 'AVAILABLE' | 'NONE';
  humanValidation: 'PENDING';
  limitations: string[];
}

const HEADLINES: Record<Outcome, string> = {
  RUNNING: 'Running', PASS: 'Assertions verified', TEST_FAILED: 'Test failed', NO_ASSERTIONS: 'Ran, but no assertion marker was reported',
  IMPORT_FAILED: 'Import failed', SCRIPT_FAILED: 'Script error', TIMEOUT: 'Timed out', CANCELLED: 'Cancelled', FOCUS_BLOCKED: 'Blocked: focus not proven',
  INFRA_BLOCKED: 'Blocked by the environment', STARTUP_FAILED: 'Godot did not start', ARTIFACT_MISSING: 'Required artifact missing',
  LAUNCH_FAILED: 'Runner could not be launched', NO_RECEIPT: 'The runner ended without a receipt', FAILED: 'Failed',
};

export interface VerdictInput { receipt: any | null; running: boolean; runner?: { exitCode: number | null; stderrTail?: string; error?: string } | null; action: 'scene' | 'test'; screenshots: number }

/** Never yields PASS unless the receipt says PASS *and* its assertions are PASS *and* the process exited 0. */
export function deriveVerdict(i: VerdictInput): Verdict {
  const r = i.receipt;
  const limitations: string[] = [];
  if (i.action === 'scene') limitations.push('A plain scene is not a test: the Harness only judges a run by its assertion marker, so a scene that never prints one cannot PASS.');
  limitations.push('The Harness verifies assertions and process health only; it does not judge what the game looks or feels like.');

  const base = { harnessStatus: r?.status ?? null, humanValidation: 'PENDING' as const, limitations, visualEvidence: (i.screenshots > 0 ? 'AVAILABLE' : 'NONE') as Verdict['visualEvidence'] };
  const done = (outcome: Outcome, reason: string | null, extra: Partial<Verdict> = {}): Verdict => ({ ...base, outcome, headline: HEADLINES[outcome], reason, executionCompleted: false, assertions: 'NOT_PROVEN', ...extra });

  if (!r) {
    if (i.running) return done('RUNNING', null);
    if (i.runner?.error) return done('LAUNCH_FAILED', i.runner.error);
    return done('NO_RECEIPT', i.runner ? `The runner exited with code ${i.runner.exitCode} before writing a receipt.${i.runner.stderrTail ? ` stderr: ${i.runner.stderrTail.trim().slice(-600)}` : ''}` : 'No receipt was found for this run (the server may have restarted while it was running).');
  }

  const assertionsStatus = r.assertions?.status;
  const assertions: Verdict['assertions'] = assertionsStatus === 'PASS' ? 'VERIFIED' : (r.assertions?.failed_count ?? 0) > 0 ? 'FAILED' : 'NOT_PROVEN';
  const exit = r.process?.exit_code;
  const completed = ['PASS', 'FAIL', 'ARTIFACT_MISSING', 'FOCUS_BLOCKED'].includes(r.status) || (r.process?.status === 'EXITED');
  const cause: string | null = r.failure_cause ?? null;
  const extra = { assertions, executionCompleted: completed };

  switch (r.status) {
    case 'PASS':
      if (assertionsStatus === 'PASS' && exit === 0) return done('PASS', null, extra);
      return done('FAILED', 'The receipt says PASS but its assertions/exit code do not back it up; treated as not passed.', extra);
    case 'FAIL':
      if ((r.assertions?.failed_count ?? 0) > 0 || r.failure_class === 'TEST_FAILED') return done(assertions === 'FAILED' ? 'TEST_FAILED' : 'NO_ASSERTIONS', cause, extra);
      return done('FAILED', cause, extra);
    case 'IMPORT_FAILED': return done('IMPORT_FAILED', cause, extra);
    case 'SCRIPT_PARSE_FAILED': case 'SCRIPT_RUNTIME_FAILED': return done('SCRIPT_FAILED', cause, extra);
    case 'TIMEOUT': return done('TIMEOUT', cause, extra);
    case 'CANCELLED': return done('CANCELLED', cause, extra);
    case 'FOCUS_BLOCKED': return done('FOCUS_BLOCKED', cause, extra);
    case 'INFRA_BLOCKED': return done('INFRA_BLOCKED', cause, extra);
    case 'STARTUP_FAILED': return done('STARTUP_FAILED', cause, extra);
    case 'ARTIFACT_MISSING': return done('ARTIFACT_MISSING', cause, extra);
    default: return done('FAILED', cause ?? `Unrecognised runner status "${String(r.status)}"`, extra);
  }
}
