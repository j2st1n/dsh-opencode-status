/**
 * dsh-opencode-status — Client half (0.3.0).
 *
 * 槽位：
 *   sidebar.footer.action  常驻紧凑按钮（状态灯 + 月剩余摘要；点击打开用量面板）
 *   shell.overlay          用量面板（状态视图：三个窗口 + 固定操作条；设置视图：Base URL / API Key）
 *
 * 上游 /v1/usage 只提供 rolling/weekly/monthly 百分比，没有 USD 余额接口
 * （anomalyco/opencode#10448 仍 open），界面只表述「剩余额度 / 可用百分比」，不编造金额。
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-status',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useRef } = React

    const CSS = `
      div[class*="footerActions"] { display: flex !important; flex-direction: column !important; gap: 4px !important; width: 100% !important; }
      @keyframes ocFadeSlideUp { from { opacity: 0; transform: translateY(8px) scale(.98) } to { opacity: 1; transform: translateY(0) scale(1) } }
      @keyframes ocFadeSlideDown { from { opacity: 1; transform: translateY(0) scale(1) } to { opacity: 0; transform: translateY(8px) scale(.98) } }
      @keyframes ocSpin { to { transform: rotate(360deg) } }
      @keyframes ocPulse { 0% { box-shadow: 0 0 0 0 rgba(34,197,94,.45) } 70% { box-shadow: 0 0 0 5px rgba(34,197,94,0) } 100% { box-shadow: 0 0 0 0 rgba(34,197,94,0) } }
      .oc-panel-enter { animation: ocFadeSlideUp .2s cubic-bezier(.2,.9,.3,1.2) both }
      .oc-panel-exit { animation: ocFadeSlideDown .15s ease-in both; pointer-events: none !important }
      .oc-btn { min-width: 0; transition: background .15s ease, border-color .15s ease, color .15s ease, transform .1s ease, opacity .15s ease }
      .oc-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); border-color: var(--dsw-alias-border-l2) }
      .oc-btn:active:not(:disabled) { transform: scale(.98) }
      .oc-btn:disabled { opacity: .55; cursor: default }
      .oc-spin { display: inline-block; animation: ocSpin .8s linear infinite }
      /* 状态灯呼吸只播一次：数据/状态变化时由 React key 换新节点重播，不再无限循环抢注意力 */
      .oc-dot-live { animation: ocPulse 1.2s ease-out 1 both }
      /* 悬浮微卡只读：不接收任何指针事件，避免遮挡 footer 按钮的点击 */
      .oc-hover-card { pointer-events: none !important }
      @media (prefers-reduced-motion: reduce) {
        .oc-panel-enter, .oc-panel-exit, .oc-spin, .oc-dot-live { animation: none !important }
        .oc-btn { transition: none !important }
      }
    `

    const T = {
      bg: 'var(--dsw-alias-bg-layer-2)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      label: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
    }

    const dotStyle = (color) => ({
      display: 'inline-block',
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: color,
      flexShrink: 0,
      verticalAlign: 'middle',
    })

    const btnBase = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 8px',
      border: `1px solid ${T.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: T.label,
      fontSize: 12,
      lineHeight: '18px',
      height: 28,
      boxSizing: 'border-box',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      border: `1px solid ${T.border}`,
      borderRadius: 6,
      background: T.layer1,
      color: T.label,
      fontSize: 12,
      outline: 'none',
    }

    const labelStyle = { display: 'block', fontSize: 12, color: T.secondary, marginBottom: 4 }

    // 面板内的可聚焦元素：仅用于 Tab 首尾循环，不是完整的焦点陷阱。
    const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

    function timeUntil(ts) {
      if (!ts) return ''
      const diff = ts - Date.now()
      if (diff <= 0) return '即将重置'
      const mins = Math.floor(diff / 60000)
      if (mins < 60) return `${mins}m`
      const hours = Math.floor(mins / 60)
      if (hours < 24) return `${hours}h${mins % 60 ? `${mins % 60}m` : ''}`
      return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`
    }

    /** 同步时间显示为 HH:MM:SS（本地时区，取 status.fetchedAt）。 */
    function fmtClock(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    /** 剩余额度阈值着色：>50 正常、>20 警告、其余错误（与 cpa 的 QuotaBar 语义一致）。 */
    function remainingColor(remaining) {
      if (remaining === null || remaining === undefined) return T.secondary
      if (remaining > 50) return T.ok
      if (remaining > 20) return T.warn
      return T.err
    }

    /** 额度档位文字：颜色之外再给一个非颜色信号（色盲用户与读屏都不能只靠颜色），阈值与 remainingColor 对齐。 */
    function remainingBand(remaining) {
      if (remaining === null || remaining === undefined) return null
      if (remaining <= 20) return '即将耗尽'
      if (remaining <= 50) return '偏低'
      return null
    }

    /** 相对时间：面板显示「12s 前」「3 分钟前」，绝对时间放 title，避免每次轮询都盯着一串时分秒。 */
    function fmtRelative(ts, now = Date.now()) {
      if (!ts) return ''
      const diff = Math.max(0, now - ts)
      if (diff < 10_000) return '刚刚'
      const secs = Math.floor(diff / 1000)
      if (secs < 60) return `${secs}s 前`
      const mins = Math.floor(secs / 60)
      if (mins < 60) return `${mins} 分钟前`
      const hours = Math.floor(mins / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.floor(hours / 24)} 天前`
    }

    /** 同步数据超过 2 分钟未更新：给弱过期提示，避免把旧额度当成实时值。 */
    const STALE_AFTER_MS = 2 * 60_000

    function clampPct(value) {
      return Math.max(0, Math.min(100, value))
    }

    /** 百分比显示值：取整并钳制到 0–100（宿主已规整，这里再兜一层，旧数据也不会出现小数或越界值）。 */
    function pctText(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return `${Math.round(clampPct(value))}%`
    }

    /** 月窗口剩余百分比；上游只给百分比，不存在金额余额。 */
    function monthlyRemainingOf(status) {
      if (!status) return null
      const windows = Array.isArray(status.windows) ? status.windows : []
      const monthly = windows.find((w) => w?.id === 'monthly')
      if (monthly && typeof monthly.remainingPct === 'number') return monthly.remainingPct
      if (typeof status.monthlyUsedPct === 'number') return Math.max(0, 100 - status.monthlyUsedPct)
      return null
    }

    function hostOf(url) {
      try {
        return new URL(url).host
      } catch {
        return url
      }
    }

    // ---------- Store ----------
    const store = {
      state: {
        open: false,
        view: 'status', // 'status' 用量视图 | 'settings' 连接设置视图
        status: null,
        config: null,
        refreshing: false,
        error: null,
      },
      listeners: new Set(),
      set(patch) {
        store.state = { ...store.state, ...patch }
        for (const fn of store.listeners) fn()
      },
      subscribe(fn) {
        store.listeners.add(fn)
        return () => store.listeners.delete(fn)
      },
    }

    function useStore() {
      return React.useSyncExternalStore(store.subscribe, () => store.state)
    }

    // ---------- 本机 API ----------
    async function api(path, options) {
      const res = await fetch(path, options)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), { data })
      return data
    }

    // 请求序号：手动刷新会推进 epoch，使所有更早发出的 GET 响应（成功或失败）失效，
    // 避免极端时序下旧数据覆盖手动刷新的新结果。
    let statusEpoch = 0

    /** GET 状态：走宿主 30 秒缓存，打开面板/切换视图都不会额外探测上游。 */
    let statusInFlight = null
    async function refreshStatus() {
      // 并发去重：挂载、打开面板与 30s 轮询同时触发时只发一个 GET，避免首个请求未写入缓存前重复探测。
      if (store.state.refreshing) return
      if (statusInFlight) return statusInFlight
      const epoch = statusEpoch
      statusInFlight = (async () => {
        try {
          const status = await api('/api/opencode-status')
          // 只接受最新 epoch 的响应：手动刷新之后返回的在途 GET 一律丢弃。
          if (epoch === statusEpoch) {
            store.set({ status, error: null })
          }
        } catch (err) {
          if (epoch === statusEpoch) store.set({ error: String(err?.message ?? err) })
        } finally {
          statusInFlight = null
        }
      })()
      return statusInFlight
    }

    async function refreshConfig() {
      try {
        const config = await api('/api/opencode-status/config')
        store.set({ config })
      } catch {}
    }

    // 30 秒状态轮询是模块级单例：采样服务于面板，不能依赖 footer 组件是否挂载。
    let statusPollingStarted = false
    let statusPollTimer = null
    let visibilityListenerBound = false

    /**
     * 页面恢复可见时立即补拉一次；隐藏期间保留 ticker（浏览器会自行节流后台定时器）。
     * 旧实现 hidden 时 clearInterval，恢复只靠这一次 visibilitychange——事件一旦丢失，
     * 轮询就永久停摆，面板会一直显示冻结的旧额度。
     */
    function onVisibilityChange() {
      if (typeof document !== 'undefined' && document.hidden) return
      refreshStatus()
    }

    /**
     * 幂等释放轮询与可见性监听：插件 dispose / HMR 重载时由 apply 的 ctx.effect 调用。
     * 不释放的话旧 ticker 会随模块退役继续存活，新旧 ticker 并存时每 30 秒发两次请求。
     */
    function disposeStatusPolling() {
      if (statusPollTimer !== null) {
        clearInterval(statusPollTimer)
        statusPollTimer = null
      }
      statusPollingStarted = false
      if (visibilityListenerBound) {
        visibilityListenerBound = false
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onVisibilityChange)
        }
      }
    }

    /**
     * 安装 30 秒 GET 轮询（幂等），返回同一个幂等 disposer。旧实现在 FooterEntry 的挂载 effect 里建 ticker：
     * footer 卸载（侧栏收起、布局切换）或 hidden 清理后事件丢失，轮询永久停止，面板显示冻结的旧额度。
     * 轮询属于模块级资源，组件卸载不拆除，但插件 dispose 时必须释放（见 disposeStatusPolling）。
     */
    function ensureStatusPolling() {
      if (!statusPollingStarted) {
        statusPollingStarted = true
        statusPollTimer = setInterval(() => refreshStatus(), 30_000)
        // 首次安装立即拉一次，面板不用等第一个 30 秒。
        refreshStatus()
      }
      if (!visibilityListenerBound) {
        // 测试与 SSR 沙箱里 document 可能没有事件接口，先探测再注册。
        const canListen = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
        if (canListen) {
          document.addEventListener('visibilitychange', onVisibilityChange)
          visibilityListenerBound = true
        }
      }
      // 多次 ensure 返回同一个函数引用：FooterEntry 的幂等调用不会造出第二个 disposer。
      return disposeStatusPolling
    }

    /** 手动刷新唯一入口：绕过 30 秒缓存，强制重新拉取当前剩余额度。 */
    async function manualRefresh() {
      if (store.state.refreshing) return
      // 先推进序号：手动刷新发起后，任何更早发出的在途 GET 响应都不再落库。
      statusEpoch += 1
      store.set({ refreshing: true, error: null })
      try {
        const status = await api('/api/opencode-status/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        })
        // 手动刷新自身的响应始终落库（刷新期间已阻止新的 GET）。
        store.set({ status, error: null })
      } catch (err) {
        store.set({ error: String(err?.message ?? err) })
      } finally {
        store.set({ refreshing: false })
      }
    }

    function openOverlay() {
      store.set({ open: true, view: 'status' })
      // 面板默认落用量视图；GET 命中 30 秒缓存，不触发额外上游探测。
      refreshStatus()
      refreshConfig()
    }

    function closeOverlay() {
      store.set({ open: false })
    }

    function toggleOverlay() {
      if (store.state.open) closeOverlay()
      else openOverlay()
    }

    function openSettings() {
      refreshConfig()
      store.set({ view: 'settings' })
    }

    // ---------- 常驻入口（状态灯 + 月剩余摘要 + 220ms 悬浮微卡） ----------
    function FooterEntry(props) {
      const state = useStore()
      const [hovering, setHovering] = useState(false)
      const hoverTimerRef = useRef(null)

      useEffect(() => {
        // 只幂等确保 ticker 存在，不接管清理：ticker 的生命周期归 apply 的 ctx.effect 管理。
        // footer 卸载（侧栏收起、布局切换）不得停采，这里也不能创建第二个 disposer 去重复清理。
        ensureStatusPolling()
      }, [])

      // 卸载时清掉待触发的悬停定时器，避免 220ms 后对已卸载组件 setState。
      useEffect(() => () => clearTimeout(hoverTimerRef.current), [])

      const onMouseEnter = () => {
        clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = setTimeout(() => setHovering(true), 220)
      }
      const onMouseLeave = () => {
        clearTimeout(hoverTimerRef.current)
        setHovering(false)
      }

      const st = state.status
      const monthlyRemaining = monthlyRemainingOf(st)
      let color = T.warn
      let label = '连接 OpenCode'
      let value = null

      if (state.error) {
        color = T.err
        label = 'OpenCode ?'
      } else if (st?.mode === 'needs_config') {
        color = T.warn
        label = 'OpenCode'
        value = '未配置'
      } else if (st?.mode === 'ready') {
        if (st.ok) {
          color = monthlyRemaining === null ? T.warn : remainingColor(monthlyRemaining)
          label = 'OpenCode'
          value = monthlyRemaining !== null ? `月剩余 ${monthlyRemaining}%` : '在线'
        } else {
          color = T.err
          label = 'OpenCode'
          value = '异常'
        }
      }

      const title = state.error
        ? `本机状态接口异常：${state.error}`
        : st?.mode === 'needs_config'
          ? '尚未配置 OpenCode API Key，点击设置'
          : st?.mode === 'ready' && !st.ok
            ? `用量拉取异常：${st.error?.message ?? '未知错误'}`
            : monthlyRemaining !== null
              ? `OpenCode GO · 月剩余 ${monthlyRemaining}% · 点击查看详情`
              : 'OpenCode GO，点击查看详情'

      // rail 模式：真正的 button（键盘可达、可点击），同样打开用量视图
      if (props?.wide === false) {
        return h(
          'button',
          {
            className: 'oc-btn oc-footer-btn',
            type: 'button',
            title,
            'aria-label': '打开 OpenCode GO 用量面板',
            style: {
              width: 36,
              height: 36,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 8,
              border: `1px solid ${color === T.err ? T.err : T.border}`,
              background: 'transparent',
              color,
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
              margin: '2px auto',
              padding: 0,
              fontVariantNumeric: 'tabular-nums',
            },
            onClick: toggleOverlay,
          },
          monthlyRemaining !== null ? `${monthlyRemaining}%` : 'GO',
        )
      }

      const segments = [
        { text: label, color: T.label },
        value ? { text: value, color } : null,
      ].filter(Boolean)
      const labelEl = h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', lineHeight: '18px', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
        segments.flatMap((s, i) =>
          i === 0
            ? [h('span', { key: `s${i}`, style: { color: s.color, fontWeight: 500, flexShrink: 0 } }, s.text)]
            : [
                h('span', { key: `sep${i}`, style: { color: T.secondary, margin: '0 5px', opacity: 0.7, flexShrink: 0 } }, '·'),
                h('span', { key: `s${i}`, style: { color: s.color, fontWeight: 500, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis' } }, s.text),
              ],
        ),
      )

      const node = h(
        'button',
        {
          className: 'oc-btn oc-footer-btn',
          type: 'button',
          title,
          onMouseEnter,
          onMouseLeave,
          style: {
            ...btnBase,
            display: 'flex',
            width: '100%',
            boxSizing: 'border-box',
            justifyContent: 'flex-start',
            margin: '2px 0',
            minWidth: 0,
            flexShrink: 0,
            borderColor: state.open ? T.brand : T.border,
            background: state.open ? 'var(--dsw-alias-interactive-bg-hover, rgba(59,130,246,.12))' : 'transparent',
          },
          onClick: toggleOverlay,
        },
        h('span', {
          // 呼吸动画只播一次：key 绑定 fetchedAt，新数据到达时换新节点重播一次，而不是无限循环。
          key: color === T.ok ? `live-${st?.fetchedAt ?? 0}` : 'live',
          className: color === T.ok ? 'oc-dot-live' : undefined,
          style: dotStyle(color),
        }),
        labelEl,
      )

      // 悬浮微卡：面板关闭、悬停 220ms、且 ready + ok 时才出现
      if (!hovering || state.open || st?.mode !== 'ready' || !st.ok) return node

      return h(
        'div',
        {
          style: { position: 'relative', width: '100%' },
          onMouseEnter,
          onMouseLeave,
        },
        node,
        h(HoverCard, { status: st }),
      )
    }

    // ---------- 220ms 悬浮微卡（只读概览，无假按钮） ----------
    function HoverCard(props) {
      const st = props.status
      const windows = Array.isArray(st?.windows) ? st.windows : []
      return h(
        'div',
        {
          className: 'oc-panel-enter oc-hover-card',
          // 只读微卡是面板的视觉重复，对读屏隐藏，避免同一份数据播报两遍。
          'aria-hidden': true,
          style: {
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 'calc(100% + 6px)',
            pointerEvents: 'none',
            background: T.bg,
            border: `1px solid ${T.border2}`,
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,.18)',
            padding: '10px 12px 8px',
            fontSize: 11,
            color: T.label,
            zIndex: 100,
            fontFamily: 'system-ui, -apple-system, sans-serif',
          },
        },
        [
          h('div', { key: 'hd', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } }, [
            h('span', { key: 't', style: { fontWeight: 600, fontSize: 12, color: T.label } }, 'OpenCode GO 用量'),
            h(
              'span',
              {
                key: 'at',
                // 相对时间更易读；绝对时刻保留在 title 里，需要精确对时再悬停查看。
                title: st?.fetchedAt ? `上次同步 ${fmtClock(st.fetchedAt)}` : '尚未同步',
                style: { marginLeft: 'auto', fontSize: 10, color: T.secondary, fontVariantNumeric: 'tabular-nums', flexShrink: 0 },
              },
              st?.fetchedAt ? `上次同步 ${fmtRelative(st.fetchedAt)}` : '尚未同步',
            ),
          ]),
          h(
            'div',
            { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            windows.map((w, i) => h(MiniQuotaRow, { key: w.id ?? i, window: w })),
          ),
          h(
            'div',
            { key: 'hint', style: { marginTop: 8, paddingTop: 6, borderTop: `1px dashed ${T.border}`, fontSize: 10, color: T.secondary, textAlign: 'center' } },
            '点击查看详情',
          ),
        ],
      )
    }

    /** 悬浮卡紧凑行：名称 / 剩余 % / ⏱ 重置倒计时 / 细进度条（紧凑视图不展示估算）。 */
    function MiniQuotaRow(props) {
      const w = props.window
      const remaining = w?.remainingPct ?? null
      const color = remainingColor(remaining)
      // 右侧两列必须是**固定宽度**：若按内容自适应，「⏱ 18d15h」比「⏱ 3h26m」宽，
      // 会把该行的进度条挤短，三条进度条的满格基准就各不相同，百分比再准也无法横向比较。
      // 标签列同样固定，短标签最长 2 个字符（5h / 周 / 月）。
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
        h('span', { key: 'n', style: { width: 28, flexShrink: 0, fontSize: 10, color: T.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, w?.shortLabel ?? w?.label ?? '—'),
        h(
          'div',
          { key: 'bar', style: { flex: 1, minWidth: 0, height: 3, borderRadius: 2, background: `color-mix(in srgb, ${color} 28%, transparent)`, overflow: 'hidden' } },
          remaining === null
            ? null
            : h('div', { style: { height: '100%', width: `${clampPct(remaining)}%`, background: color, borderRadius: 2 } }),
        ),
        h('span', { key: 'v', style: { width: 32, flexShrink: 0, textAlign: 'right', fontSize: 10, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' } }, remaining === null ? '—' : pctText(remaining)),
        // 倒计时用 ⏱ 区分刷新动作的 ↻，避免两个图标同义混淆。
        h('span', { key: 'r', style: { width: 50, flexShrink: 0, textAlign: 'right', fontSize: 10, color: T.secondary, fontVariantNumeric: 'tabular-nums' } }, w?.resetAt ? `⏱ ${timeUntil(w.resetAt)}` : ''),
      ])
    }

    // ---------- 用量视图 ----------
    function StatusView() {
      const state = useStore()
      const st = state.status

      if (!st) {
        return h('div', { style: { fontSize: 12, color: T.secondary } }, state.error ? `读取状态失败：${state.error}` : '加载中…')
      }

      const windows = Array.isArray(st.windows) ? st.windows : []

      return h('div', null, [
        h('div', { key: 'sum', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
          h('span', { key: 'd', style: dotStyle(st.ok ? T.ok : T.err) }),
          // 窄视口下让标题让位给右侧摘要：摘要 flexShrink:0，标题可省略。
          h('span', { key: 't', style: { fontSize: 12, fontWeight: 600, color: T.label, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 } }, st.ok ? '已连接' : '异常'),
        ].filter(Boolean)),
        state.error
          ? h('div', { key: 'ce', style: { fontSize: 11, color: T.err, marginTop: 8 } }, `刷新失败：${state.error}`)
          : null,
        !st.ok
          ? h('div', { key: 'se', style: { fontSize: 12, color: T.err, marginTop: 10 } }, st.error?.message ?? '网关返回异常，稍后重试')
          : null,
        st.ok && windows.length
          ? h('div', { key: 'w', style: { marginTop: 14 } }, windows.map((w, i) => h(QuotaRow, { key: w.id ?? i, window: w })))
          : null,
        st.ok && !windows.length
          ? h('div', { key: 'empty', style: { fontSize: 11, color: T.secondary, marginTop: 10 } }, '暂无用量窗口数据')
          : null,
      ].filter(Boolean))
    }

    /**
     * 面板窗口行：主百分比只显示剩余额度（进度条填充同源），「已用」降级到 aria-valuetext 与 title。
     * 语义约定：条长 = 剩余额度占比，条色 = 剩余额度档位；不再同一行并列「已用 X% / 剩余 Y%」重复表达。
     */
    function QuotaRow(props) {
      const w = props.window
      const used = w?.usedPct ?? null
      const remaining = w?.remainingPct ?? null
      const color = remainingColor(remaining)
      const band = remainingBand(remaining)
      const statusText = w?.status && w.status !== 'ok' ? w.status : null
      const detail = remaining === null ? '数据不可用' : `已用 ${pctText(used)} · 剩余 ${pctText(remaining)}`
      return h('div', { style: { marginBottom: 12 } }, [
        h('div', { key: 'meta', style: { display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11, marginBottom: 4, fontVariantNumeric: 'tabular-nums' } }, [
          h('span', { key: 'l', style: { color: T.label, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, w?.label ?? '—'),
          h('span', { key: 'r', title: detail, style: { marginLeft: 'auto', color, fontWeight: 600, flexShrink: 0 } }, remaining === null ? '剩余 —' : `剩余 ${pctText(remaining)}`),
          // 低额度除颜色外再给文字标记：色觉障碍与灰度截图里也能看出档位。
          band
            ? h(
                'span',
                { key: 'band', style: { color, flexShrink: 0, fontSize: 10, lineHeight: '14px', padding: '0 4px', borderRadius: 4, border: `1px solid ${color}` } },
                `⚠ ${band}`,
              )
            : null,
          // 倒计时用 ⏱ 区分刷新动作的 ↻，避免两个图标同义混淆。
          w?.resetAt ? h('span', { key: 't', style: { color: T.secondary, flexShrink: 0 } }, `⏱ ${timeUntil(w.resetAt)}`) : null,
        ].filter(Boolean)),
        h(
          'div',
          {
            key: 'track',
            // 进度条语义：aria-valuenow 取剩余额度，与条长、右侧主百分比同源。
            role: 'progressbar',
            'aria-label': `${w?.label ?? '用量窗口'}剩余额度`,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            ...(remaining === null ? {} : { 'aria-valuenow': Math.round(clampPct(remaining)) }),
            'aria-valuetext': remaining === null ? '数据不可用' : `剩余 ${pctText(remaining)}，已用 ${pctText(used)}${band ? `，${band}` : ''}`,
            title: detail,
            style: {
              height: 6,
              borderRadius: 3,
              background: `color-mix(in srgb, ${color} 14%, transparent)`,
              boxShadow: `inset 0 0 0 1px ${T.border}`,
              overflow: 'hidden',
            },
          },
          remaining === null
            ? null
            : h('div', {
                style: {
                  height: '100%',
                  width: `${clampPct(remaining)}%`,
                  background: color,
                  borderRadius: 3,
                  transition: 'width 0.4s ease',
                },
              }),
        ),
        statusText
          ? h('div', { key: 'st', style: { fontSize: 10, color: T.warn, marginTop: 3 } }, `窗口状态异常：${statusText}`)
          : null,
      ].filter(Boolean))
    }

    // ---------- 连接设置视图 ----------
    function ConfigCard() {
      const state = useStore()
      const cfg = state.config
      const keyState = cfg?.apiKey ?? { configured: false, writable: true, hint: null }
      const [baseUrl, setBaseUrl] = useState('')
      const [apiKey, setApiKey] = useState('')
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)

      useEffect(() => {
        if (cfg) setBaseUrl(cfg.baseUrl ?? '')
      }, [cfg])

      async function save() {
        setSaving(true)
        setError(null)
        try {
          const result = await api('/api/opencode-status/config', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ baseUrl, ...(apiKey ? { apiKey } : {}) }),
          })
          // 保存成功后回到用量视图；账号/baseUrl 变了就立刻作废旧账号的采样历史，不等下一次轮询。
          store.set({ status: result.status, config: result.config, view: 'status', error: null })
          setApiKey('')
        } catch (e) {
          setError(e?.message ?? '保存失败')
        } finally {
          setSaving(false)
        }
      }

      async function clearKey() {
        if (!window.confirm('确定清除已保存的 OpenCode API Key？')) return
        setSaving(true)
        setError(null)
        try {
          const result = await api('/api/opencode-status/config', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ baseUrl, clearApiKey: true }),
          })
          store.set({ status: result.status, config: result.config, error: null })
        } catch (e) {
          setError(e?.message ?? '清除失败')
        } finally {
          setSaving(false)
        }
      }

      /** 放弃未保存的编辑并关闭面板：重新打开时表单会从已保存的配置重新渲染。 */
      function cancel() {
        setBaseUrl(cfg?.baseUrl ?? '')
        setApiKey('')
        setError(null)
        store.set({ open: false, view: 'status' })
      }

      return h('div', null, [
        h('div', { key: 'u', style: { marginBottom: 10 } }, [
          h('label', { style: labelStyle }, 'Base URL'),
          h('input', {
            style: inputStyle,
            value: baseUrl,
            placeholder: 'https://opencode.ai/zen/go',
            onChange: (e) => setBaseUrl(e.target.value),
          }),
        ]),
        h('div', { key: 'k', style: { marginBottom: 10 } }, [
          h('label', { style: labelStyle }, `API Key *${keyState.configured ? `（已保存 ${keyState.hint}）` : ''}`),
          h('input', {
            style: { ...inputStyle, opacity: keyState.writable ? 1 : 0.6 },
            type: 'password',
            value: apiKey,
            disabled: !keyState.writable,
            placeholder: keyState.configured ? '留空表示不修改' : '粘贴 OpenCode API Key',
            onChange: (e) => setApiKey(e.target.value),
          }),
        ]),
        error ? h('div', { key: 'err', style: { fontSize: 11, color: T.err, marginBottom: 8 } }, error) : null,
        h('div', { key: 'btns', style: { display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' } }, [
          h(
            'button',
            { className: 'oc-btn', style: { ...btnBase, background: T.brand, borderColor: T.brand, color: '#fff' }, disabled: saving, onClick: save },
            saving ? '保存中…' : '保存并连接',
          ),
          h('button', { className: 'oc-btn', style: btnBase, disabled: saving, onClick: cancel }, '取消'),
          keyState.configured && keyState.writable
            ? h('button', { className: 'oc-btn', style: { ...btnBase, color: T.err, marginLeft: 'auto' }, disabled: saving, onClick: clearKey }, '清除')
            : null,
        ].filter(Boolean)),
        // 数据口径说明放设置视图：用量视图保持只读结论，正文不再常驻免责声明。
        h(
          'div',
          { key: 'note', style: { fontSize: 10, color: T.secondary, marginTop: 14, lineHeight: '15px' } },
          '上游 /v1/usage 仅提供百分比额度，界面不展示金额余额。',
        ),
      ])
    }

    // ---------- 固定底部操作条 ----------
    function OpsBar(props) {
      const state = useStore()
      const st = state.status
      // 相对时间更好读；绝对时刻保留在 title，同步超过 2 分钟再给弱过期提示。
      const lastSync = st?.fetchedAt ? fmtRelative(st.fetchedAt) : null
      const lastSyncTitle = st?.fetchedAt ? `上次同步 ${fmtClock(st.fetchedAt)}` : '尚未同步'
      const lastSyncStale = Boolean(st?.fetchedAt) && Date.now() - st.fetchedAt > STALE_AFTER_MS
      const syncText = lastSync ? `上次同步 ${lastSync}${lastSyncStale ? ' · 可能已过期' : ''}` : '尚未同步'
      const syncSpan = (key, extraStyle) =>
        h(
          'span',
          { key, title: lastSyncTitle, style: { ...extraStyle, fontVariantNumeric: 'tabular-nums' } },
          syncText,
        )

      if (props?.settings) {
        return h('div', { style: barStyle }, [
          // 只有未配置（needs_config）时没有可返回的用量视图；status 尚未加载时也要保留返回入口。
          st?.mode !== 'needs_config'
            ? h(
                'button',
                {
                  className: 'oc-btn',
                  style: btnBase,
                  onClick: () => {
                    store.set({ view: 'status' })
                    refreshStatus()
                  },
                },
                '← 返回用量',
              )
            : null,
          syncSpan('at', { marginLeft: 'auto', fontSize: 10, color: T.secondary }),
        ].filter(Boolean))
      }

      return h(
        'div',
        { style: barStyle },
        [
          h(
            'button',
            {
              key: 'refresh',
              className: 'oc-btn',
              style: btnBase,
              disabled: state.refreshing,
              onClick: manualRefresh,
              title: '绕过 30 秒缓存，强制重新拉取当前剩余额度',
            },
            h('span', { key: 'i', className: state.refreshing ? 'oc-spin' : undefined }, '↻'),
            state.refreshing ? '刷新中…' : '刷新',
          ),
          h('button', { key: 'set', className: 'oc-btn', style: btnBase, onClick: openSettings, title: '配置 Base URL 与 API Key' }, '⚙ 设置'),
          syncSpan('at', { marginLeft: 'auto', fontSize: 10, color: lastSyncStale ? T.warn : T.secondary }),
        ],
      )
    }

    const barStyle = {
      flexShrink: 0,
      borderTop: `1px solid ${T.border}`,
      padding: '10px 16px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }

    // ---------- Overlay 面板（状态视图 / 设置视图） ----------
    function OverlayPanel() {
      const state = useStore()
      const panelRef = useRef(null)
      // 相位机：closed → open → closing（播完退场动画）→ closed。
      // 拆成两个 effect：否则 phase 变化会清掉「170ms 后置 closed」的定时器，面板卡在不可见仍拦截点击的状态。
      const [phase, setPhase] = useState('closed')
      useEffect(() => {
        if (state.open) setPhase('open')
        else setPhase((p) => (p === 'open' ? 'closing' : p))
      }, [state.open])
      useEffect(() => {
        if (phase !== 'closing') return
        const timer = setTimeout(() => setPhase('closed'), 170)
        return () => clearTimeout(timer)
      }, [phase])

      // 点击外部关闭；footer 常驻按钮自身不在面板内，放行它的点击。
      useEffect(() => {
        if (!state.open) return
        const handleClickOutside = (e) => {
          if (panelRef.current && !panelRef.current.contains(e.target)) {
            const isBtn = e.target.closest && e.target.closest('.oc-footer-btn')
            if (!isBtn) store.set({ open: false })
          }
        }
        window.addEventListener('mousedown', handleClickOutside)
        return () => window.removeEventListener('mousedown', handleClickOutside)
      }, [state.open])

      // Esc 关闭：与面板同开同卸载；Tab 焦点保持在面板内，避免键盘用户掉到背后的不可见区域。
      useEffect(() => {
        if (!state.open) return
        const handleKeyDown = (e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            closeOverlay()
            return
          }
          if (e.key !== 'Tab' || !panelRef.current || typeof panelRef.current.querySelectorAll !== 'function') return
          const focusables = [...panelRef.current.querySelectorAll(FOCUSABLE)]
          if (!focusables.length) {
            e.preventDefault()
            panelRef.current.focus()
            return
          }
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (e.shiftKey && (e.target === first || e.target === panelRef.current)) {
            e.preventDefault()
            last.focus()
          } else if (!e.shiftKey && e.target === last) {
            e.preventDefault()
            first.focus()
          }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
      }, [state.open])

      // 焦点管理：面板挂载（phase 进入 open）后把焦点移入面板（容器 tabIndex=-1），关闭时归还打开前的触发元素（footer 按钮）。
      // 依赖必须带上 phase：面板 DOM 要等 phase effect 把 phase 推到 'open' 才挂载，只依赖 state.open 时
      // 首次执行 panelRef.current 还是 null，panel.focus() 会静默失效（运行时复现由 /tmp/verify-focus.mjs 手工验证，CI 无 jsdom 依赖）。
      useEffect(() => {
        if (!state.open || phase !== 'open') return
        if (typeof document === 'undefined') return
        const previous = document.activeElement
        const panel = panelRef.current
        if (panel && typeof panel.focus === 'function') panel.focus()
        return () => {
          if (!previous || typeof previous.focus !== 'function') return
          // 只把焦点从面板（或已失焦的 body）收回触发按钮：点击外部关闭时不要抢走用户刚点中的控件焦点。
          // cleanup 里不能用打开时捕获的 panel（闭包可能拿到 null），改用当前 ref。
          const current = panelRef.current
          const active = document.activeElement
          if (active && active !== document.body && typeof current?.contains === 'function' && !current.contains(active)) return
          previous.focus()
        }
      }, [state.open, phase])

      if (phase === 'closed') return null

      const st = state.status
      // 未配置时必须直接落在设置视图；其余情况由 store.view 决定。
      const settingsView = state.view === 'settings' || st?.mode === 'needs_config'

      return h(
        'div',
        {
          ref: panelRef,
          className: phase === 'closing' ? 'oc-panel-exit' : 'oc-panel-enter',
          // 非模态对话框：允许点击外部关闭，因此不声明 aria-modal（WAI-ARIA 要求 aria-modal=true 时外部内容不可交互）。
          role: 'dialog',
          'aria-label': settingsView ? 'OpenCode GO 连接配置' : 'OpenCode GO 用量',
          tabIndex: -1,
          style: {
            position: 'fixed',
            left: 12,
            bottom: 52,
            // 窄视口（<384px）不再右侧溢出：宽度随视口收缩，border-box 让 1px 边框不额外撑宽。
            width: 'min(360px, calc(100vw - 24px))',
            maxWidth: 'calc(100vw - 24px)',
            boxSizing: 'border-box',
            maxHeight: 'calc(100vh - 80px)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            background: T.bg,
            border: `1px solid ${T.border}`,
            borderRadius: 16,
            boxShadow: 'var(--dsw-shadow-lv3, 0 10px 32px rgba(0,0,0,0.4))',
            zIndex: 60,
            pointerEvents: phase === 'closing' ? 'none' : 'auto',
          },
        },
        [
          // 固定头部：标题 + 关闭
          h('div', { key: 'hd', style: { display: 'flex', alignItems: 'center', padding: '14px 16px 10px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 } }, [
            h('span', { key: 't', style: { fontSize: 13, fontWeight: 600, color: T.label } }, settingsView ? '⚙ OpenCode GO 连接配置' : 'OpenCode GO 用量'),
            !settingsView && st?.config?.baseUrl
              ? h('span', { key: 'h', style: { fontSize: 10, color: T.secondary, marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, hostOf(st.config.baseUrl))
              : null,
            h(
              'button',
              {
                key: 'x',
                className: 'oc-btn',
                style: { ...btnBase, marginLeft: 'auto', border: 'none', padding: '2px 6px' },
                onClick: closeOverlay,
                title: '关闭',
                'aria-label': '关闭面板',
              },
              '✕',
            ),
          ].filter(Boolean)),
          // 滚动内容区
          h('div', { key: 'body', style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px' } }, settingsView ? h(ConfigCard) : h(StatusView)),
          // 固定底部操作条：刷新 / 设置 / 上次同步
          h(OpsBar, { key: 'ops', settings: settingsView }),
        ],
      )
    }

    // ---------- 注册 ----------
    function apply(ctx) {
      // 0.4.6 起不再使用采样持久化，清掉旧版本留下的键（仅清理，不含任何用户数据）。
      try {
        if (typeof localStorage !== 'undefined' && localStorage) localStorage.removeItem('dsh-opencode-status.eta-samples')
      } catch {}
      // 轮询与 visibilitychange 监听随插件生命周期释放：不依赖 footer 是否挂载（侧栏收起/布局切换仍持续采样），
      // 但 dispose/HMR 时必须清掉，否则旧 ticker 会和新 ticker 并存、每 30 秒发两次请求。
      ctx.effect(() => ensureStatusPolling())
      ctx.effect(() => {
        const el = document.createElement('style')
        el.id = 'dsh-opencode-status-styles'
        el.textContent = CSS
        document.head.appendChild(el)
        return () => el.remove()
      })
      ctx.effect(() =>
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ name: 'sidebar.footer.action', id: 'opencode-status', order: 0 }, (props) => h(FooterEntry, props)),
        ),
      )
      ctx.effect(() =>
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'opencode-status-panel', order: 5 }, () => h(OverlayPanel)),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    // 仅供测试与诊断：估算/采样是纯函数 + 模块内状态，导出以便做真实单元测试（宿主侧不消费）。
    exports.__internal = { ensureStatusPolling }
    return module.exports
  },
})
