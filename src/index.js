/**
 * dsh-opencode-status — Host half.
 *
 * 本机 HTTP 路由（loopback，Cache-Control: no-store）：
 *   GET  /api/opencode-status          摘要与配额窗口数据
 *   GET  /api/opencode-status/config   脱敏配置
 *   PUT  /api/opencode-status/config   创建/更新配置
 *   POST /api/opencode-status/sync     强制同步最新配额
 *
 * 配置走 DSH 0.2.x 的 Config schema：baseUrl/keyRef 声明为 volatile 字段，宿主据此
 * 生成配置表单，并以 { get() } live ref 的形式传入 apply。baseUrl 的持久化通过可选的
 * settings 服务完成（update(profile 条目 id, patch)），密钥始终存放在 credentials。
 *
 * 数据源：https://opencode.ai/zen/go/v1/usage
 */
import z from '@deepseek-ai/schemastery'

export const name = 'opencode-status'
export const inject = ['credentials', 'webServer']

// profile 条目 id（见 cordis.patch.yml），也是 settings 表单的命名空间。
const NS = /** @type {any} */ ('opencode-status')
const DEFAULT_KEY_REF = /** @type {any} */ ('OPENCODE_GO_API_KEY')
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go'
const DEFAULT_CACHE_TTL_MS = 30_000
const REQUEST_TIMEOUT_MS = 10_000

const envBaseUrl = normalizeBase(process.env.OPENCODE_BASE_URL)
const defaultBaseUrl = isAbsoluteHttpUrl(envBaseUrl) ? envBaseUrl : DEFAULT_BASE_URL

// DSH 0.2.x 用插件导出的 Config 取代已移除的 settings 配置注册接口。
export const Config = z.object({
  // 环境变量只作为未持久化配置时的默认值；非法值不覆盖官方端点。
  baseUrl: z.string().default(defaultBaseUrl).volatile(),
  keyRef: z.string().default(DEFAULT_KEY_REF).volatile(),
})

function normalizeBase(input) {
  return String(input ?? '').trim().replace(/\/+$/, '')
}

function isAbsoluteHttpUrl(input) {
  try {
    const u = new URL(input)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** PUT/POST 只接受 JSON 请求体，允许带 charset 参数。 */
function isJsonContentType(value) {
  return typeof value === 'string' && /^application\/json\s*(?:;|$)/i.test(value.trim())
}

/** 读取请求头；Node 的 headers 是名字归一化后的普通对象。 */
function headerValue(headers, name) {
  const value = headers?.[name]
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
}

/** 与 DSH client-connection 的 isLoopbackHostname 对齐：localhost、[::1] 与 127/8。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 按指定 scheme 解析裸 authority（host 或 host:port）；非法值返回 undefined。 */
function parseAuthority(authority, scheme = 'http:') {
  try {
    return new URL(`${scheme}//${authority}`)
  } catch {
    return undefined
  }
}

/** 绑定地址的 URL 主机名形式：IPv6 加方括号，去掉接口 zone。 */
function bindHostname(bindHost) {
  if (typeof bindHost !== 'string' || bindHost === '') return undefined
  const zoneAt = bindHost.indexOf('%')
  const bare = zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt)
  try {
    return new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** 对齐 DSH 的 isTrustedAuthority：无端口条目匹配任意端口，带端口条目精确匹配。 */
function isTrustedAuthority(hostUrl, trustedHosts, scheme) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry, scheme)
    if (entryUrl === undefined) return false
    const otherScheme = entryUrl.protocol === 'http:' ? 'https:' : 'http:'
    const explicitPort = entryUrl.port !== '' ? entryUrl.port : new URL(`${otherScheme}//${entry}`).port
    return explicitPort === ''
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** Origin 的 http(s) scheme；非法或非 http(s) 值返回 undefined。 */
function originScheme(origin) {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' ? 'https:' : url.protocol === 'http:' ? 'http:' : undefined
  } catch {
    return undefined
  }
}

/** 对齐 DSH 的 isSameAuthorityOrigin：Host 按 Origin 的 scheme 归一化默认端口后比较。 */
function isSameAuthorityOrigin(origin, host) {
  const scheme = originScheme(origin)
  if (scheme === undefined) return false
  const hostUrl = parseAuthority(host, scheme)
  return hostUrl !== undefined && new URL(origin).host === hostUrl.host
}

/** 读取配置字段：volatile 字段是 { get() } live ref，普通配置对象则是具体值。 */
function readConfigField(config, key) {
  const value = config?.[key]
  return value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/** 读取宿主服务；未提供或未注入时 cordis 会抛错，这里统一降级为 undefined。 */
function readService(read) {
  try {
    return read()
  } catch {
    return undefined
  }
}

async function fetchUsageFromGateway(baseUrl, apiKey) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${normalizeBase(baseUrl)}/v1/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`网关返回 HTTP ${res.status}: ${text.slice(0, 150)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export function apply(ctx, config = {}) {
  /** @type {{ at: number, baseUrl: string, keyRef: string, data: any } | null} */
  let usageCache = null

  function invalidateCache() {
    usageCache = null
  }

  function currentBaseUrl() {
    return normalizeBase(readConfigField(config, 'baseUrl')) || defaultBaseUrl
  }

  function currentKeyRef() {
    return readConfigField(config, 'keyRef') || DEFAULT_KEY_REF
  }

  /** settings 以 profile 条目 id 作为命名空间；优先取 loader 分配的条目 id。 */
  function settingsNamespace() {
    const entryId = readService(() => ctx.fiber?.entry?.options?.id)
    return typeof entryId === 'string' && entryId ? entryId : NS
  }

  /**
   * 可选的 settings 服务（DSH 0.2.x 用它持久化 volatile 配置）。
   * 宿主未提供时返回 null，由调用方降级为明确错误响应。
   */
  function settingsService() {
    const service = readService(() => (typeof ctx.get === 'function' ? ctx.get('settings') : undefined))
    if (service && typeof service.update === 'function') return service
    // 兼容把服务直接挂在 ctx 上的宿主；未注入时 cordis 的读取已由 readService 兜住。
    const direct = readService(() => ctx.settings)
    return direct && typeof direct.update === 'function' ? direct : null
  }

  async function persistBaseUrl(baseUrl) {
    const settings = settingsService()
    if (!settings) {
      throw Object.assign(new Error('当前宿主未提供 settings 服务，无法持久化 Base URL'), {
        statusCode: 409,
        code: 'SETTINGS_UNAVAILABLE',
      })
    }
    try {
      await settings.update(settingsNamespace(), { baseUrl })
    } catch (error) {
      throw Object.assign(new Error(`Base URL 持久化失败: ${error?.message ?? error}`), {
        statusCode: 409,
        code: 'PERSIST_FAILED',
      })
    }
  }

  async function getApiKey(keyRef = currentKeyRef()) {
    const resolved = await ctx.credentials.resolve(keyRef).catch(() => undefined)
    return resolved?.value || null
  }

  async function publicConfig(overrideBaseUrl) {
    const keyRef = currentKeyRef()
    const info = await ctx.credentials.describe(keyRef)
    let hint = null
    if (info.configured) {
      const resolved = await ctx.credentials.resolve(keyRef).catch(() => undefined)
      hint = resolved?.value ? `••••${resolved.value.slice(-4)}` : '••••'
    }
    return {
      baseUrl: overrideBaseUrl ?? currentBaseUrl(),
      apiKey: {
        configured: info.configured,
        source: info.source ?? null,
        writable: info.writable,
        hint,
      },
    }
  }

  async function buildStatus(force = false, overrideBaseUrl) {
    const baseUrl = overrideBaseUrl ?? currentBaseUrl()
    const keyRef = currentKeyRef()
    const key = await getApiKey(keyRef)

    if (!key) {
      return {
        ok: false,
        mode: 'needs_config',
        fetchedAt: Date.now(),
        config: { baseUrl, hasKey: false },
        windows: [],
        error: { code: 'NOT_CONFIGURED', message: '需要配置 OpenCode API Key' },
      }
    }

    const now = Date.now()
    const cached = usageCache
    // 命中条件同时比对缓存建立时的 baseUrl 与 keyRef：设置页热改配置后立即重新拉取。
    if (
      !force &&
      cached &&
      cached.baseUrl === baseUrl &&
      cached.keyRef === keyRef &&
      now - cached.at < DEFAULT_CACHE_TTL_MS
    ) {
      return cached.data
    }

    try {
      const data = await fetchUsageFromGateway(baseUrl, key)
      const u = data?.usage ?? {}

      const windows = [
        {
          id: 'rolling',
          label: '滚动窗口 (5h)',
          shortLabel: '5h',
          usedPct: typeof u.rolling?.percent === 'number' ? u.rolling.percent : null,
          remainingPct: typeof u.rolling?.percent === 'number' ? Math.max(0, 100 - u.rolling.percent) : null,
          status: u.rolling?.status ?? 'ok',
          resetAt: u.rolling?.resetsAt ? Date.parse(u.rolling.resetsAt) : null,
        },
        {
          id: 'weekly',
          label: '周窗口',
          shortLabel: 'Weekly',
          usedPct: typeof u.weekly?.percent === 'number' ? u.weekly.percent : null,
          remainingPct: typeof u.weekly?.percent === 'number' ? Math.max(0, 100 - u.weekly.percent) : null,
          status: u.weekly?.status ?? 'ok',
          resetAt: u.weekly?.resetsAt ? Date.parse(u.weekly.resetsAt) : null,
        },
        {
          id: 'monthly',
          label: '月窗口',
          shortLabel: 'Monthly',
          usedPct: typeof u.monthly?.percent === 'number' ? u.monthly.percent : null,
          remainingPct: typeof u.monthly?.percent === 'number' ? Math.max(0, 100 - u.monthly.percent) : null,
          status: u.monthly?.status ?? 'ok',
          resetAt: u.monthly?.resetsAt ? Date.parse(u.monthly.resetsAt) : null,
        },
      ]

      const result = {
        ok: true,
        mode: 'ready',
        fetchedAt: now,
        config: { baseUrl, hasKey: true },
        monthlyUsedPct: typeof u.monthly?.percent === 'number' ? u.monthly.percent : null,
        windows,
        error: null,
      }
      usageCache = { at: now, baseUrl, keyRef, data: result }
      return result
    } catch (error) {
      return {
        ok: false,
        mode: 'ready',
        fetchedAt: now,
        config: { baseUrl, hasKey: true },
        windows: [],
        error: { code: 'GATEWAY_ERROR', message: String(error?.message ?? error) },
      }
    }
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  async function readBody(req) {
    const chunks = []
    let totalBytes = 0
    for await (const chunk of req) {
      totalBytes += chunk.length
      if (totalBytes > 64 * 1024) throw Object.assign(new Error('请求体过大'), { statusCode: 413 })
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.trim()) return {}
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw Object.assign(new Error('请求体必须是合法的 JSON'), { statusCode: 400, code: 'INVALID' })
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw Object.assign(new Error('请求体必须是 JSON 对象'), { statusCode: 400, code: 'INVALID' })
    }
    return data
  }

  /** connection 服务（DSH Web 的 Host/Origin fence 所有者）及其 trustedHosts。 */
  function connectionService() {
    return readService(() => (typeof ctx.get === 'function' ? ctx.get('connection') : undefined))
  }

  function connectionTrustedHosts() {
    const trusted = readService(() => connectionService()?.trustedHosts)
    return Array.isArray(trusted) ? trusted.filter((entry) => typeof entry === 'string') : []
  }

  /** 监听器 scheme（https 由 TLS 配置决定，从不取自请求头）。 */
  function listenerScheme() {
    const protocol = readService(() => ctx.webServer?.protocol)
    return protocol === 'https:' || protocol === 'http:' ? protocol : 'http:'
  }

  /**
   * 本地 Host/Origin fence，与 DSH client-connection 的 isTrustedApiRequest 等价：
   * Host 必须是 loopback、监听器 bind 地址或 connection.trustedHosts 中的地址；
   * 拒绝 sec-fetch-site: cross-site；带 Origin 时必须是同一 authority（默认端口按 Origin 的 scheme 归一化）。
   */
  function trustedByLocalFence(req) {
    const headers = req.headers ?? {}
    const host = headerValue(headers, 'host')
    if (host === undefined || host === '') return false
    const origin = headerValue(headers, 'origin')
    const scheme = (origin !== undefined && originScheme(origin)) || listenerScheme()
    const hostUrl = parseAuthority(host, scheme)
    if (hostUrl === undefined) return false
    const bind = bindHostname(readService(() => ctx.webServer?.host))
    const hostTrusted = isLoopbackHostname(hostUrl.hostname)
      || (bind !== undefined && hostUrl.hostname === bind)
      || isTrustedAuthority(hostUrl, connectionTrustedHosts(), scheme)
    if (!hostTrusted) return false
    if (headerValue(headers, 'sec-fetch-site') === 'cross-site') return false
    if (origin === undefined || origin === '') return true
    return isSameAuthorityOrigin(origin, host)
  }

  /** 优先使用宿主的官方 fence，缺失 connection 服务时回退到等价的本地实现。 */
  function isTrustedRequest(req) {
    const connection = connectionService()
    if (connection !== undefined && typeof connection.isTrusted === 'function') {
      return readService(() => connection.isTrusted(req)) === true
    }
    return trustedByLocalFence(req)
  }

  /**
   * 读请求防护：与写请求共用同一套 Host/来源白名单。
   * 只读路径同样会被 DNS rebinding 利用（攻击者页面可读取 baseUrl、掩码与用配额），
   * 因此 GET 不再放行任意来源。
   */
  function assertTrustedRead(req) {
    if (!isTrustedRequest(req)) {
      throw Object.assign(new Error('拒绝不可信的读请求来源'), { statusCode: 403, code: 'FORBIDDEN' })
    }
  }

  /** 写请求防护：先做 Host/来源白名单（DNS rebinding 与跨站防护），再校验请求内容类型。 */
  function assertTrustedWrite(req) {
    if (!isTrustedRequest(req)) {
      throw Object.assign(new Error('拒绝不可信的写请求来源'), { statusCode: 403, code: 'FORBIDDEN' })
    }
    if (!isJsonContentType((req.headers ?? {})['content-type'])) {
      // 与宿主 client-connection 对齐：实体格式不受支持时返回 415，而不是 403。
      throw Object.assign(new Error('写请求必须使用 application/json'), {
        statusCode: 415,
        code: 'UNSUPPORTED_MEDIA_TYPE',
      })
    }
  }

  function guard(handler, { writeMethods = [], fencedRead = false } = {}) {
    return async (req, res) => {
      try {
        const method = String(req.method ?? '').toUpperCase()
        if (writeMethods.includes(method)) assertTrustedWrite(req)
        else if (fencedRead && method === 'GET') assertTrustedRead(req)
        await handler(req, res)
      } catch (error) {
        sendJson(res, error?.statusCode ?? 500, {
          error: { code: error?.code ?? 'INTERNAL', message: String(error?.message ?? error) },
        })
      }
    }
  }

  // 路由 1：获取状态
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/opencode-status',
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD', message: 'GET only' } })
        const force = new URL(req.url ?? '/', 'http://localhost').searchParams.has('force')
        sendJson(res, 200, await buildStatus(force))
      }, { fencedRead: true }),
    }),
  )

  // 路由 2：配置
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/opencode-status/config',
      handler: guard(async (req, res) => {
        if (req.method === 'GET') {
          return sendJson(res, 200, await publicConfig())
        }
        if (req.method !== 'PUT') {
          return sendJson(res, 405, { error: { code: 'METHOD', message: 'GET/PUT only' } })
        }
        const body = await readBody(req)
        const baseUrl = normalizeBase(body.baseUrl) || defaultBaseUrl
        if (!isAbsoluteHttpUrl(baseUrl)) {
          return sendJson(res, 400, { error: { code: 'INVALID', message: 'Base URL 必须是有效的 http(s) 地址' } })
        }

        const newKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        const clearKey = body.clearApiKey === true
        const keyRef = currentKeyRef()

        if (clearKey && newKey) {
          return sendJson(res, 400, { error: { code: 'INVALID', message: '不能同时设置新密钥并清除密钥' } })
        }

        // baseUrl 变更先落盘：宿主不支持持久化时给出明确错误，避免只写入一半配置。
        if (baseUrl !== currentBaseUrl()) {
          try {
            await persistBaseUrl(baseUrl)
          } catch (error) {
            return sendJson(res, error?.statusCode ?? 409, {
              error: { code: error?.code ?? 'SETTINGS_UNAVAILABLE', message: String(error?.message ?? error) },
            })
          }
        }

        try {
          if (clearKey) await ctx.credentials.unset(keyRef)
          else if (newKey) await ctx.credentials.set(keyRef, newKey)
        } catch (error) {
          return sendJson(res, 409, { error: { code: 'KEY_NOT_WRITABLE', message: `密钥写入失败: ${error?.message ?? error}` } })
        }

        invalidateCache()

        // 持久化成功后本次响应回显保存值；宿主刷新 live ref 后后续请求自动一致。
        sendJson(res, 200, {
          saved: true,
          config: await publicConfig(baseUrl),
          status: await buildStatus(true, baseUrl),
        })
      }, { writeMethods: ['PUT'], fencedRead: true }),
    }),
  )

  // 路由 3：显式同步。保留 GET ?force=1 兼容旧客户端，新客户端使用该端点。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/opencode-status/sync',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD', message: 'POST only' } })
        sendJson(res, 200, await buildStatus(true))
      }, { writeMethods: ['POST'] }),
    }),
  )
}
