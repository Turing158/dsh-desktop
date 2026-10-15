import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./ui-overlay/browser-compat.js', import.meta.url), 'utf8')

/**
 * One realm running the shipped script, with the newest standards APIs removed
 * first so the engine shims actually install. A fresh `vm` context has its own
 * intrinsics, so nothing installed here can reach this process — which is also
 * why `Uint8Array` is no longer passed in: the realm must shim its own.
 */
function realm(remove = [], globals = {}) {
  const window = { crypto: { getRandomValues: bytes => webcrypto.getRandomValues(bytes) }, innerHeight: 800, addEventListener() {} }
  window.top = window
  const attributes = new Map()
  const document = { documentElement: { toggleAttribute: (name, value) => attributes.set(name, value), style: { setProperty() {} } } }
  const context = vm.createContext({ window, document, ...globals })
  const before = remove.length ? null : vm.runInContext('({ Iterator: globalThis.Iterator, promiseTry: globalThis.Promise.try, sumPrecise: globalThis.Math.sumPrecise, fromBase64: globalThis.Uint8Array.fromBase64 })', context)
  // `delete a.b.c` throws when `a.b` does not exist, and a bare realm has none of
  // the Web APIs — the deletion list is a wish, not a guarantee.
  if (remove.length) vm.runInContext(remove.map(path => `try { delete ${path} } catch {}`).join('\n'), context)
  vm.runInContext(source, context)
  return {
    window,
    attributes,
    before,
    rerun: () => vm.runInContext(source, context),
    evaluate: (code) => vm.runInContext(code, context),
    // Cross-realm objects do not survive `deepEqual` (their prototypes differ),
    // so structured results come back through JSON.
    json: (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)),
  }
}

function run(crypto, desktop, transport) {
  const window = { crypto, innerHeight: 800, addEventListener() {} }; window.top = window
  if (desktop) window.__TAURI__ = { core: { invoke() {} } }
  if (transport !== undefined) window.__DSH_TRANSPORT__ = transport
  const attributes = new Map()
  const document = { documentElement: { toggleAttribute: (name, value) => attributes.set(name, value), style: { setProperty() {} } } }
  vm.runInNewContext(source, { window, document })
  return { window, attributes }
}

function viewportRealm({ height = 660, offsetTop = 0, scale = 1, visual = true, desktop = false } = {}) {
  const styles = new Map(), viewportEvents = new Map(), windowEvents = new Map()
  const viewport = { height, offsetTop, scale, addEventListener: (name, fn) => viewportEvents.set(name, fn) }
  const window = { innerHeight: 812, crypto: {}, addEventListener: (name, fn) => windowEvents.set(name, fn) }
  window.top = window
  if (visual) window.visualViewport = viewport
  if (desktop) window.__TAURI__ = { core: { invoke() {} } }
  const document = { documentElement: { toggleAttribute() {}, style: { setProperty: (key, value) => styles.set(key, value) } } }
  vm.runInNewContext(source, { window, document })
  return { window, viewport, styles, viewportEvents, windowEvents,
    change(values, event = 'resize') { Object.assign(viewport, values); viewportEvents.get(event)?.() },
    rectangle: () => [styles.get('--dsh-mobile-height'), styles.get('--dsh-mobile-top')],
  }
}

test('remote viewport follows keyboard height and Safari panning, then recovers on page restore', () => {
  const f = viewportRealm()
  assert.deepEqual(f.rectangle(), ['660px', '0px'])
  f.change({ height: 320 })
  assert.deepEqual(f.rectangle(), ['320px', '0px'])
  f.change({ offsetTop: 145 }, 'scroll')
  assert.deepEqual(f.rectangle(), ['320px', '145px'])
  Object.assign(f.viewport, { height: 660, offsetTop: 0 })
  f.windowEvents.get('pageshow')()
  assert.deepEqual(f.rectangle(), ['660px', '0px'])
  f.change({ height: 0, offsetTop: -50 })
  assert.deepEqual(f.rectangle(), ['812px', '0px'])
})

test('manual pinch zoom does not shrink the app or chase viewport panning', () => {
  const f = viewportRealm()
  f.change({ height: 330, scale: 2, offsetTop: 120 })
  f.change({ offsetTop: 200 }, 'scroll')
  assert.deepEqual(f.rectangle(), ['660px', '0px'])
  f.change({ height: 300, scale: 1, offsetTop: 60 })
  assert.deepEqual(f.rectangle(), ['300px', '60px'])
  assert.deepEqual(viewportRealm({ height: 330, scale: 2, offsetTop: 120 }).rectangle(), ['660px', '0px'])
})

test('viewport falls back without VisualViewport and leaves the desktop shell alone', () => {
  const f = viewportRealm({ visual: false })
  assert.deepEqual(f.rectangle(), ['812px', '0px'])
  f.window.innerHeight = 390
  f.windowEvents.get('resize')()
  assert.deepEqual(f.rectangle(), ['390px', '0px'])
  f.window.innerHeight = 0
  f.windowEvents.get('resize')()
  assert.deepEqual(f.rectangle(), ['390px', '0px'])
  const desktop = viewportRealm({ desktop: true })
  assert.equal(desktop.styles.size, 0)
  assert.equal(desktop.viewportEvents.size, 0)
})

/** Every ECMAScript API the shims cover and the served bundles assume rather than test. */
const MODERN = [
  'globalThis.Iterator',
  'globalThis.Promise.try',
  'globalThis.Promise.withResolvers',
  'globalThis.Math.sumPrecise',
  'globalThis.Uint8Array.fromBase64',
  'globalThis.Uint8Array.fromHex',
  'globalThis.Uint8Array.prototype.toBase64',
  'globalThis.Uint8Array.prototype.toHex',
]

/**
 * A spec-shaped AbortController/AbortSignal pair owned by ONE test realm.
 *
 * The realm needs them because a bare `vm` context has no Web APIs at all, and
 * injecting this process's own `AbortSignal` would install the shims onto the
 * runner's real intrinsics — a test that mutates the process it runs in is not a
 * test. Only the surface the shim itself uses is implemented: `aborted`,
 * `reason`, `addEventListener('abort')`, and `abort(reason)`.
 *
 * @returns {{ AbortSignal: Function, AbortController: Function }} fresh classes.
 */
function abortPair() {
  class AbortSignal {
    constructor() { this.aborted = false; this.reason = undefined; this.listeners = new Set() }
    addEventListener(type, listener) { if (type === 'abort') this.listeners.add(listener) }
    removeEventListener(type, listener) { this.listeners.delete(listener) }
  }
  class AbortController {
    constructor() { this.signal = new AbortSignal() }
    abort(reason) {
      const signal = this.signal
      if (signal.aborted) return
      signal.aborted = true
      signal.reason = reason === undefined
        ? Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
        : reason
      for (const listener of [...signal.listeners]) listener.call(signal)
    }
  }
  return { AbortSignal, AbortController }
}

/**
 * A realm that also has the Web APIs the new shims attach to, none of them
 * shimmed yet (the state of the phone that reported a list that never arrives).
 *
 * `natives: true` pre-defines the three members, which is how "a native
 * implementation is never replaced" is asserted without touching the host realm.
 *
 * @param {{ natives?: boolean }} [options] - whether the engine already has them.
 * @returns the realm handle, plus the classes it handed the realm.
 */
function webRealm({ natives = false } = {}) {
  const pair = abortPair()
  // A URL class the shim can construct, deliberately WITHOUT a static `parse`:
  // `class extends URL` would inherit the host's, and the shim would skip.
  class RealmURL {
    constructor(url, base) { this.href = base === undefined ? new URL(url).href : new URL(url, base).href }
  }
  if (natives) {
    pair.AbortSignal.any = function any() { return 'native-any' }
    pair.AbortSignal.prototype.throwIfAborted = function throwIfAborted() { return 'native-throw' }
    RealmURL.parse = function parse() { return 'native-parse' }
  }
  const handle = realm([], { AbortSignal: pair.AbortSignal, AbortController: pair.AbortController, URL: RealmURL })
  return Object.assign(handle, { pair, RealmURL })
}

for (const desktop of [true, false]) test(`${desktop ? 'desktop' : 'remote browser'} HTTP origins create valid unique v4 UUIDs using the native random generator`, () => {
  let calls = 0
  const crypto = { getRandomValues(bytes) { calls++; return webcrypto.getRandomValues(bytes) } }
  const { window, attributes } = run(crypto, desktop)
  assert.equal(window.crypto, crypto)
  const values = Array.from({ length: 128 }, () => crypto.randomUUID())
  assert.equal(new Set(values).size, 128)
  assert.equal(calls, 128)
  values.forEach(value => assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
  assert.equal(attributes.get('data-dsh-browser'), !desktop)
  if (!desktop) assert.equal(window.__DSH_TRANSPORT__, undefined, 'UUID compatibility must not grant Host ownership')
})

test('native UUID implementations remain unchanged on desktop and remote pages', () => {
  for (const desktop of [true, false]) {
    const crypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes), randomUUID: () => 'native' }, method = crypto.randomUUID
    const result = run(crypto, desktop)
    assert.equal(result.window.crypto, crypto)
    assert.equal(crypto.randomUUID, method)
    assert.equal(crypto.randomUUID(), 'native')
  }
})

test('UUID repair is idempotent and never substitutes a non-cryptographic random source', () => {
  const f = realm(), method = f.window.crypto.randomUUID
  f.rerun()
  assert.equal(f.window.crypto.randomUUID, method)
  for (const crypto of [undefined, {}]) {
    run(crypto, false)
    assert.equal(crypto?.randomUUID, undefined)
  }
})

// DSH reads this ONE flag to decide whether the page may carry the Host
// settings namespace (`dsh-client-connection`). Without it a LAN-served desktop
// window is a "remote browser" to DSH, the describe mirror never answers, and the
// model page reports 加载提供方目录失败: settings are unavailable in this browser.
test('the desktop window declares that it owns the host, like DSH own desktop host', () => {
  const crypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) }
  const { window, attributes } = run(crypto, true)
  assert.equal(window.__DSH_TRANSPORT__.ownsHost, true)
  assert.equal(attributes.get('data-dsh-browser'), false)
})

test('a transport a page already installed is extended, never replaced', () => {
  const crypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) }
  const carriers = { openStream() {}, streamBaseUrl: 'http://127.0.0.1:1/' }
  const { window } = run(crypto, true, carriers)
  assert.equal(window.__DSH_TRANSPORT__, carriers)
  assert.equal(carriers.openStream instanceof Function, true)
  assert.equal(carriers.streamBaseUrl, 'http://127.0.0.1:1/')
  assert.equal(carriers.ownsHost, true)
})

// The same test that scopes the desktop branch above: a phone or any other
// browser on the LAN has no `__TAURI__`, so upstream's memory-mode policy for a
// genuinely remote page is left exactly as DSH ships it.
test('an ordinary browser on the LAN never claims host ownership', () => {
  const crypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) }
  const { window, attributes } = run(crypto, false)
  assert.equal(window.__DSH_TRANSPORT__, undefined)
  assert.equal(attributes.get('data-dsh-browser'), true)
})

// A transport that cannot be extended must not take the rest of the script with
// it: this runs in strict mode inside a `<head>` row, so an unguarded assignment
// would throw out of the IIFE and skip `data-dsh-browser` below it.
test('a transport that cannot be extended leaves the page classified anyway', () => {
  const crypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) }
  const sealed = Object.freeze({ ownsHost: true, streamBaseUrl: 'http://127.0.0.1:1/' })
  const { window, attributes } = run(crypto, true, sealed)
  assert.equal(window.__DSH_TRANSPORT__, sealed)
  assert.equal(attributes.get('data-dsh-browser'), false)
})

// ── Engine shims ────────────────────────────────────────────────────────────
// The phone reports these answer:
//
//   Failed to load plugins
//   failed to import loader entry 675c2870 (@deepseek-ai/dsh-client-ui-sidebar-
//   documentpreview): Can't find variable: Iterator
//
// `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` bundles pdf.js 6.3.289,
// whose display layer opens with an UNGUARDED read of `Iterator.prototype.join`.
// On WebKit without the iterator-helpers global that is a ReferenceError during
// the plugin's own factory, so the entry never loads and DSH mounts nothing.
//
//   …and then, once that was fixed, a page that rendered but whose Workspaces and
//   Sessions never arrived: no error on screen, no empty state, just a list that
//   stayed on its loading state for the life of the page.
//
// That second report is `@deepseek-ai/dsh-api-gateway/client` calling
// `signal.throwIfAborted()` — and `AbortSignal.any([…])` — without a feature test
// on every Remote stream it opens. The stream rejects, the multiplexed socket
// never delivers a baseline, and every store the gateway feeds stays pending. The
// client's own `ctx.timeout()`/`ctx.interval()` and the approval prompts use
// `Promise.withResolvers` the same way, and pdf.js's display layer calls
// `URL.parse`. All four are shimmed here.
//
// The earlier version of this block reasoned that `Promise.withResolvers` was a
// BOOT FLOOR (upstream's trailing `(globalThis.__DSH_BOOT_READY__ ??=
// Promise.withResolvers()).resolve()`), so anything "below" it was left
// unshimmed. Measured, that is false: with the API deleted the shell still
// paints, and the only casualty is that one inline script — see
// tools/phone-workspace-list-probe.mjs, which drives the whole phone page on a
// deliberately crippled engine.

test('the engine shims install exactly the APIs this engine is missing, and only those', () => {
  const present = realm([])
  assert.equal(present.before.Iterator, present.evaluate('globalThis.Iterator'), 'A native Iterator is never replaced')
  assert.equal(present.before.promiseTry, present.evaluate('globalThis.Promise.try'), 'A native Promise.try is never replaced')
  // Node 24 has neither of these, so the shims must have provided them…
  assert.equal(typeof present.before.sumPrecise, 'undefined')
  assert.equal(typeof present.before.fromBase64, 'undefined')
  assert.equal(present.evaluate('typeof globalThis.Math.sumPrecise'), 'function')
  assert.equal(present.evaluate('typeof globalThis.Uint8Array.fromBase64'), 'function')

  // …and with everything deleted the same members are all defined.
  const bare = realm(MODERN)
  for (const member of ['Iterator', 'Promise.try', 'Promise.withResolvers', 'Math.sumPrecise', 'Uint8Array.fromBase64', 'Uint8Array.fromHex']) {
    assert.equal(bare.evaluate(`typeof ${member}`), 'function', `${member} must be installed`)
  }
  assert.equal(bare.evaluate('typeof Uint8Array.prototype.toBase64'), 'function')
  assert.equal(bare.evaluate('typeof Uint8Array.prototype.toHex'), 'function')
  assert.equal(bare.evaluate('typeof Iterator.prototype.join'), 'undefined', 'pdf.js installs join itself, not the shim')

  // The Web APIs live in their own realm, because a bare realm has none at all.
  const web = webRealm()
  assert.equal(web.evaluate('typeof AbortSignal.prototype.throwIfAborted'), 'function')
  assert.equal(web.evaluate('typeof AbortSignal.any'), 'function')
  assert.equal(web.evaluate('typeof URL.parse'), 'function')

  // A native implementation is never replaced, on the page or on the pair.
  const capable = webRealm({ natives: true })
  assert.equal(capable.evaluate('AbortSignal.any()'), 'native-any')
  assert.equal(capable.evaluate('new AbortController().signal.throwIfAborted()'), 'native-throw')
  assert.equal(capable.evaluate("URL.parse('x')"), 'native-parse')
  assert.equal(capable.pair.AbortSignal.prototype.throwIfAborted.call(undefined), 'native-throw')
  assert.equal(capable.RealmURL.parse('x'), 'native-parse')
})

// The transport gap. `@deepseek-ai/dsh-api-gateway/client` walks EVERY Remote
// stream with `signal.throwIfAborted()` and fuses cancellation with
// `AbortSignal.any([…])`, both without a feature test. On an engine missing
// either, the stream rejects inside the gateway, the multiplexed socket never
// delivers a baseline, and the sidebar's Workspaces, its Sessions and the Session
// Intent picker all stay on their loading state with nothing on screen to say so.
test('AbortSignal.prototype.throwIfAborted rethrows the signal reason, and an AbortError without one', () => {
  const { evaluate } = webRealm()
  assert.equal(evaluate('new AbortController().signal.throwIfAborted()'), undefined, 'a live signal returns')

  const reason = evaluate('(() => { const controller = new AbortController(); controller.abort("why"); try { controller.signal.throwIfAborted() } catch (error) { return error } })()')
  assert.equal(reason, 'why', 'the caller gets the reason it aborted with')

  // An engine that predates `signal.reason` has `aborted` and nothing else: the
  // spec's default AbortError is what must come out, never `undefined`.
  const fallback = evaluate('(() => { const signal = new AbortSignal(); signal.aborted = true; try { signal.throwIfAborted() } catch (error) { return { name: error.name, message: error.message, isError: error instanceof Error } } })()')
  assert.equal(fallback.name, 'AbortError')
  assert.equal(fallback.isError, true)
  assert.match(fallback.message, /abort/i)
  assert.equal(evaluate("Object.prototype.propertyIsEnumerable.call(AbortSignal.prototype, 'throwIfAborted')"), false)
})

test('AbortSignal.any fuses signals the way the gateway needs, and admits its inputs first', () => {
  const { evaluate, json } = webRealm()
  const fused = json(`(() => {
    const first = new AbortController(), second = new AbortController()
    const signal = AbortSignal.any([first.signal, second.signal])
    const before = signal.aborted
    second.abort('second-wins')
    return { before, after: signal.aborted, reason: signal.reason, first: first.signal.aborted }
  })()`)
  assert.deepEqual(fused, { before: false, after: true, reason: 'second-wins', first: false })

  // An already-aborted input aborts the result at once, with THAT reason — the
  // gateway opens its stream with a fused signal whose lifetime may already be
  // over, and a signal that merely "will" abort would open a doomed stream.
  assert.deepEqual(
    json(`(() => { const dead = new AbortController(); dead.abort('gone'); const live = new AbortController(); const signal = AbortSignal.any([dead.signal, live.signal]); return { aborted: signal.aborted, reason: signal.reason } })()`),
    { aborted: true, reason: 'gone' },
  )

  // Inputs are admitted as a whole: a bad element throws before anything is
  // listening, so a rejected call cannot leave half a fuse attached to a caller's
  // signal.
  assert.throws(() => evaluate('AbortSignal.any([new AbortController().signal, {}])'), { name: 'TypeError' })
  assert.throws(() => evaluate('AbortSignal.any(null)'), { name: 'TypeError' })
  assert.throws(() => evaluate('AbortSignal.any(42)'), { name: 'TypeError' })
  assert.equal(evaluate('(() => { const first = new AbortController(); try { AbortSignal.any([first.signal, 7]) } catch {} first.abort(); return first.signal.listeners.size })()'), 0, 'nothing was attached to the valid input')

  // An empty list is legal and never aborts.
  assert.equal(evaluate('AbortSignal.any([]).aborted'), false)
})

test('URL.parse answers null where new URL throws', () => {
  const { evaluate } = webRealm()
  assert.equal(evaluate("URL.parse('https://example.com/a').href"), 'https://example.com/a')
  assert.equal(evaluate("URL.parse('/a', 'https://example.com/b/c').href"), 'https://example.com/a')
  assert.equal(evaluate("URL.parse('not a url')"), null)
  assert.equal(evaluate("URL.parse('/a')"), null, 'a relative reference without a base is not absolute')
  assert.equal(evaluate("URL.parse(undefined)"), null, 'pdf.js passes whatever it found on the page')
})

test('Promise.withResolvers hands back the capability, and is inherited like the standard', async () => {
  const { evaluate } = webRealm()
  assert.equal(await evaluate('(() => { const c = Promise.withResolvers(); c.resolve(); return c.promise })()'), undefined)
  assert.equal(await evaluate('(() => { const c = Promise.withResolvers(); c.resolve("done"); return c.promise })()'), 'done')
  await assert.rejects(evaluate('(() => { const c = Promise.withResolvers(); c.reject(new Error("nope")); return c.promise })()'), /nope/)
  // `this`, not the captured Promise: a subclass that inherits the static must
  // get its own instances back, exactly as the standard specifies.
  assert.deepEqual(
    JSON.parse(evaluate('JSON.stringify((() => { class Sub extends Promise {} ; const capability = Sub.withResolvers(); return { isSub: capability.promise instanceof Sub, isPromise: capability.promise instanceof Promise, resolve: typeof capability.resolve, reject: typeof capability.reject } })())')),
    { isSub: true, isPromise: true, resolve: 'function', reject: 'function' },
  )
})

// The phone-side diagnostics read this: a page whose engine was missing one of
// these is the page whose lists never arrive, so the gap has to be nameable from
// the desktop log rather than inferred from a screenshot.
test('the page publishes which APIs its engine was missing, and nothing else', () => {
  // Node 24 has Iterator, Promise.try, Promise.withResolvers and URL.parse, so a
  // bare realm reports only its real gaps…
  const capable = realm([])
  assert.deepEqual(
    capable.json('window.__DSH_ENGINE__.missing'),
    ['Math.sumPrecise', 'Uint8Array.fromBase64', 'Uint8Array.fromHex', 'Uint8Array.prototype.toBase64', 'Uint8Array.prototype.toHex'],
  )
  assert.equal(capable.evaluate('typeof window.__DSH_ENGINE__.userAgent'), 'string')

  // …the ECMAScript shims are reported in install order…
  const bare = realm(MODERN)
  assert.deepEqual(bare.json('window.__DSH_ENGINE__.missing'), [
    'Iterator',
    'Promise.try',
    'Math.sumPrecise',
    'Promise.withResolvers',
    'Uint8Array.fromBase64',
    'Uint8Array.fromHex',
    'Uint8Array.prototype.toBase64',
    'Uint8Array.prototype.toHex',
  ])

  // …and the Web APIs a bare realm does not have at all are reported by the realm
  // that does have them unshimmed, alongside this process's own remaining gaps.
  const web = webRealm()
  assert.deepEqual(web.json('window.__DSH_ENGINE__.missing'), [
    'Math.sumPrecise',
    'AbortSignal.prototype.throwIfAborted',
    'AbortSignal.any',
    'Uint8Array.fromBase64',
    'Uint8Array.fromHex',
    'Uint8Array.prototype.toBase64',
    'Uint8Array.prototype.toHex',
    'URL.parse',
  ])

  // A second evaluation of the same row finds everything present: the report is
  // that pass's finding, never a stale accumulation.
  web.rerun()
  assert.deepEqual(web.json('window.__DSH_ENGINE__.missing'), [])
})

test('the shimmed Iterator IS the realm iterator prototype, so pdf.js own join lands on every iterator', () => {
  const { evaluate, json } = realm(MODERN)
  assert.equal(evaluate('Iterator.prototype === Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))'), true)
  assert.equal(evaluate('typeof Iterator'), 'function')
  assert.throws(() => evaluate('Iterator()'), { name: 'TypeError' })
  assert.throws(() => evaluate('new Iterator()'), { name: 'TypeError' })

  // The exact statement pdf.js runs at module scope, then the calls it makes.
  const joined = json(`(() => {
    if (typeof Iterator.prototype.join !== 'function') Iterator.prototype.join = function (separator) { return [...this].join(separator) }
    const arrayIterator = Object.getPrototypeOf([][Symbol.iterator]())
    return {
      values: [1, 2, 3].values().join('-'),
      keys: new Map([[1, 'a'], [2, 'b']]).keys().join(','),
      entries: new Set(['x', 'y']).entries().join('|'),
      generator: (function* () { yield 'a'; yield 'b' }()).join(''),
      fromArray: ['a', 'b'][Symbol.iterator]().join('+'),
      ownOnIterator: Object.prototype.hasOwnProperty.call(Iterator.prototype, 'join'),
      ownOnArrayIterator: Object.prototype.hasOwnProperty.call(arrayIterator, 'join'),
      arrayJoin: [1, 2].join('-'),
    }
  })()`)
  assert.deepEqual(joined, {
    values: '1-2-3',
    keys: '1,2',
    entries: 'x,x|y,y',
    generator: 'ab',
    fromArray: 'a+b',
    ownOnIterator: true,
    ownOnArrayIterator: false,
    arrayJoin: '1-2',
  })
})

// Without this the shim would be worse than nothing: `Iterator.prototype` would
// be a fresh object no iterator inherits from, pdf.js's assignment would be a
// silent no-op, and the failure would move to the first `join` call.
test('a fallback prototype is still a usable object when no built-in iterator prototype can be derived', () => {
  const { evaluate } = realm(MODERN)
  assert.equal(evaluate('Object.isExtensible(Iterator.prototype)'), true, 'pdf.js must be able to assign join onto it')
  assert.equal(evaluate('Object.getOwnPropertyDescriptor(Iterator, "prototype").writable'), false)
  assert.equal(evaluate('Object.getOwnPropertyDescriptor(Iterator, "prototype").configurable'), false)
})

test('Promise.try is specified behaviour: synchronous call, argument pass-through, throw becomes rejection', async () => {
  const { evaluate } = realm(MODERN)
  assert.equal(await evaluate('Promise.try((a, b) => a + b, 1, 2)'), 3)
  assert.equal(await evaluate('Promise.try(() => Promise.resolve("adopted"))'), 'adopted')
  assert.equal(evaluate('(() => { let called = false; const promise = Promise.try(() => { called = true }); return [called, promise instanceof Promise] })()')[0], true)
  await assert.rejects(evaluate('Promise.try(() => { throw new Error("boom") })'), /boom/)
  // A non-callable is a rejection, never a synchronous throw.
  await assert.rejects(evaluate('Promise.try(42)'), { name: 'TypeError' })
})

test('Math.sumPrecise is compensated, so a total no naive sum can hold still survives', () => {
  const { evaluate, json } = realm(MODERN)
  // Chromium's own answers, measured through tools/engine-shim-probe.mjs: an empty
  // list is -0, and any value at all normalises it to +0.
  assert.equal(evaluate('Object.is(Math.sumPrecise([]), -0)'), true)
  assert.equal(evaluate('Object.is(Math.sumPrecise([]), 0)'), false)
  assert.equal(evaluate('Object.is(Math.sumPrecise([-0]), 0)'), true)
  assert.equal(evaluate('Object.is(Math.sumPrecise([0, -0]), 0)'), true)
  assert.equal(json('Math.sumPrecise([1, 2, 3])'), 6)
  assert.equal(json('Math.sumPrecise([1, -1, 2.5])'), 2.5)
  assert.equal(json('Math.sumPrecise([1e100, 1, -1e100])'), 1, 'plain addition rounds this to 0')
  assert.equal(json('Math.sumPrecise([1e16, 1, -1e16])'), 1)
  assert.equal(json('Math.sumPrecise([0.1, 0.2])'), 0.30000000000000004)
  assert.equal(evaluate('Math.sumPrecise([NaN, 1])'), NaN)
  assert.equal(evaluate('Math.sumPrecise([Infinity, 1])'), Infinity)
  assert.equal(evaluate('Math.sumPrecise([Infinity, -Infinity])'), NaN)
  assert.throws(() => evaluate("Math.sumPrecise([1, '2'])"), { name: 'TypeError' })
})

// The one input whose answer is NOT the mathematically exact sum, pinned as a
// test rather than a comment so the shim is never read as specification-exact:
// the exact total is 1e308 and the intermediate 2e308 is not representable, so
// this is NaN. Chromium's native implementation answers NaN for it too — the
// same probe measures both — which is why this is a limit, not a divergence.
test('Math.sumPrecise pins the one input it does not answer with the exact sum', () => {
  const { evaluate } = realm(MODERN)
  assert.equal(evaluate('Math.sumPrecise([1e308, 1e308, -1e308])'), NaN)
  assert.equal(evaluate('Math.sumPrecise([1e100, 1, -1e100])'), 1, 'a cancellation it CAN hold is still exact')
})

test('Uint8Array base64 and hex codecs round-trip the exact bytes pdf.js hands them', () => {
  const { evaluate, json } = realm(MODERN)
  assert.deepEqual(json("Array.from(Uint8Array.fromBase64('aGVsbG8='))"), [104, 101, 108, 108, 111])
  assert.deepEqual(json("Array.from(Uint8Array.fromBase64('AAECAwQFBgcICQ=='))"), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(evaluate("Uint8Array.from([104, 101, 108, 108, 111]).toBase64()"), 'aGVsbG8=')
  assert.equal(evaluate('Uint8Array.from([]).toBase64()'), '')
  assert.equal(evaluate("Uint8Array.from([255, 0, 16]).toHex()"), 'ff0010')
  assert.equal(evaluate("Uint8Array.from([0, 171, 205]).toHex()"), '00abcd')
  assert.equal(evaluate('Uint8Array.from([]).toHex()'), '')
  assert.deepEqual(json("Array.from(Uint8Array.fromHex('ff0010'))"), [255, 0, 16])
  assert.deepEqual(json("Array.from(Uint8Array.fromHex('00ABcd'))"), [0, 171, 205])
  for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 8, 31, 64]) {
    const bytes = Array.from({ length }, (_, index) => (index * 37) & 0xff)
    const text = evaluate(`Uint8Array.from([${bytes}]).toBase64()`)
    assert.deepEqual(json(`Array.from(Uint8Array.fromBase64(${JSON.stringify(text)}))`), bytes, `round trip at length ${length}`)
    assert.deepEqual(json(`Array.from(Uint8Array.fromHex(Uint8Array.from([${bytes}]).toHex()))`), bytes, `hex round trip at length ${length}`)
  }
})

test('the codecs take base64 whitespace and reject what the native ones reject', () => {
  const { evaluate, json } = realm(MODERN)
  // "loose" last-chunk handling: missing padding is allowed, extra bits ignored.
  assert.deepEqual(json("Array.from(Uint8Array.fromBase64('aGVsbG8'))"), [104, 101, 108, 108, 111])
  assert.deepEqual(json("Array.from(Uint8Array.fromBase64(' aGVs\\nbG8=\\t'))"), [104, 101, 108, 108, 111])
  assert.throws(() => evaluate("Uint8Array.fromHex(' ff 00\\n10 ')"), { name: 'SyntaxError' }, 'hex, unlike base64, does not skip whitespace')
  assert.throws(() => evaluate("Uint8Array.fromBase64('a')"), { name: 'SyntaxError' })
  assert.throws(() => evaluate("Uint8Array.fromBase64('aGVsbG8=extra')"), { name: 'SyntaxError' })
  assert.throws(() => evaluate("Uint8Array.fromBase64('aGVsbG8===')"), { name: 'SyntaxError' })
  assert.throws(() => evaluate("Uint8Array.fromBase64('aGVs*bG8=')"), { name: 'SyntaxError' })
  assert.throws(() => evaluate("Uint8Array.fromHex('abc')"), { name: 'SyntaxError' })
  assert.throws(() => evaluate("Uint8Array.fromHex('zz')"), { name: 'SyntaxError' })
  assert.throws(() => evaluate('Uint8Array.fromBase64(42)'), { name: 'TypeError' })
  assert.throws(() => evaluate('Uint8Array.fromHex(42)'), { name: 'TypeError' })
  // The receivers are branded, exactly as the standard's are.
  assert.throws(() => evaluate('Uint8Array.prototype.toHex.call([])'), { name: 'TypeError' })
  assert.throws(() => evaluate('Uint8Array.prototype.toBase64.call("AA")'), { name: 'TypeError' })
  // Non-default options are REFUSED, never quietly answered as the default.
  assert.throws(() => evaluate("Uint8Array.fromBase64('aGVsbG8=', { alphabet: 'base64url' })"), { name: 'TypeError' })
  assert.throws(() => evaluate("Uint8Array.fromBase64('aGVsbG8=', { lastChunkHandling: 'strict' })"), { name: 'TypeError' })
  assert.throws(() => evaluate("Uint8Array.from([1, 2]).toBase64({ alphabet: 'base64url' })"), { name: 'TypeError' })
  assert.throws(() => evaluate("Uint8Array.from([1, 2]).toBase64({ omitPadding: true })"), { name: 'TypeError' })
  assert.equal(evaluate("Uint8Array.fromBase64('aGVsbG8=', { alphabet: 'base64' }).toHex()"), '68656c6c6f')
  assert.equal(evaluate("Uint8Array.from([1, 2]).toBase64({ omitPadding: false })"), 'AQI=')
  // Non-enumerable, so nothing that walks a typed array's properties sees them.
  assert.equal(evaluate("Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex').enumerable"), false)
  assert.equal(evaluate("Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64').enumerable"), false)
  assert.equal(evaluate("Uint8Array.from([1,2]).map(byte => byte).toHex()"), '0102', 'the methods survive a derived typed array')
})

// A worker is its own realm: a shim installed on the page is not there, and the
// document-preview plugin builds the pdf.js worker from a string at runtime —
// `URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))` —
// so the worker's own copy of pdf.js repeats the unguarded `Iterator` read.
test('a javascript blob script carries the shims into the worker realm it becomes', async () => {
  const created = []
  const stub = { createObjectURL(blob) { created.push(blob); return `blob:${created.length}` } }
  const original = stub.createObjectURL
  const plain = new Blob(['not a script'], { type: 'text/plain' })
  const typeless = new Blob(['no type'])
  const { evaluate } = realm(MODERN, { URL: stub, Blob, plainBlob: plain, typelessBlob: typeless })
  assert.notEqual(evaluate('URL.createObjectURL'), original, 'the seam is claimed')
  assert.equal(evaluate("URL.createObjectURL(new Blob(['self.postMessage(1)'], { type: 'text/javascript' }))"), 'blob:1')
  const wrapped = await created[0].text()
  assert.match(wrapped, /installEngineShims/)
  assert.match(wrapped, /globalThis/)
  assert.ok(wrapped.endsWith('self.postMessage(1)'), 'the original source is appended, never read or rewritten')
  assert.ok(wrapped.startsWith(';try{('), 'the shim cannot take the worker script down with it')

  // The wrapper really is executable, and executing it is what installs the shims.
  assert.equal(evaluate(`typeof new Function(${JSON.stringify(wrapped)})`), 'function')

  // Wrapped exactly once per blob, not once per call: the wrapper delegates to
  // the method it captured, so a wrapper built on top of a wrapper would recurse.
  assert.equal(evaluate("URL.createObjectURL(new Blob(['self.postMessage(2)'], { type: 'application/javascript' }))"), 'blob:2')
  const second = await created[1].text()
  assert.equal(second.match(/installEngineShims/g).length, 1)
  assert.ok(second.endsWith('self.postMessage(2)'))

  // Anything that is not a javascript blob is handed over untouched.
  assert.equal(evaluate('URL.createObjectURL(plainBlob)'), 'blob:3')
  assert.equal(created[2], plain)
  assert.equal(evaluate('URL.createObjectURL(typelessBlob)'), 'blob:4')
  assert.equal(created[3], typeless)
})

// The same page can evaluate this row more than once (a reload that reuses the
// document, an injected row rendered twice). The second pass must find every API
// already present and leave the seam alone: a second wrap would ship the shims
// into every worker twice — and, because the wrapper calls the method it
// captured, wrapping your own wrapper is unbounded recursion at the first blob.
test('a second evaluation installs nothing and does not claim the blob seam again', () => {
  const stub = { createObjectURL: () => 'blob:stub' }
  const first = realm(MODERN, { URL: stub, Blob })
  const claimed = first.evaluate('URL.createObjectURL')
  const iterator = first.evaluate('globalThis.Iterator')
  first.rerun()
  assert.equal(first.evaluate('URL.createObjectURL'), claimed)
  assert.equal(first.evaluate('globalThis.Iterator'), iterator)
  assert.equal(stub.createObjectURL(new Blob(['x'], { type: 'text/javascript' })), 'blob:stub')
})
