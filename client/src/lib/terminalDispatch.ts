/**
 * Opening an agent session with a first message. The terminal panel answers each request with a TabResult, so a
 * caller can tell a session that took the prompt from one that did not, and keep the user's text in the second case.
 */

/** Outcome of a `shipyard:open-terminal` request: a session that took the prompt, or why not. */
export type TabResult = { ok: true; sessionId: string } | { ok: false; error: string }

export interface OpenAgentSessionRequest {
  projectId: string
  /** Agent that answers. Claude is the default; Codex is the other option. */
  agent: 'claude' | 'codex'
  prompt: string
}

/** How long a request may wait for the terminal panel before it is reported as failed. */
export const OPEN_SESSION_TIMEOUT_MS = 15_000

/**
 * Ask the terminal panel to open a session that starts with `prompt`. Resolves once with the outcome; a late answer
 * after the timeout is ignored, so the caller sees one result and never a second one.
 */
export function openAgentSession({ projectId, agent, prompt }: OpenAgentSessionRequest): Promise<TabResult> {
  return new Promise<TabResult>(resolve => {
    let settled = false
    const finish = (r: TabResult) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve(r)
    }
    const timer = window.setTimeout(
      () => finish({ ok: false, error: 'The terminal did not answer. Is the terminal panel available?' }),
      OPEN_SESSION_TIMEOUT_MS,
    )
    window.dispatchEvent(new CustomEvent('shipyard:open-terminal', {
      detail: { projectId, type: 'claude', agent, prompt, onResult: finish },
    }))
  })
}

/**
 * The first message for a session that proposes a system from the user's own description. The description is
 * included verbatim; the rest only sets the rules the proposal must follow.
 */
export function buildSystemProposalPrompt(projectId: string, description: string): string {
  return [
    `Propose a NEW system for this project (${projectId}) from the description below, using the MCP tool propose_system.`,
    'Before proposing, read the existing Knowledge for this project with get_design_context and the current systems with get_system, so the proposal does not duplicate or contradict a decision already made.',
    'Give it a name, a kind (system / subsystem / mechanic / entity), a one or two sentence summary of what it does for the player, its responsibilities, components (each a mechanic, subsystem or entity) and gameplay relations.',
    'Keep a resource (entity) separate from the system that produces, consumes or controls it. A relation may only say that something produces, consumes or stores an entity, not a mechanic or an activity.',
    'If something is not built yet, say so in the summary. Look at the real code with get_system / the Explorer before claiming files or evidence, and say what you could not verify.',
    'Rules: you may only PROPOSE. Do not record approvals, do not mark anything confirmed (only the user can, in the UI), do not change gameplay rules or numbers, and do not write or change Godot code or scenes: this is design only.',
    'The proposal appears in the Systems list for the user to review and confirm in the editor.',
    '', 'Description from the user:', description.trim(),
  ].join('\n')
}
