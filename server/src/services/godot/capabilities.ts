import { stat } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { getProjects } from '../projectDiscovery.js';
import { resolveForProject, sameCheckout, cleanRel, type Refusal, type ExecutionContext } from './context.js';
import { classify, DEFAULT_MARKER } from './classify.js';
import * as harness from './harness.js';
import * as runs from './runs.js';

/**
 * What an agent may know about running Godot for a task, read from the real Harness instead of written down here.
 *
 * Source of every field is stated in `sources`:
 *  - actions / modes / profiles / parameter defaults: the runner's own `param()` block, read through PowerShell's
 *    parser (the file is parsed, never executed);
 *  - profile budgets and the long-override ceiling: the runner's own `doctor -Deep` output;
 *  - the rules that turn a budget into an -OverrideReason requirement are the runner's published budget policy;
 *    they are applied only on top of budgets the runner itself reported, never on a built-in table.
 * Nothing here starts Godot or writes a receipt. The one thing JabutiStudio adds is the checkout and the test list,
 * which are its own existing resolvers.
 */

const pexec = promisify(execFile);

export interface ParamSpec { name: string; type: string; default: string | null; validValues: string[] }

export type Introspection =
  | {
    ok: true; params: ParamSpec[]; actions: string[]; modes: string[]; profiles: string[];
    budgetsSec: Record<string, number> | null; longOverrideSec: number | null; maxTimeoutSec: number | null;
    sources: { params: string; budgets: string | null };
  }
  | { ok: false; reason: string };

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const AST_PS = (script: string) =>
  `$p=${psQuote(script)};$t=$null;$e=$null;$a=[System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$t,[ref]$e);` +
  `if(!$a.ParamBlock){'[]';exit 0};ConvertTo-Json -Compress -InputObject @($a.ParamBlock.Parameters|ForEach-Object{` +
  `$v=@($_.Attributes|Where-Object{$_.TypeName.Name -eq 'ValidateSet'}|ForEach-Object{$_.PositionalArguments|ForEach-Object{$_.Value}});` +
  `[pscustomobject]@{name=$_.Name.VariablePath.UserPath;type=$_.StaticType.Name;def=$(if($_.DefaultValue){$_.DefaultValue.Extent.Text}else{$null});valid=$v}})`;

const unquote = (s: string | null) => (s == null ? null : s.replace(/^['"]|['"]$/g, ''));

let introCache: { key: string; value: Introspection } | null = null;

/** The Harness's own description of itself. Cached per runner file version. */
export async function introspect(loc: harness.HarnessLocation, pwsh: string): Promise<Introspection> {
  let key: string;
  try { const st = await stat(loc.script); key = `${loc.script}|${st.mtimeMs}|${st.size}`; } catch { return { ok: false, reason: `${loc.script} cannot be read.` }; }
  if (introCache?.key === key) return introCache.value;

  const ast = await harness.runPwsh(pwsh, ['-Command', AST_PS(loc.script)], loc.dir, 20_000);
  let raw: any[] | null = null;
  try { const j = JSON.parse(ast.stdout); raw = Array.isArray(j) ? j : [j]; } catch { /* not JSON */ }
  if (!raw || !raw.length) {
    return { ok: false, reason: `Could not read the runner's parameters (${(ast.error || ast.stderr || ast.stdout || 'no output').trim().slice(0, 300)}).` };
  }
  const params: ParamSpec[] = raw.map(p => ({ name: String(p.name), type: String(p.type), default: unquote(p.def ?? null), validValues: (Array.isArray(p.valid) ? p.valid : p.valid != null ? [p.valid] : []).map(String) }));
  const valid = (n: string) => params.find(p => p.name === n)?.validValues ?? [];
  const actions = valid('Action'), profiles = valid('Profile'), modes = valid('Mode');
  if (!actions.length) return { ok: false, reason: 'The runner declares no Action values, so its interface cannot be listed.' };

  let budgetsSec: Record<string, number> | null = null, longOverrideSec: number | null = null, maxTimeoutSec: number | null = null, budgetSource: string | null = null;
  const deep = await harness.runPwsh(pwsh, ['-File', loc.script, 'doctor', '-Deep'], loc.dir, 30_000);
  try {
    const checks = JSON.parse(deep.stdout)?.deep?.checks;
    if (checks?.profiles && typeof checks.profiles === 'object') {
      budgetsSec = Object.fromEntries(Object.entries(checks.profiles).map(([k, v]) => [k, Number(v)]));
      longOverrideSec = Number(checks.long_override?.max_without_long_playtest_sec) || null;
      maxTimeoutSec = Number(checks.long_override?.max_timeout_sec) || null;
      budgetSource = 'runner doctor -Deep (checks.profiles, checks.long_override)';
    }
  } catch { /* budgets stay unknown: reported as such */ }
  const maxDefault = Number(params.find(p => p.name === 'MaxTimeoutSec')?.default);
  if (maxTimeoutSec == null && Number.isFinite(maxDefault) && maxDefault > 0) maxTimeoutSec = maxDefault;

  const value: Introspection = { ok: true, params, actions, modes, profiles, budgetsSec, longOverrideSec, maxTimeoutSec, sources: { params: "runner param() block, parsed (not executed)", budgets: budgetSource } };
  introCache = { key, value };
  return value;
}

async function harnessRevision(dir: string): Promise<{ revision: string | null; uncommittedChanges: number | null }> {
  try {
    const rev = (await pexec('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { windowsHide: true })).stdout.trim();
    const st = (await pexec('git', ['-C', dir, 'status', '--porcelain'], { windowsHide: true })).stdout.split('\n').filter(Boolean).length;
    return { revision: rev || null, uncommittedChanges: st };
  } catch { return { revision: null, uncommittedChanges: null }; }
}

// -- plan check ---------------------------------------------------------------------------------------

export interface PlanInput { action?: string; test?: string; profile?: string; mode?: string; timeoutSec?: number; overrideReason?: string }
export interface Problem {
  code: 'harness-unavailable' | 'unsupported-action' | 'not-a-test-action' | 'test-required' | 'test-not-found' | 'bad-test-path' | 'unknown-profile' | 'unsupported-mode'
    | 'budgets-unknown' | 'override-required' | 'long-profile-required' | 'timeout-explicit-required' | 'timeout-above-ceiling' | 'bad-timeout';
  kind: 'infrastructure' | 'input' | 'budget';
  message: string;
  /** Concrete choices that would make the request valid. */
  options?: string[];
}
export interface Plan { ok: boolean; problems: Problem[]; warnings: string[]; runId?: string; command?: string[]; commandLine?: string; checkout?: string; res?: string }

const q = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

async function checkPlan(
  plan: PlanInput, intro: Introspection, d: harness.Doctor | harness.HarnessProblem, ctx: ExecutionContext, tests: string[],
): Promise<Plan> {
  const problems: Problem[] = []; const warnings: string[] = [];
  const bad = (p: Problem) => { problems.push(p); };

  if (!d.ok) { bad({ code: 'harness-unavailable', kind: 'infrastructure', message: d.message, options: ['Fix the Harness setup (settings godotHarnessDir / GODOT_HARNESS_DIR, pwsh 7, godot on PATH) — this is not a test result.'] }); return { ok: false, problems, warnings }; }
  if (!intro.ok) { bad({ code: 'harness-unavailable', kind: 'infrastructure', message: `The Harness interface could not be read: ${intro.reason}`, options: ['Do not guess actions. Ask the user to check the Harness installation.'] }); return { ok: false, problems, warnings }; }

  const action = plan.action ?? 'run';
  if (!intro.actions.includes(action)) bad({ code: 'unsupported-action', kind: 'input', message: `"${action}" is not an action of this Harness.`, options: [`Supported actions: ${intro.actions.join(', ')}.`, 'To execute a test scene use "run".'] });
  else if (action !== 'run') bad({ code: 'not-a-test-action', kind: 'input', message: `"${action}" exists in the Harness but does not run a test and produces no test verdict. JabutiStudio plans and records test runs only ("run").` });

  let res: string | undefined;
  if (!plan.test) bad({ code: 'test-required', kind: 'input', message: 'test (a project-relative .tscn) is required to plan a run.', options: tests.length ? [`Tests in this checkout: ${tests.join(', ')}`] : ['This checkout declares no scene under tests/.'] });
  else {
    const rel = cleanRel(plan.test);
    if (!rel || !rel.endsWith('.tscn')) bad({ code: 'bad-test-path', kind: 'input', message: `"${plan.test}" is not a project-relative .tscn path (res://tests/x.tscn or tests/x.tscn).` });
    else {
      const abs = join(ctx.checkoutPath, ...rel.split('/'));
      const exists = await stat(abs).then(s => s.isFile(), () => false);
      if (!exists) bad({ code: 'test-not-found', kind: 'input', message: `${rel} does not exist in ${ctx.checkoutPath}.`, options: tests.length ? [`Tests in this checkout: ${tests.join(', ')}`] : ['This checkout declares no scene under tests/.'] });
      else {
        res = `res://${rel}`;
        const cls = await classify(ctx.checkoutPath, rel);
        if (cls.kind !== 'test-scene') warnings.push(`${rel} is not under tests/: the Harness only passes a run whose scene prints the assertion marker (${DEFAULT_MARKER}), so a plain scene cannot PASS.`);
      }
    }
  }

  const profile = plan.profile ?? intro.params.find(p => p.name === 'Profile')?.default ?? 'smoke';
  const mode = plan.mode ?? intro.params.find(p => p.name === 'Mode')?.default ?? 'HEADLESS';
  if (!intro.profiles.includes(profile)) bad({ code: 'unknown-profile', kind: 'input', message: `"${profile}" is not a Harness profile.`, options: [`Profiles: ${intro.profiles.join(', ')}`] });
  if (!intro.modes.includes(mode) || mode === 'STATIC' || mode === 'INTERACTIVE') {
    bad({ code: 'unsupported-mode', kind: 'input', message: `Mode "${mode}" is not available for a recorded test run.`, options: ['Use HEADLESS (default) or RENDER_BACKGROUND. STATIC launches nothing; INTERACTIVE needs a person at the machine.'] });
  }

  // Budget policy (the runner enforces the same rules and records the reason in the receipt).
  const budget = intro.budgetsSec?.[profile];
  if (plan.timeoutSec != null) {
    const t = plan.timeoutSec;
    if (!Number.isInteger(t) || t < 1) bad({ code: 'bad-timeout', kind: 'input', message: 'timeoutSec must be a positive whole number of seconds.' });
    else if (budget == null || intro.longOverrideSec == null) bad({ code: 'budgets-unknown', kind: 'infrastructure', message: 'The Harness did not report its profile budgets, so a custom timeout cannot be checked. Run with the profile default instead.' });
    else {
      const reason = (plan.overrideReason ?? '').trim();
      if (profile === 'long_playtest' || t > budget) {
        if (intro.maxTimeoutSec != null && t > intro.maxTimeoutSec) bad({ code: 'timeout-above-ceiling', kind: 'budget', message: `${t}s is above the Harness maximum (${intro.maxTimeoutSec}s).` });
        else if (profile !== 'long_playtest' && t > intro.longOverrideSec) bad({ code: 'long-profile-required', kind: 'budget', message: `${t}s is above ${intro.longOverrideSec}s, which only the long_playtest profile may use (with an OverrideReason).`, options: ['Ask the user before a run this long; a headless test should not need it.'] });
        else if (reason.length < 10) bad({ code: 'override-required', kind: 'budget', message: `${t}s is above the ${profile} budget (${budget}s): the Harness refuses it unless an OverrideReason of at least 10 characters states why. The reason is written into the receipt.`, options: [`Prefer a profile whose budget already fits${Object.entries(intro.budgetsSec ?? {}).filter(([k, v]) => v >= t && k !== 'editor_startup').map(([k, v]) => ` (${k}: ${v}s)`).join('') || ''}.`, 'Only supply an OverrideReason that is true (e.g. a measured cold import); never a placeholder. If unsure, ask the user.'] });
      }
    }
  } else if (profile === 'long_playtest') {
    bad({ code: 'timeout-explicit-required', kind: 'budget', message: 'long_playtest has no default budget: it needs an explicit timeoutSec and an OverrideReason.' });
  }

  if (problems.length) return { ok: false, problems, warnings };
  const runId = harness.newRunId();
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', d.harness.script, 'run', '-Project', ctx.checkoutPath, '-Test', res!, '-Mode', mode, '-Profile', profile, '-Marker', DEFAULT_MARKER, '-RunId', runId];
  if (plan.timeoutSec != null && budget != null && (plan.timeoutSec > budget || profile === 'long_playtest')) args.push('-TimeoutSec', String(plan.timeoutSec), '-OverrideReason', (plan.overrideReason ?? '').trim());
  else if (plan.timeoutSec != null) args.push('-TimeoutSec', String(plan.timeoutSec));
  if (mode === 'RENDER_BACKGROUND') args.push('-NoDefaultScreenshot');
  const command = [d.pwsh, ...args];
  return { ok: true, problems, warnings, runId, command, commandLine: command.map(q).join(' '), checkout: ctx.checkoutPath, res };
}

// -- the contract ------------------------------------------------------------------------------------

export interface Failure { ok: false; code: string; message: string; options?: Refusal['options'] }

export async function getCapabilities(input: { projectId: string; taskId?: string; checkout?: 'main' | 'task'; plan?: PlanInput }): Promise<Record<string, unknown> | Failure> {
  const project = (await getProjects()).find(p => p.id === input.projectId);
  if (!project) return { ok: false, code: 'project-not-found', message: 'Project not found.' };
  const ctx = await resolveForProject(project, { projectId: project.id, taskId: input.taskId, checkout: input.checkout, origin: input.taskId ? 'task' : 'project' });
  if (!ctx.ok) return { ok: false, code: ctx.code, message: ctx.message, options: ctx.options };

  const d = await harness.doctor();
  const loc = harness.locateHarness();
  const pwsh = harness.findPwsh();
  const intro: Introspection = loc.ok && pwsh ? await introspect(loc, pwsh) : { ok: false, reason: loc.ok ? 'PowerShell 7 (pwsh) is not on PATH.' : loc.message };
  const tests = await runs.listTestScenes(ctx.checkoutPath);
  const rev = loc.ok ? await harnessRevision(loc.dir) : { revision: null, uncommittedChanges: null };

  const blockers: string[] = [];
  if (!d.ok) blockers.push(`${d.code}: ${d.message}`);
  if (!intro.ok) blockers.push(`introspection: ${intro.reason}`);

  const out: Record<string, unknown> = {
    ok: true,
    ready: blockers.length === 0,
    blockers,
    whatThisIs: 'Contract of the existing Godot Agent Harness for this project/task. Nothing was started. Use only the actions listed here; do not try others.',
    harness: loc.ok
      ? { dir: loc.dir, runner: loc.script, locatedBy: loc.source, revision: rev.revision, runnerUncommittedChanges: rev.uncommittedChanges, godot: d.ok ? { path: d.godot, version: d.version } : null, pwsh: d.ok ? d.pwsh : pwsh }
      : { located: false, message: loc.message },
    integration: d.ok ? 'ready' : { state: d.code, message: d.message },
    actions: intro.ok ? {
      supported: intro.actions,
      forTests: 'run',
      note: 'Only "run" executes a test scene and yields a test verdict. result/verify/cancel/stop/clean act on existing runs or editor sessions; editor/export are not test runs. The runner rejects any action not listed.',
    } : null,
    run: intro.ok ? {
      required: ['Project (the checkout below)', 'Test (res://….tscn)'],
      optional: intro.params.filter(p => !['Action', 'Project', 'Test'].includes(p.name)).map(p => ({ name: p.name, type: p.type, default: p.default, ...(p.validValues.length ? { validValues: p.validValues } : {}) })),
      modes: intro.modes, usableModes: intro.modes.filter(m => m === 'HEADLESS' || m === 'RENDER_BACKGROUND'),
      profiles: intro.profiles.map(n => ({ name: n, defaultTimeoutSec: intro.budgetsSec?.[n] ?? null })),
      timeouts: {
        profileBudgetsSec: intro.budgetsSec, ceilingWithoutLongPlaytestSec: intro.longOverrideSec, maxTimeoutSec: intro.maxTimeoutSec,
        overrideReason: 'Required (>= 10 characters, recorded in the receipt) when timeoutSec exceeds the profile budget, and always for long_playtest. Above the ceiling only long_playtest is allowed. A refusal is the Harness protecting its budget: choose a fitting profile or ask the user; never invent a reason.',
      },
      marker: DEFAULT_MARKER,
    } : null,
    sources: intro.ok ? intro.sources : { error: intro.reason },
    checkout: {
      path: ctx.checkoutPath, source: ctx.source, isMainCheckout: ctx.isMainCheckout, reason: ctx.reason, branch: ctx.branch, head: ctx.head, detached: ctx.detached,
      dirty: ctx.dirty, reproducibleFromSha: ctx.reproducibleFromSha, notes: ctx.notes, taskId: ctx.taskId ?? null,
    },
    tests: { scenes: tests.map(rel => ({ rel, res: `res://${rel}` })), mainScene: await runs.mainScene(ctx.checkoutPath), note: 'A scene is a test only by living under tests/. Scripts (.gd) are never run on their own.' },
    evidence: {
      location: loc.ok ? join(loc.runs, '<runId>') : null,
      files: harness.LOG_FILES, screenshots: 'screenshots/*.png',
      receipt: 'receipt.json (schema godot-harness/2): status, failure_cause, assertions, timeout (profile, override_reason), checkout, started_utc/finished_utc, process, artifacts',
      howToRead: 'MCP get_godot_run { projectId, runId } returns the verdict, receipt summary, evidence list and freshness; evidence files are served at GET /api/projects/:projectId/godot/runs/:runId/evidence?name=<file>.',
      howToLink: input.taskId ? 'After a run, MCP record_godot_run { projectId, taskId, runId } adds it to the same run index Testing and Review read.' : 'Pass taskId to get the task checkout and to link runs to the task.',
    },
    verdictMeaning: 'PASS = the receipt reports assertions PASS and exit 0 for that checkout and commit. It is not gameplay approval: human validation stays pending, and acceptance is the user\'s.',
  };
  if (input.plan) out.plan = await checkPlan(input.plan, intro, d, ctx, tests);
  return out;
}

// -- runs: result, diagnosis, freshness, registration --------------------------------------------------

export type DiagnosisClass = 'passed' | 'test-problem' | 'timeout' | 'infrastructure' | 'evidence-incomplete' | 'cancelled' | 'running';

export function diagnose(v: harness.Verdict): { class: DiagnosisClass; nextStep: string } {
  switch (v.outcome) {
    case 'PASS': return { class: 'passed', nextStep: 'Assertions held in the recorded checkout. This is not gameplay approval; report it with the run id and leave acceptance to the user.' };
    case 'TEST_FAILED': return { class: 'test-problem', nextStep: 'The test ran and its assertions failed: fix the code or the test, commit, and run again. Do not report this as passing.' };
    case 'NO_ASSERTIONS': return { class: 'test-problem', nextStep: 'The scene ran but never printed the assertion marker, so nothing was verified. Make the test print it only when its checks hold.' };
    case 'SCRIPT_FAILED': case 'IMPORT_FAILED': return { class: 'test-problem', nextStep: 'Godot could not load or run the project/scripts. Read stderr.log / stdout.log from the evidence and fix the error.' };
    case 'TIMEOUT': return { class: 'timeout', nextStep: 'The run exceeded its budget. Check whether the test hangs before asking for more time; a longer budget needs an honest OverrideReason or the user\'s decision.' };
    case 'CANCELLED': return { class: 'cancelled', nextStep: 'The run was cancelled; no verdict exists. Run again if the result is needed.' };
    case 'RUNNING': return { class: 'running', nextStep: 'Still running. Query again; do not start another run in the same checkout.' };
    case 'NO_RECEIPT': case 'ARTIFACT_MISSING': return { class: 'evidence-incomplete', nextStep: 'The Harness left no valid result for this run. Treat it as NOT proven, not as failed or passed; re-run.' };
    default: return { class: 'infrastructure', nextStep: 'The environment blocked or could not start the run (Harness/Godot/focus). It says nothing about the test; report the reason and ask the user to fix the setup.' };
  }
}

const git = async (cwd: string, ...a: string[]) => { try { return (await pexec('git', ['-C', cwd, ...a], { windowsHide: true })).stdout.trim(); } catch { return null; } };

export interface Freshness { state: 'current' | 'stale' | 'unknown'; recordedHead: string | null; currentHead: string | null; reason: string }

/** Is the run's result about the checkout as it is now? A different HEAD means the code moved on since the run. */
export async function freshnessOf(record: runs.RunRecord): Promise<Freshness> {
  const project = (await getProjects()).find(p => p.id === record.projectId);
  const recordedHead = record.checkout.head;
  if (!project) return { state: 'unknown', recordedHead, currentHead: null, reason: 'Project not found.' };
  const ctx = await resolveForProject(project, { projectId: project.id, taskId: record.taskId, checkout: record.taskId ? (record.checkout.isMainCheckout ? 'main' : 'task') : 'main', requireGodot: false });
  if (!ctx.ok) return { state: 'unknown', recordedHead, currentHead: null, reason: ctx.message };
  if (!sameCheckout(ctx.checkoutPath, record.checkout.path)) return { state: 'unknown', recordedHead, currentHead: ctx.head, reason: `The task now resolves to ${ctx.checkoutPath}, not ${record.checkout.path}.` };
  if (!recordedHead || !ctx.head) return { state: 'unknown', recordedHead, currentHead: ctx.head, reason: 'No commit was recorded for this run.' };
  if (recordedHead !== ctx.head) return { state: 'stale', recordedHead, currentHead: ctx.head, reason: `The result is for ${recordedHead.slice(0, 8)}; the checkout is now at ${ctx.head.slice(0, 8)}. Run again before relying on it.` };
  if (record.checkout.dirtyAtStart && record.checkout.dirtyAtStart.count > 0) return { state: 'current', recordedHead, currentHead: ctx.head, reason: `Same commit, but ${record.checkout.dirtyAtStart.count} uncommitted change(s) were present: the commit does not fully reproduce what ran.` };
  return { state: 'current', recordedHead, currentHead: ctx.head, reason: 'Same commit as when the run was recorded.' };
}

const summarizeReceipt = (r: any | null) => !r ? null : {
  schema: r.schema ?? null, status: r.status ?? null, failureClass: r.failure_class ?? null, failureCause: r.failure_cause ?? null,
  test: r.test ?? null, mode: r.mode ?? null, checkout: r.checkout ?? null, startedUtc: r.started_utc ?? null, finishedUtc: r.finished_utc ?? null, durationSec: r.duration_sec ?? null,
  timeout: r.timeout ? { profile: r.timeout.profile, operationSec: r.timeout.operation_sec, override: r.timeout.override, overrideReason: r.timeout.override_reason } : null,
  assertions: r.assertions ? { status: r.assertions.status, passed: r.assertions.passed_count, failed: r.assertions.failed_count, failedChecks: (r.assertions.failed ?? []).slice(0, 20) } : null,
  process: r.process ? { status: r.process.status, exitCode: r.process.exit_code, timedOut: r.process.timed_out } : null,
};

export async function getRunReport(projectId: string, runId: string): Promise<Record<string, unknown> | Failure> {
  if (!harness.RUN_ID_RE.test(runId)) return { ok: false, code: 'bad-run-id', message: 'runId must look like 20260101T120000Z-0123abcd (use the run id from the plan or the record).' };
  const loc = harness.locateHarness();
  if (!loc.ok) return { ok: false, code: loc.code, message: loc.message };
  const rec = await runs.getRecord(projectId, runId);
  if (rec) {
    const view = await runs.viewRun(rec);
    const fresh = await freshnessOf(rec);
    const diag = diagnose(view.verdict);
    return {
      ok: true, runId, recorded: true,
      record: { taskId: rec.taskId ?? null, taskNumber: rec.taskNumber ?? null, file: rec.file, res: rec.res, origin: rec.origin, registered: rec.registered ?? null, params: rec.params, checkout: rec.checkout, harness: rec.harness, startedAt: rec.startedAt },
      running: view.running, verdict: view.verdict, diagnosis: diag, freshness: fresh,
      provenanceMismatch: view.provenanceMismatch, receipt: summarizeReceipt(view.receipt), evidence: { dir: join(loc.runs, runId), files: view.evidence },
      usableAsCurrentEvidence: view.verdict.outcome === 'PASS' && fresh.state === 'current' && !view.provenanceMismatch,
    };
  }
  const receipt = await harness.readReceipt(loc, runId);
  const evidence = await harness.listEvidence(loc, runId);
  const verdict = harness.deriveVerdict({ receipt, running: false, runner: null, action: 'test', screenshots: evidence.filter(e => e.kind === 'screenshot').length });
  return {
    ok: true, runId, recorded: false,
    note: 'This run is not in the JabutiStudio index, so Testing and Review do not show it yet. record_godot_run { projectId, taskId, runId } links it to the task.',
    verdict, diagnosis: diagnose(verdict), receipt: summarizeReceipt(receipt), evidence: { dir: join(loc.runs, runId), files: evidence }, usableAsCurrentEvidence: false,
  };
}

/**
 * Link a run the agent executed with the Harness itself to the task, in the SAME index Testing and Review read.
 * The verdict is still derived from the receipt; the agent's word is never an input. Provenance (checkout, branch,
 * HEAD, dirty) is captured now and labelled as captured after the run.
 */
export async function recordAgentRun(input: { projectId: string; taskId: string; runId: string; checkout?: 'main' | 'task' }): Promise<{ ok: true; record: runs.RunRecord; alreadyRecorded: boolean } | Failure> {
  if (!harness.RUN_ID_RE.test(input.runId)) return { ok: false, code: 'bad-run-id', message: 'runId must look like 20260101T120000Z-0123abcd.' };
  const project = (await getProjects()).find(p => p.id === input.projectId);
  if (!project) return { ok: false, code: 'project-not-found', message: 'Project not found.' };
  const existing = await runs.getRecord(project.id, input.runId);
  if (existing) return existing.taskId === input.taskId ? { ok: true, record: existing, alreadyRecorded: true } : { ok: false, code: 'recorded-for-other-task', message: `Run ${input.runId} is already recorded${existing.taskId ? ` for another task (${existing.taskId})` : ' without a task'}.` };

  const loc = harness.locateHarness();
  if (!loc.ok) return { ok: false, code: loc.code, message: loc.message };
  const receipt = await harness.readReceipt(loc, input.runId);
  if (!receipt) return { ok: false, code: 'no-receipt', message: `The Harness has no receipt for ${input.runId} in ${loc.runs}. If the run is still going, wait for it; if it ended without one, the result is NOT proven and cannot be recorded as a result.` };
  if (receipt.schema !== 'godot-harness/2' || receipt.action === 'export') return { ok: false, code: 'not-a-test-receipt', message: `Receipt ${input.runId} is not a test run receipt (schema ${String(receipt.schema)}${receipt.action ? `, action ${receipt.action}` : ''}).` };

  const ctx = await resolveForProject(project, { projectId: project.id, taskId: input.taskId, checkout: input.checkout, origin: 'task' });
  if (!ctx.ok) return { ok: false, code: ctx.code, message: ctx.message, options: ctx.options };
  if (!receipt.checkout || !sameCheckout(String(receipt.checkout), ctx.checkoutPath)) {
    return { ok: false, code: 'wrong-checkout', message: `The run executed ${String(receipt.checkout)}, but this task's checkout is ${ctx.checkoutPath}. It is not evidence for this task's work; re-run with -Project set to ${ctx.checkoutPath}.` };
  }
  const rel = cleanRel(String(receipt.test ?? ''));
  if (!rel) return { ok: false, code: 'bad-receipt-test', message: `The receipt names no project-relative test (${String(receipt.test)}).` };

  const headCommittedAt = ctx.head ? await git(ctx.checkoutPath, 'log', '-1', '--format=%cI', ctx.head) : null;
  const finishedMs = Date.parse(String(receipt.finished_utc ?? ''));
  const commitMs = headCommittedAt ? Date.parse(headCommittedAt) : NaN;
  const movedOn = Number.isFinite(finishedMs) && Number.isFinite(commitMs) && commitMs > finishedMs;
  const notes = [...ctx.notes, 'Provenance (branch, HEAD, uncommitted changes) was captured when the run was recorded, after it finished; the Harness receipt does not carry a commit.'];
  if (movedOn) notes.push(`HEAD (${ctx.head?.slice(0, 8)}) was committed after the run finished: the result may describe an older commit.`);

  const record: runs.RunRecord = {
    runId: input.runId, projectId: project.id, action: rel.startsWith('tests/') ? 'test' : 'scene', file: rel, res: `res://${rel}`,
    taskId: ctx.taskId, taskNumber: ctx.taskNumber, taskTitle: ctx.taskTitle, origin: 'task',
    checkout: { path: ctx.checkoutPath, source: ctx.source, isMainCheckout: ctx.isMainCheckout, reason: ctx.reason, branch: ctx.branch, head: ctx.head, detached: ctx.detached, dirtyAtStart: ctx.dirty, reproducibleFromSha: ctx.reproducibleFromSha && !movedOn, notes },
    params: { mode: String(receipt.mode ?? 'HEADLESS'), profile: String(receipt.timeout?.profile ?? 'smoke'), marker: String(receipt.assertions?.marker ?? DEFAULT_MARKER) },
    harness: { dir: loc.dir, script: loc.script, source: loc.source, godot: '', godotVersion: receipt.godot_version ? String(receipt.godot_version) : null },
    command: [], startedAt: String(receipt.started_utc ?? new Date().toISOString()),
    runner: { exitCode: receipt.process?.exit_code ?? null, endedAt: String(receipt.finished_utc ?? new Date().toISOString()) },
    registered: { by: 'agent-report', at: new Date().toISOString(), headCommittedAt },
  };
  await runs.addRecord(project.id, record);
  return { ok: true, record, alreadyRecorded: false };
}

/** The part of an agent's brief that points at the contract instead of pasting it. Only for Godot projects. */
export function godotBriefSection(): string[] {
  return [
    '## Godot tests (JabutiStudio Harness)',
    'This is a Godot project. Do not guess how to run tests or experiment with Harness actions; ask the Harness through JabutiStudio:',
    '1. Call the MCP tool get_godot_capabilities { projectId, taskId }. It lists the actions, profiles and timeout budgets the installed Harness really supports, the test scenes in YOUR checkout, and the checkout a run will use.',
    '2. Pick a scene from `tests`, then call it again with { action: "run", test, profile } to get a validated command (with its run id). Run only a command it marks ok. Default profile smoke; if it refuses a timeout, choose a profile that fits or ask the user. Never invent an -OverrideReason.',
    '3. Afterwards call get_godot_run { projectId, runId } to read the verdict, receipt and evidence, then record_godot_run { projectId, taskId, runId } so Testing and Review show the same run.',
    '4. PASS means the assertions held in that checkout and commit; it is not gameplay approval. A stale, missing or infrastructure result is not a pass: say so in the resolution.',
    '',
  ];
}
