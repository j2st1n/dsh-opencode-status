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
      @keyframes ocFadeSlideUp { from { opacity: 0; transform: translateY(8px) scale(.98) } to { opacity: 1; transform: translateY(0) scale(1) } }
      @keyframes ocFadeSlideDown { from { opacity: 1; transform: translateY(0) scale(1) } to { opacity: 0; transform: translateY(8px) scale(.98) } }
      @keyframes ocSpin { to { transform: rotate(360deg) } }
      @keyframes ocPulse { 0% { box-shadow: 0 0 0 0 rgba(34,197,94,.45) } 70% { box-shadow: 0 0 0 5px rgba(34,197,94,0) } 100% { box-shadow: 0 0 0 0 rgba(34,197,94,0) } }
      .oc-panel-enter { animation: ocFadeSlideUp .2s cubic-bezier(.2,.9,.3,1.2) both }
      .oc-panel-exit { animation: ocFadeSlideDown .15s ease-in both; pointer-events: none !important }
      .oc-btn { transition: background .15s ease, border-color .15s ease, color .15s ease, transform .1s ease }
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
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: color,
      flexShrink: 0,
    })

    const btnBase = {
      alignItems: 'center',
      gap: 6,
      padding: '4px 8px',
      border: `1px solid ${T.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: T.label,
      fontSize: 12,
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
        const status = await api(`/api/opencode-status${force ? '?force=1' : ''}`)
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

    // ---------- 常驻入口（上下结构单行按钮） ----------
    function FooterEntry(props) {
      const state = useStore()

      useEffect(() => {
        refreshStatus(false)
        const timer = setInterval(() => refreshStatus(false), 30_000)
        return () => clearInterval(timer)
      }, [])

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

      return h(
        'button',
        {
          className: 'oc-btn oc-footer-btn',
          style: {
            ...btnBase,
            display: 'flex',
            width: '100%',
            boxSizing: 'border-box',
            justifyContent: 'flex-start',
            margin: '2px 0',
          },
          onClick: () => {
            store.set({ open: !state.open, editing: false })
            if (!state.open) {
              refreshStatus(false)
              refreshConfig()
            }
          },
          title: st?.error?.message || `OpenCode GO · ${value || '点击查看详情'}`,
        },
        h('span', { className: color === T.ok ? 'oc-dot-live' : undefined, style: dotStyle(color) }),
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'baseline', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } },
          [
            h('span', { key: 't', style: { color: T.label } }, text),
            value
              ? [
                  h('span', { key: 'sep', style: { color: T.secondary, margin: '0 5px', opacity: 0.7 } }, '·'),
                  h('span', { key: 'v', style: { color, fontWeight: 500 } }, value),
                ]
              : null,
          ].flat().filter(Boolean),
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

    // ---------- 浮层面板 ----------
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
      const showConfig = state.editing || !st || st.mode === 'needs_config'

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
            h('span', { style: { fontSize: 13, fontWeight: 600, color: T.label } }, showConfig ? '配置 OpenCode' : 'OpenCode GO 用量'),
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
              !showConfig
                ? h(
                    'button',
                    {
                      className: 'oc-btn',
                      style: { ...btnBase, padding: '2px 6px', fontSize: 11, border: 'none' },
                      onClick: async () => {
                        store.set({ refreshing: true })
                        await refreshStatus(true)
                        store.set({ refreshing: false })
                      },
                      title: '刷新用量',
                    },
                    state.refreshing ? h('span', { className: 'oc-spin' }, '↻') : '↻',
                  )
                : null,
              !showConfig
                ? h(
                    'button',
                    {
                      className: 'oc-btn',
                      style: { ...btnBase, padding: '2px 6px', fontSize: 11, border: 'none' },
                      onClick: () => {
                        store.set({ editing: true })
                        refreshConfig()
                      },
                      title: '更新配置',
                    },
                    '⚙',
                  )
                : null,
              h(
                'button',
                {
                  className: 'oc-btn',
                  style: { ...btnBase, padding: '2px 6px', fontSize: 11, border: 'none' },
                  onClick: () => store.set({ open: false, editing: false }),
                  title: '关闭',
                },
                '✕',
              ),
            ]),
          ]),
          // 内容
          showConfig
            ? h(ConfigCard)
            : h('div', null, [
                st?.error ? h('div', { key: 'err', style: { fontSize: 11, color: T.err, marginBottom: 8 } }, st.error.message) : null,
                ...(st?.windows ?? []).map((w) => h(QuotaRow, { key: w.id, window: w })),
                h('div', { key: 'tip', style: { fontSize: 10, color: T.secondary, textAlign: 'right', marginTop: 6 } }, `更新于 ${new Date(st?.fetchedAt || Date.now()).toLocaleTimeString()}`),
              ]),
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
