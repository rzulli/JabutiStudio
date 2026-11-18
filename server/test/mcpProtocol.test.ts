/**
 * MCP wire behaviour that real CLIs depend on: notifications get an empty 202 (Codex drops the server on a 200 body),
 * and with auth required a call with a real token is accepted, recorded as that client's use, and a call without one is not.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

process.env.SHIPYARD_DATA_DIR = mkdtempSync(join(tmpdir(), 'shipyard-mcpproto-'))
process.env.SHIPYARD_PORT = '5432'

let app: FastifyInstance
let cfg: typeof import('../src/services/mcpConfig.ts')
let auth: typeof import('../src/services/mcpAuth.ts')
let agent: typeof import('../src/services/agentMcp.ts')

before(async () => {
  cfg = await import('../src/services/mcpConfig.ts')
  auth = await import('../src/services/mcpAuth.ts')
  agent = await import('../src/services/agentMcp.ts')
  const Fastify = (await import('fastify')).default
  const { mcpRoutes } = await import('../src/routes/mcp.ts')
  app = Fastify()
  await app.register(mcpRoutes)
})
after(async () => { await app.close() })

const post = (payload: unknown, token?: string) => app.inject({
  method: 'POST', url: '/mcp', payload: payload as object,
  headers: token ? { authorization: `Bearer ${token}` } : {},
})

test('notifications get an empty 202; requests still get their reply', async () => {
  await cfg.saveMcpConfig({ enabled: true, requireAuth: false })
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(init.statusCode, 200)
  assert.equal(JSON.parse(init.body).result.serverInfo.name, 'shipyard')
  for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/unknown']) {
    const res = await post({ jsonrpc: '2.0', method })
    assert.equal(res.statusCode, 202, method)
    assert.equal(res.body, '', method)
  }
  assert.equal((await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }])).statusCode, 202)
  const mixed = await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 7, method: 'ping' }])
  assert.deepEqual(JSON.parse(mixed.body), [{ jsonrpc: '2.0', id: 7, result: {} }])
  assert.equal(JSON.parse((await post({ jsonrpc: '2.0', id: 9, method: 'nope' })).body).error.code, -32601)
})

test('auth required: no token is refused; a real token lists tools and its use is recorded for that agent', async () => {
  await cfg.saveMcpConfig({ enabled: true, requireAuth: true })
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode, 401)
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'garbage')).statusCode, 401)

  const redirect = 'http://127.0.0.1:9/callback'
  const client = await auth.registerClient('Codex', [redirect])
  assert.match(agent.knowledgeDiagnosis('codex').reason, /No approved Codex client/)
  const verifier = 'w'.repeat(50)
  const code = await auth.createAuthCode(client.clientId, createHash('sha256').update(verifier).digest('base64url'), 'S256', redirect, 'shipyard:read')
  const tokens = await auth.exchangeCode(code, verifier, client.clientId, redirect)
  assert.ok(tokens)

  assert.match(agent.knowledgeDiagnosis('codex').reason, /No use by this client has been recorded/)
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tokens.access_token)
  assert.equal(list.statusCode, 200)
  const names = JSON.parse(list.body).result.tools.map((x: { name: string }) => x.name)
  for (const tool of agent.KNOWLEDGE_TOOLS) assert.ok(names.includes(tool), tool)
  await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_systems', arguments: { projectId: 'nope' } } }, tokens.access_token)

  const d = agent.knowledgeDiagnosis('codex')
  assert.equal(d.state, 'ready')
  assert.match(d.reason, /Last recorded use by this client \(not proof for a new session\): tools listed/)
  assert.match(d.reason, /1 tool call\(s\), last list_systems/)
  assert.equal(agent.knowledgeDiagnosis('claude').state, 'needs-authorization')
})
