/**
 * dsh-session-delete - browser half.
 *
 * Two contributions:
 *   1. `sidebar.workspaces.session.menu.item` - the "删除会话" context-menu row.
 *      A cold Session is deleted immediately; a live one is queued for removal
 *      on the next start.
 *   2. `shell.overlay` - a boot notice that lists what the last start removed
 *      from the queue (so a queued deletion is visible after the restart).
 *
 * After an immediate deletion the sidebar list is refreshed through the client
 * Session controller's `refreshList()` (a full host `session.list` pull), so no
 * page reload is needed - this desktop shell has no F5/reload binding at all.
 *
 * Module format: a Module Loader factory package (window.__ModuleLoader__), with
 * react / react-dom / @deepseek-ai/dsh-client-ui-primitives resolved through the
 * loader's `require` as implicit baseline externals.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let react = require('react')
    let ui = require('@deepseek-ai/dsh-client-ui-primitives')

    const name = 'dsh-session-delete'
    const NS = 'sessionDelete'
    const ROUTE_DELETE = '/dsh-session-delete/delete'
    const ROUTE_QUEUE = '/dsh-session-delete/queue'
    const ROUTE_LAST_DRAIN = '/dsh-session-delete/last-drain'

    const en = {
      menu: 'Delete session',
      confirm: 'Delete session \u201c{title}\u201d?\n\nIts log and replay cache move to the Recycle Bin.',
      done: '\u201c{title}\u201d deleted; the sidebar list refreshes itself.',
      queuePrompt: 'This session is still loaded in the app, so it cannot be deleted right now.\n\nQueue it for removal on the next DSH start?',
      queued: '\u201c{title}\u201d queued. It will be deleted when DSH starts next time (before the session is opened).',
      live: 'This session is still loaded in the app, so it cannot be deleted now.',
      missing: 'No stored files found for this session.',
      untrusted: 'The request was rejected by the app trust fence. Try again.',
      failed: 'Delete failed: {reason}',
      drainTitle: 'Removed on this start: {count} session(s)',
      drainMore: 'and {count} more',
      drainKept: '{count} could not be removed and stay queued',
      drainClose: 'Got it',
    }
    const zh = {
      menu: '删除会话',
      confirm: '确定删除会话「{title}」吗？\n\n它的日志与投影缓存会移入回收站。',
      done: '「{title}」已删除，侧栏会自动刷新。',
      queuePrompt: '这个会话还加载在应用内存里，现在不能直接删。\n\n要把它标记为「下次启动 DSH 时删除」吗？（启动时会在它被打开之前删掉）',
      queued: '「{title}」已标记。下次启动 DSH 时会自动删除（在会话被打开之前）。',
      live: '这个会话还加载在应用内存里，现在不能删。',
      missing: '没有找到这个会话的存储文件（可能已经被删过）。',
      untrusted: '请求被应用的信任栅栏拒绝，请再试一次。',
      failed: '删除失败：{reason}',
      drainTitle: '本次启动已删除 {count} 个会话',
      drainMore: '另有 {count} 个',
      drainKept: '有 {count} 个没能删除，仍留在队列里',
      drainClose: '知道了',
    }

    async function postJson(path, payload) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(payload || {}),
      })
      let body = {}
      try {
        body = await response.json()
      } catch { /* non-JSON failure */ }
      if (!response.ok || !body || body.ok !== true) {
        const err = new Error((body && body.error) || ('HTTP ' + response.status))
        err.code = (body && body.code) || 'http-' + response.status
        throw err
      }
      return body
    }

    async function getJson(path) {
      const response = await fetch(path, { cache: 'no-store' })
      return response.json()
    }

    function ackDrain() {
      try {
        void fetch(ROUTE_LAST_DRAIN, { method: 'POST', cache: 'no-store' }).catch(() => {})
      } catch { /* ignore */ }
    }

    function message(t, err) {
      const code = err && err.code
      if (code === 'live') return t('live')
      if (code === 'missing') return t('missing')
      if (code === 'untrusted') return t('untrusted')
      return t('failed', { reason: String((err && err.message) || err) })
    }

    /** Context-menu row. Props: runtime share + locale share + injected callbacks. */
    const DeleteMenuItem = (props) => {
      const options = props || {}
      const sessionId = options.sessionId
      const rawTitle = options.displayTitle == null ? '' : String(options.displayTitle)
      const label = rawTitle.trim() ? rawTitle : String(sessionId || '')
      const t = typeof options.t === 'function' ? options.t : (key) => key
      const refreshList = typeof options.refreshAfterDelete === 'function' ? options.refreshAfterDelete : () => {}

      let setMenuOpen = () => {}
      try {
        if (typeof options.useMenuOpenState === 'function') {
          const state = options.useMenuOpenState()
          if (Array.isArray(state) && typeof state[1] === 'function') setMenuOpen = state[1]
        }
      } catch { /* the seat may expose a different hook shape */ }

      const onSelect = () => {
        try {
          setMenuOpen(false)
        } catch { /* menu already closed */ }
        try {
          if (!window.confirm(t('confirm', { title: label }))) return
          postJson(ROUTE_DELETE, { sessionId, title: label })
            .then((body) => {
              const note = body && body.recycled === false ? '\n\n（回收站不可用，文件已移到 ~/.dsh/.session-trash）' : ''
              window.alert(t('done', { title: label }) + note)
              refreshList(sessionId)
            })
            .catch((err) => {
              if (err && err.code === 'live' && window.confirm(t('queuePrompt'))) {
                postJson(ROUTE_QUEUE, { sessionId, title: label })
                  .then(() => window.alert(t('queued', { title: label })))
                  .catch((queueErr) => window.alert(message(t, queueErr)))
                return
              }
              window.alert(message(t, err))
            })
        } catch (err) {
          window.alert(message(t, err))
        }
      }

      const icon = ui.IconTrashOutlineRegular ? react.createElement(ui.IconTrashOutlineRegular) : null
      return react.createElement(ui.MenuItemButton, { icon, separatorBefore: true, onSelect }, t('menu'))
    }

    /**
     * Boot notice: shows the drain summary once, then acknowledges it so it does
     * not reappear. Waits for an in-flight drain (queued removals are slow: each
     * file move spawns a Powershell helper).
     */
    const DrainNotice = (props) => {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [report, setReport] = react.useState(null)

      react.useEffect(() => {
        let cancelled = false
        let timer = null
        let tries = 0
        const tick = () => {
          if (cancelled) return
          tries += 1
          getJson(ROUTE_LAST_DRAIN)
            .then((body) => {
              if (cancelled) return
              const found = body && body.report
              if (found && Array.isArray(found.deleted) && found.deleted.length > 0) {
                setReport(found)
                return
              }
              if (body && body.pending && tries < 20) {
                timer = setTimeout(tick, 900)
              }
            })
            .catch(() => {
              if (!cancelled && tries < 20) timer = setTimeout(tick, 1500)
            })
        }
        tick()
        return () => {
          cancelled = true
          if (timer) clearTimeout(timer)
        }
      }, [])

      react.useEffect(() => {
        if (!report) return undefined
        const hide = setTimeout(() => {
          ackDrain()
          setReport(null)
        }, 15000)
        return () => clearTimeout(hide)
      }, [report])

      if (!report) return null
      const deleted = report.deleted || []
      const kept = report.kept || []
      const shown = deleted.slice(0, 5)
      const more = deleted.length - shown.length

      const lineStyle = { margin: '2px 0', opacity: 0.9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
      const children = [
        react.createElement('div', { key: 'title', style: { fontWeight: 600, marginBottom: 6 } }, t('drainTitle', { count: deleted.length })),
        ...shown.map((entry, index) => react.createElement('div', { key: 'd' + index, style: lineStyle }, '\u2022 ' + (entry.title || entry.id))),
      ]
      if (more > 0) children.push(react.createElement('div', { key: 'more', style: lineStyle }, t('drainMore', { count: more })))
      if (kept.length > 0) children.push(react.createElement('div', { key: 'kept', style: { ...lineStyle, color: '#ffd28a' } }, t('drainKept', { count: kept.length })))
      children.push(react.createElement('button', {
        key: 'close',
        type: 'button',
        onClick: () => {
          ackDrain()
          setReport(null)
        },
        style: {
          marginTop: 8,
          padding: '3px 10px',
          fontSize: 12,
          color: '#fff',
          background: 'rgba(255,255,255,0.16)',
          border: '1px solid rgba(255,255,255,0.28)',
          borderRadius: 6,
          cursor: 'pointer',
        },
      }, t('drainClose')))

      return react.createElement('div', {
        role: 'status',
        style: {
          position: 'fixed',
          right: 16,
          bottom: 16,
          zIndex: 2147483000,
          maxWidth: 380,
          padding: '10px 12px',
          borderRadius: 10,
          background: 'rgba(28,32,44,0.96)',
          color: '#fff',
          font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          pointerEvents: 'auto',
        },
      }, children)
    }

    const inject = ['slots', 'locale', 'sessions']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-session-delete: dictionaries')
      const t = ctx.locale.bind(NS)

      // The client Session controller's full list pull; falls back to the
      // per-session projection refresh, and only then to a page reload.
      const refreshAfterDelete = (sessionId) => {
        try {
          const sessions = ctx.sessions
          if (sessions && typeof sessions.refreshList === 'function') {
            Promise.resolve(sessions.refreshList()).catch(() => {})
            return
          }
          if (sessions && typeof sessions.refreshProjections === 'function') {
            Promise.resolve(sessions.refreshProjections(sessionId)).catch(() => {})
            return
          }
        } catch { /* fall through to the reload fallback */ }
        try { window.location.reload() } catch { /* give up quietly */ }
      }

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'dsh-session-delete.delete',
            order: 450,
            locale: NS,
            inject: () => ({ refreshAfterDelete }),
          },
          DeleteMenuItem,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-session-delete.drain-notice',
            locale: NS,
            inject: () => ({ t }),
          },
          DrainNotice,
        ),
      )
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
