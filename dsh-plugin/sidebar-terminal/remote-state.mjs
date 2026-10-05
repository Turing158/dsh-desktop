import { currentSessionId } from './session-context.mjs'

const PREFIX = 'dsh-resource://desktop-terminal/'
const isTerminal = tab => tab?.kind === 'desktop-terminal' || tab?.contentId === 'sidebar://desktop-terminal' || tab?.contentId?.startsWith(PREFIX)

function sidebarStores(ctx) {
  const list = ctx.sessions.list.getSnapshot()
  const entry = ctx.slots.entriesOfSlot('rightbar.session')[0]
  const handle = entry?.store || entry?.options?.store
  if (list.phase !== 'ready' || !handle?.create) return []
  return list.ids.flatMap(sessionId => {
    // DSH 0.2 lists dormant sessions before their client scopes are retained.
    // resolveStore needs a live scope; revisit these sessions on the next sync.
    const scope = ctx.sessions.scope(sessionId)
    return scope ? [{ sessionId, store: ctx.slots.resolveStore(handle, { key: sessionId, ctx: scope }) }] : []
  })
}

function sidebarState(ctx, liveKeys) {
  return sidebarStores(ctx).flatMap(({ sessionId, store }) => {
    const layout = store.getSnapshot().bySession?.[sessionId]?.layout
    if (!layout) return []
    const tabs = Object.values(layout.tabs).filter(tab => liveKeys.has(tab.contentId))
    if (!tabs.length) return []
    const activeId = layout.nodes[layout.activePaneId]?.activeTabId
    return [{ sessionId, tabs: tabs.map(tab => tab.contentId),
      active: tabs.find(tab => tab.id === activeId)?.contentId || null, expanded: Boolean(layout.expanded) }]
  })
}

/** Snapshot provider for desktop terminals during an in-process DSH restart. */
export function createRemoteState(ctx, registry, dock) {
  return {
    version: 1,
    owns: node => Boolean(node?.closest?.('[data-dsh-terminal], [data-dsh-terminal-dock]')),
    ownsSidebar() {
      const current = currentSessionId(ctx.sessions.list.getSnapshot())
      const store = sidebarStores(ctx).find(value => value.sessionId === current)?.store
      const tabs = Object.values(store?.getSnapshot().bySession?.[current]?.layout.tabs || {})
      return tabs.some(isTerminal) && tabs.every(tab => isTerminal(tab) || tab.kind === 'guide')
    },
    async capture() {
      const sessions = await registry.snapshotSessions()
      if (!sessions.length) return null
      const keys = new Set(sessions.map(s => s.resourceKey))
      return {
        sessions: sessions.map(({ resourceKey, terminalId, runId }) => ({ resourceKey, terminalId, runId })).sort((a, b) => a.resourceKey.localeCompare(b.resourceKey)),
        dock: dock.capture(keys), sidebar: sidebarState(ctx, keys),
      }
    },
    async restore(saved) {
      const live = await registry.snapshotSessions()
      // Never turn a missing or restarted session into a new shell or rerun input.
      if (saved.sessions.some(s => !live.some(v => v.resourceKey === s.resourceKey && v.terminalId === s.terminalId && v.runId === s.runId))) throw Error('snapshot-terminal-missing')
      const stores = sidebarStores(ctx)
      if (saved.sidebar.some(s => !stores.some(v => v.sessionId === s.sessionId))) throw Error('snapshot-session-missing')
      dock.restore(saved.dock)
      for (const side of saved.sidebar) {
        const store = stores.find(s => s.sessionId === side.sessionId).store
        const tabs = () => Object.values(store.getSnapshot().bySession?.[side.sessionId]?.layout.tabs || {})
        const counts = new Map()
        for (const key of side.tabs) {
          const count = (counts.get(key) || 0) + 1; counts.set(key, count)
          if (tabs().filter(t => t.contentId === key).length < count) {
            store.actions.openContent(side.sessionId, { kind: 'desktop-terminal', contentId: key, title: '终端', revealIfOpened: false }, () => {})
          }
        }
        const active = tabs().find(tab => tab.contentId === side.active)
        if (active) store.actions.focusTab(side.sessionId, active.id)
        else if (side.active === null) {
          const other = tabs().find(tab => !isTerminal(tab))
          if (other) store.actions.focusTab(side.sessionId, other.id)
          else store.actions.openContent(side.sessionId, { kind: 'guide', contentId: 'sidebar://guide', title: '开始' }, () => {})
        }
        store.actions.setExpanded(side.sessionId, side.expanded)
      }
    },
  }
}

/** Remove disabled desktop tabs locally, preserving upstream tabs and native processes. */
export function hideDesktopTerminals(ctx) {
  const watched = new Map()
  let busy = false, dead = false
  function clean() {
    if (dead || busy) return
    busy = true
    try {
      const stores = sidebarStores(ctx)
      for (const [store, off] of watched) if (!stores.some(value => value.store === store)) { off(); watched.delete(store) }
      for (const { sessionId, store } of stores) {
        if (!watched.has(store)) watched.set(store, store.subscribe(clean))
        const tabs = Object.values(store.getSnapshot().bySession?.[sessionId]?.layout.tabs || {})
        for (const tab of tabs) if (isTerminal(tab)) store.actions.closeTab(sessionId, tab.id)
      }
    } finally { busy = false }
  }
  const offSessions = ctx.sessions.list.subscribe(clean)
  const timer = setInterval(clean, 1000)
  clean()
  return () => { dead = true; offSessions(); clearInterval(timer); watched.forEach(off => off()); watched.clear() }
}
