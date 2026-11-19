import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPicks, appendedText, buildChanges, defaultPicks, type Change } from '../../client/src/lib/suggestions.js'
import {
  appendAcceptance, buildQuickActionPrompt, normalizeQuickAction, TASK_ACTIONS,
} from '../src/services/taskQuickActions.js'

type Form = { title: string; description: string; prompt: string; effort: string; effortSource: 'claude' | 'manual' }
const EMPTY: Form = { title: '', description: '', prompt: '', effort: 'none', effortSource: 'manual' }
const resolve = (c: Change, f: Form): Partial<Form> => {
  if (c.key === 'title') return { title: c.proposed }
  if (c.key === 'description') return { description: c.kind === 'append' ? appendedText(f.description, c.proposed) : c.proposed }
  if (c.key === 'prompt') return { prompt: c.proposed }
  if (c.key === 'effort') return { effort: c.proposed, effortSource: 'claude' }
  return {}
}

const replace = (key: string, current: string, proposed: string): Change => ({ key, label: key, kind: 'replace', current, proposed })

test('AI Analyze: nothing is applied until something is ticked, and the form is kept', () => {
  const form: Form = { ...EMPTY, title: 'Old title', description: 'Old description' }
  const changes = buildChanges([replace('title', form.title, 'New title'), replace('description', form.description, 'New description')])
  const picks = defaultPicks(changes)
  // Both already had text, so both start unticked.
  assert.equal(picks.title, false)
  assert.equal(picks.description, false)
  const { patch, addSubtasks } = applyPicks(changes, {}, form, resolve)
  assert.deepEqual(patch, {})
  assert.deepEqual(addSubtasks, [])
  assert.equal(form.title, 'Old title') // the original object is never mutated
})

test('partial apply writes only the ticked field and leaves the rest of the form alone', () => {
  const form: Form = { ...EMPTY, title: 'T', description: 'D', prompt: 'P' }
  const changes = buildChanges([
    replace('title', form.title, 'T2'),
    replace('description', form.description, 'D2'),
    replace('prompt', form.prompt, 'P2'),
  ])
  const { patch } = applyPicks(changes, { title: true, description: false, prompt: false }, form, resolve)
  assert.deepEqual(patch, { title: 'T2' })
})

test('discard: an empty pick set returns no patch, so nothing reaches the form', () => {
  const form: Form = { ...EMPTY }
  const changes = buildChanges([replace('title', '', 'Proposed')])
  const { patch, addSubtasks } = applyPicks(changes, {}, form, resolve)
  assert.deepEqual(patch, {})
  assert.deepEqual(addSubtasks, [])
})

test('a replace equal to the current value is not offered at all', () => {
  const changes = buildChanges([replace('title', 'Same', 'Same'), replace('description', 'x', '')])
  assert.deepEqual(changes, [])
})

test('empty fields are ticked by default; filled fields are not', () => {
  const changes = buildChanges([replace('title', '', 'A'), replace('description', 'kept', 'B')])
  assert.deepEqual(defaultPicks(changes), { title: true, description: false })
})

test('subtasks are appended as new items, split by line, and never touch the form text', () => {
  const form: Form = { ...EMPTY, title: 'T' }
  const changes = buildChanges([{ key: 'subtasks', label: 'Subtasks', kind: 'subtasks', current: '', proposed: 'First step\n\n  Second step  \n' }])
  const { patch, addSubtasks } = applyPicks(changes, { subtasks: true }, form, resolve)
  assert.deepEqual(patch, {})
  assert.deepEqual(addSubtasks, ['First step', 'Second step'])
})

test('gaps are information only: shown, never ticked, never applied', () => {
  const form: Form = { ...EMPTY }
  const changes = buildChanges([{ key: 'gaps', label: 'Missing', kind: 'info', current: '', proposed: '• no acceptance' }])
  assert.equal(changes.length, 1)
  assert.deepEqual(defaultPicks(changes), { gaps: false })
  const { patch, addSubtasks } = applyPicks(changes, { gaps: true }, form, resolve)
  assert.deepEqual(patch, {})
  assert.deepEqual(addSubtasks, [])
})

test('acceptance appends under the existing description and keeps it', () => {
  const block = appendAcceptance('Users can log in.', ['Wrong password shows an error', 'Session lasts 30 minutes'])
  assert.equal(block.startsWith('Users can log in.\n\nAcceptance criteria:\n- Wrong password'), true)
  assert.equal(appendedText('Users can log in.', 'Acceptance criteria:\n- x'), 'Users can log in.\n\nAcceptance criteria:\n- x')
  assert.equal(appendAcceptance('keep me', []), 'keep me')
  assert.equal(appendAcceptance('', ['a']), 'Acceptance criteria:\n- a')
})

test('normalizer keeps only what the action asked for', () => {
  const draft = { title: 'Old', description: 'Desc', prompt: 'P' }
  const out = normalizeQuickAction('clarity', { title: 'New', description: 'Better', subtasks: ['x'], effort: 5, prompt: 'changed' }, draft)
  assert.deepEqual(Object.keys(out).sort(), ['description', 'title'])
  assert.equal(out.title, 'New')
  const simp = normalizeQuickAction('simplify', { description: 'Short', title: 'nope' }, draft)
  assert.deepEqual(Object.keys(simp), ['description'])
  const acc = normalizeQuickAction('acceptance', { acceptanceCriteria: ['a', ' ', 'b'], description: 'changed' }, draft)
  assert.deepEqual(acc, { acceptanceCriteria: ['a', 'b'] })
  const gaps = normalizeQuickAction('gaps', { gaps: ['g1'], subtasks: ['x'] }, draft)
  assert.deepEqual(gaps, { gaps: ['g1'] })
  const subs = normalizeQuickAction('subtasks', { subtasks: ['s1'], description: 'nope' }, draft)
  assert.deepEqual(subs, { subtasks: ['s1'] })
})

test('normalizer caps lists and falls back to the draft title on clarity with no title', () => {
  const many = Array.from({ length: 20 }, (_, i) => `s${i}`)
  assert.equal(normalizeQuickAction('subtasks', { subtasks: many }, {}).subtasks?.length, 8)
  assert.equal(normalizeQuickAction('gaps', { gaps: many }, {}).gaps?.length, 12)
  assert.equal(normalizeQuickAction('clarity', { description: 'd' }, { title: 'Keep' }).title, 'Keep')
  assert.deepEqual(normalizeQuickAction('clarity', null, { title: 'T' }), { title: 'T', description: undefined })
})

test('every action prompt forbids inventing evidence and asks for JSON only', () => {
  for (const action of TASK_ACTIONS) {
    const p = buildQuickActionPrompt(action, 'JabutiStudio')
    assert.match(p, /Do not invent files, tests or results/)
    assert.match(p, /ONLY with a JSON object/)
  }
})
