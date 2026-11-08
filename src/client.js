/**
 * dsh-opencode-status — Client half.
 *
 * 槽位：
 *   sidebar.footer.action  常驻极简单行按钮（状态灯 + 月用量 %；点击呼出详情面板）
 *   shell.overlay          轻量浮层面板（展示 Rolling 5h、Weekly、Monthly 进度条与重置倒计时）
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
      .oc-btn { min-width: 0; transition: background .15s ease, border-color .15s ease, color .15s ease, transform .1s ease }
      .oc-btn:hover:not(:disabled):not(.oc-btn-primary) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); border-color: var(--dsw-alias-border-l2) }
      .oc-btn-primary:hover:not(:disabled) { filter: brightness(1.12) }
      .oc-btn:active:not(:disabled) { transform: scale(.98) }
      .oc-spin { display: inline-block; animation: ocSpin .8s linear infinite }
      .oc-dot-live { animation: ocPulse 2.4s ease-out infinite }
      @media (prefers-reduced-motion: reduce) {
        .oc-panel-enter, .oc-panel-exit, .oc-spin, .oc-dot-live { animation: none !important }
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

    function usageColor(percent) {
      if (percent === null || percent === undefined) return T.secondary
      if (percent >= 90) return T.err
      if (percent >= 70) return T.warn
      return T.ok
    }

    // ---------- Store ----------
    const store = {
      state: {
        open: false,
        editing: false,
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

    async function api(path, options) {
      const res = await fetch(path, options)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), { data })
      return data
    }

    async function refreshStatus(force = false) {
      try {
        const status = force
          ? await api('/api/opencode-status/sync', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            })
          : await api('/api/opencode-status')
        store.set({ status, error: null })
      } catch (err) {
        store.set({ error: String(err?.message ?? err) })
      }
    }

    async function refreshConfig() {
      try {
        const config = await api('/api/opencode-status/config')
        store.set({ config })
      } catch {}
    }

    // ---------- 常驻入口（上下结构单行按钮 + 悬停微卡） ----------
    function FooterEntry(props) {
      const state = useStore()
      const [hovering, setHovering] = useState(false)
      const hoverTimerRef = useRef(null)

      useEffect(() => {
        refreshStatus(false)
        const timer = setInterval(() => refreshStatus(false), 30_000)
        return () => clearInterval(timer)
      }, [])

      const onMouseEnter = () => {
        clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = setTimeout(() => setHovering(true), 220)
      }
      const onMouseLeave = () => {
        clearTimeout(hoverTimerRef.current)
        setHovering(false)
      }

      const st = state.status
      let color = T.warn
      let text = '连接 OpenCode'
      let value = null

      if (state.error) {
        color = T.err
        text = 'OpenCode ?'
      } else if (st?.mode === 'ready') {
        if (st.ok) {
          const pct = st.monthlyUsedPct
          color = usageColor(pct)
          text = 'OpenCode'
          value = pct !== null ? `月用量 ${pct}%` : '在线'
        } else {
          color = T.err
          text = 'OpenCode'
          value = '异常'
        }
      }

      if (props?.wide === false) {
        return h(
          'div',
          {
            className: 'oc-btn',
            style: {
              boxSizing: 'border-box',
              width: 36,
              height: 36,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 8,
              fontSize: 10,
              fontWeight: 700,
              color: T.label,
              cursor: 'pointer',
              margin: '2px auto',
            },
            title: st?.error?.message || `OpenCode GO ${value || ''}`,
            onClick: () => store.set({ open: !state.open, editing: false }),
          },
          st?.monthlyUsedPct !== null && st?.monthlyUsedPct !== undefined ? `${st.monthlyUsedPct}%` : 'GO',
        )
      }

      const node = h(
        'button',
        {
          className: 'oc-btn oc-footer-btn',
          onMouseEnter,
          onMouseLeave,
          style: {
            ...btnBase,
            display: props?.wide === false ? 'inline-flex' : 'flex',
            width: props?.wide === false ? undefined : '100%',
            boxSizing: 'border-box',
            justifyContent: props?.wide === false ? 'center' : 'flex-start',
            margin: '2px 0',
            minWidth: 0,
            flexShrink: 0,
            borderColor: state.open ? T.brand : T.border,
            background: state.open ? 'var(--dsw-alias-interactive-bg-hover, rgba(59,130,246,.12))' : 'transparent',
          },
          onClick: () => {
            store.set({ open: !state.open, editing: false })
            if (!state.open) {
              refreshStatus(false)
              refreshConfig()
            }
          },
        },
        h('span', { className: color === T.ok ? 'oc-dot-live' : undefined, style: dotStyle(color) }),
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', lineHeight: '18px', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
          [
            h('span', { key: 't', style: { color: T.label, fontWeight: 500, flexShrink: 0 } }, text),
            value
              ? [
                  h('span', { key: 'sep', style: { color: T.secondary, margin: '0 5px', opacity: 0.7, flexShrink: 0 } }, '·'),
                  h('span', { key: 'v', style: { color, fontWeight: 500, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis' } }, value),
                ]
              : null,
          ].flat().filter(Boolean),
        ),
      )

      if (!hovering || state.open || !st?.ok || !st?.windows?.length) return node

      return h(
        'div',
        {
          style: { position: 'relative', width: '100%' },
          onMouseEnter,
          onMouseLeave,
        },
        node,
        h(
          'div',
          {
            className: 'oc-panel-enter',
            style: {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 'calc(100% + 6px)',
              background: T.bg,
              border: `1px solid ${T.border2}`,
              borderRadius: '10px',
              boxShadow: '0 8px 24px rgba(0,0,0,.18)',
              padding: '12px 14px 4px 14px',
              fontSize: '11px',
              color: T.label,
              zIndex: 100,
              fontFamily: 'system-ui, -apple-system, sans-serif',
            },
          },
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 10,
              },
            },
            h('span', { style: { fontWeight: 600, fontSize: '12px' } }, '🚀 OpenCode GO 用量概览'),
            st.plan ? h('span', { style: { fontSize: '10px', color: T.brand, fontWeight: 600 } }, st.plan) : null,
          ),
          st.windows.map((w, i) => h(QuotaRow, { key: i, window: w })),
        ),
      )
    }

    // ---------- 配额进度条 ----------
    function QuotaRow(props) {
      const w = props.window
      const used = w.usedPct
      const color = usageColor(used)
      return h('div', { style: { marginBottom: 10 } }, [
        h('div', { key: 'label', style: { display: 'flex', fontSize: 11, marginBottom: 3, fontVariantNumeric: 'tabular-nums' } }, [
          h('span', { style: { color: T.label, fontWeight: 500 } }, w.label),
          h('span', { style: { marginLeft: 'auto', color, fontWeight: 600 } }, used !== null ? `${used}%` : '—'),
          w.resetAt ? h('span', { style: { color: T.secondary, marginLeft: 6 } }, `↻ ${timeUntil(w.resetAt)}`) : null,
        ]),
        h(
          'div',
          {
            key: 'track',
            style: {
              height: 6,
              borderRadius: 3,
              background: `color-mix(in srgb, ${color} 14%, transparent)`,
              boxShadow: `inset 0 0 0 1px ${T.border}`,
              overflow: 'hidden',
            },
          },
          used === null
            ? null
            : h('div', {
                style: {
                  height: '100%',
                  width: `${Math.max(0, Math.min(100, used))}%`,
                  background: color,
                  borderRadius: 3,
                  transition: 'width 0.4s ease',
                },
              }),
        ),
      ])
    }

    // ---------- 配置卡片 ----------
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
          store.set({ status: result.status, config: result.config, editing: false })
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
          store.set({ status: result.status, config: result.config, editing: false })
        } catch (e) {
          setError(e?.message ?? '清除失败')
        } finally {
          setSaving(false)
        }
      }

      return h('div', null, [
        h('div', { key: 'u', style: { marginBottom: 10 } }, [
          h('label', { style: { display: 'block', fontSize: 12, color: T.secondary, marginBottom: 4 } }, 'Base URL'),
          h('input', {
            style: inputStyle,
            value: baseUrl,
            placeholder: 'https://opencode.ai/zen/go',
            onChange: (e) => setBaseUrl(e.target.value),
          }),
        ]),
        h('div', { key: 'k', style: { marginBottom: 10 } }, [
          h('label', { style: { display: 'block', fontSize: 12, color: T.secondary, marginBottom: 4 } }, `API Key *${keyState.configured ? `（已保存 ${keyState.hint}）` : ''}`),
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
            { className: 'oc-btn oc-btn-primary', style: { ...btnBase, background: T.brand, borderColor: T.brand, color: '#fff' }, disabled: saving, onClick: save },
            saving ? '保存中…' : '保存并连接',
          ),
          state.status?.mode === 'ready'
            ? h('button', { className: 'oc-btn', style: btnBase, disabled: saving, onClick: () => store.set({ editing: false }) }, '取消')
            : null,
          keyState.configured && keyState.writable
            ? h('button', { className: 'oc-btn', style: { ...btnBase, color: T.err, marginLeft: 'auto' }, disabled: saving, onClick: clearKey }, '清除')
            : null,
        ]),
      ])
    }

    // ---------- 浮层配置面板（点击进入控制台管理，用量已在悬浮卡片展示） ----------
    function OverlayPanel() {
      const state = useStore()
      const panelRef = useRef(null)
      const [phase, setPhase] = useState('closed')

      useEffect(() => {
        if (state.open) setPhase('open')
        else setPhase((p) => (p === 'open' ? 'closing' : p))
      }, [state.open])

      useEffect(() => {
        if (phase !== 'closing') return
        const timer = setTimeout(() => setPhase('closed'), 160)
        return () => clearTimeout(timer)
      }, [phase])

      // 点击外部关闭
      useEffect(() => {
        if (!state.open) return
        const handleClickOutside = (e) => {
          if (panelRef.current && !panelRef.current.contains(e.target)) {
            const isBtn = e.target.closest && e.target.closest('.oc-footer-btn')
            if (!isBtn) store.set({ open: false, editing: false })
          }
        }
        window.addEventListener('mousedown', handleClickOutside)
        return () => window.removeEventListener('mousedown', handleClickOutside)
      }, [state.open])

      if (phase === 'closed') return null

      const st = state.status

      return h(
        'div',
        {
          ref: panelRef,
          className: phase === 'closing' ? 'oc-panel-exit' : 'oc-panel-enter',
          style: {
            position: 'fixed',
            left: 12,
            bottom: 52,
            width: 320,
            background: T.bg,
            border: `1px solid ${T.border}`,
            borderRadius: 16,
            boxShadow: 'var(--dsw-shadow-lv3, 0 10px 32px rgba(0,0,0,0.4))',
            padding: '14px 16px 12px',
            zIndex: 60,
            pointerEvents: phase === 'closing' ? 'none' : 'auto',
          },
        },
        [
          // 头部
          h('div', { key: 'hd', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, borderBottom: `1px solid ${T.border}`, paddingBottom: 8 } }, [
            h('span', { style: { fontSize: 13, fontWeight: 600, color: T.label } }, '⚙ OpenCode GO 连接配置'),
            h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } }, [
              h(
                'button',
                {
                  className: 'oc-btn',
                  style: {
                    width: 26,
                    height: 26,
                    padding: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 14,
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    color: T.secondary,
                    background: 'transparent',
                  },
                  onClick: async () => {
                    store.set({ refreshing: true })
                    await refreshStatus(true)
                    store.set({ refreshing: false })
                  },
                  title: '强制刷新同步',
                },
                state.refreshing ? h('span', { className: 'oc-spin' }, '↻') : '↻',
              ),
              h(
                'button',
                {
                  className: 'oc-btn',
                  style: {
                    width: 26,
                    height: 26,
                    padding: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 13,
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    color: T.secondary,
                    background: 'transparent',
                  },
                  onClick: () => store.set({ open: false, editing: false }),
                  title: '关闭',
                },
                '✕',
              ),
            ]),
          ]),
          // 内容：直接展示配置与连接管理
          h(ConfigCard),
        ],
      )
    }

    // ---------- 注册 ----------
    function apply(ctx) {
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
    return module.exports
  },
})
