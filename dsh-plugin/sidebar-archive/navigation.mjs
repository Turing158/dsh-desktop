export const PANEL = 'desktop-archive'

/** Archive browsing owns a main panel; it never opens or unarchives a Session. */
export function createArchiveNavigation(view, workspaces, layout) {
  let selected = null, dead = false
  let snapshot = { only: view.getSnapshot().archivedFilter === 'only', active: layout.panelInfo.getSnapshot().activePanelId === PANEL, sessionId: null }
  const listeners = new Set()
  const publish = () => {
    const next = { only: view.getSnapshot().archivedFilter === 'only', active: layout.panelInfo.getSnapshot().activePanelId === PANEL, sessionId: selected }
    if (Object.keys(next).every(key => next[key] === snapshot[key])) return
    snapshot = next; listeners.forEach(fn => fn())
  }
  const exit = () => {
    selected = null
    view.actions.setArchivedFilter('default')
    if (layout.panelInfo.getSnapshot().activePanelId === PANEL) layout.selectPanel(null)
    publish()
  }
  const offView = view.subscribe(() => {
    if (dead) return
    const only = view.getSnapshot().archivedFilter === 'only'
    if (only !== snapshot.only) {
      publish()
      if (only) layout.selectPanel(PANEL)
      else { selected = null; if (snapshot.active) layout.selectPanel(null) }
    }
    publish()
  })
  const offPanel = layout.panelInfo.subscribe(() => {
    if (dead) return
    const wasActive = snapshot.active
    publish()
    if (wasActive && !snapshot.active) { selected = null; view.actions.setArchivedFilter('default'); publish() }
  })
  const offWorkspaces = workspaces.subscribe(() => {
    if (selected && !workspaces.getSnapshot().archivedSessionIds.includes(selected)) { selected = null; publish() }
  })
  return {
    getSnapshot: () => snapshot,
    subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)),
    isArchived: id => workspaces.getSnapshot().archivedSessionIds.includes(id),
    enter() { view.actions.setArchivedFilter('only'); layout.selectPanel(PANEL); publish() },
    exit,
    toggle() { if (snapshot.only) exit(); else this.enter() },
    open(id) {
      if (dead || !this.isArchived(id)) return false
      selected = id; view.actions.setArchivedFilter('only'); layout.selectPanel(PANEL); publish()
      return true
    },
    dispose() { dead = true; offView(); offPanel(); offWorkspaces(); listeners.clear() },
  }
}
