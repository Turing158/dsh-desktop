import { parseFile } from './protocol.mjs'

/** Native layouts own geometry; the provider carries open files and dirty text. */
export function createStateProvider(ctx, docs) {
  function stores() {
    const handle = ctx.slots.entriesOfSlot('rightbar.session')[0]?.store
    if (!handle?.create) return []
    return ctx.sessions.list.getSnapshot().ids.flatMap(sessionId => {
      const scope = ctx.sessions.scope(sessionId)
      return scope ? [{ sessionId, store: ctx.slots.resolveStore(handle, { key: sessionId, ctx: scope }) }] : []
    })
  }
  return {
    version: 1,
    owns: node => Boolean(node?.closest?.('[data-dsh-file-editor]')),
    ownsSidebar() {
      const current = ctx.sidebarRight.mounted.getSnapshot()
      const tabs = ctx.sidebarRight.openTabs.getSnapshot().filter(tab => tab.sessionId === current)
      return tabs.some(tab => tab.kind === 'text') && tabs.every(tab => tab.kind === 'guide' || tab.kind === 'text')
    },
    capture() {
      const drafts = docs.capture()?.drafts || []
      const sides = stores().flatMap(({ sessionId, store }) => {
        const layout = store.getSnapshot().bySession?.[sessionId]?.layout
        if (!layout) return []
        const tabs = Object.values(layout.tabs).filter(tab => tab.kind === 'text' && parseFile(tab.contentId))
        if (!tabs.length) return []
        return [{ sessionId, expanded: Boolean(layout.expanded), addresses: [...new Set(tabs.map(tab => tab.contentId))],
          active: tabs.find(tab => tab.id === layout.nodes[layout.activePaneId]?.activeTabId)?.contentId || null }]
      })
      return drafts.length || sides.length ? { drafts, sides } : null
    },
    async preflightRestore(saved, { signal }) {
      for (const side of saved.sides || []) {
        if (!stores().some(value => value.sessionId === side.sessionId)) throw Error('snapshot-session-missing')
        if (side.addresses.some(address => !parseFile(address))) throw Error('snapshot-file-address-invalid')
      }
      await docs.preflightRestore(saved, signal)
    },
    restore(saved) {
      docs.restore(saved)
      for (const side of saved.sides || []) {
        const store = stores().find(value => value.sessionId === side.sessionId)?.store
        if (!store) throw Error('snapshot-session-missing')
        const tabs = () => Object.values(store.getSnapshot().bySession?.[side.sessionId]?.layout.tabs || {})
        for (const address of side.addresses) {
          const file = parseFile(address)
          if (!file) throw Error('snapshot-file-address-invalid')
          if (!tabs().some(tab => tab.contentId === address)) store.actions.openContent(side.sessionId, {
            kind: 'text', contentId: address, title: file.path.split(/[\\/]/).at(-1), revealIfOpened: false,
          }, () => {})
        }
        const active = tabs().find(tab => tab.contentId === side.active)
        if (active) store.actions.focusTab(side.sessionId, active.id)
        store.actions.setExpanded(side.sessionId, side.expanded)
      }
    },
  }
}
