/**
 * Claude and Codex sessions that JabutiStudio starts get the Knowledge tools pointed at the server that is running.
 * `ready` means the agent's own client was approved (holds a token), not merely that some client registered: dynamic
 * registration happens before the person sees the consent page. Nothing here carries a token.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

const dataDir = mkdtempSync(join(tmpdir(), 'shipyard-agentmcp-'))
process.env.SHIPYARD_DATA_DIR = dataDir
process.env.SHIPYARD_PORT = '5431'

type Mods = {
  mcpConfig: typeof import('../src/services/mcpConfig.ts')
  mcpAuth: typeof import('../src/services/mcpAuth.ts')
  agentMcp: typeof import('../src/services/agentMcp.ts')
  mcpServer: typeof import('../src/services/mcpServer.ts')
  terminal: typeof import('../src/services/terminalService.ts')
}
let m: Mods
let app: FastifyInstance | null = null

before(async () => {
  m = {
    mcpConfig: await import('../src/services/mcpConfig.ts'),
    mcpAuth: await import('../src/services/mcpAuth.ts'),
    agentMcp: await import('../src/services/agentMcp.ts'),
    mcpServer: await import('../src/services/mcpServer.ts'),
    terminal: await import('../src/services/terminalService.ts'),
  }
  await m.mcpAuth.loadAuthData()
  await m.mcpConfig.loadMcpConfig()
})

after(async () => { await app?.close() })

/** Runs the real approval: register, consent (auth code) and token exchange, as a CLI would. */
async function approve(name: string) {
  const redirect = 'http://127.0.0.1:9/callback'
  const client = await m.mcpAuth.registerClient(name, [redirect])
  const verifier = 'v'.repeat(50)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const code = await m.mcpAuth.createAuthCode(client.clientId, challenge, 'S256', redirect, 'shipyard:read')
  const tokens = await m.mcpAuth.exchangeCode(code, verifier, client.clientId, redirect)
  assert.ok(tokens, 'the token exchange must succeed')
  return client
}

test('off by default: state disabled and no --mcp-config file, for both agents', async () => {
  assert.equal(m.agentMcp.knowledgeState('claude'), 'disabled')
  assert.equal(m.agentMcp.knowledgeState('codex'), 'disabled')
  assert.equal(await m.agentMcp.agentMcpConfigFile(), null)
  assert.equal(m.terminal.codexMcpArgs(), '')
  assert.equal(await m.terminal.claudeMcpArgs(), '')
})

test('on with auth required and nothing approved: needs authorization, and the file is still passed', async () => {
  await m.mcpConfig.saveMcpConfig({ enabled: true, requireAuth: true })
  assert.equal(m.agentMcp.knowledgeState('claude'), 'needs-authorization')
  assert.equal(m.agentMcp.knowledgeState('codex'), 'needs-authorization')
  const file = await m.agentMcp.agentMcpConfigFile()
  assert.ok(file && existsSync(file))
})

test('a client that only registered is not ready (the consent page was never approved)', async () => {
  await m.mcpAuth.registerClient('Codex', ['http://127.0.0.1:9/callback'])
  assert.equal(m.agentMcp.knowledgeState('codex'), 'needs-authorization')
  assert.equal(m.agentMcp.knowledgeState(), 'needs-authorization')
})

test('an approved Claude client does not make Codex ready, and the diagnosis says so', async () => {
  await approve('Claude Code')
  assert.equal(m.agentMcp.knowledgeState('claude'), 'ready')
  const codex = m.agentMcp.knowledgeDiagnosis('codex')
  assert.equal(codex.state, 'needs-authorization')
  assert.match(codex.reason, /Claude Code/)
  assert.match(codex.reason, /does not authorize Codex/)
})

test('the Codex fix names the login with the same -c override the session uses', async () => {
  const fix = m.agentMcp.knowledgeDiagnosis('codex').fix
  assert.ok(fix.includes('codex -c mcp_servers.shipyard.url=http://127.0.0.1:5431/mcp mcp login shipyard'))
  assert.doesNotMatch(fix, /codex mcp login shipyard/)
})

test('an approved Codex client makes Codex ready', async () => {
  await approve('Codex')
  assert.equal(m.agentMcp.knowledgeState('codex'), 'ready')
})

test('a revoked client stops being ready', async () => {
  const c = await approve('Codex')
  const others = m.mcpAuth.listAuthorizedClients().filter(x => /codex/i.test(x.clientName) && x.clientId !== c.clientId)
  for (const x of others) await m.mcpAuth.revokeClient(x.clientId)
  await m.mcpAuth.revokeClient(c.clientId)
  assert.equal(m.agentMcp.knowledgeState('codex'), 'needs-authorization')
  await approve('Codex')
})

test('with auth off the server is ready without a client', async () => {
  await m.mcpConfig.saveMcpConfig({ enabled: true, requireAuth: false })
  assert.equal(m.agentMcp.knowledgeState('codex'), 'ready')
  assert.equal(m.agentMcp.knowledgeState('claude'), 'ready')
})

test('Claude gets --mcp-config with the endpoint and no token; Codex gets a -c override on the same port', async () => {
  await m.mcpConfig.saveMcpConfig({ enabled: true, requireAuth: true })
  const file = await m.agentMcp.agentMcpConfigFile()
  const text = readFileSync(file!, 'utf-8')
  assert.deepEqual(JSON.parse(text), { mcpServers: { shipyard: { type: 'http', url: 'http://127.0.0.1:5431/mcp' } } })
  assert.equal(/bearer|token|secret/i.test(text), false)
  assert.match(await m.terminal.claudeMcpArgs(), /^--mcp-config /)
  assert.equal(m.terminal.codexMcpArgs(), '-c mcp_servers.shipyard.url=http://127.0.0.1:5431/mcp')
})

test('switching off again removes the file and the override from new sessions', async () => {
  await m.mcpConfig.saveMcpConfig({ enabled: false, requireAuth: true })
  assert.equal(await m.agentMcp.agentMcpConfigFile(), null)
  assert.equal(m.terminal.codexMcpArgs(), '')
})

test('every Knowledge tool the brief names is a tool the server lists', () => {
  const served = m.mcpServer.MCP_TOOLS.map((t: { name: string }) => t.name)
  for (const t of m.agentMcp.KNOWLEDGE_TOOLS) assert.ok(served.includes(t), `${t} missing from MCP_TOOLS`)
})

test('the brief states the state each agent will see', async () => {
  assert.match(m.agentMcp.knowledgePreamble('codex'), /State: disabled/)
  await m.mcpConfig.saveMcpConfig({ enabled: true, requireAuth: true })
  const claude = m.agentMcp.knowledgePreamble('claude')
  assert.match(claude, /State: ready/)
  assert.match(claude, /get_system/)
  assert.match(claude, /proposals? only|New findings are proposals only/)
  assert.doesNotMatch(claude, /State: needs/)
  for (const x of m.mcpAuth.listClients().filter(c => /codex/i.test(c.clientName))) await m.mcpAuth.revokeClient(x.clientId)
  const codex = m.agentMcp.knowledgePreamble('codex')
  assert.match(codex, /State: needs authorization/)
  assert.match(codex, /mcp login shipyard/)
  assert.match(codex, /-c mcp_servers\.shipyard\.url=/)
  assert.doesNotMatch(codex, /State: ready/)
})

test('the brief never names a token or secret', async () => {
  for (const agent of ['claude', 'codex'] as const) assert.doesNotMatch(m.agentMcp.knowledgePreamble(agent), /bearer|token|secret|eyJ/i)
})

test('an agent proposal never approves: the server has no approve/confirm tool', () => {
  const served = m.mcpServer.MCP_TOOLS.map((t: { name: string }) => t.name)
  assert.equal(served.some((n: string) => /approve|accept|confirm|integrate/i.test(n)), false)
})

test('endpoint probe: a dynamic port is followed, and a wrong one is reported, not hidden', async () => {
  await m.mcpConfig.saveMcpConfig({ enabled: true, requireAuth: false })
  const Fastify = (await import('fastify')).default
  app = Fastify()
  const { mcpRoutes } = await import('../src/routes/mcp.ts')
  await app.register(mcpRoutes)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as { port: number }).port

  process.env.SHIPYARD_PORT = String(port)
  const open = await m.agentMcp.probeKnowledgeEndpoint()
  assert.equal(open.ok, true, open.detail)
  assert.deepEqual([...m.agentMcp.KNOWLEDGE_TOOLS].filter(t => !open.tools!.includes(t)), [])

  await m.mcpConfig.saveMcpConfig({ enabled: true, requireAuth: true })
  const guarded = await m.agentMcp.probeKnowledgeEndpoint()
  assert.equal(guarded.ok, true, guarded.detail)
  assert.match(guarded.detail, /401/)

  process.env.SHIPYARD_PORT = '1'
  const wrong = await m.agentMcp.probeKnowledgeEndpoint()
  assert.equal(wrong.ok, false)
  assert.match(wrong.detail, /not reachable/)
  const brief = m.agentMcp.knowledgePreamble('claude', wrong)
  assert.match(brief, /Endpoint check failed/)

  await app.close(); app = null
  process.env.SHIPYARD_PORT = String(port)
  const down = await m.agentMcp.probeKnowledgeEndpoint()
  assert.equal(down.ok, false)
  process.env.SHIPYARD_PORT = '5431'
})
