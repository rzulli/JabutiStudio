/**
 * The one pattern every agent suggestion follows: Quick Action -> suggestion -> preview of what would change ->
 * apply only the boxes the person ticked, or discard. Pure functions; the UI and the tests use the same code.
 *
 * Rules that hold for every kind of change:
 *  - a field the person already filled starts unticked, so a suggestion never replaces their text by default;
 *  - a change that equals the current value is not offered at all;
 *  - applying writes only the ticked changes; the rest of the form is returned untouched;
 *  - "append" adds text under the existing text (acceptance criteria), it never replaces it;
 *  - "subtasks" adds items; it never removes or reorders existing ones.
 */

export type ChangeKind = 'replace' | 'append' | 'subtasks' | 'info'

export interface Change {
  key: string
  label: string
  kind: ChangeKind
  /** What the form holds now (empty string when nothing). */
  current: string
  /** What applying would produce for this field: the full new text for 'replace'; the added text for 'append'; one item per line for 'subtasks'. */
  proposed: string
}

/** Builds the offered changes. `info` entries (gaps, notes) are shown but cannot be applied. */
export function buildChanges(items: Change[]): Change[] {
  return items.filter(c => c.kind === 'info' ? !!c.proposed.trim() : c.proposed.trim().length > 0 && (c.kind === 'replace' ? c.proposed !== c.current : true))
}

/** Unticked when the field already has text; ticked when it is empty. Info rows are never ticked. */
export function defaultPicks(changes: Change[]): Record<string, boolean> {
  return Object.fromEntries(changes.map(c => [c.key, c.kind !== 'info' && !c.current.trim()]))
}

export interface AppliedPatch<T> {
  /** Only the keys that were ticked. Everything else in the form is left as it was. */
  patch: Partial<T>
  /** Items to add to the subtask list, in order. */
  addSubtasks: string[]
}

/** Maps ticked changes onto form fields. `resolve` returns the new value for a key, or undefined to skip it. */
export function applyPicks<T extends Record<string, unknown>>(
  changes: Change[], picks: Record<string, boolean>, current: T,
  resolve: (c: Change, form: T) => Partial<T>,
): AppliedPatch<T> {
  const patch: Partial<T> = {}
  const addSubtasks: string[] = []
  for (const c of changes) {
    if (c.kind === 'info' || !picks[c.key]) continue
    if (c.kind === 'subtasks') {
      addSubtasks.push(...c.proposed.split('\n').map(s => s.trim()).filter(Boolean))
      continue
    }
    Object.assign(patch, resolve(c, current))
  }
  return { patch, addSubtasks }
}

/** Snapshot taken before any apply, so Undo restores exactly what was there. */
export function snapshot<T extends Record<string, unknown>>(form: T): T {
  return { ...form }
}

/** The text a quick action would produce for a replace/append field. */
export function appendedText(current: string, added: string): string {
  if (!added.trim()) return current
  return current.trim() ? `${current.trimEnd()}\n\n${added}` : added
}
