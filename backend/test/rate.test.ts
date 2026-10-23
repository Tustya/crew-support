import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { after, test } from 'node:test'
import { readConfig } from '../src/config.ts'
import { clearRateLimits, startServer, type RunningServer } from '../src/http/server.ts'

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://crew:crew@127.0.0.1:54329/crew_support_test'
const servers: RunningServer[] = []

after(async () => {
  await Promise.all(servers.map((server) => server.close()))
})

async function boot(env: NodeJS.ProcessEnv): Promise<RunningServer> {
  const server = await startServer(readConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    AUTH_MODE: 'disabled',
    PORT: '0',
    ...env,
  }))
  servers.push(server)
  clearRateLimits()
  return server
}

async function call(url: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  const response = await fetch(`${url}${path}`, { headers })
  await response.arrayBuffer()
  return response.status
}

test('trusted proxy clients get separate buckets and login does not spend the api bucket', async () => {
  const server = await boot({
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
    RATE_LIMIT_PER_MINUTE: '2',
    LOGIN_RATE_LIMIT_PER_MINUTE: '2',
  })
  const first = { 'x-real-ip': '203.0.113.1' }
  const second = { 'x-real-ip': '203.0.113.2' }
  assert.equal(await call(server.url, '/api/v1/me', first), 401)
  assert.equal(await call(server.url, '/api/v1/me', first), 401)
  assert.equal(await call(server.url, '/api/v1/me', first), 429)
  assert.equal(await call(server.url, '/api/v1/me', second), 401)
  const loginHeaders = { 'x-real-ip': '203.0.113.9', 'content-type': 'application/json', 'x-crew-request': '1' }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${server.url}/api/v1/session`, { method: 'POST', headers: loginHeaders, body: '{}' })
    assert.equal(response.status, 401)
  }
  const blocked = await fetch(`${server.url}/api/v1/session`, { method: 'POST', headers: loginHeaders, body: '{}' })
  assert.equal(blocked.status, 429)
  assert.equal(await call(server.url, '/api/v1/me', { 'x-real-ip': '203.0.113.9' }), 401)
})

test('a spoofed real-ip header is ignored unless the socket is a trusted proxy', async () => {
  const server = await boot({ RATE_LIMIT_PER_MINUTE: '2' })
  assert.equal(await call(server.url, '/api/v1/me', { 'x-real-ip': '198.51.100.1' }), 401)
  assert.equal(await call(server.url, '/api/v1/me', { 'x-real-ip': '198.51.100.1' }), 401)
  assert.equal(await call(server.url, '/api/v1/me', { 'x-real-ip': '198.51.100.2' }), 429)
})

test('a slow request body is cut off', async () => {
  const server = await boot({ REQUEST_TIMEOUT_MS: '400', HEADERS_TIMEOUT_MS: '200' })
  const url = new URL(server.url)
  const outcome = await new Promise<string>((resolve) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: '/api/v1/session',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '100000', 'x-crew-request': '1' },
    })
    const timer = setTimeout(() => resolve('hung'), 2_000)
    req.on('response', (response) => {
      response.resume()
      clearTimeout(timer)
      resolve(`status:${response.statusCode}`)
    })
    req.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve(error.code ?? error.name)
    })
    req.write('{"email":')
  })
  assert.notEqual(outcome, 'hung')
  assert.notEqual(outcome, 'status:200')
})
