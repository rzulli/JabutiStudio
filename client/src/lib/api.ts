const BASE_URL = '/api';

interface RequestOptions extends RequestInit {
  timeout?: number;
}

/** One repo of a project and what it still holds (GET /git/pending). `repo` null = the project root. */
export interface GitPendingRepo {
  repo: string | null
  branch: string | null
  uncommitted: number
  ahead: number
  upstream: boolean
  error?: string
}

export interface Agent {
  id: string
  name: string
  /** Binary the terminal launches. */
  command: string
  /** Argument template — {cwd}, {task}, {taskFile}. */
  args: string
  builtin?: boolean
  /** Whether the binary answered a --version probe on this machine. */
  available?: boolean
  /** Suggested models for this harness; others can be typed. Empty when it has no model flag we know. */
  models?: { id: string; name: string }[]
  /** Reasoning-effort levels the harness accepts. Empty when it has none. */
  efforts?: string[]
}

/** What one run may choose besides the task: which harness, which model, how much effort. */
export interface AgentRunChoice {
  agent?: string
  model?: string
  effort?: string
}

export interface WorktreeInfo {
  path: string
  branch?: string
  projectId: string
  projectName?: string
  taskId: string
  taskNumber?: number
  taskTitle: string
  taskStatus: 'backlog' | 'todo' | 'in_progress' | 'done'
  doneAt?: string
  /** The recorded folder is no longer on disk. */
  missing: boolean
  /** The automatic sweep would remove it on its next pass. */
  stale: boolean
}

export interface WorktreeSettings {
  enabled: boolean
  basePath: string
  custom: boolean
  defaultBasePath: string
  ttlDays: number
  worktrees: WorktreeInfo[]
}

/** A live integrated-terminal session, as the server describes it. */
export interface TerminalSessionInfo {
  id: string
  projectId: string
  type: string
  /** Legacy one-string label: "[Project] Shell" */
  title: string
  createdAt: string
  taskId?: string
  agent?: string
  cwd?: string
  projectName?: string
  typeLabel?: string
  taskTitle?: string
  taskNumber?: number
  /** Name the user typed for the tab — wins over everything else. */
  customTitle?: string
  /** What the tab is about: the topic Claude Code gives its terminal, or an
   *  AI-written label for a shell. */
  summary?: string
  /** What a Claude session is doing right now. */
  state?: 'busy' | 'awaiting-input' | 'idle' | 'finished'
}

/** A Claude Code conversation that can be picked up with `claude --resume`. */
export interface ClaudeConversation {
  id: string
  projectId: string
  title?: string
  lastPrompt?: string
  updatedAt: string
  yolo: boolean
  taskId?: string
  /** It was on a tab when Shipyard last closed */
  open: boolean
}

export interface AppSettings {
  tasksDir: string
  terminalAiTitles?: boolean
  worktreePerTask?: boolean
  worktreeBasePath?: string
}

export type DeployState = 'success' | 'failed' | 'building' | 'idle' | 'unknown'

/** "Did the last build go up?" for one linked deploy. */
export interface DeployStatus {
  configured: boolean
  /** The link this status belongs to; absent when nothing is linked. */
  id?: string
  /** Sub-repository this status belongs to; absent means the project root. */
  subrepo?: string
  provider?: 'railway'
  state: DeployState
  rawStatus?: string
  deployedAt?: string
  url?: string
  projectName?: string
  environmentName?: string
  serviceName?: string
  /** Railway service this watches — what the picker marks as already linked. */
  serviceId?: string
  commitMessage?: string
  commitHash?: string
  branch?: string
  consoleUrl?: string
  error?: string
  checkedAt: string
}

export interface RailwayProjectSummary {
  id: string
  name: string
  environments: { id: string; name: string }[]
  /** `repo` is the GitHub repo the service builds from, when Railway says so. */
  services: { id: string; name: string; repo?: string }[]
}

export interface DeployCandidate {
  railwayProjectId: string
  railwayProjectName: string
  serviceId: string
  serviceName: string
  environmentId?: string
  environmentName?: string
}

export interface DeployMatch {
  projectId: string
  projectName: string
  repo: string
  /** Set when the repo came from a sub-repository rather than the project root. */
  subrepo?: string
  linked: boolean
  /** Candidates already being watched, so the picker can mark them. */
  linkedServiceIds: string[]
  candidates: DeployCandidate[]
}

export interface AutoLinkedEntry {
  projectId: string
  projectName: string
  subrepo?: string
  railwayProjectName: string
  serviceName: string
}

/** What Shipyard can link on its own, and what it needs a decision on. */
export interface MatchReport {
  sourceAvailable: boolean
  matched: DeployMatch[]
  ambiguous: DeployMatch[]
  unmatched: { projectId: string; projectName: string; repo: string | null; subrepo?: string }[]
}

export interface AutoLinkResult {
  linked: AutoLinkedEntry[]
  report: MatchReport
}

/** WhatsApp inbox connection. The token stays on the server. */
export interface InboxStatus {
  configured: boolean
  url: string | null
  lastSyncAt: string | null
  lastError: string | null
  lastCreated: number
  imported: number
}

/** A demand waiting for review in the WhatsApp inbox (GET /inbox/review). */
export interface InboxReviewDemand {
  id: string
  seq: number
  title: string
  description: string
  priority: 'urgent' | 'high' | 'medium' | 'low'
  effort: number | null
  kind: 'code' | 'admin'
  project_id: string | null
  contact_name: string
  created_at: string
  merged_at: string | null
  doubts: { q: string; answer?: string; dismissed?: boolean }[]
  target: { taskId: string | null; number: number | null; title: string | null; status: string | null } | null
  duplicate_of: { id: string; seq: number; status: string } | null
  messages: { id: string; from_me: boolean; kind: string; body: string; sent_at: string }[]
}

export interface InboxReview {
  count: number
  url: string
  demands: InboxReviewDemand[]
}

/** A demand the last syncs turned into a task or a note (GET /inbox/deliveries). */
export interface InboxDelivery {
  demandId: string
  at: string
  projectId: string
  taskId: string
  taskNumber?: number
  taskTitle: string
  title: string
  client?: string
  asNote: boolean
}

export interface DeployLinkInput {
  projectId: string
  projectName?: string
  environmentId?: string
  environmentName?: string
  serviceId?: string
  serviceName?: string
  /** Which checkout of the Shipyard project this link belongs to. */
  subrepo?: string
}

export interface SyncProviderStatus {
  providerId: 'trello' | 'clickup';
  connected: boolean;
  settingsSet: Record<string, boolean>;
  updatedAt: string | null;
}

export interface TaskCommitFile {
  file: string;
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface TaskCommit {
  hash: string;
  message: string;
  date: string;
  author_name: string;
  files: TaskCommitFile[];
  additions: number;
  deletions: number;
}

export interface TaskGitReview {
  available: boolean;
  branch: string | null;
  commits: TaskCommit[];
  files: { file: string; additions: number; deletions: number; commits: number }[];
  additions: number;
  deletions: number;
  working: { staged: number; unstaged: number; untracked: number } | null;
}

export type LifecycleStage = 'READY' | 'RUNNING' | 'REVIEW' | 'ACCEPTED' | 'INTEGRATED' | 'CLOSED';

/** What the board needs per task: enough to draw a chip, never to act on. */
export interface TaskLifecycleSummary {
  taskId: string
  stage: TaskLifecycle['stage']
  acceptance: 'none' | 'accepted' | 'lapsed'
  integration: 'integrated' | 'in-target' | 'not-integrated' | 'patch-equivalent' | 'nothing-to-integrate' | 'unknown'
  commits: number
  flag?: 'conflict' | 'branch-missing' | 'patch-equivalent'
}

/** Direct-checkout delivery: candidates by time only until a person identifies the range (server taskLifecycle.ts). */
export interface DirectDelivery {
  candidates: { sha: string; subject: string; date: string; author: string; trailer: boolean }[]
  claim?: { at: string; targetBranch: string; baseSha: string; headSha: string; basis: 'trailer' | 'person'; note?: string }
  claimProblem?: string
  uncertainty: string[]
  concurrentTasks: { id: string; number?: number; title: string }[]
}

export interface TaskLifecycle {
  taskId: string;
  projectId: string;
  stage: LifecycleStage;
  execution: { status: string; finished: boolean; sessionActive: boolean; sessions: { id: string; agent?: string; type?: string; state?: string | null; cwd?: string }[] };
  delivery: {
    mode: 'branch' | 'direct' | 'none'; branch?: string; head?: string | null; worktreePath?: string; worktreeExists: boolean; worktreeMatches: boolean;
    dirty: { count: number; files: string[] };
    commits: TaskCommit[];
    files: { file: string; additions: number; deletions: number; commits: number }[];
    additions: number; deletions: number;
    direct?: DirectDelivery;
  };
  target: { branch: string | null; exists: boolean; head?: string | null; baseline?: string | null; checkoutBranch: string | null; checkoutDirty: number; operation: string | null };
  acceptance: { state: 'none' | 'accepted' | 'lapsed'; reason?: string; record?: { at: string; headSha: string; targetBranch: string; branch: string; note?: string } };
  integration: { state: 'integrated' | 'in-target' | 'not-integrated' | 'patch-equivalent' | 'nothing-to-integrate' | 'unknown'; mergeable: 'clean' | 'conflict' | 'unknown' | null; mergeCommit?: string };
  blockers: { code: string; message: string }[];
  canAccept: boolean;
  canIntegrate: boolean;
  history: { at: string; event: string; detail?: Record<string, unknown> }[];
  closure?: { at: string; worktreePath: string; branch: string; headSha: string; worktree: 'removed' | 'failed' | 'absent'; branchResult: 'deleted' | 'preserved' | 'failed'; note?: string };
}

export interface CloseCheck { code: string; ok: boolean; message: string; acknowledgeable?: boolean }

/** What closing a task's worktree would do (server worktreeClose.ts). `token` names the exact state shown. */
export interface ClosePreview {
  taskId: string; taskNumber?: number; title: string; stage: LifecycleStage;
  mode: 'worktree' | 'branch-only' | 'none';
  allowed: boolean; needsAcknowledgement: boolean;
  checks: CloseCheck[];
  blockers: { code: string; message: string }[];
  worktree: { path: string | null; branch: string | null; head: string | null; exists: boolean; registered: boolean; locked: boolean };
  integration: { targetBranch: string | null; acceptedSha: string | null; mergeCommit: string | null; targetHead: string | null };
  changes: { total: number; counts: Record<string, number>; ignored: { total: number; sample: string[]; truncated: boolean }; digest: string } | null;
  sessions: { id: string; agent?: string; type?: string; state?: string | null }[];
  branch: { name: string | null; action: 'delete' | 'preserve'; reason: string };
  willRemove: string[]; willPreserve: string[];
  token: string;
}

export interface CloseOutcome {
  ok: boolean; complete?: boolean; code?: string; message?: string;
  result?: { worktree: 'removed' | 'failed' | 'absent'; branch: 'deleted' | 'preserved' | 'failed'; note?: string };
}

export interface WorktreeInventoryEntry {
  path: string; isMain: boolean; exists: boolean; branch: string | null; head: string | null;
  detached: boolean; locked: boolean; prunable: boolean;
  task: null | { id: string; number?: number; title: string; status: string; origin: 'shipyard' | 'manual'; stage: LifecycleStage; integration: TaskLifecycle['integration']['state']; acceptance: TaskLifecycle['acceptance']['state'] };
  collisions: { id: string; number?: number; title: string; origin: 'shipyard' | 'manual' }[];
  comparedTo: { branch: string | null; reason: 'accepted-target' | 'main-checkout-branch' };
  unmergedCommits: number | null;
  changes: null | { total: number; staged: number; modified: number; untracked: number; deleted: number; renamed: number; conflicted: number };
  sessions: { id: string; agent?: string; type?: string; state?: string | null }[];
  flags: { taskLinked: boolean; unlinked: boolean; integrated: boolean; unmerged: boolean; dirty: boolean; busy: boolean; unknown: boolean };
  cleanup: { allowed: boolean; needsAcknowledgement: boolean; blockers: { code: string; message: string }[] };
}

export interface WorktreeInventory {
  projectId: string;
  checkout: { path: string; branch: string | null; head: string | null };
  worktrees: WorktreeInventoryEntry[];
  summary: { total: number; taskLinked: number; unlinked: number; integrated: number; unmerged: number; dirty: number; busy: number; unknown: number; closable: number };
  generatedAt: string;
}

export interface WorktreeChangeReport {
  total: number;
  counts: Record<string, number>;
  entries: { path: string; kinds: string[]; assessment: 'apparent-reserialization' | 'material' | 'unknown'; generated?: boolean }[];
  entriesTruncated: boolean;
  ignored: { total: number; sample: string[]; truncated: boolean };
  resources: {
    total: number; apparentReserialization: number; material: number; unknown: number; withReferenceRemovals: number; pattern: string | null;
    files: { path: string; classification: string; assessment: 'apparent-reserialization' | 'material' | 'unknown'; addedLines: number; removedLines: number; extResourcesRemoved: string[]; extResourcesAdded: number }[];
  };
  unknownCount: number;
}

export type UsageSeverity = 'normal' | 'warning' | 'critical';

export interface UsageWindow {
  percent: number;
  resetsAt: string | null;
}

export interface ScopedUsageWindow extends UsageWindow {
  label: string;
}

/** Subscription usage from the Claude CLI's OAuth session. */
export type ClaudeUsage =
  | {
      available: true;
      plan: string | null;
      session: UsageWindow | null;
      weekly: UsageWindow | null;
      scoped: ScopedUsageWindow[];
      severity: UsageSeverity;
      extraCredits: { enabled: boolean; percent: number | null } | null;
      fetchedAt: string;
      stale: boolean;
    }
  | { available: false; reason: 'no-oauth' | 'request-failed' };

export interface SyncIntegration {
  providerId: 'trello' | 'clickup';
  projectId: string;
  milestoneId: string;
  enabled: boolean;
  autoSync: boolean;
  settings: Record<string, any>;
  state: Record<string, any>;
  lastSyncAt: string | null;
  lastSyncStatus: 'ok' | 'error' | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncOperationResult {
  success: boolean;
  message: string;
  pushed?: number;
  pulled?: number;
  created?: number;
  updated?: number;
  errors?: string[];
  remoteUrl?: string;
  milestoneId?: string;
}

function searchParams(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) qs.set(key, value)
  return qs.toString()
}

export interface ContentSearchOptions {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  /** Also search node_modules, dist, build and git-ignored files. */
  includeIgnored?: boolean
}

export interface ContentSearchMatch { line: number; text: string; column: number; length: number }
export interface ContentSearchResult {
  file: string
  filePath: string
  projectId: string
  projectName: string
  extension?: string
  matches: ContentSearchMatch[]
}
export interface ContentSearchResponse {
  results: ContentSearchResult[]
  totalMatches: number
  truncated: boolean
  timedOut: boolean
  elapsedMs: number
}

export type ExplorerKind = 'file' | 'func' | 'signal' | 'class' | 'external'
export interface ExplorerNode {
  id: string; label: string; kind: ExplorerKind
  file: string; line: number; community: number
}
export interface ExplorerEdge {
  from: string; to: string; relation: string
  confidence: 'EXTRACTED' | 'INFERRED' | string
  file: string; line: number; count: number
}
export interface ExplorerNeighbor { edge: ExplorerEdge; node: ExplorerNode }
export interface ExplorerNodeDetail {
  node: ExplorerNode
  outgoing: ExplorerNeighbor[]; incoming: ExplorerNeighbor[]
  contains: ExplorerNode[]; container?: ExplorerNode
}
export type ExplorerResponse =
  | { godot: false; root: string }
  | {
      godot: true; root?: string; installed: boolean; building: boolean; built: boolean; builtAt?: string
      staleness?: { changed: number; added: number; removed: number; checkedAt: number }
      summary?: { nodes: number; edges: number; files: number; relations: Record<string, number>; confidence: Record<string, number> }
    }
export interface ExplorerSearchResult { total: number; nodes: ExplorerNode[]; counts: Record<ExplorerKind, number> }
export interface ExplorerBuildResult { files: number; nodes: number; edges: number; tookMs: number }

async function request<T>(path: string, options?: RequestOptions): Promise<T> {
  const { timeout, ...fetchOptions } = options || {};
  const headers: Record<string, string> = {};
  if (fetchOptions.body) {
    headers['Content-Type'] = 'application/json';
  }

  let signal = fetchOptions.signal;
  let controller: AbortController | undefined;
  if (timeout && !signal) {
    controller = new AbortController();
    signal = controller.signal;
    setTimeout(() => controller!.abort(), timeout);
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    headers,
    ...fetchOptions,
    signal,
  }).catch((err) => {
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || error.message || 'Request failed');
  }

  // A non-JSON answer means the port serves something other than this API (e.g. a stale server or a web page).
  if (!(res.headers.get('content-type') || '').includes('application/json')) {
    throw new Error("This API answered with a web page instead of JSON. Another server is probably on this port (often a dev server from another checkout): stop it, then restart this checkout's server.");
  }
  return res.json();
}

export interface CloudStatus {
  connected: boolean
  defaultServerUrl: string
  serverUrl?: string
  email?: string
  deviceName?: string
  syncing?: boolean
  lastSyncAt?: string | null
  lastError?: string | null
  /** Local changes not on the server yet. */
  pending?: number
  synced?: number
  plan?: { plan: string; active: boolean; planExpiresAt: string | null; upgradeUrl: string | null } | null
  usage?: { records: number; bytes: number } | null
  devices?: { id: string; name: string; lastSeenAt: string; current: boolean }[]
  /** Projects other machines have that this one has no folder for. */
  missingProjects?: { id: string; name: string; folder: string; remote?: string }[]
}

export interface CloudCredentials {
  email: string
  password: string
  serverUrl?: string
  deviceName?: string
}

export type AiProvider = 'claude' | 'openai' | 'gemini'

export interface AiProviderStatus {
  provider: AiProvider
  label: string
  /** Command the provider's CLI is detected under (claude / codex / gemini). */
  cliCommand: string
  cliAvailable: boolean
  /** Claude only: a live OAuth token means calls run on the subscription. */
  oauthAvailable: boolean
  apiConfigured: boolean
  model: string | null
  maxTokens: number | null
  activeBackend: 'cli-oauth' | 'cli' | 'api' | null
}

export interface AiBackendStatus {
  preferredProvider: AiProvider
  activeProvider: AiProvider | null
  activeBackend: 'cli-oauth' | 'cli' | 'api' | null
  providers: AiProviderStatus[]
}


export type DesignFreshness = 'CURRENT' | 'MOVED' | 'CHANGED' | 'AMBIGUOUS' | 'STALE' | 'GONE' | 'UNKNOWN'
export interface DesignApproval {
  lapsed?: boolean; state: 'unknown' | 'claimed' | 'approved' | 'rejected' | 'revoked'; source: string; quote?: string; at?: string; channel?: string; detail?: string }
export interface DesignEvidence {
  type: string; ref: string; note: string; candidate_only: boolean; freshness: DesignFreshness; detail: string
  lines?: [number, number] | null; path?: string | null; excerpt: { line: number; text: string }[]
}
export interface DesignDecision {
  id: string; title: string; claim: string; claim_sha256: string; system?: string | null
  decision_state: string; approval: DesignApproval; evidence_status: string; implementation: string; catalogued_implementation: string
  supersedes: string[]; conflicts_with: string[]; matched_by?: string[]
  files: { role: string; path: string }[]; tests: { path: string; direct: boolean }[]; qps: { path: string; direct: boolean }[]
  evidence: DesignEvidence[]
  source?: 'native' | 'legacy'; systems?: string[]; provenance?: { origin?: string; createdAt?: string; status?: string }
}

// ---- System catalog (Explorer > Systems) ----
export type SystemStatus = 'proposed' | 'confirmed' | 'dismissed' | 'merged'
export interface SystemSummary {
  id: string; name: string; summary: string; status: SystemStatus; origin: 'discovery' | 'agent' | 'user'
  kind: 'system' | 'subsystem' | 'mechanic' | 'entity'; planned: boolean; createdAt: string
  files: number; decisions: number; conflicts: number; flags: string[]
}
export interface CatalogProbe { dir: string; file: string; exists: boolean; sha256: string | null; systems: number; ids: string[]; modifiedAt: string | null; error?: string }
export interface CatalogResolutionRecord { dir: string; sourceSha256: string; resolvedAt: string; manifest: string | null; choices: Record<string, string>; targetSha256After: string | null }
export interface SiblingCatalog extends CatalogProbe { relation: 'identical' | 'addable' | 'conflicting' | 'resolved' | 'unreadable'; label: string; addableIds: string[]; conflictIds: string[]; resolution?: CatalogResolutionRecord }
export type CatalogChoice = 'keep-active' | 'take-other' | 'keep-both'
export interface CatalogCompareRow { id: string; name: string; kind: 'identical' | 'only-here' | 'only-there' | 'different' | 'duplicate'; changes: { field: string; here: string; there: string }[]; duplicateOf?: string; hereUpdatedAt?: string; thereUpdatedAt?: string; hereStatus?: string; thereStatus?: string }
export interface CatalogSide { dir: string; label: string; sha256: string | null; systems: number; modifiedAt: string | null }
export interface CatalogCompare { active: CatalogSide; other: CatalogSide; rows: CatalogCompareRow[]; resolution: CatalogResolutionRecord | null }
export interface CatalogSourceReport {
  identity: { projectId: string; path: string }
  source: { dataDir: string; selectedBy: string; mode: string; port: string | null; pid: number }
  active: CatalogProbe & { label: string; loaded: number | null; lastRead: { at: string; ok: boolean; systems: number; error?: string } | null }
  others: SiblingCatalog[]
}
export interface SystemCheckout { root: string; isCanonical: boolean; branch?: string; head?: string; unborn?: boolean; uncommitted: number; integration: string }
export type SystemTier = 'core' | 'participant' | 'candidate' | 'test' | 'historical' | 'related'
export type SystemFacet = 'logic' | 'data' | 'ui' | 'telemetry' | 'purchase' | 'requirement' | 'effect' | 'test' | 'other'
export type EvidenceState = 'verified' | 'file-only' | 'moved' | 'stale' | 'missing'
export type EvidenceBasis = 'demonstrated' | 'inferred' | 'candidate' | 'stale'
export interface SystemEvidence { path: string; needle?: string; note?: string; state: EvidenceState; line?: number; resolvedPath?: string }
export interface SystemMember {
  path: string; role: 'code' | 'scene' | 'resource' | 'test'; score: number
  why: { kind: 'anchor' | 'dk' | 'name' | 'mention'; detail: string }[]
  confidence: 'declared' | 'extracted'; tier: SystemTier; facet: SystemFacet; areas: string[]
  uncommitted: boolean; changedSinceAnalysis: boolean
  state: 'ok' | 'moved'; movedFrom?: string
  symbols: { id: string; label: string; kind: string; line: number }[]
}
export interface SystemFamily { key: string; label: string; count: number; sample: string[]; paths: string[] }
export interface SystemArea {
  id: string; name: string; kind: 'subsystem' | 'mechanic' | 'entity' | 'facet'; summary: string
  status: 'proposed' | 'confirmed' | 'inferred'; origin: string; inferred: boolean; basis: EvidenceBasis
  evidence: SystemEvidence[]
  files: { path: string; tier: SystemTier; facet: SystemFacet; line?: number; uncommitted: boolean }[]
  fileCount: number; testCount: number; families: SystemFamily[]
  anchors?: { files: string[]; terms: string[] }
  responsibilities?: string[]; planned?: boolean
}
export interface SystemEndpoint { ref: string; label: string; type: 'self' | 'area' | 'system' | 'entity'; systemId?: string; areaId?: string; known: boolean }
export interface SystemRelation {
  id: string; kind: string; label: string; from: SystemEndpoint; to: SystemEndpoint; note?: string
  status: 'proposed' | 'confirmed'; origin: string; basis: EvidenceBasis; evidence: SystemEvidence[]
  direction: 'internal' | 'outgoing' | 'incoming'; storedIn: string; examinedHead?: string
}
export interface SystemTechnicalLink { toSystem?: string; toName: string; files: string[]; relations: Record<string, number>; edges: number; extracted: number; inferred: number }
export interface SystemCompareRow {
  kind: 'code' | 'code-comment' | 'document' | 'test'; label: string; ref: string; freshness?: string; note?: string
  value?: number; unit?: string; line?: string; ambiguous?: boolean; fromDecision: string
}
export interface SystemCompareColumn {
  key: string; value?: number; unit?: string
  claimedBy: { id: string; title: string; decisionState: string; approval: string; evidenceStatus: string; implementation: string }[]
  rows: SystemCompareRow[]; implemented: boolean; declared: boolean; inTests: boolean
}
export interface SystemComparison { id: string; topic: string; numeric: boolean; decisions: string[]; columns: SystemCompareColumn[]; approvalNote: string; unitNote: string }
export interface SystemDecision {
  id: string; title: string; claim: string; decisionState: string
  approval?: { state: string; source: string; quote?: string }
  evidenceStatus: string; implementation: string; conflictsWith: string[]
  relevance: 'declared' | 'term' | 'touches-member'; origin?: string
  evidence: { type: string; ref: string; freshness?: string; detail?: string; note?: string; excerpt: string[] }[]
  files: string[]; tests: string[]
}
export type SystemDiagnosticRef = { path: string; source: string; state: 'absent' | 'absent-since-analysis' | 'other-checkout' | 'not-indexed' | 'unknown' }
export interface SystemDiagnostic {
  code: 'proposal' | 'graph-not-built' | 'graph-stale' | 'graph-other-checkout' | 'files-missing' | 'files-not-indexed' | 'files-unverifiable' | 'references-vanished'
  kind: 'classification' | 'analysis' | 'integrity'; severity: 'info' | 'warning'
  title: string; meaning: string; cause: string; effect: string
  action: { kind: 'review' | 'reanalyze' | 'edit-members' | 'acknowledge' | 'none'; label: string; available: boolean; blockedReason?: string }
  refs: SystemDiagnosticRef[]; altersDesign: false
}
export interface SystemAnalysis { state: 'not-built' | 'current' | 'stale' | 'other-checkout'; label: string; builtAt?: number; describes: string }
export interface SystemView {
  id: string; name: string; summary: string; responsibilities: string[]
  kind: 'system' | 'subsystem' | 'mechanic' | 'entity'; planned: boolean
  areas: SystemArea[]; relations: SystemRelation[]; technical: SystemTechnicalLink[]; comparisons: SystemComparison[]
  families: SystemFamily[]; testGroups: { dir: string; count: number; paths: string[] }[]
  overlaps: { id: string; name: string; shared: number; ratio: number }[]
  tierCounts: Record<SystemTier, number>
  status: SystemStatus; origin: 'discovery' | 'agent' | 'user'; confirmedAt?: string; confirmedVia?: string
  anchors: { terms: string[]; files: string[]; decisions: string[] }
  mergedInto?: string; mergedFrom?: string[]
  suggestions: { at: string; origin: string; summary?: string; anchors: { terms: string[]; files: string[]; decisions: string[] }; areas?: unknown[]; relations?: unknown[] }[]
  checkout: SystemCheckout
  members: SystemMember[]; weakerMembers: number
  neighbors: { path: string; edges: number; confidence: string; relation: string; via: string; relations: Record<string, number>; extractedEdges: number; inferredEdges: number }[]
  design: { available: boolean; reason?: string; decisions: SystemDecision[]; conflicts: [string, string][] }
  tasks: { id: string; number?: number; title: string; status: string; matchedBy: string }[]
  related: { id: string; name: string; shared: string[]; declared: boolean }[]
  maintenance: {
    graph: { built: boolean; builtAt?: number; describesCheckout: string; installed?: boolean }
    changedMembers: string[]; needsReanalysis: boolean
    vanished: { key: string; since: string }[]; unresolvedAnchors: { path: string; state: 'gone'; source?: string }[]
    graphAgainstCheckout: string
    analysis: SystemAnalysis; diagnostics: SystemDiagnostic[]
  }
  limitations: string[]
}
export interface SystemRelationInput { id?: string; kind: string; from: string; to: string; note?: string; evidence?: { path: string; needle?: string; note?: string }[] }
export interface SystemCreate { name: string; summary?: string; kind?: 'system' | 'subsystem' | 'mechanic' | 'entity'; terms?: string[]; files?: string[]; planned?: boolean; createOnly?: boolean }
export interface SystemEdit {
  name?: string; summary?: string; responsibilities?: string[]; status?: 'confirmed' | 'proposed' | 'dismissed'
  anchors?: { terms?: string[]; files?: string[]; decisions?: string[] }; ackVanished?: boolean; clearSuggestions?: boolean
  confirm?: { areas?: string[]; relations?: string[] }; remove?: { areas?: string[]; relations?: string[] }; adoptSuggestion?: number
  kind?: 'system' | 'subsystem' | 'mechanic' | 'entity'; dropSuggestion?: number
  setArea?: { id?: string; name: string; kind?: 'subsystem' | 'mechanic' | 'entity'; summary?: string; files?: string[]; terms?: string[]; responsibilities?: string[]; planned?: boolean; evidence?: { path: string; needle?: string; note?: string }[] }
  upsertRelation?: SystemRelationInput; planned?: boolean
  replaceRelation?: { id: string; relation: SystemRelationInput }
}
/** Portable system as published in jabutistudio.systems.json (only the fields the UI compares). */
export interface PortableSystem {
  id: string; name: string; summary: string; responsibilities: string[]; status: 'proposed' | 'confirmed' | 'dismissed' | 'merged'
  origin: 'discovery' | 'agent' | 'user'; confirmedAt?: string; confirmedVia?: string; updatedAt: string; kind?: string
  anchors: { terms: string[]; files: string[]; decisions: string[] }
  areas?: { id: string; name: string; kind: string; status: string }[]
  relations?: { id: string; kind: string; from: string; to: string; status: string }[]
}
export type KnowledgeState = 'published' | 'local-change' | 'diverged' | 'unpublished-proposal' | 'unavailable'
export interface KnowledgeChange { field: string; published: unknown; local: unknown }
export interface KnowledgeSystem {
  id: string; name: string; state: KnowledgeState
  published: PortableSystem | null; workingFile: PortableSystem | null; local: PortableSystem | null
  changes: KnowledgeChange[]; fileChanges: KnowledgeChange[]; evidenceStale: boolean
}
export interface KnowledgeReconciliation {
  project: string
  checkout: { root: string; isCanonical: boolean; branch?: string; head?: string; dirty: boolean | null; unborn: boolean }
  revision: { requested: string; commit: string | null; unborn: boolean; examinedWorkingTree: boolean }
  file: { state: 'present' | 'modified' | 'untracked' | 'absent' | 'invalid' | 'incompatible'; reason?: string
    revisionSha256?: string; workingSha256?: string; expectedSha256?: string; integration?: 'same' | 'differs' | 'absent-in-main' }
  systems: KnowledgeSystem[]; limitations: string[]
}
export interface KnowledgeDigest { id: string; name: string; status: string; origin: string; areas: number; relations: number; proposedItems: number }
export interface KnowledgePlan {
  export: { target: string; canExport: boolean; reason?: string; needsFirstCommit?: boolean; systems: KnowledgeDigest[] }
  update: { exists: false } | { exists: true; error: string } | {
    exists: true; sha256: string; fileOnly: KnowledgeDigest[]
    rows: { id: string; name: string; action: 'add' | 'update' | 'unchanged' | 'needs-choice'; status: string; origin: string
      changes: KnowledgeChange[]; file: PortableSystem | null; local: PortableSystem }[]
  }
  import: { exists: false } | { exists: true; error: string } | {
    exists: true; sha256: string; conflicts: number; importable: number; safe: boolean
    items: (KnowledgeDigest & { kind: 'new' | 'identical' | 'changed' | 'duplicate'; against?: string; evidenceStale: boolean; provenance?: string
      changes: { field: string; current: unknown; incoming: unknown }[] })[]
  }
}

const wt = (w?: string) => (w ? `worktree=${encodeURIComponent(w)}` : '')

export interface ProposeDecisionBody {
  title: string; claim: string; scope?: string[]; systems?: string[]; files?: string[]; conflictsWith?: string[]
  evidence: { type: string; path: string; startLine?: number; needle?: string; note?: string }[]
}

export interface DesignContext {
  available: boolean; reason?: string
  root?: string; branch?: string | null; head?: string | null; indexed?: boolean; note?: string | null
  examined?: { root: string; isCanonical: boolean; registry: string; revision?: string }
  decisions?: DesignDecision[]
  conflicts?: { ids: string[] }[]
  sources?: { native: { state: string; reason?: string; count: number }; legacy: { available: boolean; reason?: string } }
  graph?: { built: boolean; incoming: { file: string; relation: string; confidence: string; line: number }[]; outgoing: { file: string; relation: string; confidence: string; line: number }[] }
}

export const api = {
  getExplorer: (projectId: string) => request<ExplorerResponse>(`/projects/${projectId}/explorer`),
  buildExplorer: (projectId: string) =>
    request<ExplorerBuildResult>(`/projects/${projectId}/explorer/build`, { method: 'POST', timeout: 11 * 60_000 }),
  searchExplorer: (projectId: string, q: string, kind: string, signal?: AbortSignal) =>
    request<ExplorerSearchResult>(`/projects/${projectId}/explorer/search?q=${encodeURIComponent(q)}&kind=${kind}`, { signal }),
  getExplorerNode: (projectId: string, node: string) =>
    request<ExplorerNodeDetail>(`/projects/${projectId}/explorer/node?node=${encodeURIComponent(node)}`),
  getDesign: (projectId: string, file: string, worktree?: string) =>
    request<DesignContext>(`/projects/${projectId}/design?file=${encodeURIComponent(file)}${worktree ? `&worktree=${encodeURIComponent(worktree)}` : ''}`),
  getDesignCheckouts: (projectId: string) =>
    request<{ legacyRecords: number; checkouts: { path: string; branch?: string }[] }>(`/projects/${projectId}/design/checkouts`),
  proposeDecision: (projectId: string, body: ProposeDecisionBody) =>
    request<DesignDecision & { id: string }>(`/projects/${projectId}/design/proposals`, { method: 'POST', body: JSON.stringify(body) }),
  attestDecision: (projectId: string, body: { decisionId: string; state: 'approved' | 'rejected' | 'revoked'; quote: string }) =>
    request<{ decision_id: string; state: string }>(`/projects/${projectId}/design/approve`, { method: 'POST', body: JSON.stringify(body) }),
  getSystems: (projectId: string, worktree?: string) =>
    request<{ systems: SystemSummary[]; loadErrors: { id: string; name: string; error: string }[]; checkout: SystemCheckout | null; dismissed: number }>(`/projects/${projectId}/systems?${wt(worktree)}`),
  getSystem: (projectId: string, id: string, worktree?: string) =>
    request<SystemView>(`/projects/${projectId}/systems/${encodeURIComponent(id)}?${wt(worktree)}`),
  getSystemBrief: (projectId: string, id: string, worktree?: string, goal?: string, area?: string) =>
    request<{ text: string; head?: string; root: string }>(`/projects/${projectId}/systems/${encodeURIComponent(id)}/brief?${wt(worktree)}${goal ? `&goal=${encodeURIComponent(goal)}` : ''}${area ? `&area=${encodeURIComponent(area)}` : ''}`),
  discoverSystems: (projectId: string, worktree?: string) =>
    request<{ added: number; candidates: number }>(`/projects/${projectId}/systems/discover?${wt(worktree)}`, { method: 'POST' }),
  editSystem: (projectId: string, id: string, body: SystemEdit) =>
    request<unknown>(`/projects/${projectId}/systems/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  createSystem: (projectId: string, body: SystemCreate) =>
    request<{ id: string; outcome: string }>(`/projects/${projectId}/systems`, { method: 'POST', body: JSON.stringify(body) }),
  mergeSystems: (projectId: string, into: string, from: string[]) =>
    request<unknown>(`/projects/${projectId}/systems/${encodeURIComponent(into)}/merge`, { method: 'POST', body: JSON.stringify({ from }) }),
  splitSystem: (projectId: string, id: string, body: { name: string; terms?: string[]; files?: string[] }) =>
    request<{ id: string }>(`/projects/${projectId}/systems/${encodeURIComponent(id)}/split`, { method: 'POST', body: JSON.stringify(body) }),
  getKnowledge: (projectId: string, worktree?: string, revision?: string) =>
    request<KnowledgeReconciliation>(`/projects/${projectId}/systems/knowledge?${wt(worktree)}${revision ? `&revision=${encodeURIComponent(revision)}` : ''}`),
  getKnowledgePlan: (projectId: string) => request<KnowledgePlan>(`/projects/${projectId}/systems/knowledge/plan`),
  firstCommitKnowledge: (projectId: string) =>
    request<{ commit: string; branch: string | null }>(`/projects/${projectId}/systems/knowledge/first-commit`, { method: 'POST', body: '{}' }),
  exportKnowledge: (projectId: string, systemIds: string[]) =>
    request<{ sha256: string | null }>(`/projects/${projectId}/systems/knowledge/export`, { method: 'POST', body: JSON.stringify({ systemIds }) }),
  updateKnowledge: (projectId: string, body: { expectedSha256: string; systemIds: string[]; takeLocal: string[]; expectedLocal: Record<string, string> }) =>
    request<{ updated: string[]; unchanged: string[]; sha256: string }>(`/projects/${projectId}/systems/knowledge/update`, { method: 'POST', body: JSON.stringify(body) }),
  importKnowledge: (projectId: string, expectedSha256: string) =>
    request<{ added: number }>(`/projects/${projectId}/systems/knowledge/import`, { method: 'POST', body: JSON.stringify({ expectedSha256 }) }),
  getCatalogSource: (projectId: string) => request<CatalogSourceReport>(`/projects/${projectId}/systems/catalog-source`),
  importCatalogSource: (projectId: string, body: { fromDir: string; expectedSourceSha256: string; expectedTargetSha256: string | null }) =>
    request<{ added: string[]; backup: string | null; manifest: string | null }>(`/projects/${projectId}/systems/catalog-source/import`, { method: 'POST', body: JSON.stringify(body) }),
  compareCatalogSource: (projectId: string, fromDir: string) => request<CatalogCompare>(`/projects/${projectId}/systems/catalog-source/compare?fromDir=${encodeURIComponent(fromDir)}`),
  resolveCatalogSource: (projectId: string, body: { fromDir: string; expectedSourceSha256: string; expectedTargetSha256: string | null; choices: Record<string, CatalogChoice> }) =>
    request<{ added: string[]; replaced: string[]; copies: string[]; keptActive: string[]; backup: string | null; manifest: string; systems: number }>(`/projects/${projectId}/systems/catalog-source/resolve`, { method: 'POST', body: JSON.stringify(body) }),
  // Shipyard Cloud
  getCloudStatus: () => request<CloudStatus>('/cloud/status'),
  cloudSignup: (body: CloudCredentials) => request<CloudStatus>('/cloud/signup', { method: 'POST', body: JSON.stringify(body), timeout: 120_000 }),
  cloudLogin: (body: CloudCredentials) => request<CloudStatus>('/cloud/login', { method: 'POST', body: JSON.stringify(body), timeout: 120_000 }),
  cloudLogout: () => request<CloudStatus>('/cloud/logout', { method: 'POST' }),
  cloudSyncNow: () => request<CloudStatus>('/cloud/sync', { method: 'POST', timeout: 300_000 }),

  // Projects
  getProjects: () => request<{ projects: any[] }>('/projects'),
  refreshProjects: () => request<{ projects: any[] }>('/projects/refresh', { method: 'POST' }),
  updateProject: (id: string, data: any) => request(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Milestones
  getMilestones: (projectId: string) => request<{ milestones: any[] }>(`/projects/${projectId}/milestones`),
  createMilestone: (projectId: string, data: { name: string; description?: string }) =>
    request(`/projects/${projectId}/milestones`, { method: 'POST', body: JSON.stringify(data) }),
  updateMilestone: (projectId: string, milestoneId: string, data: { name?: string; description?: string; status?: string }) =>
    request(`/projects/${projectId}/milestones/${milestoneId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteMilestone: (projectId: string, milestoneId: string) =>
    request(`/projects/${projectId}/milestones/${milestoneId}`, { method: 'DELETE' }),

  // Tasks
  getAllTasks: () => request<{ tasks: any[] }>('/tasks/all'),
  getTasks: (projectId: string, milestoneId?: string) =>
    request<{ tasks: any[] }>(`/projects/${projectId}/tasks${milestoneId ? `?milestone=${encodeURIComponent(milestoneId)}` : ''}`),
  getTaskForecast: (projectId: string, milestoneId?: string) =>
    request<any>(`/projects/${projectId}/tasks/forecast${milestoneId ? `?milestone=${encodeURIComponent(milestoneId)}` : ''}`),
  createTask: (projectId: string, data: any) => request(`/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (projectId: string, taskId: string, data: any) => request(`/projects/${projectId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(data) }),
  addTaskNote: (projectId: string, taskId: string, note: string, status?: string) =>
    request(`/projects/${projectId}/tasks/${taskId}/note`, { method: 'POST', body: JSON.stringify({ note, status }) }),
  deleteTask: (projectId: string, taskId: string) => request(`/projects/${projectId}/tasks/${taskId}`, { method: 'DELETE' }),
  reorderTasks: (projectId: string, taskIds: string[]) => request(`/projects/${projectId}/tasks/reorder`, { method: 'POST', body: JSON.stringify({ taskIds }) }),
  importTasks: (projectId: string, tasks: any[]) => request<{ imported: number }>(`/projects/${projectId}/tasks/import`, { method: 'POST', body: JSON.stringify({ tasks }) }),
  importAllTasks: (tasks: any[]) => request<{ imported: number }>('/tasks/import', { method: 'POST', body: JSON.stringify({ tasks }) }),
  applyCsvChanges: (projectId: string, changes: { update: any[]; create: any[]; remove: string[] }) =>
    request<{ updated: number; created: number; removed: number }>(`/projects/${projectId}/tasks/csv-apply`, { method: 'POST', body: JSON.stringify(changes) }),
  replaceTasks: (projectId: string, tasks: any[], milestoneId?: string) =>
    request<{ tasks: any[] }>(`/projects/${projectId}/tasks/replace`, { method: 'POST', body: JSON.stringify({ tasks, milestoneId }) }),
  bulkUpdateTasks: (projectId: string, taskIds: string[], data: Record<string, any>) =>
    request<{ updated: number }>(`/projects/${projectId}/tasks/bulk-update`, { method: 'POST', body: JSON.stringify({ taskIds, data }) }),
  bulkDeleteTasks: (projectId: string, taskIds: string[]) =>
    request<{ deleted: number }>(`/projects/${projectId}/tasks/bulk-delete`, { method: 'POST', body: JSON.stringify({ taskIds }) }),

  // Sync (stateless proxy)
  syncProxy: (url: string, method: 'GET' | 'POST', payload?: unknown, action?: string) =>
    request<{ data: any; error?: string }>('/sync/proxy', { method: 'POST', body: JSON.stringify({ url, method, payload, action }) }),
  syncTest: (url: string) =>
    request<{ ok: boolean; error?: string; data?: any }>('/sync/test', { method: 'POST', body: JSON.stringify({ url }) }),

  // ── Stateful integrations (Trello, ClickUp) ─────────────────────────
  // Global provider credentials (shared across projects)
  listSyncProviders: () =>
    request<{ providers: SyncProviderStatus[] }>('/sync/providers'),
  saveSyncProvider: (providerId: 'trello' | 'clickup', settings: Record<string, any>) =>
    request<{ provider: SyncProviderStatus }>(
      `/sync/providers/${providerId}`,
      { method: 'POST', body: JSON.stringify({ settings }) },
    ),
  deleteSyncProvider: (providerId: 'trello' | 'clickup') =>
    request<{ deleted: boolean }>(`/sync/providers/${providerId}`, { method: 'DELETE' }),
  testSyncProvider: (providerId: 'trello' | 'clickup', overrides?: Record<string, any>) =>
    request<{ ok: boolean; message: string }>(
      `/sync/providers/${providerId}/test`,
      { method: 'POST', body: JSON.stringify({ overrides }) },
    ),
  clickupDiscover: (body: { token?: string; teamId?: string }) =>
    request<{ teams?: Array<{ id: string; name: string }>; spaces?: Array<{ id: string; name: string; private: boolean }> }>(
      '/sync/clickup/discover',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  trelloAuthorizeUrl: (apiKey?: string) =>
    request<{ url: string }>(
      '/sync/trello/authorize-url',
      { method: 'POST', body: JSON.stringify({ apiKey }) },
    ),

  // Link-to-existing flow (for connecting a project on another computer
  // to a board/list that already exists)
  listTrelloBoards: () =>
    request<{ boards: Array<{ id: string; name: string; url: string; closed: boolean }> }>(
      '/sync/trello/boards',
    ),
  listClickupLists: (spaceId: string) =>
    request<{ lists: Array<{ id: string; name: string; url?: string }> }>(
      `/sync/clickup/lists?spaceId=${encodeURIComponent(spaceId)}`,
    ),
  linkTrelloBoard: (projectId: string, boardId: string, milestoneId?: string) =>
    request<SyncOperationResult & { matchedCount?: number; totalRemote?: number; milestoneId?: string }>(
      `/projects/${projectId}/sync/trello/link`,
      { method: 'POST', body: JSON.stringify({ boardId, milestoneId }) },
    ),
  linkClickupList: (projectId: string, spaceId: string, listId: string, milestoneId?: string) =>
    request<SyncOperationResult & { matchedCount?: number; totalRemote?: number; milestoneId?: string }>(
      `/projects/${projectId}/sync/clickup/link`,
      { method: 'POST', body: JSON.stringify({ spaceId, listId, milestoneId }) },
    ),

  // Per-(project, milestone) sync configs.
  // The list endpoints return one entry per (projectId, providerId, milestoneId);
  // mutating endpoints take milestoneId in the body/query and default to
  // 'default' (the General milestone) when omitted, which keeps callers that
  // don't yet know about milestones working.
  listIntegrations: (projectId?: string) =>
    request<{ integrations: SyncIntegration[] }>(
      projectId ? `/projects/${projectId}/sync` : '/sync/integrations',
    ),
  saveIntegration: (projectId: string, providerId: 'trello' | 'clickup', body: {
    milestoneId?: string;
    settings?: Record<string, any>;
    enabled?: boolean;
    autoSync?: boolean;
  }) =>
    request<{ integration: SyncIntegration }>(
      `/projects/${projectId}/sync/${providerId}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  deleteIntegration: (projectId: string, providerId: 'trello' | 'clickup', milestoneId?: string) =>
    request<{ deleted: boolean }>(
      `/projects/${projectId}/sync/${providerId}${milestoneId ? `?milestoneId=${encodeURIComponent(milestoneId)}` : ''}`,
      { method: 'DELETE' },
    ),
  testIntegration: (projectId: string, providerId: 'trello' | 'clickup', milestoneId?: string, overrides?: Record<string, any>) =>
    request<{ ok: boolean; message: string }>(
      `/projects/${projectId}/sync/${providerId}/test`,
      { method: 'POST', body: JSON.stringify({ milestoneId, overrides }) },
    ),
  pushIntegration: (projectId: string, providerId: 'trello' | 'clickup', milestoneId?: string) =>
    request<SyncOperationResult>(
      `/projects/${projectId}/sync/${providerId}/push`,
      { method: 'POST', body: JSON.stringify({ milestoneId }) },
    ),
  pullIntegration: (projectId: string, providerId: 'trello' | 'clickup', milestoneId?: string) =>
    request<SyncOperationResult>(
      `/projects/${projectId}/sync/${providerId}/pull`,
      { method: 'POST', body: JSON.stringify({ milestoneId }) },
    ),
  mergeIntegration: (projectId: string, providerId: 'trello' | 'clickup', milestoneId?: string) =>
    request<SyncOperationResult>(
      `/projects/${projectId}/sync/${providerId}/merge`,
      // Runs in the background every 30s: it must give its connection back.
      { method: 'POST', body: JSON.stringify({ milestoneId }), timeout: 120_000 },
    ),

  // Git
  getGitPending: (projectId: string) => request<{ repos: GitPendingRepo[] }>(`/projects/${projectId}/git/pending`),
  getGitStatus: (projectId: string, subrepo?: string) => request<any>(`/projects/${projectId}/git/status${subrepo ? `?subrepo=${encodeURIComponent(subrepo)}` : ''}`),
  getGitDiff: (projectId: string, file?: string, staged = false, subrepo?: string) => request<{ diff: string }>(`/projects/${projectId}/git/diff?${file ? `file=${encodeURIComponent(file)}&` : ''}staged=${staged}${subrepo ? `&subrepo=${encodeURIComponent(subrepo)}` : ''}`),
  getGitFileAtRef: (projectId: string, file: string, ref = 'HEAD', subrepo?: string) => request<{ content: string }>(`/projects/${projectId}/git/show?file=${encodeURIComponent(file)}&ref=${encodeURIComponent(ref)}${subrepo ? `&subrepo=${encodeURIComponent(subrepo)}` : ''}`),
  stageFile: (projectId: string, file: string, subrepo?: string) => request(`/projects/${projectId}/git/stage`, { method: 'POST', body: JSON.stringify({ file, subrepo }) }),
  stageAll: (projectId: string, subrepo?: string) => request(`/projects/${projectId}/git/stage-all`, { method: 'POST', body: JSON.stringify({ subrepo }) }),
  unstageFile: (projectId: string, file: string, subrepo?: string) => request(`/projects/${projectId}/git/unstage`, { method: 'POST', body: JSON.stringify({ file, subrepo }) }),
  unstageAll: (projectId: string, subrepo?: string) => request(`/projects/${projectId}/git/unstage-all`, { method: 'POST', body: JSON.stringify({ subrepo }) }),
  gitCommit: (projectId: string, message: string, subrepo?: string) => request(`/projects/${projectId}/git/commit`, { method: 'POST', body: JSON.stringify({ message, subrepo }) }),
  gitPush: (projectId: string, subrepo?: string) => request(`/projects/${projectId}/git/push`, { method: 'POST', body: JSON.stringify({ subrepo }) }),
  gitPull: (projectId: string, subrepo?: string) => request(`/projects/${projectId}/git/pull`, { method: 'POST', body: JSON.stringify({ subrepo }) }),
  getGitLog: (projectId: string, subrepo?: string) => request<any>(`/projects/${projectId}/git/log${subrepo ? `?subrepo=${encodeURIComponent(subrepo)}` : ''}`),
  getGitBranches: (projectId: string, subrepo?: string) => request<any>(`/projects/${projectId}/git/branches${subrepo ? `?subrepo=${encodeURIComponent(subrepo)}` : ''}`),
  getGitWorktrees: (projectId: string, subrepo?: string) => request<any>(`/projects/${projectId}/git/worktrees${subrepo ? `?subrepo=${encodeURIComponent(subrepo)}` : ''}`),
  checkoutBranch: (projectId: string, branch: string, subrepo?: string) =>
    request<{ success: boolean; branch: string }>(`/projects/${projectId}/git/checkout`, { method: 'POST', body: JSON.stringify({ branch, subrepo }) }),
  getGitMainCommit: (projectId: string, subrepo?: string) => request<{ commit: { hash: string; message: string; date: string; author_name: string; isMerged: boolean } | null }>(`/projects/${projectId}/git/main-commit${subrepo ? `?subrepo=${encodeURIComponent(subrepo)}` : ''}`),
  getCommitDiff: (projectId: string, hash: string, subrepo?: string) =>
    request<{ files: { file: string; status: string; additions: number; deletions: number }[]; diff: string }>(
      `/projects/${projectId}/git/commit-diff?hash=${encodeURIComponent(hash)}${subrepo ? `&subrepo=${encodeURIComponent(subrepo)}` : ''}`
    ),
  getTaskGitReview: (projectId: string, since: string, until?: string, subrepo?: string) =>
    request<TaskGitReview>(
      `/projects/${projectId}/git/task-review?since=${encodeURIComponent(since)}${until ? `&until=${encodeURIComponent(until)}` : ''}${subrepo ? `&subrepo=${encodeURIComponent(subrepo)}` : ''}`
    ),
  getLifecycleSummary: (projectId: string) => request<{ tasks: TaskLifecycleSummary[] }>(`/projects/${projectId}/lifecycle/summary`),
  getTaskLifecycle: (projectId: string, taskId: string) => request<TaskLifecycle>(`/projects/${projectId}/tasks/${taskId}/lifecycle`),
  getClosePreview: (projectId: string, taskId: string) => request<ClosePreview>(`/projects/${projectId}/tasks/${taskId}/lifecycle/close-preview`),
  closeTask: (projectId: string, taskId: string, body: { expectedToken: string; acknowledgeIgnored?: boolean; acknowledgeUnknownProcesses?: boolean }) =>
    request<CloseOutcome>(`/projects/${projectId}/tasks/${taskId}/lifecycle/close`, { method: 'POST', body: JSON.stringify(body) }),
  getWorktreeInventory: (projectId: string) => request<WorktreeInventory>(`/projects/${projectId}/worktrees/inventory`),
  getWorktreeChanges: (projectId: string, path: string) =>
    request<{ ok: true; path: string; report: WorktreeChangeReport }>(`/projects/${projectId}/worktrees/changes?path=${encodeURIComponent(path)}`),
  getWorktreeDiff: (projectId: string, path: string, file: string) =>
    request<{ ok: true; file: string; untracked: boolean; diff: string; truncated: boolean; binary: boolean }>(`/projects/${projectId}/worktrees/diff?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}`),
  linkWorktree: (projectId: string, body: { taskId: string; path: string }) =>
    request<{ ok: true; already: boolean }>(`/projects/${projectId}/worktrees/link`, { method: 'POST', body: JSON.stringify(body) }),
  unlinkWorktree: (projectId: string, taskId: string) =>
    request<{ ok: true; removed: boolean }>(`/projects/${projectId}/worktrees/link/${taskId}`, { method: 'DELETE' }),
  acceptTaskDelivery: (projectId: string, taskId: string, body: { targetBranch: string; expectedHeadSha: string; note?: string }) =>
    request<{ ok: true; view: TaskLifecycle }>(`/projects/${projectId}/tasks/${taskId}/lifecycle/accept`, { method: 'POST', body: JSON.stringify(body) }),
  revokeTaskAcceptance: (projectId: string, taskId: string) =>
    request<{ ok: true; view: TaskLifecycle }>(`/projects/${projectId}/tasks/${taskId}/lifecycle/accept`, { method: 'DELETE' }),
  identifyDirectDelivery: (projectId: string, taskId: string, body: { baseSha: string; headSha: string; note?: string }) =>
    request<{ ok: true; view: TaskLifecycle }>(`/projects/${projectId}/tasks/${taskId}/lifecycle/direct-delivery`, { method: 'POST', body: JSON.stringify(body) }),
  clearDirectDelivery: (projectId: string, taskId: string) =>
    request<{ ok: true; view: TaskLifecycle }>(`/projects/${projectId}/tasks/${taskId}/lifecycle/direct-delivery`, { method: 'DELETE' }),
  integrateTask: (projectId: string, taskId: string, body: { targetBranch: string; expectedHeadSha: string; branch: string }) =>
    request<{ ok: true; view: TaskLifecycle }>(`/projects/${projectId}/tasks/${taskId}/lifecycle/integrate`, { method: 'POST', body: JSON.stringify(body) }),
  discardFile: (projectId: string, file: string, type: 'staged' | 'unstaged' | 'untracked', subrepo?: string) =>
    request(`/projects/${projectId}/git/discard`, { method: 'POST', body: JSON.stringify({ file, type, subrepo }) }),
  discardAll: (projectId: string, section: 'staged' | 'unstaged', subrepo?: string) =>
    request(`/projects/${projectId}/git/discard-all`, { method: 'POST', body: JSON.stringify({ section, subrepo }) }),
  undoCommit: (projectId: string, subrepo?: string) =>
    request(`/projects/${projectId}/git/undo-commit`, { method: 'POST', body: JSON.stringify({ subrepo }) }),
  generateCommitMessage: (projectId: string, subrepo?: string) =>
    request<{ message: string; source: 'cli' | 'api' }>(`/projects/${projectId}/git/generate-commit-message`, { method: 'POST', body: JSON.stringify({ subrepo }), timeout: 70_000 }),

  // Terminals (native launchers)
  launchTerminal: (projectId: string, type: string) => request('/terminals/launch', { method: 'POST', body: JSON.stringify({ projectId, type }) }),
  openFolder: (projectId: string) => request('/terminals/folder', { method: 'POST', body: JSON.stringify({ projectId }) }),

  // Integrated terminal
  getTerminalStatus: () => request<{ available: boolean }>('/terminal/status'),
  getTerminalSessions: (projectId?: string) =>
    request<{ sessions: TerminalSessionInfo[] }>(
      `/terminal/sessions${projectId ? `?projectId=${projectId}` : ''}`
    ),
  createTerminalSession: (projectId: string, type = 'shell', cols = 80, rows = 24, taskId?: string, prompt?: string, agent?: string, resume?: { id: string; title?: string }, run?: { model?: string; effort?: string }) =>
    request<TerminalSessionInfo>(
      '/terminal/sessions',
      { method: 'POST', body: JSON.stringify({ projectId, type, cols, rows, ...(taskId ? { taskId } : {}), ...(prompt ? { prompt } : {}), ...(agent ? { agent } : {}), ...(run?.model ? { model: run.model } : {}), ...(run?.effort ? { effort: run.effort } : {}),...(resume ? { resume: resume.id, resumeTitle: resume.title } : {}) }) }
    ),
  getClaudeConversations: (projectId?: string, limit?: number) =>
    request<{ conversations: ClaudeConversation[] }>(
      '/terminal/conversations' + (projectId ? `?projectId=${encodeURIComponent(projectId)}${limit ? `&limit=${limit}` : ''}` : '')
    ),
  killTerminalSession: (sessionId: string) =>
    request('/terminal/sessions/' + sessionId, { method: 'DELETE' }),
  renameTerminalSession: (sessionId: string, title: string | null) =>
    request<{ success: boolean; customTitle: string | null }>('/terminal/sessions/' + sessionId, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  getAiTerminalSessions: () =>
    request<{ sessions: { id: string; projectId: string; type: string; taskId: string; createdAt: string }[] }>(
      '/terminal/ai-sessions'
    ),
  getTerminalPreviews: () =>
    request<{ previews: Record<string, { at: number; lines: string[] }> }>('/terminal/previews'),
  writeToTerminalSession: (sessionId: string, data: string) =>
    request<{ success: boolean }>(`/terminal/sessions/${sessionId}/write`, { method: 'POST', body: JSON.stringify({ data }) }),
  uploadTerminalClipboardImage: (sessionId: string, mimeType: string, data: string) =>
    request<{ path: string; expiresInMs: number }>(`/terminal/sessions/${sessionId}/clipboard-image`, {
      method: 'POST',
      body: JSON.stringify({ mimeType, data }),
      timeout: 20_000,
    }),
  /** A path the terminal printed: `editor` means open it here, `system` means the OS already did. */
  openTerminalPath: (sessionId: string, path: string, system = false) =>
    request<{ opened: 'editor' | 'system' | 'revealed'; projectId?: string; path: string }>(`/terminal/sessions/${sessionId}/open-path`, {
      method: 'POST',
      body: JSON.stringify({ path, system }),
    }),
  getAiResolvePrompt: (projectId: string, taskId: string, feedback?: string) =>
    request<{ prompt: string }>(`/projects/${projectId}/tasks/${taskId}/ai-resolve`, {
      method: 'POST',
      ...(feedback?.trim() ? { body: JSON.stringify({ feedback }) } : {}),
    }),
  getAiManagePrompt: (projectId: string, rawText: string) =>
    request<{ prompt: string }>(`/projects/${projectId}/ai-manage-prompt`, { method: 'POST', body: JSON.stringify({ rawText }) }),

  // Project management
  scanDirectory: (directory: string) => request<{ projects: { path: string; name: string; techStack: string[]; isGitRepo: boolean }[] }>('/projects/scan', { method: 'POST', body: JSON.stringify({ directory }) }),
  addProjects: (paths: string[]) => request<{ projects: any[] }>('/projects/add', { method: 'POST', body: JSON.stringify({ paths }) }),
  removeProject: (path: string) => request<{ projects: any[] }>('/projects/remove', { method: 'POST', body: JSON.stringify({ path }) }),

  // Deploys (Railway)
  getDeployProviders: () =>
    request<{ providers: { railway: { connected: boolean } } }>('/deploy/providers'),
  connectRailway: (token: string) =>
    request<{
      connected: boolean
      account: { name?: string; email?: string }
      linked: AutoLinkResult['linked']
      report: MatchReport | null
    }>('/deploy/providers/railway', {
      method: 'POST',
      body: JSON.stringify({ token }),
      timeout: 40_000,
    }),
  getDeployMatches: () => request<MatchReport>('/deploy/railway/matches', { timeout: 30_000 }),
  autoLinkDeploys: (body?: { only?: string[]; relink?: boolean }) =>
    request<AutoLinkResult>('/deploy/railway/autolink', {
      method: 'POST',
      body: JSON.stringify(body || {}),
      timeout: 40_000,
    }),
  disconnectRailway: () => request<{ connected: boolean }>('/deploy/providers/railway', { method: 'DELETE' }),
  getRailwayProjects: () =>
    request<{ projects: RailwayProjectSummary[] }>('/deploy/railway/projects', { timeout: 20_000 }),
  getAllDeployStatus: () =>
    request<{ statuses: Record<string, DeployStatus[]> }>('/deploy/status', { timeout: 20_000 }),
  getDeployStatus: (projectId: string, subrepo?: string) =>
    request<{ statuses: DeployStatus[] }>(
      `/projects/${projectId}/deploy${subrepo !== undefined ? `?subrepo=${encodeURIComponent(subrepo)}` : ''}`,
      { timeout: 20_000 }
    ),
  linkDeploy: (projectId: string, body: DeployLinkInput) =>
    request<{ status: DeployStatus }>(`/projects/${projectId}/deploy`, {
      method: 'PUT',
      body: JSON.stringify(body),
      timeout: 20_000,
    }),
  /** `link` drops one deploy; `subrepo` every deploy of a checkout; neither, all. */
  unlinkDeploy: (projectId: string, target?: { link?: string; subrepo?: string }) => {
    const query = target?.link
      ? `?link=${encodeURIComponent(target.link)}`
      : target?.subrepo !== undefined
        ? `?subrepo=${encodeURIComponent(target.subrepo)}`
        : ''
    return request(`/projects/${projectId}/deploy${query}`, { method: 'DELETE' })
  },

  // WhatsApp inbox
  getInboxStatus: () => request<InboxStatus>('/inbox'),
  getInboxReview: () => request<InboxReview>('/inbox/review'),
  getInboxReviewCount: () => request<{ count: number }>('/inbox/review?summary=1'),
  updateInboxDemand: (id: string, body: Partial<{ title: string; description: string; priority: string; effort: number | null; projectId: string | null; kind: 'code' | 'admin'; targetTaskId: string | null }>) =>
    request<{ ok: boolean }>(`/inbox/review/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  approveInboxDemand: (id: string) => request<{ ok: boolean }>(`/inbox/review/${encodeURIComponent(id)}/approve`, { method: 'POST', body: '{}' }),
  discardInboxDemand: (id: string) => request<{ ok: boolean }>(`/inbox/review/${encodeURIComponent(id)}/discard`, { method: 'POST', body: '{}' }),
  getInboxDeliveries: (since?: string) => request<{ deliveries: InboxDelivery[] }>(`/inbox/deliveries${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  configureInbox: (url: string, token: string) =>
    request<InboxStatus & { created: number }>('/inbox', {
      method: 'PUT',
      body: JSON.stringify({ url, token }),
      timeout: 40_000,
    }),
  disconnectInbox: () => request<InboxStatus>('/inbox', { method: 'DELETE' }),
  syncInbox: () => request<InboxStatus & { created: number }>('/inbox/sync', { method: 'POST', timeout: 40_000 }),

  // Settings
  getSettings: () => request<AppSettings>('/settings'),
  updateSettings: (body: { terminalAiTitles?: boolean }) =>
    request<AppSettings>('/settings', { method: 'PATCH', body: JSON.stringify(body) }),

  // Coding agents (which CLI runs a task)
  getAgents: () => request<{ agents: Agent[]; defaultAgent: string }>('/agents'),
  saveAgents: (body: { agents?: Agent[]; defaultAgent?: string }) =>
    request<{ agents: Agent[]; defaultAgent: string }>('/agents', { method: 'PUT', body: JSON.stringify(body) }),

  // Worktree per task (isolated checkout so agents can run in parallel)
  getWorktrees: () => request<WorktreeSettings>('/worktrees'),
  saveWorktreeConfig: (body: { enabled?: boolean; basePath?: string | null }) =>
    request<Omit<WorktreeSettings, 'worktrees'>>('/worktrees', { method: 'PUT', body: JSON.stringify(body) }),

  // Browse filesystem
  browse: (path: string) => request<{ directories: { name: string; path: string }[] }>('/browse', { method: 'POST', body: JSON.stringify({ path }) }),

  // Claude AI
  // AI providers — Claude, OpenAI (codex) and Gemini share one backend chain
  getAiStatus: () => request<AiBackendStatus>('/ai/status'),
  setPreferredAiProvider: (provider: AiProvider) =>
    request<{ ok: boolean }>('/ai/preferred', { method: 'POST', body: JSON.stringify({ provider }) }),
  saveAiConfig: (provider: AiProvider, data: { apiKey: string; model?: string; maxTokens?: number }) =>
    request<{ ok: boolean }>(`/ai/config/${provider}`, { method: 'POST', body: JSON.stringify(data) }),
  deleteAiConfig: (provider: AiProvider) =>
    request<{ ok: boolean }>(`/ai/config/${provider}`, { method: 'DELETE' }),
  testAiKey: (provider: AiProvider, apiKey: string) =>
    request<{ ok: boolean; error?: string }>(`/ai/config/${provider}/test`, {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
      timeout: 30_000,
    }),

  getClaudeStatus: () => request<{ configured: boolean; cliAvailable: boolean; oauthAvailable: boolean; activeBackend: 'cli-oauth' | 'cli' | 'api' | null; activeProvider: AiProvider | null; preferredProvider: AiProvider; model: string | null; maxTokens: number | null }>('/claude/status'),
  getClaudeUsage: () => request<ClaudeUsage>('/claude/usage'),
  saveClaudeConfig: (data: { apiKey: string; model?: string; maxTokens?: number }) =>
    request<{ ok: boolean }>('/claude/config', { method: 'POST', body: JSON.stringify(data) }),
  deleteClaudeConfig: () => request<{ ok: boolean }>('/claude/config', { method: 'DELETE' }),
  testClaudeKey: (apiKey: string) =>
    request<{ ok: boolean; error?: string }>('/claude/config/test', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  analyzeTask: (projectId: string, title: string, taskId?: string) =>
    request<{ title: string; description: string; prompt: string; effort?: 1 | 2 | 3 | 5 | 8; effortConfidence?: 'low' | 'medium' | 'high' }>('/claude/analyze-task', { method: 'POST', body: JSON.stringify({ projectId, title, taskId }), timeout: 60_000 }),
  classifyTaskEffort: (projectId: string, taskIds?: string[]) =>
    request<{ suggestions: Array<{ taskId: string; title: string; effort: 1 | 2 | 3 | 5 | 8; confidence: 'low' | 'medium' | 'high'; rationale: string }> }>(
      '/claude/classify-task-effort', { method: 'POST', body: JSON.stringify({ projectId, taskIds }), timeout: 180_000 }
    ),
  applyTaskEffort: (projectId: string, assignments: Array<{ taskId: string; effort: 1 | 2 | 3 | 5 | 8; confidence?: 'low' | 'medium' | 'high' }>) =>
    request<{ updated: number }>(`/projects/${projectId}/tasks/effort/apply`, { method: 'POST', body: JSON.stringify({ assignments }) }),  bulkOrganizeTasks: (projectId: string, rawText: string) =>
    request<{ tasks: Array<{ title: string; description: string; prompt: string; priority: string; effort?: 1 | 2 | 3 | 5 | 8; status: string }> }>(
      '/claude/bulk-organize', { method: 'POST', body: JSON.stringify({ projectId, rawText }) }
    ),
  manageTasks: (projectId: string, rawText: string, existingTasks: Array<{ id: string; title: string; description: string; status: string; priority: string }>) =>
    request<{ actions: Array<{ type: string; task?: any; taskId?: string; changes?: any; reason?: string; title?: string; existingTaskId?: string }>; summary: string }>(
      '/claude/manage-tasks', { method: 'POST', body: JSON.stringify({ projectId, rawText, existingTasks }) }
    ),
  // MCP Server
  getMcpStatus: () => request<{
    enabled: boolean;
    requireAuth: boolean;
    /** disabled: MCP is off · needs-authorization: on, no client approved yet · ready */
    state: 'disabled' | 'needs-authorization' | 'ready';
    endpoint: string;
    clients: Array<{ clientId: string; clientName: string; createdAt: string }>;
  }>('/mcp/status'),
  saveMcpConfig: (data: { enabled: boolean; requireAuth?: boolean }) =>
    request<{ ok: boolean; enabled: boolean; requireAuth: boolean }>('/mcp/config', { method: 'POST', body: JSON.stringify(data) }),
  revokeMcpClient: (clientId: string) =>
    request<{ ok: boolean }>(`/mcp/clients/${clientId}`, { method: 'DELETE' }),

  // Logs
  getLogs: (filters?: { level?: string; category?: string; projectId?: string; limit?: number }) => {
    const params = new URLSearchParams()
    if (filters?.level) params.set('level', filters.level)
    if (filters?.category) params.set('category', filters.category)
    if (filters?.projectId) params.set('projectId', filters.projectId)
    if (filters?.limit) params.set('limit', String(filters.limit))
    const qs = params.toString()
    return request<{ logs: any[] }>(`/logs${qs ? `?${qs}` : ''}`)
  },
  getLogStats: () => request<{ total: number; errors: number; warnings: number; byCategory: Record<string, number> }>('/logs/stats'),
  clearLogs: () => request<{ ok: boolean }>('/logs', { method: 'DELETE' }),

  // Search
  // `prefer` is the open project: it and the rest of its client rank first.
  // `projectId` restricts the search to that one project.
  searchFiles: (query: string, opts: { projectId?: string; prefer?: string; includeSidecars?: boolean; signal?: AbortSignal } = {}) =>
    request<{ results: Array<{ name: string; path: string; projectId: string; projectName: string; type: 'file' | 'dir'; extension?: string }> }>(
      `/search/files?${searchParams({ q: query, projectId: opts.projectId, prefer: opts.prefer, sidecars: opts.includeSidecars ? 'show' : undefined })}`,
      { signal: opts.signal },
    ),
  searchContent: (query: string, opts: ContentSearchOptions & { projectId?: string; prefer?: string; signal?: AbortSignal } = {}) =>
    request<ContentSearchResponse>(
      `/search/content?${searchParams({
        q: query,
        projectId: opts.projectId,
        prefer: opts.prefer,
        caseSensitive: opts.caseSensitive ? 'true' : undefined,
        wholeWord: opts.wholeWord ? 'true' : undefined,
        regex: opts.regex ? 'true' : undefined,
        includeIgnored: opts.includeIgnored ? 'true' : undefined,
      })}`,
      { signal: opts.signal },
    ),

  // Files
  // `taskId` selects a task's worktree as the root of the request; omitted = the project folder.
  getFileTree: (projectId: string, relPath: string, includeSidecars = false, taskId?: string) =>
    request<{ entries: Array<{ name: string; path: string; type: 'file' | 'dir'; size?: number; extension?: string; mimeHint?: string; readOnly?: boolean }> }>(
      `/projects/${projectId}/files/tree?${searchParams({ path: relPath, sidecars: includeSidecars ? 'show' : undefined, taskId })}`
    ),
  getFileCheckout: (projectId: string, taskId?: string) =>
    request<{ projectName: string; isMainCheckout: boolean; checkoutPath: string; reason: string; taskId: string | null; taskNumber: number | null; taskTitle: string | null; branch: string | null; head: string | null; detached: boolean; dirty: { count: number; files: string[] } | null }>(
      `/projects/${projectId}/files/checkout?${searchParams({ taskId })}`
    ),
  getFileContent: (projectId: string, relPath: string, taskId?: string) =>
    request<{ content: string; encoding: string; mimeHint: string; size: number }>(
      `/projects/${projectId}/files/content?${searchParams({ path: relPath, taskId })}`,
      { headers: { 'Accept': 'application/json' } }
    ),
  deleteFile: (projectId: string, relPath: string, taskId?: string) =>
    request<{ success: boolean }>(
      `/projects/${projectId}/files?${searchParams({ path: relPath, taskId })}`,
      { method: 'DELETE' }
    ),
  openFileFolder: (projectId: string, relPath: string) =>
    request<{ success: boolean }>(
      `/projects/${projectId}/files/open-folder`,
      { method: 'POST', body: JSON.stringify({ path: relPath }) }
    ),
  saveFileContent: (projectId: string, relPath: string, content: string, taskId?: string) =>
    request<{ success: boolean; size: number }>(
      `/projects/${projectId}/files/content`,
      { method: 'PUT', body: JSON.stringify({ path: relPath, content, taskId }) }
    ),
  renameFile: (projectId: string, relPath: string, newName: string, taskId?: string) =>
    request<{ success: boolean; newPath: string }>(
      `/projects/${projectId}/files/rename`,
      { method: 'POST', body: JSON.stringify({ path: relPath, newName, taskId }) }
    ),
  createFile: (projectId: string, parentPath: string, name: string, type: 'file' | 'dir', taskId?: string) =>
    request<{ success: boolean; path: string }>(
      `/projects/${projectId}/files/create`,
      { method: 'POST', body: JSON.stringify({ parentPath, name, type, taskId }) }
    ),
  copyFile: (projectId: string, sourcePath: string, destParentPath?: string, newName?: string, taskId?: string) =>
    request<{ success: boolean; path: string }>(
      `/projects/${projectId}/files/copy`,
      { method: 'POST', body: JSON.stringify({ sourcePath, destParentPath, newName, taskId }) }
    ),

  // Reports
  getReportData: (projectId: string, opts: { milestoneId?: string; from?: string; to?: string; includeCommits?: boolean; status?: string[] }) => {
    const params = new URLSearchParams();
    if (opts.milestoneId) params.set('milestone', opts.milestoneId);
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.includeCommits) params.set('includeCommits', '1');
    if (opts.status?.length) params.set('status', opts.status.join(','));
    const qs = params.toString();
    return request<any>(`/projects/${projectId}/reports/data${qs ? `?${qs}` : ''}`);
  },
};
