import { request } from 'http';

// Decides whether Electron starts its own backend, reuses one already listening on the port, or refuses.
// It has no Electron imports so the server test suite can exercise it directly.

/** Must match SERVER_PROTOCOL in server/src/routes/identity.ts (a test checks that). */
export const SERVER_PROTOCOL = 1;

const IDENTITY_APP = 'jabutistudio';
const IDENTITY_PATH = '/api/identity';
const MAX_IDENTITY_BYTES = 64 * 1024;

export type ProbeResult =
  | { kind: 'free' }
  | { kind: 'reusable'; serveClient: boolean }
  | { kind: 'foreign'; reason: string };

function foreign(reason: string): ProbeResult {
  return { kind: 'foreign', reason };
}

/** Classifies the answer of the identity route. Pure: no I/O. */
export function classifyIdentity(status: number | undefined, body: string, expectedProtocol: number): ProbeResult {
  if (status === 404) return foreign('it answers, but has no JabutiStudio identity route (an older or different server)');
  if (status !== 200) return foreign(`the identity check answered HTTP ${status ?? 'none'}`);

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return foreign('the identity check did not return JSON');
  }
  if (typeof data !== 'object' || data === null) return foreign('the identity check did not return an object');

  const identity = data as Record<string, unknown>;
  if (identity.app !== IDENTITY_APP) return foreign('the process on this port is not JabutiStudio');
  if (identity.protocol !== expectedProtocol) {
    return foreign(`JabutiStudio protocol ${String(identity.protocol)} does not match this Electron (protocol ${expectedProtocol})`);
  }
  if (identity.status !== 'ok') return foreign('the server reports itself as not ready');

  return { kind: 'reusable', serveClient: identity.serveClient === true };
}

/** HTTP GET with a hard timeout. Resolves with the status and body, or with the error code. */
function get(host: string, port: number, path: string, timeoutMs: number): Promise<
  { ok: true; status: number; body: string } | { ok: false; code: string }
> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = request({ hostname: host, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < MAX_IDENTITY_BYTES) body += chunk;
      });
      res.on('end', () => settle({ ok: true, status: res.statusCode ?? 0, body }));
      res.on('error', (err: NodeJS.ErrnoException) => settle({ ok: false, code: err.code ?? 'ERROR' }));
    });
    req.on('error', (err: NodeJS.ErrnoException) => settle({ ok: false, code: err.code ?? 'ERROR' }));
    req.on('timeout', () => {
      req.destroy();
      settle({ ok: false, code: 'TIMEOUT' });
    });
    req.end();
  });
}

export interface ProbeOptions {
  port: number;
  expectedProtocol: number;
  host?: string;
  timeoutMs?: number;
}

/**
 * Asks what is listening on the port. Nothing listening (connection refused) is "free". Anything that
 * answers is checked for identity and protocol before it can be reused. Silence or other errors are
 * "foreign": the port is taken by something we cannot vouch for, so we neither reuse nor kill it.
 */
export async function probeBackend(opts: ProbeOptions): Promise<ProbeResult> {
  const result = await get(opts.host ?? '127.0.0.1', opts.port, IDENTITY_PATH, opts.timeoutMs ?? 1500);
  if (!result.ok) {
    if (result.code === 'ECONNREFUSED') return { kind: 'free' };
    return foreign(`port ${opts.port} is taken and did not answer the identity check (${result.code})`);
  }
  return classifyIdentity(result.status, result.body, opts.expectedProtocol);
}

/** True when something answers on the URL with a non-5xx status. Used to find the Vite dev server. */
export async function isUrlReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  const result = await get(host, port, '/', timeoutMs);
  return result.ok && result.status < 500;
}

/**
 * Polls `check` until it passes. Throws when it never does: a backend that is not confirmed ready must not
 * be treated as ready, or the window loads into a server that is still refusing connections.
 */
export async function waitUntilReady(
  check: () => Promise<boolean>,
  opts: { attempts: number; intervalMs: number; what: string },
): Promise<void> {
  for (let i = 0; i < opts.attempts; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`${opts.what} did not answer after ${opts.attempts} attempts`);
}

export class BackendConflictError extends Error {
  constructor(port: number, reason: string) {
    super(`Port ${port} is in use by a process JabutiStudio will not reuse or stop: ${reason}. `
      + 'Nothing was started. Stop that process, or restart the JabutiStudio dev server (pnpm dev) if it is an older JabutiStudio backend.');
    this.name = 'BackendConflictError';
  }
}

/** A running process we spawned (own) is stopped at quit. A backend we reused (external) never is. */
export type BackendOwnership = 'own' | 'external';

export interface OwnedProcess {
  stop(): void;
}

export interface BackendHandle {
  ownership: BackendOwnership;
  /** For an external backend: whether it serves the built client itself. */
  serveClient: boolean;
  stop(): void;
}

export interface EnsureBackendOptions {
  port: number;
  probe: () => Promise<ProbeResult>;
  /** Starts a backend this Electron owns. Resolves once it is ready, rejects if it fails. */
  spawnOwn: () => Promise<OwnedProcess>;
}

/**
 * Reuses a compatible backend already on the port, or starts one when the port is free. A conflicting
 * process makes it throw without starting or touching anything.
 */
export async function ensureBackend(opts: EnsureBackendOptions): Promise<BackendHandle> {
  const probe = await opts.probe();

  if (probe.kind === 'reusable') {
    return { ownership: 'external', serveClient: probe.serveClient, stop: () => {} };
  }
  if (probe.kind === 'foreign') {
    throw new BackendConflictError(opts.port, probe.reason);
  }

  const owned = await opts.spawnOwn();
  let stopped = false;
  return {
    ownership: 'own',
    serveClient: true,
    stop: () => {
      if (stopped) return;
      stopped = true;
      owned.stop();
    },
  };
}
