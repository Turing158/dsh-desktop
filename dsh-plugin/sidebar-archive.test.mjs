import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchiveNavigation, PANEL } from './sidebar-archive/navigation.mjs'
import { rowSessionId } from './sidebar-archive/sidebar.mjs'

function store(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { snapshot = { ...snapshot, ...next }; listeners.forEach(fn => fn()) },
    count: () => listeners.size,
  }
}
function fixture() {
  const view = store({ archivedFilter: 'default', groupBy: 'workspace-tree', orderBy: 'manual' })
  view.actions = { setArchivedFilter: archivedFilter => view.set({ archivedFilter }) }
  const workspaces = store({ archivedSessionIds: ['a', 'b'] })
  const panelInfo = store({ activePanelId: null })
  const layout = { panelInfo, selectPanel: activePanelId => panelInfo.set({ activePanelId }) }
  return { view, workspaces, layout, nav: createArchiveNavigation(view, workspaces, layout) }
}

test('archive entry keeps native grouping and allows only archived history; exit restores workspace', () => {
  const { nav, view, workspaces, layout } = fixture()
  assert.equal(nav.open('active-session'), false)
  nav.toggle()
  assert.deepEqual(nav.getSnapshot(), { only: true, active: true, sessionId: null })
  assert.equal(view.getSnapshot().groupBy, 'workspace-tree')
  assert.equal(view.getSnapshot().orderBy, 'manual')
  assert.equal(layout.panelInfo.getSnapshot().activePanelId, PANEL)
  assert.equal(nav.open('a'), true)
  assert.equal(nav.getSnapshot().sessionId, 'a')
  assert.equal(nav.open('b'), true)
  assert.equal(nav.getSnapshot().sessionId, 'b')
  assert.deepEqual(workspaces.getSnapshot().archivedSessionIds, ['a', 'b'])
  nav.toggle()
  assert.deepEqual(nav.getSnapshot(), { only: false, active: false, sessionId: null })
  assert.equal(view.getSnapshot().archivedFilter, 'default')
})

test('native filter and external navigation stay synchronized with archive mode', () => {
  const { nav, view, layout } = fixture()
  view.actions.setArchivedFilter('only')
  assert.equal(nav.getSnapshot().active, true)
  nav.open('a')
  layout.selectPanel('settings')
  assert.deepEqual(nav.getSnapshot(), { only: false, active: false, sessionId: null })
  assert.equal(layout.panelInfo.getSnapshot().activePanelId, 'settings')
  nav.enter(); nav.open('a')
  view.actions.setArchivedFilter('show')
  assert.deepEqual(nav.getSnapshot(), { only: false, active: false, sessionId: null })
})

test('restoring or removing the selected archive closes its content but keeps archive browsing', () => {
  const { nav, workspaces } = fixture()
  nav.open('a')
  workspaces.set({ archivedSessionIds: ['b'] })
  assert.deepEqual(nav.getSnapshot(), { only: true, active: true, sessionId: null })
  assert.equal(nav.open('a'), false)
  workspaces.set({ archivedSessionIds: [] })
  assert.equal(nav.getSnapshot().only, true)
})

test('navigation releases subscriptions on disposal and refuses further opens', () => {
  const { nav, view, workspaces, layout } = fixture()
  let changes = 0
  nav.subscribe(() => changes++)
  nav.open('a'); nav.exit(); nav.dispose()
  const before = changes
  assert.equal(view.count(), 0); assert.equal(workspaces.count(), 0); assert.equal(layout.panelInfo.count(), 0)
  assert.equal(nav.open('a'), false)
  view.actions.setArchivedFilter('only')
  assert.equal(changes, before)
})

test('row identity uses native row keys and bounded search-result ancestry', () => {
  assert.equal(rowSessionId({ getAttribute: () => 'session:a' }), 'a')
  const search = { getAttribute: () => null, '__reactFiber$fixture': { return: { memoizedProps: { result: { id: 'b' } } } } }
  assert.equal(rowSessionId(search), 'b')
  assert.equal(rowSessionId({ getAttribute: () => 'workspace:a' }), null)
})
