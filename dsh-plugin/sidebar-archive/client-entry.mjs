import { t, useLocale } from '../i18n/api.mjs'
import { createArchiveNavigation, PANEL } from './navigation.mjs'
import { mountArchiveSidebar, mountArchiveSessionMenu } from './sidebar.mjs'
import { mountHistorySlots, HISTORY_SLOT } from './history-slots.mjs'
import css from './style.css'

window.__ModuleLoader__.load({ id: '@dsh-desktop/sidebar-archive', factory(require) {
  const React = require('react'), h = React.createElement
  const { createRoot } = require('react-dom/client')
  const { Button, Tooltip, IconArchiveOutlineRegular: Archive } = require('@deepseek-ai/dsh-client-ui-primitives')
  function install(ctx) {
    const view = ctx.slots.entriesOfSlot('sidebar.workspaces').find(entry => entry.store)?.store.create()
    if (!view?.actions.setArchivedFilter) return
    // Migrate the old combined list now that archives have their own entry.
    if (view.getSnapshot().archivedFilter === 'show') view.actions.setArchivedFilter('default')
    const navigation = createArchiveNavigation(view, ctx.workspaces.list, ctx.layout)
    const useNavigation = () => React.useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
    function Toggle() {
      useLocale(React)
      const { only } = useNavigation(), label = only ? t('返回工作区') : t('查看归档区')
      return h(Tooltip, { label, side: 'bottom', portal: true, delayMs: 500 },
        h('button', { type: 'button', className: 'dshArchive__toggle', 'aria-label': label, 'aria-pressed': only,
          onClick: () => navigation.toggle() }, h(Archive, { size: 16 })))
    }
    function HistoryPlaceholder({ loading = false, onRetry }) {
      useLocale(React)
      return h('div', { className: 'dshArchive__empty', role: loading ? 'status' : 'alert',
        'data-dsh-history-placeholder': loading ? 'loading' : 'error' },
        h(Archive, { size: 32, 'aria-hidden': true }),
        h('div', { className: 'dshArchive__placeholderCopy' },
          h('p', { className: 'dshArchive__placeholderTitle' }, t(loading ? '正在加载历史内容…' : '历史内容暂时无法加载')),
          !loading && h('p', { className: 'dshArchive__placeholderHint' }, t('请稍后重试，或选择其他会话。'))),
        !loading && h(Button, { variant: 'ghost', onClick: onRetry }, t('重试')))
    }
    function HistoryContent({ reference, SessionProvider, renderSlot, selectedView }) {
      const session = reference.binding.session
      const subscribe = React.useCallback(listener => session.subscribe(listener), [session])
      const getState = React.useCallback(() => session.getSnapshot().openState, [session])
      const openState = React.useSyncExternalStore(subscribe, getState, getState)
      const [retry, setRetry] = React.useState({ busy: false, failed: false })
      const reload = async () => {
        if (retry.busy) return
        setRetry({ busy: true, failed: false })
        try { await session.open(); setRetry({ busy: false, failed: false }) }
        catch { setRetry({ busy: false, failed: true }) }
      }
      // A retained reference can be ready even when its history request failed.
      // Observe the history state before mounting the native error renderer.
      if (retry.busy || (openState === 'loading' && !retry.failed)) return h(HistoryPlaceholder, { loading: true })
      if (openState === 'error' || retry.failed) return h(HistoryPlaceholder, { onRetry: reload })
      return h(SessionProvider, { session: reference }, renderSlot(HISTORY_SLOT, {
        inspectCall: undefined, viewRequest: null, openView: () => {}, completeViewRequest: () => {},
      }, { only: selectedView }))
    }
    function History({ sessionId, SessionProvider, renderSlot, selectedView }) {
      const [reference, setReference] = React.useState(null), [error, setError] = React.useState(null), [retry, setRetry] = React.useState(0)
      React.useEffect(() => {
        let live = true, held
        setReference(null); setError(null)
        try {
          held = ctx.sessions.retain(sessionId, { source: 'desktopArchive' })
          held.ready.then(() => { if (live) setReference(held) }, () => { if (live) setError(true) })
        } catch { setError(true) }
        return () => { live = false; held?.release() }
      }, [sessionId, retry])
      if (error) return h(HistoryPlaceholder, { onRetry: () => setRetry(value => value + 1) })
      if (!reference) return h(HistoryPlaceholder, { loading: true })
      return h(HistoryContent, { reference, SessionProvider, renderSlot, selectedView })
    }
    function ArchivePanel({ SessionProvider, renderSlot, useSessions }) {
      useLocale(React)
      const { sessionId } = useNavigation(), title = useSessions(state => sessionId && state.byId[sessionId]?.displayTitle)
      const [selectedView, setSelectedView] = React.useState('chat')
      const views = ctx.slots.entriesOfSlot(HISTORY_SLOT).map(entry => ({ id: entry.options.id,
        label: typeof entry.options.label === 'function' ? entry.options.label() : entry.options.label || entry.options.id }))
      const activeView = views.some(view => view.id === selectedView) ? selectedView : views[0]?.id
      return h('section', { className: 'dshArchive', 'data-dsh-archive-panel': '', 'data-archive-session': sessionId || undefined },
        h('header', { className: 'dshArchive__header' },
          h('div', { className: 'dshArchive__titleRow' },
            h('h2', { title: title || t('归档区') }, title || t('归档区')),
            sessionId && h('span', { className: 'dshArchive__readonly' }, t('已归档 · 只读'))),
          sessionId && views.length > 1 && h('nav', { className: 'dshArchive__tabs', 'aria-label': t('历史内容视图') },
            views.map(view => h('button', { key: view.id, type: 'button', 'aria-pressed': view.id === activeView,
              onClick: () => setSelectedView(view.id) }, view.label)))),
        h('div', { className: 'dshArchive__content', 'data-conversation-scroll': '', 'data-conversation-region': '' },
          sessionId ? h(History, { key: sessionId, sessionId, SessionProvider, renderSlot, selectedView: activeView })
            : h('div', { className: 'dshArchive__empty' }, h(Archive, { size: 32 }), t('选择归档会话查看历史内容'))),
        sessionId && h('footer', { className: 'dshArchive__notice' }, t('归档会话仅供查看，无法继续对话。')))
    }
    const offMain = ctx.slots.register({ name: 'main', key: PANEL,
      children: { [HISTORY_SLOT]: { kind: 'list', scope: 'session' } },
    }, ArchivePanel)
    const offHistory = mountHistorySlots(React, ctx.slots)
    const offMenu = mountArchiveSessionMenu(React, ctx.slots, ctx.workspaces.list)
    const style = document.createElement('style'); style.textContent = css; document.head.append(style)
    const offSidebar = mountArchiveSidebar(React, createRoot, Toggle, navigation, () => {
      if (document.documentElement.hasAttribute('data-dsh-browser') && document.querySelector('[class*="_frame"]:not([data-sidebar-collapsed])')) ctx.layout.toggleSidebar()
    })
    if (navigation.getSnapshot().only) navigation.enter()
    if (window.__DSH_UI_BOOT__?.smoke) window.__DSH_ARCHIVE_SMOKE__ = { navigation, view }
    return () => { navigation.exit(); offSidebar(); offMenu(); navigation.dispose(); offHistory(); offMain(); style.remove() }
  }
  return { inject: ['slots', 'sessions', 'workspaces', 'layout'], apply(ctx) {
    return ctx.slots.inject('sidebar.workspaces', () => ctx.slots.inject('conversation.view', () => ctx.slots.inject('main', () => install(ctx))))
  } }
} })
