import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { t as translate, useLocale } from './i18n/api.mjs'
import { createDockStore, createDockComponent, createDockToggleComponent, createDockWorkspaceSource, dockWorkspaceKey } from './sidebar-terminal/dock.mjs'
import { SettingsSchema } from './sidebar-terminal/index.js'

const PREFIX = 'dsh-resource://desktop-terminal/'
function harness(t, saved = {}, sessions = null, storageFails = false, options = {}) {
  let stored = JSON.stringify(saved), native = sessions, counter = 0
  const held = new Set(), released = [], subscribers = new Set(), views = new Map(), calls = []
  const registry = {
    get sessions() { return native },
    subscribe: fn => (subscribers.add(fn), () => subscribers.delete(fn)),
    hold: key => held.add(key), release: key => { held.delete(key); released.push(key) },
    view: tab => {
      if (!views.has(tab.contentId)) views.set(tab.contentId, {
        info: { state: 'running', cwd: 'C:\\project', profileId: 'pwsh' }, message: '', profileId: 'pwsh', profiles: [{ profileId: 'pwsh', name: 'PowerShell' }, { profileId: 'cmd', name: 'CMD' }],
        mount() {}, unmount() {},
        clear: () => calls.push([tab.contentId, 'clear']), connect: () => calls.push([tab.contentId, 'reconnect']), restart: home => calls.push([tab.contentId, 'restart', home]),
      })
      return views.get(tab.contentId)
    },
  }
  const storage = { getItem: () => { if (storageFails) throw Error(); return stored }, setItem: (_key, value) => { if (storageFails) throw Error(); stored = value } }
  const store = createDockStore(registry, { storage, viewport: () => 800, uuid: () => 'uuid-' + ++counter, ...options })
  t.after(() => store.dispose())
  return { store, registry, held, released, views, calls, saved: () => JSON.parse(stored), native: value => { native = value; subscribers.forEach(fn => fn()) } }
}

test('add, switch, close-active-neighbor, close-all and default profile', t => {
  const h = harness(t), a = h.store.add(), b = h.store.add(), c = h.store.add()
  assert.equal(h.store.getSnapshot().active, c.contentId)
  assert.equal(h.held.size, 3)
  h.store.activate(b.contentId); h.store.close(b.contentId)
  assert.equal(h.store.getSnapshot().active, c.contentId)
  assert.equal(h.store.getSnapshot().collapsed, false)
  h.store.close(c.contentId)
  assert.equal(h.store.getSnapshot().active, a.contentId)
  assert.equal(h.store.getSnapshot().collapsed, false)
  h.store.close(a.contentId)
  assert.equal(h.store.getSnapshot().active, null)
  assert.equal(h.store.getSnapshot().collapsed, true)
  assert.equal(h.held.size, 0)
  assert.equal(h.saved().workspaces.unassigned.tabs.length, 0)
})

test('resize bounds and hiding the panel do not release addresses', t => {
  const h = harness(t), tab = h.store.add()
  h.store.resize(1000); assert.equal(h.saved().height, 480)
  h.store.resize(10); assert.equal(h.saved().height, 120)
  h.store.resize(280); h.store.collapse(true)
  assert.equal(h.store.getSnapshot().collapsed, true)
  assert.equal(h.saved().collapsed, undefined, 'visibility is not a startup preference')
  h.store.collapse(false)
  assert.equal(h.store.getSnapshot().active, tab.contentId)
  assert.equal(h.store.getSnapshot().height, 280)
  h.store.dispose()
  assert.deepEqual(h.released, [])
})

test('recovery waits for the bridge, drops missing keys and adopts without opening', t => {
  const key = PREFIX + 'dock-live', gone = PREFIX + 'dock-gone'
  const h = harness(t, { tabs: [key, gone, key, 'invalid'], active: key, collapsed: true, height: 300 })
  assert.equal(h.store.getSnapshot().restoring, true)
  h.store.resize(310)
  assert.deepEqual(h.saved().tabs, [key, gone])
  h.native([{ resourceKey: key, state: 'running' }])
  const state = h.store.getSnapshot()
  assert.equal(state.restoring, false)
  assert.equal(state.tabs.length, 1)
  assert.equal(state.tabs[0].recovered, true)
  assert.equal(state.active, key)
  assert.deepEqual([...h.held], [key])
  assert.deepEqual(h.saved().workspaces.unassigned.tabs, [key])
  assert.deepEqual(h.calls, [])
})

test('creating while recovery is pending preserves both owners and the new selection', t => {
  const key = PREFIX + 'dock-live'
  const h = harness(t, { tabs: [key], active: key })
  const tab = h.store.add()
  h.native([{ resourceKey: key }])
  assert.deepEqual(h.store.getSnapshot().tabs.map(t => t.contentId), [key, tab.contentId])
  assert.equal(h.store.getSnapshot().active, tab.contentId)
})

test('unavailable storage and malformed settings fall back without throwing', t => {
  const h = harness(t, {}, null, true)
  assert.equal(h.store.getSnapshot().height, 240)
  h.store.add(); h.store.collapse(true); h.store.resize(NaN)
  assert.equal(h.store.getSnapshot().height, 240)
  const bad = harness(t, { tabs: 'oops', height: 'not a number', collapsed: 'oops' })
  // Anything that is not an explicit `false` is closed, so a corrupt record cannot
  // open a panel — the safe direction for a value that reserves layout space.
  assert.equal(bad.store.getSnapshot().collapsed, true)
  assert.equal(bad.store.getSnapshot().tabs.length, 0)
})

test('every launch starts closed even if the previous panel was open', t => {
  // A first launch: nothing stored, nothing chosen, no space reserved.
  const fresh = harness(t)
  assert.equal(fresh.store.getSnapshot().collapsed, true)
  // Existing local preferences must not reopen it on the next launch.
  const reopened = harness(t, { collapsed: false, height: 300 })
  assert.equal(reopened.store.getSnapshot().collapsed, true)
  assert.equal(reopened.store.getSnapshot().height, 300)
})

function workspaceSource(initial) {
  let cwd = initial
  const listeners = new Set()
  return {
    getSnapshot: () => cwd === undefined ? null : { key: dockWorkspaceKey(cwd), cwd },
    subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)),
    select(path) { cwd = path; listeners.forEach(fn => fn()) },
    get listenerCount() { return listeners.size },
  }
}

test('folders retain separate tabs and selections, and an open empty folder gets one terminal', t => {
  const workspace = workspaceSource('C:\\projects\\a')
  const h = harness(t, {}, [], false, { workspaceSource: workspace })
  assert.equal(h.store.getSnapshot().tabs.length, 0)
  h.store.open()
  const a = h.store.getSnapshot().tabs[0], a2 = h.store.add()
  assert.equal(a.cwd, 'C:\\projects\\a')
  h.store.activate(a.contentId)
  workspace.select('C:\\projects\\b')
  const b = h.store.getSnapshot().tabs[0]
  assert.equal(b.cwd, 'C:\\projects\\b')
  assert.notEqual(a.contentId, b.contentId)
  assert.equal(h.store.getSnapshot().tabs.length, 1)
  h.store.open()
  assert.equal(h.store.getSnapshot().tabs.length, 1)
  workspace.select('C:\\projects\\a')
  assert.deepEqual(h.store.getSnapshot().tabs.map(t => t.contentId), [a.contentId, a2.contentId])
  assert.equal(h.store.getSnapshot().active, a.contentId)
  assert.equal(h.held.size, 3, 'inactive workspaces retain their running terminals')
  assert.deepEqual(h.released, [])
  h.store.close(a.contentId)
  workspace.select('C:\\projects\\b')
  assert.equal(h.store.getSnapshot().active, b.contentId)
  assert.deepEqual(h.released, [a.contentId])
  h.store.close(b.contentId)
  assert.equal(h.store.getSnapshot().tabs.length, 0)
  assert.equal(h.store.getSnapshot().collapsed, true)
  assert.ok(h.held.has(a2.contentId), 'closing this folder does not close another folder’s terminals')
  h.store.open()
  assert.equal(h.store.getSnapshot().tabs.length, 1)
  assert.notEqual(h.store.getSnapshot().active, b.contentId)
})

test('hidden workspace changes and loading create no terminals until explicitly opened', t => {
  const workspace = workspaceSource('C:\\a')
  const h = harness(t, {}, [], false, { workspaceSource: workspace })
  workspace.select('C:\\b')
  assert.equal(h.held.size, 0)
  workspace.select(undefined)
  h.store.open()
  assert.equal(h.held.size, 0, 'loading must not start a shell in a fallback directory')
  workspace.select('C:\\a')
  assert.equal(h.store.getSnapshot().tabs.length, 1)
  assert.equal(h.store.getSnapshot().tabs[0].cwd, 'C:\\a')
  h.store.collapse(true)
  workspace.select('C:\\b')
  assert.equal(h.store.getSnapshot().collapsed, true)
  assert.equal(h.store.getSnapshot().tabs.length, 0)
  h.store.dispose()
  assert.equal(workspace.listenerCount, 0)
})

test('reload recovers every workspace while keeping the panel closed', t => {
  const workspace = workspaceSource('C:\\a')
  const h = harness(t, {}, [], false, { workspaceSource: workspace })
  h.store.open()
  const a = h.store.getSnapshot().tabs[0], a2 = h.store.add()
  h.store.activate(a.contentId)
  workspace.select('C:\\b')
  const b = h.store.getSnapshot().tabs[0]
  const saved = h.saved()
  h.store.dispose()
  const restored = harness(t, saved, null, false, { workspaceSource: workspace })
  assert.equal(restored.store.getSnapshot().collapsed, true)
  assert.equal(restored.held.size, 3, 'recovery retains inactive owners before native discovery')
  restored.native([a, a2, b].map(tab => ({ resourceKey: tab.contentId, cwd: tab.cwd })))
  assert.equal(restored.store.getSnapshot().collapsed, true)
  assert.equal(restored.store.getSnapshot().active, b.contentId)
  workspace.select('C:\\a')
  restored.store.open()
  assert.equal(restored.store.getSnapshot().active, a.contentId)
  assert.equal(restored.store.getSnapshot().tabs.length, 2)
  assert.equal(restored.store.getSnapshot().tabs.every(tab => tab.recovered), true)
})

test('legacy global terminals migrate to their own native startup folders', t => {
  const a = PREFIX + 'old-a', b = PREFIX + 'old-b', gone = PREFIX + 'gone'
  const workspace = workspaceSource('C:\\b')
  const h = harness(t, { tabs: [a, b, gone], active: a, collapsed: false }, null, false, { workspaceSource: workspace })
  h.store.open()
  assert.equal(h.store.getSnapshot().tabs.length, 0)
  h.native([{ resourceKey: a, cwd: 'C:\\a' }, { resourceKey: b, cwd: 'C:\\b' }])
  assert.deepEqual(h.store.getSnapshot().tabs.map(t => t.contentId), [b])
  workspace.select('C:\\a')
  assert.deepEqual(h.store.getSnapshot().tabs.map(t => t.contentId), [a])
  assert.equal(h.store.getSnapshot().active, a)
  assert.deepEqual(h.released, [gone])
})

test('opening during recovery seeds a terminal if every saved terminal is gone', t => {
  const workspace = workspaceSource('C:\\a')
  const h = harness(t, { tabs: [PREFIX + 'gone'] }, null, false, { workspaceSource: workspace })
  h.store.open()
  h.native([])
  assert.equal(h.store.getSnapshot().tabs.length, 1)
  assert.equal(h.store.getSnapshot().tabs[0].cwd, 'C:\\a')
  h.native([])
  assert.equal(h.store.getSnapshot().tabs.length, 1, 'subsequent native refreshes cannot seed duplicates')
})

test('a late saved-open setting cannot reveal the panel or undo a user open', t => {
  let notify, ready = false
  const scope = { getSnapshot: () => ({ status: ready ? 'ready' : 'loading', value: { layout: { height: 310, collapsed: false } } }), subscribe: fn => (notify = fn, () => {}), set() {} }
  const hidden = harness(t, { collapsed: false }, [], false, { settingsScope: scope })
  ready = true; notify()
  assert.equal(hidden.store.getSnapshot().collapsed, true)
  assert.equal(hidden.store.getSnapshot().height, 310)
  ready = false
  const opened = harness(t, {}, [], false, { settingsScope: scope })
  opened.store.open()
  ready = true; notify()
  assert.equal(opened.store.getSnapshot().collapsed, false)
  assert.equal(opened.store.getSnapshot().height, 310)
})

test('workspace source follows session folders and subscribes to both catalogs', () => {
  let sessions = { phase: 'ready', current: 'a1', byId: {} }
  let workspaces = { phase: 'ready', items: [{ path: 'C:\\Project\\A', sessionIds: ['a1', 'a2'] }, { path: 'C:\\Project\\B', sessionIds: ['b1'] }] }
  const listeners = new Set()
  const source = createDockWorkspaceSource({
    sessions: { list: { getSnapshot: () => sessions, subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)) } },
    workspaces: { list: { getSnapshot: () => workspaces, subscribe: fn => { const listener = () => fn(); listeners.add(listener); return () => listeners.delete(listener) } } },
  })
  const first = source.getSnapshot()
  sessions.current = 'a2'
  assert.deepEqual(source.getSnapshot(), first, 'conversations in one folder share terminals')
  sessions.current = 'b1'
  assert.notEqual(source.getSnapshot().key, first.key)
  assert.equal(dockWorkspaceKey('c:/project/a/'), first.key)
  workspaces = { ...workspaces, phase: 'loading' }
  assert.equal(source.getSnapshot(), null)
  let changes = 0
  const off = source.subscribe(() => changes++)
  listeners.forEach(fn => fn())
  assert.equal(changes, 2)
  off()
  assert.equal(listeners.size, 0)
})

test('rc2 workspace source follows main-view ownership and ignores background retains', () => {
  let sessions = { phase: 'ready', ids: ['background', 'a', 'b'], byId: {
    background: { id: 'background', cwd: 'C:/background', retainedBy: { plugin: 1 } },
    a: { id: 'a', retainedBy: { mainView: 1 } },
    b: { id: 'b', cwd: 'C:/standalone', retainedBy: {} },
  } }
  const listeners = new Set()
  const source = createDockWorkspaceSource({
    sessions: { list: { getSnapshot: () => sessions, subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)) } },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [{ path: 'C:/project', sessionIds: ['a'] }] }), subscribe: () => () => {} } },
  })
  const snapshots = [source.getSnapshot()]
  const off = source.subscribe(() => snapshots.push(source.getSnapshot()))
  sessions = { ...sessions, byId: { ...sessions.byId, a: { ...sessions.byId.a, retainedBy: {} }, b: { ...sessions.byId.b, retainedBy: { mainView: 1 } } } }
  listeners.forEach(fn => fn())
  assert.deepEqual(snapshots.map(value => value.cwd), ['C:/project', 'C:/standalone'])
  sessions.byId.b.retainedBy = {}
  assert.equal(source.getSnapshot(), null, 'a background retain must not select a terminal folder')
  off()
  assert.equal(listeners.size, 0)
})

test('opening an empty panel starts a terminal; opening a populated one does not', t => {
  const empty = harness(t)
  assert.equal(empty.store.getSnapshot().collapsed, true)
  empty.store.open()
  const state = empty.store.getSnapshot()
  assert.equal(state.collapsed, false, 'the panel must open')
  assert.equal(state.tabs.length, 1, 'an empty panel opens with a terminal to type in')
  assert.equal(state.active, state.tabs[0].contentId)
  assert.equal(empty.held.size, 1, 'the seeded terminal owns its address')

  // A second open is not a second shell.
  empty.store.open()
  assert.equal(empty.store.getSnapshot().tabs.length, 1)

  // A panel that already holds terminals is only revealed.
  const h = harness(t); const tab = h.store.add(); h.store.collapse(true)
  h.store.open()
  assert.equal(h.store.getSnapshot().tabs.length, 1)
  assert.equal(h.store.getSnapshot().active, tab.contentId)
})

test('opening while recovery is pending reveals without seeding a rival shell', t => {
  const key = PREFIX + 'dock-live'
  const h = harness(t, { tabs: [key], active: key, collapsed: true })
  assert.equal(h.store.getSnapshot().restoring, true)
  h.store.open()
  // Seeding here would start a NEW shell beside the one about to be restored,
  // which is the opposite of what "open the panel I left" should do.
  assert.equal(h.store.getSnapshot().collapsed, false)
  assert.equal(h.store.getSnapshot().tabs.length, 0)
  h.native([{ resourceKey: key, state: 'running' }])
  assert.deepEqual(h.store.getSnapshot().tabs.map(x => x.contentId), [key])
  assert.equal(h.store.getSnapshot().collapsed, false, 'and the restored panel stays open')
})

test('shortcut reuses a matching terminal or creates one while preserving other shells', t => {
  const h = harness(t)
  const a = h.store.add(), b = h.store.add()
  h.store.collapse(true)
  h.store.openMatching(key => key === a.contentId)
  assert.equal(h.store.getSnapshot().active, a.contentId)
  assert.equal(h.store.getSnapshot().tabs.length, 2)
  assert.equal(h.store.getSnapshot().collapsed, false)
  h.store.openMatching(() => false)
  assert.equal(h.store.getSnapshot().tabs.length, 3)
  assert.deepEqual(h.released, [])
  assert.ok(h.held.has(b.contentId))
})

test('shortcut waits for recovery before selecting a shell of the configured type', t => {
  const key = PREFIX + 'recovered-shell'
  const h = harness(t, { tabs: [key] })
  h.store.openMatching(candidate => candidate === key)
  assert.equal(h.store.getSnapshot().tabs.length, 0)
  h.native([{ resourceKey: key }])
  assert.equal(h.store.getSnapshot().tabs.length, 1)
  assert.equal(h.store.getSnapshot().active, key)
})

test('host geometry restores across origins and takes precedence over stale port storage', t => {
  const scope = { getSnapshot: () => ({ status: 'ready', value: { layout: { height: 320, collapsed: true } } }), subscribe: () => () => {}, set() {} }
  for (const saved of [{}, { height: 180, collapsed: false }]) {
    const h = harness(t, saved, null, false, { settingsScope: scope })
    assert.equal(h.store.getSnapshot().height, 320)
    assert.equal(h.store.getSnapshot().collapsed, true)
  }
})

test('editing during settings load wins and durable writes coalesce to the latest geometry', async t => {
  let notify, ready = false
  const writes = []
  const scope = { getSnapshot: () => ({ status: ready ? 'ready' : 'loading', value: { layout: { height: 180, collapsed: false } } }), subscribe: fn => (notify = fn, () => {}), set: async (field, value) => { writes.push({ field, value }) } }
  const h = harness(t, {}, null, false, { settingsScope: scope })
  h.store.resize(340); h.store.collapse(true)
  ready = true; notify()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(writes.at(-1), { field: 'layout', value: { height: 340, collapsed: true } })
  assert.equal(h.store.getSnapshot().height, 340)
})

test('host settings schema validates layout and supplies a complete descriptor', () => {
  // The DEFAULT is closed: an install that has never opened the panel must not
  // reserve space, and both the runtime default and the wire descriptor say so.
  assert.deepEqual(SettingsSchema({}), { layout: { height: 240, collapsed: true }, profileId: 'auto', position: 'bottom' })
  assert.deepEqual(SettingsSchema.validate({ layout: { height: 300, collapsed: false } }), { layout: { height: 300, collapsed: false }, profileId: 'auto', position: 'bottom' })
  for (const layout of [{ height: 0, collapsed: true }, { height: 240, collapsed: 'true' }, null]) assert.equal(SettingsSchema.validate({ layout }), undefined)
  const schema = SettingsSchema.toJSON()
  assert.equal(schema.refs[schema.uid].type, 'object')
  assert.deepEqual(schema.refs[6].meta.default, { height: 240, collapsed: true })
})

// A stateful hook harness, so controls are clicked and rerendered after selecting
// a different tab rather than just matching source strings.
function renderHarness(t, h, useMenu = true, presentation) {
  let cursor = 0, slots = [], effects = [], hidden = false
  // The left column the region is measured from. `sidebarRight` is what the panel's
  // left edge must equal, so the stub carries a real box rather than an absent node:
  // a harness that never found the column could not tell "excluded the sidebar" from
  // "found nothing and defaulted to 0".
  const sidebar = { getBoundingClientRect: () => ({ right: sidebarRight }) }
  let sidebarRight = 280
  const listeners = new Map()
  const document = {
    documentElement: { style: { setProperty: (key, value) => { document[key] = value } }, toggleAttribute() {}, removeAttribute() {} },
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn) },
    removeEventListener: (name, fn) => listeners.set(name, (listeners.get(name) ?? []).filter(f => f !== fn)),
    // A real dispatch, so a component that forgets to listen fails here rather than
    // silently relying on some other render to refresh it.
    dispatchEvent: event => { for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event); return true },
    /** The handlers currently registered for an event, so a test can tell whose they are. */
    listeners: name => [...(listeners.get(name) ?? [])],
    querySelector: selector => (selector.includes('_sidebarCol') ? sidebar : null),
  }
  const win = { innerHeight: 800, __TAURI__: { core: { Channel() {} } }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {} }
  const previousWindow = globalThis.window, previousDocument = globalThis.document
  globalThis.window = win; globalThis.document = document
  t.after(() => { slots.forEach(s => s?.cleanup?.()); globalThis.window = previousWindow; globalThis.document = previousDocument })
  const state = initial => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] }
  const effect = (fn, deps) => {
    const index = cursor++, old = slots[index]
    if (!old || deps.some((d, i) => d !== old.deps[i])) effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: fn() } })
  }
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: state, useReducer: (fn, initial) => { const [s, set] = state(initial); return [s, () => set(fn)] },
    useRef: initial => state(() => ({ current: initial }))[0], useEffect: effect, useLayoutEffect: effect }
  // The runtime's module imports are stripped for this sandbox, so a helper it
  // imports from a sibling file is concatenated too — the code under test is real
  // either way, and a missing helper would look like a broken surface instead.
  const selection = readFileSync(new URL('./sidebar-terminal/selection.mjs', import.meta.url), 'utf8').replace(/^export /gm, '')
  const source = readFileSync(new URL('./sidebar-terminal/runtime.mjs', import.meta.url), 'utf8').replace(/^import .+\n/gm, '').replace(/^export /gm, '')
  const context = { window: win, document, queueMicrotask, Promise }
  Object.assign(context, { t: translate, useLocale })
  vm.runInNewContext(selection + '\n' + source + '\nthis.factory = createTerminalUI', context)
  const ui = context.factory(React, useMenu ? { Menu: function Menu() {} } : null)
  if (presentation) ui.presentation = presentation
  const Dock = createDockComponent(React, h.registry, h.store, ui, () => hidden)
  let tree, nodes
  return {
    render() { cursor = 0; effects = []; tree = Dock(); effects.forEach(fn => fn()); nodes = []; const walk = n => { if (typeof n !== 'object' || !n) return; nodes.push(n); n.children.forEach(walk) }; walk(tree); return tree },
    get nodes() { return nodes },
    one: predicate => nodes.find(predicate),
    /** The "..." menu, told apart from the shell picker's Menu by its anchored trigger. */
    menu: () => nodes.find(n => n.type?.name === 'Menu' && n.props.anchor?.props?.['data-dsh-terminal-more']),
    /** The shell picker's Menu, anchored on the pill that wears the settings selector. */
    shell: () => nodes.find(n => n.type?.name === 'Menu' && n.props.anchor?.props?.className === 'dshTerminal__shell'),
    hidden(value) { hidden = value }, document, React,
    /** Run the effects a component queued during its last render, as React would. */
    flush() { const pending = effects; effects = []; pending.forEach(fn => fn()) },
    /** Move the left column, as a drag or a rail toggle does, then re-measure. */
    sidebar(width) { sidebarRight = width; listeners.get('resize')?.(); return document['--dsh-terminal-dock-left'] },
  }
}
const textOf = n => typeof n === 'string' ? n : n?.children?.map(textOf).join('') || ''

test('dock puts decorative dots before titles, keeps normal status offscreen and only one controls row', t => {
  const h = harness(t); h.store.add(); h.store.add()
  const r = renderHarness(t, h); r.render()
  const tabs = r.nodes.filter(n => n.props.role === 'tab')
  assert.equal(tabs.length, 2)
  for (const tab of tabs) {
    assert.equal(tab.children[0].props.className, 'dshTerminal__dot')
    assert.match(textOf(tab), /^终端 \d+$/)
    assert.match(tab.props['aria-label'], /运行中/)
    assert.match(tab.props.title, /启动目录/)
  }
  assert.equal(r.nodes.some(n => n.props.className === 'dshTerminal__header'), false)
  assert.ok(r.shell(), 'the shell picker rides the app\'s Menu in the dock bar too')
  assert.equal(r.nodes.some(n => n.props.className === 'dshTerminalDock__notice'), false)
  assert.deepEqual(Array.from(r.menu().props.items, i => i.id), ['clear', 'reconnect', 'restart', 'collapse'])
})

test('switching tabs retargets profile, clear, reconnect and restart; inactive status updates', t => {
  const h = harness(t), a = h.store.add(), b = h.store.add(), r = renderHarness(t, h)
  r.render()
  r.shell().props.onSelect('cmd')
  r.menu().props.onSelect('clear')
  h.store.activate(a.contentId); r.render()
  assert.equal(r.shell().props.selectedId, 'pwsh')
  r.menu().props.onSelect('reconnect'); r.menu().props.onSelect('restart')
  assert.deepEqual(h.calls, [[b.contentId, 'clear'], [a.contentId, 'reconnect'], [a.contentId, 'restart', undefined]])
  assert.equal(h.views.get(b.contentId).profileId, 'cmd')
  h.views.get(b.contentId).info.state = 'exited'; r.render()
  assert.match(r.one(n => n.props.role === 'tab' && n.props['data-resource-key'] === b.contentId).props['aria-label'], /已退出/)
})

test('dock titles follow each terminal, including inactive updates, accessible labels and full tooltips', t => {
  const h = harness(t), a = h.store.add(), b = h.store.add()
  const r = renderHarness(t, h, false, view => ({ title: view?.info.title, tone: 'ok', description: '已连接' }))
  const tab = key => r.one(n => n.props.role === 'tab' && n.props['data-resource-key'] === key)
  r.render()
  assert.equal(textOf(tab(a.contentId)), '终端 1', 'missing title uses the numbered fallback')
  h.views.get(a.contentId).info.title = '前端开发服务'
  h.views.get(b.contentId).info.title = '构建 <preview> & 测试'
  r.render()
  assert.equal(textOf(tab(a.contentId)), '前端开发服务', 'inactive tab has its own live title')
  assert.equal(textOf(tab(b.contentId)), '构建 <preview> & 测试', 'title stays plain text')
  assert.equal(tab(a.contentId).props.title, '前端开发服务\n已连接')
  assert.equal(tab(a.contentId).props['aria-label'], '前端开发服务\n已连接')
  assert.ok(r.one(n => n.props['aria-label'] === '关闭前端开发服务'))
  tab(a.contentId).props.onFocus({ currentTarget: { getBoundingClientRect: () => ({ left: 300 }) } })
  const longTitle = '长标题终端 / ' + '运行中的自定义任务'.repeat(12)
  h.views.get(a.contentId).info.title = longTitle
  r.render()
  assert.equal(textOf(tab(a.contentId)), longTitle)
  assert.equal(textOf(r.one(n => n.props.role === 'tooltip')), longTitle + '\n已连接')
  h.store.activate(a.contentId); r.render()
  assert.equal(textOf(tab(b.contentId)), '构建 <preview> & 测试', 'switching tabs does not exchange titles')
  h.views.get(a.contentId).info.title = '   '; r.render()
  assert.equal(textOf(tab(a.contentId)), '终端 1', 'blank title cannot leave an empty tab')
})

test('collapse hides the panel, releases its space, and vanilla round trips', t => {
  const h = harness(t); h.store.add(); const r = renderHarness(t, h); r.render()
  r.one(n => n.props.role === 'separator').props.onKeyDown({ key: 'ArrowUp', preventDefault() {} }); r.render()
  assert.equal(r.document['--dsh-terminal-dock-height'], '260px')
  // The 收起 control beside "..." is the way out, and it is the dock's OWN: the
  // panel's other actions stay in the menu, where the user asked for them.
  r.one(n => n.props['aria-label'] === '收起底部侧边栏').props.onClick(); r.render()
  // Collapsed is HIDDEN — no strip, and nothing reserved.
  assert.equal(r.render(), null)
  assert.equal(r.document['--dsh-terminal-dock-height'], '0px')
  // Reopening through the store (what the header button calls) restores height and
  // the active tab, and never released a session to get there.
  h.store.open(); r.render()
  assert.equal(r.document['--dsh-terminal-dock-height'], '260px')
  assert.equal(r.one(n => n.props.role === 'separator').props['aria-valuenow'], 260)
  r.hidden(true); assert.equal(r.render(), null)
  assert.equal(r.document['--dsh-terminal-dock-height'], '0px')
  r.hidden(false); r.render()
  assert.equal(r.document['--dsh-terminal-dock-height'], '260px')
  assert.deepEqual(h.released, [])
})

test('shortcut can reveal the dock in vanilla, and changing mode withdraws that override', t => {
  const h = harness(t); h.store.add(); const r = renderHarness(t, h)
  r.hidden(true); assert.equal(r.render(), null)
  h.store.openMatching(() => true)
  assert.ok(r.render())
  assert.equal(r.document['--dsh-terminal-dock-height'], '240px')
  r.document.dispatchEvent({ type: 'dsh-desktop:ui-mode' })
  assert.equal(r.render(), null)
  assert.equal(r.document['--dsh-terminal-dock-height'], '0px')
  assert.deepEqual(h.released, [])
})

test('the panel region starts where the left column ends, and follows it', t => {
  const h = harness(t); h.store.add(); const r = renderHarness(t, h); r.render()
  // 280 is the contract's default sidebar width; the panel must not cover it.
  assert.equal(r.document['--dsh-terminal-dock-left'], '280px')
  // A dragged-wider sidebar moves the panel's edge with it.
  assert.equal(r.sidebar(420), '420px')
  // And the collapsed rail (56) moves it back.
  assert.equal(r.sidebar(56), '56px')
})

// Deliver DOM mutations and layout notifications separately: a CSS grid
// transition keeps changing the sidebar box after its inline style is written.
function leftEdgeHarness(t) {
  let sidebar = { getBoundingClientRect: () => ({ right }) }, right = 280
  const frame = {}, values = new Map(), listeners = new Map(), observers = []
  class Observer {
    targets = new Set()
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe(target) { this.targets.add(target) }
    unobserve(target) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
    deliver(target) { if (this.targets.has(target)) this.callback([{ target }]) }
  }
  class MutationObserver extends Observer {}
  class ResizeObserver extends Observer {}
  const document = {
    documentElement: { style: { setProperty: (key, value) => values.set(key, value) } },
    querySelector: selector => selector.includes('_sidebarCol') ? sidebar : { parentElement: frame },
  }
  const context = { document, MutationObserver, ResizeObserver, window: {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
  } }
  const source = readFileSync(new URL('./sidebar-terminal/dock.mjs', import.meta.url), 'utf8')
    .replace(/^import .+\n/gm, '').replace(/^export /gm, '')
  vm.runInNewContext(source + '\nthis.stop = trackLeftEdge(document)', context)
  t.after(() => context.stop())
  return {
    edge: () => values.get('--dsh-terminal-dock-left'),
    mutation(width) { right = width; observers.filter(o => o instanceof MutationObserver).forEach(o => o.deliver(frame)) },
    layout(width) { right = width; observers.filter(o => o instanceof ResizeObserver).forEach(o => o.deliver(sidebar)) },
    replace(width) { const old = sidebar; sidebar = { getBoundingClientRect: () => ({ right }) }; this.mutation(width); return old },
    observed: node => observers.some(o => o.targets.has(node)),
    stop: context.stop, observers, listeners,
  }
}

test('dock follows animation frames and the final width after rapid sidebar reversals', t => {
  const r = leftEdgeHarness(t)
  assert.equal(r.edge(), '280px')
  for (let i = 0; i < 12; i++) {
    r.mutation(280) // Collapse starts with the previous rendered width.
    r.layout(192); assert.equal(r.edge(), '192px')
    r.mutation(192) // Expand reverses a transition already in progress.
    r.layout(224); assert.equal(r.edge(), '224px')
    r.mutation(224) // Reverse again before the preceding animation completes.
    r.layout(56); assert.equal(r.edge(), '56px')
    r.mutation(56)
    r.layout(280); assert.equal(r.edge(), '280px', 'final layout needs no additional DOM mutation or window resize')
  }
})

test('dock observes a replacement sidebar and releases observers on unmount', t => {
  const r = leftEdgeHarness(t)
  const old = r.replace(56)
  assert.equal(r.observed(old), false)
  r.layout(180); assert.equal(r.edge(), '180px')
  r.layout(420); assert.equal(r.edge(), '420px')
  r.stop()
  assert.equal(r.edge(), '0px')
  assert.equal(r.observers.every(o => o.targets.size === 0), true)
  assert.equal(r.listeners.size, 0)
  r.layout(280); assert.equal(r.edge(), '0px')
})

test('the header control opens and closes the panel from the same button', t => {
  const h = harness(t)
  const r = renderHarness(t, h)
  // The control is the STORE's own view of "collapsed", so it is exercised the way
  // the seat mounts it: render the component, press it, render again.
  // Render the icon too: a shallow element tree misses errors inside its component.
  const React = { ...r.React, createElement(type, props, ...children) {
    return typeof type === 'function' ? type(props || {}) : r.React.createElement(type, props, ...children)
  } }
  const Toggle = createDockToggleComponent(React, h.store, () => false)

  // Collapsed by default, so the control is present and is the way in.
  assert.equal(h.store.getSnapshot().collapsed, true)
  const button = Toggle()
  assert.equal(button.props['aria-label'], '打开底部侧边栏')
  assert.equal(button.props['aria-expanded'], false)
  assert.equal(button.children[0].type, 'svg')
  button.props.onClick()
  assert.equal(h.store.getSnapshot().collapsed, false)
  assert.equal(h.store.getSnapshot().tabs.length, 1, 'opening an empty panel starts a terminal')
  const terminal = h.store.getSnapshot().active

  // The control STAYS while the panel is open and flips to the closing action —
  // a way out that vanishes with the panel would be no way out at all, which is
  // exactly what the user asked this button to be.
  const open = Toggle()
  assert.notEqual(open, null, 'the control remains while the panel is shown')
  assert.equal(open.props['aria-label'], '收起底部侧边栏')
  assert.equal(open.props['aria-expanded'], true)
  open.props.onClick()
  assert.equal(h.store.getSnapshot().collapsed, true, 'and pressing it again closes the panel')
  assert.deepEqual(h.released, [], 'closing collapses; it releases no address of its own')
  assert.equal(Toggle().props['aria-label'], '打开底部侧边栏', 'and the way back in is the same button')
  Toggle().props.onClick()
  assert.equal(h.store.getSnapshot().tabs.length, 1, 'reopening reuses the existing terminal')
  assert.equal(h.store.getSnapshot().active, terminal)

  // 原版 withholds it entirely: the panel is this project's addition.
  assert.equal(createDockToggleComponent(r.React, h.store, () => true)(), null)
})

test('the header control follows a live mode switch, not just its own store', t => {
  const h = harness(t)
  const r = renderHarness(t, h)
  let vanilla = false
  const Probe = createDockToggleComponent(r.React, h.store, () => vanilla)

  // Mount it the way React would: render, then run the effects that render queued.
  // The listener set is captured BEFORE the mount, so what is counted below can only
  // be a listener the COMPONENT installed — never the test's own. That distinction is
  // the whole point: the first version of this test subscribed to the same event
  // itself, so it passed against a component that listened to nothing.
  const before = new Set(r.document.listeners('dsh-desktop:ui-mode'))
  assert.notEqual(Probe(), null, 'the control is present while collapsed in desktop mode')
  r.flush()
  const added = r.document.listeners('dsh-desktop:ui-mode').filter(fn => !before.has(fn))
  assert.equal(added.length, 1, 'the component must install exactly one mode listener of its own')

  // The mode changes with NO store change at all, and the announcement is raised
  // through the component's OWN captured listener rather than a fresh dispatch, so
  // this exercises the subscription the assertion above found. If that listener were
  // absent or a no-op, `added` would be empty or the call would not reach the store
  // — and the render below would still report the stale desktop answer.
  vanilla = true
  added[0]({ type: 'dsh-desktop:ui-mode' })
  assert.equal(Probe(), null, 'and 原版 must withhold the control immediately')
})

test('closing the last tab hides the dock and reopening seeds exactly one fresh terminal', async t => {
  const h = harness(t), r = renderHarness(t, h)
  let openerFocused = false
  const query = r.document.querySelector
  r.document.querySelector = selector => selector === '[data-dsh-terminal-dock-toggle]'
    ? { focus() { openerFocused = true } } : query(selector)
  h.store.open()
  const only = h.store.getSnapshot().active
  r.render()
  r.one(n => n.props['aria-label'] === '关闭终端 1').props.onClick()
  await Promise.resolve()
  assert.equal(openerFocused, true, 'focus returns to the header control after the last tab closes')
  r.render() // Flush the closing layout effect before checking the settled tree.
  assert.equal(r.render(), null)
  assert.equal(r.document['--dsh-terminal-dock-height'], '0px')
  assert.equal(h.store.getSnapshot().collapsed, true)
  assert.equal(h.store.getSnapshot().tabs.length, 0)
  assert.deepEqual(h.released, [only])
  h.native([])
  assert.equal(h.store.getSnapshot().tabs.length, 0, 'background updates do not reopen the empty dock')
  h.store.open(); r.render()
  assert.equal(h.store.getSnapshot().tabs.length, 1)
  assert.notEqual(h.store.getSnapshot().active, only)
  assert.equal(r.document['--dsh-terminal-dock-height'], '240px')
  assert.equal(r.shell().props.anchor.props.disabled, false)
  h.store.open()
  assert.equal(h.store.getSnapshot().tabs.length, 1)
})

test('a session error raises no row: it tones the dot and rides the tooltip', t => {
  // The user's ask, verbatim: the visible condition line goes, a broken terminal
  // says so with the dot's colour, and the reason is read through the tooltip. So
  // this asserts the whole replacement contract rather than just the absence of the
  // row — otherwise "deleted the feature" and "moved the feature" look identical.
  const h = harness(t), a = h.store.add(), r = renderHarness(t, h); r.render()
  const tab = () => r.one(n => n.props['data-resource-key'] === a.contentId)

  // A healthy terminal: the row is already gone, and the dot is NOT alarming.
  assert.equal(r.nodes.some(n => n.props.className === 'dshTerminalDock__notice'), false)
  assert.equal(tab().props['data-dsh-terminal-tone'], 'ok', 'a running shell is not a warning')

  h.views.get(a.contentId).message = '启动目录不存在或不可访问，可选择在主目录重试。'; r.render()
  assert.equal(
    r.nodes.some(n => n.props.className === 'dshTerminalDock__notice'),
    false,
    'the condition row must not come back',
  )
  // The dot carries the warning — and this is the load-bearing half: `state` is
  // still `running` through this failure, so a dot keyed on state alone stays green.
  assert.equal(
    tab().props['data-dsh-terminal-tone'],
    'bad',
    'a live condition recolours the dot even though the shell is still running',
  )
  // The reason is reachable in the tooltip, which is what the row used to say.
  assert.match(tab().props.title, /主目录重试/, 'the reason is in the tooltip')
  assert.match(tab().props['aria-label'], /主目录重试/, 'and in the accessible name')

  // A DIFFERENT session error, to prove the tooltip carries whatever the reason is
  // rather than one hard-coded sentence.
  h.views.get(a.contentId).message = '最多可同时保留 16 个终端，请先关闭其他终端。'; r.render()
  assert.match(tab().props.title, /16/)
  assert.equal(tab().props['data-dsh-terminal-tone'], 'bad')

  // Recovering clears the warning: the tone follows the condition both ways, so a
  // dot that has gone red cannot stay red once the terminal is healthy again.
  h.views.get(a.contentId).message = ''; r.render()
  assert.equal(tab().props['data-dsh-terminal-tone'], 'ok', 'the warning clears with the condition')
  assert.doesNotMatch(tab().props.title, /16/)

  // The retry action that used to be reachable from the row still is.
  h.views.get(a.contentId).message = '启动目录不存在或不可访问，可选择在主目录重试。'; r.render()
  r.menu().props.onSelect('home')
  assert.deepEqual(h.calls, [[a.contentId, 'restart', true]])
})

test('fallback menu opens and Escape restores trigger focus', t => {
  const h = harness(t); h.store.add(); const r = renderHarness(t, h, false); r.render()
  const more = r.one(n => n.props['data-dsh-terminal-more'])
  let focused = false; more.props.ref.current = { focus: () => { focused = true }, getBoundingClientRect: () => ({ right: 1200, top: 560 }) }
  more.props.onClick(); r.render()
  assert.ok(r.one(n => n.props.role === 'menu'))
  r.one(n => n.props.className === 'dshTerminal__actions').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  r.render()
  assert.equal(r.one(n => n.props.role === 'menu'), undefined)
  assert.equal(focused, true)
})
