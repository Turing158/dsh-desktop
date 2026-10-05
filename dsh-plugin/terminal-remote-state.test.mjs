import test from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteState, hideDesktopTerminals } from './sidebar-terminal/remote-state.mjs'
import { createDockStore, dockWorkspaceKey } from './sidebar-terminal/dock.mjs'

const prefix = 'dsh-resource://desktop-terminal/'
function fixture(t, { cwd = 'C:\\a', native, saved = {}, side = {} } = {}) {
  const sessions = native || ['dock-a', 'dock-b', 'side-a'].map((key, i) => ({ resourceKey: prefix + key, terminalId: 'term-' + i, runId: 1 }))
  const listeners = new Set(), held = new Set(), closed = [], bySession = {}, actions = []
  let serial = 0, currentCwd = cwd
  for (const [id, keys] of Object.entries(side)) {
    const tabs = Object.fromEntries(keys.map(contentId => { const tabId = 'tab-' + ++serial; return [tabId, { id: tabId, kind: contentId.startsWith(prefix) ? 'desktop-terminal' : 'files', contentId }] }))
    bySession[id] = { layout: { tabs, expanded: true, activePaneId: 'p', nodes: { p: { activeTabId: Object.keys(tabs).at(-1) } } } }
  }
  const notify = () => listeners.forEach(fn => fn())
  const store = {
    subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)), getSnapshot: () => ({ bySession }),
    actions: {
      closeTab(id, key) { closed.push(key); delete bySession[id].layout.tabs[key]; notify() },
      openContent(id, intent, done) {
        actions.push(intent)
        bySession[id] ||= { layout: { tabs: {}, nodes: { p: {} }, activePaneId: 'p' } }
        const key = 'tab-' + ++serial
        bySession[id].layout.tabs[key] = { ...intent, id: key }
        bySession[id].layout.nodes.p.activeTabId = key; notify(); done(key)
      },
      focusTab(id, key) { bySession[id].layout.nodes.p.activeTabId = key },
      setExpanded(id, expanded) { bySession[id].layout.expanded = expanded },
    },
  }
  const list = { getSnapshot: () => ({ phase: 'ready', ids: ['a', 'b'], current: 'a' }), subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)) }
  const ctx = { sessions: { list, scope: id => ({ id }) }, slots: { entriesOfSlot: () => [{ store: { create() {} } }], resolveStore: () => store } }
  const registry = { get sessions() { return sessions }, snapshotSessions: async () => sessions, hold: key => held.add(key), release: key => held.delete(key), subscribe: () => () => {} }
  const workspaceSource = { getSnapshot: () => ({ key: dockWorkspaceKey(currentCwd), cwd: currentCwd }), subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)) }
  const dock = createDockStore(registry, { storage: { getItem: () => JSON.stringify(saved), setItem() {} }, workspaceSource, viewport: () => 900 })
  const provider = createRemoteState(ctx, registry, dock)
  t.after(() => dock.dispose())
  return { ctx, store, dock, provider, sessions, closed, actions, notify, switchFolder(path) { currentCwd = path; notify() } }
}

test('cross-origin restore preserves two folders, active terminals, visibility and duplicated sidebar sessions', async t => {
  const a = prefix + 'dock-a', b = prefix + 'dock-b', side = prefix + 'side-a'
  const source = fixture(t, { saved: { version: 2, workspaces: { a: { cwd: 'C:\\a', tabs: [a], active: a }, b: { cwd: 'C:\\b', tabs: [b], active: b } } }, side: { a: [side, side] } })
  source.dock.open(); source.dock.resize(312)
  const snapshot = await source.provider.capture()
  const target = fixture(t)
  await target.provider.restore(snapshot)
  assert.deepEqual(await target.provider.capture(), snapshot)
  assert.equal(target.dock.getSnapshot().collapsed, false)
  assert.equal(target.dock.getSnapshot().active, a)
  target.switchFolder('C:\\b')
  assert.equal(target.dock.getSnapshot().active, b)
  target.switchFolder('C:\\a')
  await target.provider.restore(snapshot)
  assert.equal(target.actions.length, 2, 'retry must not duplicate sidebar tabs')
  assert.deepEqual(await target.provider.capture(), snapshot)
})

test('a missing or restarted native process blocks restore before creating any views', async t => {
  const source = fixture(t), snapshot = await source.provider.capture()
  const target = fixture(t)
  target.sessions[0].runId++
  await assert.rejects(target.provider.restore(snapshot), /snapshot-terminal-missing/)
  assert.deepEqual(target.actions, [])
  assert.equal(target.dock.getSnapshot().tabs.length, 0)
})

test('disabled desktop removes current and later stale tabs while keeping upstream terminals, files and native sessions', t => {
  const f = fixture(t, { side: { a: ['sidebar://files', prefix + 'side-a'], b: ['sidebar://desktop-terminal'] } })
  f.store.actions.openContent('a', { kind: 'terminal', contentId: 'sidebar://terminal/upstream' }, () => {})
  const stop = hideDesktopTerminals(f.ctx); t.after(stop)
  assert.equal(f.closed.length, 2)
  assert.deepEqual(Object.values(f.store.getSnapshot().bySession.a.layout.tabs).map(t => t.contentId), ['sidebar://files', 'sidebar://terminal/upstream'])
  f.store.actions.openContent('a', { kind: 'desktop-terminal', contentId: prefix + 'later' }, () => {})
  assert.equal(f.closed.length, 3)
  assert.equal(f.sessions.length, 3)
  stop()
  f.store.actions.openContent('a', { kind: 'desktop-terminal', contentId: prefix + 'after-stop' }, () => {})
  assert.equal(f.closed.length, 3)
})

test('stale-tab cleanup waits for dormant session scopes before resolving stores', t => {
  const f = fixture(t, { side: { a: [prefix + 'a'], b: [prefix + 'b'] } })
  let retained = false
  f.ctx.sessions.scope = id => id === 'b' && !retained ? undefined : { id }
  f.ctx.slots.resolveStore = (_handle, binding) => {
    assert.ok(binding.ctx, 'renderer cannot bind a missing session scope')
    return f.store
  }
  t.after(hideDesktopTerminals(f.ctx))
  assert.equal(f.closed.length, 1)
  retained = true
  f.notify()
  assert.equal(f.closed.length, 2)
})
