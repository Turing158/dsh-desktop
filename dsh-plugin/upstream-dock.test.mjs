import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUpstreamRegistry, createUpstreamBody, createUpstreamRemoteState, UPSTREAM_PREFIX } from './sidebar-terminal/upstream-dock.mjs'
import { createUpstreamPreferences, installUpstreamShellDefault, bindUpstreamShortcut } from './sidebar-terminal/upstream-preferences.mjs'
import { SettingsSchema } from './sidebar-terminal/index.js'
import { createDockStore, createDockWorkspaceSource } from './sidebar-terminal/dock.mjs'
import { restartTerminalTarget, sidebarTerminalTarget } from './sidebar-terminal/upstream-tab-menu.mjs'

function source(value) {
  const listeners = new Set()
  return { getSnapshot: () => value, subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)),
    set(next) { value = next; listeners.forEach(fn => fn()) } }
}
function fixture(t, disk = new Map(), preferences) {
  const calls = { views: [], closes: [], retained: [] }
  const models = new Map()
  const storage = { getItem: key => disk.get(key), setItem: (key, value) => disk.set(key, value) }
  const ctx = {
    sessions: { list: source({ phase: 'ready', current: 'a', byId: { a: { id: 'a' }, a2: { id: 'a2' }, b: { id: 'b' } } }) },
    workspaces: { list: source({ phase: 'ready', items: [
      { path: 'C:/one', sessionIds: ['a', 'a2'] }, { path: 'C:/two', sessionIds: ['b'] },
    ] }) },
    sidebarRight: { openTabs: source([{ kind: 'terminal', sessionId: 'a', tabId: 'right', contentId: 'sidebar://terminal/right' }]) },
    webTerminals: {
      retainTabs(tabs) { calls.retained = tabs },
      view(sessionId, key, contentId, terminalId, shellPath) {
        calls.views.push({ sessionId, key, contentId, ...(shellPath === undefined ? {} : { shellPath }) })
        if (!models.has(key)) models.set(key, { state: source({ writable: true, phase: 'connected' }), async close() {} })
        return models.get(key)
      },
      close(...args) { calls.closes.push(args); models.delete(args[1]) },
    },
  }
  const originalRetain = ctx.webTerminals.retainTabs
  const registry = createUpstreamRegistry(ctx, { storage, preferences })
  let serial = 0
  const store = createDockStore(registry, { storage, viewport: () => 800, uuid: () => String(++serial),
    workspaceSource: createDockWorkspaceSource(ctx), prefix: UPSTREAM_PREFIX, storageKey: 'upstream-dock-test' })
  const dispose = () => { store.dispose(); registry.dispose() }
  t.after(dispose)
  return { ctx, registry, store, disk, calls, dispose, originalRetain }
}

test('native dock snapshots cross origins with project owners, shells, active tabs and visibility intact', t => {
  const original = fixture(t, new Map(), { shellPath: () => 'chosen-shell' })
  const select = (f, current) => f.ctx.sessions.list.set({ ...f.ctx.sessions.list.getSnapshot(), current })
  original.store.open(); const first = original.store.getSnapshot().tabs[0]
  original.store.add(); original.store.activate(first.contentId)
  original.store.resize(320)
  original.store.collapse(true)
  select(original, 'b')
  original.registry.withShellPath('second-shell', () => original.store.add())
  original.store.collapse(true)
  const provider = createUpstreamRemoteState(original.ctx, original.registry, original.store)
  const saved = JSON.parse(JSON.stringify(provider.capture()))
  assert.equal(saved.backend, 'dsh')
  assert.equal(saved.sessions.length, 3)
  const next = fixture(t)
  const restored = createUpstreamRemoteState(next.ctx, next.registry, next.store)
  restored.restore(saved); restored.restore(saved)
  assert.deepEqual(restored.capture(), saved)
  assert.equal(next.calls.views.length, 0, 'restoration does not allocate terminals or send commands')
  assert.equal(next.calls.closes.length, 0, 'retries do not restart restored shells')
  assert.equal(next.store.getSnapshot().active, first.contentId)
  assert.equal(next.store.getSnapshot().height, 320)
  next.registry.view(next.store.getSnapshot().tabs[0])
  select(next, 'b')
  next.registry.view(next.store.getSnapshot().tabs[0])
  assert.deepEqual(next.calls.views.map(v => [v.sessionId, v.shellPath]), [['a', 'chosen-shell'], ['b', 'second-shell']])
})

test('native terminal restore rejects missing owners and inconsistent payloads before changing holds', t => {
  const original = fixture(t); original.store.open()
  const saved = createUpstreamRemoteState(original.ctx, original.registry, original.store).capture()
  for (const corrupt of [
    value => { value.sessions[0].sessionId = 'missing' },
    value => { value.backend = 'desktop' },
    value => { value.dock.workspaces[0].tabs.push(value.dock.workspaces[0].tabs[0]) },
    value => { value.sessions[0].cwd = 'C:/wrong-project' },
    value => { value.dock.workspaces[0].active = 'missing' },
  ]) {
    const next = fixture(t), input = structuredClone(saved); corrupt(input)
    const provider = createUpstreamRemoteState(next.ctx, next.registry, next.store)
    assert.throws(() => provider.restore(input), /snapshot-(terminal-unsupported|session-missing)/)
    assert.equal(next.registry.sessions.length, 0)
    assert.equal(next.calls.views.length, 0)
    assert.equal(next.calls.closes.length, 0)
  }
  const next = fixture(t)
  const provider = createUpstreamRemoteState(next.ctx, next.registry, next.store)
  provider.restore(saved)
  const conflict = structuredClone(saved); conflict.sessions[0].shellPath = 'changed'
  assert.throws(() => provider.restore(conflict), /snapshot-terminal-conflict/)
  assert.deepEqual(provider.capture(), saved)
})

test('DSH dock retains collapsed and inactive projects alongside right sidebar terminals', t => {
  const f = fixture(t)
  assert.equal(f.calls.views.length, 0, 'opening the app does not allocate a shell')
  f.store.open()
  const a = f.store.getSnapshot().tabs[0]
  f.registry.view(a)
  assert.equal(f.calls.views[0].sessionId, 'a')
  f.ctx.sessions.list.set({ phase: 'ready', current: 'a2' })
  assert.equal(f.store.getSnapshot().active, a.contentId, 'same project keeps its terminals')
  f.ctx.sessions.list.set({ phase: 'ready', current: 'b' })
  const b = f.store.getSnapshot().tabs[0]
  f.registry.view(b)
  assert.equal(f.calls.views[1].sessionId, 'b')
  f.store.collapse(true)
  f.ctx.webTerminals.retainTabs([{ sessionId: 'b', tabId: 'new-right', contentId: 'sidebar://terminal/new-right' }])
  assert.deepEqual(f.calls.retained.map(tab => tab.tabId), ['new-right', a.contentId, b.contentId])
  assert.equal(f.calls.closes.length, 0)
  f.ctx.sessions.list.set({ phase: 'ready', current: 'a' })
  f.store.open()
  assert.equal(f.store.getSnapshot().active, a.contentId)
  f.store.close(a.contentId)
  assert.deepEqual(f.calls.closes, [['a', a.contentId, a.contentId]])
  assert.deepEqual(f.calls.retained.map(tab => tab.tabId), ['new-right', b.contentId])
  f.dispose()
  assert.equal(f.ctx.webTerminals.retainTabs, f.originalRetain)
  assert.equal(f.calls.closes.length, 1, 'unloading detaches without closing other terminals')
})

test('reload restores dock identities with their owning sessions and allocates only on view', t => {
  const first = fixture(t)
  first.store.open()
  const a = first.store.getSnapshot().tabs[0]
  first.ctx.sessions.list.set({ phase: 'ready', current: 'b' })
  const b = first.store.getSnapshot().tabs[0]
  first.dispose()
  const next = fixture(t, first.disk)
  assert.equal(next.store.getSnapshot().collapsed, true)
  assert.equal(next.calls.views.length, 0)
  assert.equal(next.store.getSnapshot().active, a.contentId)
  next.ctx.sessions.list.set({ phase: 'ready', current: 'b' })
  next.store.open()
  assert.equal(next.store.getSnapshot().active, b.contentId)
  next.registry.view(next.store.getSnapshot().tabs[0])
  assert.deepEqual(next.calls.views, [{ sessionId: 'b', key: b.contentId, contentId: b.contentId }])
})

test('dock mounts the registered DSH component and routes its replacement action to the dock', () => {
  function DSHBody() {}
  const React = { createElement: (type, props) => ({ type, props }), useSyncExternalStore: (_subscribe, snapshot) => {
    const value = snapshot()
    assert.equal(snapshot(), value, 'external store snapshots must be stable between updates')
    return value
  } }
  const calls = [], model = { state: source({ phase: 'connected' }) }
  const entry = { options: { key: 'DSH' }, component: DSHBody, locale: 'sidebarTerminal' }
  const ctx = { slots: { entriesOfSlot: () => [entry], subscribe() {} },
    theme: { getTheme: () => 'dark' }, on() {}, locale: { bind: name => name } }
  const Body = createUpstreamBody(React, ctx, 'DSH')
  const tree = Body({ tab: { contentId: 'terminal-key' }, view: { model }, store: { close: key => calls.push(key), add: () => calls.push('add') } })
  assert.equal(tree.type, DSHBody)
  assert.equal(tree.props.view(), model)
  assert.equal(tree.props.useTerminal('terminal-key').phase, 'connected')
  assert.equal(tree.props.useTheme(), 'dark')
  assert.equal(tree.props.t, 'sidebarTerminal')
  tree.props.useTabInfo().tab.actions.openTab('terminal', { replaceTab: true })
  assert.deepEqual(calls, ['terminal-key', 'add'])
})


const tick = () => new Promise(resolve => setImmediate(resolve))
function preferencesFixture(t) {
  const snapshot = source({status:'ready',value:{profileId:'cmd',position:'bottom'}})
  const writes=[],opened=[]
  const scope={...snapshot,async set(field,value){writes.push([field,value]);snapshot.set({status:'ready',value:SettingsSchema({...snapshot.getSnapshot().value,[field]:value})});return true}}
  const ctx={sessions:{list:source({phase:'ready',current:'s'})},sidebarRight:{openTab:(...args)=>opened.push(args)},webTerminals:{launchShells:async()=>({shells:[{path:'C:/Windows/cmd.exe',name:'CMD'},{path:'C:/Git/bin/bash.exe',name:'Git Bash'}]})}}
  const preferences=createUpstreamPreferences(ctx,scope,new EventTarget())
  t.after(()=>preferences.dispose())
  return {ctx,scope,preferences,writes,opened}
}
test('DSH shell discovery migrates legacy preferences and persists the chosen path',async t=>{
  const f=preferencesFixture(t);await tick()
  assert.equal(f.preferences.shellPath(),'C:/Windows/cmd.exe')
  assert.equal(f.preferences.getSnapshot().profiles.length,2)
  await f.preferences.set('profileId','C:/Git/bin/bash.exe')
  await f.preferences.set('position','right')
  assert.deepEqual(f.writes,[['shellPath','C:/Git/bin/bash.exe'],['position','right']])
  assert.equal(f.preferences.shellPath(),'C:/Git/bin/bash.exe')
  const original=(...args)=>args
  f.ctx.webTerminals.view=original
  const off=installUpstreamShellDefault(f.ctx.webTerminals,f.preferences)
  assert.equal(f.ctx.webTerminals.view('s','new','url')[4],'C:/Git/bin/bash.exe')
  assert.equal(f.ctx.webTerminals.view('s','new','url',undefined,'C:/Windows/cmd.exe')[4],'C:/Windows/cmd.exe','explicit guide selection wins')
  assert.equal(f.ctx.webTerminals.view('s','old','url','restored-id')[3],'restored-id')
  off();assert.equal(f.ctx.webTerminals.view,original)
  await f.preferences.set('profileId','auto')
  assert.equal(f.preferences.shellPath(),undefined)
  assert.equal(f.scope.getSnapshot().value.shellPath,'')
})
test('DSH shortcuts route to the configured seat and prevent duplicate upstream handling',async t=>{
  const f=preferencesFixture(t);await tick()
  const target=new EventTarget(),bottom=[]
  const dock={store:{openMatching:fn=>bottom.push(fn('old'))},registry:{matchesShell:(_key,path)=>path==='C:/Windows/cmd.exe'}}
  const off=bindUpstreamShortcut(target,f.ctx,dock,f.preferences,error=>{throw error});t.after(off)
  let duplicates=0;target.addEventListener('keydown',()=>duplicates++)
  const press=()=>{const event=new Event('keydown',{cancelable:true});Object.assign(event,{ctrlKey:true,code:'Backquote',key:'~'});target.dispatchEvent(event);assert.equal(event.defaultPrevented,true)}
  press();await tick();assert.deepEqual(bottom,[true]);assert.equal(duplicates,0)
  await f.preferences.set('position','right');press();await tick()
  assert.deepEqual(f.opened,[['terminal',{params:{shellPath:'C:/Windows/cmd.exe'}}]])
  assert.equal(bottom.length,1)
})
test('dock tabs retain their creation shell while new tabs follow preference changes',t=>{
  let selected='C:/Windows/cmd.exe'
  const f=fixture(t,new Map(),{shellPath:()=>selected})
  f.store.open();const first=f.store.getSnapshot().tabs[0]
  selected='C:/Git/bin/bash.exe';f.store.add();const second=f.store.getSnapshot().tabs[1]
  f.registry.view(first);f.registry.view(second)
  assert.deepEqual(f.calls.views.map(v=>v.shellPath),['C:/Windows/cmd.exe','C:/Git/bin/bash.exe'])
  assert.equal(f.registry.matchesShell(first.contentId,selected),false)
  f.registry.withShellPath('C:/custom.exe',()=>f.store.add())
  f.registry.view(f.store.getSnapshot().tabs[2]);assert.equal(f.calls.views[2].shellPath,'C:/custom.exe')
})

test('restart retains the running shell, waits for cleanup and deduplicates rapid selections', async () => {
  let finish, closes = 0
  const replacements = []
  const model = { state: source({ info: { shell: { path: 'running-shell' } } }), close: () => { closes++; return new Promise(resolve => { finish = resolve }) } }
  const target = { model, shellPath: 'old-default', exists: () => true, replace: path => replacements.push(path) }
  const first = restartTerminalTarget(target)
  assert.equal(restartTerminalTarget(target, 'other-shell'), first)
  assert.deepEqual(replacements, [])
  finish(); await first
  assert.equal(closes, 1)
  assert.deepEqual(replacements, ['running-shell'])
})

test('failed cleanup and a tab closed during cleanup cannot spawn a replacement', async () => {
  let replaced = 0, exists = true, finish
  const target = { model: { state: source({}), close: async () => { throw Error('close failed') } }, exists: () => exists, replace: () => replaced++ }
  await assert.rejects(restartTerminalTarget(target), /close failed/)
  target.model.close = () => new Promise(resolve => { finish = resolve })
  const pending = restartTerminalTarget(target)
  exists = false; finish(); await pending
  assert.equal(replaced, 0)
})

test('right menu replaces the clicked occurrence in its owning session with the selected shell', async () => {
  const opened = [], views = []
  const signal = new AbortController()
  const navigation = source({ address: 'sidebar://terminal/inactive', params: { terminalId: 'restored', shellPath: 'original' } })
  const ctx = {
    sidebarRight: { tabDomain: { occurrence(sessionId, tab) {
      assert.equal(sessionId, 'original-session'); assert.equal(tab.id, 'inactive')
      return { navigation, signal: signal.signal, tabActions: { openTab: (...args) => opened.push(args) } }
    } } },
    webTerminals: { view: (...args) => { views.push(args); return { state: source({}), async close() {} } } },
  }
  assert.equal(sidebarTerminalTarget(ctx, 'original-session', { kind: 'file' }), null)
  const target = sidebarTerminalTarget(ctx, 'original-session', { kind: 'terminal', id: 'inactive' })
  await restartTerminalTarget(target, 'chosen-shell')
  assert.deepEqual(views, [['original-session', 'inactive', 'sidebar://terminal/inactive', 'restored', 'original']])
  assert.deepEqual(opened, [['terminal', { replaceTab: true, params: { shellPath: 'chosen-shell' } }]])
  navigation.set({ address: 'somewhere-else' })
  assert.equal(target.exists(), false)
})

test('switching an inactive dock terminal preserves its tab, order and owning project', async t => {
  const f = fixture(t, new Map(), { shellPath: () => 'original-shell' })
  f.store.open(); const first = f.store.getSnapshot().tabs[0]
  f.store.add(); const second = f.store.getSnapshot().tabs[1]
  const target = f.registry.terminalTarget(first)
  let finish
  target.model.close = () => new Promise(resolve => { finish = resolve })
  const pending = restartTerminalTarget(target, 'selected-shell')
  f.ctx.sessions.list.set({ phase: 'ready', current: 'b' })
  finish(); await pending
  assert.equal(f.calls.views.at(-1).sessionId, 'a')
  assert.equal(f.calls.views.at(-1).shellPath, 'selected-shell')
  assert.notEqual(f.registry.view(first).model, target.model)
  assert.equal(f.registry.matchesShell(first.contentId, 'selected-shell'), true)
  f.ctx.sessions.list.set({ phase: 'ready', current: 'a' })
  assert.deepEqual(f.store.getSnapshot().tabs, [first, second])
  assert.equal(f.store.getSnapshot().active, second.contentId)
  assert.deepEqual(f.calls.closes, [['a', first.contentId, first.contentId]])
  const restored = fixture(t, f.disk)
  assert.equal(restored.registry.matchesShell(first.contentId, 'selected-shell'), true)
})
