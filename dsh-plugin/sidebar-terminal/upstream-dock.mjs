import { t, useLocale } from '../i18n/api.mjs'
import { createDockStore, createDockComponent, createDockToggleComponent, createDockWorkspaceSource } from './dock.mjs'
import { currentSessionId } from './session-context.mjs'
import { createTerminalTabMenuRows, installSidebarTerminalMenu } from './upstream-tab-menu.mjs'

export const UPSTREAM_PREFIX = 'sidebar://terminal/desktop-dock/'
const BINDINGS_KEY = 'dsh-upstream-terminal-dock-bindings'

/** Adapt the dock's ownership to DSH's terminal service without allocating Rust PTYs. */
export function createUpstreamRegistry(ctx, options = {}) {
  let storage
  try { storage = options.storage === undefined ? window.localStorage : options.storage } catch {}
  let saved = {}
  try { saved = JSON.parse(storage?.getItem(BINDINGS_KEY) || '{}') || {} } catch {}
  const bindings = new Map(Object.entries(saved).filter(([key, value]) =>
    key.startsWith(UPSTREAM_PREFIX) && typeof value?.sessionId === 'string' && (value.cwd === null || typeof value.cwd === 'string')))
  const held = new Set(), views = new Map(), listeners = new Set()
  let explicitShell
  const preferredShell = () => explicitShell ?? options.preferences?.shellPath()
  const service = ctx.webTerminals
  const retainTabs = service.retainTabs
  let sidebarTabs = ctx.sidebarRight.openTabs.getSnapshot().filter(tab => tab.kind === 'terminal')
  const persist = () => { try { storage?.setItem(BINDINGS_KEY, JSON.stringify(Object.fromEntries(bindings))) } catch {} }
  const dockTabs = () => [...held].flatMap(key => {
    const binding = bindings.get(key)
    return binding ? [{ sessionId: binding.sessionId, tabId: key, contentId: key }] : []
  })
  // DSH has one window-wide retention list. Merge at its public entry point so
  // sidebar changes cannot drop the holds of collapsed or inactive dock tabs.
  function retain(tabs) {
    sidebarTabs = tabs
    return retainTabs.call(service, [...tabs, ...dockTabs()])
  }
  service.retainTabs = retain
  const sync = () => retain(sidebarTabs)
  return {
    get sessions() { return [...bindings].map(([resourceKey, value]) => ({ resourceKey, ...value })) },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    hold(key) {
      if (!bindings.has(key)) {
        const sessionId = currentSessionId(ctx.sessions.list.getSnapshot())
        const workspace = createDockWorkspaceSource(ctx).getSnapshot()
        if (!sessionId || !workspace) return
        bindings.set(key, { sessionId, cwd: workspace.cwd, shellPath: preferredShell() }); persist()
      }
      held.add(key); sync()
    },
    matchesShell(key, path) { return bindings.get(key)?.shellPath === path },
    terminalTarget(tab) {
      const key = tab.contentId, binding = bindings.get(key), view = this.view(tab)
      if (!binding || !view) return null
      return {
        sessionId: binding.sessionId, shellPath: binding.shellPath, model: view.model,
        exists: () => bindings.get(key) === binding && views.get(key) === view,
        replace: shellPath => {
          service.close(binding.sessionId, key, key)
          view.off(); views.delete(key)
          binding.shellPath = shellPath; persist()
          // Start now even if the clicked tab is inactive or its project is hidden.
          this.view(tab)
          listeners.forEach(fn => fn())
        },
      }
    },
    withShellPath(path, run) { const previous = explicitShell; explicitShell = path; try { return run() } finally { explicitShell = previous } },
    release(key) {
      const binding = bindings.get(key)
      if (binding) service.close(binding.sessionId, key, key)
      views.get(key)?.off()
      views.delete(key); bindings.delete(key); held.delete(key)
      persist(); sync()
    },
    view(tab) {
      const key = tab.contentId
      if (!views.has(key)) {
        const binding = bindings.get(key)
        if (!binding) return null
        const model = binding.shellPath === undefined ? service.view(binding.sessionId, key, key) : service.view(binding.sessionId, key, key, undefined, binding.shellPath)
        const off = model.state.subscribe(() => listeners.forEach(fn => fn()))
        views.set(key, { model, off })
      }
      return views.get(key)
    },
    dispose() {
      views.forEach(view => view.off()); views.clear(); listeners.clear()
      if (service.retainTabs === retain) {
        service.retainTabs = retainTabs
        retainTabs.call(service, sidebarTabs)
      }
    },
  }
}

/** Render the component registered by DSH itself, with dock-owned tab actions. */
export function createUpstreamBody(React, ctx, typeId, registry) {
  const h = React.createElement
  // entriesOfSlot returns a fresh array; subscribe to the stable entry identity.
  const entrySnapshot = () => ctx.slots.entriesOfSlot('sidebar.right.pane.tab').find(value => value.options.key === typeId)
  const subscribe = fn => ctx.slots.subscribe('sidebar.right.pane.tab', fn)
  const theme = () => ctx.theme.getTheme()
  const themeSubscribe = fn => ctx.on('theme/change', fn)
  return function UpstreamBody({ tab, view, store }) {
      useLocale(React)
    const entry = React.useSyncExternalStore(subscribe, entrySnapshot, entrySnapshot)
    if (!entry || !view) return h('p', { role: 'status' }, t('正在加载 DSH 终端…'))
    const model = view.model
    return h(entry.component, {
      useTabInfo: () => ({ tab: { ...tab, id: tab.contentId, visible: true, actions: {
        openTab(_kind, options) {
          if (options?.replaceTab) store.close(tab.contentId)
          if (registry) registry.withShellPath(options?.params?.shellPath, () => store.add())
          else store.add()
        },
      } } }),
      useTerminal: (_key, select = value => value) => select(React.useSyncExternalStore(model.state.subscribe, model.state.getSnapshot, model.state.getSnapshot)),
      useTheme: (select = value => value) => select(React.useSyncExternalStore(themeSubscribe, theme, theme)),
      view: () => model,
      t: ctx.locale.bind(entry.locale || 'sidebarTerminal'),
    })
  }
}

export function createUpstreamDock(React, ctx, settingsScope, isVanilla, typeId, preferences, primitives) {
  const h = React.createElement
  const registry = createUpstreamRegistry(ctx, { preferences })
  const store = createDockStore(registry, {
    settingsScope, workspaceSource: createDockWorkspaceSource(ctx),
    prefix: UPSTREAM_PREFIX, storageKey: 'dsh-upstream-terminal-dock',
  })
  const Rows = primitives?.MenuItemButton && primitives?.MenuSurface && primitives?.Menu
    ? createTerminalTabMenuRows(React, primitives, ctx.webTerminals) : null
  const offMenu = Rows ? installSidebarTerminalMenu(React, ctx, Rows) : null
  function TabMenu({ tab, point, dismiss }) {
    return h(primitives.Menu, {
      open: true, anchor: null, portal: true, autoFocus: true, onClose: dismiss,
      getAnchorRect: () => ({ left: point.x, right: point.x, top: point.y, bottom: point.y }),
    }, h(Rows, { target: registry.terminalTarget(tab), dismiss }),
    h(primitives.MenuItemButton, { separatorBefore: true, onSelect: () => { dismiss(); store.close(tab.contentId) } }, t('关闭')))
  }
  const ui = {
    TabMenu: Rows ? TabMenu : null,
    Body: createUpstreamBody(React, ctx, typeId, registry),
    tooltip: (_description, child) => child,
    presentation(view) {
      const state = view?.model.state.getSnapshot()
      const info = state?.info
      const labels = { idle: t('等待连接'), loading: t('正在加载'), creating: t('正在启动'), connecting: t('正在连接'), connected: t('已连接'), disconnected: t('连接已断开'), failed: t('连接失败'), closing: t('正在关闭'), closed: t('已关闭') }
      return {
        title: info?.title || state?.title,
        tone: state?.writable ? 'ok' : state?.phase === 'failed' ? 'bad' : 'busy',
        description: [labels[state?.phase] || t('DSH 终端'), info?.cwd, state?.error].filter(Boolean).join(' · '),
      }
    },
    useControls(_view, _bump, { collapse }) {
      return h('div', { className: 'dshTerminal__actions' }, h('button', {
        type: 'button', className: 'dshTerminal__collapse', 'data-dsh-terminal-collapse': true,
        'aria-label': t('收起底部侧边栏'), title: t('收起底部侧边栏'), onClick: collapse,
      }, h('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'currentColor',
        'aria-hidden': 'true', focusable: 'false',
      }, h('path', { d: 'M3.85 5H12.15Q13 5 12.46 5.65L8.54 10.35Q8 11 7.46 10.35L3.54 5.65Q3 5 3.85 5Z' }))))
    },
  }
  return {
    store, registry,
    Component: createDockComponent(React, registry, store, ui, isVanilla),
    Toggle: createDockToggleComponent(React, store, isVanilla),
    dispose() { offMenu?.(); store.dispose(); registry.dispose() },
  }
}
