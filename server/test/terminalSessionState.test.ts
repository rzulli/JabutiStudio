/**
 * What a session that runs another agent's CLI (Codex) reports. Shipyard cannot read
 * Codex's turn state, so a Codex tab must not claim `busy` on its own: a tab that
 * says `busy` with nothing behind it blocks Accept and Integrate forever
 * (`session-active`). These tests run a real PTY with a stand-in `codex` on PATH.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, getSession, killSession } from '../src/services/terminalService.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (check()) return
    await sleep(100)
  }
}

/**
 * A `codex` that stays up at its prompt, answering each line like a finished turn.
 * The prompt is `›`, not Claude's `>`/`❯`: the screen reader must not mistake it for Claude.
 */
const IDLE_SHIM = `
process.stdout.write('OpenAI Codex (test shim)\\r\\n\\r\\n\\u203a ')
process.stdin.on('data', () => { process.stdout.write('\\r\\n* Done.\\r\\n\\r\\n\\u203a ') })
process.stdin.resume()
`

/** A `codex` that dies at once, the way a missing or broken CLI does. */
const EXIT_SHIM_OUTPUT = 'codex: failed to start'

function installShim(dir: string, kind: 'idle' | 'exit'): void {
  const script = join(dir, 'fake-codex.cjs')
  writeFileSync(script, kind === 'idle' ? IDLE_SHIM : `process.stdout.write('${EXIT_SHIM_OUTPUT}\\r\\n')\nprocess.exit(1)\n`)
  const cmd = `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
  writeFileSync(join(dir, 'codex.cmd'), cmd)
}

async function withCodexShim(kind: 'idle' | 'exit', run: (sessionId: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'shipyard-codex-shim-'))
  const savedPath = process.env.PATH
  try {
    installShim(dir, kind)
    process.env.PATH = `${dir};${savedPath}`
    const id = await createSession('state-test', dir, 'ai-resolve', 100, 30, 'State test', undefined, 'Do the thing', 'codex')
    assert.ok(id, 'session should start')
    try {
      await run(id)
    } finally {
      killSession(id)
      // The shell and its child are still exiting; Windows keeps the folder locked until they are gone.
      await sleep(1_500)
    }
  } finally {
    process.env.PATH = savedPath
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {}
  }
}

test('a Codex prompt delivered to a shell does not leave the tab busy after the turn', async () => {
  await withCodexShim('idle', async id => {
    // The prompt has landed once the injector releases the watcher.
    await waitFor(() => getSession(id)?.watchHold === false, 30_000)
    await sleep(4_000)
    const session = getSession(id)
    assert.ok(session, 'the terminal stays open')
    assert.notEqual(session.state, 'busy', 'nothing can tell us Codex is still working, so it must not say busy')
  })
})

test('a Codex CLI that exits on launch does not leave the tab busy', async () => {
  await withCodexShim('exit', async id => {
    await waitFor(() => getSession(id)?.watchHold === false, 30_000)
    await sleep(1_000)
    const session = getSession(id)
    assert.ok(session, 'the shell stays open')
    assert.notEqual(session.state, 'busy', 'no CLI ran, so there is no turn to be busy with')
  })
})
