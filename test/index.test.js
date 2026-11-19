import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import test from 'node:test'
import vm from 'node:vm'

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

test('package.json 版本与 CHANGELOG 顶部一致，并保留 DSH 0.2.x 兼容范围', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  // 版本号不再钉死：以 package.json 为唯一事实源，要求 CHANGELOG 顶部标题跟随同一版本。
  const changelogVersion = /^# Changelog\n\n## ([^\s]+)\n/.exec(changelog)?.[1] ?? null
  assert.equal(changelogVersion, manifest.version)
  // 仍是合法的三段式 semver，避免版本字段被写成空串或非法值也能过。
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.engines.node, '>=20')
  // DSH 兼容上界与插件自身版本无关，必须保持显式钉死（`<0.3.0-0` 让 0.3.0 的预发布版同样 UNMET）。
  // 该范围语义由宿主 app-boot 的 evaluatePluginCompatibility 验证：
  // 0.2.2-rc.1 → COMPATIBLE；0.3.0-rc.1 / 0.3.0-rc.2 / 0.3.0 → UNMET（见 CHANGELOG 0.2.1）。
  assert.equal(manifest.engines.dsh, '>=0.2.0 <0.3.0-0')
})

test('CHANGELOG 顶部是当前发布版本，README 描述新的点击/刷新/设置/悬浮行为', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // 用 package.json 的实际版本拼正则，避免每次发版再钉死；点号等正则元字符做转义。
  const escapedVersion = manifest.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.match(changelog, new RegExp('^# Changelog\\n\\n## ' + escapedVersion + '\\n'))
  assert.match(changelog, /用量面板/)
  assert.match(changelog, /刷新/)

  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /用量面板/)
  assert.match(readme, /点击/)
  assert.match(readme, /刷新/)
  assert.match(readme, /设置/)
  assert.match(readme, /悬浮/)
  assert.match(readme, /剩余/)
})

test('客户端默认视图为用量，设置是独立视图且不再使用已废弃的 editing 标记', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  // store 用 view: 'status' | 'settings' 表达面板视图
  assert.match(text, /view: 'status'/)
  assert.match(text, /view: 'settings'/)
  assert.doesNotMatch(text, /editing/)
  // 点击常驻按钮 → toggleOverlay → openOverlay 重置到用量视图
  assert.match(text, /onClick: toggleOverlay/)
  assert.match(text, /function openOverlay\(\)[\s\S]{0,200}open: true, view: 'status'/)
  // 设置入口独立，且未配置时直接显示设置视图
  assert.match(text, /onClick: openSettings/)
  assert.match(text, /store\.set\(\{ view: 'settings' \}\)/)
  assert.match(text, /state\.view === 'settings' \|\| st\?\.mode === 'needs_config'/)
})

test('底部操作条「刷新」调用 sync 且带 JSON 内容类型，展示上次同步时间与错误文案', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  // 手动刷新走 POST /api/opencode-status/sync，并显式声明 JSON 内容类型
  assert.match(text, /\/api\/opencode-status\/sync'[\s\S]{0,160}content-type': 'application\/json'/)
  assert.match(text, /method: 'POST'/)
  assert.match(text, /onClick: manualRefresh/)
  // 刷新期间禁用按钮并显示旋转 + 「刷新中…」
  assert.match(text, /disabled: state\.refreshing/)
  assert.match(text, /'刷新中…'/)
  assert.match(text, /className: state\.refreshing \? 'oc-spin' : undefined/)
  // 上次同步显示相对时间，绝对时刻放 title（HH:MM:SS）
  assert.match(text, /const lastSync = st\?\.fetchedAt \? fmtRelative\(st\.fetchedAt\) : null/)
  assert.match(text, /上次同步 \$\{lastSync\}/)
  assert.match(text, /pad\(d\.getHours\(\)\)/)
  // 失败时在面板内显示错误文案，而不是静默
  assert.match(text, /刷新失败：\$\{state\.error\}/)
})

test('设置视图可保存回用量视图、「取消」丢弃编辑并关闭面板', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(text, /保存并连接/)
  assert.match(text, /store\.set\(\{ status: result\.status, config: result\.config, view: 'status', error: null \}\)/)
  assert.match(text, /onClick: cancel/)
  assert.match(text, /function cancel\(\)/)
  assert.match(text, /store\.set\(\{ open: false, view: 'status' \}\)/)
  assert.match(text, /'← 返回用量'/)
})

test('三个窗口行给出剩余主百分比、降级已用、倒计时与按剩余阈值着色的进度条', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const quotaRow = text.slice(text.indexOf('function QuotaRow'), text.indexOf('// ---------- 连接设置视图'))
  // 行内只保留「剩余」一个主百分比；「已用」降级到 title 与 aria-valuetext，避免同行重复表达
  assert.match(quotaRow, /已用 \$\{pctText\(used\)\}/)
  assert.match(quotaRow, /剩余 \$\{pctText\(remaining\)\}/)
  assert.match(quotaRow, /timeUntil\(w\.resetAt\)/)
  assert.match(quotaRow, /clampPct\(remaining\)/)
  assert.match(quotaRow, /remainingColor\(remaining\)/)
  // 窗口 status 非 ok 时有可见提示
  assert.match(quotaRow, /窗口状态异常：/)
  // 阈值语义：>50 正常、>20 警告、其余错误（与 cpa 的 QuotaBar 一致）
  assert.match(text, /if \(remaining > 50\) return T\.ok/)
  assert.match(text, /if \(remaining > 20\) return T\.warn/)
  // 不编造金额余额，只用剩余额度/百分比表述（源码不含 $10 / ¥10 这类货币金额）
  assert.doesNotMatch(text, /[\$¥€]\s?\d/)
})

test('面板可 Esc 关闭、具备 dialog 语义与焦点归还，进度条暴露 progressbar ARIA（P0）', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const panel = text.slice(text.indexOf('function OverlayPanel'), text.indexOf('// ---------- 注册'))

  // Esc 关闭：keydown 监听以 state.open 为门，随面板打开注册、关闭卸载
  assert.match(panel, /if \(!state\.open\) return[\s\S]{0,200}e\.key === 'Escape'/)
  assert.match(panel, /window\.addEventListener\('keydown', handleKeyDown\)/)
  assert.match(panel, /return \(\) => window\.removeEventListener\('keydown', handleKeyDown\)/)
  // 非模态对话框：role + aria-label，但不声明 aria-modal（允许点击外部关闭，外部内容仍可交互）
  assert.match(panel, /role: 'dialog'/)
  assert.match(panel, /'aria-label': settingsView \? 'OpenCode GO 连接配置' : 'OpenCode GO 用量'/)
  assert.doesNotMatch(panel, /'aria-modal'/)
  // 打开时焦点移入面板（容器 tabIndex=-1），关闭时归还触发元素。
  // 运行时复现由 /tmp/verify-focus.mjs 手工验证（真实 React 18.3.1 + jsdom），CI 无 jsdom 依赖，这里只固化关键结构：
  // deps 必须同时包含 state.open 与 phase，且 phase 未到 'open' 时早退——否则面板 DOM 尚未挂载时
  // panelRef.current 为 null，panel.focus() 静默失效。
  assert.match(panel, /\}, \[state\.open, phase\]\)/)
  assert.match(panel, /if \(!state\.open \|\| phase !== 'open'\) return/)
  assert.match(panel, /tabIndex: -1/)
  assert.match(panel, /if \(panel && typeof panel\.focus === 'function'\) panel\.focus\(\)/)
  assert.match(panel, /previous\.focus\(\)/)
  // 点击外部关闭时不抢走用户刚点中的控件焦点；cleanup 用当前 panelRef.current 判断（打开时捕获的 panel 可能为 null）
  assert.match(panel, /const current = panelRef\.current/)
  assert.match(panel, /current\.contains\(active\)/)
  // Tab 在面板内首尾循环，不立即逃到背后的不可见区域
  assert.match(panel, /e\.key !== 'Tab'/)
  assert.match(panel, /FOCUSABLE/)

  const quotaRow = text.slice(text.indexOf('function QuotaRow'), text.indexOf('// ---------- 连接设置视图'))
  // 进度条语义：role + valuemin/max/now + 可读文本；剩余缺失时不给 valuenow
  assert.match(quotaRow, /role: 'progressbar'/)
  assert.match(quotaRow, /'aria-valuemin': 0/)
  assert.match(quotaRow, /'aria-valuemax': 100/)
  assert.match(quotaRow, /'aria-valuenow': Math\.round\(clampPct\(remaining\)\)/)
  assert.match(quotaRow, /'aria-valuetext'/)
  assert.match(quotaRow, /remaining === null \? '数据不可用' :/)
  // 低额度除颜色外有文字档位（阈值与 remainingColor 一致）
  const band = text.slice(text.indexOf('function remainingBand'), text.indexOf('function fmtRelative'))
  assert.match(band, /if \(remaining <= 20\) return '即将耗尽'/)
  assert.match(band, /if \(remaining <= 50\) return '偏低'/)
  assert.match(quotaRow, /⚠ \$\{band\}/)
})

test('面板宽度自适应窄视口，390px 下不横向溢出（P0）', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(text, /width: 'min\(360px, calc\(100vw - 24px\)\)'/)
  assert.match(text, /maxWidth: 'calc\(100vw - 24px\)'/)
  assert.match(text, /boxSizing: 'border-box'/)
  assert.doesNotMatch(text, /width: 360,/)
})

test('P1 信息设计：相对时间/过期提示、单一主百分比、免责说明移入设置、倒计时与呼吸动画一次性', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

  // 相对时间 + 绝对时间 title + 超过 2 分钟的弱过期提示
  assert.match(text, /function fmtRelative\(ts, now = Date\.now\(\)\)/)
  assert.match(text, /const STALE_AFTER_MS = 2 \* 60_000/)
  assert.match(text, /title: lastSyncTitle/)
  assert.match(text, /上次同步 \$\{lastSync\}\$\{lastSyncStale \? ' · 可能已过期' : ''\}/)
  assert.match(text, /const lastSyncTitle = st\?\.fetchedAt \? `上次同步 \$\{fmtClock\(st\.fetchedAt\)\}` : '尚未同步'/)

  // 头部给判断性摘要，不再与月窗口行重复「月剩余 N%」
  const statusView = text.slice(text.indexOf('function StatusView'), text.indexOf('function QuotaRow'))
  // 头部用 label 而不是 shortLabel：shortLabel 是 220px 悬浮卡的紧凑缩写，复用会把英文漏进主面板
  assert.match(statusView, /最紧张 \$\{tightest\.label \?\? tightest\.id \?\? '—'\}/)
  assert.doesNotMatch(statusView, /tightest\.shortLabel/)
  assert.doesNotMatch(statusView, /月剩余/)
  assert.doesNotMatch(statusView, /hostOf\(/)
  // host 只在面板标题行展示一次
  assert.match(text, /hostOf\(st\.config\.baseUrl\)/)

  // 窗口行只保留一个可见主百分比，「已用」降级到 title/aria
  const quotaRow = text.slice(text.indexOf('function QuotaRow'), text.indexOf('// ---------- 连接设置视图'))
  const meta = quotaRow.slice(quotaRow.indexOf("key: 'meta'"), quotaRow.indexOf("key: 'track'"))
  assert.match(meta, /剩余 \$\{pctText\(remaining\)\}/)
  assert.doesNotMatch(meta, /已用/)
  assert.match(quotaRow, /已用 \$\{pctText\(used\)\} · 剩余 \$\{pctText\(remaining\)\}/)
  // 代码注释说明条-文字语义
  assert.match(text, /条长 = 剩余额度占比/)

  // 免责说明不再常驻用量视图，移入设置视图
  assert.doesNotMatch(statusView, /上游 \/v1\/usage/)
  const configCard = text.slice(text.indexOf('function ConfigCard'), text.indexOf('// ---------- 固定底部操作条'))
  assert.match(configCard, /上游 \/v1\/usage 仅提供百分比额度，界面不展示金额余额。/)
  // 设置视图与用量视图都按需保留免责说明以外的内容

  // 倒计时不再复用刷新用的 ↻
  assert.doesNotMatch(quotaRow, /`↻/)
  assert.match(quotaRow, /⏱ \$\{timeUntil\(w\.resetAt\)\}/)
  const miniRow = text.slice(text.indexOf('function MiniQuotaRow'), text.indexOf('// ---------- 用量视图'))
  assert.doesNotMatch(miniRow, /`↻/)
  assert.match(miniRow, /⏱ \$\{timeUntil\(w\.resetAt\)\}/)

  // 呼吸动画只播一次，不再无限循环
  assert.match(text, /\.oc-dot-live \{ animation: ocPulse 1\.2s ease-out 1 both \}/)
  assert.doesNotMatch(text, /oc-dot-live \{ animation: ocPulse[^}]*infinite/)
})

/** 构建带可控定时器 / 可见性事件 / document 事件的插件运行时，用于验证模块级轮询。 */
function loadPollingRuntime(options = {}) {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const state = { open: false, view: 'status', status: null, config: null, refreshing: false, error: null }
  const intervals = new Map()
  const cleared = []
  const listeners = new Map()
  const fetches = []
  const effects = []
  const effectCleanups = []
  let nextTimer = 1
  let plugin = null
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null) }),
    useEffect: (fn) => effects.push(fn),
    useState: (value) => [value, () => {}],
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: () => state,
  }
  const documentMock = {
    hidden: false,
    createElement: () => ({ remove() {} }),
    head: { appendChild() {} },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => listeners.delete(type),
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition) => {
          plugin = definition.factory((name) => {
            if (name === 'react') return React
            throw new Error(`unexpected require: ${name}`)
          })
        },
      },
    },
    document: documentMock,
    fetch: async (url) => {
      fetches.push(String(url))
      return options.fetch ? options.fetch(String(url)) : { ok: true, json: async () => ({}) }
    },
    setInterval: (fn, ms) => {
      const id = nextTimer++
      intervals.set(id, { fn, ms })
      return id
    },
    clearInterval: (id) => {
      cleared.push(id)
      intervals.delete(id)
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    // 可选注入 localStorage（账号隔离的真实路径用例用）；默认不注入。
    ...(options.localStorage ? { localStorage: options.localStorage } : {}),
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  const registered = []
  const slots = {
    inject: (name, factory) => factory(),
    register: (meta, component) => {
      registered.push(component)
      return () => {}
    },
  }
  /** 执行一次 apply：保存 ctx.effect 注册的 cleanup，供「插件 dispose」用例真正触发。 */
  const applyPlugin = () => {
    plugin.apply({
      effect: (factory) => {
        const cleanup = factory()
        if (typeof cleanup === 'function') effectCleanups.push(cleanup)
        return cleanup
      },
      slots,
    })
  }
  applyPlugin()
  /** 最小函数组件渲染器：真正执行组件函数体，useEffect 才会被收集（否则卸载断言会空跑）。 */
  const render = (element) => {
    if (element == null || element === false || typeof element !== 'object') return element
    if (Array.isArray(element)) return element.map(render)
    if (typeof element.type === 'function') return render(element.type(element.props))
    return { ...element, children: element.children.map(render) }
  }
  /** 执行组件挂载时收集到的 effect，返回 cleanup 列表。 */
  const runComponentEffects = () => {
    const pending = effects.splice(0)
    return pending.map((fn) => fn())
  }
  /** 执行 apply 注册的全部 cleanup，模拟插件 dispose / HMR 卸载。 */
  const disposePlugin = () => {
    for (const cleanup of effectCleanups.splice(0).reverse()) cleanup()
  }
  return { plugin, state, document: documentMock, intervals, cleared, listeners, fetches, registered, render, runComponentEffects, disposePlugin, applyPlugin }
}

test('轮询：模块级幂等 ticker，组件卸载不停摆、插件 dispose 释放，恢复可见立即补拉（P0/F1/F3）', async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const app = loadPollingRuntime()
  // apply 即安装唯一 ticker（30s）并立即补拉一次
  assert.equal(app.intervals.size, 1)
  assert.equal([...app.intervals.values()][0].ms, 30_000)
  assert.equal(app.listeners.size, 1)
  await flush()
  assert.equal(app.fetches.length, 1)

  // 真正渲染 footer（执行组件函数体与 useEffect）：effect 再 ensure 一次是幂等的，不新开 ticker、不重复发请求
  app.render(app.registered[0]({ wide: true }))
  const componentCleanups = app.runComponentEffects()
  assert.ok(componentCleanups.length >= 2, 'footer effect 必须真的执行到（防止卸载断言空跑）')
  assert.equal(app.intervals.size, 1)
  assert.equal(app.fetches.length, 1)
  // 组件卸载：cleanup 不得拆除模块级 ticker（旧实现正是在这里停掉采样）
  for (const cleanup of componentCleanups) if (typeof cleanup === 'function') cleanup()
  assert.equal(app.intervals.size, 1)
  assert.equal(app.listeners.size, 1)
  assert.equal(app.cleared.length, 0)

  // 页面隐藏：不再 clearInterval（交给浏览器节流），也不立即补拉
  app.document.hidden = true
  app.listeners.get('visibilitychange')()
  await flush()
  assert.equal(app.intervals.size, 1)
  assert.equal(app.cleared.length, 0)
  assert.equal(app.fetches.length, 1)

  // 恢复可见：立即补拉一次，复用原 ticker
  app.document.hidden = false
  app.listeners.get('visibilitychange')()
  await flush()
  assert.equal(app.intervals.size, 1)
  assert.equal(app.cleared.length, 0)
  assert.equal(app.fetches.length, 2)

  // ticker 到点仍会继续采样
  ;[...app.intervals.values()][0].fn()
  await flush()
  assert.equal(app.fetches.length, 3)

  // 重复 ensure（重新挂载）仍然只有一个 ticker、一个可见性监听
  app.plugin.__internal.ensureStatusPolling()
  app.plugin.__internal.ensureStatusPolling()
  assert.equal(app.intervals.size, 1)
  assert.equal(app.listeners.size, 1)
  assert.equal(app.cleared.length, 0)

  // 插件 dispose / HMR 卸载：timer 与 visibilitychange 监听必须随 ctx.effect cleanup 释放
  const timerId = [...app.intervals.keys()][0]
  app.disposePlugin()
  assert.equal(app.intervals.size, 0, 'dispose 后不得遗留 ticker')
  assert.equal(app.cleared.includes(timerId), true, 'dispose 必须 clearInterval 掉本插件安装的 ticker')
  assert.equal(app.listeners.size, 0, 'dispose 后不得遗留 visibilitychange 监听')
  // 监听已移除：再触发可见性事件不会补拉
  app.document.hidden = false
  assert.equal(app.fetches.length, 3)

  // HMR 重新 apply：新旧不会并存，只安装一个 ticker
  app.applyPlugin()
  assert.equal(app.intervals.size, 1)
  assert.equal(app.listeners.size, 1)

  // 幂等 disposer：多次 ensure 返回同一个函数引用，重复调用只清理一次
  const disposeA = app.plugin.__internal.ensureStatusPolling()
  const disposeB = app.plugin.__internal.ensureStatusPolling()
  assert.equal(disposeA, disposeB, 'ensureStatusPolling 必须返回同一个 disposer')
  disposeA()
  disposeA()
  assert.equal(app.intervals.size, 0)
  assert.equal(app.listeners.size, 0)
})

test('上游小数与越界百分比被取整并钳制到 0–100（P0）', async () => {
  const originalFetch = globalThis.fetch
  const app = harness({ credentials: { [DEFAULT_KEY_REF]: 'pct-key-1234' } })
  const route = app.routes.get('/api/opencode-status')
  const usage = (percent) => new Response(JSON.stringify({ usage: { rolling: { percent }, weekly: { percent }, monthly: { percent } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  try {
    globalThis.fetch = async () => usage(12.7)
    const rounded = await invoke(route, 'GET', '/api/opencode-status?force=1')
    assert.equal(rounded.body.windows[0].usedPct, 13)
    assert.equal(rounded.body.windows[0].remainingPct, 87)
    assert.equal(rounded.body.monthlyUsedPct, 13)

    // x.5 边界：先取整 used 再用 100 - used 派生 remaining，两者之和必须恒为 100（旧实现 12.5→13/88）
    globalThis.fetch = async () => usage(12.5)
    const half = await invoke(route, 'GET', '/api/opencode-status?force=1')
    assert.equal(half.body.windows[0].usedPct, 13)
    assert.equal(half.body.windows[0].remainingPct, 87)
    for (const w of half.body.windows) {
      assert.equal(w.usedPct + w.remainingPct, 100)
    }

    globalThis.fetch = async () => usage(150)
    const over = await invoke(route, 'GET', '/api/opencode-status?force=1')
    assert.equal(over.body.windows[0].usedPct, 100)
    assert.equal(over.body.windows[0].remainingPct, 0)

    globalThis.fetch = async () => usage(-30)
    const under = await invoke(route, 'GET', '/api/opencode-status?force=1')
    assert.equal(under.body.windows[0].usedPct, 0)
    assert.equal(under.body.windows[0].remainingPct, 100)

    // 所有窗口的百分比都必须是 0–100 的整数
    for (const w of rounded.body.windows) {
      for (const value of [w.usedPct, w.remainingPct]) {
        assert.equal(Number.isInteger(value), true)
        assert.equal(value >= 0 && value <= 100, true)
      }
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GATEWAY_ERROR 不前移「上次同步」：沿用最后一次成功时间，从未成功则为 null', async () => {
  const originalFetch = globalThis.fetch

  try {
    const app = harness({ credentials: { [DEFAULT_KEY_REF]: 'stale-time-1234' } })
    const route = app.routes.get('/api/opencode-status')

    globalThis.fetch = async () => gatewayResponse()
    const ready = await invoke(route, 'GET', '/api/opencode-status?force=1')
    assert.equal(ready.body.ok, true)

    globalThis.fetch = async () => new Response('gateway down', { status: 503 })
    const failed = await invoke(route, 'GET', '/api/opencode-status?force=1')
    assert.equal(failed.body.ok, false)
    assert.equal(failed.body.error.code, 'GATEWAY_ERROR')
    assert.equal(failed.body.fetchedAt, ready.body.fetchedAt)

    // 从未成功过：fetchedAt 为 null，界面据此显示「尚未同步」而不是一个假的同步时刻
    const fresh = harness({ credentials: { [DEFAULT_KEY_REF]: 'never-ok-1234' } })
    const never = await invoke(fresh.routes.get('/api/opencode-status'), 'GET', '/api/opencode-status')
    assert.equal(never.body.error.code, 'GATEWAY_ERROR')
    assert.equal(never.body.fetchedAt, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('侧栏按钮按月剩余着色，rail 模式渲染真正的 button 并打开用量视图', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  // 文案体现月剩余摘要，颜色取剩余额度阈值
  assert.match(text, /月剩余 \$\{monthlyRemaining\}%/)
  assert.match(text, /color = monthlyRemaining === null \? T\.warn : remainingColor\(monthlyRemaining\)/)
  // rail 模式（wide === false）是真 button，不是 div
  const rail = text.slice(text.indexOf('if (props?.wide === false)'), text.indexOf('const segments ='))
  assert.match(rail, /h\(\s*'button'/)
  assert.match(rail, /onClick: toggleOverlay/)
  assert.doesNotMatch(rail, /h\(\s*'div'/)
  assert.match(rail, /monthlyRemaining !== null \? `\$\{monthlyRemaining\}%` : 'GO'/)
})

test('client 工厂可在最小 React stub 下加载，注册两个槽位且 rail 模式渲染真 button', () => {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect: () => {},
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }
  let plugin = null
  const registered = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition) => {
          plugin = definition.factory((name) => {
            if (name === 'react') return React
            throw new Error(`unexpected require: ${name}`)
          })
        },
      },
    },
    document: { createElement: () => ({ remove() {} }), head: { appendChild() {} } },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  assert.deepEqual([...plugin.inject], ['slots'])
  plugin.apply({
    effect: (factory) => factory(),
    slots: {
      inject: (name, factory) => factory(),
      register: (meta, component) => {
        registered.push({ meta, component })
        return () => {}
      },
    },
  })
  assert.deepEqual(registered.map((r) => r.meta.name), ['sidebar.footer.action', 'shell.overlay'])
  assert.deepEqual(registered.map((r) => r.meta.id), ['opencode-status', 'opencode-status-panel'])

  // rail 模式必须渲染为真正的 button，并且点击处理函数存在
  const element = registered[0].component({ wide: false })
  const rail = element.type(element.props)
  assert.equal(rail.type, 'button')
  assert.equal(typeof rail.props.onClick, 'function')
})

test('220ms 悬浮卡展示标题 + Go 标识 + 上次同步与三窗口紧凑行，且不拦截点击', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const card = text.slice(text.indexOf('function HoverCard'), text.indexOf('/** 悬浮卡紧凑行'))
  assert.match(card, /OpenCode GO 用量/)
  assert.match(card, /'GO'/)
  assert.match(card, /上次同步 \$\{fmtClock\(st\.fetchedAt\)\}/)
  assert.match(card, /MiniQuotaRow/)
  assert.match(card, /点击查看详情/)
  // 只读卡片：没有假按钮，且不接收指针事件，不遮挡 footer 按钮
  assert.doesNotMatch(card, /h\('button'/)
  assert.match(card, /pointerEvents: 'none'/)

  // 220ms 延迟、面板关闭且 ready+ok 时才渲染
  assert.match(text, /setTimeout\(\(\) => setHovering\(true\), 220\)/)
  assert.match(text, /if \(!hovering \|\| state\.open \|\| st\?\.mode !== 'ready' \|\| !st\.ok\) return node/)
  // 保留 30 秒 GET 自动刷新；打开面板走缓存，不额外探测上游
  assert.match(text, /setInterval\(\(\) => refreshStatus\(\), 30_000\)/)
  assert.match(text, /GET 命中 30 秒缓存，不触发额外上游探测/)
})

test('手动刷新推进请求序号，更早的在途 GET 响应不再覆盖状态（F2）', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  // 模块级请求序号
  assert.match(text, /let statusEpoch = 0/)
  const refresh = text.slice(text.indexOf('let statusInFlight'), text.indexOf('async function refreshConfig'))
  assert.match(refresh, /const epoch = statusEpoch/)
  // 成功与失败两条路径都只接受最新 epoch 的响应
  assert.match(refresh, /if \(epoch === statusEpoch\) \{[\s\S]{0,160}recordSamples\(status\)[\s\S]{0,160}store\.set\(\{ status, error: null \}\)/)
  assert.match(refresh, /if \(epoch === statusEpoch\) store\.set\(\{ error:/)
  // 手动刷新发起时先推进序号，自身响应仍直接落库
  const manual = text.slice(text.indexOf('async function manualRefresh'), text.indexOf('function openOverlay'))
  assert.match(manual, /statusEpoch \+= 1[\s\S]{0,240}api\('\/api\/opencode-status\/sync'/)
  // 手动刷新同样先采样再落库，估算才能用到最新一次样本
  assert.match(manual, /recordSamples\(status\)[\s\S]{0,80}store\.set\(\{ status, error: null \}\)/)
  assert.match(manual, /store\.set\(\{ status, error: null \}\)/)
  // 30s 轮询行为保持不变
  assert.match(text, /setInterval\(\(\) => refreshStatus\(\), 30_000\)/)
})

test('运行时验证：手动刷新后更早的 GET 成功/失败响应都被丢弃（F2）', async () => {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

  const createRuntime = () => {
    const calls = []
    const fetchImpl = (url, init) => {
      let resolve
      let reject
      const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
      })
      calls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? null, resolve, reject })
      return promise
    }
    const React = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null) }),
      // 立即执行 effect 模拟挂载；OverlayPanel 的 'closed' 相位放行到 'open'。
      useEffect: (fn) => fn(),
      useState: (value) => [value === 'closed' ? 'open' : value, () => {}],
      useRef: (value) => ({ current: value }),
      useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    }
    let plugin = null
    const registered = []
    const sandbox = {
      window: {
        __ModuleLoader__: {
          load: (definition) => {
            plugin = definition.factory((name) => {
              if (name === 'react') return React
              throw new Error(`unexpected require: ${name}`)
            })
          },
        },
      },
      document: { createElement: () => ({ remove() {} }), head: { appendChild() {} } },
      fetch: fetchImpl,
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    }
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox, { filename: 'client.js' })
    plugin.apply({
      effect: (factory) => factory(),
      slots: {
        inject: (name, factory) => factory(),
        register: (meta, component) => {
          registered.push(component)
          return () => {}
        },
      },
    })
    return { calls, registered }
  }

  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  const collect = (node, out = []) => {
    if (node == null || node === false) return out
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node))
      return out
    }
    if (Array.isArray(node)) {
      node.forEach((n) => collect(n, out))
      return out
    }
    if (typeof node.type === 'function') {
      collect(node.type(node.props), out)
      return out
    }
    // aria-valuetext / title 是读屏与悬停可见的信息，和文本一起参与断言
    for (const key of ['aria-valuetext', 'title']) {
      if (typeof node.props?.[key] === 'string') out.push(node.props[key])
    }
    node.children.forEach((n) => collect(n, out))
    return out
  }

  const findButton = (node, label) => {
    if (node == null || node === false) return null
    if (typeof node === 'string' || typeof node === 'number') return null
    if (Array.isArray(node)) {
      for (const n of node) {
        const hit = findButton(n, label)
        if (hit) return hit
      }
      return null
    }
    if (typeof node.type === 'function') return findButton(node.type(node.props), label)
    if (node.type === 'button' && collect(node.children).join('').includes(label)) return node
    for (const n of node.children) {
      const hit = findButton(n, label)
      if (hit) return hit
    }
    return null
  }

  const fresh = {
    ok: true,
    mode: 'ready',
    fetchedAt: 2_000,
    config: { baseUrl: 'https://fresh.example.test/go' },
    monthlyUsedPct: 10,
    windows: [{ id: 'monthly', label: '月窗口', shortLabel: 'Monthly', usedPct: 10, remainingPct: 90, status: 'ok', resetAt: null }],
  }
  const stale = {
    ok: true,
    mode: 'ready',
    fetchedAt: 1_000,
    config: { baseUrl: 'https://stale.example.test/go' },
    monthlyUsedPct: 90,
    windows: [{ id: 'monthly', label: '月窗口', shortLabel: 'Monthly', usedPct: 90, remainingPct: 10, status: 'ok', resetAt: null }],
  }

  // 成功路径：POST 先返回，旧 GET 后返回 → 旧数据必须被丢弃
  const app = createRuntime()
  collect(app.registered[0]({ wide: true })) // 挂载 footer，触发初始 GET
  await flush()
  const oldGet = app.calls[0]
  assert.equal(oldGet.method, 'GET')
  const refreshButton = findButton(app.registered[1](), '刷新')
  assert.equal(typeof refreshButton?.props?.onClick, 'function')
  refreshButton.props.onClick()
  await flush()
  const post = app.calls.find((call) => call.method === 'POST')
  assert.equal(post.headers['content-type'], 'application/json')
  post.resolve({ ok: true, json: async () => fresh })
  await flush()
  oldGet.resolve({ ok: true, json: async () => stale })
  await flush()
  const panelText = collect(app.registered[1]()).join('|')
  // 新语义：头部给「最紧张窗口」摘要，窗口行只留剩余主百分比，已用降级到 aria/title
  assert.match(panelText, /最紧张 月窗口/)
  // 摘要不再重复窗口行已有的数字：百分比只在该窗口行出现一次
  assert.doesNotMatch(panelText, /最紧张 月窗口 90%/)
  assert.match(panelText, /剩余 90%/)
  assert.match(panelText, /已用 10%/)
  assert.doesNotMatch(panelText, /剩余 10%|已用 90%/)

  // 失败路径：POST 先返回，旧 GET 随后失败 → 不能覆盖状态也不能写入错误
  const app2 = createRuntime()
  collect(app2.registered[0]({ wide: true }))
  await flush()
  const oldGet2 = app2.calls[0]
  const refreshButton2 = findButton(app2.registered[1](), '刷新')
  refreshButton2.props.onClick()
  await flush()
  app2.calls.find((call) => call.method === 'POST').resolve({ ok: true, json: async () => fresh })
  await flush()
  oldGet2.reject(new Error('stale GET failed'))
  await flush()
  const panelText2 = collect(app2.registered[1]()).join('|')
  assert.match(panelText2, /最紧张 月窗口/)
  assert.doesNotMatch(panelText2, /刷新失败/)
})

test('设置视图在 status 未加载时仍保留「← 返回用量」，仅 needs_config 隐藏（F3）', () => {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

  const render = (state) => {
    const React = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null) }),
      useEffect: () => {},
      // OverlayPanel 以 'closed' 初始化 phase；这里直接放行到 'open' 渲染
      useState: (value) => [value === 'closed' ? 'open' : value, () => {}],
      useRef: (value) => ({ current: value }),
      useSyncExternalStore: () => state,
    }
    let plugin = null
    const registered = []
    const sandbox = {
      window: {
        __ModuleLoader__: {
          load: (definition) => {
            plugin = definition.factory((name) => {
              if (name === 'react') return React
              throw new Error(`unexpected require: ${name}`)
            })
          },
        },
      },
      document: { createElement: () => ({ remove() {} }), head: { appendChild() {} } },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    }
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox, { filename: 'client.js' })
    plugin.apply({
      effect: (factory) => factory(),
      slots: {
        inject: (name, factory) => factory(),
        register: (meta, component) => {
          registered.push(component)
          return () => {}
        },
      },
    })

    const texts = []
    const walk = (node) => {
      if (node == null || node === false) return
      if (typeof node === 'string' || typeof node === 'number') {
        texts.push(String(node))
        return
      }
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      if (typeof node.type === 'function') {
        walk(node.type(node.props))
        return
      }
      node.children.forEach(walk)
    }
    walk(registered[1]())
    return texts.join('|')
  }

  // status 尚未加载（null）就切到设置视图：返回入口必须可见
  const loading = render({ open: true, view: 'settings', status: null, config: null, refreshing: false, error: null })
  assert.match(loading, /⚙ OpenCode GO 连接配置/)
  assert.match(loading, /← 返回用量/)

  // needs_config：没有可返回的用量数据，隐藏返回入口
  const needsConfig = render({
    open: true,
    view: 'status',
    status: {
      ok: false,
      mode: 'needs_config',
      fetchedAt: 1,
      windows: [],
      config: { baseUrl: 'https://opencode.ai/zen/go', hasKey: false },
      error: { code: 'NOT_CONFIGURED', message: '需要配置 OpenCode API Key' },
    },
    config: { baseUrl: 'https://opencode.ai/zen/go', apiKey: { configured: false, writable: true, hint: null } },
    refreshing: false,
    error: null,
  })
  assert.match(needsConfig, /⚙ OpenCode GO 连接配置/)
  assert.doesNotMatch(needsConfig, /← 返回用量/)
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

// ---------- 消耗速率估算（t10）：纯函数 + 采样状态，全部用真实运行时断言 ----------

/** 加载 client.js 到 vm 沙箱，返回插件导出（含 __internal 中的估算/采样函数）。 */
function loadClientForUnit(extraGlobals = {}) {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null) }),
    useEffect: () => {},
    useState: (value) => [value, () => {}],
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }
  let plugin = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition) => {
          plugin = definition.factory((name) => {
            if (name === 'react') return React
            throw new Error(`unexpected require: ${name}`)
          })
        },
      },
    },
    document: { createElement: () => ({ remove() {} }), head: { appendChild() {} } },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    // 可选注入 localStorage 等额外全局（持久化用例用）；默认不注入，覆盖沙箱无存储的降级路径。
    ...extraGlobals,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  return plugin
}

/** 用「注入的 state」渲染面板或 footer（hover 强制打开），并保留元素树用于 props/样式断言。 */
function renderClientTree({ state, forceHover = false }) {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null) }),
    // OverlayPanel 用 useState('closed') 初始化相位；footer 的 hovering 用 false 初始化，这里按需放行。
    useEffect: () => {},
    useState: (value) => [value === 'closed' ? 'open' : forceHover && value === false ? true : value, () => {}],
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: () => state,
  }
  let plugin = null
  const registered = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition) => {
          plugin = definition.factory((name) => {
            if (name === 'react') return React
            throw new Error(`unexpected require: ${name}`)
          })
        },
      },
    },
    document: { createElement: () => ({ remove() {} }), head: { appendChild() {} } },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  plugin.apply({
    effect: (factory) => factory(),
    slots: {
      inject: (name, factory) => factory(),
      register: (meta, component) => {
        registered.push(component)
        return () => {}
      },
    },
  })
  return { plugin, footer: registered[0], panel: registered[1] }
}

const collectNodeText = (node, out = []) => {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((n) => collectNodeText(n, out))
    return out
  }
  if (typeof node.type === 'function') {
    collectNodeText(node.type(node.props), out)
    return out
  }
  for (const key of ['aria-valuetext', 'title']) {
    if (typeof node.props?.[key] === 'string') out.push(node.props[key])
  }
  node.children.forEach((n) => collectNodeText(n, out))
  return out
}

const findNode = (node, predicate) => {
  if (node == null || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findNode(n, predicate)
      if (hit) return hit
    }
    return null
  }
  if (typeof node.type === 'function') return findNode(node.type(node.props), predicate)
  const ownText = collectNodeText(node.children).join('')
  if (predicate(ownText, node)) return node
  for (const n of node.children) {
    const hit = findNode(n, predicate)
    if (hit) return hit
  }
  return null
}

test('估算纯函数：样本不足/跨度不足/速率为 0/回落/缺 resetAt 一律返回 null', () => {
  const { estimateEta } = loadClientForUnit().__internal
  const now = 1_700_000_000_000
  const min = 60_000
  const mk = (at, used) => ({ at, used })

  // 样本不足（<3）
  assert.equal(estimateEta([mk(now - 20 * min, 0), mk(now, 10)], 20, now + 60 * min, now), null)
  // 跨度不足（3 个样本但只跨 5 分钟）
  assert.equal(estimateEta([mk(now - 5 * min, 0), mk(now - 2 * min, 2), mk(now, 5)], 20, now + 60 * min, now), null)
  // 速率为 0（used 不变）
  assert.equal(estimateEta([mk(now - 20 * min, 10), mk(now - 10 * min, 10), mk(now, 10)], 20, now + 60 * min, now), null)
  // used 回落（异常数据）不得算出正 ETA
  assert.equal(estimateEta([mk(now - 20 * min, 10), mk(now - 10 * min, 8), mk(now, 6)], 20, now + 60 * min, now), null)
  // resetAt 缺失或已过期：无法判断能否撑到重置
  assert.equal(estimateEta([mk(now - 20 * min, 0), mk(now - 10 * min, 4), mk(now, 8)], 20, null, now), null)
  assert.equal(estimateEta([mk(now - 20 * min, 0), mk(now - 10 * min, 4), mk(now, 8)], 20, now - min, now), null)
  // 剩余为 0 时不再给「耗尽」的荒谬文案
  assert.equal(estimateEta([mk(now - 20 * min, 0), mk(now - 10 * min, 4), mk(now, 8)], 0, now + 60 * min, now), null)
})

test('估算纯函数：ETA 短于重置标记耗尽，长于重置标记可支撑，时长文案分级', () => {
  const { estimateEta, fmtEtaDuration } = loadClientForUnit().__internal
  const now = 1_700_000_000_000
  const min = 60_000
  // 20 分钟用掉 10% → 0.5%/min；剩余 20% → 约 40m 后耗尽
  const samples = [{ at: now - 20 * min, used: 0 }, { at: now - 10 * min, used: 5 }, { at: now, used: 10 }]
  const short = estimateEta(samples, 20, now + 60 * min, now)
  assert.equal(Math.round(short.etaMs / min), 40)
  assert.equal(short.exhaustsBeforeReset, true)
  // 同样速率下剩余 80% → 160 分钟，长于 60 分钟后的重置
  const long = estimateEta(samples, 80, now + 60 * min, now)
  assert.equal(long.exhaustsBeforeReset, false)
  assert.equal(Math.round(long.untilResetMs / min), 60)
  // 时长文案：<1h 分钟、<24h h+m、更长 d+h
  assert.equal(fmtEtaDuration(40 * min), '40m')
  assert.equal(fmtEtaDuration(125 * min), '2h5m')
  assert.equal(fmtEtaDuration(26 * 60 * min), '1d2h')
})

test('采样：按 fetchedAt 去重、按窗口分组，used 回落才清空历史（resetsAt 前移不清空）', () => {
  const { recordSamples, getSamples, resetEtaSamples } = loadClientForUnit().__internal
  resetEtaSamples()
  const t0 = 1_700_000_000_000
  const resetAt = t0 + 86_400_000
  const status = (at, rollingUsed, weeklyUsed, nextResetAt = resetAt) => ({
    ok: true,
    mode: 'ready',
    fetchedAt: at,
    windows: [
      { id: 'rolling', usedPct: rollingUsed, remainingPct: 100 - rollingUsed, resetAt: nextResetAt },
      { id: 'weekly', usedPct: weeklyUsed, remainingPct: 100 - weeklyUsed, resetAt },
    ],
  })

  // 同一 fetchedAt（宿主 30s 缓存）只留一个样本
  recordSamples(status(t0, 10, 0))
  recordSamples(status(t0, 10, 0))
  assert.equal(getSamples('rolling').length, 1)
  // 不同 fetchedAt 正常追加
  recordSamples(status(t0 + 60_000, 12, 1))
  // 跨 realm 对象/数组原型不同，deepStrictEqual 会报「同结构非同一引用」，这里投影成基元再比。
  const pairs = (id) => Array.from(getSamples(id), (s) => [s.at, s.used])
  assert.deepEqual(pairs('rolling'), [[t0, 10], [t0 + 60_000, 12]])
  // used 回落 → 该窗口历史清空，只保留重置后的新样本；其他窗口不受影响
  recordSamples(status(t0 + 120_000, 3, 2))
  assert.deepEqual(pairs('rolling'), [[t0 + 120_000, 3]])
  assert.equal(getSamples('weekly').length, 3)
  // resetsAt 前移（滚动窗口随早先用量的过期而前移）不是重置：即使 used 继续增长，历史也必须继续累积
  recordSamples(status(t0 + 180_000, 4, 3, resetAt + 86_400_000))
  assert.deepEqual(pairs('rolling'), [[t0 + 120_000, 3], [t0 + 180_000, 4]])
  // weekly 的历史同样继续累积，不受 rolling 的 resetsAt 变化影响
  assert.equal(getSamples('weekly').length, 4)
  // 失败状态（ok:false / 无 fetchedAt）不采样
  recordSamples({ ok: false, fetchedAt: t0 + 240_000, windows: [] })
  recordSamples({ ok: true, windows: [] })
  assert.equal(getSamples('rolling').length, 2)
  // 未成功过的窗口读取为空
  assert.equal(getSamples('monthly').length, 0)
})

test('采样裁剪：每窗口最多 120 个样本，且只保留最近 60 分钟', () => {
  const { recordSamples, getSamples, resetEtaSamples } = loadClientForUnit().__internal
  resetEtaSamples()
  const t0 = 1_700_000_000_000
  const resetAt = t0 + 86_400_000
  const push = (at, used) => recordSamples({
    ok: true,
    fetchedAt: at,
    windows: [{ id: 'rolling', usedPct: used, remainingPct: 100 - used, resetAt }],
  })

  // 130 个 10 秒间隔样本，总跨度 21.5 分钟（全部在 60 分钟内）→ 只保留最近 120 个
  for (let i = 0; i < 130; i += 1) push(t0 + i * 10_000, i)
  const capped = getSamples('rolling')
  assert.equal(capped.length, 120)
  assert.equal(capped[0].used, 10)
  assert.equal(capped[capped.length - 1].used, 129)

  // 3 小时后追加：cutoff 之前的旧样本全部裁掉，只剩新样本
  push(t0 + 3 * 3_600_000, 200)
  const pruned = getSamples('rolling')
  assert.equal(pruned.length, 1)
  assert.equal(pruned[0].used, 200)
})

test('采样回归：resetAt 每次前移且 usedPct 单调不降时，样本持续累积并算出估算（P0）', () => {
  const { recordSamples, getSamples, resetEtaSamples, estimateEta, etaView } = loadClientForUnit().__internal
  resetEtaSamples()
  const now = Date.now()
  const min = 60_000
  const resetAt = now + 2 * 3_600_000
  const start = now - 10 * min
  // 21 个 30s 样本（跨度正好 10 分钟）；resetAt 每次前移 30s，模拟滚动窗口随早先用量过期而滑动
  for (let i = 0; i < 21; i += 1) {
    recordSamples({
      ok: true,
      fetchedAt: start + i * 30_000,
      windows: [{
        id: 'rolling',
        usedPct: i,
        remainingPct: 100 - i,
        resetAt: resetAt + i * 30_000,
      }],
    })
  }
  const samples = getSamples('rolling')
  assert.equal(samples.length, 21, 'resetAt 前移不得清空采样历史')
  const estimate = estimateEta(samples, 50, resetAt)
  assert.ok(estimate, '跨度已满 10 分钟且速率 >0，应能算出估算')
  assert.equal(estimate.spanMs, 10 * min)
  const view = etaView({ id: 'rolling', remainingPct: 50, resetAt })
  assert.ok(view, '面板应渲染估算而不是继续采样中')
  assert.notEqual(view.text, '采样中')
  assert.match(view.text, /后耗尽|可支撑到重置/)
})

test('采样回归：usedPct 真实回落时清空历史（窗口重置的唯一可靠信号）', () => {
  const { recordSamples, getSamples, resetEtaSamples } = loadClientForUnit().__internal
  resetEtaSamples()
  const t0 = Date.now()
  const resetAt = t0 + 3 * 3_600_000
  const push = (at, used, nextResetAt = resetAt) => recordSamples({
    ok: true,
    fetchedAt: at,
    windows: [{ id: 'rolling', usedPct: used, remainingPct: 100 - used, resetAt: nextResetAt }],
  })
  push(t0, 10)
  push(t0 + 30_000, 12)
  push(t0 + 60_000, 15)
  assert.equal(getSamples('rolling').length, 3)
  // 新窗口：used 从 15 回落到 1（resetAt 同时也变了）→ 历史必须清空，只保留新窗口样本
  push(t0 + 90_000, 1, t0 + 5 * 3_600_000)
  const after = getSamples('rolling')
  assert.equal(after.length, 1)
  assert.deepEqual([after[0].at, after[0].used], [t0 + 90_000, 1])
})

test('采样回归：同一 fetchedAt 重复入样被去重（宿主 30s 缓存）', () => {
  const { recordSamples, getSamples, resetEtaSamples } = loadClientForUnit().__internal
  resetEtaSamples()
  const at = Date.now()
  const resetAt = at + 3 * 3_600_000
  const status = (fetchedAt, used) => ({
    ok: true,
    fetchedAt,
    windows: [{ id: 'rolling', usedPct: used, remainingPct: 100 - used, resetAt }],
  })
  recordSamples(status(at, 10))
  recordSamples(status(at, 10))
  recordSamples(status(at, 12)) // 同一 fetchedAt 但数据不同：仍不得重复入样
  const samples = getSamples('rolling')
  assert.equal(samples.length, 1)
  assert.deepEqual([samples[0].at, samples[0].used], [at, 10])
  recordSamples(status(at + 30_000, 13))
  assert.equal(getSamples('rolling').length, 2)
})

/** 内存版 localStorage，用于验证持久化读写（不触碰真实浏览器存储）。 */
function createMemoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    raw: (key) => (data.has(key) ? data.get(key) : null),
  }
}

test('采样回归：localStorage 持久化按身份恢复最近 60 分钟 / 最多 120 条 / 去重，重载后接着累积', () => {
  const now = Date.now()
  const min = 60_000
  const key = 'dsh-opencode-status.eta-samples'
  const baseUrl = 'https://opencode.ai/zen/go'
  const keyHint = '••••abcd'
  const resetAt = now + 3 * 3_600_000
  // 130 个 10 秒间隔样本（全部在最近 60 分钟内）+ 1 条过期样本 + 1 条重复 fetchedAt
  const recent = []
  for (let i = 0; i < 130; i += 1) recent.push({ at: now - 30 * min + i * 10_000, used: i })
  const duplicateAt = recent[115].at
  const storage = createMemoryStorage({
    [key]: JSON.stringify({
      v: 2,
      baseUrl,
      keyHint,
      windows: {
        rolling: {
          resetAt,
          samples: [{ at: now - 61 * min, used: 1 }, ...recent, { at: duplicateAt, used: 999 }],
        },
      },
    }),
  })
  const restored = loadClientForUnit({ localStorage: storage }).__internal
  // 身份（首个 status/config 响应）未知前不恢复，避免盲信旧账号样本
  assert.equal(restored.getSamples('rolling').length, 0)
  restored.noteEtaIdentity(baseUrl, keyHint)
  const restoredSamples = restored.getSamples('rolling')
  assert.equal(restoredSamples.length, 120, '每窗口只保留最近 120 条')
  assert.equal(restoredSamples[0].used, 10, '更早的 10 条被裁掉')
  assert.equal(restoredSamples[restoredSamples.length - 1].used, 129)
  assert.ok(!restoredSamples.some((s) => s.at === now - 61 * min), '超过 60 分钟的样本不恢复')
  assert.equal(restoredSamples.filter((s) => s.at === duplicateAt).length, 1, '同一 fetchedAt 只留一条')
  assert.equal(restoredSamples.find((s) => s.at === duplicateAt).used, 999)

  // 新样本写入后重新加载：历史接着累积，不用从 1 个点重新等 10 分钟
  const liveStorage = createMemoryStorage()
  const first = loadClientForUnit({ localStorage: liveStorage }).__internal
  first.noteEtaIdentity(baseUrl, keyHint)
  assert.equal(first.getSamples('rolling').length, 0)
  const feed = (plugin, at, used) => plugin.recordSamples({
    ok: true,
    fetchedAt: at,
    config: { baseUrl, hasKey: true },
    windows: [{ id: 'rolling', usedPct: used, remainingPct: 100 - used, resetAt }],
  })
  feed(first, now - 2 * min, 10)
  feed(first, now - min, 11)
  feed(first, now, 12)
  const persisted = JSON.parse(liveStorage.raw(key))
  assert.equal(persisted.v, 2)
  assert.equal(persisted.baseUrl, baseUrl, '持久化必须记录 baseUrl 归属')
  assert.equal(persisted.keyHint, keyHint, '拿得到 apiKey.hint 时必须一并记录')
  assert.equal(persisted.windows.rolling.samples.length, 3)
  assert.doesNotMatch(JSON.stringify(persisted), /api.?key|token|secret|authorization/i, '持久化不得包含密钥类信息')
  const reloaded = loadClientForUnit({ localStorage: liveStorage }).__internal
  assert.equal(reloaded.getSamples('rolling').length, 0, '身份未知前不恢复')
  reloaded.noteEtaIdentity(baseUrl, keyHint)
  assert.deepEqual(
    Array.from(reloaded.getSamples('rolling'), (s) => [s.at, s.used]),
    Array.from(first.getSamples('rolling'), (s) => [s.at, s.used]),
  )
  feed(reloaded, now + 30_000, 13)
  assert.equal(reloaded.getSamples('rolling').length, 4)

  // localStorage 读/写抛错（隐私模式、配额满）时静默降级：照常采样，不影响面板
  const brokenStorage = {
    getItem: () => { throw new Error('storage denied') },
    setItem: () => { throw new Error('storage denied') },
    removeItem: () => { throw new Error('storage denied') },
  }
  const degraded = loadClientForUnit({ localStorage: brokenStorage }).__internal
  assert.doesNotThrow(() => feed(degraded, now, 5))
  assert.equal(degraded.getSamples('rolling').length, 1)
})

test('采样回归：持久化按 baseUrl / 账号 hint 隔离，身份不匹配整体丢弃且不混出估算（F2）', () => {
  const now = Date.now()
  const min = 60_000
  const key = 'dsh-opencode-status.eta-samples'
  const resetAt = now + 3_600_000
  const baseUrlA = 'https://opencode.ai/zen/go'
  const baseUrlB = 'https://gateway.example.test/go'
  const hintA = '••••1111'
  const hintB = '••••2222'
  const payload = (patch = {}) => JSON.stringify({
    v: 2,
    baseUrl: baseUrlA,
    keyHint: hintA,
    windows: { rolling: { resetAt, samples: [{ at: now - 3 * min, used: 10 }, { at: now - 2 * min, used: 20 }] } },
    ...patch,
  })
  const loadWith = (raw) => {
    const storage = createMemoryStorage({ [key]: raw })
    return { storage, internal: loadClientForUnit({ localStorage: storage }).__internal }
  }

  // 1) 换 baseUrl：整体丢弃，并清掉不属于当前账号的持久化副本
  const wrongBase = loadWith(payload({ baseUrl: baseUrlB }))
  wrongBase.internal.noteEtaIdentity(baseUrlA, hintA)
  assert.equal(wrongBase.internal.getSamples('rolling').length, 0, 'baseUrl 不匹配必须整体丢弃')
  assert.equal(wrongBase.storage.raw(key), null)

  // 2) 同 baseUrl、hint 不同（换了账号）：整体丢弃
  const wrongHint = loadWith(payload({ keyHint: hintB }))
  wrongHint.internal.noteEtaIdentity(baseUrlA, hintA)
  assert.equal(wrongHint.internal.getSamples('rolling').length, 0, '账号 hint 不匹配必须整体丢弃')

  // 3) 旧版 v1 没有身份归属：无法校验，整体丢弃
  const legacy = loadWith(JSON.stringify({ v: 1, windows: { rolling: { resetAt, samples: [{ at: now - 2 * min, used: 20 }] } } }))
  legacy.internal.noteEtaIdentity(baseUrlA, hintA)
  assert.equal(legacy.internal.getSamples('rolling').length, 0, '旧版无身份样本必须丢弃')

  // 4) 身份匹配：正常恢复
  const matched = loadWith(payload())
  matched.internal.noteEtaIdentity(baseUrlA, hintA)
  assert.equal(matched.internal.getSamples('rolling').length, 2, '身份匹配时恢复历史')

  // 5) 拿不到 hint 时只按 baseUrl 隔离（已知限制：同 baseUrl 换账号无法识别）
  const noHint = loadWith(payload())
  noHint.internal.noteEtaIdentity(baseUrlA, null)
  assert.equal(noHint.internal.getSamples('rolling').length, 2, '拿不到 hint 时按 baseUrl 隔离')

  // 5b) 恢复时 hint 未知、之后拿到的 hint 与存储不同（hint 晚到）：已恢复样本必须丢弃
  const lateHint = loadWith(payload())
  lateHint.internal.noteEtaIdentity(baseUrlA, null)
  assert.equal(lateHint.internal.getSamples('rolling').length, 2)
  lateHint.internal.noteEtaIdentity(baseUrlA, hintB)
  assert.equal(lateHint.internal.getSamples('rolling').length, 0, 'hint 晚到且不匹配时必须丢弃已恢复样本')

  // 6) 运行时换 baseUrl：旧历史立即作废，不会把两个账号的 usedPct 拼成错误估算
  const runtime = loadClientForUnit().__internal
  const feed = (at, used, url) => runtime.recordSamples({
    ok: true,
    fetchedAt: at,
    config: { baseUrl: url, hasKey: true },
    windows: [{ id: 'rolling', usedPct: used, remainingPct: 100 - used, resetAt }],
  })
  feed(now - 2 * min, 10, baseUrlA)
  feed(now - min, 20, baseUrlA)
  assert.equal(runtime.getSamples('rolling').length, 2)
  feed(now, 50, baseUrlB)
  const afterSwitch = runtime.getSamples('rolling')
  assert.equal(afterSwitch.length, 1, '换 baseUrl 后旧账号历史必须清空')
  assert.deepEqual([afterSwitch[0].at, afterSwitch[0].used], [now, 50])
  assert.equal(runtime.estimateEta(afterSwitch, 50, resetAt), null, '只有一个新样本时不得算出混用估算')

  // 7) 运行时换账号（同 baseUrl、hint 变）：同样清空历史
  runtime.noteEtaIdentity(baseUrlA, hintA)
  feed(now + 30_000, 51, baseUrlA)
  feed(now + 60_000, 52, baseUrlA)
  runtime.noteEtaIdentity(baseUrlA, hintB)
  assert.equal(runtime.getSamples('rolling').length, 0, '账号 hint 变化后旧历史必须清空')
})

test('采样回归：同账号 hint 晚到只补写身份、不清空已恢复历史（F2-LATE-HINT）', () => {
  const now = Date.now()
  const key = 'dsh-opencode-status.eta-samples'
  const baseUrlA = 'https://opencode.ai/zen/go'
  const hintA = '••••1111'
  const resetAt = now + 3_600_000
  const storage = createMemoryStorage({
    [key]: JSON.stringify({
      v: 2,
      baseUrl: baseUrlA,
      keyHint: hintA,
      windows: { rolling: { resetAt, samples: [{ at: now - 3 * 60_000, used: 10 }, { at: now - 2 * 60_000, used: 20 }] } },
    }),
  })
  const plugin = loadClientForUnit({ localStorage: storage }).__internal
  // status 先到：只有 baseUrl，hint 未知 → 按 baseUrl 恢复（缺证据不下结论）
  plugin.noteEtaIdentity(baseUrlA, null)
  assert.equal(plugin.getSamples('rolling').length, 2, 'hint 未知时按 baseUrl 恢复历史')
  // config 后到，返回同一账号的同一 hint：只补写身份，不得清空
  plugin.noteEtaIdentity(baseUrlA, hintA)
  assert.equal(plugin.getSamples('rolling').length, 2, '同 hint 晚到不得清空历史')
  assert.notEqual(storage.raw(key), null, '同 hint 晚到也不得清掉持久化副本')
  assert.equal(JSON.parse(storage.raw(key)).windows.rolling.samples.length, 2)
  // 后续样本继续累积，而不是从头再等 10 分钟
  plugin.recordSamples({
    ok: true,
    fetchedAt: now,
    config: { baseUrl: baseUrlA, hasKey: true },
    windows: [{ id: 'rolling', usedPct: 30, remainingPct: 70, resetAt }],
  })
  assert.equal(plugin.getSamples('rolling').length, 3, '同 hint 晚到后样本应继续累积')
})

test('采样回归：真实 apply→status→refreshConfig 顺序下同账号 hint 晚到不清空历史（F2-LATE-HINT）', async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const now = Date.now()
  const min = 60_000
  const baseUrl = 'https://opencode.ai/zen/go'
  const hint = '••••1111'
  const key = 'dsh-opencode-status.eta-samples'
  const resetAt = now + 2 * 3_600_000
  // 存储里 3 条同账号历史（首尾跨度 10 分钟）→ 恢复后应能直接出估算
  const storage = createMemoryStorage({
    [key]: JSON.stringify({
      v: 2,
      baseUrl,
      keyHint: hint,
      windows: {
        rolling: {
          resetAt,
          samples: [
            { at: now - 12 * min, used: 10 },
            { at: now - 6 * min, used: 15 },
            { at: now - 2 * min, used: 20 },
          ],
        },
      },
    }),
  })
  const status = {
    ok: true,
    mode: 'ready',
    fetchedAt: now - min,
    config: { baseUrl, hasKey: true },
    windows: [{ id: 'rolling', label: '滚动窗口 (5h)', shortLabel: '5h', usedPct: 30, remainingPct: 70, status: 'ok', resetAt }],
  }
  const config = { baseUrl, apiKey: { configured: true, source: 'profile', writable: true, hint } }
  const app = loadPollingRuntime({
    localStorage: storage,
    fetch: (url) => (url.includes('/api/opencode-status/config')
      ? { ok: true, json: async () => config }
      : { ok: true, json: async () => status }),
  })
  // apply → 首次 status 只带 baseUrl：恢复 3 条并追加当前样本
  await flush()
  assert.equal(app.plugin.__internal.getSamples('rolling').length, 4, 'status 先到时应恢复并继续累积')
  assert.match(app.plugin.__internal.etaView(status.windows[0])?.text ?? '', /后耗尽|可支撑到重置/, '恢复的历史应能直接出估算')

  // 点开面板：refreshStatus（同一 fetchedAt 去重）+ refreshConfig（同一 hint 晚到）
  const findFirstButton = (node) => {
    if (node == null || node === false || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findFirstButton(child)
        if (hit) return hit
      }
      return null
    }
    if (node.type === 'button') return node
    for (const child of node.children ?? []) {
      const hit = findFirstButton(child)
      if (hit) return hit
    }
    return null
  }
  const tree = app.render(app.registered[0]({ wide: true }))
  const button = findFirstButton(tree)
  assert.ok(button && typeof button.props.onClick === 'function', 'footer 必须渲染出可点击按钮')
  button.props.onClick()
  await flush()

  assert.equal(app.plugin.__internal.getSamples('rolling').length, 4, '同账号同 hint 晚到不得清空历史')
  assert.match(app.plugin.__internal.etaView(status.windows[0])?.text ?? '', /后耗尽|可支撑到重置/, '点开面板后估算仍在，不退回采样中')
  assert.equal(JSON.parse(storage.raw(key)).windows.rolling.samples.length, 4, '存储副本也应保留 4 条')
  app.disposePlugin()
})

test('三态渲染：面板可估算才渲染（悬浮卡紧凑视图不展示估算），不可估算不渲染任何节点', () => {
  const now = Date.now()
  const min = 60_000
  const resetAt = now + 2 * 3_600_000
  const history = [
    { at: now - 24 * min, used: 0 },
    { at: now - 12 * min, used: 5 },
    { at: now - min, used: 10 },
  ]
  const currentStatus = {
    ok: true,
    mode: 'ready',
    fetchedAt: now - min,
    config: { baseUrl: 'https://opencode.ai/zen/go' },
    windows: [{ id: 'rolling', label: '滚动窗口 (5h)', shortLabel: '5h', usedPct: 10, remainingPct: 20, status: 'ok', resetAt }],
  }
  const stateFor = (status) => ({ open: true, view: 'status', status, config: { baseUrl: 'https://opencode.ai/zen/go' }, refreshing: false, error: null })
  const inject = (plugin) => {
    for (const sample of history) {
      plugin.__internal.recordSamples({
        ok: true,
        fetchedAt: sample.at,
        windows: [{ id: 'rolling', usedPct: sample.used, remainingPct: 100 - sample.used, resetAt }],
      })
    }
  }

  // 1) ETA < 距重置（剩余 20% → 约 46m，粗化后 45m，重置还有 2h）→ 告警色「约 45m 后耗尽」
  const shortCase = renderClientTree({ state: stateFor(currentStatus) })
  inject(shortCase.plugin)
  const panelTree = shortCase.panel()
  const panelText = collectNodeText(panelTree).join('|')
  assert.match(panelText, /约 45m 后耗尽/)
  assert.match(panelText, /按最近 23 分钟的消耗速率估算（按当前速率），仅供参考/)
  const exhausted = findNode(panelTree, (text) => text === '约 45m 后耗尽')
  assert.ok(exhausted, '应渲染耗尽估算节点')
  assert.equal(exhausted.type, 'span')
  assert.equal(exhausted.props.style.color, 'var(--dsw-alias-state-warn-primary)')
  // 布局：不换行、整段展示不截断（flexShrink:0、无 ellipsis）、不占额外行高
  assert.equal(exhausted.props.style.flexShrink, 0)
  assert.equal(exhausted.props.style.whiteSpace, 'nowrap')
  assert.equal(exhausted.props.style.overflow, undefined)
  assert.equal(exhausted.props.style.textOverflow, undefined)
  assert.equal(exhausted.props.style.margin, undefined)
  // 「剩余 N%」与「⏱ 倒计时」硬性保留
  const remainingNode = findNode(panelTree, (text) => text === '剩余 20%')
  const countdownNode = findNode(panelTree, (text) => text.startsWith('⏱ '))
  assert.ok(remainingNode && countdownNode, '剩余与倒计时必须同屏')
  assert.equal(remainingNode.props.style.flexShrink, 0)
  assert.equal(countdownNode.props.style.flexShrink, 0)
  // 同一行（flex 且未换行）
  const metaRow = findNode(panelTree, (text, node) => node.props?.style?.display === 'flex' && text.includes('剩余 20%') && text.includes('约 45m 后耗尽'))
  assert.ok(metaRow, '估算与剩余应在同一条 flex 行内')
  assert.equal(metaRow.props.style.flexWrap, undefined)
  // 只有窗口标签允许 ellipsis；档位/剩余/ETA/倒计时都不截断
  const labelNode = findNode(panelTree, (text) => text === '滚动窗口 (5h)')
  assert.equal(labelNode.props.style.textOverflow, 'ellipsis')
  assert.equal(labelNode.props.style.minWidth, 0)
  assert.equal(remainingNode.props.style.textOverflow, undefined)
  assert.equal(countdownNode.props.style.textOverflow, undefined)
  assert.equal(exhausted.props.style.textOverflow, undefined)
  // 诚实性：估算文案不出现预测口吻（「即将耗尽」是既有档位标记，单独存在，不算预测）
  assert.doesNotMatch(panelText, /预计|将要|将会/)

  // 2) 同一速率、剩余 80%（约 184m > 120m）→ 中性色「可支撑到重置」
  const supportStatus = { ...currentStatus, windows: [{ ...currentStatus.windows[0], usedPct: 10, remainingPct: 80 }] }
  const supportCase = renderClientTree({ state: stateFor(supportStatus) })
  inject(supportCase.plugin)
  const supportTree = supportCase.panel()
  const supportText = collectNodeText(supportTree).join('|')
  assert.match(supportText, /可支撑到重置/)
  assert.doesNotMatch(supportText, /\d+\s?耗尽/)
  const supportNode = findNode(supportTree, (text) => text === '可支撑到重置')
  assert.equal(supportNode.props.style.color, 'var(--dsw-alias-label-secondary)')
  assert.equal(supportNode.props.style.flexShrink, 0)
  assert.equal(supportNode.props.style.textOverflow, undefined)

  // 3) 不可估算（没有任何样本）→ 完全不渲染估算节点，也不出现占位文案
  //    （「即将耗尽」是既有档位徽标，与估算无关，不能当成 ETA 文案）
  const emptyCase = renderClientTree({ state: stateFor(currentStatus) })
  const emptyTree = emptyCase.panel()
  const emptyText = collectNodeText(emptyTree).join('|')
  assert.doesNotMatch(emptyText, /可支撑到重置|消耗速率/)
  assert.equal(findNode(emptyTree, (text) => /^约 \S+ 后耗尽$/.test(text)), null)
  assert.equal(findNode(emptyTree, (text, node) => /^按最近 \d+ 分钟的消耗速率估算/.test(node.props?.title ?? '')), null)
  assert.equal(findNode(emptyTree, (text) => text === '剩余 20%')?.props?.style?.flexShrink, 0)
  // 不留下 "--"/"0m"/"估算中" 之类占位
  assert.equal(findNode(emptyTree, (text) => /^(-{2,}|0m|估算中|--)$/.test(text)), null)

  // 4) 最坏组合：最长标签 + 档位徽标（剩余 40 → 偏低）+ 长 ETA + 剩余% + ⏱
  //    完整字面 ETA 与档位徽标、剩余%、倒计时都完整渲染且 flexShrink:0，只有标签允许 ellipsis。
  const bandHistory = [
    { at: now - 21 * min, used: 0 },
    { at: now - 11 * min, used: 3.5 },
    { at: now - min, used: 7 },
  ]
  const bandStatus = { ...currentStatus, windows: [{ ...currentStatus.windows[0], usedPct: 60, remainingPct: 40 }] }
  const bandCase = renderClientTree({ state: stateFor(bandStatus) })
  for (const sample of bandHistory) {
    bandCase.plugin.__internal.recordSamples({
      ok: true,
      fetchedAt: sample.at,
      windows: [{ id: 'rolling', usedPct: sample.used, remainingPct: 100 - sample.used, resetAt }],
    })
  }
  const bandTree = bandCase.panel()
  const bandText = collectNodeText(bandTree).join('|')
  const bandEta = findNode(bandTree, (text) => /^约 \S+ 后耗尽$/.test(text))
  assert.ok(bandEta, '档位存在时仍应渲染完整 ETA')
  assert.equal(bandEta.props.style.textOverflow, undefined)
  assert.equal(bandEta.props.style.flexShrink, 0)
  const bandBadge = findNode(bandTree, (text) => text === '⚠ 偏低')
  assert.ok(bandBadge, '档位徽标不得被砍掉（告警不只靠颜色）')
  assert.equal(bandBadge.props.style.flexShrink, 0)
  assert.match(bandText, /剩余 40%/)
  assert.ok(findNode(bandTree, (text) => text.startsWith('⏱ ')))
  // 只有标签允许 ellipsis
  const bandLabel = findNode(bandTree, (text) => text === '滚动窗口 (5h)')
  assert.equal(bandLabel.props.style.textOverflow, 'ellipsis')
  assert.equal(findNode(bandTree, (text) => text === '剩余 40%').props.style.textOverflow, undefined)

  // 5) 紧凑模式（悬浮微卡）整段不渲染估算：同一 estimateEta，只是不展示
  const compactPlugin = shortCase.plugin
  const windowForEta = { id: 'rolling', remainingPct: 20, resetAt }
  assert.ok(compactPlugin.__internal.etaView(windowForEta), '面板口径应能给出估算')
  assert.equal(compactPlugin.__internal.etaView(windowForEta, { compact: true }), null, '紧凑模式必须整段不渲染')

  // 6) 悬浮微卡不渲染 ETA，但剩余% 与 ⏱ 照旧；两条渲染路径共用同一套估算只是呈现密度不同
  const hoverCase = renderClientTree({ state: { ...stateFor(currentStatus), open: false }, forceHover: true })
  inject(hoverCase.plugin)
  const hoverTree = hoverCase.footer({ wide: true })
  const hoverText = collectNodeText(hoverTree).join('|')
  assert.doesNotMatch(hoverText, /约 .+ 后耗尽|可支撑到重置|消耗速率/)
  assert.match(hoverText, /20%/)
  assert.match(hoverText, /⏱/)
  // 卡片仍是 aria-hidden 的只读微卡
  const hoverCard = findNode(hoverTree, (text, node) => node.props?.['aria-hidden'] === true)
  assert.ok(hoverCard, '悬浮卡应为 aria-hidden')
})

test('ETA 粗化：按两位有效数字取整，不暗示分钟级精度', () => {
  const { plugin } = renderClientTree({
    state: { open: false, view: 'status', status: null, config: null, refreshing: false, error: null },
  })
  const { coarsenEta } = plugin.__internal
  const m = 60_000
  // <1h：取 5 分钟，且最小 5m（避免出现「约 0m」）
  assert.equal(coarsenEta(3 * m), 5 * m)
  assert.equal(coarsenEta(46 * m), 45 * m)
  assert.equal(coarsenEta(59 * m), 60 * m)
  // 1-10h：取 30 分钟（1h54m → 2h）
  assert.equal(coarsenEta(114 * m), 120 * m)
  // ≥10h：取 1 小时（13h10m → 13h）
  assert.equal(coarsenEta(790 * m), 780 * m)
  // ≥48h：取 1 天（82h → 3d）
  assert.equal(coarsenEta(82 * 60 * m), 72 * 60 * m)
})

test('采样中提示：有样本但未攒够时给出进度，攒够后让位给真实估算', () => {
  const now = Date.now()
  const min = 60_000
  const resetAt = now + 2 * 3_600_000
  const currentStatus = {
    ok: true,
    mode: 'ready',
    fetchedAt: now - min,
    config: { baseUrl: 'https://opencode.ai/zen/go' },
    windows: [{ id: 'rolling', label: '滚动窗口 (5h)', shortLabel: '5h', usedPct: 10, remainingPct: 20, status: 'ok', resetAt }],
  }
  const stateFor = (status) => ({ open: true, view: 'status', status, config: { baseUrl: 'https://opencode.ai/zen/go' }, refreshing: false, error: null })
  const feed = (plugin, samples) => {
    for (const s of samples) {
      plugin.__internal.recordSamples({ ok: true, fetchedAt: s.at, windows: [{ id: 'rolling', usedPct: s.used, remainingPct: 100 - s.used, resetAt }] })
    }
  }

  // 1) 只有 2 个点、跨度 1 分钟 → 显示「采样中」，且不出现任何 ETA 数字
  const warming = renderClientTree({ state: stateFor(currentStatus) })
  feed(warming.plugin, [{ at: now - 2 * min, used: 8 }, { at: now - min, used: 10 }])
  const warmingTree = warming.panel()
  const warmingText = collectNodeText(warmingTree).join('|')
  assert.match(warmingText, /采样中/)
  assert.doesNotMatch(warmingText, /后耗尽|可支撑到重置/)
  const hint = findNode(warmingTree, (text) => text === '采样中')
  assert.ok(hint, '应渲染采样中提示')
  assert.match(hint.props.title, /需要 3 个点且跨度满 10 分钟/)
  // 仍是纯展示文案，不抢布局：不截断、不收缩
  assert.equal(hint.props.style.flexShrink, 0)

  // 2) 悬浮微卡（compact）不显示采样提示
  const hoverCase = renderClientTree({ state: { ...stateFor(currentStatus), open: false }, forceHover: true })
  feed(hoverCase.plugin, [{ at: now - 2 * min, used: 8 }, { at: now - min, used: 10 }])
  assert.doesNotMatch(collectNodeText(hoverCase.footer({ wide: true })).join('|'), /采样中/)

  // 3) 样本攒够且速率 > 0 → 采样中让位给真实估算
  const ready = renderClientTree({ state: stateFor(currentStatus) })
  feed(ready.plugin, [{ at: now - 20 * min, used: 0 }, { at: now - 12 * min, used: 5 }, { at: now - min, used: 10 }])
  const readyText = collectNodeText(ready.panel()).join('|')
  assert.doesNotMatch(readyText, /采样中/)
  assert.match(readyText, /后耗尽/)
})
