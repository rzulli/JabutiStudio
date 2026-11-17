/**
 * Electron's bootstrap reuses a JabutiStudio backend already on the port, starts its own when the port is
 * free, and refuses any other process. A backend it reused is never stopped when the window quits.
 * The probes run against real HTTP servers, and the identity route is the one this server registers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import { identityRoutes, SERVER_PROTOCOL as SERVER_SIDE_PROTOCOL } from '../src/routes/identity.ts'
// Dynamic import: electron/ is CommonJS, and the ESM loader cannot see named exports of its compiled output statically.
const {
  classifyIdentity, probeBackend, ensureBackend, BackendConflictError, SERVER_PROTOCOL, isUrlReachable,
} = await import('../../electron/serverBootstrap.ts')

const identityBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  app: 'jabutistudio', protocol: SERVER_PROTOCOL, serveClient: false, status: 'ok', ...overrides,
})

/** Starts a plain HTTP server on a free loopback port and returns it with its port. */
function listen(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }))
  })
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

/** A port that nothing listens on: bind, learn the number, release it. */
async function freePort(): Promise<number> {
  const { server, port } = await listen(() => {})
  await close(server)
  return port
}

test('the identity route and Electron agree on the protocol', () => {
  assert.equal(SERVER_SIDE_PROTOCOL, SERVER_PROTOCOL)
})

test('classifyIdentity accepts a JabutiStudio answer and reports whether it serves the client', () => {
  assert.deepEqual(classifyIdentity(200, identityBody(), SERVER_PROTOCOL), { kind: 'reusable', serveClient: false })
  assert.deepEqual(classifyIdentity(200, identityBody({ serveClient: true }), SERVER_PROTOCOL), { kind: 'reusable', serveClient: true })
})

test('classifyIdentity refuses a process that is not JabutiStudio', () => {
  for (const [status, body, expect] of [
    [404, '', 'identity route'],
    [500, identityBody(), 'HTTP 500'],
    [200, '<html>hello</html>', 'did not return JSON'],
    [200, 'null', 'did not return an object'],
    [200, JSON.stringify({ app: 'someone-else', protocol: SERVER_PROTOCOL, status: 'ok' }), 'not JabutiStudio'],
    [200, identityBody({ protocol: SERVER_PROTOCOL + 1 }), 'does not match'],
    [200, identityBody({ status: 'starting' }), 'not ready'],
  ] as const) {
    const result = classifyIdentity(status, body, SERVER_PROTOCOL)
    assert.equal(result.kind, 'foreign', `expected foreign for ${status} ${body}`)
    assert.match((result as { reason: string }).reason, new RegExp(expect))
  }
})

test('probeBackend reports a free port when nothing listens there', async () => {
  const port = await freePort()
  assert.deepEqual(await probeBackend({ port, expectedProtocol: SERVER_PROTOCOL }), { kind: 'free' })
})

test('probeBackend reuses a JabutiStudio backend that answers its identity route', async () => {
  const { server, port } = await listen((req, res) => {
    if (req.url === '/api/identity') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(identityBody({ serveClient: true })); return }
    res.writeHead(404); res.end()
  })
  try {
    assert.deepEqual(await probeBackend({ port, expectedProtocol: SERVER_PROTOCOL }), { kind: 'reusable', serveClient: true })
  } finally { await close(server) }
})

test('probeBackend treats a port that answers with something else as a conflict, not as free', async () => {
  const { server, port } = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>not us</h1>') })
  try {
    const result = await probeBackend({ port, expectedProtocol: SERVER_PROTOCOL })
    assert.equal(result.kind, 'foreign')
  } finally { await close(server) }
})

test('probeBackend gives up on a port that accepts connections but never answers', async () => {
  const sockets: import('node:net').Socket[] = []
  const { server, port } = await listen(() => {})
  server.on('connection', (s) => sockets.push(s))
  try {
    const started = Date.now()
    const result = await probeBackend({ port, expectedProtocol: SERVER_PROTOCOL, timeoutMs: 200 })
    assert.equal(result.kind, 'foreign')
    assert.ok(Date.now() - started < 3000, 'the probe must not hang')
  } finally {
    sockets.forEach((s) => s.destroy())
    await close(server)
  }
})

test('the real identity route is recognised by the Electron probe', async () => {
  const app = Fastify({ logger: false })
  await app.register(identityRoutes, { serveClient: true })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as AddressInfo).port
  try {
    assert.deepEqual(await probeBackend({ port, expectedProtocol: SERVER_PROTOCOL }), { kind: 'reusable', serveClient: true })
  } finally { await app.close() }
})

test('isUrlReachable is true for a server that answers and false for a free port', async () => {
  const { server, port } = await listen((_req, res) => { res.writeHead(200); res.end('ok') })
  try {
    assert.equal(await isUrlReachable('127.0.0.1', port), true)
  } finally { await close(server) }
  assert.equal(await isUrlReachable('127.0.0.1', await freePort()), false)
})

test('ensureBackend reuses a compatible backend: no spawn, and stopping leaves it running', async () => {
  let spawned = 0
  let killed = 0
  const handle = await ensureBackend({
    port: 5420,
    probe: async () => ({ kind: 'reusable', serveClient: false }),
    spawnOwn: async () => { spawned++; return { stop: () => { killed++ } } },
  })
  assert.equal(handle.ownership, 'external')
  assert.equal(handle.serveClient, false)
  handle.stop()
  handle.stop()
  assert.equal(spawned, 0)
  assert.equal(killed, 0)
})

test('ensureBackend starts its own backend when the port is free, and stops it exactly once', async () => {
  let spawned = 0
  let killed = 0
  const handle = await ensureBackend({
    port: 5420,
    probe: async () => ({ kind: 'free' }),
    spawnOwn: async () => { spawned++; return { stop: () => { killed++ } } },
  })
  assert.equal(handle.ownership, 'own')
  assert.equal(spawned, 1)
  assert.equal(killed, 0)
  handle.stop()
  handle.stop()
  assert.equal(killed, 1)
})

test('ensureBackend refuses a foreign process without spawning or stopping anything', async () => {
  let spawned = 0
  await assert.rejects(
    ensureBackend({
      port: 5420,
      probe: async () => ({ kind: 'foreign', reason: 'the process on this port is not JabutiStudio' }),
      spawnOwn: async () => { spawned++; return { stop: () => {} } },
    }),
    (err: unknown) => err instanceof BackendConflictError && /5420/.test(err.message) && /not JabutiStudio/.test(err.message),
  )
  assert.equal(spawned, 0)
})

test('ensureBackend propagates a failed spawn and returns no handle', async () => {
  await assert.rejects(
    ensureBackend({
      port: 5420,
      probe: async () => ({ kind: 'free' }),
      spawnOwn: async () => { throw new Error('Server exited with code 1') },
    }),
    /exited with code 1/,
  )
})
