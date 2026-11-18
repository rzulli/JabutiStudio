import { canonicalPath } from '../pathIdentity.js';
import * as harness from './harness.js';
import { trackedGuiIn } from './instances.js';
import { listRecords } from './runs.js';

/**
 * Godot processes that may be using a checkout, read from the registries this server already keeps. Nothing new is
 * recorded here and nothing is stopped.
 *
 *  - `running`: a process this server started and can still see alive (Godot windows, Harness runners in flight).
 *  - `unknown`: a Harness run recorded for this checkout that has neither a live runner nor a recorded exit. It may
 *    still be running (the server restarted while it ran) or may have ended without writing its exit. Not provably
 *    finished, so it is not reported as absent.
 *
 * Godot windows opened by hand, and windows started before a restart, are not in any registry: they are not seen.
 */
export interface ProcessActivity { kind: 'godot-editor' | 'godot-play' | 'harness-run'; runId?: string; pid?: number; since?: string }
export interface GodotProcesses { running: ProcessActivity[]; unknown: ProcessActivity[] }

export async function godotProcessesIn(checkout: string, projectId: string): Promise<GodotProcesses> {
  const here = canonicalPath(checkout);
  const running: ProcessActivity[] = [];
  for (const g of trackedGuiIn(checkout)) {
    running.push({ kind: g.kind === 'play' ? 'godot-play' : 'godot-editor', pid: g.pid, since: g.startedAt });
  }
  for (const [runId, entry] of harness.live) {
    if (!entry.exited && entry.projectRoot && canonicalPath(entry.projectRoot) === here) {
      running.push({ kind: 'harness-run', runId, pid: entry.child.pid ?? undefined });
    }
  }
  const unknown: ProcessActivity[] = [];
  let records: Awaited<ReturnType<typeof listRecords>> = [];
  try { records = await listRecords(projectId); } catch { records = []; }
  for (const r of records) {
    if (!r.checkout?.path || canonicalPath(r.checkout.path) !== here) continue;
    if (r.runner) continue;                     // the exit was recorded by this server
    if (harness.live.has(r.runId)) continue;    // tracked live above
    unknown.push({ kind: 'harness-run', runId: r.runId, since: r.startedAt });
  }
  return { running, unknown };
}
