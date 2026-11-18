import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';

/**
 * What a Godot file is, from evidence in the checkout, and which actions that justifies.
 *
 *  - A `.tscn` is a runnable scene. It is a TEST scene only when it lives under a `tests/` (or `test/`) folder:
 *    the location convention the Harness fixtures use. Being runnable is never enough.
 *  - A `.gd` is never run by itself. A test script offers "Run Related Test" only for scenes that attach it
 *    (an `ext_resource` of type Script in the scene file): a verifiable link. Same-name matches are only suggestions.
 *  - Gameplay scripts get "find related" from scenes that attach them and test scripts that name their res:// path.
 */

export type FileKind = 'scene' | 'test-scene' | 'test-script' | 'gameplay-script' | 'other';

export interface Related { rel: string; res: string; verified: boolean; reason: string }

export interface Classification {
  kind: FileKind;
  evidence: string[];
  warnings: string[];
  actions: {
    runScene: boolean;
    runTest: boolean;
    openInGodot: boolean;
    /** Verified test scenes exist for this script. */
    runRelatedTest: boolean;
    findRelated: boolean;
  };
  relatedTests: Related[];
  relatedScenes: Related[];
  /** Inferred only (e.g. same file name): shown, never run automatically. */
  suggestions: Related[];
}

/** The marker a Harness test scene prints once its assertions hold. */
export const DEFAULT_MARKER = 'HARNESS_ASSERTIONS_PASS';

const SKIP_DIRS = new Set(['.git', '.godot', '.import', 'node_modules', 'addons', '.claude', '.worktrees', 'worktrees', 'export', 'release', 'artifacts']);
const MAX_FILES = 6000;
const MAX_BYTES = 512 * 1024;

const isTestPath = (rel: string) => /(^|\/)tests?\//i.test(rel);
const basename = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
const stem = (rel: string) => basename(rel).replace(/\.[^.]+$/, '');
const mk = (rel: string, verified: boolean, reason: string): Related => ({ rel, res: `res://${rel}`, verified, reason });

interface Index { scenes: string[]; scripts: string[]; truncated: boolean }

async function walk(root: string): Promise<Index> {
  const scenes: string[] = [], scripts: string[] = [];
  let seen = 0, truncated = false;
  const visit = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen >= MAX_FILES) { truncated = true; return; }
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name.toLowerCase())) await visit(join(dir, e.name), `${prefix}${e.name}/`); continue; }
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (lower.endsWith('.tscn')) { scenes.push(prefix + e.name); seen++; }
      else if (lower.endsWith('.gd')) { scripts.push(prefix + e.name); seen++; }
    }
  };
  await visit(root, '');
  return { scenes, scripts, truncated };
}

async function text(root: string, rel: string): Promise<string> {
  try {
    const p = join(root, ...rel.split('/'));
    if ((await stat(p)).size > MAX_BYTES) return '';
    return await readFile(p, 'utf-8');
  } catch { return ''; }
}

/** Script paths (project-relative) attached through ext_resource lines of a .tscn. */
export function scriptsOfScene(tscn: string): string[] {
  const out: string[] = [];
  for (const m of tscn.matchAll(/^\[ext_resource\b([^\]]*)\]/gm)) {
    const attrs = m[1];
    const type = /\btype="([^"]*)"/.exec(attrs)?.[1];
    const path = /\bpath="res:\/\/([^"]+)"/.exec(attrs)?.[1];
    if (path && (type === 'Script' || path.toLowerCase().endsWith('.gd'))) out.push(path);
  }
  return out;
}

export async function classify(root: string, rel: string): Promise<Classification> {
  const lower = rel.toLowerCase();
  const base: Classification = {
    kind: 'other', evidence: [], warnings: [],
    actions: { runScene: false, runTest: false, openInGodot: true, runRelatedTest: false, findRelated: false },
    relatedTests: [], relatedScenes: [], suggestions: [],
  };

  if (lower.endsWith('.tscn')) {
    const src = await text(root, rel);
    const scripts = scriptsOfScene(src);
    if (isTestPath(rel)) {
      base.kind = 'test-scene';
      base.actions.runTest = true;
      base.evidence.push('Located under a tests/ folder');
      let marker = false;
      for (const s of scripts) if ((await text(root, s)).includes(DEFAULT_MARKER)) marker = true;
      if (marker) base.evidence.push(`A script attached to the scene prints ${DEFAULT_MARKER}`);
      else base.warnings.push(`No attached script prints ${DEFAULT_MARKER}: the Harness can report FAIL but never PASS for this scene.`);
    } else {
      base.kind = 'scene';
      base.actions.runScene = true;
      base.evidence.push('A .tscn outside any tests/ folder: runnable scene, not a test');
    }
    return base;
  }

  if (lower.endsWith('.gd')) {
    const idx = await walk(root);
    if (idx.truncated) base.warnings.push(`The project has more than ${MAX_FILES} scenes and scripts; related files may be incomplete.`);
    const attachedBy = new Map<string, string[]>(); // script rel -> scenes
    for (const sc of idx.scenes) {
      for (const s of scriptsOfScene(await text(root, sc))) {
        const list = attachedBy.get(s) ?? [];
        list.push(sc);
        attachedBy.set(s, list);
      }
    }
    if (isTestPath(rel)) {
      base.kind = 'test-script';
      base.evidence.push('Located under a tests/ folder; a script is never executed on its own');
      for (const sc of attachedBy.get(rel) ?? []) {
        if (isTestPath(sc)) base.relatedTests.push(mk(sc, true, 'The test scene attaches this script'));
        else base.relatedScenes.push(mk(sc, true, 'The scene attaches this script'));
      }
      if (!base.relatedTests.length) {
        for (const sc of idx.scenes) {
          if (isTestPath(sc) && stem(sc) === stem(rel)) base.suggestions.push(mk(sc, false, 'Same file name (inferred, not proven)'));
        }
      }
    } else {
      base.kind = 'gameplay-script';
      base.evidence.push('A script outside tests/: it runs only through a scene that attaches it');
      for (const sc of attachedBy.get(rel) ?? []) {
        if (isTestPath(sc)) base.relatedTests.push(mk(sc, true, 'The test scene attaches this script'));
        else base.relatedScenes.push(mk(sc, true, 'The scene attaches this script'));
      }
      // Test scripts that name this script's res:// path, and the test scenes that attach those scripts.
      const needle = `res://${rel}`;
      for (const ts of idx.scripts) {
        if (!isTestPath(ts) || ts === rel) continue;
        if (!(await text(root, ts)).includes(needle)) continue;
        for (const sc of attachedBy.get(ts) ?? []) {
          if (isTestPath(sc) && !base.relatedTests.some(r => r.rel === sc)) base.relatedTests.push(mk(sc, true, `Test script ${basename(ts)} references this script`));
        }
      }
    }
    base.actions.runRelatedTest = base.kind === 'test-script' && base.relatedTests.length > 0;
    base.actions.findRelated = base.relatedScenes.length + base.relatedTests.length + base.suggestions.length > 0;
    return base;
  }

  return base;
}

/** True when `target` is a verified related test of `script` (used to authorize "Run Related Test"). */
export async function isVerifiedRelated(root: string, script: string, target: string): Promise<boolean> {
  const c = await classify(root, script);
  return c.relatedTests.some(r => r.verified && r.rel === target);
}
