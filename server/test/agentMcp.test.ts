/**
 * Claude sessions that JabutiStudio starts get the Knowledge tools through --mcp-config, pointed at the server that is
 * running. The file names the endpoint and never a token. While the MCP server is off, no file is passed at all.
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'shipyard-agentmcp-'))
process.env.SHIPYARD_DATA_DIR = dataDir
process.env.SHIPYARD_PORT = '5431'

type Mods = {
  mcpConfig: typeof import('../src/services/mcpConfig.ts')
  mcpAuth: typeof import('../src/services/mcpAuth.ts')
  agentMcp: typeof import('../src/services/agentMcp.ts')
}
let m: Mods

before(async () => {
  m = {
    mcpConfig: await import('../src/services/mcpConfig.ts'),
    mcpAuth: await import('../src/services/mcpAuth.ts'),
    agentMcp: await import('../src/services/agentMcp.ts'),
  }
  await m.mcpAuth.loadAuthData()
  await m.mcpConfig.loadMcpConfig()
})

test('off by default: state disabled and no --mcp-config file', async () => {
  assert.equal(m.agentMcp.knowledgeState(), 'disabled')
  assert.equal(await m.agentMcp.agentMcpConfigFile(), null)
})

test('on with auth required and no approved client: needs authorization, and the file is still passed', async () => {
  await m.mcpConfig.saveMcpConfig({ enabled: true, requireAuth: true })
  assert.equal(m.agentMcp.knowledgeState(), 'needs-authorization')
  const file = await m.agentMcp.agentMcpConfigFile()
  assert.ok(file && existsSync(file))
})

test('the file points at the running server and carries no token', async () => {
  const file = await m.agentMcp.agentMcpConfigFile()
  const text = readFileSync(file!, 'utf-8')
  const json = JSON.parse(text)
  assert.deepEqual(json, { mcpServers: { shipyard: { type: 'http', url: 'http://127.0.0.1:5431/mcp' } } })
  assert.equal(/bearer|token|secret/i.test(text), false)
})

test('an approved client makes it ready', async () => {
  await m.mcpAuth.registerClient('Claude Code', ['http://127.0.0.1:9/callback'])
  assert.equal(m.agentMcp.knowledgeState(), 'ready')
})

test('with auth off the server is ready without a client', async () => {
  await m.mcpConfig.saveMcpConfig({ enabled: true, requireAuth: false })
  assert.equal(m.agentMcp.knowledgeState(), 'ready')
})

test('switching off again removes the file from new sessions', async () => {
  await m.mcpConfig.saveMcpConfig({ enabled: false, requireAuth: true })
  assert.equal(await m.agentMcp.agentMcpConfigFile(), null)
})

test('the brief names the Knowledge state the agent will see, in each of the three states', async () => {
  assert.match(m.agentMcp.knowledgePreamble(), /State: disabled/)
  await m.mcpConfig.saveMcpConfig({ enabled: true, requireAuth: true })
  await m.mcpAuth.registerClient('Second client', ['http://127.0.0.1:9/cb'])
  const ready = m.agentMcp.knowledgePreamble()
  assert.match(ready, /State: ready/)
  assert.match(ready, /get_system/)
  assert.doesNotMatch(ready, /State: needs/)
})

test('the brief never names a token or secret', async () => {
  assert.doesNotMatch(m.agentMcp.knowledgePreamble(), /bearer|token|secret/i)
})
