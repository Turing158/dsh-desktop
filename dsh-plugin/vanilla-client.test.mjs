/**
 * Executes the appearance client plugin's mode handling in a mock page.
 *
 * ## Why this file exists
 *
 * `ui-client/client.js` is a hand-authored browser bundle, so it cannot be
 * imported like a module — but its *body* is ordinary JavaScript, and the parts
 * that matter here need no React. This test runs `apply()` for real over a stub
 * context and DOM, which is the only way to catch the failures that reading the
 * file cannot:
 *
 *   - the startup ordering between applying the mode and the settings section,
 *     which relies on hoisting and would otherwise be verifiable only by
 *     inspection;
 *   - a section that fails to withdraw in 原版, or fails to come back;
 *   - the loading window, where an unloaded settings scope must NOT be read as
 *     `desktop` and switch the overlay back on.
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
const source = readFileSync(join(here, 'ui-client', 'client.js'), 'utf8')

/**
 * Load the client bundle with a DOM stub in scope, and expose its exports.
 *
 * The file is a `window.__ModuleLoader__.load({ id, factory })` registration, so
 * the stub records the factory and calls it with a bare `require` for React.
 * React is only needed for `createElement` at render time, which the mode tests
 * never reach — the components are never rendered. The font-size tests pass a
 * recording React of their own (see {@link recordingReact}).
 *
 * WHY THE DOCUMENT GOES IN THE SANDBOX. The bundle closes over `document` when it
 * is evaluated, so substituting it afterwards would have no effect: the factory's
 * closures would still point at whatever was in scope at evaluation time. The
 * stub is therefore installed in the vm context before the script runs.
 *
 * @param document - the DOM stub the bundle should see.
 * @param react - optional React stub replacing the inert default.
 * @param primitives - what the bundle's guarded primitives read resolves to; the
 *   default carries a `Menu` stub, which is what the real page's module table has.
 * @returns the module exports (`apply`, `inject`).
 */
function loadBundle(document, react, primitives = { Menu: function Menu() {} }) {
  let captured
  const sandbox = {
    console,
    document,
    Blob, URL, atob,
    Image: class { decode() { return Promise.resolve() } },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init?.detail
      }
    },
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.window.__ModuleLoader__ = {
    load: (entry) => {
      captured = entry
    },
  }

  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'ui-client/client.js' }).runInContext(sandbox)

  assert.ok(captured, 'the bundle must register itself with __ModuleLoader__')
  assert.equal(captured.id, '@dsh-desktop/appearance')

  return captured.factory((name) => {
    if (name === 'react') return react ?? inertReact
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${name}`)
  })
}

/**
 * A React stub whose renders produce plain element trees.
 *
 * `createElement` records the call as a node; a function-typed node is a
 * component the tree walker invokes with its props, exactly what a reconciler
 * would do. `useSyncExternalStore` reads the real store, so a rendered section
 * projects the store's actual state rather than a fixture. The selector's open
 * flag and trigger ref are stubbed inline, as every hook here is.
 */
const recordingReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial ?? null }),
  Fragment: {},
}

/** The default React stub: every render is inert, every hook null. */
const inertReact = {
  createElement: () => null,
  useSyncExternalStore: () => null,
  Fragment: {},
}

/**
 * Render the 外观 section into a plain element tree and find one node.
 *
 * A function-typed node is tested against the predicate FIRST: the app's `Menu`
 * primitive is a component the walker would otherwise expand (and lose), and the
 * selector's popup is asserted through the Menu element's props — items, the
 * selected id, the anchor — rather than through anything inside it.
 *
 * @param component - the section component the slot stub captured.
 * @param predicate - node predicate; the first match wins.
 * @returns the matched node.
 */
function renderSection(component, predicate) {
  const found = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node.type === 'function') {
      if (predicate(node)) {
        found.push(node)
        return
      }
      walk(node.type(node.props ?? {}))
      return
    }
    if (predicate(node)) found.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(component())
  assert.ok(found.length > 0, 'the rendered section must contain the sought node')
  return found[0]
}

/** Drain the microtask queue the plugin defers its font-size writes onto. */
const flushMicrotasks = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
}

/**
 * A `document` stub sufficient for the mode logic and the font-size writes.
 *
 * The body records every property the plugin writes on it, which is the one
 * observable surface an out-of-bounds font size has: the plugin applies those
 * by writing `--dsh-content-font-size` exactly where the app's own presenter
 * writes the native size.
 *
 * @returns the stub, with the attribute it carries and any events dispatched.
 */
function createDocument() {
  const attributes = new Map()
  const listeners = new Map()
  const bodyStyle = new Map()

  /** Ask for a mode, as the title bar's menu item does. */
  function requestMode(mode) {
    return stub.dispatchEvent({ type: 'dsh-desktop:set-ui-mode', detail: { mode } })
  }

  const body = {
    style: {
      setProperty: (name, value) => bodyStyle.set(name, value),
      removeProperty: (name) => bodyStyle.delete(name),
      getPropertyValue: (name) => (bodyStyle.has(name) ? bodyStyle.get(name) : ''),
    },
  }

  const stub = {
    title: 'DeepSeek Harness',
    body,
    documentElement: {
      getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
      setAttribute: (name, value) => attributes.set(name, String(value)),
      removeAttribute: (name) => attributes.delete(name),
      style: { setProperty: () => {} },
    },
    addEventListener: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    removeEventListener: () => {},
    dispatchEvent: (event) => {
      for (const fn of listeners.get(event.type) ?? []) fn(event)
      return true
    },
    requestMode,
    /** The current attribute. */
    mode: () => attributes.get('data-dsh-ui') ?? null,
    listenerCount: (name) => (listeners.get(name) ?? []).length,
    /** The body variable the app's presenter and the plugin both write. */
    bodyStyle,
  }

  return stub
}

/**
 * A stub client context.
 *
 * @param options - the settings section to resolve and its load status.
 * @returns the context plus the bookkeeping a test asserts on.
 */
function createContext(options = {}) {
  const state = {
    /** Mode writes the plugin asked the settings scope to persist. */
    writes: [],
    /** Current registered settings sections, by id. */
    sections: new Map(),
    /** Number of slot-injection callbacks run. */
    injections: 0,
    /** Effects registered, by label. */
    effects: new Map(),
    /** Events the plugin subscribed to on the context, by name. */
    handlers: new Map(),
    /** The captured 外观 section component, for rendering. */
    sectionComponent: null,
    /** Scope subscribers, invokable to model a settings commit elsewhere. */
    scopeSubscribers: [],
    /** Sizes handed to `theme.setFontSize`. */
    runtimeFontSizeWrites: [],
  }

  const status = options.status ?? 'ready'
  let section = options.section ?? { animation: 'system', ui: 'desktop' }

  /** Replace the resolved section, as a commit from another window would. */
  state.setSection = (next) => {
    section = next
    for (const subscriber of state.scopeSubscribers) subscriber()
  }

  const scope = {
    getSnapshot: () => ({ status, value: status === 'ready' ? section : undefined }),
    subscribe: (callback) => {
      state.scopeSubscribers.push(callback)
      return () => {
        const at = state.scopeSubscribers.indexOf(callback)
        if (at !== -1) state.scopeSubscribers.splice(at, 1)
      }
    },
    set: (field, value) => {
      state.writes.push([field, value])
      return options.write ? options.write(field, value) : Promise.resolve(options.writeResult)
    },
    unset: (field) => {
      state.writes.push([field, null])
      return Promise.resolve(options.writeResult)
    },
  }

  const theme = {
    getTheme: () => ({ preference: 'system', fontSize: 14 }),
    setTheme: () => {},
    setFontSize: (px) => {
      state.runtimeFontSizeWrites.push(px)
    },
  }

  const slots = {
    inject: (name, callback) => {
      assert.equal(name, 'settings.section')
      state.injections += 1
      // Run the callback the way a declared slot does, and remember its teardown.
      state.slotTeardown = callback()
    },
    register: (spec, component) => {
      assert.equal(spec.name, 'settings.section')
      // A section entry is keyed by id; re-registering the same id is what the
      // real SlotCore rejects, so the stub models that too.
      if (state.sections.has(spec.id)) {
        throw new Error(`duplicate registration for ${spec.id}`)
      }
      state.sections.set(spec.id, spec)
      state.sectionComponent = component
      return () => {
        state.sections.delete(spec.id)
        state.sectionComponent = null
      }
    },
  }

  const ctx = {
    theme,
    slots,
    ...(options.legacySettings
      ? { settingsScope: { bind: ({ namespace }) => { assert.equal(namespace, 'desktop-appearance'); return scope } } }
      : { configForms: { get: namespace => { assert.equal(namespace, 'desktop-appearance'); return scope } } }),
    inject: (services, callback) => {
      if (services.every(service => ctx[service])) return callback(ctx)
    },
    effect: (fn, label) => {
      state.effects.set(label, fn)
      return fn()
    },
    on: (name, handler) => {
      state.handlers.set(name, handler)
      return () => state.handlers.delete(name)
    },
    logger: { warn: (message) => state.warnings?.push(message) },
  }

  state.warnings = []
  return { ctx, state }
}

// ── the behaviours ───────────────────────────────────────────────────────────

test('the legacy settings service still persists appearance changes', () => {
  const document = createDocument(), { ctx, state } = createContext({ legacySettings: true })
  loadBundle(document).apply(ctx)
  document.requestMode('vanilla')
  assert.equal(document.mode(), 'vanilla')
  assert.deepEqual(state.writes, [['ui', 'vanilla']])
})

test('a configForms refusal is reported even when the write promise resolves', async () => {
  const document = createDocument(), { ctx, state } = createContext({ writeResult: false })
  loadBundle(document).apply(ctx)
  document.requestMode('vanilla')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /settings write was not accepted/)
})

test('the plugin registers a settings section and a mode attribute on load', () => {
  const document = createDocument()
  const { ctx, state } = createContext()

  const module = loadBundle(document)
  // Copied into THIS realm's array first: the bundle's own array comes from the
  // vm context, and a strict deep-equal compares prototypes, so comparing it
  // directly fails on the realm boundary rather than on the contents.
  assert.deepEqual(
    Array.from(module.inject),
    ['slots', 'theme'],
    'the plugin must declare the services it needs',
  )
  module.apply(ctx)

  assert.equal(state.injections, 1, 'the settings section slot must be injected')
  assert.deepEqual([...state.sections.keys()], ['appearance'], 'the 外观 section must be registered')
  // Desktop is the default, and it is written explicitly so the page states it.
  assert.equal(document.mode(), 'desktop', 'the mode attribute must be set on load')
})

test('a page that starts in 原版 withdraws the 外观 section', () => {
  const document = createDocument()
  // The host half already published vanilla before first paint.
  document.documentElement.setAttribute('data-dsh-ui', 'vanilla')

  const { ctx, state } = createContext({ section: { animation: 'system', ui: 'vanilla' } })
  loadBundle(document).apply(ctx)

  assert.equal(document.mode(), 'vanilla')
  assert.deepEqual(
    [...state.sections.keys()],
    [],
    'the 外观 section is this app\'s own addition and must be withdrawn in 原版',
  )
})

test('the menu request persists the mode, applies it, and announces it', () => {
  const document = createDocument()
  const events = []
  const { ctx, state } = createContext()
  loadBundle(document).apply(ctx)

  // Listen for the announcement the title bar and DOM tier both consume.
  document.addEventListener('dsh-desktop:ui-mode', (event) => events.push(event.detail.mode))

  document.requestMode('vanilla')

  assert.equal(document.mode(), 'vanilla', 'the attribute must move at once')
  assert.deepEqual(state.writes, [['ui', 'vanilla']], 'the choice must be persisted')
  assert.deepEqual(events, ['vanilla'], 'the change must be announced')
  assert.deepEqual([...state.sections.keys()], [], 'the section must go with it')

  document.requestMode('desktop')

  assert.equal(document.mode(), 'desktop')
  assert.deepEqual(state.writes, [['ui', 'vanilla'], ['ui', 'desktop']])
  assert.deepEqual(events, ['vanilla', 'desktop'])
  assert.deepEqual([...state.sections.keys()], ['appearance'], 'and must come back')
})

test('an unknown mode in the request is ignored rather than applied', () => {
  const document = createDocument()
  const { ctx, state } = createContext()
  loadBundle(document).apply(ctx)

  document.requestMode('bogus')

  assert.equal(document.mode(), 'desktop', 'the mode must not move')
  assert.deepEqual(state.writes, [], 'and nothing may be persisted')
})

test('an unloaded settings scope does NOT switch the overlay back on', () => {
  const document = createDocument()
  // The page is in 原版, published by the host half before first paint, while the
  // settings mirror is still loading. Reading "no value" as desktop here would
  // flash the whole overlay back on.
  document.documentElement.setAttribute('data-dsh-ui', 'vanilla')

  const { ctx, state } = createContext({ status: 'loading' })
  loadBundle(document).apply(ctx)

  assert.equal(
    document.mode(),
    'vanilla',
    'the host-published mode must survive an unloaded scope',
  )
  assert.deepEqual(
    [...state.sections.keys()],
    [],
    'and the section must stay withdrawn',
  )
})

test('the plugin installs exactly one request listener', () => {
  const document = createDocument()
  const { ctx } = createContext()
  loadBundle(document).apply(ctx)

  assert.equal(
    document.listenerCount('dsh-desktop:set-ui-mode'),
    1,
    'a second live listener would apply every request twice',
  )
})

// ── the font size (10..18, the theme runtime's 12..17 inside it) ──────────────

/**
 * Find the selector's `Menu` in a rendered section.
 *
 * @param component - the section component the slot stub captured.
 * @returns the Menu element with its props.
 */
function renderSelectorMenu(component) {
  return renderSection(component, (node) => typeof node.type === 'function' && node.type.name === 'Menu')
}

test('the selector\'s menu offers every size and routes 12..17 to the theme runtime', async () => {
  const document = createDocument()
  const { ctx, state } = createContext()
  loadBundle(document, recordingReact).apply(ctx)

  const menu = renderSelectorMenu(state.sectionComponent)
  // The whole 10..18 range, one item per px, no gaps — a stepper would hide
  // the ends this plugin owns, which is why the menu lists them all. The arrays
  // are copied into THIS realm first: the items come from the vm context, and a
  // strict deep-equal compares prototypes, so comparing one of its arrays
  // directly fails on the realm boundary rather than on the contents.
  assert.deepEqual(
    Array.from(menu.props.items, (item) => item.id),
    ['10', '11', '12', '13', '14', '15', '16', '17', '18'],
  )
  assert.deepEqual(
    Array.from(menu.props.items, (item) => item.label),
    ['10px', '11px', '12px', '13px', '14px', '15px', '16px', '17px', '18px'],
  )
  assert.equal(menu.props.selectedId, '14', 'the displayed size is the runtime snapshot until an override is chosen')
  // The app's own selector shape: portalled, hanging from the pill's left edge,
  // the pill itself carried as the anchor.
  assert.equal(menu.props.portal, true, 'portalled, so it is the same surface every other dropdown is')
  assert.equal(menu.props.align, 'start', 'the pill sits at the row\'s left, so the panel drops from that edge')
  assert.equal(menu.props.anchor.props.className, 'dshAppearance__selector', 'the pill is the Menu\'s anchor')
  // The recording React keeps children at the element's top level rather than in
  // props, and the array is minted inside the vm — copied out before comparing.
  assert.deepEqual(
    Array.from(menu.props.anchor.children ?? []),
    ['14px'],
    'the pill reads the current size',
  )

  // An in-range choice is the native path: the runtime persists it in ui-theme
  // and its presenter applies it. This plugin must neither write the variable
  // nor store a second copy of the value.
  menu.props.onSelect('16')
  await flushMicrotasks()
  assert.deepEqual(state.runtimeFontSizeWrites, [16], 'an in-range size goes to theme.setFontSize')
  assert.deepEqual(state.writes, [], 'and is not persisted in the overlay namespace')
  assert.equal(document.bodyStyle.get('--dsh-content-font-size'), undefined, 'and the plugin writes no variable for it')
})

test('an out-of-range size is applied by the plugin and persisted as an override', async () => {
  const document = createDocument()
  const { ctx, state } = createContext()
  loadBundle(document, recordingReact).apply(ctx)

  const menu = renderSelectorMenu(state.sectionComponent)
  // 18 is beyond the runtime's ceiling — theme.setFontSize would THROW — so the
  // plugin applies the variable itself and stores the choice in its namespace.
  menu.props.onSelect('18')
  await flushMicrotasks()
  assert.equal(document.bodyStyle.get('--dsh-content-font-size'), '18px', 'the plugin writes the variable the presenter would')
  assert.deepEqual(state.writes, [['fontSizeOverride', 18]], 'and persists the override for the next launch')
  assert.deepEqual(state.runtimeFontSizeWrites, [], 'and never hands an out-of-range size to the throwing runtime')

  // Returning to an in-range size must clear the override BEFORE the runtime
  // call: the publish inside it runs the plugin's theme/change handler, which
  // would otherwise re-assert the override it still saw in the store.
  menu.props.onSelect('14')
  await flushMicrotasks()
  assert.deepEqual(state.writes, [['fontSizeOverride', 18], ['fontSizeOverride', null]], 'the override is removed from the document')
  assert.deepEqual(state.runtimeFontSizeWrites, [14])
})

test('without the primitives module the selector degrades to the native select', () => {
  const document = createDocument()
  const { ctx, state } = createContext()
  // The guarded read warns and carries on: the section must still come up, with
  // a control that works rather than a plugin that failed to load.
  loadBundle(document, recordingReact, null).apply(ctx)

  const select = renderSection(state.sectionComponent, (node) => node.type === 'select')
  assert.deepEqual(
    select.children.flat().map((option) => option.props.value),
    ['10', '11', '12', '13', '14', '15', '16', '17', '18'],
  )
  assert.equal(select.props.value, '14')
})

test('a theme event never erases an active override', async () => {
  const document = createDocument()
  const { ctx, state } = createContext({
    section: { animation: 'system', ui: 'desktop', fontSizeOverride: 10 },
  })
  loadBundle(document).apply(ctx)
  await flushMicrotasks()
  assert.equal(document.bodyStyle.get('--dsh-content-font-size'), '10px', 'the persisted override is applied at startup')

  // What the app does on every theme change: the presenter rewrites the
  // variable from the snapshot — the runtime still holds 14, it knows nothing
  // of the override — and the plugin's handler runs somewhere in that emit.
  document.body.style.setProperty('--dsh-content-font-size', '14px')
  state.handlers.get('theme/change')({ preference: 'dark', fontSize: 14 })
  await flushMicrotasks()
  assert.equal(
    document.bodyStyle.get('--dsh-content-font-size'),
    '10px',
    'the override must land after the presenter’s write, whoever subscribed first',
  )
})

test('a settings commit from another window converges the font size', async () => {
  const document = createDocument()
  const { ctx, state } = createContext()
  loadBundle(document).apply(ctx)
  await flushMicrotasks()
  assert.equal(document.bodyStyle.get('--dsh-content-font-size'), undefined, 'no override, no plugin write')

  // Another window chose 10: the document now carries the override, and the
  // mirror delivers it to every subscriber.
  state.setSection({ animation: 'system', ui: 'desktop', fontSizeOverride: 10 })
  await flushMicrotasks()
  assert.equal(document.bodyStyle.get('--dsh-content-font-size'), '10px')

  // And then chose 15 in the native range: the override is gone from the
  // document, and nothing else rewrites the variable — the theme runtime only
  // publishes on its own changes — so the plugin hands the variable back.
  state.setSection({ animation: 'system', ui: 'desktop' })
  await flushMicrotasks()
  assert.equal(document.bodyStyle.get('--dsh-content-font-size'), '14px', 'withdrawn to the runtime’s own size')
})

test('原版 withdraws the override, and desktop re-asserts it', async () => {
  const document = createDocument()
  const { ctx, state } = createContext({
    section: { animation: 'system', ui: 'desktop', fontSizeOverride: 10 },
  })
  loadBundle(document).apply(ctx)
  await flushMicrotasks()
  assert.equal(document.bodyStyle.get('--dsh-content-font-size'), '10px')

  document.requestMode('vanilla')
  await flushMicrotasks()
  assert.equal(
    document.bodyStyle.get('--dsh-content-font-size'),
    '14px',
    'the frontend must show only its own size in 原版 — the plugin’s value is a modification',
  )

  document.requestMode('desktop')
  await flushMicrotasks()
  assert.equal(document.bodyStyle.get('--dsh-content-font-size'), '10px', 'and the override comes back with the overlay')
})


test('a refused reasoning control preference restores the saved style and reports failure', async () => {
  const document = createDocument()
  const { ctx, state } = createContext({ writeResult: false, section: { reasoningControl: 'select' } })
  loadBundle(document, recordingReact).apply(ctx)
  const row = () => renderSection(state.sectionComponent, n => n.props?.title === '推理等级控件')
  const pending = row().props.onChange('slider')
  assert.equal(row().props.value, 'slider')
  await pending
  assert.deepEqual(state.writes, [['reasoningControl', 'slider']])
  assert.equal(row().props.value, 'select')
  assert.ok(renderSection(state.sectionComponent, n => n.props?.role === 'alert'))
})

test('rapid reasoning style changes keep the last choice while saves settle', async () => {
  const document = createDocument(), commits = []
  const { ctx, state } = createContext({ write: (field, value) => new Promise(resolve => {
    commits.push(() => { state.setSection({ [field]: value }); resolve(true) })
  }) })
  loadBundle(document, recordingReact).apply(ctx)
  const row = () => renderSection(state.sectionComponent, n => n.props?.title === '推理等级控件')
  const first = row().props.onChange('slider'), last = row().props.onChange('select')
  await flushMicrotasks()
  assert.equal(commits.length, 1)
  commits.shift()(); await first
  assert.equal(row().props.value, 'select')
  await flushMicrotasks()
  commits.shift()(); await last
  assert.deepEqual(state.writes, [['reasoningControl', 'slider'], ['reasoningControl', 'select']])
  state.setSection({ reasoningControl: 'slider' })
  assert.equal(row().props.value, 'slider')
})

test('a refused composer material write restores the saved choice and exposes an error', async () => {
  const document = createDocument()
  const { ctx, state } = createContext({ writeResult: false, section: { composerMaterial: 'frosted' } })
  loadBundle(document, recordingReact).apply(ctx)
  const row = renderSection(state.sectionComponent, n => n.props?.title === '输入框材质')
  const pending = row.props.onChange('transparent')
  assert.equal(document.documentElement.getAttribute('data-dsh-composer-material'), 'transparent')
  await pending
  assert.deepEqual(state.writes, [['composerMaterial', 'transparent']])
  assert.equal(document.documentElement.getAttribute('data-dsh-composer-material'), 'frosted')
  assert.equal(renderSection(state.sectionComponent, n => n.props?.title === '输入框材质').props.value, 'frosted')
  assert.ok(renderSection(state.sectionComponent, n => n.props?.role === 'alert'))
})

test('rapid material choices keep the latest preview while earlier writes settle', async () => {
  const document = createDocument()
  const commits = []
  const { ctx, state } = createContext({ write: (field, value) => new Promise(resolve => {
    commits.push(() => { state.setSection({ [field]: value }); resolve(true) })
  }) })
  loadBundle(document, recordingReact).apply(ctx)
  const row = renderSection(state.sectionComponent, n => n.props?.title === '输入框材质')
  const first = row.props.onChange('glass')
  const last = row.props.onChange('transparent')
  await flushMicrotasks()
  assert.equal(commits.length, 1, 'writes must be serialized')
  commits.shift()()
  await first
  assert.equal(document.documentElement.getAttribute('data-dsh-composer-material'), 'transparent')
  await flushMicrotasks()
  commits.shift()()
  await last
  assert.deepEqual(state.writes, [['composerMaterial', 'glass'], ['composerMaterial', 'transparent']])
  state.setSection({ composerMaterial: 'frosted' })
  assert.equal(document.documentElement.getAttribute('data-dsh-composer-material'), 'frosted')
})

test('composer sliders preview immediately and preserve independent values when switching materials', async () => {
  const document = createDocument()
  let saved = { composerMaterial: 'transparent' }
  const { ctx, state } = createContext({ section: saved, write: async (field, value) => {
    saved = { ...saved, [field]: value }
    state.setSection(saved)
    return true
  } })
  loadBundle(document, recordingReact).apply(ctx)
  const material = () => renderSection(state.sectionComponent, n => n.props?.title === '输入框材质')
  const slider = () => renderSection(state.sectionComponent, n => n.type === 'input' && n.props.type === 'range' && n.props['aria-valuetext'])
  for (const [choice, label, field, value, variable, cssValue] of [
    ['transparent', '输入框透明度', 'composerTransparency', 35, '--dsh-composer-transparent-tint', '65%'],
    ['frosted', '纯磨砂效果程度', 'composerFrostedIntensity', 70, '--dsh-composer-frosted-strength', '0.7'],
    ['glass', '毛玻璃效果程度', 'composerGlassIntensity', 25, '--dsh-composer-glass-strength', '0.25'],
  ]) {
    await material().props.onChange(choice)
    const control = slider()
    assert.equal(control.props['aria-label'], label)
    const event = { target: { value: String(value) } }
    control.props.onChange(event)
    assert.equal(document.bodyStyle.get(variable), cssValue, 'drag updates the surface immediately')
    assert.equal(saved[field], undefined, 'drag preview does not write until committed')
    await control.props.onPointerUp(event)
    await control.props.onBlur(event)
    assert.equal(saved[field], value)
    assert.equal(state.writes.filter(([key]) => key === field).length, 1, 'blur after pointer-up does not duplicate the write')
  }
  for (const [choice, value] of [['transparent', 35], ['frosted', 70], ['glass', 25]]) {
    await material().props.onChange(choice)
    assert.equal(slider().props.value, value, 'switching back restores this material’s setting')
  }
})

test('an earlier slider save and unrelated settings updates cannot reset an active drag', async () => {
  const document = createDocument()
  let saved = { composerMaterial: 'glass', composerGlassIntensity: 50 }
  const commits = []
  const { ctx, state } = createContext({ section: saved, write: (field, value) => new Promise(resolve => {
    commits.push(() => { saved = { ...saved, [field]: value }; state.setSection(saved); resolve(true) })
  }) })
  loadBundle(document, recordingReact).apply(ctx)
  const slider = () => renderSection(state.sectionComponent, n => n.props?.['aria-label'] === '毛玻璃效果程度')
  const event = value => ({ target: { value: String(value) } })
  const first = slider().props.onKeyUp(event(60))
  await flushMicrotasks()
  slider().props.onChange(event(85))
  state.setSection({ ...saved, backgroundTransparency: 20 })
  commits.shift()()
  await first
  assert.equal(slider().props.value, 85)
  assert.equal(document.bodyStyle.get('--dsh-composer-glass-strength'), '0.85')
  const last = slider().props.onBlur(event(85))
  await flushMicrotasks()
  commits.shift()()
  await last
  assert.equal(saved.composerGlassIntensity, 85)
  assert.equal(slider().props.value, 85)
})

test('a refused material intensity write restores its saved value and reports failure', async () => {
  const document = createDocument()
  const { ctx, state } = createContext({ writeResult: false, section: { composerMaterial: 'frosted', composerFrostedIntensity: 40 } })
  loadBundle(document, recordingReact).apply(ctx)
  const slider = () => renderSection(state.sectionComponent, n => n.props?.['aria-label'] === '纯磨砂效果程度')
  const pending = slider().props.onPointerUp({ target: { value: '80' } })
  assert.equal(document.bodyStyle.get('--dsh-composer-frosted-strength'), '0.8')
  await pending
  assert.equal(slider().props.value, 40)
  assert.equal(document.bodyStyle.get('--dsh-composer-frosted-strength'), '0.4')
  assert.ok(renderSection(state.sectionComponent, n => n.props?.role === 'alert'))
})

test('a refused background write restores the saved surface and exposes an error', async () => {
  const document = createDocument()
  const { ctx, state } = createContext({ writeResult: false, section: { backgroundImage: 'data:image/png;base64,aGVsbG8=', backgroundChat: true } })
  loadBundle(document, recordingReact).apply(ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(document.documentElement.getAttribute('data-dsh-background-chat'), '')
  const row = renderSection(state.sectionComponent, n => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked === true)
  await row.props.onChange({ target: { checked: false } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(document.documentElement.getAttribute('data-dsh-background-chat'), '')
  assert.ok(renderSection(state.sectionComponent, n => n.props?.role === 'alert'))
})


test('large persisted backgrounds use short URLs and removal cancels pending decoding', async () => {
  const document = createDocument()
  const large = 'data:image/png;base64,' + 'A'.repeat(1600000)
  const { ctx, state } = createContext({ section: { backgroundImage: large, backgroundChat: true, backgroundChatTransparency: 0 } })
  loadBundle(document, recordingReact).apply(ctx)
  await new Promise(resolve => setImmediate(resolve))
  const css = document.bodyStyle.get('--dsh-background-image')
  assert.match(css, /^url\("blob:/)
  assert.ok(css.length < 200)
  assert.equal(document.bodyStyle.get('--dsh-background-chat-opacity'), '0', 'legacy image opacity converts to transparent surface')
  state.setSection({ backgroundImage: '' })
  assert.equal(document.bodyStyle.get('--dsh-background-image'), 'none')
  assert.equal(document.documentElement.getAttribute('data-dsh-background-chat'), null)
  state.setSection({ backgroundImage: large })
  state.setSection({ backgroundImage: '' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(document.bodyStyle.get('--dsh-background-image'), 'none', 'late decoder must not restore a removed image')
})
