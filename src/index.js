/**
 * dsh-opencode-status — Host half.
 *
 * 本机 HTTP 路由（loopback，Cache-Control: no-store）：
 *   GET  /api/opencode-status          摘要与配额窗口数据
 *   GET  /api/opencode-status/config   脱敏配置
 *   PUT  /api/opencode-status/config   创建/更新配置
 *   POST /api/opencode-status/sync     强制同步最新配额
 *
 * 数据源：https://opencode.ai/zen/go/v1/usage
 */
import z from '@deepseek-ai/schemastery'

export const name = 'opencode-status'
export const inject = ['settings', 'credentials', 'webServer']

const NS = /** @type {any} */ ('opencode-status')
const DEFAULT_KEY_REF = /** @type {any} */ ('OPENCODE_GO_API_KEY')
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go'
const DEFAULT_CACHE_TTL_MS = 30_000
const REQUEST_TIMEOUT_MS = 10_000

const envBaseUrl = normalizeBase(process.env.OPENCODE_BASE_URL)

const schema = z.object({
  // 环境变量只作为未持久化配置时的默认值；非法值不覆盖官方端点。
  baseUrl: z.string().default(isAbsoluteHttpUrl(envBaseUrl) ? envBaseUrl : DEFAULT_BASE_URL),
  keyRef: z.string().default(DEFAULT_KEY_REF),
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

export function apply(ctx) {
  const scope = ctx.settings.register(NS, schema)

  /** @type {{ at: number, data: any } | null} */
  let usageCache = null

  function invalidateCache() {
    usageCache = null
  }

  async function getApiKey() {
    const cfg = scope.get()
    const keyRef = cfg.keyRef || DEFAULT_KEY_REF
    const resolved = await ctx.credentials.resolve(keyRef).catch(() => undefined)
    return resolved?.value || null
  }

  async function publicConfig() {
    const cfg = scope.get()
    const keyRef = cfg.keyRef || DEFAULT_KEY_REF
    const info = await ctx.credentials.describe(keyRef)
    let hint = null
    if (info.configured) {
      const resolved = await ctx.credentials.resolve(keyRef).catch(() => undefined)
      hint = resolved?.value ? `••••${resolved.value.slice(-4)}` : '••••'
    }
    return {
      baseUrl: cfg.baseUrl || DEFAULT_BASE_URL,
      apiKey: {
        configured: info.configured,
        source: info.source ?? null,
        writable: info.writable,
        hint,
      },
    }
  }

  async function buildStatus(force = false) {
    const cfg = scope.get()
    const baseUrl = cfg.baseUrl || DEFAULT_BASE_URL
    const key = await getApiKey()

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
    if (!force && usageCache && now - usageCache.at < DEFAULT_CACHE_TTL_MS) {
      return usageCache.data
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
      usageCache = { at: now, data: result }
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
    const data = JSON.parse(text)
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw Object.assign(new Error('请求体必须是 JSON 对象'), { statusCode: 400 })
    }
    return data
  }

  function guard(handler) {
    return async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        sendJson(res, error?.statusCode ?? 500, {
          error: { code: 'INTERNAL', message: String(error?.message ?? error) },
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
      }),
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
        const baseUrl = normalizeBase(body.baseUrl) || DEFAULT_BASE_URL
        if (!isAbsoluteHttpUrl(baseUrl)) {
          return sendJson(res, 400, { error: { code: 'INVALID', message: 'Base URL 必须是有效的 http(s) 地址' } })
        }

        const newKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        const clearKey = body.clearApiKey === true
        const keyRef = scope.get().keyRef || DEFAULT_KEY_REF

        if (clearKey && newKey) {
          return sendJson(res, 400, { error: { code: 'INVALID', message: '不能同时设置新密钥并清除密钥' } })
        }

        try {
          if (clearKey) await ctx.credentials.unset(keyRef)
          else if (newKey) await ctx.credentials.set(keyRef, newKey)
        } catch (error) {
          return sendJson(res, 409, { error: { code: 'KEY_NOT_WRITABLE', message: `密钥写入失败: ${error?.message ?? error}` } })
        }

        await scope.update({ baseUrl })
        invalidateCache()

        sendJson(res, 200, {
          saved: true,
          config: await publicConfig(),
          status: await buildStatus(true),
        })
      }),
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
      }),
    }),
  )
}
