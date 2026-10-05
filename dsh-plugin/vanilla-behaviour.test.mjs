/**
 * Executes the 原版 switch end to end in a simulated page.
 *
 * The other test file asserts the contract between the four files as text. This
 * one goes further and *runs* the two halves that are runnable outside a browser:
 *
 *   - `ui-overlay/dom.js` as a classic script over a minimal DOM stub, with the
 *     mode flipped underneath it, and
 *   - the CSS gate, evaluated by a tiny selector matcher over a synthetic tree.
 *
 * The point is to catch the failures a text assertion cannot: a guard placed
 * after the work it was meant to prevent, a cleanup that misses an attribute
 * because it only removes it from the first matching node, and a gate that stops
 * matching the title bar along with everything else.
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
const domSource = readFileSync(join(here, 'ui-overlay', 'dom.js'), 'utf8')

/**
 * A DOM element stub with just enough surface for the overlay.
 *
 * Deliberately minimal: only the methods `dom.js` actually calls, so a new call
 * site fails loudly here rather than passing against an over-built fake.
 */
class FakeElement {
  constructor(tagName, className = '') {
    this.tagName = tagName.toUpperCase()
    this.className = className
    /** Element node, as the dialog scan filters on `nodeType === 1`. */
    this.nodeType = 1
    this.children = []
    this.parentElement = null
    this.attributes = new Map()
    this.textContent = ''
    /** The inline-style surface, as `dom.js` writes to it for a hairline divider. */
    this.style = { cssText: '' }
    /** Set by the reveal row's icon; the stub only needs it to be assignable. */
    this.innerHTML = ''
    /** Appended listeners, so a test can drive a click the overlay bound. */
    this.listeners = new Map()
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    // `class` is kept in step with the attribute, as the DOM does. `className` is
    // what the selector matcher reads, so a `setAttribute('class', …)` that did not
    // update it would let a fixture set a marker nothing could match — a stub that
    // silently disagrees with the browser.
    if (name === 'class') this.className = String(value)
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  /**
   * `appendChild`, as `dom.js` builds the reveal row with it.
   *
   * Distinct from `append` because the DOM has both and the code under test uses
   * each: `append` for the overlay's own tagging helpers, `appendChild` when
   * constructing a new element.
   */
  appendChild(child) {
    return this.append(child)
  }

  /** Register a listener, so a test can dispatch a click at it. */
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }

  /** Whether this node is still in the document, as the DOM reports it. */
  get isConnected() {
    let node = this
    while (node) {
      if (node.tagName === 'HTML') return true
      node = node.parentElement
    }
    return false
  }

  /** Detach a child, as the submenu cleanup does. */
  removeChild(child) {
    const at = this.children.indexOf(child)
    if (at >= 0) this.children.splice(at, 1)
    child.parentElement = null
    return child
  }

  /**
   * Re-insert a node before a sibling, as the exit-animation replay does.
   *
   * A node that is already parented is moved, the way the DOM's own
   * `insertBefore` moves rather than throws — the replay can legitimately be
   * handed a clone whose bookkeeping the stub must keep in step with.
   */
  insertBefore(node, ref) {
    const at = this.children.indexOf(ref)
    if (at < 0) return this.append(node)
    if (node.parentElement) node.parentElement.removeChild(node)
    this.children.splice(at, 0, node)
    node.parentElement = this
    return node
  }

  /**
   * A copy of this node, as the exit-animation replay builds its ghost with.
   *
   * The REAL reason this must be a faithful copy and not a re-wrap of the same
   * object: the overlay's ghost is a `cloneNode` precisely because React's
   * handles on a node are JavaScript properties a clone does not carry. The
   * stub has no such handles, but the attribute and child copy is what the
   * assertions read, so attributes (the ghost marker, the layer tag, the
   * position fixtures) and, when deep, the whole subtree are reproduced.
   */
  cloneNode(deep = false) {
    const clone = new FakeElement(this.tagName, String(this.className))
    for (const [name, value] of this.attributes) clone.setAttribute(name, value)
    clone.textContent = this.textContent
    if (deep) {
      for (const child of this.children) clone.append(child.cloneNode(true))
    }
    return clone
  }

  /** Fire the listeners for one event type, as a real click would. */
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({
        type,
        // `currentTarget` is the element the listener is bound to, which is how a
        // listener reads its own `data-*` attributes off the event.
        currentTarget: this,
        target: this,
        stopPropagation: () => {},
        preventDefault: () => {},
        ...event,
      })
    }
  }

  /**
   * Reflect a property write into the attribute map, for the properties the DOM
   * treats as attributes (`src`, `width`, `height`, `alt`, `title`, `type`).
   *
   * Without this, `img.src = '…'` would be invisible to `getAttribute('src')` and a
   * test asserting the icon URL would see null while the browser would see the
   * real value — a stub that disagrees with the engine in the direction that hides
   * bugs.
   */
  set src(value) {
    this.setAttribute('src', value)
  }

  get src() {
    return this.getAttribute('src')
  }

  set width(value) {
    this.setAttribute('width', value)
  }

  set height(value) {
    this.setAttribute('height', value)
  }

  set alt(value) {
    this.setAttribute('alt', value)
  }

  set title(value) {
    this.setAttribute('title', value)
  }

  set type(value) {
    this.setAttribute('type', value)
  }

  /** The node's own keys, which is how the fiber lookup finds React's handle. */
  get ownKeys() {
    return Object.keys(this)
  }

  /** Class tokens, as the dialog exclusion reads them. */
  get classList() {
    const tokens = String(this.className).split(/\s+/).filter(Boolean)
    return { contains: (token) => tokens.includes(token) }
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  /** Whether this node or any descendant matches, by the few rules the stub needs. */
  querySelector(selector) {
    const found = []
    collect(this, found)
    for (const node of found) {
      if (matches(node, selector)) return node
    }
    return null
  }

  querySelectorAll(selector) {
    const found = []
    collect(this, found)
    return found.filter((node) => matches(node, selector))
  }

  matches(selector) {
    return matches(this, selector)
  }

  closest(selector) {
    let node = this
    while (node) {
      if (matches(node, selector)) return node
      node = node.parentElement
    }
    return null
  }

  contains(other) {
    let node = other
    while (node) {
      if (node === this) return true
      node = node.parentElement
    }
    return false
  }

  append(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  /**
   * The element's viewport box, for the dialog size test.
   *
   * A `data-size="small"` element reports a menu-sized box and everything else
   * reports a viewport-filling one, which is the distinction that test rests on.
   * Defaulting to the small box is the safe direction: an element the stub cannot
   * classify is then left untagged rather than pushed down.
   */
  getBoundingClientRect() {
    if (this.getAttribute('data-size') === 'viewport') {
      return { left: 0, top: 0, right: 1280, bottom: 840, width: 1280, height: 840 }
    }
    return { left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 }
  }
}

/** Depth-first collection, so querySelector sees the whole subtree. */
function collect(node, out) {
  for (const child of node.children) {
    out.push(child)
    collect(child, out)
  }
}

/**
 * Match the handful of selector forms the overlay uses.
 *
 * Only what is needed: `[attr]`, `[attr="value"]`, `[class*="x"]`, `[class*="x"][class*="y"]`,
 * a bare tag, and a comma-separated LIST of any of those. Anything else returns
 * false, which is the safe direction — the stub then decorates nothing rather
 * than everything.
 *
 * The list form is not optional: `clearDecorations` queries all three of the
 * overlay's attributes in one call, and a stub that ignored the commas would
 * report "nothing to clean" while the real page cleaned up correctly.
 */
function matches(node, selector) {
  const alternatives = selector.split(',')
  if (alternatives.length > 1) {
    return alternatives.some((part) => matches(node, part.trim()))
  }

  // `body *` — the periodic sweep's selector. A real engine returns every
  // descendant of body; the stub tree is rooted at <html>, so ancestry is what
  // decides. Without this branch the sweep silently matches nothing, which would
  // make the backstop untestable while looking implemented.
  if (/^body\s+\*$/.test(selector.trim())) {
    let parent = node.parentElement
    while (parent) {
      if (parent.tagName === 'BODY') return true
      parent = parent.parentElement
    }
    return false
  }

  // COMPOUND selectors: a class fragment AND an attribute, as
  // `[class*="menuOpen"][role="treeitem"]` is. Every part must hold, so each is
  // evaluated rather than returning on the first one that matches — returning
  // early on the class alone would make the stub match rows the real engine does
  // not, which is the direction that hides bugs.
  const classTests = [...selector.matchAll(/\[class\*=["']([^"']+)["']\]/g)].map((m) => m[1])
  const classOk = classTests.every((fragment) => String(node.className).includes(fragment))

  // Every `[attr=value]` in the selector (there may be more than one).
  const attrValues = [...selector.matchAll(/\[([\w-]+)=["']([^"']*)["']\]/g)]
  const attrsOk = attrValues.every(([, name, value]) => node.getAttribute(name) === value)

  if (classTests.length > 0 || attrValues.length > 0) {
    return classOk && attrsOk
  }

  // A bare `[attr]` presence test.
  const attrName = /^\[([\w-]+)\]$/.exec(selector.trim())
  if (attrName) return node.hasAttribute(attrName[1])

  // A bare tag, used for dialog detection in this stub.
  if (/^[a-z]+$/i.test(selector)) return node.tagName === selector.toUpperCase()
  return false
}

/** A `document` stub over a synthetic tree, with the functions dom.js touches. */
function createDocument() {
  const documentElement = new FakeElement('html')
  const body = new FakeElement('body')
  documentElement.append(body)

  const listeners = new Map()
  const document = {
    documentElement,
    body,
    title: 'DeepSeek Harness',
    children: [documentElement],
    querySelector: (selector) => {
      for (const node of [documentElement, ...flatten(documentElement)]) {
        if (matches(node, selector)) return node
      }
      return null
    },
    querySelectorAll: (selector) =>
      [documentElement, ...flatten(documentElement)].filter((node) => matches(node, selector)),
    addEventListener: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    removeEventListener: () => {},
    dispatchEvent: (event) => {
      for (const fn of listeners.get(event.type) ?? []) fn(event)
      return true
    },
    /**
     * Element construction, as the reveal row builds itself with it.
     *
     * The stub previously had no `createElement` because nothing in the overlay
     * created nodes. The reveal item does, so it is added rather than worked
     * around: the alternative — a seam in the production file for the test's
     * benefit — would leave the shipping construction path unexercised.
     */
    createElement: (tagName) => new FakeElement(tagName),
    /**
     * An empty stylesheet list.
     *
     * The submenu's class is looked up from the loaded stylesheets (it is a
     * per-build hash). An empty list is the honest stub for a page that has none:
     * the lookup must return nothing and the code must fall back, which is exactly
     * the path a deleted stylesheet rule takes.
     */
    styleSheets: [],
  }
  return document
}

/** Every node in the tree, including the root. */
function flatten(node, out = []) {
  for (const child of node.children) {
    out.push(child)
    flatten(child, out)
  }
  return out
}

/**
 * Build the page the overlay expects: the app mounted, with the nodes it tags.
 *
 * The frame mirrors the app's real structure (`dsh-client-ui-layout`):
 *
 *     div[class*="_frame"]                              the grid frame
 *       div[class*="_sidebarCol"]
 *       div[class*="_centerCol"]
 *       div[class*="_rightbarCol"][data-rightbar-col]
 *       div[class*="_overlayLayer"][data-shell-overlay] <- always rendered
 *
 * `data-shell-overlay` is the anchor the stylesheet uses to find the frame, so it
 * is modelled exactly as the app writes it: the literal string `true`. The
 * conditional `data-rightbar-collapsed` is deliberately NOT modelled — the whole
 * point of the fix is that the layout must not depend on it.
 *
 * @returns the document stub plus the nodes assertions need.
 */
function createPage() {
  const document = createDocument()

  const frame = new FakeElement('div', '_frame_abc123')
  const sidebar = new FakeElement('div', '_sidebarCol_abc123')
  const center = new FakeElement('div', '_centerCol_abc123')
  const rightbar = new FakeElement('div', '_rightbarCol_abc123')
  rightbar.setAttribute('data-rightbar-col', 'true')

  const overlayLayer = new FakeElement('div', '_overlayLayer_abc123')
  overlayLayer.setAttribute('data-shell-overlay', 'true')

  frame.append(sidebar)
  frame.append(center)
  frame.append(rightbar)
  frame.append(overlayLayer)
  document.body.append(frame)

  const composerInput = new FakeElement('div', '_input_abc123')
  composerInput.setAttribute('contenteditable', 'true')
  const composerCard = new FakeElement('div', '_card_abc123')
  composerCard.append(composerInput)
  center.append(composerCard)

  return { document, frame, overlayLayer, composerCard }
}

/** Build the `window`/global sandbox `dom.js` runs in. */
function createSandbox(document) {
  /**
   * Callbacks queued for the next animation frame, and the observers installed.
   *
   * Both are RECORDED rather than dropped so a test can drive the real path —
   * a mutation arrives, the observer's callback runs, it schedules a frame, the
   * frame runs the work. The overlay's own injection hangs off exactly that chain,
   * so stubbing it to a no-op would leave the feature untestable while looking
   * covered.
   */
  const frames = []
  const observers = []

  const sandbox = {
    document,
    console,
    // The overlay polls on a timer, which stays a no-op: a test drives `pass()`
    // explicitly rather than racing a clock.
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => {
      frames.push(fn)
      return frames.length
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback
        observers.push(this)
      }
      observe() {}
      disconnect() {}
    },
    KeyboardEvent: class {
      constructor(type, init) {
        this.type = type
        Object.assign(this, init)
      }
    },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init?.detail
      }
    },
    // The dialog tag is decided from computed style: `position: fixed` plus the
    // four inset sides. A layer declares its inset as a space-separated
    // top/right/bottom/left list, defaulting to `auto` on every side — which is
    // what a coordinate-positioned popup effectively is, so an un-annotated
    // element is never tagged.
    innerWidth: 1280,
    innerHeight: 840,
    // The dialog tag is decided from computed style: `position: fixed` plus the
    // four inset sides. A layer declares its inset as a space-separated
    // top/right/bottom/left list, defaulting to `auto` on every side — which is
    // what a coordinate-positioned popup effectively is, so an un-annotated
    // element is never tagged.
    //
    // THE TAGGED SHAPE IS MODELLED TOO, and that is the load-bearing half. The
    // stylesheet turns `data-dsh-chrome='layer'` into
    // `top: var(--dsh-desktop-titlebar-height, 44px)`, so a TAGGED fixed layer's
    // computed top is the bar's height and no longer the inset's `0px`. A stub
    // that ignored that link would answer the retirement question from a shape
    // the real engine can never report while the tag is on — which is exactly
    // how the flip-flop shipped: the retirement retired every tag it had just
    // written, in the browser, while these tests stayed green.
    getComputedStyle: (node) => {
      const inset = (node.getAttribute('data-inset') ?? 'auto auto auto auto').split(/\s+/)
      const [top, right = top, bottom = top, left = right] = inset
      const position = node.getAttribute('data-position') ?? 'static'
      const style = {
        position,
        top: top === '0' ? '0px' : top,
        right: right === '0' ? '0px' : right,
        bottom: bottom === '0' ? '0px' : bottom,
        left: left === '0' ? '0px' : left,
      }
      if (position === 'fixed' && node.getAttribute('data-dsh-chrome') === 'layer') {
        style.top = '44px'
      }
      return style
    },
  }

  /**
   * Deliver a DOM mutation the way the browser would: every observer's callback
   * runs, then the frames those callbacks scheduled.
   *
   * This is the overlay's real path for the reveal injection — a menu mounts, the
   * body observer fires, its frame callback injects — so a test that calls this is
   * exercising the shipping code rather than a seam written for it.
   */
  sandbox.deliverMutation = () => {
    for (const observer of observers.slice()) observer.callback([])
    const pending = frames.splice(0)
    for (const fn of pending) fn(0)
  }

  /**
   * Run the overlay's own periodic pass, without a mutation to trigger it.
   *
   * The steady-state interval is a no-op in this stub (a test drives the work
   * explicitly rather than racing a clock), so this reaches the pass through the
   * observer's frame callback — the same path a real DOM change takes. It is what
   * exercises the RETIREMENT half of a tag: a surface React re-rendered into a
   * different shape, with no node added or removed for the observer to see.
   */
  sandbox.deliverPass = () => {
    for (const observer of observers.slice()) observer.callback([])
    const pending = frames.splice(0)
    for (const fn of pending) fn(0)
  }

  /**
   * Deliver REMOVAL records the way the browser would.
   *
   * The exit-animation observer does its work synchronously in its callback —
   * no frame is scheduled — so delivering the records is the whole path. The
   * records are handed to every observer, exactly as one real mutation batch
   * reaches all of them; the coalescing observers only schedule a harmless
   * frame in response.
   *
   * @param records - MutationRecord-shaped objects: `removedNodes`, `target`,
   *   `nextSibling`.
   */
  sandbox.deliverRemoval = (records) => {
    for (const observer of observers.slice()) observer.callback(records)
  }

  /**
   * Deliver a mutation AND let the catalog promise chain settle.
   *
   * A session menu's row is built when `/open-in-app/apps` answers, so a test that
   * only runs the frame callback would see nothing injected and would be measuring
   * the stub's timing rather than the feature. Awaiting this is what makes the
   * session case testable at all.
   *
   * @returns a promise settled after the injection has had its chance to run.
   */
  sandbox.deliverMutationAsync = async () => {
    sandbox.deliverMutation()
    // Three microtask turns: the fetch answer, the `.json()` answer, then the
    // continuation that appends the row.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    sandbox.deliverMutation()
  }

  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  /**
   * A `fetch` stub answering the app's launcher routes.
   *
   * The reveal feature posts to `/open-in-app/open` and reads `/open-in-app/apps`,
   * so both are recorded here: a test can assert WHICH application and directory a
   * click asked for, rather than only that something happened.
   *
   * The apps answer is configurable so a host with no resolved applications — a
   * real case, and the one where the submenu must not appear — can be exercised.
   */
  sandbox.fetch = (url, init) => {
    sandbox.requests.push({ url: String(url), init })
    if (String(url).indexOf('/open-in-app/apps') !== -1) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ apps: sandbox.appCatalog }),
      })
    }
    return Promise.resolve({ ok: true })
  }
  sandbox.requests = []
  /** What the host answers for `/open-in-app/apps`; overridable per test. */
  sandbox.appCatalog = ['explorer', 'cursor', 'vscode']

  return sandbox
}

/**
 * Evaluate `dom.js` against a page, returning its sandbox.
 *
 * The script is an IIFE that runs its first pass immediately and installs a
 * listener for the mode change, so evaluating it is enough to bring the overlay
 * up — exactly as an injected `<script>` does in the real page.
 */
function runOverlay(document, { desktop = true } = {}) {
  const sandbox = createSandbox(document)
  if (desktop) sandbox.__TAURI__ = { core: { invoke: async () => ({}) } }
  vm.createContext(sandbox)
  new vm.Script(domSource, { filename: 'dom.js' }).runInContext(sandbox)
  return sandbox
}

test('ordinary browsers do not get desktop directory launch menu items', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceRow' })
  const { viewport } = createOpenMenu(document, ['重命名', '删除工作区'])
  const sandbox = runOverlay(document, { desktop: false })
  await sandbox.deliverMutationAsync()
  assert.equal(viewport.children.filter(c => c.getAttribute('data-dsh-desktop') === 'reveal-item').length, 0)
  assert.equal(sandbox.requests.length, 0)
})

/** Flip the mode and run one pass, as the injected listener does on a change. */
function setMode(document, mode) {
  document.documentElement.setAttribute('data-dsh-ui', mode)
  document.dispatchEvent({ type: 'dsh-desktop:ui-mode', detail: { mode } })
}

// ── the behaviours ───────────────────────────────────────────────────────────

test('the overlay decorates the page when the mode is desktop', () => {
  const { document, composerCard } = createPage()
  // Absent attribute: the stylesheet's gate treats that as desktop, and so must
  // the DOM tier, or a plain browser load would come up undecorated.
  runOverlay(document)

  assert.equal(
    composerCard.getAttribute('data-dsh-desktop'),
    'composer',
    'the composer must be tagged so the stylesheet can target it',
  )
  assert.equal(document.documentElement.getAttribute('data-dsh-ready'), '1')
})

test('switching to 原版 removes every tag the overlay added', () => {
  const { document, composerCard } = createPage()
  runOverlay(document)

  // Give the overlay something to clean up beyond the composer, so the cleanup
  // is exercised on more than one node and more than one attribute.
  const extraCard = new FakeElement('div', '_card_xyz')
  document.body.append(extraCard)
  setMode(document, 'desktop')
  const reTagged = document.querySelector('[class*="_card"][data-dsh-desktop="composer"]')
  assert.ok(reTagged, 'the composer must be tagged in desktop mode')

  setMode(document, 'vanilla')

  assert.equal(
    composerCard.getAttribute('data-dsh-desktop'),
    null,
    'the composer tag must be removed, not merely ignored',
  )
  assert.equal(
    document.documentElement.getAttribute('data-dsh-ready'),
    null,
    'the readiness flag must be removed with the rest',
  )
  assert.equal(
    document.querySelector('[data-dsh-desktop]'),
    null,
    'no element may keep an overlay attribute in 原版',
  )
  assert.equal(
    document.title,
    'DeepSeek Harness',
    'the frontend title must be restored',
  )
})

test('cleaning up removes the tag from EVERY matching node, not just the first', () => {
  const { document } = createPage()
  runOverlay(document)

  // Several nodes carrying the overlay's attributes at once — the shape a real
  // page has after the settings panel and a menu have both been open.
  for (const attribute of ['data-dsh-desktop', 'data-dsh-relocated', 'data-dsh-danger']) {
    for (let i = 0; i < 3; i += 1) {
      const node = new FakeElement('div', '_row_' + i)
      node.setAttribute(attribute, 'true')
      document.body.append(node)
    }
  }

  setMode(document, 'vanilla')

  for (const attribute of ['data-dsh-desktop', 'data-dsh-relocated', 'data-dsh-danger']) {
    assert.equal(
      document.querySelectorAll(`[${attribute}]`).length,
      0,
      `every ${attribute} tag must be removed`,
    )
  }
})

test('switching back to the new styles re-decorates the page', () => {
  const { document, composerCard } = createPage()
  runOverlay(document)

  setMode(document, 'vanilla')
  assert.equal(composerCard.getAttribute('data-dsh-desktop'), null)

  setMode(document, 'desktop')

  assert.equal(
    composerCard.getAttribute('data-dsh-desktop'),
    'composer',
    'the composer must be tagged again after switching back',
  )
  assert.equal(document.documentElement.getAttribute('data-dsh-ready'), '1')
})

test('the native right-click menu is only taken over in desktop mode', () => {
  const { document } = createPage()
  runOverlay(document)

  const prevented = []
  // A plain object rather than the KeyboardEvent stub: the handler only reads
  // `target` and calls `preventDefault`, and the stub document dispatches it
  // straight to the capture listener dom.js installed.
  const event = {
    type: 'contextmenu',
    target: document.body,
    clientX: 10,
    clientY: 10,
    preventDefault: () => prevented.push(true),
  }

  setMode(document, 'desktop')
  document.dispatchEvent(event)
  assert.equal(prevented.length, 1, 'desktop mode must suppress the native menu')

  setMode(document, 'vanilla')
  document.dispatchEvent(event)
  assert.equal(
    prevented.length,
    1,
    '原版 must leave the native menu alone — suppressing it is itself a modification',
  )
})

// ── a menu does not close when the pointer leaves it ─────────────────────────

/**
 * A menu, portalled to `body` exactly as the app renders one.
 *
 * `role="menu"` is the whole identification: it is what the app's own component
 * sets and what `dom.js` keys on, rather than a build-specific CSS-module hash.
 *
 * @param className - the class, for identification in assertions.
 * @param items - how many `[role="menuitem"]` children to give it.
 * @returns the menu element.
 */
function menu(className, items = 2) {
  const node = new FakeElement('div', className)
  node.setAttribute('role', 'menu')
  for (let i = 0; i < items; i += 1) {
    const item = new FakeElement('button', '_item_abc')
    item.setAttribute('role', 'menuitem')
    node.append(item)
  }
  return node
}

/**
 * Build a `pointerout` as the browser reports it during a real move.
 *
 * The two fields the guard reads are `target` (the element being left) and
 * `relatedTarget` (where the pointer is going), so both are explicit here. The
 * event carries `stopPropagation`, which is how the guard withholds the event
 * from the app's own handler.
 *
 * @param target - the element the pointer leaves.
 * @param relatedTarget - where it is going, or null when it left the window.
 * @returns the event plus a record of whether propagation was stopped.
 */
function pointerOut(target, relatedTarget) {
  const record = { stopped: false }
  return {
    record,
    event: {
      type: 'pointerout',
      target,
      relatedTarget,
      stopPropagation: () => {
        record.stopped = true
      },
    },
  }
}

test('leaving an open menu does NOT close it, which is the reported bug', () => {
  const { document } = createPage()
  runOverlay(document)

  // A menu as the app renders one: portalled to <body>, which is outside the
  // `#root` React listens on — the detail that makes a document-capture guard
  // able to pre-empt the app's handler.
  const open = menu('_list_1nxmc_8 _portal_1nxmc_44')
  document.body.append(open)
  const item = open.children[0]

  setMode(document, 'desktop')

  // Pointer leaves the menu for the page behind it. The app would close the menu
  // on this; the overlay must withhold it.
  const leavingMenu = pointerOut(item, document.body)
  document.dispatchEvent(leavingMenu.event)
  assert.equal(
    leavingMenu.record.stopped,
    true,
    'a leave aimed outside the menu must be withheld, or the menu closes itself',
  )

  // Pointer leaves the WINDOW entirely — `relatedTarget` is null. The app treats
  // that as a leave too, and so must the guard, or the menu closes on the way to
  // another application.
  const leavingWindow = pointerOut(item, null)
  document.dispatchEvent(leavingWindow.event)
  assert.equal(
    leavingWindow.record.stopped,
    true,
    'a leave with no related target must be withheld as well',
  )
})

test('a move WITHIN the menu is left alone, so hover behaviour is untouched', () => {
  const { document } = createPage()
  runOverlay(document)

  const open = menu('_list_1nxmc_8 _portal_1nxmc_44')
  document.body.append(open)
  const first = open.children[0]
  const second = open.children[1]
  setMode(document, 'desktop')

  // Moving from one item to the next never leaves the menu, so nothing is being
  // dismissed and the event must reach the app untouched. Suppressing this would
  // be the over-reach that breaks intra-menu hover states.
  const inside = pointerOut(first, second)
  document.dispatchEvent(inside.event)
  assert.equal(
    inside.record.stopped,
    false,
    'a move between two items of the same menu is not a leave',
  )

  // And the same for a move into the menu's own padding rather than onto an item.
  const toSelf = pointerOut(first, open)
  document.dispatchEvent(toSelf.event)
  assert.equal(toSelf.record.stopped, false, 'moving onto the menu itself is not a leave')
})

test('a submenu counts as part of its parent menu, not as leaving it', () => {
  const { document } = createPage()
  runOverlay(document)

  // A submenu is a `[role="menu"]` in its own right, nested inside the parent's
  // item wrapper. Moving onto it must not be read as leaving the parent, or a
  // menu with a submenu would close the moment the user reached for the submenu.
  const parent = menu('_list_1nxmc_8 _portal_1nxmc_44')
  const wrapper = parent.children[0]
  const submenu = menu('_submenu_1nxmc_9', 1)
  wrapper.append(submenu)
  document.body.append(parent)
  setMode(document, 'desktop')

  const intoSubmenu = pointerOut(parent.children[0], submenu)
  document.dispatchEvent(intoSubmenu.event)
  assert.equal(
    intoSubmenu.record.stopped,
    false,
    'a nested menu is inside the menu, so reaching for it is not a leave',
  )

  // But leaving the whole structure — parent and submenu both — still is one.
  const outOfBoth = pointerOut(submenu.children[0], document.body)
  document.dispatchEvent(outOfBoth.event)
  assert.equal(
    outOfBoth.record.stopped,
    true,
    'leaving the submenu for the page is a leave of the menu it belongs to',
  )
})

test('pointer movement outside any menu is never touched', () => {
  const { document } = createPage()
  runOverlay(document)

  const row = new FakeElement('div', '_projectRow_abc')
  document.body.append(row)
  setMode(document, 'desktop')

  // The overwhelming majority of pointer movement in the app is between elements
  // that have nothing to do with a menu. The guard must cost nothing there and,
  // more importantly, must not disturb any of it.
  const unrelated = pointerOut(row, document.body)
  document.dispatchEvent(unrelated.event)
  assert.equal(unrelated.record.stopped, false, 'ordinary pointer movement must pass through')

  // And a menu-less hover card, tooltip, or dialog is likewise untouched.
  const card = new FakeElement('div', '_card_1b2ny_13')
  document.body.append(card)
  const onCard = pointerOut(card, row)
  document.dispatchEvent(onCard.event)
  assert.equal(onCard.record.stopped, false, 'a non-menu surface must not be affected')
})

test('the leave guard stands down in 原版, like the right-click takeover', () => {
  const { document } = createPage()
  runOverlay(document)

  const open = menu('_list_1nxmc_8 _portal_1nxmc_44')
  document.body.append(open)

  // 原版 is the frontend with none of this project's modifications, and how a menu
  // is dismissed is frontend behaviour. The listener stays installed and returns,
  // so switching back needs no re-binding.
  setMode(document, 'vanilla')
  const inVanilla = pointerOut(open.children[0], document.body)
  document.dispatchEvent(inVanilla.event)
  assert.equal(
    inVanilla.record.stopped,
    false,
    '原版 must keep the app’s own menu dismissal',
  )

  // And it resumes the moment the desktop styles come back.
  setMode(document, 'desktop')
  const back = pointerOut(open.children[0], document.body)
  document.dispatchEvent(back.event)
  assert.equal(back.record.stopped, true, 'switching back must restore the guard')
})

test('a related target that is not a Node does not throw in the capture listener', () => {
  const { document } = createPage()
  runOverlay(document)

  const open = menu('_list_1nxmc_8 _portal_1nxmc_44')
  document.body.append(open)
  setMode(document, 'desktop')

  // `relatedTarget` is typed as a bare EventTarget and can be a Window, or a node
  // React has already detached. `Node.contains` THROWS on a non-Node argument, and
  // a throw inside this capture listener would break the app's own pointer
  // handling rather than merely misjudging one move — so the shape is tested, and
  // a non-Node is treated as "outside the menu".
  const windowTarget = pointerOut(open.children[0], { nodeType: undefined })
  document.dispatchEvent(windowTarget.event)
  assert.equal(
    windowTarget.record.stopped,
    true,
    'a non-Node related target must be judged, not thrown on',
  )

  // A null related target keeps working, which is the pointer-leaves-the-window
  // shape and the one that reaches this branch most often.
  const nullTarget = pointerOut(open.children[0], null)
  document.dispatchEvent(nullTarget.event)
  assert.equal(nullTarget.record.stopped, true, 'a null related target must still be handled')
})

test('the leave guard is installed exactly once, alongside the right-click binding', () => {
  const dom = readFileSync(join(here, 'ui-overlay', 'dom.js'), 'utf8')

  // Two live listeners would each call stopPropagation on the same event, which is
  // harmless — but the shared flag is what the right-click takeover depends on, and
  // a second evaluation is a real event (an injected row reloaded, a dev reload).
  // So the install guard must cover both listeners.
  const install = dom.slice(dom.indexOf('function installContextMenu'), dom.indexOf('function installModeListener'))
  assert.ok(
    install.includes("addEventListener('pointerout'"),
    'the leave guard must be installed by installContextMenu',
  )
  assert.ok(
    install.indexOf('__dshDesktopContextMenu') < install.indexOf("addEventListener('pointerout'"),
    'the once-guard must precede the leave guard, or a second evaluation double-binds it',
  )

  // Capture phase, which is what puts it ahead of the app's own handler: React
  // attaches its listeners to the container it renders into, and a capture
  // listener on `document` always runs first.
  assert.ok(
    /addEventListener\('pointerout',\s*onPointerOut,\s*true\)/.test(dom),
    'the leave guard must be capture-phase on document, or it cannot pre-empt React',
  )
})

test('the leave guard only ever stops propagation, never prevents the default', () => {
  const dom = readFileSync(join(here, 'ui-overlay', 'dom.js'), 'utf8')
  const guard = dom.slice(dom.indexOf('function keepsMenuOpen'), dom.indexOf('function installContextMenu'))

  // `preventDefault` on a pointer event would interfere with focus and with the
  // app's own pointer handling far beyond dismissing a menu. Withholding the event
  // from the app is the whole mechanism, so that is all it may do.
  assert.ok(
    guard.includes('stopPropagation'),
    'the guard must withhold the leave by stopping propagation',
  )
  assert.ok(
    !guard.includes('preventDefault'),
    'the guard must not preventDefault: it is withholding an event, not cancelling an action',
  )

  // And it must be gated on the mode, like every other behaviour this tier adds.
  assert.ok(guard.includes('isVanilla()'), 'the guard must stand down in 原版')
})

// ── the frame anchor, executed ───────────────────────────────────────────────

test('the frame is tagged as chrome so the bar keeps its space', () => {
  const { document, frame, overlayLayer } = createPage()
  runOverlay(document)

  // THE REGRESSION THIS GUARDS. The stylesheet originally found the frame by
  // `[data-rightbar-collapsed]`, which the app writes as
  // `cols.rightbar === 0 || void 0` — and React omits an attribute whose value is
  // `void 0`, so it exists only while the panel is COLLAPSED. Opening the panel
  // dropped the frame's padding and slid every column up under the opaque bar.
  //
  // This page models the EXPANDED state: no `data-rightbar-collapsed` anywhere.
  assert.equal(
    document.querySelector('[data-rightbar-collapsed]'),
    null,
    'the fixture must model the expanded panel, where that attribute is absent',
  )

  // The frame tag is now only a FALLBACK: the bar's space is reserved by the
  // container rule on #root, which needs no JavaScript. The tag remains for a page
  // where #root is not the mount point.
  assert.equal(
    frame.getAttribute('data-dsh-chrome'),
    'frame',
    'the frame must be tagged even with the right panel open',
  )

  // The tag must land on the frame (the overlay layer\'s PARENT), not on the
  // layer itself: the offset has to go on the frame, because the layer is
  // `position: absolute; inset: 0` and must keep covering the bar\'s strip.
  assert.equal(
    overlayLayer.getAttribute('data-dsh-chrome'),
    null,
    'the tag belongs on the frame, not the overlay layer',
  )
  assert.equal(
    overlayLayer.parentElement.getAttribute('data-dsh-chrome'),
    'frame',
    'the tag must be on the overlay layer\'s parent',
  )
})

test('the frame tag SURVIVES 原版, because it is layout and not appearance', () => {
  const { document, frame } = createPage()
  runOverlay(document)
  assert.equal(frame.getAttribute('data-dsh-chrome'), 'frame')

  setMode(document, 'vanilla')

  // 原版 removes this project's APPEARANCE. It does not remove the window's title
  // bar — the window is `decorations(false)`, so the bar is there in both modes and
  // the app under it must stay clear of it. A `data-dsh-desktop` tag would have been
  // stripped here, which is exactly the bug this split fixes.
  assert.equal(
    frame.getAttribute('data-dsh-chrome'),
    'frame',
    '原版 must keep the layout tag, or content slides back under the bar',
  )
  assert.equal(
    frame.getAttribute('data-dsh-desktop'),
    null,
    'but the appearance tag must still be withdrawn',
  )

  setMode(document, 'desktop')
  assert.equal(frame.getAttribute('data-dsh-chrome'), 'frame')
})

// ── full-surface layers are pushed below the bar ─────────────────────────────

/**
 * Build a fixed layer with the given computed inset, as the app writes it.
 *
 * `role` is set because the fast candidate scan keys on it — every full-screen
 * layer in this app declares one (`role="presentation"` on the settings and modal
 * roots, `role="dialog"` on the lightbox backdrop), and the accessibility
 * contract is what makes that stable across builds.
 *
 * @param className - the element's class, for identification in assertions.
 * @param inset - space-separated top/right/bottom/left, as computed style reports.
 * @param role - the ARIA role the layer declares, if any.
 * @returns the element.
 */
function layer(className, inset, role) {
  const node = new FakeElement('div', className)
  node.setAttribute('data-position', 'fixed')
  node.setAttribute('data-inset', inset)
  if (role) node.setAttribute('role', role)
  return node
}

/**
 * The overlay tag that lifts a full-surface dialog clear of the title bar.
 *
 * The bar is chrome and stays above every dialog, so a dialog that centres its
 * content in the FULL viewport loses its header — including its own close button —
 * under the bar. The DOM tier tags the layer and the stylesheet moves its top edge
 * down; this is the executable half of that pair.
 */
test('a full-surface layer is tagged, wherever it lives in the document', () => {
  const { document, frame } = createPage()
  runOverlay(document)

  // THE REGRESSION THIS EXISTS FOR. The first version of this scan looked only at
  // `document.body.children`, on the assumption that the app portals its dialogs
  // to <body>. It portals some there, but the SETTINGS overlay — the one users
  // open most — is rendered deep inside `#root`. It was therefore never tagged,
  // and its header and close button sat under the bar (measured live: hidden by
  // 20px). So the layer is placed deliberately inside the frame here.
  const nested = layer('VOzbGW_overlay', '0', 'presentation')
  frame.append(nested)

  // And a body-portalled one, which the old scan did catch.
  const portalled = layer('_root_w1urq_2', '0', 'presentation')
  document.body.append(portalled)

  setMode(document, 'desktop')

  assert.equal(
    nested.getAttribute('data-dsh-chrome'),
    'layer',
    'a full-surface layer INSIDE #root must be tagged, not only body children',
  )
  assert.equal(
    portalled.getAttribute('data-dsh-chrome'),
    'layer',
    'a body-portalled full-surface layer must still be tagged',
  )
})

test('the bar and the coordinate-positioned popups are never tagged', () => {
  const { document } = createPage()
  runOverlay(document)

  // The bar is `inset: 0 0 auto 0`, so its computed bottom is `auto`. That is what
  // keeps it out of the set — no name-based exclusion is needed, which matters
  // because the bar's class is this project's own and could be renamed.
  const bar = layer('dshTb', '0 auto')
  document.body.append(bar)

  // A menu, a tooltip and the dock float are all positioned in JavaScript from
  // `getBoundingClientRect()`, i.e. REAL viewport coordinates. Shifting one would
  // move it 44px away from the trigger it is anchored to.
  const menu = layer('_list_1nxmc_8', '138 264 574 798')
  const tooltip = layer('_bubble_1nw3t_1', '120 auto auto 340')
  document.body.append(menu)
  document.body.append(tooltip)

  setMode(document, 'desktop')

  assert.equal(bar.getAttribute('data-dsh-chrome'), null, 'the bar must not push itself down')
  assert.equal(menu.getAttribute('data-dsh-chrome'), null, 'an anchored menu must not be moved')
  assert.equal(tooltip.getAttribute('data-dsh-chrome'), null, 'nor a tooltip')
})

test('settings is animated when CSS already reserves the title bar inset', () => {
  const { document } = createPage()
  const sandbox = runOverlay(document)
  const settings = layer('settings_overlay', '44px 0 0 0', 'presentation')
  document.body.append(settings)
  sandbox.deliverRemoval([])
  assert.equal(settings.getAttribute('data-dsh-chrome'), 'layer')
  const root = layer('appRoot', '44px 0 0 0')
  document.body.append(root)
  runOverlay(document)
  assert.equal(root.getAttribute('data-dsh-chrome'), null, 'the offset app container is not a dialog layer')
})

test('a second mutation batch tags a feedback dialog before the pending frame', () => {
  const { document } = createPage()
  const sandbox = runOverlay(document)
  // Schedule appearance work first, as a button's pending state would do.
  sandbox.deliverRemoval([])
  const feedback = layer('feedback_root', '0', 'presentation')
  document.body.append(feedback)
  // No animation frame has run between these separate mutation batches.
  sandbox.deliverRemoval([])
  assert.equal(feedback.getAttribute('data-dsh-chrome'), 'layer')
})

test('the layer tag SURVIVES 原版, which is the reported bug', () => {
  const { document } = createPage()
  runOverlay(document)

  const nested = layer('VOzbGW_overlay', '0', 'presentation')
  document.body.append(nested)

  setMode(document, 'desktop')
  assert.equal(nested.getAttribute('data-dsh-chrome'), 'layer')

  setMode(document, 'vanilla')

  // THE BUG. The tag used to be `data-dsh-desktop='dialog'`, and 原版 exists to strip
  // that family — so the moment a user switched to 原版, the settings panel's header
  // went back under the bar (measured live: panelTop 24 in 原版 against 46 in the
  // desktop mode). The bar is the WINDOW's chrome and exists in both modes, so the
  // layout tag must outlive the appearance cleanup.
  assert.equal(
    nested.getAttribute('data-dsh-chrome'),
    'layer',
    '原版 must keep the layer tag, or dialogs slide back under the bar',
  )
  assert.equal(
    nested.getAttribute('data-dsh-desktop'),
    null,
    'while the appearance family is still withdrawn',
  )

  setMode(document, 'desktop')
  assert.equal(nested.getAttribute('data-dsh-chrome'), 'layer')
})

test('the appearance tags are still withdrawn in 原版', () => {
  const { document, frame } = createPage()
  runOverlay(document)

  // The composer and the relocated rows are APPEARANCE: they must go. Only the
  // chrome family survives, and this asserts the split is real rather than a
  // wholesale "stop cleaning up".
  const composer = frame.querySelector('[class*="_card"]')
  assert.equal(composer.getAttribute('data-dsh-desktop'), 'composer')

  const relocated = new FakeElement('div', '_row_abc')
  relocated.setAttribute('data-dsh-relocated', 'true')
  document.body.append(relocated)

  setMode(document, 'vanilla')

  assert.equal(
    composer.getAttribute('data-dsh-desktop'),
    null,
    'the composer tag is appearance and must be withdrawn',
  )
  assert.equal(
    relocated.getAttribute('data-dsh-relocated'),
    null,
    'so must the relocated-row tag',
  )
  assert.equal(
    frame.getAttribute('data-dsh-chrome'),
    'frame',
    'but the layout tag stays',
  )
})

test('the mutation pass uses the cheap candidate set and the sweep is the backstop', () => {
  const dom = readFileSync(join(here, 'ui-overlay', 'dom.js'), 'utf8')

  // Cost is the reason for the split: a computed-style sweep of the whole document
  // measured ~1-2.4ms over ~740 nodes, which is affordable twice a second but not
  // on every mutation frame while the agent streams.
  assert.ok(
    /markFullSurfaceLayers\(true\)/.test(dom),
    'the periodic pass must sweep, so a role-less layer is still caught',
  )
  assert.ok(
    /markFullSurfaceLayers\(false\)/.test(dom),
    'the mutation pass must use the candidate set',
  )

  // The candidate set must be a role list, not a class list: roles are part of the
  // accessibility contract, while every CSS-module hash changes per build.
  const candidates = /var LAYER_CANDIDATES = '([^']+)'/.exec(dom)
  assert.ok(candidates, 'the candidate selector must be a named constant')
  assert.ok(
    candidates[1].includes('[role=') || candidates[1].includes('[aria-modal='),
    'the candidate set must be keyed on roles, not build-specific classes',
  )
  assert.ok(
    !/_([a-z0-9]{5})_/.test(candidates[1]),
    'the candidate set must not contain a CSS-module hash',
  )
})

test('a role-less full-surface layer is still caught, by the sweep', () => {
  const { document } = createPage()
  runOverlay(document)

  // The candidate scan keys on ARIA roles, so a future layer that declares none
  // would be invisible to it. The periodic pass sweeps every element instead, and
  // `runOverlay` evaluates the script — whose first pass IS a sweep — so a layer
  // present before the script runs must be caught even with no role at all.
  const anonymous = layer('_futureOverlay_abc123', '0')
  document.body.append(anonymous)

  // Re-running makes the first (sweeping) pass see it, which is exactly what
  // happens on any page load where the layer already exists.
  runOverlay(document)

  assert.equal(
    anonymous.getAttribute('data-dsh-chrome'),
    'layer',
    'the sweep must catch a full-surface layer that declares no role',
  )
})

// ── the tag is retired when a layer stops being full-surface ────────────────

test('the right panel retires its layer tag when it docks back from fullscreen', () => {
  const { document, frame } = createPage()
  runOverlay(document)

  // The right sidebar's panel in its FULLSCREEN shape — one element, fixed,
  // inset 0 — modelled the way the app writes it (`dsh-client-ui-sidebar-right`:
  // `data-sidebar-right-panel` flips between "fullscreen" and "push" on the SAME
  // node; only the position/inset change underneath it).
  const panel = new FakeElement('div', 'P3OORG_panel')
  panel.setAttribute('data-sidebar-right-panel', 'fullscreen')
  panel.setAttribute('data-position', 'fixed')
  panel.setAttribute('data-inset', '0')
  frame.append(panel)

  // A later pass sees the fullscreen shape and tags it — the sweep's job, since
  // the panel declares no ARIA role for the cheap candidate scan.
  runOverlay(document)
  assert.equal(
    panel.getAttribute('data-dsh-chrome'),
    'layer',
    'the fullscreen panel must be tagged, like any full-surface layer',
  )

  // Dock back: the app flips the attribute and the panel returns to
  // `position: absolute; top: 0` inside its column — which the container rule has
  // already placed below the bar. THIS IS THE REGRESSION. A write-once tag kept
  // the 44px offset on the docked panel, so it started 44px below its column's
  // top edge — a gap the app never drew, for as long as the page stayed loaded.
  panel.setAttribute('data-sidebar-right-panel', 'push')
  panel.setAttribute('data-position', 'absolute')
  panel.setAttribute('data-inset', '0 0')

  runOverlay(document)

  assert.equal(
    panel.getAttribute('data-dsh-chrome'),
    null,
    'a layer that stopped being full-surface must retire its tag',
  )
  assert.equal(
    frame.getAttribute('data-dsh-chrome'),
    'frame',
    'and the frame must be untouched: retirement keys on the layer value only',
  )
})

test('retirement does not churn a tag that still describes its layer', () => {
  const { document, frame } = createPage()

  // A permanently full-surface layer, like the settings overlay: it exists only
  // while open and is `position: fixed; inset: 0` for that whole time.
  const settings = layer('VOzbGW_overlay', '0', 'presentation')
  frame.append(settings)

  runOverlay(document)
  assert.equal(settings.getAttribute('data-dsh-chrome'), 'layer')

  // The steady state re-runs the pass every WATCH_MS; three more passes must not
  // withdraw a tag that is still true, or the offset would flicker off and on.
  runOverlay(document)
  runOverlay(document)
  runOverlay(document)

  assert.equal(
    settings.getAttribute('data-dsh-chrome'),
    'layer',
    'a still-matching layer must keep its tag across passes',
  )
})

test('the offset shape does not un-tag the layer it came from', () => {
  const { document } = createPage()
  const sandbox = runOverlay(document)

  // The settings overlay: fixed, inset 0, and — once tagged — top 44px, because
  // the stylesheet's own offset rule is what the tag drives. The stub models
  // that link, so the shape the retirement asks about here is the shape a real
  // engine reports while the tag is on.
  const settings = layer('VOzbGW_overlay', '0', 'presentation')
  document.body.append(settings)
  setMode(document, 'desktop')

  assert.equal(settings.getAttribute('data-dsh-chrome'), 'layer')

  // THE REPORTED BUG, IN MINIATURE. The retirement used to re-ask the UNOFFSET
  // question — top must be 0px — of a layer whose tag had just moved that top
  // to 44px. The answer was always "no", so every pass stripped every tag it
  // had written: no layer was ever offset, and every dialog centred in the full
  // viewport with its header against the bar. Measured live before the fix:
  // tag written and gone within one pass, computed top back to 0px.
  sandbox.deliverMutation()

  assert.equal(
    settings.getAttribute('data-dsh-chrome'),
    'layer',
    'a tagged layer at top 44px is still the same full-surface layer',
  )
})

// ── a surface that closes fades out instead of vanishing ────────────────────

test('a closing menu is replayed as a fading ghost where it was portalled', () => {
  const { document } = createPage()
  const sandbox = runOverlay(document)
  setMode(document, 'desktop')

  const list = menu('_list_abc123')
  document.body.append(list)

  // React's unmount: the node leaves the document, and the observer receives
  // the removal record with the parent it left and the sibling that followed.
  document.body.removeChild(list)
  sandbox.deliverRemoval([{ removedNodes: [list], target: document.body, nextSibling: null }])

  assert.equal(list.parentElement, null, 'the original stays unmounted')
  const ghosts = document.querySelectorAll("[data-dsh-ghost='menu']")
  assert.equal(ghosts.length, 1, 'exactly one ghost is replayed')
  const ghost = ghosts[0]
  assert.equal(ghost.parentElement, document.body, 'the ghost returns to where the menu lived')
  assert.notEqual(ghost, list, 'the ghost is a CLONE — React has unmounted the original')
  assert.equal(ghost.getAttribute('role'), 'menu', 'the ghost carries the menu role, so the fade styles apply')
  assert.equal(
    ghost.querySelectorAll('[role="menuitem"]').length,
    2,
    'and the whole list fades with it, items included',
  )
})

test('a closing dialog layer is ghosted and a non-layer candidate is not', () => {
  const { document } = createPage()
  const sandbox = runOverlay(document)
  setMode(document, 'desktop')

  // The settings overlay shape: role=presentation, fixed, inset 0, a dialog
  // panel inside. Tagged by the pass, so the clone carries the offset tag too.
  const overlayEl = new FakeElement('div', 'VOzbGW_overlay')
  overlayEl.setAttribute('role', 'presentation')
  overlayEl.setAttribute('data-position', 'fixed')
  overlayEl.setAttribute('data-inset', '0')
  const panel = new FakeElement('div', 'VOzbGW_panel')
  panel.setAttribute('role', 'dialog')
  overlayEl.append(panel)
  document.body.append(overlayEl)

  // The same role on a node that is NOT a full-surface layer — a presentation
  // wrapper the app unmounts mid-page. Its removal must not be replayed.
  const wrapper = new FakeElement('div', 'someSection')
  wrapper.setAttribute('role', 'presentation')
  document.body.append(wrapper)

  sandbox.deliverMutation()
  assert.equal(overlayEl.getAttribute('data-dsh-chrome'), 'layer', 'the overlay was a layer while open')

  document.body.removeChild(overlayEl)
  document.body.removeChild(wrapper)
  sandbox.deliverRemoval([
    { removedNodes: [overlayEl], target: document.body, nextSibling: null },
    { removedNodes: [wrapper], target: document.body, nextSibling: null },
  ])

  const ghosts = document.querySelectorAll("[data-dsh-ghost='layer']")
  assert.equal(ghosts.length, 1, 'only the real layer is replayed')
  assert.equal(
    ghosts[0].querySelector('[role="dialog"]') === null,
    false,
    'the fading layer carries its panel',
  )
  assert.equal(
    document.querySelectorAll('[data-dsh-ghost]').length,
    1,
    'the presentation wrapper produced no ghost',
  )
})

test('a ghost retires when its fade ends', () => {
  const { document } = createPage()
  const sandbox = runOverlay(document)
  setMode(document, 'desktop')

  const list = menu('_list_abc123')
  document.body.append(list)
  document.body.removeChild(list)
  sandbox.deliverRemoval([{ removedNodes: [list], target: document.body, nextSibling: null }])

  const ghost = document.querySelector("[data-dsh-ghost='menu']")
  assert.notEqual(ghost, null)

  ghost.dispatch('animationend')
  assert.equal(
    document.querySelectorAll('[data-dsh-ghost]').length,
    0,
    'the ghost is removed once its fade has played',
  )
})

// ── a plugin card's body expands and collapses ──────────────────────────────

/**
 * Build the page shape a plugin card has, as `PluginCard.js` renders it.
 *
 *     ul.pbvGtq_cards
 *       li.YyYd_a_card[.YyYd_a_cardOpen]     the card, and its open state
 *         button.YyYd_a_header               the toggle, carrying aria-expanded
 *         div.YyYd_a_body                    ONLY while open (React unmounts it)
 *
 * The body's conditional mounting is the whole reason this feature needs the DOM
 * tier: the OPEN direction is a mount, which CSS can animate on its own, but the
 * CLOSE direction is an unmount, which CSS cannot touch at all.
 *
 * @returns the document stub plus the card parts.
 */
function createPluginCardPage() {
  const { document } = createPage()
  const list = new FakeElement('ul', 'pbvGtq_cards')
  const card = new FakeElement('li', 'YyYd_a_card')
  const header = new FakeElement('button', 'YyYd_a_header')
  header.setAttribute('aria-expanded', 'false')
  card.append(header)
  list.append(card)
  document.body.append(list)
  return { document, list, card, header }
}

test('a card body is tagged while its card is open, and untagged when it closes', () => {
  const { document, card } = createPluginCardPage()
  const sandbox = runOverlay(document)
  setMode(document, 'desktop')

  // CLOSED: there is no body in the tree at all, so there is nothing to tag.
  sandbox.deliverMutation()
  assert.equal(
    document.querySelectorAll("[data-dsh-chrome='collapse-body']").length,
    0,
    'a closed card has no body to tag',
  )

  // OPEN: React writes `_cardOpen` on the card and mounts the body in one commit.
  card.className = 'YyYd_a_card YyYd_a_cardOpen'
  const body = new FakeElement('div', 'YyYd_a_body')
  card.append(body)
  sandbox.deliverMutation()

  assert.equal(
    body.getAttribute('data-dsh-chrome'),
    'collapse-body',
    'an open card’s body must be tagged, which is what the close ghost is keyed on',
  )

  // CLOSE: the tag is retired along with the state it describes, so it keeps
  // describing the surface's present shape rather than its history — the same
  // principle the layer tag follows. The periodic pass is what re-asks the
  // question on a surface React has not re-rendered.
  card.className = 'YyYd_a_card'
  sandbox.deliverPass()
  assert.equal(
    body.getAttribute('data-dsh-chrome'),
    null,
    'a body no longer inside an open card must lose the tag',
  )
})

test('a closing card body is replayed as a shrinking ghost', () => {
  const { document, card } = createPluginCardPage()
  const sandbox = runOverlay(document)
  setMode(document, 'desktop')

  card.className = 'YyYd_a_card YyYd_a_cardOpen'
  const body = new FakeElement('div', 'YyYd_a_body')
  card.append(body)
  sandbox.deliverMutation()
  assert.equal(body.getAttribute('data-dsh-chrome'), 'collapse-body', 'tagged while open')

  // React's unmount: the body leaves the document. Its geometry is gone by the
  // time the observer runs, which is exactly why the ghost kind is decided from
  // the ATTRIBUTE the overlay wrote while the node was still connected.
  card.removeChild(body)
  sandbox.deliverRemoval([{ removedNodes: [body], target: card, nextSibling: null }])

  const ghosts = document.querySelectorAll("[data-dsh-ghost='collapse']")
  assert.equal(ghosts.length, 1, 'exactly one collapse ghost is replayed')
  assert.equal(ghosts[0].parentElement, card, 'the ghost shrinks where the body lived')
  assert.notEqual(ghosts[0], body, 'the ghost is a clone; React owns none of it')

  // NOT a generic fade: a collapse body needs its own keyframes, because the exit
  // shrinks as well as dims. A `layer` ghost here would merely fade.
  assert.equal(
    document.querySelectorAll("[data-dsh-ghost='layer']").length,
    0,
    'an unroled div must not be replayed as a full-surface layer',
  )
  assert.equal(
    document.querySelectorAll("[data-dsh-ghost='menu']").length,
    0,
    'nor as a menu',
  )
})

test('an untagged div is never ghosted, so ordinary unmounts stay instant', () => {
  const { document } = createPluginCardPage()
  const sandbox = runOverlay(document)
  setMode(document, 'desktop')

  // The body-shaped div every app renders: no role, no tag. The collapse ghost is
  // keyed on a tag this overlay wrote, precisely so that a plain div removal — of
  // which there are many per second while the agent streams — is not replayed.
  const plain = new FakeElement('div', 'YyYd_a_body')
  document.body.append(plain)
  document.body.removeChild(plain)
  sandbox.deliverRemoval([{ removedNodes: [plain], target: document.body, nextSibling: null }])

  assert.equal(
    document.querySelectorAll('[data-dsh-ghost]').length,
    0,
    'an untagged div must not be replayed',
  )
})

test('a collapse ghost is not replayed in 原版 or with animation off', () => {
  for (const [mode, animation] of [
    ['vanilla', 'on'],
    ['desktop', 'off'],
  ]) {
    const { document, card } = createPluginCardPage()
    const sandbox = runOverlay(document)
    setMode(document, mode)
    setAttributeAnimation(document.documentElement, animation)

    card.className = 'YyYd_a_card YyYd_a_cardOpen'
    const body = new FakeElement('div', 'YyYd_a_body')
    card.append(body)
    sandbox.deliverMutation()
    card.removeChild(body)
    sandbox.deliverRemoval([{ removedNodes: [body], target: card, nextSibling: null }])

    assert.equal(
      document.querySelectorAll('[data-dsh-ghost]').length,
      0,
      `${mode}/${animation} must not replay a collapse`,
    )
  }
})

test('the collapse animation interpolates height, and clips for its whole run', () => {
  const css = readFileSync(join(here, 'ui-overlay', 'theme.css'), 'utf8')
  const dom = readFileSync(join(here, 'ui-overlay', 'dom.js'), 'utf8')

  // WHY `interpolate-size`. The body's height depends on which controls the card
  // holds, the font size chosen in 外观, and the wrapping of a description — so a
  // JavaScript-measured pixel height would be wrong the moment any of those
  // changed. `interpolate-size: allow-keywords` is what makes `0 -> auto` a real
  // interpolation instead, and it is supported from Chromium 129 (this window is
  // WebView2 153).
  //
  // ASSERTED AS A DECLARATION INSIDE A RULE, NOT AS A SUBSTRING OF THE FILE. The
  // property is also named twice in the prose that explains it, so a file-wide
  // `includes()` is satisfied by the comments alone — verified by deleting both
  // real declarations and watching the weaker assertion still pass. The slice runs
  // from the open rule's selector to its closing brace, which is where the
  // declaration has to be for the engine to see it.
  const openRuleAt = css.indexOf("body [class*='_cardOpen'] [class*='_body']:not([data-dsh-ghost])")
  assert.ok(openRuleAt > 0, 'the open animation must be keyed on the card’s open class')
  const openRule = css.slice(openRuleAt, css.indexOf('}', openRuleAt))
  assert.ok(
    /(^|[\s;{])interpolate-size:\s*allow-keywords\s*;/.test(openRule),
    'the collapse rule must DECLARE interpolate-size, or `block-size: auto` cannot animate',
  )

  // The open animation keys on the card's own open class, so a freshly mounted body
  // animates in its MOUNT frame rather than waiting for a pass.
  assert.ok(/animation:\s*dsh-desktop-collapse-open/.test(openRule), 'and must name its keyframes')

  // `overflow` is DISCRETE — it cannot interpolate — so it must be named in BOTH
  // frames. A `from`-only declaration flips at 50%, and the form spills out of a
  // half-height box for the second half of the expansion. This is the assertion
  // that catches that, and it is the bug the first draft of this rule had.
  //
  // The slice ends at the keyframes block's own closing brace, NOT at the next
  // `@keyframes` marker: there is a prose banner between the two, and it mentions
  // `overflow: hidden` while explaining this very rule — so a slice that swept it
  // in would count three occurrences and report a correct rule as broken.
  const openAt = css.indexOf('@keyframes dsh-desktop-collapse-open')
  assert.ok(openAt > 0, 'the open keyframes must exist')
  const openKeyframes = css.slice(openAt, css.indexOf('\n}\n', openAt))
  assert.equal(
    (openKeyframes.match(/overflow:\s*hidden/g) ?? []).length,
    2,
    'overflow must be declared in BOTH frames of the open animation, since it is discrete',
  )
  assert.ok(/block-size:\s*0/.test(openKeyframes), 'the expansion starts at zero height')
  assert.ok(
    /block-size:\s*auto/.test(openKeyframes),
    'and ends at auto, which is the pair interpolate-size makes animatable',
  )

  // The ghost's rule and keyframes, with the same discrete-property treatment.
  const ghostAt = css.indexOf("html body [data-dsh-ghost='collapse']")
  assert.ok(ghostAt > 0, 'the collapse ghost must have its own rule')
  assert.ok(
    /animation:\s*dsh-desktop-collapse-close/.test(css.slice(ghostAt, css.indexOf('}', ghostAt))),
    'and its own keyframes, since the exit shrinks rather than merely fading',
  )
  const closeKeyframes = css.slice(
    css.indexOf('@keyframes dsh-desktop-collapse-close'),
    css.indexOf('\n}\n', css.indexOf('@keyframes dsh-desktop-collapse-close')),
  )
  assert.ok(/block-size:\s*0/.test(closeKeyframes), 'the collapse must end at zero height')
  assert.ok(
    /overflow:\s*hidden/.test(closeKeyframes),
    'and must clip while it shrinks, or the form spills over the card below',
  )

  // The tag and its value must match on both sides: the DOM tier writes it, the
  // stylesheet's keyframes and the ghost recogniser read it. Asserted as the
  // CONSTANT DECLARATIONS rather than as bare substrings, so a rename that left a
  // stale mention in a comment cannot satisfy this.
  assert.ok(
    /var COLLAPSE_BODY = 'collapse-body'/.test(dom),
    'the DOM tier must name the collapse tag',
  )
  assert.ok(
    dom.includes('COLLAPSE_BODY') && dom.includes('COLLAPSE_ATTRIBUTE'),
    'and must use both the tag and its attribute',
  )
  assert.ok(
    /var GHOST_COLLAPSE = 'collapse'/.test(dom),
    'the ghost value must be a named constant, since the stylesheet keys on it',
  )

  // Gated both ways, like every other animation this overlay adds. Asserted on the
  // gate SELECTOR (up to its brace) rather than on a file-wide substring, so the
  // rule has to exist as a rule.
  for (const [gate, why] of [
    [
      "html:not([data-dsh-ui='vanilla']):not([data-dsh-desktop-animation='on']) body [class*='_cardOpen'] [class*='_body']",
      'under reduced motion unless animation is explicitly on',
    ],
    [
      "html:not([data-dsh-ui='vanilla'])[data-dsh-desktop-animation='off'] body [class*='_cardOpen'] [class*='_body']",
      'under an explicit animation off',
    ],
  ]) {
    const at = css.indexOf(gate)
    assert.ok(at > 0, `the collapse must stand down ${why}`)
    assert.ok(
      /animation:\s*none/.test(css.slice(at, css.indexOf('}', at))),
      `and the gate ${why} must actually disable the animation`,
    )
  }
})

test('no ghost is replayed when the frontend does not animate', () => {
  const { document } = createPage()
  const sandbox = runOverlay(document)

  function closeAList() {
    const list = menu('_list_abc123')
    document.body.append(list)
    document.body.removeChild(list)
    const before = document.body.children.length
    sandbox.deliverRemoval([{ removedNodes: [list], target: document.body, nextSibling: null }])
    return {
      ghosted: document.querySelectorAll('[data-dsh-ghost]').length,
      appended: document.body.children.length - before,
    }
  }

  // 原版 is the unmodified frontend: it does not animate, whatever the
  // animation preference says, so the removal is left alone entirely.
  setMode(document, 'vanilla')
  setAttributeAnimation(document.documentElement, 'on')
  assert.deepEqual(closeAList(), { ghosted: 0, appended: 0 }, '原版 must not replay a removal')

  // An explicit off is the user declining motion: same answer.
  setMode(document, 'desktop')
  setAttributeAnimation(document.documentElement, 'off')
  assert.deepEqual(closeAList(), { ghosted: 0, appended: 0 }, 'off must not replay a removal')

  // The system preference (the attribute absent) follows the OS; a page whose
  // engine reports no preference — as this stub does — animates.
  setAttributeAnimation(document.documentElement, null)
  assert.deepEqual(closeAList(), { ghosted: 1, appended: 1 }, 'system plays the fade when the OS allows it')
})

/** Write the animation preference the way the client plugin does. */
function setAttributeAnimation(root, value) {
  if (value === null) root.removeAttribute('data-dsh-desktop-animation')
  else root.setAttribute('data-dsh-desktop-animation', value)
}

// ── the CSS gate, evaluated ──────────────────────────────────────────────────

/**
 * Evaluate the stylesheet's frame-anchor logic against a DOM stub.
 *
 * This is the half no browser-free test can fully exercise — real selector
 * matching needs a real engine. What it CAN do is prove the two anchors agree
 * about which node is the frame, which is the property the fix rests on: the
 * `:has()` rule and the tag rule must select the same element, or one of them is
 * reserving space on the wrong node.
 *
 * `:has(> child)` is implemented for exactly this: "the element that has a direct
 * child matching X".
 */
test('both frame anchors resolve to the same node', () => {
  const { document, frame } = createPage()

  // The `:has(> [data-shell-overlay])` rule, evaluated.
  const viaHas = [document.body, ...flatten(document.body)].find((node) =>
    node.children.some((child) => child.hasAttribute('data-shell-overlay')),
  )
  assert.equal(viaHas, frame, ':has() must resolve to the frame')

  // The tag rule's target, once the DOM tier has run.
  runOverlay(document)
  const viaTag = document.querySelector("[data-dsh-chrome='frame']")
  assert.equal(viaTag, frame, 'the tag rule must resolve to the same frame')

  // And both must be the grid container the app actually lays out, identified by
  // carrying the columns — not, say, the overlay layer or a column.
  assert.ok(
    frame.querySelector('[data-rightbar-col]'),
    'the frame must be the element containing the rightbar column',
  )
  assert.ok(
    frame.querySelector('[class*="_centerCol"]'),
    'and the centre column, whose content was disappearing',
  )
})

/**
 * The specificities the gate has to preserve, checked by execution rather than
 * by reading the file: the overlay is injected in <head> but the app injects its
 * palette later, so an equal-specificity rule silently loses.
 */
test('the gate leaves section 9 matching while section 1 stops', () => {
  const css = readFileSync(join(here, 'ui-overlay', 'theme.css'), 'utf8')

  // The gate text itself must appear, and it must be a `:not()` on the
  // attribute — a rule keyed on the attribute being PRESENT would invert the
  // meaning and apply the overlay only in 原版.
  assert.ok(css.includes("html:not([data-dsh-ui='vanilla'])"))
  assert.ok(
    !/^\s*html\[data-dsh-ui='vanilla'\]/m.test(css),
    'the gate must be a :not(), so an absent attribute means desktop',
  )

  // Section 9's own bar rules carry no gate.
  const barStart = css.indexOf('9. desktop title bar')
  const after = css.slice(barStart)
  assert.ok(after.includes('.dshTb {'), 'the bar must still be styled in 原版')

  // The container and the layer offset are likewise ungated: they are the window's
  // layout, not its appearance, so 原版 keeps them. This is asserted structurally by
  // requiring the rules to contain no mode gate at all.
  assert.ok(
    after.includes('html body #root {'),
    'the container must exist in section 9, where nothing is gated',
  )
  const containerAt = after.indexOf('html body #root {')
  const containerRule = after.slice(containerAt, after.indexOf('}', containerAt))
  assert.ok(
    !containerRule.includes('data-dsh-ui'),
    'the container must not be gated on the UI mode, or 原版 loses the bar offset',
  )
})

// ── 在资源管理器打开: the sidebar half, executed ──────────────────────────────

/**
 * Build a page shaped like the sidebar's real row tree, with React-like fiber
 * handles attached so the path lookup can be exercised.
 *
 * The structure mirrors the live app exactly, which is what makes the walk's
 * correctness testable at all:
 *
 *     div[class*="_list"]                       ONE list holding EVERY section
 *       div[class*="groupSection"]              one per workspace
 *         div[class*="_projectRow"]             that workspace's row
 *         div[class*="_sessionRow"] …           its sessions
 *       div[class*="groupSection"]              the ungrouped bucket (last)
 *         div[class*="_projectRow"]             no path
 *         div[class*="_sessionRow"] …           sessions with no workspace
 *
 * The shared `list` container is deliberately part of the fixture: it is the node
 * that made an earlier version of the walk return a NEIGHBOUR's directory, so a
 * stub without it would pass while the real page failed.
 *
 * @param options - `markOpen` names the row to mark as having its menu open.
 * @returns the document stub plus the rows.
 */
function createSidebarPage(options = {}) {
  const document = createDocument()

  const list = new FakeElement('div', 'bhn1Oq_list')
  document.body.append(list)

  /**
   * Give a node a React-fiber-shaped handle whose chain carries the row's group.
   *
   * `dom.js` walks `.return` looking for props it can read: the directory lookup
   * wants an object prop with an absolute `cwd`, and the ungrouped-bucket lookup
   * wants a group whose `workspaceId` is absent. Modelling both as the app does —
   * the derived group object nested under a `group` prop on the row, shaped as
   * `deriveGroups` builds it — keeps the tests honest about which shape is
   * expected. A session row carries NO group of its own, which is the app's shape
   * and the reason the directory walk exists.
   *
   * @param node - the element.
   * @param group - the derived group the row was rendered from, or undefined.
   */
  function attachFiber(node, group) {
    const fiber = { memoizedProps: group === undefined ? {} : { group }, return: null }
    // ENUMERABLE, as React writes it: the lookup finds the handle by scanning the
    // node's own keys, so a non-enumerable property here would make the stub pass
    // a path the real page never takes.
    node['__reactFiber$test'] = fiber
  }

  const sections = []

  /** One workspace section: a project row plus its session rows. */
  function addSection(workspaceCwd, sessionCount) {
    const section = new FakeElement('div', 'bhn1Oq_groupSection')
    list.append(section)

    const project = new FakeElement('div', 'YDXeBa_projectRow')
    project.setAttribute('role', 'treeitem')
    // The group shape `deriveGroups` hands the row component: a real workspace
    // carries the host's id and directory; the ungrouped bucket is built with an
    // empty key and neither — which is exactly how `rowIsUngrouped` tells the two
    // apart, and why both fields are modelled rather than `cwd` alone.
    attachFiber(
      project,
      workspaceCwd === undefined
        ? { key: '', workspaceId: undefined, cwd: undefined, label: '', sessions: [] }
        : {
            key: workspaceCwd,
            workspaceId: workspaceCwd,
            cwd: workspaceCwd,
            label: workspaceCwd,
            sessions: [],
          },
    )
    section.append(project)

    const sessions = []
    for (let i = 0; i < sessionCount; i += 1) {
      const session = new FakeElement('div', 'YDXeBa_sessionRow')
      session.setAttribute('role', 'treeitem')
      // A session row carries NO cwd of its own — that is the app's shape, and the
      // reason the walk exists.
      attachFiber(session, undefined)
      section.append(session)
      sessions.push(session)
    }

    sections.push({ section, project, sessions })
    return { section, project, sessions }
  }

  const workspace = addSection('D:\\projects\\alpha', 2)
  const ungrouped = addSection(undefined, 2)

  if (options.markOpen) {
    // Which ROW has its menu open decides which shape is injected: the workspace
    // row keeps the direct action, a session row gets the submenu.
    const target =
      options.markOpen === 'ungroupedSession'
        ? ungrouped.sessions[0]
        : options.markOpen === 'workspaceRow'
          ? workspace.project
          : workspace.sessions[0]
    // `className` directly, not `setAttribute('class', …)`: this stub keeps the
    // class list as a property (which is what the selector matcher reads) while the
    // attribute map is a separate store, so going through the attribute would set a
    // marker nothing could see.
    target.className = target.className + ' YDXeBa_menuOpen'
  }

  return { document, list, workspace, ungrouped }
}

/**
 * Build the open menu the injection targets, shaped as the app renders one.
 *
 * A real menu is `<div role="menu"><div class*="viewport">…items…</div></div>`, and
 * each item is a wrapper `div[class*="itemWrap"]` holding a
 * `button[role="menuitem"]` with an icon span and a label span. The classes are what
 * the injection CLONES for the new row, so the fixture carries them.
 *
 * @param document - the document stub.
 * @param labels - the app's own item labels, in order.
 * @returns the menu element.
 */
function createOpenMenu(document, labels) {
  const menu = new FakeElement('div', '_list_1nxmc_8 _portal_1nxmc_44')
  menu.setAttribute('role', 'menu')
  const viewport = new FakeElement('div', '_viewport_1nxmc_22')
  menu.append(viewport)

  for (const label of labels) {
    const wrap = new FakeElement('div', '_itemWrap_1nxmc_92')
    const button = new FakeElement('button', '_item_1nxmc_92')
    button.setAttribute('role', 'menuitem')
    const icon = new FakeElement('span', '_itemIcon_1nxmc_144')
    const text = new FakeElement('span', '_itemLabel_1nxmc_174')
    text.textContent = label
    button.append(icon)
    button.append(text)
    wrap.append(button)
    viewport.append(wrap)
  }

  document.body.append(menu)
  return { menu, viewport }
}

test('a WORKSPACE menu gets the DIRECT action, last and below a divider', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceRow' })
  const { viewport } = createOpenMenu(document, ['重命名', '删除工作区'])

  const sandbox = runOverlay(document)
  await sandbox.deliverMutationAsync()

  const injected = viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-item')
  assert.equal(injected.length, 1, 'exactly one reveal row must be added')

  const divider = viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-divider')
  assert.equal(divider.length, 1, 'the row must sit below a divider')

  // Position: the app's items first, then the divider, then the reveal row. The
  // label is read off each item's own label span rather than the wrapper's
  // `textContent`, which this stub does not aggregate across children.
  const order = viewport.children.map((c) => {
    const marker = c.getAttribute('data-dsh-desktop')
    if (marker !== null) return marker
    const label = c.querySelector('[class*="itemLabel"]')
    return label === null ? null : label.textContent
  })
  assert.deepEqual(
    order,
    ['重命名', '删除工作区', 'reveal-divider', 'reveal-item'],
    'the reveal row must come last, after the divider',
  )

  // The workspace row keeps the ONE-CLICK action: label 在资源管理器打开, no
  // submenu. The submenu is deliberately scoped to the session menus.
  assert.equal(
    injected[0].querySelector('[data-dsh-desktop="reveal-label"]').textContent,
    '在资源管理器打开',
    'a workspace row offers the direct action',
  )
  assert.equal(
    injected[0].querySelector('[data-dsh-desktop="reveal-submenu"]'),
    null,
    'and no submenu, since only the session menus changed shape',
  )

  // It must be a real menu item, or the app's own keyboard and click handling
  // would skip it.
  const button = injected[0].querySelector('[role="menuitem"]')
  assert.ok(button, 'the row must carry role=menuitem')
  assert.equal(button.className, '_item_1nxmc_92', 'and reuse the app’s own item class')
  assert.ok(
    injected[0].querySelector('[class*="itemIcon"]') !== null,
    'with the app’s own icon wrapper class',
  )
  assert.ok(
    injected[0].querySelector('[class*="itemIcon"]').innerHTML.includes('<svg'),
    'holding the app’s folder glyph',
  )

  // Clicking it launches, through the app's own route, and closes the menu.
  button.dispatch('click')
  await Promise.resolve()
  const launch = sandbox.requests.filter((r) => r.url.indexOf('/open-in-app/open') !== -1)
  assert.equal(launch.length, 1, 'the click must post to the app’s launcher route')
  assert.ok(
    launch[0].init.body.includes('"app":"explorer"'),
    'naming the explorer entry',
  )
  assert.ok(
    launch[0].init.body.includes('D:\\\\projects\\\\alpha'),
    'and the workspace’s own directory',
  )
})

test('a SESSION menu gets 打开… as a submenu of the host’s applications', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceSession' })
  const { viewport } = createOpenMenu(document, ['重命名', '分叉会话', '归档会话'])

  const sandbox = runOverlay(document)
  await sandbox.deliverMutationAsync()

  const injected = viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-item')
  assert.equal(injected.length, 1, 'exactly one reveal row must be added')

  const button = injected[0].querySelector('[role="menuitem"]')
  assert.equal(
    injected[0].querySelector('[data-dsh-desktop="reveal-label"]').textContent,
    '打开…',
    'a session row is a submenu parent, so its label says so',
  )

  // The app's own accessibility contract for a submenu parent.
  assert.equal(button.getAttribute('aria-haspopup'), 'menu', 'the parent must announce a submenu')
  assert.equal(button.getAttribute('aria-expanded'), 'false', 'and start collapsed')

  // The submenu itself: one entry per nameable application the host resolved, in
  // the host's order — the app's own catalog, not a hard-coded list.
  //
  // Found on `document.body`, NOT inside the row, and that is the point: the list
  // is PORTALLED so it can escape the sidebar's stacking context. Nesting it left
  // the entries visible but unclickable — measured live, every press passed through
  // to the composer underneath. So its parent is asserted, not just its existence.
  const submenu = document.body.querySelector('[data-dsh-desktop="reveal-submenu"]')
  assert.ok(submenu, 'the parent must own a submenu')
  assert.equal(submenu.parentElement, document.body, 'which must be portalled to the body')
  assert.equal(submenu.getAttribute('role'), 'menu', 'and be a menu in its own right')

  const entries = submenu.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-app')
  assert.deepEqual(
    entries.map((e) => e.getAttribute('data-app')),
    ['explorer', 'cursor', 'vscode'],
    'the entries must be the host’s resolved applications, in its order',
  )
  assert.deepEqual(
    entries.map((e) => e.querySelector('[class*="itemLabel"]').textContent),
    ['文件资源管理器', 'Cursor', 'VS Code'],
    'labelled from the app’s own dictionary',
  )
  // The app's real icon, from the host's own icon route.
  assert.deepEqual(
    entries.map((e) => e.querySelector('img').getAttribute('src')),
    ['/open-in-app/icon/explorer', '/open-in-app/icon/cursor', '/open-in-app/icon/vscode'],
    'each entry must use the host-served application icon',
  )
  assert.ok(
    entries.every((e) => e.querySelector('img').getAttribute('width') === '18'),
    'at the size the app’s own menu uses',
  )
  // It must be hidden until asked for, or the list would hang open over the page.
  assert.equal(submenu.style.display, 'none', 'the list must start hidden')
})

test('the injected Open submenu survives leaving its parent and crossing the portal gap', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceSession' })
  const { viewport } = createOpenMenu(document, ['重命名', '分叉会话', '归档会话'])
  const sandbox = runOverlay(document)
  await sandbox.deliverMutationAsync()
  const row = viewport.querySelector('[data-dsh-desktop="reveal-item"]')
  const submenu = document.body.querySelector('[data-dsh-desktop="reveal-submenu"]')
  const pending = []
  sandbox.setTimeout = fn => { pending.push(fn); return pending.length }
  row.dispatch('mouseenter')
  row.dispatch('mouseleave', { relatedTarget: document.body })
  pending.splice(0).forEach(fn => fn())
  assert.equal(submenu.style.display, 'flex', 'crossing the gap must not start a close timer')
  submenu.dispatch('mouseenter')
  assert.equal(row.querySelector('[role="menuitem"]').getAttribute('aria-expanded'), 'true')
})

test('each submenu entry launches ITS OWN application', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceSession' })
  const { viewport } = createOpenMenu(document, ['重命名', '分叉会话', '归档会话'])

  const sandbox = runOverlay(document)
  await sandbox.deliverMutationAsync()

  const submenu = document.body.querySelector('[data-dsh-desktop="reveal-submenu"]')
  const entries = submenu.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-app')

  // EVERY entry, and against its own label — because the bug this guards is a
  // `var`-in-a-loop closure: all four buttons reported their own `data-app` while
  // every handler read the LAST one. Asserting only the first entry would have
  // passed with the bug present.
  for (const entry of entries) {
    const app = entry.getAttribute('data-app')
    const before = sandbox.requests.length
    entry.dispatch('pointerdown')
    await Promise.resolve()

    const made = sandbox.requests.slice(before).filter((r) => r.url.indexOf('/open-in-app/open') !== -1)
    assert.equal(made.length, 1, `pressing ${app} must launch exactly once`)
    assert.ok(
      made[0].init.body.includes(`"app":"${app}"`),
      `pressing ${app} must launch ${app}, not another entry`,
    )
    assert.ok(
      made[0].init.body.includes('D:\\\\projects\\\\alpha'),
      'against the session’s workspace directory',
    )
  }
})

// ── the deep-link row in session menus ───────────────────────────────────────

test('a SESSION menu gets 复制... and its deep-link child copies through the host clipboard', async () => {
  const { document, workspace } = createSidebarPage({ markOpen: 'workspaceSession' })
  // The id lives on the row's own `node` prop — the app's real shape. The
  // fixture's default session fibers carry none, so this one is set explicitly.
  workspace.sessions[0]['__reactFiber$test'] = {
    memoizedProps: { node: { id: 'session-abc-123' } },
    return: null,
  }
  const { viewport } = createOpenMenu(document, ['重命名', '分叉会话'])

  const copied = []
  const sandbox = runOverlay(document)
  sandbox.__TAURI__ = { core: { invoke: async (command, args) => { copied.push({ command, args }); return {} } } }
  await sandbox.deliverMutationAsync()
  await sandbox.deliverMutationAsync()

  const links = viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'link-item')
  assert.equal(links.length, 1, 'exactly one deep-link row, even across re-renders')

  const button = links[0].querySelector('[role="menuitem"]')
  assert.equal(
    links[0].querySelector('[data-dsh-desktop="link-label"]').textContent,
    '复制...',
    'labelled like the title bar’s identical action',
  )
  assert.equal(button.disabled, false, 'a row that exposed its id copies')
  assert.ok(
    links[0].querySelector('[class*="itemIcon"]').innerHTML.includes('<svg'),
    'with the app’s own icon slot',
  )
  assert.equal(button.className, '_item_1nxmc_92', 'reusing the app’s own item class')
  assert.equal(button.getAttribute('aria-haspopup'), 'menu')
  button.dispatch('pointerdown')
  button.dispatch('click')
  assert.equal(copied.length, 0, 'the parent only opens its submenu')
  const submenu = document.body.querySelector('[data-dsh-desktop="copy-submenu"]')
  assert.equal(submenu.style.display, 'flex')
  assert.equal(button.getAttribute('aria-expanded'), 'true')
  assert.deepEqual(submenu.children.map(entry => entry.querySelector('[class*="itemLabel"]').textContent),
    ['复制深度链接', '复制会话内容', '保存会话内容'])

  // ACTS ON pointerdown, like the reveal entries: the app's dismissal runs on
  // the same phase and would unmount the row before any click.
  submenu.children[0].dispatch('pointerdown')
  submenu.children[0].dispatch('click')
  await new Promise(setImmediate)

  assert.equal(copied.length, 1, 'the press must copy exactly once')
  assert.equal(copied[0].command, 'clipboard_write_text', 'through the granted clipboard command')
  assert.equal(
    copied[0].args.text,
    'deepseekharness://session/session-abc-123',
    'naming the row’s own session',
  )
  const toast = document.body.children.find((c) => c.getAttribute('data-dsh-desktop') === 'toast')
  assert.ok(toast, 'a copy must be confirmed — the copied string is invisible')
  assert.ok(toast.textContent.includes('已复制深度链接'), 'with the success wording')
})

test('the copy submenu forwards its row id for content actions and disappears with the owning menu', async () => {
  const { document, workspace } = createSidebarPage({ markOpen: 'workspaceSession' })
  workspace.sessions[0]['__reactFiber$test'] = { memoizedProps: { node: { id: 'background-session' } }, return: null }
  const { menu } = createOpenMenu(document, ['重命名'])
  const sandbox = runOverlay(document)
  const calls = []
  sandbox.__DSH_SESSION_ACTIONS__ = {
    copyContent: id => calls.push(['copy', id]),
    saveContent: id => calls.push(['save', id]),
  }
  await sandbox.deliverMutationAsync()
  const submenu = document.body.querySelector('[data-dsh-desktop="copy-submenu"]')
  submenu.children[1].dispatch('pointerdown')
  submenu.children[1].dispatch('click')
  submenu.children[2].dispatch('keydown', { key: 'Enter' })
  assert.deepEqual(calls, [['copy', 'background-session'], ['save', 'background-session']])
  menu.parentElement.removeChild(menu)
  sandbox.deliverRemoval([{ removedNodes: [menu], target: document.body }])
  assert.equal(submenu.isConnected, false, 'no orphaned submenu after dismissal')
})

test('a session row without a readable id still gets the row, disabled rather than absent', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceSession' })
  const { viewport } = createOpenMenu(document, ['重命名'])

  const sandbox = runOverlay(document)
  await sandbox.deliverMutationAsync()

  const links = viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'link-item')
  assert.equal(links.length, 1, 'the row must be offered')
  assert.equal(
    links[0].querySelector('[role="menuitem"]').disabled,
    true,
    'but disabled: a vanishing item reads as a broken menu',
  )
})

test('a WORKSPACE menu gets no deep-link row', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceRow' })
  const { viewport } = createOpenMenu(document, ['重命名', '删除工作区'])

  const sandbox = runOverlay(document)
  await sandbox.deliverMutationAsync()

  assert.equal(
    viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'link-item').length,
    0,
    'a workspace names no single session to link to',
  )
})

test('the submenu acts on pointerdown, which is what survives the app’s dismissal', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceSession' })
  const { viewport } = createOpenMenu(document, ['重命名', '分叉会话', '归档会话'])

  const sandbox = runOverlay(document)
  await sandbox.deliverMutationAsync()

  const submenu = document.body.querySelector('[data-dsh-desktop="reveal-submenu"]')
  const entry = submenu.children.find((c) => c.getAttribute('data-dsh-desktop') === 'reveal-app')

  // WHY POINTERDOWN. The app's own `Menu` closes on a document-level `pointerdown`
  // whose target is outside the menu AND outside the anchor wrapper. A portalled
  // list is outside both — that is what lets it escape the sidebar's stacking
  // context — so the menu unmounts before any `click` fires. Verified live:
  // `pointerdown` reached the entry, `click` never did, and no request was made.
  //
  // So `click` alone must NOT be what launches: the same press is dispatched as a
  // click here and nothing may happen.
  const beforeClick = sandbox.requests.length
  entry.dispatch('click')
  await Promise.resolve()
  assert.equal(
    sandbox.requests.slice(beforeClick).filter((r) => r.url.indexOf('/open-in-app/open') !== -1).length,
    0,
    'a click alone must not launch, since the app would have closed the menu by then',
  )

  entry.dispatch('pointerdown')
  await Promise.resolve()
  assert.equal(
    sandbox.requests.slice(beforeClick).filter((r) => r.url.indexOf('/open-in-app/open') !== -1).length,
    1,
    'the press is what launches',
  )
})

test('the submenu launches the app it was given, not a fixed one', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceSession' })
  const { viewport } = createOpenMenu(document, ['重命名', '分叉会话', '归档会话'])

  const sandbox = runOverlay(document)
  await sandbox.deliverMutationAsync()

  // Superseded by "each submenu entry launches ITS OWN application", which checks
  // every entry rather than one; kept as the single-entry case because it is the
  // cheapest way to see a regression in isolation.
  const submenu = document.body.querySelector('[data-dsh-desktop="reveal-submenu"]')
  const entries = submenu.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-app')

  // The SECOND entry, so a "first one only" wiring bug cannot pass.
  entries[1].dispatch('pointerdown')
  await Promise.resolve()

  const launch = sandbox.requests.filter((r) => r.url.indexOf('/open-in-app/open') !== -1)
  assert.equal(launch.length, 1, 'the entry must launch')
  assert.ok(
    launch[0].init.body.includes('"app":"cursor"'),
    'the CHOSEN application must be the one launched',
  )
  assert.ok(
    launch[0].init.body.includes('D:\\\\projects\\\\alpha'),
    'against the session’s workspace directory',
  )
})

test('no submenu is offered when the host resolved no application', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceSession' })
  const { viewport } = createOpenMenu(document, ['重命名', '分叉会话', '归档会话'])

  const sandbox = runOverlay(document)
  // A host without the capability answers an empty list — a real case, and the one
  // where an empty submenu would read as broken rather than as unavailable.
  sandbox.appCatalog = []
  await sandbox.deliverMutationAsync()

  assert.equal(
    viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-item').length,
    0,
    'an empty catalog must yield no entry at all, not an empty submenu',
  )
})

test('an application the app names but this overlay does not is skipped', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceSession' })
  const { viewport } = createOpenMenu(document, ['重命名', '分叉会话', '归档会话'])

  const sandbox = runOverlay(document)
  // `zed` and `windsurf` are in the app's dictionary; `mystery-app` is not. An
  // unnameable id must stay invisible rather than render as a raw id — the app's
  // own rule, and the reason the label map exists.
  sandbox.appCatalog = ['explorer', 'mystery-app', 'zed']
  await sandbox.deliverMutationAsync()

  const submenu = document.body.querySelector('[data-dsh-desktop="reveal-submenu"]')
  assert.ok(submenu, 'the submenu must exist on the body')
  assert.deepEqual(
    submenu.children
      .filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-app')
      .map((e) => e.getAttribute('data-app')),
    ['explorer', 'zed'],
    'only nameable applications may appear',
  )
})

test('the reveal item is NOT added when the row has no directory', async () => {
  // THE BUG THIS EXISTS FOR. The ungrouped bucket's sessions belong to no
  // workspace, so they have no directory. An earlier version of the lookup kept
  // walking past the bucket's own (path-less) project row and reached the SHARED
  // list container, which holds every section — so it returned whichever workspace
  // sorted first. Verified live: an ungrouped session resolved to StarFallHub's
  // directory. The walk must stop at the first project row, path or no path.
  const { document } = createSidebarPage({ markOpen: 'ungroupedSession' })
  const { viewport } = createOpenMenu(document, ['重命名', '分叉会话', '归档会话'])

  const sandbox = runOverlay(document)
  await sandbox.deliverMutationAsync()

  assert.equal(
    viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-item').length,
    0,
    'a row with no workspace must get no reveal item, not a neighbour’s directory',
  )
  assert.equal(
    viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-divider').length,
    0,
    'and no divider either, since there is nothing below it',
  )
})

test('the ungrouped bucket’s header row is tagged, and only it', async () => {
  // The stylesheet gives the bucket a face of its own — its own glyph, a quieter
  // title — and it can apply that face only where the DOM tier says the bucket
  // is. The identifier is the row's own React data: the one group built without
  // a workspaceId. The fixture models both group shapes, so this test fails if
  // the lookup ever keys on the label (locale-dependent) or the classes (hashed).
  const { document, workspace, ungrouped } = createSidebarPage()
  const sandbox = runOverlay(document)
  await sandbox.deliverMutation()

  assert.equal(
    ungrouped.project.getAttribute('data-dsh-desktop'),
    'ungrouped',
    'the bucket’s header must be tagged so the stylesheet can target it',
  )
  assert.equal(
    workspace.project.getAttribute('data-dsh-desktop'),
    null,
    'a real workspace must keep the app’s own folder face',
  )
  for (const session of [...workspace.sessions, ...ungrouped.sessions]) {
    assert.equal(
      session.getAttribute('data-dsh-desktop'),
      null,
      'session rows are ordinary rows, inside the bucket too',
    )
  }

  // One render is many mutation records; the write must be idempotent.
  await sandbox.deliverMutation()
  assert.equal(ungrouped.project.getAttribute('data-dsh-desktop'), 'ungrouped')
})

test('the ungrouped tag follows the appearance family in 原版', async () => {
  const { document, ungrouped } = createSidebarPage()
  const sandbox = runOverlay(document)
  await sandbox.deliverMutation()
  assert.equal(ungrouped.project.getAttribute('data-dsh-desktop'), 'ungrouped')

  setMode(document, 'vanilla')
  assert.equal(
    ungrouped.project.getAttribute('data-dsh-desktop'),
    null,
    '原版 removes the project’s appearance tags, this one included',
  )

  // And a re-render in 原版 must not re-add what the cleanup removed — the same
  // race the relocated-row tag was fixed for.
  await sandbox.deliverMutation()
  assert.equal(ungrouped.project.getAttribute('data-dsh-desktop'), null)
})

test('a row that stops being the ungrouped bucket loses the tag', async () => {
  // The bucket is defined by the row's data, not by the node: a workspace
  // created where the list used to end re-renders the row with a real group —
  // modelled by re-attaching the fiber — and the tag must retire, or the
  // bucket's face would stick to a real workspace.
  const { document, ungrouped } = createSidebarPage()
  const sandbox = runOverlay(document)
  await sandbox.deliverMutation()
  assert.equal(ungrouped.project.getAttribute('data-dsh-desktop'), 'ungrouped')

  ungrouped.project['__reactFiber$test'] = {
    memoizedProps: {
      group: { key: 'ws-new', workspaceId: 'ws-new', cwd: 'D:\\projects\\new', sessions: [] },
    },
    return: null,
  }
  await sandbox.deliverMutation()
  assert.equal(
    ungrouped.project.getAttribute('data-dsh-desktop'),
    null,
    'the bucket’s face must not stick to a real workspace',
  )
})

test('the reveal item is not injected in 原版', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceSession' })
  const { viewport } = createOpenMenu(document, ['重命名', '分叉会话', '归档会话'])

  const sandbox = runOverlay(document)
  setMode(document, 'vanilla')
  await sandbox.deliverMutationAsync()

  assert.equal(
    viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-item').length,
    0,
    '原版 is the frontend with none of this project’s modifications',
  )

  // And it comes back when the desktop styles do, with no re-binding.
  setMode(document, 'desktop')
  await sandbox.deliverMutationAsync()
  assert.equal(
    viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-item').length,
    1,
    'switching back must restore the item',
  )
})

test('injecting twice adds only one row', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceSession' })
  const { viewport } = createOpenMenu(document, ['重命名', '归档会话'])

  const sandbox = runOverlay(document)
  // The menu re-renders as the pointer moves, and every render is a chance to
  // inject a second copy — hence the marker guard.
  await sandbox.deliverMutationAsync()
  await sandbox.deliverMutationAsync()
  await sandbox.deliverMutationAsync()

  assert.equal(
    viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-item').length,
    1,
    'the injection must be idempotent',
  )
})

test('a refused launch is reported on the page, not swallowed', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceRow' })
  const { viewport } = createOpenMenu(document, ['重命名', '删除工作区'])

  const sandbox = runOverlay(document)
  await sandbox.deliverMutationAsync()

  // THE FAILURE THE FEATURE USED TO HIDE. The route answers 404 for a directory
  // that does not exist — a workspace whose folder was moved or deleted, the most
  // common real refusal. The first version of this handler only attached a
  // `.catch`, which fires for NETWORK errors and never for an answered refusal:
  // the click closed the menu and nothing anywhere said why. A toast is the
  // whole fix — the same click, with a sentence naming the reason.
  const realFetch = sandbox.fetch
  sandbox.fetch = (url, init) => {
    sandbox.requests.push({ url: String(url), init })
    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ code: 'not-found', message: 'directory does not exist: D:\\projects\\alpha' }),
    })
  }

  const button = viewport.children
    .filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-item')
    .flatMap((c) => c.children)[0]
  button.dispatch('click')
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  const toast = document.body.children.find((c) => c.getAttribute('data-dsh-desktop') === 'toast')
  assert.ok(toast, 'a refused launch must produce a visible report')
  assert.ok(
    toast.textContent.includes('directory does not exist'),
    'the report must carry the route’s reason',
  )
  assert.ok(
    toast.textContent.includes('D:\\projects\\alpha'),
    'and the directory the action tried to open',
  )

  // A second refusal must not pile up unbounded toasts.
  button.dispatch('click')
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(
    document.body.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'toast').length,
    2,
    'each failure reports once',
  )
  void realFetch
})

test('a failed catalog read is retried on the next menu open', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceSession' })
  const { viewport } = createOpenMenu(document, ['重命名', '分叉会话', '归档会话'])

  const sandbox = runOverlay(document)
  // First open: the apps route answers a refusal (the fence rejecting once, the
  // server briefly unavailable — one-off failures of both kinds are real). The
  // submenu must be absent for THAT menu, because an empty catalog offers nothing.
  const realFetch = sandbox.fetch
  sandbox.fetch = (url, init) => {
    sandbox.requests.push({ url: String(url), init })
    return Promise.resolve({ ok: false, status: 503 })
  }
  await sandbox.deliverMutationAsync()
  assert.equal(
    viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-item').length,
    0,
    'a failed read offers no submenu this time',
  )

  // Second open: the same read now succeeds. The first version CACHED the empty
  // answer for the page's lifetime, so the 打开… item never appeared again no
  // matter how many times the menu was reopened — the failure outlived its cause.
  // The cache holds only a non-empty catalog, so this open retries and wins.
  sandbox.fetch = realFetch
  // Let the failed read finish settling before reopening, the way real menu opens
  // are spread over time: a menu opened WHILE a read is in flight joins it and is
  // served by its (here, failed) answer, which would measure the join path
  // instead of the retry.
  await Promise.resolve()
  await sandbox.deliverMutationAsync()
  assert.equal(
    viewport.children.filter((c) => c.getAttribute('data-dsh-desktop') === 'reveal-item').length,
    1,
    'the next open must retry the read and offer the submenu',
  )
})

test('the report listener renders the title bar’s failure reports too', async () => {
  const { document } = createSidebarPage({ markOpen: 'workspaceRow' })
  createOpenMenu(document, ['重命名', '删除工作区'])

  runOverlay(document)

  // The title bar dispatches `dsh-desktop:report` for the launches it fails on;
  // this renderer is the one surface, so both halves of the feature fail the same
  // visible way. The event shape is what client.js dispatches: detail.message.
  document.dispatchEvent({
    type: 'dsh-desktop:report',
    detail: { message: '打开 D:\\gone 失败：HTTP 404' },
  })

  const toast = document.body.children.find((c) => c.getAttribute('data-dsh-desktop') === 'toast')
  assert.ok(toast, 'a title bar report must reach the same toast')
  assert.equal(toast.textContent, '打开 D:\\gone 失败：HTTP 404', 'with the message it carried')
})

test('the reveal feature drives the APP’s launcher routes, not a second one', () => {
  const dom = readFileSync(join(here, 'ui-overlay', 'dom.js'), 'utf8')

  // WHY THE APP'S ROUTES. DSH ships `dsh-host-open-in-app`, which resolves a
  // catalog of installed applications to verified launchers and exposes
  // `POST /open-in-app/open` plus the apps and icon routes. Reusing them means no
  // new Rust command, no new Tauri permission, and no second launcher to keep in
  // step — and it inherits the app's own Host/Origin fence, browser
  // authentication, and wire validation of the body. Both halves of this project
  // use them.
  assert.ok(dom.includes("'/open-in-app/open'"), 'the overlay must post to the app’s launcher route')
  assert.ok(
    dom.includes("'/open-in-app/apps'"),
    'and read the catalog from the app’s own apps route, so it offers what the app offers',
  )
  assert.ok(
    dom.includes("'/open-in-app/icon/'"),
    'and take each application icon from the app’s own icon route',
  )

  // The app id must be DATA, not a literal: the submenu passes the entry the user
  // chose, so a hard-coded `explorer` would make every entry launch Explorer.
  assert.ok(
    /function openWithApp\(appId, path\)/.test(dom),
    'one helper must take the app id',
  )
  assert.ok(
    /body: JSON\.stringify\(\{ app: appId, path: path \}\)/.test(dom),
    'and post the app it was given',
  )

  // No second implementation: nothing may spawn a process of its own. The patterns
  // are anchored so a REGEX method (`/…/.exec(…)`, which this file legitimately
  // uses to read the submenu class) or a CSS property name is not mistaken for a
  // process launch.
  for (const forbidden of [
    { pattern: /require\(\s*['"]child_process['"]\s*\)/, what: 'child_process' },
    { pattern: /(?:^|[^.\w])exec(?:Sync)?\s*\(/m, what: 'exec(' },
    { pattern: /(?:^|[^.\w])spawn(?:Sync)?\s*\(/m, what: 'spawn(' },
    { pattern: /shell\.openExternal/, what: 'shell.openExternal' },
  ]) {
    assert.ok(
      !forbidden.pattern.test(dom),
      `the overlay must not launch anything itself (found ${forbidden.what})`,
    )
  }
})

test('the sidebar submenu mirrors the app’s dictionary and skips unnameable ids', () => {
  const dom = readFileSync(join(here, 'ui-overlay', 'dom.js'), 'utf8')

  // The app renders only ids it can NAME, so a host catalog extension without a
  // dictionary entry stays invisible instead of showing a raw id. The map is
  // mirrored here because the app keeps its own copy module-private, and the
  // consequence of drift is "an app is not offered", never "a wrong label".
  assert.ok(
    dom.includes("get explorer() { return t('文件资源管理器') }") && dom.includes("cursor: 'Cursor'"),
    'the label map must mirror the app’s own dictionary',
  )
  assert.ok(
    /hasOwnProperty\.call\(OPEN_APP_LABELS, ids\[i\]\)/.test(dom),
    'an id with no label must be skipped rather than rendered',
  )

  // The submenu's class comes from the loaded stylesheet, because it is a
  // per-build hash — and it brings the app's own positioning, its `::before`
  // pointer bridge, and its shadow. A fallback exists for the case where no such
  // rule is found, so the list still appears beside its item.
  assert.ok(
    dom.includes('function submenuClassName()'),
    'the submenu class must be looked up, not written down',
  )
  assert.ok(
    dom.includes('100% + 10px'),
    'found by the declaration that makes a nested list a submenu',
  )
  assert.ok(
    dom.includes('reveal-submenu'),
    'and the list must be marked, so it is identifiable',
  )
})

test('the reveal item’s guard is structural, not a hard-coded class hash', () => {
  const dom = readFileSync(join(here, 'ui-overlay', 'dom.js'), 'utf8')

  // The app's CSS-module hashes change every build, so a rule or lookup keyed on
  // one stops working silently after an upgrade. The row is found by its ROLE and
  // its open marker, and the item classes are CLONED from a real item in the same
  // menu rather than written down.
  assert.ok(
    dom.includes('[class*="menuOpen"][role="treeitem"]'),
    'the open row must be found by role plus the app’s open marker',
  )
  assert.ok(
    dom.includes('[class*="projectRow"]') && dom.includes('[class*="viewport"]'),
    'the workspace row and the item list must be found by class FRAGMENT, not a full hash',
  )

  // And the icon is the app's own artwork, transcribed because a classic script
  // cannot import it — so the path must match the bundle's.
  const source = readFileSync(join(here, 'ui-overlay', 'dom.js'), 'utf8')
  const path = /var FOLDER_ICON_PATH =\s*\n?\s*'([^']+)'/.exec(source)
  assert.ok(path, 'the folder icon path must be a named constant')

  const bundle = readBundleFolderIcon()
  if (bundle !== null) {
    assert.equal(
      path[1],
      bundle,
      'the transcribed folder path must equal the app bundle’s own IconFolderOpenOutline16',
    )
  }
})

/**
 * Read `IconFolderOpenOutline16`'s path data out of the installed frontend bundle.
 *
 * Returns null when the bundle is not present, so the assertion above skips rather
 * than fails on a machine without DSH installed — the same contract the other
 * tests in this repository use for needing the real implementation.
 *
 * @returns the `d` attribute, or null.
 */
function readBundleFolderIcon() {
  const appData = process.env.APPDATA
  if (!appData) return null
  const candidates = [
    join(appData, '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets'),
    join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets'),
  ]
  for (const dir of candidates) {
    let files
    try {
      files = require('node:fs').readdirSync(dir)
    } catch {
      continue
    }
    const bundleName = files.find((f) => /^index-.*\.js$/.test(f))
    if (bundleName === undefined) continue
    const text = readFileSync(join(dir, bundleName), 'utf8')
    // The icon component is `NAME=({size:…})=>…d:"<path>"`; find the definition by
    // the export map's local name so a re-minified build still resolves.
    const exported = /IconFolderOpenOutline16:([A-Za-z0-9_$]+)/.exec(text)
    if (!exported) continue
    const at = text.indexOf(`${exported[1]}=({size:`)
    if (at < 0) continue
    const d = /d:"([^"]+)"/.exec(text.slice(at, at + 4000))
    if (d) return d[1]
  }
  return null
}
