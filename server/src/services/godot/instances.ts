import { canonicalPath } from '../pathIdentity.js';

/**
 * Godot windows this server started (editor / interactive game), per checkout. Repeating the same action must not
 * pile up Godot instances: a second request while the first window is alive is refused with the pid. Only what this
 * server launched is known; a Godot someone opened by hand is not seen (and not touched).
 */
export type GuiKind = 'editor' | 'play';

const live = new Map<string, { pid: number; startedAt: string; checkout: string; kind: GuiKind }>();
const key = (checkout: string, kind: GuiKind) => `${canonicalPath(checkout)}|${kind}`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function runningInstance(checkout: string, kind: GuiKind): { pid: number; startedAt: string } | null {
  const k = key(checkout, kind);
  const hit = live.get(k);
  if (!hit) return null;
  if (alive(hit.pid)) return hit;
  live.delete(k);
  return null;
}

export function rememberInstance(checkout: string, kind: GuiKind, pid: number): void {
  live.set(key(checkout, kind), { pid, startedAt: new Date().toISOString(), checkout, kind });
}

export interface SessionInCheckout { id: string; taskId?: string; taskNumber?: number; agent?: string; state: string | null; title?: string }

/** Terminal sessions whose working directory is this checkout, so the person is told who else can change files while they play. */
export async function sessionsIn(checkout: string): Promise<SessionInCheckout[]> {
  try {
    const { listSessions } = await import('../terminalService.js');
    const here = canonicalPath(checkout);
    return listSessions()
      .filter(s => s.cwd && canonicalPath(s.cwd) === here)
      .map(s => ({ id: s.id, taskId: s.taskId, taskNumber: s.taskNumber, agent: s.agent, state: s.state ?? null, title: s.title }));
  } catch {
    return [];
  }
}

/** Wording of the "state may change while you test" warnings. A session that reports nothing (another agent's CLI) is named, not assumed idle. */
export function sessionWarnings(sessions: SessionInCheckout[], taskId?: string): string[] {
  const out: string[] = [];
  const active = sessions.filter(s => s.state === 'busy' || s.state === 'awaiting-input');
  const silent = sessions.filter(s => s.state === null);
  if (active.length) out.push(`${active.length} agent session(s) are working in this checkout right now (${active.map(s => s.agent ?? 'shell').join(', ')}); files may change while you test.`);
  if (silent.length) out.push(`${silent.length} session(s) in this checkout do not report whether they are working (${silent.map(s => s.agent ?? 'shell').join(', ')}); the files may change under you.`);
  const others = new Set(sessions.filter(s => s.taskId && s.taskId !== taskId).map(s => s.taskNumber ? `#${s.taskNumber}` : s.taskId));
  if (others.size) out.push(`The checkout is shared with other task(s): ${[...others].join(', ')}. What you see may include their changes.`);
  return out;
}

/**
 * Godot windows this server started that are still alive in `checkout`. Only what this process launched since its last
 * start is known: a window opened by hand, or started before a restart, is not in this map and is not reported here.
 */
export function trackedGuiIn(checkout: string): { kind: GuiKind; pid: number; startedAt: string }[] {
  const here = canonicalPath(checkout);
  const out: { kind: GuiKind; pid: number; startedAt: string }[] = [];
  for (const [k, hit] of [...live.entries()]) {
    if (canonicalPath(hit.checkout) !== here) continue;
    if (alive(hit.pid)) out.push({ kind: hit.kind, pid: hit.pid, startedAt: hit.startedAt });
    else live.delete(k);
  }
  return out;
}
