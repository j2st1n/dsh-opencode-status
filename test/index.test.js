import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply, Config, inject } from '../src/index.js'

const projectDir = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_BASE_URL = Config.dict.baseUrl.meta.default
const DEFAULT_KEY_REF = Config.dict.keyRef.meta.default

const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1:3080' }

function request(method, url, body, options) {
  const payload = options.rawBody === undefined
    ? body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    : [Buffer.from(options.rawBody)]
  const req = Readable.from(payload)
  req.method = method
  req.url = url
  // 默认模拟浏览器客户端；写请求带 application/json，对 GET 无影响。
  req.headers = options.headers ?? JSON_HEADERS
  return req
}

async function invoke(route, method, url, body, options = {}) {
  let status = null
  let headers = null
  let text = ''
  const res = {
    writeHead(code, values) {
      status = code
      headers = values
    },
    end(chunk = '') {
      text += chunk
    },
  }
  await route.handler(request(method, url, body, options), res)
  return { status, headers, body: text ? JSON.parse(text) : null }
}

function gatewayResponse() {
  return new Response(JSON.stringify({
    usage: {
      rolling: { percent: 10, status: 'ok' },
      weekly: { percent: 20, status: 'ok' },
      monthly: { percent: 30, status: 'ok' },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 模拟宿主配置：plain 对象，或 DSH 0.2.x 传入的 volatile live ref。 */
function createConfig(values, volatile) {
  const state = { ...values }
  const source = volatile
    ? { baseUrl: { get: () => state.baseUrl }, keyRef: { get: () => state.keyRef } }
    : state
  return {
    source,
    read: () => ({ ...state }),
    write: (patch) => {
      Object.assign(state, patch)
    },
  }
}

/**
 * @param {object} [options]
 * @param {'ok'|'missing'|'fail'} [options.settings] settings.update 的成功 / 缺失 / 失败路径
 * @param {'get'|'property'} [options.settingsMount] 服务通过 ctx.get('settings') 还是 ctx.settings 暴露
 * @param {boolean} [options.volatile] 配置字段是否以 { get() } live ref 传入
 * @param {{host?: string, protocol?: string}} [options.webServer] 监听器 bind 地址与 scheme
 * @param {object} [options.connection] DSH connection 服务（trustedHosts / isTrusted）
 */
function harness({
  config = {},
  credentials = {},
  volatile = false,
  settings = 'ok',
  settingsMount = 'get',
  webServer = {},
  connection,
} = {}) {
  const routes = new Map()
  const store = new Map(Object.entries(credentials))
  const configStore = createConfig(config, volatile)
  const updates = []
  const settingsService = settings === 'missing'
    ? null
    : {
        update: async (ns, patch) => {
          if (settings === 'fail') throw new Error('plugin entry is not configurable')
          updates.push({ ns, patch })
          // 真实宿主会把 volatile ref 的值更新为刚持久化的配置。
          configStore.write(patch)
        },
      }
  const ctx = {
    credentials: {
      describe: async (ref) => ({ configured: store.has(ref), source: 'store', writable: true }),
      resolve: async (ref) => store.has(ref) ? { value: store.get(ref) } : undefined,
      set: async (ref, value) => store.set(ref, value),
      unset: async (ref) => store.delete(ref),
    },
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      host: webServer.host ?? '127.0.0.1',
      protocol: webServer.protocol ?? 'http:',
    },
    effect: (factory) => factory(),
  }
  const readConnection = () => connection ?? undefined
  if (settingsMount === 'get') {
    ctx.get = (name) => {
      if (name === 'settings') return settingsService ?? undefined
      if (name === 'connection') return readConnection()
      return undefined
    }
  } else {
    ctx.settings = settingsService ?? undefined
    ctx.get = (name) => (name === 'connection' ? readConnection() : undefined)
  }
  apply(ctx, configStore.source)
  return {
    routes,
    credentials: store,
    updates,
    readConfig: configStore.read,
    setConfig: configStore.write,
  }
}

test('Config 是合法的 schemastery schema，baseUrl/keyRef 为 volatile 字段', () => {
  assert.equal(typeof Config, 'function')
  assert.equal(Config['~standard'].vendor, 'schemastery')
  assert.equal(Config.dict.baseUrl.meta.volatile, true)
  assert.equal(Config.dict.keyRef.meta.volatile, true)
  assert.equal(Config.dict.baseUrl.meta.default, DEFAULT_BASE_URL)
  assert.equal(Config.dict.keyRef.meta.default, 'OPENCODE_GO_API_KEY')

  // 宿主通过 ~standard.validate 解析配置，volatile 字段解析为 { get() } live ref。
  const resolved = Config({}).baseUrl
  assert.equal(typeof resolved.get, 'function')
  assert.equal(resolved.get(), DEFAULT_BASE_URL)
  assert.equal(Config({}).keyRef.get(), 'OPENCODE_GO_API_KEY')

  // settings 已不再作为必需注入项，缺失时插件仍要激活。
  assert.equal(inject.includes('settings'), false)
  assert.deepEqual(inject, ['credentials', 'webServer'])
})

test('宿主端不再调用已被 DSH 0.2.x 移除的配置注册接口', () => {
  // 拆开拼接，避免本文件命中 "src/ 与 test/ 不含该调用" 的仓库检查。
  const removed = ['settings', 'register'].join('.')
  for (const file of ['src/index.js', 'src/client.js', 'test/index.test.js']) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.equal(text.includes(removed), false, file)
  }
})

test('配置字段缺失时回退到默认 Base URL 与默认密钥引用', async () => {
  const app = harness({ credentials: { [DEFAULT_KEY_REF]: 'secret-1234' } })
  const res = await invoke(app.routes.get('/api/opencode-status/config'), 'GET', '/api/opencode-status/config')

  assert.equal(res.status, 200)
  assert.equal(res.body.baseUrl, DEFAULT_BASE_URL)
  assert.deepEqual(res.body.apiKey, { configured: true, source: 'store', writable: true, hint: '••••1234' })
})

test('volatile live ref 配置按请求时的最新值生效', async () => {
  const originalFetch = globalThis.fetch
  let requestedUrl = null
  globalThis.fetch = async (url) => {
    requestedUrl = String(url)
    return gatewayResponse()
  }

  try {
    const app = harness({
      volatile: true,
      config: { baseUrl: 'https://ref.example.test/go', keyRef: 'REF_OPENCODE_KEY' },
      credentials: { REF_OPENCODE_KEY: 'ref-secret-9999' },
    })
    const res = await invoke(app.routes.get('/api/opencode-status'), 'GET', '/api/opencode-status')

    assert.equal(res.status, 200)
    assert.equal(res.body.mode, 'ready')
    assert.equal(res.body.config.baseUrl, 'https://ref.example.test/go')
    assert.equal(requestedUrl, 'https://ref.example.test/go/v1/usage')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET 状态：缺少密钥 needs_config，网关正常 ready，异常 GATEWAY_ERROR 不抛到路由外', async () => {
  const originalFetch = globalThis.fetch
  try {
    const withoutKey = harness()
    const missing = await invoke(withoutKey.routes.get('/api/opencode-status'), 'GET', '/api/opencode-status')
    assert.equal(missing.status, 200)
    assert.equal(missing.body.mode, 'needs_config')
    assert.equal(missing.body.error.code, 'NOT_CONFIGURED')
    assert.deepEqual(missing.body.windows, [])

    const app = harness({ credentials: { [DEFAULT_KEY_REF]: 'sk-live-1234' } })
    const route = app.routes.get('/api/opencode-status')
    let requested = null
    globalThis.fetch = async (url, init) => {
      requested = { url: String(url), auth: init?.headers?.Authorization }
      return gatewayResponse()
    }

    const ready = await invoke(route, 'GET', '/api/opencode-status')
    assert.equal(ready.status, 200)
    assert.equal(ready.body.mode, 'ready')
    assert.equal(ready.body.ok, true)
    assert.equal(ready.body.monthlyUsedPct, 30)
    assert.deepEqual(ready.body.windows.map((w) => w.id), ['rolling', 'weekly', 'monthly'])
    assert.equal(requested.url, `${DEFAULT_BASE_URL}/v1/usage`)
    assert.equal(requested.auth, 'Bearer sk-live-1234')

    globalThis.fetch = async () => new Response('gateway down', { status: 503 })
    const failed = await invoke(route, 'GET', '/api/opencode-status?force=1')
    assert.equal(failed.status, 200)
    assert.equal(failed.body.mode, 'ready')
    assert.equal(failed.body.ok, false)
    assert.equal(failed.body.error.code, 'GATEWAY_ERROR')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('30s 缓存生效，sync 端点与 ?force 强制刷新', async () => {
  const originalFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    return gatewayResponse()
  }

  try {
    const app = harness({ credentials: { [DEFAULT_KEY_REF]: 'cache-key-1234' } })
    const statusRoute = app.routes.get('/api/opencode-status')
    const syncRoute = app.routes.get('/api/opencode-status/sync')

    const first = await invoke(statusRoute, 'GET', '/api/opencode-status')
    const cached = await invoke(statusRoute, 'GET', '/api/opencode-status')
    assert.equal(first.body.fetchedAt, cached.body.fetchedAt)
    assert.equal(fetches, 1)

    const synced = await invoke(syncRoute, 'POST', '/api/opencode-status/sync')
    assert.equal(synced.status, 200)
    assert.equal(synced.body.monthlyUsedPct, 30)
    assert.equal(fetches, 2)

    const forced = await invoke(statusRoute, 'GET', '/api/opencode-status?force=1')
    assert.equal(forced.status, 200)
    assert.equal(fetches, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('PUT 通过 settings.update 以 profile 条目 id 持久化 baseUrl 并保存密钥', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => gatewayResponse()

  try {
    const app = harness({ credentials: { [DEFAULT_KEY_REF]: 'old-key-1111' } })
    const res = await invoke(app.routes.get('/api/opencode-status/config'), 'PUT', '/api/opencode-status/config', {
      baseUrl: 'https://saved.example.test/go/',
      apiKey: 'new-key-2222',
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.saved, true)
    assert.deepEqual(app.updates, [{ ns: 'opencode-status', patch: { baseUrl: 'https://saved.example.test/go' } }])
    assert.equal(app.credentials.has(DEFAULT_KEY_REF), true)
    assert.equal(app.credentials.get(DEFAULT_KEY_REF), 'new-key-2222')
    assert.equal(res.body.config.baseUrl, 'https://saved.example.test/go')
    assert.equal(res.body.config.apiKey.hint, '••••2222')
    assert.equal(res.body.status.mode, 'ready')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('baseUrl 未变化时不触发持久化，缺少 settings 的宿主仍可管理密钥', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => gatewayResponse()

  try {
    const app = harness({ settings: 'missing', config: { baseUrl: DEFAULT_BASE_URL } })
    const res = await invoke(app.routes.get('/api/opencode-status/config'), 'PUT', '/api/opencode-status/config', {
      baseUrl: DEFAULT_BASE_URL,
      apiKey: 'missing-settings-key',
    })

    assert.equal(res.status, 200)
    assert.deepEqual(app.updates, [])
    assert.equal(app.credentials.get(DEFAULT_KEY_REF), 'missing-settings-key')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('宿主缺少 settings 服务时 baseUrl 变更降级为明确错误而非崩溃', async () => {
  const app = harness({ settings: 'missing' })
  const res = await invoke(app.routes.get('/api/opencode-status/config'), 'PUT', '/api/opencode-status/config', {
    baseUrl: 'https://unsupported.example.test/go',
    apiKey: 'never-written',
  })

  assert.equal(res.status, 409)
  assert.equal(res.body.error.code, 'SETTINGS_UNAVAILABLE')
  assert.match(res.body.error.message, /settings/)
  assert.equal(app.credentials.has(DEFAULT_KEY_REF), false)
})

test('settings.update 失败时返回 PERSIST_FAILED 而不是抛到路由外', async () => {
  const app = harness({ settings: 'fail' })
  const res = await invoke(app.routes.get('/api/opencode-status/config'), 'PUT', '/api/opencode-status/config', {
    baseUrl: 'https://broken.example.test/go',
  })

  assert.equal(res.status, 409)
  assert.equal(res.body.error.code, 'PERSIST_FAILED')
  assert.match(res.body.error.message, /Base URL/)
})

test('settings 服务直接挂在 ctx 上时同样可以持久化 baseUrl', async () => {
  const app = harness({ settingsMount: 'property' })
  const res = await invoke(app.routes.get('/api/opencode-status/config'), 'PUT', '/api/opencode-status/config', {
    baseUrl: 'https://property.example.test/go',
  })

  assert.equal(res.status, 200)
  assert.deepEqual(app.updates, [{ ns: 'opencode-status', patch: { baseUrl: 'https://property.example.test/go' } }])
})

test('自定义 keyRef 在读取、写入与清除时保持一致', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => gatewayResponse()

  try {
    const app = harness({
      config: { keyRef: 'CUSTOM_OPENCODE_KEY' },
      credentials: { CUSTOM_OPENCODE_KEY: 'old-8888' },
    })
    const route = app.routes.get('/api/opencode-status/config')

    const saved = await invoke(route, 'PUT', '/api/opencode-status/config', {
      baseUrl: DEFAULT_BASE_URL,
      apiKey: 'new-9999',
    })
    assert.equal(saved.status, 200)
    assert.equal(app.credentials.get('CUSTOM_OPENCODE_KEY'), 'new-9999')
    assert.equal(app.credentials.has(DEFAULT_KEY_REF), false)
    assert.deepEqual(app.updates, [])

    const cleared = await invoke(route, 'PUT', '/api/opencode-status/config', {
      baseUrl: DEFAULT_BASE_URL,
      clearApiKey: true,
    })
    assert.equal(cleared.status, 200)
    assert.equal(app.credentials.has('CUSTOM_OPENCODE_KEY'), false)
    assert.equal(cleared.body.status.mode, 'needs_config')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('非法 Base URL 与密钥冲突返回 400，非 GET/PUT/POST 方法返回 405', async () => {
  const app = harness({ credentials: { [DEFAULT_KEY_REF]: 'conflict-5555' } })
  const configRoute = app.routes.get('/api/opencode-status/config')
  const statusRoute = app.routes.get('/api/opencode-status')
  const syncRoute = app.routes.get('/api/opencode-status/sync')

  const invalid = await invoke(configRoute, 'PUT', '/api/opencode-status/config', { baseUrl: 'ftp://example.test/go' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'INVALID')

  const conflict = await invoke(configRoute, 'PUT', '/api/opencode-status/config', {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: 'both',
    clearApiKey: true,
  })
  assert.equal(conflict.status, 400)
  assert.equal(conflict.body.error.code, 'INVALID')

  assert.equal((await invoke(statusRoute, 'POST', '/api/opencode-status', {})).status, 405)
  assert.equal((await invoke(configRoute, 'DELETE', '/api/opencode-status/config')).status, 405)
  assert.equal((await invoke(syncRoute, 'GET', '/api/opencode-status/sync')).status, 405)
  assert.equal((await invoke(syncRoute, 'PUT', '/api/opencode-status/sync')).status, 405)
})

test('响应带 no-store，超过 64KB 的请求体返回 413', async () => {
  // 不配置密钥，避免状态读取触发真实网关请求。
  const app = harness()
  const status = await invoke(app.routes.get('/api/opencode-status'), 'GET', '/api/opencode-status')
  assert.equal(status.headers['cache-control'], 'no-store')
  assert.equal(status.body.mode, 'needs_config')

  const oversized = await invoke(app.routes.get('/api/opencode-status/config'), 'PUT', '/api/opencode-status/config', {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: 'x'.repeat(65 * 1024),
  })
  assert.equal(oversized.status, 413)
  assert.equal(oversized.body.error.message, '请求体过大')
})

test('OPENCODE_BASE_URL 成为未配置 profile 的 Config 默认值', () => {
  const read = (envValue) => {
    const script = `
      process.env.OPENCODE_BASE_URL = ${JSON.stringify(envValue)}
      const { Config } = await import('./src/index.js?env-default-test')
      process.stdout.write(Config.dict.baseUrl.meta.default)
    `
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: projectDir,
      encoding: 'utf8',
    })
  }

  const valid = read('https://env.example.test/go/')
  assert.equal(valid.status, 0, valid.stderr)
  assert.equal(valid.stdout, 'https://env.example.test/go')

  const invalid = read('ftp://env.example.test/go')
  assert.equal(invalid.status, 0, invalid.stderr)
  assert.equal(invalid.stdout, 'https://opencode.ai/zen/go')
})

test('请求体 JSON 解析失败返回 400 INVALID，64KB 上限仍为 413', async () => {
  const app = harness()
  const route = app.routes.get('/api/opencode-status/config')

  const malformed = await invoke(route, 'PUT', '/api/opencode-status/config', undefined, { rawBody: '{"baseUrl":' })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.body.error.code, 'INVALID')
  assert.match(malformed.body.error.message, /JSON/)

  const notAnObject = await invoke(route, 'PUT', '/api/opencode-status/config', [1, 2])
  assert.equal(notAnObject.status, 400)
  assert.equal(notAnObject.body.error.code, 'INVALID')

  const oversized = await invoke(route, 'PUT', '/api/opencode-status/config', undefined, {
    rawBody: 'x'.repeat(65 * 1024),
  })
  assert.equal(oversized.status, 413)
})

test('写请求跨源 Origin 返回 403，且不触碰凭据与配置', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => gatewayResponse()

  try {
    const app = harness({ config: { baseUrl: DEFAULT_BASE_URL } })
    const route = app.routes.get('/api/opencode-status/config')
    const syncRoute = app.routes.get('/api/opencode-status/sync')

    const crossOrigin = await invoke(route, 'PUT', '/api/opencode-status/config', {
      baseUrl: 'https://evil.example.test/go',
      apiKey: 'evil-key',
    }, {
      headers: { 'content-type': 'application/json', origin: 'http://evil.example.test', host: '127.0.0.1:3080' },
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal(crossOrigin.body.error.code, 'FORBIDDEN')
    assert.equal(app.credentials.has(DEFAULT_KEY_REF), false)
    assert.deepEqual(app.updates, [])
    assert.equal(app.readConfig().baseUrl, DEFAULT_BASE_URL)

    const crossOriginSync = await invoke(syncRoute, 'POST', '/api/opencode-status/sync', undefined, {
      headers: { 'content-type': 'application/json', origin: 'http://evil.example.test', host: '127.0.0.1:3080' },
    })
    assert.equal(crossOriginSync.status, 403)
    assert.equal(crossOriginSync.body.error.code, 'FORBIDDEN')

    // 同源（content-type 带 charset）放行。
    const sameOrigin = await invoke(route, 'PUT', '/api/opencode-status/config', {
      baseUrl: DEFAULT_BASE_URL,
      apiKey: 'same-origin-1234',
    }, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        origin: 'http://127.0.0.1:3080',
        host: '127.0.0.1:3080',
      },
    })
    assert.equal(sameOrigin.status, 200)
    assert.equal(app.credentials.get(DEFAULT_KEY_REF), 'same-origin-1234')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('写请求 content-type 非 application/json 返回 415，GET 与 405 分支不变', async () => {
  const app = harness({ credentials: { [DEFAULT_KEY_REF]: 'content-type-key' } })
  const configRoute = app.routes.get('/api/opencode-status/config')
  const syncRoute = app.routes.get('/api/opencode-status/sync')

  // 带可信 Host：判定必须落在 content-type 分支，而不是被来源 fence 提前拒绝。
  const plain = await invoke(configRoute, 'PUT', '/api/opencode-status/config', { baseUrl: DEFAULT_BASE_URL }, {
    headers: { 'content-type': 'text/plain', host: '127.0.0.1:3080' },
  })
  assert.equal(plain.status, 415)
  assert.equal(plain.body.error.code, 'UNSUPPORTED_MEDIA_TYPE')
  assert.equal(plain.body.error.message, '写请求必须使用 application/json')
  assert.equal(app.credentials.get(DEFAULT_KEY_REF), 'content-type-key')

  const missing = await invoke(configRoute, 'PUT', '/api/opencode-status/config', { baseUrl: DEFAULT_BASE_URL }, {
    headers: { host: '127.0.0.1:3080' },
  })
  assert.equal(missing.status, 415)
  assert.equal(missing.body.error.code, 'UNSUPPORTED_MEDIA_TYPE')

  const syncPlain = await invoke(syncRoute, 'POST', '/api/opencode-status/sync', undefined, {
    headers: { 'content-type': 'text/plain', host: '127.0.0.1:3080' },
  })
  assert.equal(syncPlain.status, 415)

  // GET 不做 content-type 校验（仍受来源 fence 保护）。
  const get = await invoke(configRoute, 'GET', '/api/opencode-status/config', undefined, {
    headers: { 'content-type': 'text/plain', host: '127.0.0.1:3080' },
  })
  assert.equal(get.status, 200)

  // 不被支持的写方法仍走 405。
  assert.equal((await invoke(configRoute, 'DELETE', '/api/opencode-status/config', undefined, { headers: {} })).status, 405)
  assert.equal((await invoke(syncRoute, 'PUT', '/api/opencode-status/sync', undefined, { headers: {} })).status, 405)
})

test('GET 路由同样做 Host/来源 fence，阻断 DNS rebinding 的读取路径', async () => {
  // 不配置密钥：needs_config 在发起上游请求前直接返回，不需要 stub fetch。
  const app = harness({ config: { baseUrl: DEFAULT_BASE_URL } })
  const statusRoute = app.routes.get('/api/opencode-status')
  const configRoute = app.routes.get('/api/opencode-status/config')

  const rebound = await invoke(statusRoute, 'GET', '/api/opencode-status', undefined, {
    headers: { host: 'evil.example.test:3080', origin: 'http://evil.example.test:3080' },
  })
  assert.equal(rebound.status, 403)
  assert.equal(rebound.body.error.code, 'FORBIDDEN')

  const reboundConfig = await invoke(configRoute, 'GET', '/api/opencode-status/config', undefined, {
    headers: { host: 'evil.example.test:3080' },
  })
  assert.equal(reboundConfig.status, 403)

  const noHost = await invoke(statusRoute, 'GET', '/api/opencode-status', undefined, { headers: {} })
  assert.equal(noHost.status, 403)

  const loopback = await invoke(configRoute, 'GET', '/api/opencode-status/config', undefined, {
    headers: { host: '127.0.0.1:3080' },
  })
  assert.equal(loopback.status, 200)
  assert.equal(loopback.body.apiKey.configured, false)
})

test('宿主提供 connection.isTrusted 时读与写都委托官方判定', async () => {
  const app = harness({ connection: { isTrusted: (req) => req.headers?.host === 'harness.internal:3080' } })
  const configRoute = app.routes.get('/api/opencode-status/config')

  // 官方判定拒绝的 Host 即便看起来像 loopback 也不放行。
  const rejectedRead = await invoke(configRoute, 'GET', '/api/opencode-status/config', undefined, {
    headers: { host: '127.0.0.1:3080' },
  })
  assert.equal(rejectedRead.status, 403)

  // 官方判定认可的 Host 即便不是 loopback 也放行。
  const allowedRead = await invoke(configRoute, 'GET', '/api/opencode-status/config', undefined, {
    headers: { host: 'harness.internal:3080' },
  })
  assert.equal(allowedRead.status, 200)

  const allowedWrite = await invoke(configRoute, 'PUT', '/api/opencode-status/config', { baseUrl: DEFAULT_BASE_URL }, {
    headers: { 'content-type': 'application/json', host: 'harness.internal:3080' },
  })
  assert.equal(allowedWrite.status, 200)
})

test('热改 baseUrl / keyRef 后缓存立即失效，下一次 GET 重新拉取', async () => {
  const originalFetch = globalThis.fetch
  let fetches = 0
  let lastUrl = null
  let lastAuth = null
  globalThis.fetch = async (url, init) => {
    fetches += 1
    lastUrl = String(url)
    lastAuth = init?.headers?.Authorization
    return gatewayResponse()
  }

  try {
    const app = harness({
      volatile: true,
      config: { baseUrl: 'https://before.example.test/go', keyRef: 'FIRST_KEY' },
      credentials: { FIRST_KEY: 'first-secret-1111', SECOND_KEY: 'second-secret-2222' },
    })
    const route = app.routes.get('/api/opencode-status')

    const first = await invoke(route, 'GET', '/api/opencode-status')
    assert.equal(first.status, 200)
    assert.equal(fetches, 1)
    assert.equal(lastUrl, 'https://before.example.test/go/v1/usage')

    // 同一配置仍命中 30s 缓存。
    const cached = await invoke(route, 'GET', '/api/opencode-status')
    assert.equal(cached.body.fetchedAt, first.body.fetchedAt)
    assert.equal(fetches, 1)

    // 模拟设置页热改 baseUrl：下一次 GET 立即重新拉取。
    app.setConfig({ baseUrl: 'https://after.example.test/go' })
    const afterBaseUrl = await invoke(route, 'GET', '/api/opencode-status')
    assert.equal(fetches, 2)
    assert.equal(lastUrl, 'https://after.example.test/go/v1/usage')
    assert.equal(afterBaseUrl.body.config.baseUrl, 'https://after.example.test/go')

    // 热改 keyRef 同样立即失效。
    app.setConfig({ keyRef: 'SECOND_KEY' })
    await invoke(route, 'GET', '/api/opencode-status')
    assert.equal(fetches, 3)
    assert.equal(lastAuth, 'Bearer second-secret-2222')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('package.json 声明 DSH 0.2.x 兼容范围与 0.2.2 版本', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, '0.2.2')
  assert.equal(manifest.engines.node, '>=20')
  // 上界写成 `<0.3.0-0`：0.3.0 的预发布版（0.3.0-rc.1 / rc.2）也因此 UNMET。
  // 该范围语义由宿主 app-boot 的 evaluatePluginCompatibility 验证：
  // 0.2.2-rc.1 → COMPATIBLE；0.3.0-rc.1 / 0.3.0-rc.2 / 0.3.0 → UNMET（见 CHANGELOG 0.2.1）。
  assert.equal(manifest.engines.dsh, '>=0.2.0 <0.3.0-0')
})

test('client 的强制刷新请求带 application/json 内容类型', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(text, /\/api\/opencode-status\/sync'[\s\S]{0,160}content-type': 'application\/json'/)
})

test('写请求 Host 白名单拒绝 DNS rebinding、缺失/非法 Host 与跨站请求', async () => {
  const app = harness({ config: { baseUrl: DEFAULT_BASE_URL }, connection: { trustedHosts: [] } })
  const route = app.routes.get('/api/opencode-status/config')
  const put = (body, headers) => invoke(route, 'PUT', '/api/opencode-status/config', body, { headers })

  // rebinding 形态：Origin 与 Host 同为攻击者域名，Origin 自洽也必须被 Host 白名单拒绝。
  const rebinding = await put(
    { baseUrl: 'https://evil.example.test/go', apiKey: 'rebind-key' },
    { 'content-type': 'application/json', host: 'evil.example.test', origin: 'http://evil.example.test' },
  )
  assert.equal(rebinding.status, 403)
  assert.equal(rebinding.body.error.code, 'FORBIDDEN')
  assert.equal(app.credentials.has(DEFAULT_KEY_REF), false)
  assert.deepEqual(app.updates, [])
  assert.equal(app.readConfig().baseUrl, DEFAULT_BASE_URL)

  const missingHost = await put({ baseUrl: DEFAULT_BASE_URL }, { 'content-type': 'application/json' })
  assert.equal(missingHost.status, 403)

  const unparsableHost = await put(
    { baseUrl: DEFAULT_BASE_URL },
    { 'content-type': 'application/json', host: 'bad host' },
  )
  assert.equal(unparsableHost.status, 403)

  const crossSite = await put(
    { baseUrl: DEFAULT_BASE_URL, apiKey: 'cross-site-key' },
    { 'content-type': 'application/json', host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
  )
  assert.equal(crossSite.status, 403)
  assert.equal(app.credentials.has(DEFAULT_KEY_REF), false)

  // 宿主提供官方 fence 时以它为准（connection.isTrusted === false 一律拒绝）。
  const delegated = harness({ config: { baseUrl: DEFAULT_BASE_URL }, connection: { isTrusted: () => false, trustedHosts: [] } })
  const denied = await invoke(
    delegated.routes.get('/api/opencode-status/config'),
    'PUT',
    '/api/opencode-status/config',
    { baseUrl: DEFAULT_BASE_URL },
    { headers: { 'content-type': 'application/json', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } },
  )
  assert.equal(denied.status, 403)
})

test('真实浏览器形态经 loopback、localhost、bind 地址与 trustedHosts 放行写请求', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => gatewayResponse()

  try {
    const put = (app, body, headers) => invoke(
      app.routes.get('/api/opencode-status/config'),
      'PUT',
      '/api/opencode-status/config',
      { baseUrl: DEFAULT_BASE_URL, ...body },
      { headers },
    )

    const loopback = harness({ config: { baseUrl: DEFAULT_BASE_URL } })
    const viaLoopback = await put(
      loopback,
      { apiKey: 'loopback-key' },
      { 'content-type': 'application/json', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    )
    assert.equal(viaLoopback.status, 200)
    assert.equal(loopback.credentials.get(DEFAULT_KEY_REF), 'loopback-key')

    const localhost = harness({ config: { baseUrl: DEFAULT_BASE_URL } })
    const viaLocalhost = await put(
      localhost,
      { apiKey: 'localhost-key' },
      { 'content-type': 'application/json', host: 'localhost:3080', origin: 'http://localhost:3080' },
    )
    assert.equal(viaLocalhost.status, 200)

    // 监听器绑定非 loopback 地址时，浏览器用 bind 地址访问同样放行。
    const bound = harness({ config: { baseUrl: DEFAULT_BASE_URL }, webServer: { host: '192.168.1.5' } })
    const viaBind = await put(
      bound,
      { apiKey: 'bind-key' },
      { 'content-type': 'application/json', host: '192.168.1.5:3080', origin: 'http://192.168.1.5:3080' },
    )
    assert.equal(viaBind.status, 200)
    assert.equal(bound.credentials.get(DEFAULT_KEY_REF), 'bind-key')

    // connection.trustedHosts 声明的部署域名。
    const trusted = harness({ config: { baseUrl: DEFAULT_BASE_URL }, connection: { trustedHosts: ['harness.internal'] } })
    const viaTrusted = await put(
      trusted,
      { apiKey: 'trusted-key' },
      { 'content-type': 'application/json', host: 'harness.internal:3080', origin: 'http://harness.internal:3080' },
    )
    assert.equal(viaTrusted.status, 200)

    // Host 的默认端口按 Origin 的 scheme 归一化：https://127.0.0.1 对应 Host 127.0.0.1:443。
    const tls = harness({ config: { baseUrl: DEFAULT_BASE_URL }, webServer: { protocol: 'https:' } })
    const viaDefaultPort = await put(
      tls,
      { apiKey: 'tls-key' },
      { 'content-type': 'application/json', host: '127.0.0.1:443', origin: 'https://127.0.0.1' },
    )
    assert.equal(viaDefaultPort.status, 200)
  } finally {
    globalThis.fetch = originalFetch
  }
})
