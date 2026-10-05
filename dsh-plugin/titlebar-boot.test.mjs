/**
 * Executes the injected boot title bar (`title-bar/boot.js`) in a simulated page.
 *
 * ## What is actually at risk
 *
 * The bar that exists before DSH does is the one piece of this app that runs with
 * **no** framework, no module system, and no help: it is a document-created script
 * injected by the Rust host, so a mistake in it is a blank strip or a thrown
 * exception on every page. Nothing else in the project can catch that, because
 * nothing else runs in that world.
 *
 * Three failures are worth this file on their own:
 *
 *   1. **The window cannot be closed.** `decorations(false)` removed the OS
 *      controls; the bar is the only way to minimize or close the window on a
 *      boot page. If its buttons are wired to the wrong command names, or never
 *      revealed, the app becomes an unclosable window on exactly the screens a
 *      user reaches when something has gone wrong.
 *   2. **Two bars at once.** The boot bar and the real one occupy the same strip.
 *      If the handoff name drifts, both stay visible forever.
 *   3. **A second bar from a second evaluation.** WebView2 may run an
 *      `AddScriptToExecuteOnDocumentCreated` script more than once per document,
 *      which would stack two sets of window controls.
 *
 * The DOM stub is deliberately minimal — only the methods `boot.js` actually
 * calls — so a new call site fails here rather than passing against an
 * over-built fake.
 *
 * Run with: `node --test dsh-plugin/`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { apply as applyTitleBarHost } from './title-bar/index.js'

test('the title-bar host publishes functional chrome without the optional UI overlay', () => {
  let render
  applyTitleBarHost({ on(event, listener) { assert.equal(event, 'webserver/index-inject'); render = listener } })
  const table = []
  render(table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'style')
  assert.equal(table[0].placement, 'head')
  assert.match(table[0].text, /\.dshTb\s*\{[\s\S]*?position: fixed/)
  assert.match(table[0].text, /\.dshTb__controls\s*\{/)
  assert.match(table[0].text, /html body #root\s*\{/)
  assert.ok(table[0].text.includes("[data-shortcut-modal='settings']"))
  assert.doesNotMatch(table[0].text, /\.dshChanges\s*\{|\.dshPlugins__restart|dsh-inventory-expand/)
})

const here = dirname(fileURLToPath(import.meta.url))
const BOOT = join(here, 'title-bar', 'boot.js')
const CLIENT = join(here, 'title-bar', 'client.js')
const OVERLAY = join(here, 'ui-overlay', 'dom.js')
const bootSource = readFileSync(BOOT, 'utf8')

/** The host element's id, mirroring the constant in `boot.js`. */
const HOST_ID = 'dsh-desktop-titlebar-boot'

/** The event the real bar announces itself with. */
const READY_EVENT = 'dsh-desktop:titlebar-ready'

/** The durable marker the real bar sets. */
const READY_ATTRIBUTE = 'data-dsh-titlebar'

// ── the DOM stub ─────────────────────────────────────────────────────────────

/**
 * A CSSStyleDeclaration-shaped store.
 *
 * `boot.js` writes the bar's height as a custom property on `<html>` and the
 * popup's coordinates as plain properties, so both forms have to be recorded —
 * and `padding`/`background` are read back nowhere, which is why only these two
 * accessors exist.
 *
 * @returns the store.
 */
function createStyle() {
  const properties = new Map()
  return {
    setProperty: (name, value) => properties.set(name, String(value)),
    getPropertyValue: (name) => properties.get(name) ?? '',
    get properties() {
      return properties
    },
  }
}

/** A DOM element stub with the surface `boot.js` needs. */
class FakeElement {
  constructor(tagName, namespace = 'http://www.w3.org/1999/xhtml') {
    this.tagName = tagName.toUpperCase()
    this.namespaceURI = namespace
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.textContent = ''
    this.listeners = new Map()
    /** Class names, so `querySelectorAll('.x')` can find the buttons. */
    this.className = ''
    /** The inline-style surface `boot.js` writes to. */
    this.style = createStyle()
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    if (name === 'class') this.className = String(value)
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    for (const node of nodes) this.appendChild(node)
  }

  addEventListener(type, fn, capture = false) {
    const key = capture ? type + ':capture' : type
    if (!this.listeners.has(key)) this.listeners.set(key, [])
    this.listeners.get(key).push(fn)
  }

  removeEventListener(type, fn, capture = false) {
    const key = capture ? type + ':capture' : type
    const list = this.listeners.get(key)
    if (!list) return
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }

  /** Dispatch to this element's own listeners; returns how many ran. */
  dispatch(type, event = {}) {
    const list = this.listeners.get(type) ?? []
    for (const fn of list) fn({ type, target: this, ...event })
    return list.length
  }

  /** Whether a listener of this type is installed. */
  listens(type, capture = false) {
    return (this.listeners.get(capture ? type + ':capture' : type) ?? []).length
  }

  contains(other) {
    let node = other
    while (node) {
      if (node === this) return true
      node = node.parentNode
    }
    return false
  }

  closest(selector) {
    let node = this
    while (node) {
      if (matches(node, selector)) return node
      node = node.parentNode
    }
    return null
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector) {
    return flatten(this).filter((node) => matches(node, selector))
  }

  getBoundingClientRect() {
    return { left: 100, top: 0, right: 160, bottom: 44, width: 60, height: 44 }
  }
}

/** Depth-first collection of an element's descendants. */
function flatten(node, out = []) {
  for (const child of node.children) {
    out.push(child)
    flatten(child, out)
  }
  return out
}

/**
 * Match the few selector forms `boot.js` and these tests use.
 *
 * Only what is needed: a bare class, a bare tag, `#id`, and `[attr]`/`[attr="value"]`.
 * Anything else returns false, which is the safe direction — the stub then finds
 * nothing rather than everything, so an assertion about a missing element cannot
 * pass by accident.
 */
function matches(node, selector) {
  if (selector.startsWith('#')) return node.getAttribute('id') === selector.slice(1)
  if (selector.startsWith('.')) return String(node.className).split(/\s+/).includes(selector.slice(1))
  const attrValue = /^\[([\w-]+)=["']([^"']*)["']\]$/.exec(selector)
  if (attrValue) return node.getAttribute(attrValue[1]) === attrValue[2]
  const attrName = /^\[([\w-]+)\]$/.exec(selector)
  if (attrName) return node.hasAttribute(attrName[1])
  if (/^[a-z]+$/i.test(selector)) return node.tagName === selector.toUpperCase()
  return false
}

/**
 * A `document` stub.
 *
 * @param options - `withHost` installs a Tauri bridge; `url` sets the location.
 * @returns the document stub plus the bookkeeping a test asserts on.
 */
function createDocument(options = {}) {
  const documentElement = new FakeElement('html')
  const head = new FakeElement('head')
  const body = new FakeElement('body')
  documentElement.appendChild(head)
  documentElement.appendChild(body)

  const documentListeners = new Map()
  let title = 'DeepSeek Harness'

  const document = {
    documentElement,
    head,
    body,
    get title() {
      return title
    },
    set title(value) {
      title = value
    },
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (namespace, tag) => new FakeElement(tag, namespace),
    getElementById: (id) => flatten(documentElement).find((node) => node.getAttribute('id') === id) ?? null,
    querySelector: (selector) => document.querySelectorAll(selector)[0] ?? null,
    querySelectorAll: (selector) => flatten(documentElement).filter((node) => matches(node, selector)),
    addEventListener: (type, fn, capture = false) => {
      const key = capture ? type + ':capture' : type
      if (!documentListeners.has(key)) documentListeners.set(key, [])
      documentListeners.get(key).push(fn)
    },
    removeEventListener: (type, fn, capture = false) => {
      const key = capture ? type + ':capture' : type
      const list = documentListeners.get(key)
      if (!list) return
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    dispatchEvent: (event) => {
      // Both phases, as a real dispatch would: the popup's dismiss listener is a
      // capture one, so a stub that only ran the bubble phase would report the
      // menu as permanently open.
      for (const key of [event.type + ':capture', event.type]) {
        for (const fn of [...(documentListeners.get(key) ?? [])]) fn(event)
      }
      return true
    },
    listenerCount: (type, capture = false) =>
      (documentListeners.get(capture ? type + ':capture' : type) ?? []).length,
  }

  return { document, documentElement, head, body, options }
}

/**
 * Build the sandbox `boot.js` runs in.
 *
 * @param document - the document stub.
 * @param options - `withHost` installs a Tauri bridge; `location` overrides the URL.
 * @returns the sandbox, with a record of the commands invoked.
 */
function createSandbox(document, options = {}) {
  const invoked = []

  const sandbox = {
    document,
    console,
    // Timers are recorded rather than run, so a test drives the host-detection
    // ladder explicitly with `drainTimers` instead of racing a clock.
    setTimeout: (fn) => {
      sandbox.__timers.push(fn)
      return sandbox.__timers.length
    },
    clearTimeout: () => {},
    location: options.location ?? {
      protocol: 'tauri:',
      hostname: '',
      href: 'tauri://localhost/index.html',
    },
    __timers: [],
    __invoked: invoked,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init?.detail
      }
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  }

  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  // By default the document IS the top-level one, which is the app's real case.
  // A frame test overrides this with a different object.
  if (options.top === undefined) sandbox.top = sandbox
  else sandbox.top = options.top

  if (options.withHost !== false) {
    sandbox.__TAURI__ = {
      core: {
        invoke: (command, args) => {
          invoked.push({ command, args })
          return Promise.resolve(command === 'window_is_maximized' ? false : undefined)
        },
      },
      // `withApp` installs the app namespace the about dialog reads its version
      // from. Absent by default, which is the "no version available" case the
      // dialog must degrade from.
      ...(options.withApp
        ? { app: { getVersion: () => Promise.resolve(options.withApp) } }
        : {}),
    }
  }

  return sandbox
}

/**
 * Evaluate `boot.js` against a document.
 *
 * @param document - the document stub.
 * @param options - passed through to {@link createSandbox}.
 * @returns the sandbox.
 */
function runBoot(document, options = {}) {
  const sandbox = createSandbox(document, options)
  vm.createContext(sandbox)
  new vm.Script(bootSource, { filename: 'title-bar/boot.js' }).runInContext(sandbox)
  return sandbox
}

/**
 * Let the pending promise chains settle.
 *
 * More ticks than the shortest path needs, on purpose: `invokeHost` normalises a
 * command result through `Promise.resolve().then(...)` so a rejection can never
 * escape, and that adds a tick of its own before a caller's `.then` runs. A stub
 * that resolved in one tick would leave `settle` looking sufficient while the
 * assertion ran early.
 */
async function settle() {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
}

/**
 * Run every pending timer, then let the promise chains they start settle.
 *
 * The ladder is bounded, so this terminates: each round consumes the timers the
 * previous one scheduled, and a round that schedules none ends the loop. It is
 * capped anyway, so a regression that makes the ladder unbounded fails this test
 * rather than hanging the suite.
 *
 * @param sandbox - the sandbox whose timers to drain.
 */
async function drainTimers(sandbox) {
  for (let round = 0; round < 20; round += 1) {
    const pending = sandbox.__timers.splice(0)
    if (pending.length === 0) return
    for (const fn of pending) fn()
    await settle()
  }
  throw new Error('the timer ladder never settled: it appears to be unbounded')
}

/** The mounted bar, or null. */
const barOf = (document) => document.getElementById(HOST_ID)

/** The window-control buttons of a mounted bar. */
const controlsOf = (document) => barOf(document).querySelectorAll('.dshBoot__control')

/** The 更多 trigger of a mounted bar. */
const moreOf = (document) => barOf(document).querySelector('.dshBoot__item')

// ── the bar is always there ──────────────────────────────────────────────────

test('the bar mounts immediately, with the 更多 menu as its only option', () => {
  const { document } = createDocument()
  runBoot(document)

  const bar = barOf(document)
  assert.ok(bar, 'the bar must be in the document as soon as the script runs')

  // The boot bar offers exactly one menu. 编辑 / 会话 / 项目 all act on DSH
  // services that do not exist yet, so offering them would mean offering dead
  // entries — the reduced menu is the contract, not a placeholder.
  const menus = bar.querySelectorAll('.dshBoot__item')
  assert.equal(menus.length, 1, 'exactly one menu trigger may exist')
  assert.equal(menus[0].textContent, '更多')
  assert.equal(menus[0].getAttribute('aria-haspopup'), 'menu')

  // And the brand is present, so it reads as the app's own bar rather than as a
  // system strip.
  assert.ok(bar.querySelector('.dshBoot__brand'), 'the brand lockup must be present')
  assert.ok(bar.querySelector('.dshBoot__logo'), 'the mark must be present')
})

test('the bar publishes its height for the page to reserve', () => {
  const { document, documentElement } = createDocument()
  runBoot(document)

  // The boot page reserves this with `padding-top: calc(... )` in its own
  // stylesheet. It has to be published by the bar, because the bar is the only
  // side that knows the number.
  assert.equal(
    documentElement.style.getPropertyValue('--dsh-desktop-titlebar-height'),
    '44px',
    'the height must be published as a custom property on <html>',
  )
})

test('the 更多 menu offers 关于 and nothing else', () => {
  const { document, body } = createDocument()
  runBoot(document)

  assert.equal(body.querySelector('.dshBoot__menu'), null, 'the popup starts closed')

  const trigger = moreOf(document)
  trigger.dispatch('click', { button: 0 })

  const menu = body.querySelector('.dshBoot__menu')
  assert.ok(menu, 'the popup must open into <body>, not inside the bar')

  // Four of the app's menus are absent here: 编辑 / 会话 / 项目 all act on DSH
  // services that do not exist yet, so offering them would mean offering dead
  // entries — the reduced menu is the contract, not a placeholder.
  const items = menu.querySelectorAll('[role="menuitem"]')
  assert.equal(items.length, 1, '关于 is the only entry before DSH exists')
  assert.equal(items[0].textContent, '关于')
  assert.equal(
    items[0].getAttribute('aria-disabled'),
    null,
    '关于 must be offered enabled — it opens this bar’s own about dialog, the same ' +
      'content the real bar’s dialog shows. See the dialog assertions below and the ' +
      'client assertions at the bottom of this file.',
  )

  assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'the trigger must report the state')

  // Toggling closes it, like every other menu in the app.
  trigger.dispatch('click', { button: 0 })
  assert.equal(body.querySelector('.dshBoot__menu'), null, 'a second click must close the popup')
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
})

test('a click elsewhere, or Escape, dismisses the popup', () => {
  const { document, body } = createDocument()
  runBoot(document)

  const trigger = moreOf(document)

  trigger.dispatch('click', { button: 0 })
  assert.ok(body.querySelector('.dshBoot__menu'), 'the popup must be open to be dismissed')
  document.dispatchEvent({ type: 'mousedown', target: body })
  assert.equal(body.querySelector('.dshBoot__menu'), null, 'an outside click must close the popup')

  trigger.dispatch('click', { button: 0 })
  document.dispatchEvent({ type: 'keydown', key: 'Escape' })
  assert.equal(body.querySelector('.dshBoot__menu'), null, 'Escape must close the popup')

  // A click INSIDE the popup must not close it, or the item could never be used
  // once it becomes active.
  trigger.dispatch('click', { button: 0 })
  const menu = body.querySelector('.dshBoot__menu')
  document.dispatchEvent({ type: 'mousedown', target: menu.querySelector('[role="menuitem"]') })
  assert.ok(body.querySelector('.dshBoot__menu'), 'a click inside the popup must leave it open')
})

// ── the 关于 dialog ───────────────────────────────────────────────────────────

/**
 * Open the boot bar's 更多 menu and choose 关于.
 *
 * The menu is a click toggle and the item a click target, so the whole path is
 * two dispatched clicks — no pointer bookkeeping needed. The item is found
 * WITHIN the popup because the stub's selector engine has no descendant
 * combinator; the two-step query is the shape every other test here uses.
 */
function openAbout(document, body) {
  moreOf(document).dispatch('click', { button: 0 })
  const menu = body.querySelector('.dshBoot__menu')
  menu.querySelector('[role="menuitem"]').dispatch('click', { button: 0 })
}

test('关于 opens the about dialog, as a real dialog', () => {
  const { document, body } = createDocument()
  runBoot(document)

  openAbout(document, body)

  // Choosing the item hands the screen over from the popup to the panel.
  assert.equal(body.querySelector('.dshBoot__menu'), null, 'choosing the item closes the popup')
  const overlay = body.querySelector('.dshBoot__overlay')
  assert.ok(overlay, 'the dialog must open into <body>, like every app dialog')

  const dialog = overlay.querySelector('[role="dialog"]')
  assert.ok(dialog, 'the panel must be a dialog element, not a decorated div')
  assert.equal(dialog.getAttribute('aria-modal'), 'true', 'a modal mask must say so')
  assert.equal(dialog.getAttribute('aria-label'), '关于')

  // The same facts the real bar's dialog shows: the whale, the name, the
  // sentence — this bar owns no brand assets of its own and must not invent any.
  assert.ok(overlay.querySelector('.dshBoot__aboutMark').querySelector('svg'), 'the mark must be the bar’s own whale')
  assert.equal(
    overlay.querySelector('.dshBoot__aboutName').textContent,
    'DeepseekHarness',
  )
  assert.match(
    overlay.querySelector('.dshBoot__aboutText').textContent,
    /DeepSeek Harness/,
    'the dialog must say what the app is',
  )

  // The stub installs no app namespace, so no version arrives. The row is then
  // OMITTED, never placeholdered: a dialog about the build must not claim a
  // build it cannot name.
  assert.equal(overlay.querySelector('.dshBoot__aboutVersion'), null)
})

test('the about dialog shows the version when the shell answers', async () => {
  const { document, body } = createDocument()
  runBoot(document, { withApp: '9.9.9' })

  openAbout(document, body)
  await settle()

  const overlay = body.querySelector('.dshBoot__overlay')
  const version = overlay.querySelector('.dshBoot__aboutVersion')
  assert.ok(version, 'the version row must appear once the shell answers')
  assert.equal(version.textContent, '版本 9.9.9')
})

test('the about dialog closes from the button, the mask, and Escape', () => {
  const { document, body } = createDocument()
  runBoot(document)

  openAbout(document, body)
  body.querySelector('.dshBoot__aboutClose').dispatch('click', { button: 0 })
  assert.equal(body.querySelector('.dshBoot__overlay'), null, '关闭 must remove the dialog')

  openAbout(document, body)
  body.querySelector('.dshBoot__overlay').dispatch('mousedown', { button: 0 })
  assert.equal(body.querySelector('.dshBoot__overlay'), null, 'a click on the mask must dismiss it')

  // A click INSIDE the card is the dialog's own business — selecting nothing,
  // but never dismissing the panel out from under the user.
  openAbout(document, body)
  const overlay = body.querySelector('.dshBoot__overlay')
  overlay.querySelector('.dshBoot__about').dispatch('mousedown', { button: 0 })
  assert.ok(body.querySelector('.dshBoot__overlay'), 'a click inside the card must keep it open')

  document.dispatchEvent({ type: 'keydown', key: 'Escape' })
  assert.equal(body.querySelector('.dshBoot__overlay'), null, 'Escape must dismiss the dialog')

  // And reopening after any close must work: the state, not the element, is
  // what was reset.
  openAbout(document, body)
  assert.ok(body.querySelector('.dshBoot__overlay'), 'the dialog must reopen after a close')
})

test('the handoff retires an open about dialog with the bar', () => {
  const { document, body } = createDocument()
  runBoot(document)

  openAbout(document, body)
  assert.ok(body.querySelector('.dshBoot__overlay'), 'the dialog must be open to be retired')

  // The real bar takes over; the boot bar's teardown must take its dialog down
  // with it, or the mask stays stranded over the real bar's page.
  document.dispatchEvent({ type: READY_EVENT })
  assert.equal(body.querySelector('.dshBoot__overlay'), null, 'the dialog must not outlive the bar')
  assert.equal(body.querySelector('.dshBoot__menu'), null)
})

test('the two about dialogs say the same thing about the app', () => {
  const client = readFileSync(CLIENT, 'utf8')

  // The sentence is the one fact the two dialogs share, across two worlds that
  // cannot import from each other. A drift here means the boot bar and the real
  // bar describe two different apps.
  const sentence = /'([^']*桌面外壳[^']*)'/.exec(client)?.[1]
  assert.ok(sentence, 'the real bar’s dialog must carry the about sentence')
  assert.ok(
    bootSource.includes("'" + sentence + "'"),
    'the boot dialog must quote the same sentence byte-for-byte',
  )
})

// ── the window controls, which are the only way out of a boot page ───────────

test('the window controls call the real host commands', async () => {
  const { document } = createDocument()
  const sandbox = runBoot(document)
  await settle()

  const controls = controlsOf(document)
  assert.equal(controls.length, 3, 'minimize, maximize and close must all be present')

  // The bar starts hidden and reveals itself once a bridge is found, so a plain
  // browser never shows a second set of controls under its native frame.
  const group = barOf(document).querySelector('.dshBoot__controls')
  assert.equal(group.getAttribute('data-host'), 'yes', 'the controls must be revealed with a host')

  controls[0].dispatch('click', { button: 0 })
  controls[2].dispatch('click', { button: 0 })

  // Filtered to the clicks: the bar also asks for the window's maximize state on
  // mount, which is not an action these assertions are about.
  const commands = sandbox.__invoked.map((call) => call.command)
  assert.deepEqual(
    commands.filter((command) => command !== 'window_is_maximized'),
    ['window_minimize', 'window_close'],
    'the buttons must call the commands the Rust side actually registers',
  )

  // The command names are the whole contract with `window_controls.rs`, so they
  // are checked against it rather than against a copy in this file.
  const rust = readFileSync(join(here, '..', 'src-tauri', 'src', 'window_controls.rs'), 'utf8')
  for (const command of ['window_minimize', 'window_close', 'window_toggle_maximize', 'window_is_maximized', 'window_start_drag']) {
    assert.ok(
      rust.includes(`pub fn ${command}(`),
      `${command} is called by the bar but is not a command in window_controls.rs`,
    )
    assert.ok(
      bootSource.includes(`'${command}'`),
      `window_controls.rs defines ${command} but the bar never calls it`,
    )
  }
})

test('the controls stay hidden when no shell is present', async () => {
  const { document } = createDocument()
  const sandbox = runBoot(document, { withHost: false })
  await settle()

  const group = barOf(document).querySelector('.dshBoot__controls')
  assert.equal(
    group.getAttribute('data-host'),
    'unknown',
    'without a bridge the controls must stay hidden, or a browser tab shows two sets',
  )

  // The ladder is bounded, so it must not schedule work forever on a page that
  // will never grow a bridge.
  await drainTimers(sandbox)
  assert.equal(
    group.getAttribute('data-host'),
    'unknown',
    'the ladder must give up rather than retry indefinitely',
  )
  assert.equal(sandbox.__timers.length, 0, 'and must not schedule more work')
})

test('the maximize button reflects the window state it is given', async () => {
  const { document } = createDocument()
  const sandbox = createSandbox(document)
  // Report the window as maximized from the first query, so the glyph must come
  // back as "restore down" rather than as a second maximize square.
  sandbox.__TAURI__.core.invoke = (command) => {
    sandbox.__invoked.push({ command })
    return Promise.resolve(command === 'window_is_maximized' ? true : undefined)
  }
  vm.createContext(sandbox)
  new vm.Script(bootSource, { filename: 'title-bar/boot.js' }).runInContext(sandbox)
  await settle()

  const maximize = controlsOf(document)[1]
  assert.equal(maximize.getAttribute('aria-label'), '向下还原', 'a maximized window offers restore')
})

test('the bar is a drag surface, but its buttons are not', () => {
  const { document } = createDocument()
  const sandbox = runBoot(document)

  const bar = barOf(document)
  // A decorationless window has no caption for the OS to drag, so the bar asks
  // the host to start one. `event.target.closest` is what keeps a click on a
  // button from being read as a drag.
  bar.dispatch('mousedown', { button: 0, target: bar })
  assert.ok(
    sandbox.__invoked.some((call) => call.command === 'window_start_drag'),
    'a press on the bar itself must start a window move',
  )

  const before = sandbox.__invoked.length
  bar.dispatch('mousedown', { button: 0, target: moreOf(document) })
  assert.equal(
    sandbox.__invoked.length,
    before,
    'a press on a button must NOT start a window move',
  )

  // And a non-primary press is never a drag, or a right-click would move the window.
  bar.dispatch('mousedown', { button: 2, target: bar })
  assert.equal(sandbox.__invoked.length, before, 'only the primary button may start a drag')
})

// ── the handoff to the real bar ─────────────────────────────────────────────

test('the real bar\'s announcement retires the boot bar', () => {
  const { document } = createDocument()
  runBoot(document)
  assert.ok(barOf(document), 'the boot bar must start mounted')

  document.dispatchEvent({ type: READY_EVENT })

  assert.equal(barOf(document), null, 'the boot bar must remove itself on the announcement')
  assert.equal(
    document.getElementById(HOST_ID + '-style'),
    null,
    'and must take its stylesheet with it, or the real bar inherits these rules',
  )
})

test('the boot bar stands down when the real one is already on screen', () => {
  const { document, documentElement } = createDocument()
  // The event only reaches a listener that was already installed. A boot bar that
  // mounts after the announcement — a slow document start on a warm plugin tree —
  // must therefore read the durable marker instead.
  documentElement.setAttribute(READY_ATTRIBUTE, 'ready')

  runBoot(document)

  assert.equal(
    barOf(document),
    null,
    'the durable marker must stop the boot bar from installing itself over the real one',
  )
})

test('the announcement name and marker are spelled identically on both sides', () => {
  const client = readFileSync(CLIENT, 'utf8')

  // The two halves live in different worlds — an injected classic script and a
  // browser bundle — so these two names are the entire contract between them. A
  // typo leaves BOTH bars on screen permanently, which is the failure this test
  // exists to make impossible.
  for (const [name, source] of [['boot.js', bootSource], ['client.js', client]]) {
    assert.ok(source.includes(READY_EVENT), `${name} must name the ready event`)
    assert.ok(source.includes(READY_ATTRIBUTE), `${name} must name the ready marker`)
  }

  // The client half must SET the marker, and the boot half must READ it: two
  // writers or two readers would look correct while doing nothing.
  assert.ok(
    /setAttribute\(TITLEBAR_READY_ATTRIBUTE/.test(client),
    'the client plugin must set the ready marker',
  )
  assert.ok(
    /getAttribute\(READY_ATTRIBUTE\)/.test(bootSource),
    'the boot bar must read the ready marker',
  )
})

test('the bar is guarded against a second evaluation', () => {
  const { document } = createDocument()

  // WebView2 can evaluate a document-created script more than once per document.
  // A second bar would be a second set of window controls stacked in the same
  // strip, which looks like one broken set.
  runBoot(document)
  const first = barOf(document)
  runBoot(document)

  assert.equal(
    barOf(document),
    first,
    'a second evaluation must not replace or duplicate the bar',
  )
  assert.equal(
    document.querySelectorAll('#' + HOST_ID).length,
    1,
    'exactly one bar may exist after two evaluations',
  )
})

test('the bar only mounts on the app\'s own origins', () => {
  // A document-created script runs on every top-level navigation. The bar belongs
  // to this app's window, not to whatever the webview might be pointed at.
  for (const hostname of ['tauri.localhost', '127.0.0.1', 'localhost']) {
    const { document } = createDocument()
    runBoot(document, { location: { protocol: 'http:', hostname, href: 'http://' + hostname + '/' } })
    assert.ok(barOf(document), `the bar must mount on ${hostname}`)
  }

  const { document } = createDocument()
  runBoot(document, {
    location: { protocol: 'https:', hostname: 'example.com', href: 'https://example.com/' },
  })
  assert.equal(barOf(document), null, 'the bar must not mount on a foreign origin')
})

test('the bar never mounts inside a subframe', () => {
  const { document } = createDocument()

  // THE TRAP. WebView2 runs document-created scripts in SUBFRAMES as well, and
  // Tauri's `for_main_frame_only` is documented as ignored on Windows — see
  // `wry`'s `with_initialization_script_for_main_only`. DSH renders same-origin
  // iframes (the document preview is built from a base64 payload), so without this
  // guard the bar would draw a second strip inside every preview pane.
  const inner = createDocument()
  inner.document.defaultView = inner
  const sandbox = runBoot(document, {
    location: { protocol: 'http:', hostname: '127.0.0.1', href: 'http://127.0.0.1:8080/' },
    top: {},
  })

  assert.equal(barOf(document), null, 'a framed document must not get a bar')
  assert.ok(sandbox.__TAURI__, 'the sandbox must still be the app one, to prove the frame check fired')
})

test('a frame with a foreign parent is refused rather than throwing', () => {
  const { document } = createDocument()

  // `frameElement` throws for a cross-origin parent, so the guard compares
  // `window.top` inside a `try`. A throwing comparison must mean "not ours", not
  // an exception during page start — which would leave the whole page unguarded.
  const sandbox = createSandbox(document, {
    location: { protocol: 'http:', hostname: '127.0.0.1', href: 'http://127.0.0.1:8080/' },
  })
  Object.defineProperty(sandbox, 'top', {
    get() {
      throw new Error('cross-origin parent')
    },
  })
  vm.createContext(sandbox)
  new vm.Script(bootSource, { filename: 'title-bar/boot.js' }).runInContext(sandbox)

  assert.equal(barOf(document), null, 'a foreign-parented frame must be left alone')
})

// ── the artwork is one whale ────────────────────────────────────────────────

test('the boot bar draws the same mark as the real one', () => {
  const client = readFileSync(CLIENT, 'utf8')

  // A second copy of the path is unavoidable — the two run in different worlds
  // and neither can import the other — but a second *different* whale is not. The
  // icon generator parses `LOGO_PATH` out of `client.js`, so a drift here would
  // also silently change the taskbar icon.
  const extract = (source) => {
    const match = /var LOGO_PATH\s*=\s*\n?\s*'([^']+)'/.exec(source)
    assert.ok(match, 'LOGO_PATH must be declared')
    return match[1]
  }

  assert.equal(
    extract(bootSource),
    extract(client),
    'the boot bar and the real bar must draw identical artwork',
  )
})

test('the two bars agree on the height they reserve', () => {
  const client = readFileSync(CLIENT, 'utf8')

  // The boot bar reserves the strip on the boot page and the real bar on the DSH
  // page. If they disagreed, the page would jump by the difference at the handoff.
  assert.ok(/BAR_HEIGHT = 44\b/.test(bootSource), 'the boot bar must be 44px tall')
  assert.ok(/BAR_HEIGHT = 44\b/.test(client), 'the real bar must be 44px tall')

  // And the fallback in every `var(...)` that reads the published property must
  // match, or a page where the property is not yet set reserves the wrong space.
  assert.ok(
    bootSource.includes('BAR_HEIGHT + \'px\''),
    'the boot bar must publish its own height',
  )
})

test('the boot and full menus agree on both palette shadows', () => {
  const css = readFileSync(join(here, 'ui-overlay', 'theme.css'), 'utf8')
  const bootCss = readFileSync(join(here, '..', 'src-tauri', 'ui', 'style.css'), 'utf8')
  const client = readFileSync(CLIENT, 'utf8')
  const squash = text => text.replace(/\s+/g, '')
  // Compare the two rendering paths, without freezing a previous visual design.
  // The boot script must also work before the shared stylesheet is available.
  const shadows = [...css.matchAll(/--dsh-menu-shadow:\s*([^;]+);/g)].map(match => match[1])
  assert.equal(shadows.length, 2, 'the shared menu surface defines light and dark elevation')
  for (const shadow of shadows) {
    assert.ok(squash(bootSource).includes(squash(shadow)), 'boot fallbacks must match the full menu surface')
    assert.ok(!/255|#fff|white/i.test(shadow), 'neither drop shadow may become a white glow')
  }
  assert.ok(squash(bootCss).includes(squash(shadows[1])), 'the always-dark boot page uses the dark menu elevation')
  assert.ok(!client.includes('--dsh-menu-shadow:'), 'the full title bar reuses the shared menu surface')
})

// ── the directory actions in the title bar's two menus ──────────────────────

test('the 会话 menu offers 打开… as a submenu, last and below a separator', () => {
  const client = readFileSync(CLIENT, 'utf8')

  const at = client.indexOf('function sessionItems(')
  assert.ok(at > 0, 'sessionItems must exist')
  const body = client.slice(at, client.indexOf('\n    }', at))

  assert.ok(body.includes("id: 'reveal'"), 'the menu must offer the reveal item')
  assert.ok(body.includes("label: t('打开…')"), 'labelled 打开…, since it opens a submenu')

  // It is a SUBMENU PARENT, not a one-click action: `submenu` is the app's own
  // Menu-primitive prop, so the nested list gets the app's positioning, styling,
  // hover behaviour and keyboard contract rather than a lookalike.
  assert.ok(
    /id: 'reveal'[\s\S]*?submenu: submenu/.test(body),
    'the item must carry a submenu, or it is a plain action again',
  )

  // LAST, and after a separator, so it cannot be mistaken for 归档会话 above it.
  const revealAt = body.indexOf("id: 'reveal'")
  const separatorAt = body.indexOf("type: 'separator'")
  assert.ok(separatorAt > 0 && separatorAt < revealAt, 'a separator must precede it')

  // Disabled when there is no directory AND when the host resolved no
  // application: an empty submenu reads as broken rather than as unavailable.
  assert.ok(
    /disabled: !canReveal \|\| submenu\.length === 0/.test(body),
    'the item must be disabled when there is nothing to offer',
  )
})

test('the 会话 menu offers 复制深度链接, wired to the clipboard and the shared toast', () => {
  const client = readFileSync(CLIENT, 'utf8')
  const overlay = readFileSync(OVERLAY, 'utf8')

  const at = client.indexOf('function sessionItems(')
  const body = client.slice(at, client.indexOf('\n    }', at))

  // The item sits with the other session actions, enabled on the same condition
  // they are — `hasCurrent` — so the menu never explains its disabled state two
  // different ways.
  assert.ok(body.includes("id: 'copy-link'"), 'the menu must offer the copy-link item')
  assert.ok(body.includes("label: t('复制深度链接')"), 'labelled 复制深度链接')
  assert.ok(body.includes("label: t('保存会话内容')"), 'the save action uses 保存会话内容')
  assert.ok(
    /id: 'copy-session', label: t\('复制\.\.\.'\), icon: h\(IconCopy\), disabled: !hasCurrent, submenu:/.test(body),
    'enabled exactly when a session is selected, like its neighbours',
  )

  // The icon is the app's own link glyph from the primitives module, like every
  // other icon in the bar — no hand-drawn substitute. The bar resolves each
  // icon through BOTH naming generations (DSH 0.2 renamed the exports), so the
  // assertion checks the resolver call rather than a single member read.
  assert.ok(
    client.includes("iconOrMissing('IconLinkOutline16', 'IconLinkOutlineRegular')"),
    'the bar must use the app’s own link icon',
  )

  // The dispatch routes the id to the copy helper AND keeps it out of the
  // openWithApp fallback, which swallows every unrecognised session-menu id.
  assert.ok(
    /if \(id === 'copy-link'\) copyDeepLink\(\)/.test(client),
    'onSelect must route copy-link to the copy helper',
  )
  assert.ok(
    /if \(!\['rename', 'archive', 'fork', 'copy-link', 'copy-content', 'save-content', 'copy-session'\]\.includes\(id\)\)/.test(client),
    'copy-link must be excluded from the launch-applications fallback',
  )

  // The copy goes through the granted clipboard command and confirms through
  // the overlay's toast — the copied string is invisible, so an unconfirmed
  // copy is indistinguishable from a dead button.
  assert.ok(
    /invokeHost\('clipboard_write_text', \{ text: 'deepseekharness:\/\/session\/' \+ session\.id \}\)/.test(client),
    'the copy must write the scheme link through the host clipboard',
  )
  assert.ok(
    /detail: \{ message: t\('已复制深度链接'\) \}/.test(client),
    'and must confirm the copy through the toast event',
  )

  // THE TWO ENTRIES MUST SPELL THE LINK IDENTICALLY. The title bar's 会话 menu
  // and the overlay's session row menu are two code paths for one action; a
  // scheme drift between them would make one of the two copies dead. The full
  // cross-check lives in the overlay's tests; this asserts the shared prefix
  // exists on both sides.
  assert.ok(
    client.includes('deepseekharness://session/') && overlay.includes('deepseekharness://session/'),
    'both entry points must name the same scheme and resource',
  )
})

test('the 项目 menu keeps the DIRECT action — only 会话 changed shape', () => {
  const client = readFileSync(CLIENT, 'utf8')

  const at = client.indexOf('function projectItems(')
  assert.ok(at > 0, 'projectItems must exist')
  const body = client.slice(at, client.indexOf('\n    }', at))

  // The 项目 menu still opens Explorer directly. The submenu is deliberately
  // scoped to the session menus, so this asserts the scope rather than leaving it
  // to a future reader to guess.
  assert.ok(
    body.includes("id: 'reveal'") && body.includes("label: t('在资源管理器打开')"),
    'the project menu must keep the one-click action',
  )
  assert.ok(
    !body.includes('submenu:'),
    'and must NOT grow a submenu, since the submenu is the session menus’ shape',
  )
  assert.ok(
    !body.includes('apps'),
    'nor depend on the app catalog, which it does not use',
  )
})

test('the 打开… submenu reproduces the app’s own session-header menu', () => {
  const client = readFileSync(CLIENT, 'utf8')

  const at = client.indexOf('function openSubmenuItems(')
  assert.ok(at > 0, 'openSubmenuItems must exist')
  const body = client.slice(at, client.indexOf('\n    }', at))

  // Same catalog and same order: the host's resolution map keys, which is what the
  // app's own menu lists. The ids are NOT hard-coded, so an application the host
  // gains or loses is followed rather than pinned.
  assert.ok(
    body.includes('apps[i].id') && body.includes('apps[i].label'),
    'the entries must come from the host’s resolved catalog',
  )

  // The app's real application icon, from the host's own icon route — the same
  // PNG the app's menu shows, not a substitute glyph.
  assert.ok(
    body.includes('appIconUrl(apps[i].id)'),
    'each entry must use the host-served application icon',
  )

  // The read is the app's own apps route, and it must not reject: a host without
  // the capability yields an empty list, and the caller then offers no submenu.
  assert.ok(
    client.includes("'/open-in-app/apps'"),
    'the catalog must come from the app’s own apps route',
  )
  assert.ok(
    /\.catch\(function \(\) \{[\s\S]{0,120}return \[\]/.test(client),
    'a failed catalog read must degrade to no submenu, never to a rejection',
  )

  // The app's own labels, mirrored because the app keeps that map module-private.
  // An id the app has and this map lacks degrades to "not offered", never to a
  // wrong label — which is why it is a map and not a passthrough.
  assert.ok(
    client.includes('get explorer() { return t(\'文件资源管理器\') }') && client.includes('cursor: \'Cursor\''),
    'the labels must mirror the app’s dictionary',
  )
})

test('the title bar’s open actions post to the app’s own launcher route', () => {
  const client = readFileSync(CLIENT, 'utf8')

  // One launcher for the whole project: the submenu passes the CHOSEN app id, and
  // the directory actions pass `explorer`. Both end at the same route, so there is
  // no second launcher to keep in step — and no new Rust command or Tauri
  // permission, since DSH already owns a verified one.
  assert.ok(client.includes("'/open-in-app/open'"), 'the bar must post to the app’s launcher route')
  assert.ok(
    /function openWithApp\(ctx, appId, path\)/.test(client),
    'one helper must take the app id, so the choice is data rather than a second call site',
  )
  assert.ok(
    /openWithApp\(ctx, 'explorer', path\)/.test(client),
    'and the direct action must be that helper with the explorer entry',
  )
  assert.ok(
    /openWithApp\(ctx, id, revealPath\)/.test(client),
    'while the submenu passes the id it was given',
  )

  // It must NOT go through the host bridge: the launcher is the app's, and a
  // second path would need a permission this app deliberately does not grant.
  assert.ok(
    !/invokeHost\('open_/.test(client),
    'the bar must not add a host command for this; the app already owns a launcher',
  )

  // The folder icon comes from the app's primitives module, like every other icon
  // in the bar — no hand-drawn glyph. Resolved across naming generations, as
  // every icon in the bar is.
  assert.ok(
    client.includes("iconOrMissing('IconFolderOpenOutline16', 'IconFolderOpenOutlineRegular')"),
    'the bar must use the app’s own folder icon',
  )
})

test('a refused launch is reported to the page, not only to the console', () => {
  const client = readFileSync(CLIENT, 'utf8')
  const overlay = readFileSync(OVERLAY, 'utf8')

  // WHY THIS EXISTS. A launch that answers 404 — a workspace whose directory was
  // moved or deleted, the most common real refusal — used to close the menu and
  // do nothing else anywhere: the failure was console-only on the bar's side and
  // not even that on the overlay's. What the user reports for a silent no-op is
  // "菜单里无法使用", with nothing to diagnose it by. The bar now reads the
  // route's reason and hands it to the page.
  assert.ok(
    /function reportLaunchFailure\(ctx, path, reason\)/.test(client),
    'the failure path must have a dedicated reporter',
  )
  assert.ok(
    /response\s*\n?\s*\.json\(\)/.test(client) || client.includes('response.json()'),
    'the route’s JSON reason must be read, not just the status',
  )

  // The channel is the overlay's toast listener, dispatched by event name. The
  // two files must spell it identically or the report dies on the document.
  assert.ok(
    /var REPORT_EVENT = 'dsh-desktop:report'/.test(client),
    'the bar must declare the report event',
  )
  assert.ok(
    overlay.includes("var REPORT_EVENT = 'dsh-desktop:report'") &&
      overlay.includes('addEventListener(REPORT_EVENT'),
    'and the overlay must listen for the same event name',
  )

  // The dispatch is guarded, because a page without CustomEvent (or without a
  // listener) must degrade to the log line, never to a throw.
  assert.ok(
    /new CustomEvent\(REPORT_EVENT, \{/.test(client),
    'the report must carry a detail payload',
  )
})

test('the real bar’s 关于 opens a dialog built on the app’s primitives', () => {
  const client = readFileSync(CLIENT, 'utf8')

  // The item used to be listed but disabled (`disabled: true`) because there
  // was nothing for it to say. It now opens the About dialog, so the menu item
  // must not carry a disabled flag any more.
  const moreAt = client.indexOf('function moreItems(')
  assert.ok(moreAt > 0, 'moreItems must exist')
  const moreBody = client.slice(moreAt, client.indexOf('\n    }', moreAt))
  assert.ok(
    !/id: 'about'[^\n]*disabled/.test(moreBody),
    '关于 must be offered enabled — the dialog gives it something to say',
  )
  assert.ok(
    moreBody.includes("{ id: 'about', label: t('关于'), icon: h(IconQuestion) }"),
    'the item keeps its id, label and icon',
  )

  // The menu routes the choice to the dialog state, and the state renders it.
  assert.ok(
    /if \(id === 'about'\) setAboutOpen\(true\)/.test(client),
    'onSelect must open the dialog for the about id',
  )
  const aboutAt = client.indexOf('function AboutDialog(')
  assert.ok(aboutAt > 0, 'an AboutDialog must exist')
  const aboutBody = client.slice(aboutAt, client.indexOf('\n    }', aboutAt))
  assert.ok(
    /h\(\s*Modal,/.test(aboutBody) && aboutBody.includes("closeLabel: t('关闭')"),
    'the dialog must be built on the app’s own Modal, not a lookalike surface',
  )
  assert.ok(
    aboutBody.includes('h(Logo)'),
    'the mark must be the bar’s own whale — a second drawing would be a second brand',
  )

  // The version comes from the shell, read once on first open, and a failed or
  // unavailable read omits the row (`''`) rather than showing a placeholder: a
  // dialog about the build must not claim a build it cannot name.
  assert.ok(
    /api\.app\.getVersion\(\)/.test(client),
    'the version must come from the shell’s own API',
  )
  assert.ok(
    /if \(!aboutOpen \|\| appVersion !== null\) return/.test(client),
    'the read must happen once, when the dialog first opens',
  )
  assert.ok(
    /setAppVersion\(''\)/.test(client),
    'an unavailable version must degrade to an omitted row, never a placeholder',
  )

  // And the remote page may only call it because the capability grants exactly
  // that one core permission — not the whole app namespace.
  const capability = JSON.parse(
    readFileSync(join(here, '..', 'src-tauri', 'capabilities', 'title-bar.json'), 'utf8'),
  )
  assert.ok(
    capability.permissions.includes('core:app:allow-version'),
    'the title-bar capability must grant core:app:allow-version for the version read',
  )
  assert.ok(
    !capability.permissions.includes('core:app:default'),
    'and must not grant the whole app namespace for one call',
  )
})

// ── the mark, which is also the sidebar's collapse control ──────────────────

test('the real bar’s mark is a button carrying both glyphs', () => {
  const client = readFileSync(CLIENT, 'utf8')

  // THE CONTROL THE SIDEBAR LOST. The overlay hides the sidebar's own header —
  // the mark, the wordmark and 收起侧边栏 — so the bar's mark becomes the control
  // that replaces it. The reasoning lives in `client.js` and `theme.css` section 9;
  // what is asserted here is the DOM shape, which is what the stylesheet keys on.
  const at = client.indexOf('function brand()')
  assert.ok(at > 0, 'the brand must be built by a dedicated function, not inline in the tree')
  const body = client.slice(at, client.indexOf('\n      }', at))

  // A real button, so it is focusable and keyboard-operable — the sidebar's was one,
  // and nothing about moving it changes what it is.
  assert.ok(/h\(\s*'button',/.test(body), 'the mark must be a button, not a div with a click handler')
  assert.ok(body.includes("type: 'button'"), 'and must declare its type')

  // Both glyphs in the tree at once, with the stylesheet choosing between them —
  // see the hover test in `vanilla-mode.test.mjs` for why not a state swap.
  assert.ok(body.includes("className: 'dshTb__markLogo'"), 'the mark glyph must be rendered')
  assert.ok(body.includes("className: 'dshTb__markPanel'"), 'and the panel glyph alongside it')

  // The click routes to the layout service, guarded.
  assert.ok(/onClick: toggleSidebar/.test(body), 'the click must call the guarded toggle')

  // Pointer-down is suppressed like every other button in the bar, or clicking the
  // mark would blur the composer and drop a pending selection.
  assert.ok(
    /onMouseDown: function \(event\) \{ event\.preventDefault\(\) \}/.test(body),
    'the mark must not steal focus from the composer',
  )

  // The lockup around it is unchanged: the wordmark and badge still render, so the
  // bar keeps the identity the sidebar's row used to carry.
  assert.ok(body.includes("className: 'dshTb__wordmark'"), 'the wordmark must still render')
  assert.ok(body.includes("className: 'dshTb__badge'"), 'and the HARNESS badge')

  // It must be USED in the tree. A builder nothing calls would satisfy every
  // assertion above while leaving the bar exactly as it was.
  assert.ok(/^\s*brand\(\),$/m.test(client), 'the tree must render brand()')
})

test('the boot bar’s brand stays inert, because nothing owns a sidebar yet', () => {
  // The boot bar is injected by the Rust host and runs before DSH exists — there is
  // no layout service, no sidebar, and no session. Its mark must therefore stay
  // what it is: artwork. Making it a button there would draw a control that cannot
  // do anything on exactly the screens a user reaches when something has gone wrong.
  assert.ok(
    !bootSource.includes('dshBoot__mark'),
    'the boot bar must not carry the mark control’s class',
  )
  assert.ok(
    !bootSource.includes('toggleSidebar'),
    'and must not call a sidebar service that does not exist yet',
  )

  // Its lockup is still asserted by the executed tests above (`.dshBoot__brand`),
  // so this only pins the absence of the new control.
})


test('the boot bar honours the icon-hover preference the host has already published', () => {
  // The host's head script writes `data-dsh-titlebar-hover` before <body> exists,
  // and this bar mounts as soon as it does — so one attribute read is the whole
  // mechanism. With the preference off, the bar must install a rule that kills
  // its own hover states; with it on (or absent), it must not.
  const { document: off } = createDocument()
  off.documentElement.setAttribute('data-dsh-titlebar-hover', 'off')
  runBoot(off)

  const disabled = off.head.children.find((node) => node.id === HOST_ID + '-style-hover-off')
  assert.ok(disabled, 'the hover-off rule must be installed when the attribute is off')
  const rule = disabled.textContent
  assert.ok(rule.includes(".dshBoot__control--close:hover"), 'the red close tint must be silenced')
  assert.ok(rule.includes('.dshBoot__item:hover'), 'the trigger highlight must be silenced')
  assert.ok(rule.includes('.dshBoot__control:hover'), 'the window-control highlight must be silenced')

  const { document: on } = createDocument()
  runBoot(on)
  assert.equal(
    on.head.children.find((node) => node.id === HOST_ID + '-style-hover-off'),
    undefined,
    'no hover-off rule may be installed while the preference is on (or unset)',
  )
})

test('title-bar shape and hover belong to the app, not appearance settings', () => {
  const client = readFileSync(CLIENT, 'utf8')
  const appearance = readFileSync(join(here, 'ui-client', 'client.js'), 'utf8')
  const host = readFileSync(join(here, 'desktop-ui.mjs'), 'utf8')
  for (const label of ['简易标题栏', '关闭图标悬停', "title: '标题栏'", "title: '标题栏图标悬停'"]) {
    assert.ok(!client.includes(label) && !appearance.includes(label), label + ' must not be offered')
  }
  for (const event of ['dsh-desktop:set-titlebar-mode', 'dsh-desktop:set-titlebar-hover']) {
    assert.ok(!client.includes(event) && !appearance.includes(event), 'old preference requests are no longer handled')
  }
  for (const attribute of ['data-dsh-titlebar-mode', 'data-dsh-titlebar-hover']) {
    assert.ok(client.includes(attribute) && host.includes(attribute), 'app-owned chrome still uses ' + attribute)
  }
  assert.ok(host.includes("chromeAttributesScript(readUiMode(ctx), TITLEBAR_FULL, 'on')"), 'old saved simple/off choices cannot hide running app controls')
})

test('the stylesheet gates the bar’s hover rules and nothing else about the bar', () => {
  const css = readFileSync(join(here, 'ui-overlay', 'theme.css'), 'utf8')
  const gate = "html:not([data-dsh-titlebar-hover='off'])"

  // Every gated rule must be one of the bar's own hover reactions, and the
  // focus-visible reveal must stay ungated: a keyboard user keeps the reveal
  // whatever the pointer preference says. The gated rules are written one per
  // line, so line scanning is the structural check.
  const gatedLines = css.split('\n').filter((line) => line.includes(gate))
  assert.ok(gatedLines.length >= 4, 'the trigger, control, close and mark hover rules must be gated')
  for (const line of gatedLines) {
    assert.ok(line.includes('.dshTb__'), 'only bar rules may be gated: ' + line.trim())
    assert.ok(line.includes(':hover'), 'only hover reactions may be gated: ' + line.trim())
  }
  const focusLines = css
    .split('\n')
    .filter((line) => /[.]dshTb__(item|control|mark):focus-visible/.test(line))
  assert.ok(focusLines.length >= 4, 'the focus rules must exist to be checked')
  for (const line of focusLines) {
    assert.ok(!line.includes(gate), 'the focus reveal must never be gated: ' + line.trim())
  }
})
