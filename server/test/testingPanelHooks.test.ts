/**
 * Regression for React #310 ("Rendered more hooks than during the previous render") in TestingPanel.
 * The client has no DOM test runner, so this is a structural check of the component source: every hook call in
 * TestingPanel must come before its first early return. A hook after a return runs on some renders and not on others,
 * which is exactly the loading -> loaded transition that blanked the Testing tab.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const panel = join(here, '..', '..', 'client', 'src', 'components', 'testing', 'TestingPanel.tsx')

/** Lines of the TestingPanel component body (from its declaration to the closing brace at column 0). */
export function componentBody(src: string): string[] {
  const lines = src.split(/\r?\n/)
  const start = lines.findIndex(l => /^export function TestingPanel\(/.test(l))
  assert.notEqual(start, -1, 'TestingPanel declaration not found')
  let end = lines.findIndex((l, i) => i > start && /^}/.test(l))
  assert.notEqual(end, -1, 'TestingPanel closing brace not found')
  return lines.slice(start, end + 1)
}

/** Index of the first hook call and of the first component-level early return in the body. */
export function hookOrderViolations(body: string[]): { hooksAfterReturn: number[]; firstReturn: number } {
  const hookRe = /\buse[A-Z]\w*(<[^>]*>)?\(/
  const returnRe = /^ {2}(if \(.*\) )?return\b/
  const firstReturn = body.findIndex(l => returnRe.test(l))
  assert.notEqual(firstReturn, -1, 'no early return found: the test would not be checking anything')
  const hooksAfterReturn = body.flatMap((l, i) => (i > firstReturn && hookRe.test(l) ? [i + 1] : []))
  return { hooksAfterReturn, firstReturn: firstReturn + 1 }
}

test('TestingPanel calls every hook before its first early return (no #310 on loading -> loaded)', async () => {
  const src = await readFile(panel, 'utf8')
  const { hooksAfterReturn, firstReturn } = hookOrderViolations(componentBody(src))
  assert.deepEqual(hooksAfterReturn, [], `hook call(s) after the early return at body line ${firstReturn}: ${hooksAfterReturn.join(', ')}`)
})

test('the check flags a hook placed after an early return (the pre-fix shape)', () => {
  const bad = [
    'export function TestingPanel({ projectId }) {',
    '  const { data: status } = useGodotStatus(projectId)',
    '  if (!status) return <div />',
    '  const [, setEditorCheckout] = useEditorCheckout(projectId)',
    '}',
  ]
  const { hooksAfterReturn } = hookOrderViolations(bad)
  assert.deepEqual(hooksAfterReturn, [4])
})
