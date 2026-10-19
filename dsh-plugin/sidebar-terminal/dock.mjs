import { t, useLocale } from '../i18n/api.mjs'
import { currentSessionId } from './session-context.mjs'
import { createDockMotion } from './dock-motion.mjs'
import { observeChrome } from '../observe-chrome.mjs'

const PREFIX = 'dsh-resource://desktop-terminal/'
const STORAGE_KEY = 'dsh-terminal-dock'
export const DEFAULT_HEIGHT = 240
export const clampHeight = (height, viewport = window.innerHeight) => Math.round(Math.min(Math.max(120, viewport * .6), Math.max(120, Number.isFinite(height) ? height : DEFAULT_HEIGHT)))

/**
 * The left column, found by the stable half of its CSS-module class name.
 *
 * `theme.css` and `ui-overlay/dom.js` already ground the sidebar on
 * `[class*='_sidebarCol']`: the build hashes the PREFIX of a module class and
 * leaves the readable suffix alone, so the suffix is the durable handle and the
 * hash is not. The panel below starts where this column ends, so it needs the
 * same handle — see {@link createDockComponent}'s region effect.
 */
const SIDEBAR_SELECTOR = '[class*="_sidebarCol"]'

/**
 * Marks the header control that opens this panel.
 *
 * The dock's own collapse button unmounts as it collapses, so the control that
 * replaces it has to be findable from outside the header's React tree — see
 * {@link createDockComponent}'s `collapse`.
 */
export const TOGGLE_ATTRIBUTE = 'data-dsh-terminal-dock-toggle'

/** Folder identity stays stable across conversations and workspace renames. */
export function dockWorkspaceKey(cwd) {
  if (!cwd) return 'unassigned'
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd)
  const path = cwd.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return 'folder:' + (windows ? path.toLowerCase() : path)
}

export function createDockWorkspaceSource(ctx) {
  return {
    getSnapshot() {
      const sessions = ctx.sessions.list.getSnapshot(), workspaces = ctx.workspaces.list.getSnapshot()
      const current = currentSessionId(sessions)
      if (sessions.phase !== 'ready' || workspaces.phase !== 'ready' || !current) return null
      const workspace = workspaces.items.find(w => w.sessionIds.includes(current))
      const cwd = workspace?.path || sessions.byId?.[current]?.cwd || null
      return { key: dockWorkspaceKey(cwd), cwd }
    },
    subscribe(listener) {
      const offs = [ctx.sessions.list.subscribe(listener), ctx.workspaces.list.subscribe(listener)]
      return () => offs.forEach(off => off())
    },
  }
}

/** Owns each folder's terminals independently of visibility and React mounts. */
export function createDockStore(registry, options = {}) {
  const prefix = options.prefix || PREFIX, storageKey = options.storageKey || STORAGE_KEY
  let storage
  try { storage = options.storage === undefined ? window.localStorage : options.storage } catch {}
  let saved = {}
  try { saved = JSON.parse(storage?.getItem(storageKey) || '{}') || {} } catch {}
  const scope = options.settingsScope, workspaceSource = options.workspaceSource
  let settingsReady = false, changedLayout = false, pendingLayout = null, writing = false
  const viewport = options.viewport || (() => window.innerHeight)
  const uuid = options.uuid || (() => crypto.randomUUID())
  const buckets = new Map(), claimed = new Set(), owned = new Set()
  let current = null, dead = false, recovering = false, wantTerminal = false
  let requestedMatch = null
  const cleanKeys = keys => (Array.isArray(keys) ? keys : []).filter(key => {
    if (typeof key !== 'string' || !key.startsWith(prefix) || claimed.has(key)) return false
    claimed.add(key); return true
  })
  function bucketFor(workspace) {
    if (!buckets.has(workspace.key)) buckets.set(workspace.key, { cwd: workspace.cwd, pending: [], preferred: null, tabs: [], active: null, serial: 0 })
    return buckets.get(workspace.key)
  }
  if (saved.workspaces && typeof saved.workspaces === 'object') {
    for (const value of Object.values(saved.workspaces)) {
      if (!value || (value.cwd !== null && typeof value.cwd !== 'string')) continue
      const bucket = bucketFor({ key: dockWorkspaceKey(value.cwd), cwd: value.cwd })
      bucket.pending.push(...cleanKeys(value.tabs))
      bucket.preferred ||= value.active
    }
  }
  // Legacy global tabs can be assigned only after native startup directories arrive.
  let legacy = cleanKeys(saved.tabs), legacyPreferred = saved.active
  // Visibility is deliberately not restored. Every app/page launch starts hidden.
  let state = { height: clampHeight(saved.height, viewport()), collapsed: true, workspaceKey: null, cwd: null, tabs: [], active: null, restoring: true }
  const listeners = new Set()
  const record = (bucket, contentId, recovered = false) => ({ contentId, recovered, cwd: bucket.cwd, signal: new AbortController().signal, number: ++bucket.serial })
  function hold(key) { if (!owned.has(key)) { owned.add(key); registry.hold(key) } }
  function release(key) { owned.delete(key); registry.release(key) }
  function refreshState() {
    const bucket = current && bucketFor(current)
    state = { ...state, workspaceKey: current?.key ?? null, cwd: current?.cwd ?? null, tabs: bucket?.tabs || [], active: bucket?.active || null, restoring: !current || legacy.length > 0 || Boolean(bucket?.pending.length) }
  }
  // Local storage restores resource keys within a backend lifetime. DSH chooses
  // a new HTTP port on launch, so geometry also belongs in host settings.
  function flushLayout() {
    if (!scope || !settingsReady || writing || !pendingLayout) return
    const value = pendingLayout; pendingLayout = null; writing = true
    Promise.resolve().then(() => scope.set('layout', value)).catch(() => {
      // Keep the local copy usable when the settings service is unavailable.
    }).finally(() => { writing = false; if (!dead) flushLayout() })
  }
  function publish(layoutChanged = false) {
    if (dead) return
    refreshState()
    const workspaces = Object.fromEntries([...buckets].map(([key, b]) => [key, { cwd: b.cwd, tabs: [...b.pending, ...b.tabs.map(t => t.contentId)], active: b.active || b.preferred || null }]))
    try { storage?.setItem(storageKey, JSON.stringify({ version: 2, height: state.height, workspaces, tabs: legacy, active: legacyPreferred || null })) } catch {}
    // Keep the legacy schema compatible while persisting only the height preference.
    if (layoutChanged) { changedLayout = true; pendingLayout = { height: state.height, collapsed: true }; flushLayout() }
    listeners.forEach(fn => fn())
  }
  function readLayout() {
    if (dead || settingsReady || !scope) return
    const snap = scope.getSnapshot()
    if (snap?.status !== 'ready') return
    settingsReady = true
    // An edit made during loading wins; otherwise the host is authoritative,
    // including when a later launch happens to reuse an old HTTP port.
    if (changedLayout) {
      pendingLayout = { height: state.height, collapsed: true }; flushLayout(); return
    }
    const layout = snap.value?.layout
    if (layout && Number.isFinite(layout.height)) {
      state = { ...state, height: clampHeight(layout.height, viewport()) }; publish()
    }
  }
  function recover() {
    if (dead || recovering || registry.sessions === null || (!legacy.length && ![...buckets.values()].some(b => b.pending.length))) return
    recovering = true
    try {
      const found = new Map(registry.sessions.map(s => [s.resourceKey, s]))
      for (const key of legacy) {
        const info = found.get(key)
        if (!info) { release(key); continue }
        const cwd = info.cwd || null, bucket = bucketFor({ key: dockWorkspaceKey(cwd), cwd })
        bucket.pending.push(key)
        if (key === legacyPreferred) bucket.preferred = key
      }
      legacy = []; legacyPreferred = null
      for (const bucket of buckets.values()) {
        const pending = bucket.pending; bucket.pending = []
        const restored = pending.filter(key => found.has(key)).map(key => record(bucket, key, true))
        bucket.tabs = [...restored, ...bucket.tabs]
        bucket.active ||= (restored.some(t => t.contentId === bucket.preferred) ? bucket.preferred : restored[0]?.contentId) || null
        bucket.preferred = null
        for (const key of pending) if (!found.has(key)) release(key)
      }
    } finally { recovering = false }
    refreshState(); ensureTerminal(); publish()
  }
  function addTab() {
    state = { ...state, collapsed: false }
    if (!current) { wantTerminal = true; publish(); return }
    const bucket = bucketFor(current), tab = record(bucket, prefix + 'dock-' + uuid())
    bucket.tabs = [...bucket.tabs, tab]; bucket.active = tab.contentId
    wantTerminal = false
    hold(tab.contentId); publish(); return tab
  }
  function ensureTerminal() {
    if (!wantTerminal || state.collapsed || state.restoring) return
    wantTerminal = false
    const matches = requestedMatch; requestedMatch = null
    if (matches) {
      const active = state.tabs.find(tab => tab.contentId === state.active)
      const tab = [active, ...state.tabs].find(tab => tab && matches(tab.contentId))
      if (tab) { bucketFor(current).active = tab.contentId; refreshState() }
      else addTab()
    } else if (!state.tabs.length) addTab()
  }
  function readWorkspace() {
    if (dead) return
    const next = workspaceSource ? workspaceSource.getSnapshot() : { key: dockWorkspaceKey(null), cwd: null }
    if (next?.key === current?.key && next?.cwd === current?.cwd) return
    current = next
    if (current) bucketFor(current).cwd = current.cwd
    wantTerminal = !state.collapsed
    refreshState(); ensureTerminal(); publish()
  }
  // All folders retain ownership, including those not currently displayed.
  for (const key of [...legacy, ...[...buckets.values()].flatMap(b => b.pending)]) hold(key)
  const off = registry.subscribe(recover)
  const offSettings = scope?.subscribe(readLayout)
  const offWorkspace = workspaceSource?.subscribe(readWorkspace)
  readWorkspace()
  readLayout()
  recover()
  return {
    getSnapshot: () => state,
    // The remote-apply snapshot crosses HTTP origins in native memory. Only
    // resource identities and presentation are copied, never shell input/output.
    capture(liveKeys) {
      return {
        height: state.height, collapsed: state.collapsed, shortcutVisible: Boolean(state.shortcutVisible),
        workspaces: [...buckets.values()].map(b => ({
          cwd: b.cwd,
          tabs: [...b.pending, ...b.tabs.map(t => t.contentId)].filter(key => liveKeys.has(key)),
          active: b.active || b.preferred || null,
        })).filter(b => b.tabs.length).map(b => ({ ...b, active: b.tabs.includes(b.active) ? b.active : b.tabs[0] })),
      }
    },
    restore(saved) {
      const incoming = new Set(saved.workspaces.flatMap(b => b.tabs))
      for (const key of incoming) hold(key)
      for (const key of [...owned]) if (!incoming.has(key)) release(key)
      buckets.clear(); legacy = []; legacyPreferred = null
      for (const value of saved.workspaces) {
        const bucket = bucketFor({ key: dockWorkspaceKey(value.cwd), cwd: value.cwd })
        bucket.tabs = value.tabs.map(key => record(bucket, key, true))
        bucket.active = value.active
      }
      state = { ...state, height: clampHeight(saved.height, viewport()), collapsed: saved.collapsed, shortcutVisible: saved.shortcutVisible }
      wantTerminal = false; requestedMatch = null
      publish()
    },
    subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)),
    add: addTab,
    /**
     * Reveal the panel, starting a terminal when it holds nothing to show.
     *
     * This is what the header's 打开底部侧边栏 control calls. Seeding the terminal
     * HERE rather than in the caller keeps the rule in one place: an empty panel
     * that is asked for is a panel the user wants to type in, so opening it and
     * starting a shell are one action.
     *
     * A panel that is STILL RECOVERING is left alone. Its addresses are about to
     * arrive from the native session list, so seeding now would add a shell beside
     * the ones being restored rather than instead of them.
     */
    open() {
      if (!state.collapsed && state.tabs.length > 0) return
      state = { ...state, collapsed: false }; wantTerminal = true
      ensureTerminal(); publish()
    },
    openMatching(matches) {
      requestedMatch = matches
      state = { ...state, collapsed: false, shortcutVisible: true }; wantTerminal = true
      ensureTerminal(); publish()
    },
    resetShortcutVisibility() { if (state.shortcutVisible) { state = { ...state, shortcutVisible: false }; publish() } },
    activate(key) { if (current && state.tabs.some(t => t.contentId === key)) { const bucket = bucketFor(current); bucket.active = key; bucket.preferred = null; publish() } },
    close(key) {
      const index = state.tabs.findIndex(t => t.contentId === key)
      if (index < 0) return
      const bucket = bucketFor(current), tabs = state.tabs.filter(t => t.contentId !== key)
      bucket.tabs = tabs
      bucket.active = state.active === key ? (tabs[Math.min(index, tabs.length - 1)]?.contentId || null) : state.active
      wantTerminal = false; requestedMatch = null
      // Keep an emptied dock hidden until the next explicit open seeds a tab.
      if (!tabs.length) state = { ...state, collapsed: true }
      release(key); publish()
    },
    resize(height) { const next = clampHeight(height, viewport()); if (next !== state.height) { state = { ...state, height: next }; publish(true) } },
    collapse(value) { if (!value) { this.open(); return } if (!state.collapsed) { wantTerminal = false; requestedMatch = null; state = { ...state, collapsed: true }; publish() } },
    // Reload detaches consumers; it must never release the persisted owners.
    dispose() { dead = true; off(); offSettings?.(); offWorkspace?.(); listeners.clear() },
  }
}

/**
 * Where the panel's region begins: the left column's right edge.
 *
 * WHY THIS IS MEASURED RATHER THAN READ FROM A TOKEN. The sidebar's width is an
 * inline `grid-template-columns` px value the frame solves at runtime — 264–420
 * dragged, 56 on the rail, and re-solved whenever the viewport crosses the
 * auto-collapse breakpoint. There is no variable to read and no arithmetic that
 * reproduces the solver, so the answer is taken from the box that already has it.
 *
 * Observe the sidebar's actual size: the frame's grid transition continues after
 * React writes its inline style, and rapid toggles can reverse it mid-flight.
 * A mutation-only measurement would leave the dock at an intermediate width.
 * Keep the frame observer too, to rebind when a breakpoint replaces the sidebar.
 *
 * @param doc - the document to read and publish to.
 * @returns a disposer undoing the property and observers/listener.
 */
function trackLeftEdge(doc) {
  // Defensive for the same reason every other cross-boundary read here is: a
  // document without the query API (a stub, or a page the app has not mounted
  // into) must leave the panel usable at its default edge rather than throw
  // during a render.
  if (typeof doc.querySelector !== 'function') return () => {}
  const panel = doc.querySelector('[data-dsh-terminal-dock]')
  if (!panel) return () => {}
  let sidebar = null, previousLeft = null, disposed = false
  // This property is consumed by one fixed panel. Writing it on <html> during
  // every grid frame invalidates inherited styles across the entire transcript.
  const measure = () => {
    if (disposed) return
    const next = doc.querySelector(SIDEBAR_SELECTOR)
    if (next !== sidebar) {
      if (sidebar) sizes?.unobserve(sidebar)
      sidebar = next
      if (sidebar) sizes?.observe(sidebar, { box: 'border-box' })
    }
    // Before the app mounts there is no left column, and the panel starts at the
    // window's edge: the app's own boot state, corrected on the first mutation.
    const left = sidebar ? Math.max(0, Math.round(sidebar.getBoundingClientRect().right)) : 0
    if (left !== previousLeft) {
      panel.style.setProperty('left', left + 'px')
      previousLeft = left
    }
  }
  const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
  measure()
  const layer = doc.querySelector('[data-shell-overlay]')
  // The overlay layer is a DIRECT child of the frame (the same relation theme.css
  // grounds its frame selectors on), so its parent is the frame without a
  // build-specific class name being named here.
  const frame = layer?.parentElement || null
  const observer = frame && typeof MutationObserver === 'function'
    ? new MutationObserver(measure)
    : null
  observer?.observe(frame, { attributes: true, attributeFilter: ['style', 'data-sidebar-collapsed', 'data-dragging'], childList: true })
  window.addEventListener('resize', measure)
  return () => {
    disposed = true
    sizes?.disconnect()
    observer?.disconnect()
    window.removeEventListener('resize', measure)
    panel.style.removeProperty('left')
  }
}

export function createDockComponent(React, registry, store, ui, isVanilla) {
  const h = React.createElement
  return function TerminalDock() {
      useLocale(React)
    const [, bump] = React.useReducer(n => n + 1, 0)
    const [focused, setFocused] = React.useState(null)
    const [tabMenu, setTabMenu] = React.useState(null)
    const host = React.useRef(null), root = React.useRef(null), drag = React.useRef(null), plus = React.useRef(null), collapseRef = React.useRef(null)
    const state = store.getSnapshot(), hidden = (isVanilla() && !state.shortcutVisible) || state.workspaceKey === null
    const open = !hidden && !state.collapsed
    const [present, setPresent] = React.useState(false)
    const motion = React.useRef(null)
    const rendered = !hidden && (open || present)
    React.useEffect(() => { setTabMenu(null) }, [state.workspaceKey, state.collapsed, hidden])
    const desktop = Boolean(window.__TAURI__?.core?.Channel)
    const active = state.tabs.find(t => t.contentId === state.active)
    const v = desktop && active ? registry.view(active) : null
    // The native terminal already supports a retained, non-visible tab. Keep its
    // emulator for reopening this tab instead of rebuilding xterm on every click.
    const retained = React.useRef(null)
    if (hidden || retained.current !== active?.contentId) retained.current = null
    if (open && ui.Body && active) retained.current = active.contentId
    const mounted = rendered || (!hidden && retained.current !== null)
    // DSH versions using React 18 omit an unknown boolean `inert` prop. Set the
    // native property so closing/retained terminals cannot receive focus there.
    React.useLayoutEffect(() => { if (root.current) root.current.inert = !open }, [open, mounted])
    React.useEffect(() => {
      const offs = [store.subscribe(bump), registry.subscribe(bump)]
      const resize = () => { store.resize(store.getSnapshot().height); bump() }
      const mode = () => { store.resetShortcutVisibility(); bump() }
      document.addEventListener('dsh-desktop:ui-mode', mode)
      window.addEventListener('resize', resize)
      return () => { offs.forEach(off => off()); document.removeEventListener('dsh-desktop:ui-mode', mode); window.removeEventListener('resize', resize) }
    }, [])
    // The region: this panel is the frame's bottom strip MINUS the left column,
    // which keeps its full height. Only the visible panel needs this measurement.
    React.useLayoutEffect(() => rendered ? trackLeftEdge(document) : undefined, [rendered])
    React.useLayoutEffect(() => {
      motion.current = createDockMotion(document, () => setPresent(false))
      return () => { motion.current.dispose(); motion.current = null }
    }, [])
    React.useLayoutEffect(() => {
      if (open) setPresent(true)
      motion.current.update(open, state.height, root.current, hidden)
    }, [open, hidden, state.height])
    React.useLayoutEffect(() => {
      if (!ui.Body && rendered && v && host.current) v.mount(host.current)
      return () => { if (!ui.Body) v?.unmount() }
    }, [v, rendered])
    React.useLayoutEffect(() => {
      if (open) root.current?.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }, [state.active, state.collapsed, hidden])
    const focusTab = key => queueMicrotask(() => {
      if (store.getSnapshot().collapsed) {
        document.querySelector('[' + TOGGLE_ATTRIBUTE + ']')?.focus()
        return
      }
      const button = [...(root.current?.querySelectorAll('[role="tab"]') || [])].find(el => el.dataset.resourceKey === key)
      ;(button || plus.current)?.focus()
    })
    const close = key => { store.close(key); focusTab(store.getSnapshot().active) }
    // Collapsing unmounts this button, so focus is handed to the control that
    // replaces it: the header's 打开底部侧边栏 button. Losing it to the body would
    // send a keyboard user back to the top of the document.
    const collapse = () => {
      store.collapse(true)
      queueMicrotask(() => document.querySelector('[' + TOGGLE_ATTRIBUTE + ']')?.focus())
    }
    const controls = ui.useControls(v, bump, { dock: true, collapse })
    const fallback = tab => registry.sessions?.find(s => s.resourceKey === tab?.contentId)
    const tabPresentation = tab => {
      const info = ui.presentation(desktop ? registry.view(tab) : null, desktop, fallback(tab))
      const title = (typeof info.title === 'string' && info.title.trim()) || t('终端 ') + tab.number
      return { ...info, title, description: [title, info.description].filter(Boolean).join('\n') }
    }
    // A retained native terminal is display:none and inert after its closing
    // slide. It reserves no space and cannot take focus or keyboard input.
    if (!mounted) return null
    const tabKey = (e, tab) => {
      if (ui.TabMenu && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
        e.preventDefault(); e.stopPropagation()
        const rect = e.currentTarget.getBoundingClientRect()
        setTabMenu({ tab, point: { x: rect.left, y: rect.bottom } }); return
      }
      if (e.key === 'Escape') { setFocused(null); return }
      if (e.key === 'Delete') { e.preventDefault(); close(tab.contentId); return }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const index = state.tabs.indexOf(tab), count = state.tabs.length
      const next = state.tabs[e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : (index + (e.key === 'ArrowLeft' ? -1 : 1) + count) % count]
      store.activate(next.contentId); focusTab(next.contentId)
    }
    const endDrag = e => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }
    // The section id is the disclosure target the header toggle's `aria-controls`
    // names; a retained native terminal remains a hidden disclosure target.
    return h('section', { className: 'dshTerminalDock dshTerminal', ref: root, 'data-dsh-terminal-dock': true, id: 'dsh-terminal-dock', 'aria-label': t('底部终端'), 'aria-hidden': open ? undefined : true, style: { height: state.height, display: rendered ? undefined : 'none' } },
      h('div', {
        className: 'dshTerminalDock__resize', role: 'separator', tabIndex: 0, 'aria-orientation': 'horizontal', 'aria-label': t('调整终端面板高度'),
        'aria-valuemin': 120, 'aria-valuemax': Math.max(120, Math.floor(window.innerHeight * .6)), 'aria-valuenow': state.height,
        title: t('拖动调整高度；双击或 Home 重置；方向键调整，End 最大化高度'),
        onPointerDown: e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); drag.current = { y: e.clientY, height: state.height }; e.currentTarget.setPointerCapture(e.pointerId) },
        onPointerMove: e => { if (drag.current) store.resize(drag.current.height + drag.current.y - e.clientY) },
        onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: () => { drag.current = null },
        onDoubleClick: () => store.resize(DEFAULT_HEIGHT),
        onKeyDown: e => { const value = { ArrowUp: state.height + 20, ArrowDown: state.height - 20, Home: DEFAULT_HEIGHT, End: window.innerHeight * .6 }[e.key]; if (value !== undefined) { e.preventDefault(); store.resize(value) } },
      }),
      h('div', { className: 'dshTerminalDock__bar' },
        h('div', { className: 'dshTerminalDock__tabs', role: 'tablist', 'aria-label': t('底部终端标签') }, state.tabs.map(tab => {
          const info = tabPresentation(tab), title = info.title, selected = state.active === tab.contentId
          return h('div', { key: tab.contentId, className: 'dshTerminalDock__tab', 'data-active': selected,
            onContextMenu: ui.TabMenu ? e => {
              e.preventDefault(); e.stopPropagation(); setFocused(null)
              setTabMenu({ tab, point: { x: e.clientX, y: e.clientY } })
            } : undefined,
          },
            ui.tooltip(info.description, h('button', {
              type: 'button', role: 'tab', id: 'dock-tab-' + tab.number, 'aria-controls': 'dsh-terminal-dock-viewport',
              'aria-selected': selected, tabIndex: selected ? 0 : -1, 'aria-label': info.description,
              className: 'dshTerminalDock__label', 'data-resource-key': tab.contentId, 'data-dsh-terminal-tone': info.tone,
              'aria-describedby': focused?.key === tab.contentId ? 'dsh-terminal-dock-tip' : undefined,
              onFocus: e => setFocused({ key: tab.contentId, x: e.currentTarget.getBoundingClientRect().left }), onBlur: () => setFocused(null),
              title: info.description, onClick: () => store.activate(tab.contentId), onKeyDown: e => tabKey(e, tab),
            }, h('span', { className: 'dshTerminal__dot', 'aria-hidden': 'true' }), h('span', { className: 'dshTerminalDock__title' }, title))),
            h('button', { type: 'button', className: 'dshTerminalDock__close', 'aria-label': t('关闭') + title, title: t('关闭') + title, onClick: () => close(tab.contentId) }, '×'),
            h('span', { className: 'dshTerminalDock__sr', role: 'status' }, info.description))
        })),
        h('button', { type: 'button', ref: plus, className: 'dshTerminalDock__add', 'aria-label': t('新建终端'), title: t('新建终端'), onClick: () => store.add() }, '+'),
        controls),
      ui.TabMenu && tabMenu && state.tabs.includes(tabMenu.tab) && h(ui.TabMenu, {
        key: tabMenu.tab.contentId, ...tabMenu, dismiss: () => { setTabMenu(null); focusTab(tabMenu.tab.contentId) },
      }),
      focused && state.tabs.some(t => t.contentId === focused.key) && h('div', {
        id: 'dsh-terminal-dock-tip', role: 'tooltip', className: 'dshTerminalDock__tooltip',
        style: { left: Math.max(4, Math.min(focused.x, window.innerWidth - 324)), bottom: state.height + 6, maxHeight: Math.max(40, window.innerHeight - state.height - 54) },
      }, tabPresentation(state.tabs.find(t => t.contentId === focused.key)).description),
      // The notice row is GONE, and its absence is the point: a terminal that has
      // gone wrong reports itself through the tab's dot and its tooltip (the
      // `ui.tooltip(info.description, …)` on the tab above), never by pushing a
      // sentence into the layout. `presentation()` no longer returns a `notice`
      // field at all, so there is nothing here to gate on — the row is deleted
      // rather than left as a dead `&&` that a later reader would take for a live
      // path.
      h('div', { className: 'dshTerminal__viewport', id: 'dsh-terminal-dock-viewport', role: 'tabpanel', 'aria-labelledby': active ? 'dock-tab-' + active.number : undefined, ref: host },
        active && desktop && ui.Body && h(ui.Body, { key: active.contentId, tab: active, view: v, store, visible: open }),
        !active && h('p', { className: 'dshTerminalDock__empty' }, state.restoring ? t('正在恢复终端…') : t('点击 + 新建终端')),
        active && !desktop && h('p', { className: 'dshTerminalDock__empty' }, t('请在桌面应用中打开终端。'))))
  }
}

/**
 * The header control that opens AND closes the panel.
 *
 * ## One control for both directions
 *
 * The user's ask, verbatim: an icon button immediately left of the shipped
 * 打开侧边栏 control that opens and closes the bottom panel. It started life
 * open-only — while the panel was shown it rendered nothing, deferring to the
 * panel's own 收起 control the way the shipped sidebar defers to its tab strip —
 * but a way out that vanishes with the panel is no way out at all, so it now
 * stays mounted in BOTH states and toggles. The panel's own 收起 control remains
 * beside the dock's other actions; this button is the row's way in and out.
 *
 * The label names the ACTION (打开 while closed, 收起 while open) rather than the
 * state, and `aria-expanded` carries the state itself — pointing at the dock
 * section by id, which is what makes the button a disclosure control rather than
 * a pressed one.
 *
 * @param React - the React instance the plugin's client half was handed.
 * @param store - the dock store, which owns the collapsed flag.
 * @param isVanilla - reads the live UI mode; 原版 shows none of this chrome.
 * @returns the component the utilities seat renders.
 */
export function createDockToggleComponent(React, store, isVanilla) {
  const h = React.createElement
  // Keep the glyph in the injected React instance's scope. Its bottom divider
  // matches the rounded panel icon used by the neighboring sidebar control.
  function BottomPanelGlyph() {
    return h('svg', {
      width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true', focusable: 'false',
    },
      h('rect', { x: 1.65, y: 2.15, width: 12.7, height: 11.7, rx: 2.4 }),
      h('path', { d: 'M1.65 10.3h12.7' }),
    )
  }
  return function TerminalDockToggle() {
      useLocale(React)
    const [, bump] = React.useReducer(n => n + 1, 0)
    React.useEffect(() => {
      const off = store.subscribe(bump)
      // THE MODE EVENT IS REQUIRED, not belt-and-braces. This control reads the mode
      // during render, so it is only as fresh as its last render — and the store
      // notifies on store changes alone. Without this listener a switch to 原版 would
      // leave the button mounted until something unrelated happened to re-render the
      // header: the project's own control sitting in the frontend it is supposed to
      // leave alone, and unstyled, because the stylesheet's gate stops matching it.
      document.addEventListener('dsh-desktop:ui-mode', bump)
      return () => { off(); document.removeEventListener('dsh-desktop:ui-mode', bump) }
    }, [])
    const state = store.getSnapshot()
    // 原版 means the unmodified frontend: the panel is this project's addition, so
    // the control is withheld with it rather than left as a button that appears to
    // do nothing. In desktop mode it is ALWAYS here, in both panel states — that is
    // the point of the change.
    if (isVanilla()) return null
    const open = !state.collapsed
    return h('button', {
      type: 'button', className: 'dshTerminal__dockToggle', [TOGGLE_ATTRIBUTE]: true,
      'aria-label': open ? t('收起底部侧边栏') : t('打开底部侧边栏'),
      title: open ? t('收起底部侧边栏') : t('打开底部侧边栏'),
      'aria-expanded': open, 'aria-controls': 'dsh-terminal-dock',
      // Pointer-down is suppressed for the reason every other control in this app
      // does it: taking focus here would drop the composer's selection and with it
      // a pending Ctrl+C/V.
      onMouseDown: event => { event.preventDefault() },
      onClick: () => (open ? store.collapse(true) : store.open()),
    }, h(BottomPanelGlyph))
  }
}

/** DSH hides header utilities before the first message; keep the dock reachable beside its corner. */
export function createDockFallbackToggle(React, reactDom, Toggle) {
  return function DockFallbackToggle() {
    const [host, setHost] = React.useState(null)
    React.useLayoutEffect(() => {
      const node = document.createElement('span')
      node.setAttribute('data-dsh-dock-toggle-fallback', '')
      node.style.cssText = 'display:inline-flex;align-items:center;margin-left:auto'
      const sync = () => {
        const regular = [...document.querySelectorAll('[' + TOGGLE_ATTRIBUTE + ']')].some(button => !node.contains(button))
        const corner = document.querySelector('[data-conversation-header-corner]')
        if (corner && !regular) {
          if (node.nextSibling !== corner) corner.before(node)
          setHost(node)
        } else {
          node.remove()
          setHost(null)
        }
      }
      const observer = observeChrome('[data-conversation-header-corner], [' + TOGGLE_ATTRIBUTE + ']', sync)
      sync()
      return () => { observer.disconnect(); node.remove() }
    }, [])
    return host ? reactDom.createPortal(React.createElement(Toggle), host) : null
  }
}
