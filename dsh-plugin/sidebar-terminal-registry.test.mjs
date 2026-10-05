import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { currentSessionId } from './sidebar-terminal/session-context.mjs'

// Evaluate the real registry without importing the browser-only xterm classes.
// The runtime's own module imports are stripped below, so a helper it calls from
// another file has to be concatenated into the same context — otherwise the code
// under test would be missing a function it legitimately imports, and the failure
// would look like a broken registry.
const source = readFileSync(new URL('./sidebar-terminal/runtime.mjs', import.meta.url), 'utf8')
const selectionSource = readFileSync(new URL('./sidebar-terminal/selection.mjs', import.meta.url), 'utf8')
  .replace(/^export /gm, '')
const registrySource = source.slice(source.indexOf('export function createRegistry'), source.indexOf('\nfunction createView')).replace('export ', '')
const PREFIX = 'dsh-resource://desktop-terminal/'
const tick = () => new Promise(resolve => setImmediate(resolve))

function harness(t, keys = [], rc2 = false) {
  let tabs = keys.map(contentId => ({ contentId }))
  const subscribers = new Set(), closed = [], disposed = [], opened = []
  let workspacePath = 'C:\\a'
  const native = ['dock-a', 'side-a', 'orphan'].map(id => ({ resourceKey: PREFIX + id, terminalId: id, runId: 1, state: 'running' }))
  const store = { getSnapshot: () => ({ bySession: { a: { layout: { tabs } } } }), subscribe: fn => (subscribers.add(fn), () => subscribers.delete(fn)) }
  const ctx = {
    slots: { entriesOfSlot: () => [{ store: { create() { throw Error('must resolve the live store') } } }], resolveStore: () => store },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', ids: ['a'], ...(rc2 ? { byId: { a: { id: 'a', retainedBy: { mainView: 1 } } } } : { current: 'a' }) }), subscribe: () => () => {} }, scope: () => ({}) },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [{ path: workspacePath, sessionIds: ['a'] }] }) } },
  }
  const sandbox = {
    PREFIX, ctx, currentSessionId, setInterval: () => 1, clearInterval() {}, queueMicrotask,
    window: { __DSH_TERMINAL_IDENTITY__: {}, addEventListener() {}, removeEventListener() {} },
    wire: info => ({ terminalId: info.terminalId, runId: info.runId }),
    invoke: async (name, args) => { if (name === 'terminal_list') return [...native]; if (name === 'terminal_close') closed.push(args.terminalId); if (name === 'terminal_open') { opened.push(args); return { resourceKey: args.resourceKey, cwd: args.cwd } } },
    createView: (key, open) => ({ key, connect: () => open(key, null, false, false), dispose: () => disposed.push(key) }),
  }
  vm.runInNewContext(registrySource + '\nthis.registry = createRegistry(ctx)', sandbox)
  const registry = sandbox.registry
  t.after(() => registry.dispose())
  return { registry, closed, disposed, opened, workspace: path => { workspacePath = path }, change: keys => { tabs = keys.map(contentId => ({ contentId })); subscribers.forEach(fn => fn()) } }
}

test('held dock addresses survive layout reconciliation and are not orphans', async t => {
  const { registry, change, closed } = harness(t)
  registry.hold(PREFIX + 'dock-a')
  await tick()
  change([])
  await tick()
  assert.deepEqual(closed, [])
  assert.deepEqual(Array.from(registry.orphans(), s => s.terminalId), ['side-a', 'orphan'])
})

test('release closes the last reference and disposes its view', async t => {
  const { registry, closed, disposed } = harness(t)
  registry.hold(PREFIX + 'dock-a')
  registry.view({ signal: {}, contentId: PREFIX + 'dock-a' })
  await tick()
  registry.release(PREFIX + 'dock-a')
  await tick()
  assert.deepEqual(closed, ['dock-a'])
  assert.deepEqual(disposed, [PREFIX + 'dock-a'])
})

test('sidebar removal keeps a held PTY; release keeps a sidebar reference', async t => {
  const { registry, change, closed } = harness(t, [PREFIX + 'side-a', PREFIX + 'dock-a'])
  registry.hold(PREFIX + 'dock-a')
  registry.hold(PREFIX + 'side-a')
  await tick()
  change([PREFIX + 'side-a'])
  registry.release(PREFIX + 'side-a')
  await tick()
  assert.deepEqual(closed, [])
  change([])
  registry.release(PREFIX + 'dock-a')
  await tick()
  assert.deepEqual(closed.sort(), ['dock-a', 'side-a'])
})

test('re-holding before queued cleanup cancels disposal and shutdown preserves PTYs', async t => {
  const { registry, closed, disposed } = harness(t)
  registry.hold(PREFIX + 'dock-a')
  registry.view({ signal: {}, contentId: PREFIX + 'dock-a' })
  await tick()
  registry.release(PREFIX + 'dock-a')
  registry.hold(PREFIX + 'dock-a')
  await tick()
  assert.deepEqual(closed, [])
  assert.deepEqual(disposed, [])
  registry.dispose()
  await tick()
  assert.deepEqual(closed, [])
})

test('a delayed dock open keeps its own folder after the active workspace changes', async t => {
  const h = harness(t)
  for (const key of ['bound-a', 'bound-home', 'sidebar-current']) h.registry.hold(PREFIX + key)
  const dock = h.registry.view({ signal: {}, contentId: PREFIX + 'bound-a', cwd: 'C:\\a' })
  const unassigned = h.registry.view({ signal: {}, contentId: PREFIX + 'bound-home', cwd: null })
  const sidebar = h.registry.view({ signal: {}, contentId: PREFIX + 'sidebar-current' })
  h.workspace('C:\\b')
  await dock.connect(); await unassigned.connect(); await sidebar.connect()
  assert.deepEqual(h.opened.map(call => call.cwd), ['C:\\a', null, 'C:\\b'])
})

test('rc2 sidebar terminals start in the selected main-view workspace', async t => {
  const h = harness(t, [], true), key = PREFIX + 'rc2-sidebar'
  h.registry.hold(key)
  await h.registry.view({ signal: {}, contentId: key }).connect()
  assert.equal(h.opened[0].cwd, 'C:\\a')
})

test('closing while profiles are loading never starts an ownerless native shell', async () => {
  let profilesDone
  const profiles = new Promise(resolve => { profilesDone = resolve })
  const calls = [], listeners = new Set()
  class Terminal {
    loadAddon() {} onData() {} attachCustomKeyEventHandler() {} reset() {} dispose() {}
  }
  class Observer { observe() {} disconnect() {} }
  const sandbox = {
    Terminal, FitAddon: class {}, ResizeObserver: Observer, MutationObserver: Observer,
    setInterval: () => 1, clearInterval() {}, queueMicrotask, crypto: { randomUUID: () => 'view' },
    document: { documentElement: {}, body: {}, addEventListener() {}, removeEventListener() {}, createElement: () => ({ addEventListener() {}, remove() {} }) },
    window: { __DSH_TERMINAL_IDENTITY__: {}, addEventListener() {}, removeEventListener() {}, __TAURI__: { core: {
      Channel: class {}, invoke: async name => { calls.push(name); return name === 'terminal_profiles' ? profiles : [] },
    } } },
    ctx: {
      slots: { entriesOfSlot: () => [{ store: { create() {} } }], resolveStore: () => ({ subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)), getSnapshot: () => ({ bySession: {} }) }) },
      sessions: { scope: () => ({}), list: { subscribe: () => () => {}, getSnapshot: () => ({ phase: 'ready', ids: ['a'] }) } },
      workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [] }) } },
    },
  }
  vm.runInNewContext(selectionSource + '\n' + source.replace(/^import .+\n/gm, '').replace(/^export /gm, '') + '\nthis.registry=createRegistry(ctx)', sandbox)
  const registry = sandbox.registry, key = PREFIX + 'dock-pending'
  registry.hold(key)
  const connected = registry.view({ signal: {}, contentId: key }).connect()
  await tick()
  registry.release(key)
  await tick()
  profilesDone([{ profileId: 'cmd' }]); await connected
  assert.equal(calls.includes('terminal_open'), false)
  registry.dispose()
})

test('pointer and focus events share one control grant and refocusing renews it', async () => {
  const events = new Map(), grants = []
  const element = { addEventListener: (name, fn) => events.set(name, fn), contains: () => false, remove() {} }
  class Terminal { loadAddon() {} onData() {} attachCustomKeyEventHandler() {} reset() {} dispose() {} }
  class Observer { observe() {} disconnect() {} }
  const sandbox = {
    Terminal, FitAddon: class {}, ResizeObserver: Observer, MutationObserver: Observer,
    setInterval: () => 1, clearInterval() {}, queueMicrotask, crypto: { randomUUID: () => 'view' },
    document: { documentElement: {}, body: {}, addEventListener() {}, removeEventListener() {}, createElement: () => element },
    window: { __DSH_TERMINAL_IDENTITY__: {}, __TAURI__: { core: { Channel: class {}, invoke: async name => {
      if (name === 'terminal_profiles') return [{ profileId: 'cmd' }]
      if (name === 'terminal_attach') return 'attachment'
      if (name === 'terminal_control') return new Promise(resolve => grants.push(resolve))
    } } } },
  }
  vm.runInNewContext(selectionSource + '\n' + source.replace(/^import .+\n/gm, '').replace(/^export /gm, '') + `\nthis.view=createView('key',async()=>({terminalId:'t',runId:1,state:'running',profileId:'cmd'}),async()=>{},()=>{})`, sandbox)
  const v = sandbox.view
  await v.connect()
  events.get('pointerdown')(); events.get('focusin')()
  assert.equal(grants.length, 1, 'one grant while focus and pointer events overlap')
  grants[0](1); await tick()
  assert.equal(v.readyForInput, true)
  events.get('pointerdown')(); await tick()
  assert.equal(grants.length, 1, 'clicking a controlled terminal cannot invalidate queued input')
  events.get('focusout')({ relatedTarget: null })
  assert.equal(v.readyForInput, false)
  events.get('focusin')()
  assert.equal(grants.length, 2)
  grants[1](2); await tick()
  assert.equal(v.readyForInput, true)
  v.unmount()
  assert.equal(v.readyForInput, false)
  v.dispose()
})
