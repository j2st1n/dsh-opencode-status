import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../src/index.js'

const projectDir = fileURLToPath(new URL('..', import.meta.url))

function request(method, url, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(payload)
  req.method = method
  req.url = url
  return req
}

async function invoke(route, method, url, body) {
  let status = null
  let text = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk = '') {
      text += chunk
    },
  }
  await route.handler(request(method, url, body), res)
  return { status, body: text ? JSON.parse(text) : null }
}

function harness(initialConfig, initialCredentials = {}) {
  const routes = new Map()
  const credentials = new Map(Object.entries(initialCredentials))
  let config = { ...initialConfig }
  const scope = {
    get: () => ({ ...config }),
    update: async (patch) => {
      config = { ...config, ...patch }
    },
  }
  const ctx = {
    settings: { register: () => scope },
    credentials: {
      describe: async (ref) => ({ configured: credentials.has(ref), source: 'store', writable: true }),
      resolve: async (ref) => credentials.has(ref) ? { value: credentials.get(ref) } : undefined,
      set: async (ref, value) => credentials.set(ref, value),
      unset: async (ref) => credentials.delete(ref),
    },
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect: (factory) => factory(),
  }
  apply(ctx)
  return { routes, credentials, getConfig: () => ({ ...config }) }
}

test('custom keyRef is used consistently and sync route forces a refresh', async () => {
  const originalFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    return new Response(JSON.stringify({
      usage: {
        rolling: { percent: 10, status: 'ok' },
        weekly: { percent: 20, status: 'ok' },
        monthly: { percent: 30, status: 'ok' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const app = harness(
      { baseUrl: 'https://opencode.example.test/go', keyRef: 'CUSTOM_OPENCODE_KEY' },
      { CUSTOM_OPENCODE_KEY: 'old-key' },
    )
    const configRoute = app.routes.get('/api/opencode-status/config')
    const syncRoute = app.routes.get('/api/opencode-status/sync')

    const saved = await invoke(configRoute, 'PUT', '/api/opencode-status/config', {
      baseUrl: 'https://opencode.example.test/go',
      apiKey: 'new-key',
    })
    assert.equal(saved.status, 200)
    assert.equal(app.credentials.get('CUSTOM_OPENCODE_KEY'), 'new-key')
    assert.equal(app.credentials.has('OPENCODE_GO_API_KEY'), false)

    const synced = await invoke(syncRoute, 'POST', '/api/opencode-status/sync')
    assert.equal(synced.status, 200)
    assert.equal(synced.body.monthlyUsedPct, 30)
    assert.equal(fetches, 2)

    const rejected = await invoke(syncRoute, 'GET', '/api/opencode-status/sync')
    assert.equal(rejected.status, 405)

    const cleared = await invoke(configRoute, 'PUT', '/api/opencode-status/config', {
      baseUrl: 'https://opencode.example.test/go',
      clearApiKey: true,
    })
    assert.equal(cleared.status, 200)
    assert.equal(app.credentials.has('CUSTOM_OPENCODE_KEY'), false)
    assert.equal(cleared.body.status.mode, 'needs_config')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OPENCODE_BASE_URL becomes the schema default for an unconfigured profile', () => {
  const script = `
    process.env.OPENCODE_BASE_URL = 'https://env.example.test/go/'
    const { apply } = await import('./src/index.js?env-default-test')
    let schema
    const scope = { get: () => ({ baseUrl: '', keyRef: '' }), update: async () => {} }
    apply({
      settings: { register: (_namespace, value) => { schema = value; return scope } },
      credentials: {},
      webServer: { register: () => () => {} },
      effect: (factory) => factory(),
    })
    process.stdout.write(schema.dict.baseUrl.meta.default)
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectDir,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'https://env.example.test/go')
})
