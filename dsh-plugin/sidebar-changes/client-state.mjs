import { VIEWS } from './shared/change-model.mjs'
import { FILE_KIND, parseChangeAddress, changeTitle } from './file-resource.mjs'
const PREFIX = 'dsh-resource://desktop-changes/'
export function migrateFileIds(ids, entries) {
  return [...new Set(ids.flatMap(id => {
    const exact = entries.find(entry => entry.fileId === id)
    if (exact) return [exact.fileId]
    const matches = entries.filter(entry => entry.aliases?.includes(id))
    return matches.length === 1 ? [matches[0].fileId] : []
  }))]
}
/** Each view writes only its own state, even while a sibling is mounting. */
export function createViewStates(states, view) {
  return {
    get(key) {
      const saved = states.get(key)
      const { views, ...legacy } = saved || {}
      return views?.[view] || (saved?.source === view ? legacy : { source: view, fileId: null, listScroll: 0, detailScroll: 0 })
    },
    set(key, value) {
      const saved = states.get(key) || { source: view }
      states.set(key, { ...saved, views: { ...saved.views, [view]: value } })
    },
  }
}
export const isChanges = tab => tab?.kind === 'desktop-changes' && tab.contentId?.startsWith(PREFIX)
  || tab?.kind === FILE_KIND && Boolean(parseChangeAddress(tab.contentId))
function stores(ctx) {
  const handle = ctx.slots.entriesOfSlot('rightbar.session')[0]?.store
  if (!handle?.create) return []
  return ctx.sessions.list.getSnapshot().ids.flatMap(sessionId => {
    const scope = ctx.sessions.scope(sessionId)
    return scope ? [{ sessionId, store: ctx.slots.resolveStore(handle, { key: sessionId, ctx: scope }) }] : []
  })
}
export function createStateProvider(ctx, states) {
  return {
    version: 1,
    owns: node => Boolean(node?.closest?.('[data-dsh-changes]')),
    ownsSidebar() {
      const list = ctx.sessions.list.getSnapshot(), current = list.current ?? Object.values(list.byId || {}).find(row => row.retainedBy?.mainView > 0)?.id
      const surface = stores(ctx).find(value => value.sessionId === current)
      const tabs = Object.values(surface?.store.getSnapshot().bySession?.[current]?.layout.tabs || {})
      return tabs.some(isChanges) && tabs.every(tab => isChanges(tab) || tab.kind === 'guide')
    },
    capture() {
      const sides = []
      for (const { sessionId, store } of stores(ctx)) {
        const layout = store.getSnapshot().bySession?.[sessionId]?.layout
        if (!layout) continue
        const tabs = Object.values(layout.tabs).filter(isChanges)
        if (!tabs.length) continue
        // Geometry stays in the native sidebar store; only content state belongs here.
        sides.push({ sessionId, expanded: Boolean(layout.expanded), tabs: tabs.map(tab => ({ address: tab.contentId, state: states.get(sessionId + '\0' + tab.contentId) || { source: parseChangeAddress(tab.contentId)?.source || 'session', fileId: null, listScroll: 0, detailScroll: 0 } })),
          active: tabs.find(tab => layout.nodes[layout.activePaneId]?.activeTabId === tab.id)?.contentId || null })
      }
      return sides.length ? { sides } : null
    },
    preflightRestore(saved) {
      for (const side of saved.sides) {
        if (!stores(ctx).some(value => value.sessionId === side.sessionId)) throw Error('snapshot-session-missing')
        for (const tab of side.tabs) {
          if ((!parseChangeAddress(tab.address) && !tab.address.startsWith(PREFIX)) || !VIEWS.includes(tab.state.source)) throw Error('snapshot-panel-unsupported')
        }
      }
    },
    async restore(saved) {
      for (const side of saved.sides) {
        const store = stores(ctx).find(value => value.sessionId === side.sessionId)?.store
        if (!store) throw Error('snapshot-session-missing')
        const tabs = () => Object.values(store.getSnapshot().bySession?.[side.sessionId]?.layout.tabs || {})
        for (const tab of side.tabs) {
          const file = parseChangeAddress(tab.address)
          if ((!file && !tab.address.startsWith(PREFIX)) || !VIEWS.includes(tab.state.source)) throw Error('snapshot-panel-unsupported')
          states.set(side.sessionId + '\0' + tab.address, tab.state)
          if (!tabs().some(value => value.contentId === tab.address)) store.actions.openContent(side.sessionId,
            { kind: file ? FILE_KIND : 'desktop-changes', contentId: tab.address, title: file ? changeTitle(tab.address) : '更改', revealIfOpened: false }, () => {})
        }
        const active = tabs().find(tab => tab.contentId === side.active)
        if (active) store.actions.focusTab(side.sessionId, active.id)
        store.actions.setExpanded(side.sessionId, side.expanded)
      }
      document.dispatchEvent(new Event('dsh-desktop:changes-restore'))
    },
  }
}
