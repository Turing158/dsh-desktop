/**
 * Executes the terminal plugin's registration and address handling for real.
 *
 * ## Why this file exists
 *
 * `sidebar-terminal/client.js` is a hand-authored browser bundle, so it cannot be
 * imported like a module — but its body is ordinary JavaScript, and the two things
 * this project actually promises about it are both executable:
 *
 *   1. **One 终端 entry, and the terminal in the tab it was picked from.** The
 *      column is a black box here, but NOT an unmodelled one: the layout reducer
 *      below reimplements the two decisions the behaviour depends on, transcribed
 *      from the shipped code and cited in place (`planOpenContent`'s page
 *      dedup/focus branch, and `openContent`'s replace-at-this-index branch). That
 *      is what makes "a second guide click lands a second terminal in the guide's
 *      slot instead of jumping to the first one" an assertion rather than a claim.
 *
 *   2. **原版 shows no entry, and no event storm double-registers it.** The type id
 *      is unique in the registry, so a second live registration throws where the
 *      app would instead fail the whole boot.
 *
 * The React stub is deliberately thin: the component is CALLED as a function, so
 * `useLayoutEffect` runs its callback inline and the adoption can be observed
 * without a renderer.
 *
 * Run with: `node --test dsh-plugin/`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'sidebar-terminal', 'client.js'), 'utf8')

/** The identity the DSH registry keys on; a second live registration of it throws. */
const ID = '@dsh-desktop/sidebar-terminal'
const KIND = 'desktop-terminal'
const PAGE_ADDRESS = `sidebar://${KIND}`
/**
 * The address prefix the adoption must use.
 *
 * `dsh-resource://` IS the assertion, not a detail: `placeResource` throws on any
 * other scheme, and the FIRST live smoke run of this plugin failed exactly there —
 * a private scheme was rejected by the call that opens it, the terminal silently
 * stayed on the shared page address, and a second guide click jumped back to the
 * first terminal instead of opening a new one.
 */
const SCHEME = 'dsh-resource://desktop-terminal/'

/**
 * Load the bundle with a DOM stub in scope and return its exports.
 *
 * The file is a `window.__ModuleLoader__.load({ id, factory })` registration, so
 * the stub records the factory and calls it with a bare `require` for React. The
 * document goes into the sandbox because the bundle closes over it at evaluation
 * time — substituting it afterwards would have no effect.
 *
 * @param document - the DOM stub the bundle should see.
 * @returns the module exports (`apply`, `inject`).
 */
function loadBundle(document, { desktop = true, runtime, uiState } = {}) {
  let captured
  /** Effects registered through `ctx.effect`, by label, so a test can tear them down. */
  const sandbox = {
    console,
    crypto: { randomUUID: () => 'test-uuid' },
    document,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init?.detail
      }
    },
  }
  sandbox.window = sandbox
  sandbox.top = sandbox
  if (desktop) sandbox.__TAURI__ = { core: { Channel: class {}, invoke() {} } }
  sandbox.DSHTerminal = runtime
  sandbox.__DSH_UI_STATE__ = uiState
  sandbox.globalThis = sandbox
  sandbox.window.__ModuleLoader__ = {
    load: (entry) => {
      captured = entry
    },
  }

  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'sidebar-terminal/client.js' }).runInContext(sandbox)

  assert.ok(captured, 'the bundle must register itself with __ModuleLoader__')
  assert.equal(captured.id, ID)

  /** Runs a layout effect inline and remembers its cleanup. */
  const react = {
    createElement: (type, props, ...children) => ({
      type: typeof type === 'function' ? type.name || 'component' : type,
      props: props ?? {},
      children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
      component: typeof type === 'function' ? type : null,
    }),
    useLayoutEffect: (fn) => {
      react.cleanups.push(fn())
    },
    cleanups: [],
  }

  const module = captured.factory((name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return {}
    throw new Error(`unexpected require: ${name}`)
  })
  module.react = react
  return module
}

/**
 * A `document` stub carrying the mode attribute and dispatching the overlay's own
 * announcement, exactly as `ui-client/client.js` does.
 *
 * @returns the stub.
 */
function createDocument() {
  const attributes = new Map()
  const listeners = new Map()

  const stub = {
    documentElement: {
      getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
      setAttribute: (name, value) => attributes.set(name, String(value)),
    },
    addEventListener: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    removeEventListener: (name, fn) => {
      const held = listeners.get(name)
      if (held) listeners.set(name, held.filter((entry) => entry !== fn))
    },
    dispatchEvent: (event) => {
      for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event)
      return true
    },
    /** Announce an applied mode, as the appearance plugin does. */
    announce: (mode) => {
      attributes.set('data-dsh-ui', mode)
      stub.dispatchEvent({ type: 'dsh-desktop:ui-mode', detail: { mode } })
    },
    mode: (value) => {
      if (value !== undefined) attributes.set('data-dsh-ui', value)
      return attributes.get('data-dsh-ui') ?? null
    },
    listenerCount: (name) => (listeners.get(name) ?? []).length,
  }
  return stub
}

/**
 * The last few lines of the shipped layout reducer, and nothing else.
 *
 * ## What is modelled, and why the rest is not
 *
 * Two decisions decide the delivered behaviour, and both are transcribed here
 * rather than guessed:
 *
 *   - **`planOpenContent` (dsh-web-frontend, `lib`→`e7`)**: a PAGE
 *     (`contentId === sidebar://<kind>`) is looked up across the pane by
 *     (address, kind) and FOCUSED when found — `revealIfOpened` is forced false
 *     for pages. A RESOURCE honours the caller's `revealIfOpened`, so
 *     `revealIfOpened: false` opens a second tab at a fresh address.
 *   - **`openContent` (ui-sidebar-right)**: with `replaceTab`, the new tab takes
 *     the replaced tab's pane AND index, and the replaced tab closes in the same
 *     commit.
 *
 * Everything else about the kit — splits, floats, reordering, history — is
 * deliberately absent: none of it can change what this plugin does, and modelling
 * it would only make this file harder to trust.
 *
 * @returns the layout, its store actions, and the writes it recorded.
 */
function createLayout() {
  const state = {
    tabs: {
      t1: { id: 't1', kind: 'files', contentId: 'sidebar://files', title: '文件' },
      t2: { id: 't2', kind: 'guide', contentId: 'sidebar://guide', title: '开始' },
    },
    panes: { p1: { id: 'p1', host: 'dock', tabs: ['t1', 't2'] } },
    activePaneId: 'p1',
    floats: [],
  }
  const writes = []
  let seq = 2

  /** `findPaneContentTab`: by address, and by kind when one is given. */
  function contentTab(paneId, address, kind) {
    for (const id of state.panes[paneId].tabs) {
      const tab = state.tabs[id]
      if (tab && tab.contentId === address && (kind === undefined || tab.kind === kind)) return id
    }
    return undefined
  }

  /** `findTabPane`. */
  function tabPane(tabId) {
    for (const pane of Object.values(state.panes)) if (pane.tabs.includes(tabId)) return pane
    return undefined
  }

  /**
   * `actions.openContent(intent, settled)`.
   *
   * @param intent - kind, contentId, title, and the optional placement.
   * @param settled - called with the tab the open landed on.
   */
  function openContent(intent, settled) {
    writes.push({ ...intent })
    const replacing = intent.replaceTab === undefined ? undefined : tabPane(intent.replaceTab)
    const pane = replacing ?? state.panes[intent.paneId ?? state.activePaneId]
    const index = replacing === undefined ? undefined : replacing.tabs.indexOf(intent.replaceTab)
    const page = intent.contentId === `sidebar://${intent.kind}`

    // A page resolves across the pane and, when found, is FOCUSED: nothing opens.
    const held = page ? contentTab(pane.id, `sidebar://${intent.kind}`, intent.kind) : undefined
    if (held !== undefined) {
      settled(held)
      return
    }

    const reveal = page ? false : intent.revealIfOpened
    const existing = reveal === false ? undefined : contentTab(pane.id, intent.contentId, intent.kind)
    if (existing !== undefined) {
      settled(existing)
      return
    }

    seq += 1
    const id = `tab${seq}`
    state.tabs[id] = { id, kind: intent.kind, contentId: intent.contentId, title: intent.title }
    if (index === undefined) pane.tabs.push(id)
    else {
      pane.tabs.splice(index, 0, id)
      pane.tabs.splice(pane.tabs.indexOf(intent.replaceTab), 1)
      delete state.tabs[intent.replaceTab]
    }
    settled(id)
  }

  return {
    state,
    writes,
    tabs: () => state.panes.p1.tabs.map((id) => state.tabs[id]).filter(Boolean),
    contentTab,
    /** `openTab(kind, options)`: the page path, as `placeTab` composes it. */
    openPage(kind, options = {}, from) {
      const placement = from?.actions
        ? from.actions.openTab(kind, options)
        : rawPlacement(kind, options)
      return placement
    },
    /** The shipped guide's own click path: `tab.actions.openTab(kind, { replaceTab: true })`. */
    openPageFrom(tab, kind, options = {}) {
      return tab.actions.openTab(kind, options)
    },
    openContent,
  }

  /** `placeTab` → `place` → `openContent`, for a caller acting outside any tab. */
  function rawPlacement(kind, options) {
    const address = `sidebar://${kind}`
    openContent(
      {
        kind,
        contentId: address,
        title: kind,
        ...(options.paneId === undefined ? {} : { paneId: options.paneId }),
        ...(options.replaceTab === undefined ? {} : { replaceTab: true }),
        ...(options.revealIfOpened === undefined ? {} : { revealIfOpened: options.revealIfOpened }),
      },
      () => {},
    )
  }
}

/**
 * The `hold()`-shaped tab record one pane occurrence hands to a body.
 *
 * `place()` (ui-sidebar-right) folds the placement into the tab's own actions:
 * `replaceTab: true` becomes the acting tab's id, and its pane is inherited. This
 * mirrors that, because it is the mechanism the adoption relies on.
 *
 * @param layout - the layout from {@link createLayout}.
 * @param tabId - the tab the body belongs to.
 * @returns the record, its abort controller, and the writes it caused.
 */
function createTabRecord(layout, tabId) {
  const controller = new AbortController()
  const record = {
    get id() {
      return tabId
    },
    get contentId() {
      return layout.state.tabs[tabId]?.contentId
    },
    get kind() {
      return layout.state.tabs[tabId]?.kind
    },
    signal: controller.signal,
    /** Model the column aborting this occurrence: the record is on its way out. */
    abort: () => controller.abort(),
    actions: {
      openResource(address, options = {}) {
        layout.openContent(
          {
            kind: options.kind ?? layout.state.tabs[tabId]?.kind ?? KIND,
            contentId: address,
            title: '终端',
            ...(options.replaceTab === true ? { replaceTab: tabId } : {}),
            ...(options.revealIfOpened === undefined ? {} : { revealIfOpened: options.revealIfOpened }),
          },
          () => {},
        )
      },
      openTab(kind, options = {}) {
        layout.openContent(
          {
            kind,
            contentId: `sidebar://${kind}`,
            title: kind,
            ...(options.replaceTab === true ? { replaceTab: tabId } : {}),
            ...(options.revealIfOpened === undefined ? {} : { revealIfOpened: options.revealIfOpened }),
          },
          () => {},
        )
      },
      close() {
        const pane = layout.state.panes.p1
        pane.tabs = pane.tabs.filter((id) => id !== tabId)
        delete layout.state.tabs[tabId]
      },
    },
  }
  return record
}

/**
 * A stub client context that models the registry's own uniqueness rules.
 *
 * The id check is not a formality: registering `ID` twice is what the shipped
 * `SidebarRightTabRegistry` throws on, and a throw inside `apply()` fails the whole
 * boot rather than one entry.
 *
 * @returns the context plus the bookkeeping a test asserts on.
 */
function createContext({ legacySettings = false } = {}) {
  const state = {
    types: new Map(),
    bodies: new Map(),
    overlays: new Map(),
    toggles: new Map(),
    injections: [],
    warnings: [],
    effects: new Map(),
    typeListeners: new Set(),
    settings: new Map(),
    registrations: 0,
  }

  const ctx = {
    webTerminals: {}, theme: {}, locale: {},
    ...(legacySettings
      ? { settingsScope: { bind: ({ namespace }) => { assert.equal(namespace, 'desktop-terminal-dock'); return {} } } }
      : { configForms: { get: namespace => { assert.equal(namespace, 'desktop-terminal-dock'); return {} } } }),
    inject: (services, callback) => {
      if (services.every(service => ctx[service])) {
        const before = new Set(state.effects.keys())
        callback(ctx)
        const effects = [...state.effects].filter(([key]) => !before.has(key)).map(([, dispose]) => dispose)
        return { dispose: () => effects.forEach(dispose => dispose?.()) }
      }
    },
    logger: { warn: (message) => state.warnings.push(message) },
    effect: (fn, label) => {
      // The TEARDOWN is what a test needs to call, so that is what is kept —
      // storing the body would make "tear down" re-run the registration instead.
      const dispose = fn()
      state.effects.set(label, dispose)
      return dispose
    },
    sidebarRightTabs: {
      get: kind => [...state.types.values()].find(type => type.kind === kind),
      subscribe: listener => {
        state.typeListeners.add(listener)
        return () => state.typeListeners.delete(listener)
      },
      register: (definition) => {
        state.registrations += 1
        if (state.types.has(definition.id)) {
          throw new Error(`sidebarRight: tab type id "${definition.id}" is already registered`)
        }
        state.types.set(definition.id, definition)
        for (const listener of [...state.typeListeners]) listener()
        return () => {
          state.types.delete(definition.id)
          for (const listener of [...state.typeListeners]) listener()
        }
      },
    },
    slots: {
      inject: (name, callback) => {
        assert.ok(
          ['sidebar.right.pane.tab', 'shell.overlay', 'conversation.session.header.utilities', 'settings.general.item'].includes(name),
          `unexpected slot ${name}`,
        )
        state.injections.push(name)
        return callback()
      },
      register: (spec, component) => {
        if (spec.name === 'settings.general.item') {
          assert.equal(state.settings.has(spec.id), false)
          state.settings.set(spec.id, component)
          return () => state.settings.delete(spec.id)
        }
        if (spec.name === 'shell.overlay') {
          assert.equal(spec.id, 'desktop-terminal-dock')
          assert.equal(spec.order, -1)
          assert.equal(state.overlays.has(spec.id), false)
          state.overlays.set(spec.id, component)
          return () => state.overlays.delete(spec.id)
        }
        if (spec.name === 'conversation.session.header.utilities') {
          // A LIST seat: the id is this plugin's own cell, and `order` is what puts
          // it immediately left of the corner seat the shipped 打开侧边栏 button
          // occupies. Registering into that corner instead would REPLACE the app's
          // own control, which is why this assertions exists at all.
          assert.equal(spec.id, 'desktop-terminal-dock')
          assert.equal(spec.order, 1)
          assert.equal(state.toggles.has(spec.id), false)
          state.toggles.set(spec.id, component)
          return () => state.toggles.delete(spec.id)
        }
        assert.equal(spec.name, 'sidebar.right.pane.tab')
        if (state.bodies.has(spec.key)) throw new Error(`duplicate body key ${spec.key}`)
        state.bodies.set(spec.key, component)
        return () => {
          state.bodies.delete(spec.key)
        }
      },
    },
  }

  return { ctx, state }
}

/** Open the guide's 终端 capsule the way the shipped guide does. */
function pickTerminalFromGuide(layout, guideTabId) {
  const guide = createTabRecord(layout, guideTabId)
  layout.openPageFrom(guide, KIND, { replaceTab: true })
}

// ── the registration ─────────────────────────────────────────────────────────

test('browser registers no terminal surfaces or settings and starts only stale-tab cleanup', () => {
  const document = createDocument(), { ctx, state } = createContext()
  let cleanup = 0, disposed = 0
  loadBundle(document, { desktop: false, runtime: { hideDesktopTerminals(value) { assert.equal(value, ctx); cleanup++; return () => disposed++ } } }).apply(ctx)
  assert.equal(cleanup, 1)
  assert.equal(state.types.size + state.bodies.size + state.overlays.size + state.toggles.size, 0)
  assert.deepEqual(state.injections, [])
  state.effects.get('desktop terminal browser cleanup')()
  assert.equal(disposed, 1)
})

test('the plugin declares its registration, runtime and settings services', () => {
  const module = loadBundle(createDocument())
  assert.deepEqual(
    Array.from(module.inject),
    ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'workspaces'],
    'an undeclared service parks the plugin instead of loading it',
  )
})

test('desktop registers one type with one guide entry, and the body under the same id', () => {
  const document = createDocument()
  document.mode('desktop')
  const { ctx, state } = createContext()

  loadBundle(document).apply(ctx)

  assert.deepEqual([...state.types.keys()], [ID], 'exactly one type, keyed by the package id')
  const [definition] = state.types.values()
  assert.equal(definition.kind, KIND, 'the kind is what openTab names')
  assert.deepEqual(Array.from(definition.patterns), [`${SCHEME}**`])
  assert.equal(
    definition.priority,
    undefined,
    'omitting priority is the `extension` band, which outranks every shipped viewer',
  )
  assert.equal(typeof definition.title, 'function', 'a thunk, so a language change needs no re-registration')
  assert.equal(definition.title(), '终端')

  assert.equal(definition.guide.length, 1, 'one capsule, or the guide lists the entry twice')
  const [entry] = definition.guide
  assert.equal(entry.order, Number.MAX_SAFE_INTEGER, 'the entry sorts after every registered one')
  assert.equal(entry.title(), '终端')
  assert.equal(typeof entry.description, 'function')
  assert.equal(typeof entry.icon, 'function', 'the guide needs a glyph, or it draws its cube placeholder')

  assert.deepEqual(
    state.injections,
    ['sidebar.right.pane.tab', 'shell.overlay', 'conversation.session.header.utilities'],
    'each surface is injected once: the tab body, the bottom panel, and the header control that opens it',
  )
  assert.equal(state.overlays.size, 1)
  assert.equal(state.toggles.size, 1, 'the dock has exactly one header control')
  assert.deepEqual(
    [...state.bodies.keys()],
    [ID],
    'the body registers under the definition id — the seat looks it up by that key',
  )
})

test('the legacy settings service still activates the desktop terminal', () => {
  const document = createDocument(), { ctx, state } = createContext({ legacySettings: true })
  loadBundle(document).apply(ctx)
  assert.deepEqual([...state.types.keys()], [ID])
  assert.equal(state.bodies.size, 1)
})

const upstreamTerminal = {
  id: '@deepseek-ai/dsh-client-ui-sidebar-terminal', kind: 'terminal', priority: 'builtin',
  title: () => '终端', guide: [{ title: () => '新建终端' }],
}

function runtimeProbe() {
  const active = new Set(), started = []
  function resource(name) {
    assert.equal(active.has(name), false, 'no duplicate ' + name)
    active.add(name); started.push(name)
    return () => active.delete(name)
  }
  return { active, started,
    uiState: { registerProvider: () => resource('snapshot') },
    runtime: {
      createSettings: () => ({ preferences: {}, ProfileRow() {}, PositionRow() {}, dispose: resource('preferences') }),
      createRegistry: () => ({ dispose: resource('registry') }),
      createBody: () => () => null,
      createDock: () => ({ store: {}, dispose: resource('dock') }),
      createUpstreamSettings: () => ({ preferences: {}, ProfileRow() {}, PositionRow() {}, dispose: resource('upstream-preferences') }),
      installUpstreamShellDefault: () => resource('upstream-defaults'),
      installUpstreamTerminalInteractions: () => resource('upstream-interactions'),
      bindUpstreamShortcut: () => resource('upstream-shortcut'),
      createUpstreamDock: () => ({ store: {}, dispose: resource('upstream-dock') }),
      createUpstreamRemoteState: () => ({}),
      createRemoteState: () => ({}),
      bindShortcut: () => resource('shortcut'),
      hideDesktopTerminals: () => resource('cleanup'),
    },
  }
}

for (const legacySettings of [false, true]) {
  test(`built-in terminal keeps the dock and toggle without native fallback (${legacySettings ? 'legacy' : 'current'} settings)`, () => {
    const document = createDocument(), { ctx, state } = createContext({ legacySettings }), probe = runtimeProbe()
    ctx.sidebarRightTabs.register(upstreamTerminal)
    loadBundle(document, probe).apply(ctx)
    assert.deepEqual(probe.started, ['cleanup', 'upstream-preferences', 'upstream-defaults', 'upstream-interactions', 'upstream-dock', 'snapshot', 'upstream-shortcut'], 'uses DSH in the dock with one snapshot provider and no duplicate shortcuts')
    document.announce('vanilla'); document.announce('desktop')
    assert.deepEqual([...state.types.values()], [upstreamTerminal])
    assert.equal(state.bodies.size, 0)
    assert.equal(state.settings.size, 2)
    assert.equal(state.overlays.size, 1)
    assert.equal(state.toggles.size, 1)
    state.effects.get('desktop-sidebar-terminal: tab type and guide entry')()
    assert.equal(probe.active.size, 0)
    assert.equal(state.typeListeners.size, 0)
  })
}

test('late upstream registration fully tears down the fallback and its removal restores it once', () => {
  const document = createDocument(), { ctx, state } = createContext(), probe = runtimeProbe()
  loadBundle(document, probe).apply(ctx)
  assert.equal(state.settings.size, 2)
  assert.deepEqual([...probe.active].sort(), ['dock', 'preferences', 'registry', 'shortcut', 'snapshot'])
  const removeUpstream = ctx.sidebarRightTabs.register(upstreamTerminal)
  assert.deepEqual([...probe.active], ['cleanup', 'upstream-preferences', 'upstream-defaults', 'upstream-interactions', 'upstream-dock', 'snapshot', 'upstream-shortcut'])
  assert.deepEqual([...state.types.values()], [upstreamTerminal])
  assert.equal(state.bodies.size, 0)
    assert.equal(state.settings.size, 2)
  assert.equal(state.overlays.size, 1)
  assert.equal(state.toggles.size, 1)
  assert.equal(document.listenerCount('dsh-desktop:ui-mode'), 0)
  document.announce('desktop')
  const removeFiles = ctx.sidebarRightTabs.register({ id: 'files', kind: 'files' })
  removeFiles()
  assert.equal(probe.started.filter(name => name === 'cleanup').length, 1)
  removeUpstream()
  assert.equal(probe.active.has('cleanup'), false)
  assert.equal(probe.active.has('upstream-interactions'), false)
  assert.equal(state.types.has(ID), true)
  assert.equal(state.settings.size, 2)
  assert.equal(probe.started.filter(name => name === 'registry').length, 2)
  state.effects.get('desktop-sidebar-terminal: tab type and guide entry')()
  assert.equal(probe.active.size + state.typeListeners.size, 0)
  ctx.sidebarRightTabs.register(upstreamTerminal)
  assert.equal(probe.active.size, 0, 'disposed plugin must not reactivate')
})

test('canOpen accepts this type\'s own addresses and refuses anything else', () => {
  const document = createDocument()
  document.mode('desktop')
  const { ctx, state } = createContext()
  loadBundle(document).apply(ctx)

  const [definition] = state.types.values()
  assert.equal(definition.canOpen(`${SCHEME}abc`), true)
  // The router only consults canOpen after a glob match; the predicate states the
  // invariant the body depends on, so a future pattern change cannot loosen it.
  assert.equal(definition.canOpen('dsh-resource://file/a.md'), false)
  assert.equal(definition.canOpen('sidebar://desktop-terminal'), false)
})

// ── the mode gate ────────────────────────────────────────────────────────────

test('原版 withholds the guide entry and keeps the type, and switching back restores it', () => {
  const document = createDocument()
  document.mode('vanilla')
  const { ctx, state } = createContext()

  loadBundle(document).apply(ctx)

  // THE TYPE STAYS. A terminal the user already has open is dispatched by the
  // definition's id, so withdrawing the type would leave that tab rendering the
  // column's "nothing can view this" notice — a broken pane, which is not what
  // "the unmodified frontend" may mean.
  assert.deepEqual([...state.types.keys()], [ID], 'the type must stay registered in 原版')
  assert.deepEqual([...state.bodies.keys()], [ID], 'and so must its body')
  assert.equal(state.injections.length, 3, 'each surface is injected exactly once')
  assert.equal(
    state.types.get(ID).guide,
    undefined,
    'but the 终端 capsule is this project\'s addition, so the guide must not offer it',
  )

  document.announce('desktop')
  assert.equal(state.types.get(ID).guide.length, 1, 'the entry comes back with the overlay')

  document.announce('vanilla')
  assert.equal(state.types.get(ID).guide, undefined, 'and goes again')

  document.announce('desktop')
  assert.equal(state.types.get(ID).guide.length, 1, 'and returns a second time')
  assert.equal(
    state.bodies.size,
    1,
    'the body outlives every one of those changes: it is registered once, not per mode',
  )
})

test('a repeated mode never re-registers, and the id is never double-held', () => {
  const document = createDocument()
  document.mode('desktop')
  const { ctx, state } = createContext()
  loadBundle(document).apply(ctx)

  const first = state.types.get(ID)
  // The event is announcement-shaped: the appearance plugin re-announces the
  // current mode on startup, and an overlay re-injection can announce again.
  // Re-registering an id that is still live THROWS in the real registry, so a
  // naive "always replace" would fail the boot on the second announcement.
  document.dispatchEvent({ type: 'dsh-desktop:ui-mode', detail: { mode: 'desktop' } })
  document.dispatchEvent({ type: 'dsh-desktop:ui-mode', detail: { mode: 'desktop' } })
  document.announce('desktop')
  document.announce('desktop')

  assert.deepEqual(state.warnings, [], 'nothing was refused')
  assert.equal(state.registrations, 1, 'the same definition is left in place')
  assert.equal(state.types.get(ID), first, 'and it is the SAME registration, untouched')
})

test('the payload is ignored and the attribute is what decides', () => {
  const document = createDocument()
  document.mode('desktop')
  const { ctx, state } = createContext()
  loadBundle(document).apply(ctx)

  // A payload that disagrees with the page: the attribute is what the stylesheet
  // and the DOM tier are gated on, so it is the one answer that cannot be stale.
  document.dispatchEvent({ type: 'dsh-desktop:ui-mode', detail: { mode: 'vanilla' } })

  assert.deepEqual([...state.types.keys()], [ID], 'the page is still desktop, so the entry stays')
})

test('teardown releases the type, the body, and the announcement listener', () => {
  const document = createDocument()
  document.mode('desktop')
  const { ctx, state } = createContext()
  loadBundle(document).apply(ctx)

  assert.equal(state.effects.size, 1, 'the registrations live in one effect')
  const [teardown] = state.effects.values()
  teardown()

  assert.deepEqual([...state.types.keys()], [], 'a plugin reload must not leave an entry behind')
  assert.deepEqual([...state.bodies.keys()], [])
  assert.equal(state.overlays.size, 0, 'reload releases the dock seat too')
  assert.equal(
    document.listenerCount('dsh-desktop:ui-mode'),
    0,
    'a stranded listener would re-register the type after the plugin is gone',
  )

  // Re-applying is what a reload does; both halves must work a second time.
  loadBundle(document).apply(ctx)
  assert.deepEqual([...state.types.keys()], [ID])
  assert.equal(state.types.get(ID).guide.length, 1, 'including the guide entry')
})

// ── the navigation this plugin exists for ────────────────────────────────────

test('the first pick replaces the guide in place, and the terminal adopts its own address', () => {
  const document = createDocument()
  document.mode('desktop')
  const { ctx, state } = createContext()
  const module = loadBundle(document)
  module.apply(ctx)

  const layout = createLayout()
  assert.deepEqual(
    layout.tabs().map((tab) => tab.id),
    ['t1', 't2'],
    'the guide sits second, behind a files tab',
  )

  pickTerminalFromGuide(layout, 't2')

  assert.deepEqual(
    layout.tabs().map((tab) => tab.id),
    ['t1', 'tab3'],
    'the terminal takes the guide\'s own slot, and the guide is gone',
  )
  assert.equal(layout.tabs()[1].contentId, PAGE_ADDRESS, 'it opens at the page address first')

  // Now the body runs, as the seat runs it: the tab adopts an address of its own.
  //
  // A replacement in this store MINTS A NEW TAB ID for the same slot — verified in
  // the shipped reducer: `openContent` reads `findTabPane(state, replace)` by id,
  // then calls `planOpenContent`, which always mints (`tab: makeTab(...)`). So the
  // expected sequence is tab3 (the page-address open) replaced by tab4 (the
  // adoption), at the same index, with the guide's record closed.
  const Body = state.bodies.get(ID)
  const record = createTabRecord(layout, 'tab3')
  Body({
    useTabInfo: () => ({ tab: record }),
  })

  const [adopted] = layout.tabs().slice(1)
  assert.equal(
    adopted.contentId,
    `${SCHEME}tab3-test-uuid`,
    'the record moves to its own address: the tab id plus deterministic entropy, so no two adoptions can ever collide',
  )
  assert.deepEqual(
    layout.tabs().map((tab) => tab.id),
    ['t1', adopted.id],
    'and it keeps its place in the strip: the replacement takes the replaced tab\'s index',
  )
  assert.equal(layout.tabs()[1].kind, KIND)
})

test('a second pick opens a SECOND terminal in the guide\'s slot, keeping the first', () => {
  const document = createDocument()
  document.mode('desktop')
  const { ctx, state } = createContext()
  const module = loadBundle(document)
  module.apply(ctx)
  const Body = state.bodies.get(ID)

  const layout = createLayout()
  pickTerminalFromGuide(layout, 't2')
  const first = layout.tabs().at(-1)
  Body({ useTabInfo: () => ({ tab: createTabRecord(layout, first.id) }) })
  const firstAdopted = layout.tabs().at(-1)

  // A guide is added back the way the column's own "+" does it: a page, so it opens
  // fresh once no guide is left in the pane.
  layout.openContent(
    { kind: 'guide', contentId: 'sidebar://guide', title: '开始', paneId: 'p1', revealIfOpened: false },
    () => {},
  )
  const guideId = layout.tabs().at(-1).id

  pickTerminalFromGuide(layout, guideId)
  const second = layout.tabs().at(-1)
  Body({ useTabInfo: () => ({ tab: createTabRecord(layout, second.id) }) })
  const secondAdopted = layout.tabs().at(-1)

  assert.equal(
    firstAdopted.contentId,
    `${SCHEME}${first.id}-test-uuid`,
    'the first terminal keeps its own address',
  )
  assert.equal(
    firstAdopted.kind,
    KIND,
    'and survives the second pick, which is what a real tab strip must show',
  )
  assert.equal(
    layout.tabs().filter((tab) => tab.kind === KIND).length,
    2,
    'two terminals, two tabs',
  )
  assert.notEqual(
    layout.contentTab('p1', PAGE_ADDRESS, KIND),
    firstAdopted.id,
    'the page address is free again, which is the whole reason for the second address',
  )

  // The failure this guards, for the record: a terminal still sitting ON the page
  // address would be FOCUSED instead of opened, and the guide would stay put.
  const shared = createLayout()
  shared.openContent(
    { kind: KIND, contentId: PAGE_ADDRESS, title: '终端', paneId: 'p1', revealIfOpened: false },
    () => {},
  )
  shared.openContent(
    { kind: 'guide', contentId: 'sidebar://guide', title: '开始', paneId: 'p1', revealIfOpened: false },
    () => {},
  )
  const stuckGuide = shared.tabs().at(-1).id
  const before = shared.tabs().map((tab) => tab.id)
  pickTerminalFromGuide(shared, stuckGuide)
  assert.deepEqual(
    shared.tabs().map((tab) => tab.id),
    before,
    'a page-address terminal is focused and nothing moves — the jump this design removes',
  )
})

test('the rendered surface states its condition and offers nothing to type into', () => {
  const document = createDocument()
  document.mode('desktop')
  const { ctx, state } = createContext()
  loadBundle(document).apply(ctx)

  const layout = createLayout()
  pickTerminalFromGuide(layout, 't2')
  const Body = state.bodies.get(ID)
  Body({ useTabInfo: () => ({ tab: createTabRecord(layout, layout.tabs().at(-1).id) }) })
  const tree = Body({ useTabInfo: () => ({ tab: createTabRecord(layout, layout.tabs().at(-1).id) }) })

  /** Every string in the tree, so the copy is asserted where it is rendered. */
  const text = []
  const elements = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'string') {
      if (typeof node === 'string') text.push(node)
      return
    }
    if (typeof node !== 'object') return
    if (node.type) elements.push(node)
    if (node.props && typeof node.props.children === 'string') text.push(node.props.children)
    else if (node.props && node.props.children !== undefined) walk(node.props.children)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)

  const all = text.join(' ')
  assert.match(all, /桌面连接不可用/, 'the page must say it is not connected, in words')
  assert.match(all, /请在桌面应用中打开终端。/, 'and must say what that means for the user')
  assert.match(all, /桌面连接不可用/, 'the status row carries the same fact')

  // The acceptance rule is "no control that looks like it can run a command", and
  // that is a property of the tree, not of a screenshot.
  for (const tag of ['input', 'textarea', 'form']) {
    assert.equal(
      elements.some((element) => element.type === tag),
      false,
      `the surface must not render <${tag}>: this stage cannot execute anything`,
    )
  }
})

// ── the adoption's own boundaries ────────────────────────────────────────────

test('adoption is idempotent, and skips a tab that cannot act', () => {
  const document = createDocument()
  document.mode('desktop')
  const { ctx, state } = createContext()
  loadBundle(document).apply(ctx)
  const Body = state.bodies.get(ID)

  const layout = createLayout()
  pickTerminalFromGuide(layout, 't2')
  const record = createTabRecord(layout, layout.tabs().at(-1).id)
  const renders = layout.writes.length

  Body({ useTabInfo: () => ({ tab: record }) })
  const afterFirst = layout.writes.length
  Body({ useTabInfo: () => ({ tab: record }) })
  Body({ useTabInfo: () => ({ tab: record }) })

  assert.equal(afterFirst - renders, 1, 'the first render adopts the address once')
  assert.equal(
    layout.writes.length,
    afterFirst,
    're-rendering the same record must not write again — this is what stops a loop',
  )

  // An aborted occurrence is a tab that is going away: the column refuses its
  // actions, and asking anyway would be a write into a record nobody is drawing.
  const dying = createTabRecord(layout, layout.tabs().at(-1).id)
  dying.abort()
  const before = layout.writes.length
  Body({ useTabInfo: () => ({ tab: dying }) })
  assert.equal(layout.writes.length, before, 'an aborted tab is left alone')
})

test('a body with no page address to give up writes nothing', () => {
  const document = createDocument()
  document.mode('desktop')
  const { ctx, state } = createContext()
  loadBundle(document).apply(ctx)
  const Body = state.bodies.get(ID)

  const layout = createLayout()
  // A record already at its own address, which is every render after the first.
  layout.state.tabs.t9 = { id: 't9', kind: KIND, contentId: `${SCHEME}t9`, title: '终端' }
  layout.state.panes.p1.tabs.push('t9')
  const before = layout.writes.length

  Body({ useTabInfo: () => ({ tab: createTabRecord(layout, 't9') }) })

  assert.equal(layout.writes.length, before, 'nothing to adopt, nothing written')
})

test('a refused adoption leaves a working terminal and says so in the log', () => {
  const document = createDocument()
  document.mode('desktop')
  const { ctx, state } = createContext()
  loadBundle(document).apply(ctx)
  const Body = state.bodies.get(ID)

  const layout = createLayout()
  pickTerminalFromGuide(layout, 't2')
  const record = createTabRecord(layout, layout.tabs().at(-1).id)
  record.actions.openResource = () => {
    throw new Error('no mounted surface')
  }

  const tree = Body({ useTabInfo: () => ({ tab: record }) })

  assert.ok(tree, 'the surface still renders: a refused step is not a broken pane')
  assert.equal(state.warnings.length, 1, 'and the refusal is recorded where it can be read')
  assert.match(state.warnings[0], /own address/)
})
