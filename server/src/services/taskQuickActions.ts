/**
 * Quick actions for a task's text. They run through the same AI Analyze route and the same aiBackend as before; this
 * module only decides what each action asks for and what it is allowed to return. Nothing here writes a task: the
 * client shows every proposal as a diff and the person chooses what to apply.
 */

export const TASK_ACTIONS = ['clarity', 'acceptance', 'gaps', 'simplify', 'subtasks'] as const
export type TaskAction = typeof TASK_ACTIONS[number]

export interface TaskDraft { title?: string; description?: string; prompt?: string }

const FOCUS: Record<TaskAction, string> = {
  clarity: 'Rewrite the title and description so they are clearer and more precise. Keep the same meaning and scope; do not add new requirements. Return "title" and "description" only.',
  acceptance: 'Write 3 to 6 acceptance criteria that a reviewer could check (observable behaviour, not implementation steps). Return "acceptanceCriteria": array of short strings. Do not change the description.',
  gaps: 'List what is missing or ambiguous in this task to make it executable: undefined terms, missing constraints, unknown affected files, missing acceptance. Return "gaps": array of short strings. Do not rewrite the task. If nothing is missing, return an empty array.',
  simplify: 'Shorten the description to its essential meaning, removing repetition and filler. Do not drop a requirement. Return "description" only.',
  subtasks: 'Split the work into 2 to 6 subtasks, each small enough to finish in one session. Return "subtasks": array of short action titles, in order.',
}

/** The system prompt for one action. It forbids inventing evidence and says what the model must not claim. */
export function buildQuickActionPrompt(action: TaskAction, projectContext: string): string {
  return [
    `You help a developer improve one task. Project context: ${projectContext}`,
    FOCUS[action],
    'Use only the task text and the project context given. Do not invent files, tests or results. If you cannot tell, say so in the output rather than guessing.',
    'Respond ONLY with a JSON object containing only the keys requested above. No markdown fences.',
  ].join('\n')
}

export function buildQuickActionMessage(action: TaskAction, title: string, draft: TaskDraft): string {
  return [
    `Action: ${action}`,
    `Title: ${title}`,
    `Description: ${draft.description ?? ''}`,
    `Technical details: ${draft.prompt ?? ''}`,
  ].join('\n')
}

const clean = (s: unknown) => (typeof s === 'string' ? s.trim() : '')
const list = (v: unknown, max = 8) => (Array.isArray(v) ? v.map(clean).filter(Boolean).slice(0, max) : [])

/**
 * Keep only what the action asked for, typed. Anything else the model returned is dropped, so a "clarity" answer can
 * never silently carry a new subtask list or effort into the form.
 */
export function normalizeQuickAction(action: TaskAction, parsed: any, draft: TaskDraft): {
  title?: string; description?: string; subtasks?: string[]; acceptanceCriteria?: string[]; gaps?: string[]
} {
  const p = parsed && typeof parsed === 'object' ? parsed : {}
  switch (action) {
    case 'clarity': return { title: clean(p.title) || draft.title, description: clean(p.description) || undefined }
    case 'simplify': return { description: clean(p.description) || undefined }
    case 'acceptance': return { acceptanceCriteria: list(p.acceptanceCriteria) }
    case 'gaps': return { gaps: list(p.gaps, 12) }
    case 'subtasks': return { subtasks: list(p.subtasks) }
  }
}

/** Acceptance criteria are appended under a heading, so the original description is kept as it is. */
export function appendAcceptance(description: string, criteria: string[]): string {
  if (!criteria.length) return description
  const block = ['Acceptance criteria:', ...criteria.map(c => `- ${c}`)].join('\n')
  return description.trim() ? `${description.trimEnd()}\n\n${block}` : block
}
