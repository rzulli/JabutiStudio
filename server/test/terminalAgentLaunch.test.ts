/**
 * A session opened with a prompt must carry that prompt. The plain Claude tab used to take the bare launch,
 * which has no place for a prompt, so "Send to Claude" opened an empty Claude session. A Claude tab with a
 * prompt now takes the agent path, pinned to Claude even when the settings default to another CLI.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usesBareClaudeTab, agentIdForSession } from '../src/services/terminalService.ts'

test('a Claude tab without a prompt keeps the bare launch', () => {
  assert.equal(usesBareClaudeTab('claude', undefined, undefined), true)
  assert.equal(usesBareClaudeTab('claude', undefined, ''), true)
})

test('a Claude tab with a prompt does not take the bare launch', () => {
  assert.equal(usesBareClaudeTab('claude', undefined, 'Propose a system'), false)
})

test('an explicit agent never takes the bare launch', () => {
  assert.equal(usesBareClaudeTab('claude', 'codex', 'x'), false)
  assert.equal(usesBareClaudeTab('claude', 'codex', undefined), false)
})

test('a Claude tab with a prompt runs Claude even if the default agent is another CLI', () => {
  assert.equal(agentIdForSession('claude', undefined), 'claude')
  assert.equal(agentIdForSession('claude', 'codex'), 'codex')
})

test('other agent sessions still fall back to the configured default agent', () => {
  assert.equal(agentIdForSession('ai-resolve', undefined), undefined)
  assert.equal(agentIdForSession('ai-manage', 'aider'), 'aider')
})
