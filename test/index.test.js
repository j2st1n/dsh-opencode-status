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

test('package.json 升到 0.3.0，并保留 DSH 0.2.x 兼容范围', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, '0.3.0')
  assert.equal(manifest.engines.node, '>=20')
  // 上界写成 `<0.3.0-0`：0.3.0 的预发布版（0.3.0-rc.1 / rc.2）也因此 UNMET。
  // 该范围语义由宿主 app-boot 的 evaluatePluginCompatibility 验证：
  // 0.2.2-rc.1 → COMPATIBLE；0.3.0-rc.1 / 0.3.0-rc.2 / 0.3.0 → UNMET（见 CHANGELOG 0.2.1）。
  assert.equal(manifest.engines.dsh, '>=0.2.0 <0.3.0-0')
})

test('CHANGELOG 顶部是 0.3.0，README 描述新的点击/刷新/设置/悬浮行为', () => {
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.match(changelog, /^# Changelog\n\n## 0\.3\.0\n/)
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
  assert.match(statusView, /最紧张 \$\{tightest\.shortLabel \?\? tightest\.label \?\? '—'\}/)
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

test('轮询在 document.hidden 时暂停、恢复可见立即补拉，间隔仍为 30s（P1）', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  // 30 秒 GET 自动刷新保持不变（宿主缓存 TTL 也是 30s）
  assert.match(text, /setInterval\(\(\) => refreshStatus\(\), 30_000\)/)
  assert.match(text, /const onVisibilityChange = \(\) => \{[\s\S]{0,260}refreshStatus\(\)[\s\S]{0,120}setInterval\(\(\) => refreshStatus\(\), 30_000\)/)
  assert.match(text, /document\.hidden/)
  assert.match(text, /typeof document\.addEventListener === 'function'/)
  assert.match(text, /removeEventListener\('visibilitychange', onVisibilityChange\)/)
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
  assert.match(refresh, /if \(epoch === statusEpoch\) store\.set\(\{ status, error: null \}\)/)
  assert.match(refresh, /if \(epoch === statusEpoch\) store\.set\(\{ error:/)
  // 手动刷新发起时先推进序号，自身响应仍直接落库
  const manual = text.slice(text.indexOf('async function manualRefresh'), text.indexOf('function openOverlay'))
  assert.match(manual, /statusEpoch \+= 1[\s\S]{0,240}api\('\/api\/opencode-status\/sync'/)
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
  assert.match(panelText, /最紧张 Monthly 90%/)
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
  assert.match(panelText2, /最紧张 Monthly 90%/)
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
