/**
 * Godot execution API (RC1). Kept apart from api.ts: refusals carry a code and explicit options that the UI
 * must show, so errors are structured instead of flattened into a message.
 */
const BASE = '/api'

export type Outcome =
  | 'RUNNING' | 'PASS' | 'TEST_FAILED' | 'NO_ASSERTIONS' | 'IMPORT_FAILED' | 'SCRIPT_FAILED' | 'TIMEOUT' | 'CANCELLED'
  | 'FOCUS_BLOCKED' | 'INFRA_BLOCKED' | 'STARTUP_FAILED' | 'ARTIFACT_MISSING' | 'LAUNCH_FAILED' | 'NO_RECEIPT' | 'FAILED'

export interface GodotSelection { taskId?: string; checkout?: 'main' | 'task'; file?: string; origin?: 'project' | 'task' | 'editor' }

export interface GodotContext {
  ok: true
  projectId: string; projectName: string; projectPath: string
  taskId?: string; taskNumber?: number; taskTitle?: string
  checkoutPath: string; source: 'project' | 'task'; isMainCheckout: boolean; reason: string
  origin: 'project' | 'task' | 'editor'
  branch: string | null; head: string | null; detached: boolean
  dirty: { count: number; files: string[] } | null
  reproducibleFromSha: boolean
  file?: { rel: string; res: string; absolute: string; ext: string; sameAsEditorCheckout?: boolean; existsInEditorCheckout?: boolean }
  notes: string[]
}
export interface SessionInCheckout { id: string; taskId?: string; taskNumber?: number; agent?: string; state: string | null; title?: string }
export interface LaunchResult {
  ok: true; kind: 'editor' | 'play'; context: GodotContext; godot: string; version: string | null; pid: number | null; args: string[]
  openedPath: string; scene?: string; note?: string; warnings: string[]; sessions: SessionInCheckout[]
}
/** `checkout` picks this run's checkout; `checkoutMode` records the task's checkout (kept on the task, asked once). */
export interface GodotRefusal { ok: false; code: string; message: string; options?: { checkout?: 'main' | 'task'; checkoutMode?: 'direct' | 'isolated'; label: string }[] }

export interface Related { rel: string; res: string; verified: boolean; reason: string }
export interface GodotClassification {
  kind: 'scene' | 'test-scene' | 'test-script' | 'gameplay-script' | 'other'
  evidence: string[]; warnings: string[]
  actions: { runScene: boolean; runTest: boolean; openInGodot: boolean; runRelatedTest: boolean; findRelated: boolean }
  relatedTests: Related[]; relatedScenes: Related[]; suggestions: Related[]
}

export interface GodotStatus {
  godotProject: boolean
  harness?: { ready: true; godot: string; version: string | null; dir: string; source: string } | { ready: false; code: string; message: string }
}

export interface RunRecord {
  runId: string; projectId: string; action: 'scene' | 'test'; file: string; res: string; via?: string
  taskId?: string; taskNumber?: number; taskTitle?: string; origin: 'project' | 'task' | 'editor'
  checkout: {
    path: string; source: 'project' | 'task'; isMainCheckout: boolean; reason: string
    branch: string | null; head: string | null; detached: boolean
    dirtyAtStart: { count: number; files: string[] } | null; reproducibleFromSha: boolean; notes: string[]
  }
  params: { mode: string; profile: string; marker: string }
  harness: { dir: string; script: string; source: string; godot: string; godotVersion: string | null }
  command: string[]; startedAt: string
  runner?: { exitCode: number | null; endedAt: string; stderrTail?: string; error?: string }
}
export interface Verdict {
  outcome: Outcome; harnessStatus: string | null; headline: string; reason: string | null
  executionCompleted: boolean; assertions: 'VERIFIED' | 'FAILED' | 'NOT_PROVEN'; visualEvidence: 'AVAILABLE' | 'NONE'; humanValidation: 'PENDING'; limitations: string[]
}
export interface RunListItem { record: RunRecord; running: boolean; verdict: Pick<Verdict, 'outcome' | 'headline' | 'harnessStatus' | 'reason'> }
export interface EvidenceFile { name: string; kind: 'log' | 'receipt' | 'screenshot'; bytes: number }
export interface RunView {
  record: RunRecord; running: boolean; verdict: Verdict; receipt: any | null; provenanceMismatch: string | null
  evidence: EvidenceFile[]; session: any | null
}

export class GodotError extends Error {
  constructor(message: string, readonly code: string, readonly options?: GodotRefusal['options']) { super(message) }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: init?.body ? { 'Content-Type': 'application/json' } : undefined, ...init })
  if (!(res.headers.get('content-type') || '').includes('application/json')) {
    throw new GodotError("This API answered with a web page instead of JSON. Another server is probably on this port (often a dev server from another checkout): stop it, then restart this checkout's server.", 'not-json')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new GodotError(body.message || body.error || res.statusText || 'Request failed', body.code || 'error', body.options)
  return body as T
}

const qs = (s: Record<string, string | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(s)) if (v) p.set(k, v)
  const t = p.toString()
  return t ? `?${t}` : ''
}

export const godotApi = {
  status: (projectId: string) => call<GodotStatus>(`/projects/${projectId}/godot/status`),
  /** Records a legacy task's checkout once (Direct Checkout or its own worktree). A person's click only. */
  recordCheckoutMode: (projectId: string, taskId: string, checkoutMode: 'direct' | 'isolated') =>
    call<{ ok: true; checkoutMode: 'direct' | 'isolated'; changed: boolean }>(`/projects/${projectId}/tasks/${taskId}/checkout-mode`, { method: 'POST', body: JSON.stringify({ checkoutMode }) }),
  context: (projectId: string, s: GodotSelection) =>
    call<{ context: GodotContext | GodotRefusal; classification?: GodotClassification | null; mainScene?: string | null; tests?: string[]; testScripts?: string[]; sessions?: SessionInCheckout[]; warnings?: string[] }>(`/projects/${projectId}/godot/context${qs({ ...s })}`),
  open: (projectId: string, s: GodotSelection) =>
    call<LaunchResult>(`/projects/${projectId}/godot/open`, { method: 'POST', body: JSON.stringify(s) }),
  play: (projectId: string, s: GodotSelection) =>
    call<LaunchResult>(`/projects/${projectId}/godot/play`, { method: 'POST', body: JSON.stringify(s) }),
  run: (projectId: string, body: GodotSelection & { file: string; action: 'scene' | 'test'; via?: string; mode?: 'HEADLESS' | 'RENDER_BACKGROUND' }) =>
    call<{ ok: true; record: RunRecord }>(`/projects/${projectId}/godot/runs`, { method: 'POST', body: JSON.stringify(body) }),
  runs: (projectId: string, file?: string, taskId?: string) => call<{ runs: RunListItem[] }>(`/projects/${projectId}/godot/runs${qs({ file, taskId })}`),
  /** Exact history of one file on one checkout (the index, not a window of recent runs). `stored` = runs held at all. */
  runsExact: (projectId: string, file: string, checkoutPath: string, limit = 1) =>
    call<{ runs: RunListItem[]; stored: number; storeLimit: number }>(`/projects/${projectId}/godot/runs${qs({ file, checkoutPath, exact: '1', limit: String(limit) })}`),
  runView: (projectId: string, runId: string) => call<RunView>(`/projects/${projectId}/godot/runs/${runId}`),
  cancel: (projectId: string, runId: string) => call<{ ok: true; output: string }>(`/projects/${projectId}/godot/runs/${runId}/cancel`, { method: 'POST', body: '{}' }),
  evidenceUrl: (projectId: string, runId: string, name: string) => `${BASE}/projects/${projectId}/godot/runs/${runId}/evidence?name=${encodeURIComponent(name)}`,
  evidenceText: async (projectId: string, runId: string, name: string) => {
    const res = await fetch(godotApi.evidenceUrl(projectId, runId, name))
    if (!res.ok) throw new Error('Could not read that file')
    return { text: await res.text(), truncated: res.headers.get('X-Truncated') === '1' }
  },
}

/** "Main checkout" or "Task #4 worktree" — the short name of a context, for labels. */
export function contextLabel(c: Pick<GodotContext, 'source' | 'taskNumber' | 'isMainCheckout'>): string {
  return c.isMainCheckout ? 'Main checkout' : `Task #${c.taskNumber ?? '?'} worktree`
}

export const shortSha = (sha?: string | null) => (sha ? sha.slice(0, 7) : '—')
