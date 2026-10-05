/**
 * The connection note — the overlay's on-page diagnosis for a phone page
 * whose session list cannot load.
 *
 * The note probes `/api/__dsh-desktop/connection-note`, an intentionally
 * unknown path under the `/api` prefix, so the request walks the same ladder
 * the session-list RPCs walk: the /api trust fence answers 403 for an
 * untrusted Host, browser auth answers 401 for a spent login, and the route
 * dispatcher's 404 is the healthy answer. A rejected fetch means the computer
 * is unreachable. Each diagnosis carries its own fix, because the upstream
 * connection pill reports all three as one bare "disconnected".
 *
 * These tests run the REAL script in a vm — the way `remote-quick-actions`
 * loads `dom.js` — against a document stub, a controllable fetch, and manual
 * timers, and hold five behaviours in place:
 *
 *   1. the probe ladder classifies exactly the statuses the /api route produces;
 *   2. each diagnosis names its fix, and `untrusted` names the host to paste;
 *   3. an unhealthy probe renders one note, and recovery removes it — so a
 *      backend restart explains itself and clears without a reload;
 *   4. re-rendering relabels the SAME element instead of stacking notes;
 *   5. 知了道 dismisses only the dismissed diagnosis: a changed failure is
 *      new information and is shown.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const source = readFileSync(new URL('./ui-overlay/connection-note.js', import.meta.url), 'utf8')
const HOST = 'desktop.local:3080'

/**
 * A fake element with the attribute, child, and listener bookkeeping the
 * note touches. `remove` only marks the element: a detached element must not
 * answer `getElementById` again, which is what the real DOM does.
 *
 * @param {string} tag - the tag name, for readability of failure output.
 * @returns {object} the element.
 */
function element(tag) {
  return {
    tag,
    id: '',
    removed: false,
    kids: [],
    listeners: {},
    style: {},
    className: '',
    type: '',
    textContent: '',
    setAttribute(name, value) { this['attr:' + name] = String(value) },
    getAttribute(name) { return this['attr:' + name] ?? null },
    appendChild(kid) { this.kids.push(kid); return kid },
    remove() { this.removed = true },
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn) },
  }
}

/**
 * A document stub whose `getElementById` skips removed elements, matching the
 * real DOM's behaviour the note's re-render path depends on.
 *
 * @returns {object} the stub, plus handles for driving it.
 */
function documentStub() {
  const created = []
  const listeners = {}
  const doc = {
    readyState: 'loading',
    hidden: false,
    head: element('head'),
    documentElement: element('html'),
    body: element('body'),
    createElement: tag => { const el = element(tag); created.push(el); return el },
    getElementById: id => created.find(el => el.id === id && !el.removed) ?? null,
    addEventListener: (name, fn) => { (listeners[name] ??= []).push(fn) },
    removeEventListener() {},
    dispatch(name) { for (const fn of listeners[name] ?? []) fn({}) },
  }
  return { doc, created }
}

/**
 * Run the real overlay script in a sandbox.
 *
 * @param {object} handles
 * @param {() => Promise<{status: number}> | (() => never)} [fetchImpl] - the
 *   fetch the probe sees; a thrown value models an unreachable computer.
 * @param {boolean} [iframe] - run as a nested frame, which the script exits on.
 * @param {Function} [WebSocket] - the page's socket constructor, if it has one.
 * @param {string[]} [engineGaps] - the APIs `browser-compat.js` had to shim.
 * @param {string[]} [engineAbsent] - the APIs it could not shim.
 * @returns {object} the window/document handles and the exposed test seam.
 */
function run({ fetchImpl = () => Promise.resolve({ status: 404 }), iframe = false, WebSocket, engineGaps, engineAbsent } = {}) {
  const { doc, created } = documentStub()
  let poll = null
  let fetchNow = fetchImpl
  const window = {
    location: { host: HOST, pathname: '/' },
    addEventListener(name, fn) { (window.listeners[name] ??= []).push(fn) },
    listeners: {},
    setInterval: fn => { poll = fn; return 7 },
    clearInterval() {},
    navigator: { userAgent: 'TestPhone/1.0 (WebKit)' },
  }
  window.top = iframe ? { window: 'parent' } : window
  window.document = doc
  if (WebSocket !== undefined) window.WebSocket = WebSocket
  if (engineGaps !== undefined || engineAbsent !== undefined) {
    window.__DSH_ENGINE__ = { missing: engineGaps ?? [], absent: engineAbsent ?? [], userAgent: window.navigator.userAgent }
  }
  // The script reads the sandbox's own `fetch` binding, so swaps go through
  // this indirection rather than a `window.fetch` property. Diagnostics posts are
  // captured instead of answered by the probe's stub: one fetch carries both jobs.
  const posted = []
  const sandbox = {
    window,
    document: doc,
    fetch: (url, init) => {
      if (String(url).indexOf('/__dsh-desktop/diag') !== -1) {
        posted.push(JSON.parse(init.body))
        return Promise.resolve({ status: 204 })
      }
      return fetchNow(url, init)
    },
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
  }
  vm.runInNewContext(source, sandbox)
  // The script runs in <head> while the document is still loading; the page
  // starts its polling only once the body exists.
  doc.readyState = 'complete'
  doc.dispatch('DOMContentLoaded')
  return {
    window,
    doc,
    created,
    poll,
    note: window.__DSH_CONNECTION_NOTE__,
    posted,
    /** Swap the fetch the probe sees, mid-flight. */
    setFetch(impl) { fetchNow = impl },
    /** Drive one poll cycle and settle its microtasks. */
    async tick() { await poll(); await new Promise(resolve => setImmediate(resolve)) },
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

test('the probe ladder matches the statuses the /api route produces', () => {
  const { note } = run()
  assert.equal(note.classify(403), 'untrusted')
  assert.equal(note.classify(401), 'unauthenticated')
  for (const status of [200, 204, 400, 404, 405, 499]) assert.equal(note.classify(status), 'ok', String(status))
  for (const status of [0, 500, 502, 503]) assert.equal(note.classify(status), 'unreachable', String(status))
})

test('a rejected probe means the computer is unreachable', async () => {
  const { note } = run({ fetchImpl: () => { throw new Error('down') } })
  assert.equal(await note.probe(), 'unreachable')
})

test('each diagnosis names its fix; the untrusted one names the host to paste', () => {
  const { note } = run()
  const untrusted = note.message('untrusted', HOST)
  assert.match(untrusted, /desktop\.local:3080/)
  assert.match(untrusted, /Host 白名单/)
  assert.match(untrusted, /手机端无法自行解除/)
  assert.match(note.message('unauthenticated', HOST), /重新复制完整链接|扫码/)
  assert.match(note.message('unreachable', HOST), /同一网络|防火墙/)
})

test('an unhealthy probe renders one note; recovery removes it', async () => {
  let status = 403
  const run1 = run({ fetchImpl: () => Promise.resolve({ status }) })
  await run1.tick()
  const noteEl = run1.doc.getElementById('dsh-connection-note')
  assert.ok(noteEl, 'the note is rendered')
  assert.equal(noteEl.getAttribute('role'), 'status')
  assert.equal(noteEl.getAttribute('data-dsh-connection-note'), 'untrusted')
  assert.ok(run1.created.some(el => el.id === 'dsh-connection-note-style'), 'the styling is injected once')
  const text = noteEl.kids.find(kid => kid.className === 'dshConn__text')
  assert.match(text.textContent, new RegExp(HOST))
  await run1.tick()
  assert.equal(run1.doc.getElementById('dsh-connection-note'), noteEl, 'a repeated diagnosis relabels, not stacks')
  status = 404
  await run1.tick()
  assert.equal(run1.doc.getElementById('dsh-connection-note'), null, 'recovery clears the note')
  assert.ok(noteEl.removed)
})

test('知道了 dismisses one diagnosis; a changed failure is still shown', async () => {
  const run1 = run({ fetchImpl: () => Promise.resolve({ status: 403 }) })
  await run1.tick()
  const noteEl = run1.doc.getElementById('dsh-connection-note')
  const close = noteEl.kids.find(kid => kid.tag === 'button')
  assert.equal(close.textContent, '知道了')
  close.listeners.click[0]()
  assert.ok(noteEl.removed, 'dismissal removes the note')
  await run1.tick()
  assert.equal(run1.doc.getElementById('dsh-connection-note'), null, 'the same diagnosis stays dismissed')
  // A different diagnosis is new information: the network dying after the
  // user dismissed an untrusted-host note must still be surfaced.
  run1.setFetch(() => { throw new Error('down') })
  await run1.tick()
  const shown = run1.doc.getElementById('dsh-connection-note')
  assert.ok(shown, 'the new diagnosis is shown')
  assert.equal(shown.getAttribute('data-dsh-connection-note'), 'unreachable')
})

test('a hidden tab does not poll; becoming visible probes again', async () => {
  let status = 404
  const run1 = run({ fetchImpl: () => Promise.resolve({ status }) })
  await run1.tick()
  assert.equal(run1.doc.getElementById('dsh-connection-note'), null)
  run1.doc.hidden = true
  status = 403
  await run1.tick()
  assert.equal(run1.doc.getElementById('dsh-connection-note'), null, 'no probe ran while hidden')
  run1.doc.hidden = false
  run1.doc.dispatch('visibilitychange')
  await flush()
  const shown = run1.doc.getElementById('dsh-connection-note')
  assert.equal(shown?.getAttribute('data-dsh-connection-note'), 'untrusted', 'visible again → the probe fires')
})

test('a nested frame mounts nothing', () => {
  const run1 = run({ iframe: true })
  assert.equal(run1.window.__DSH_CONNECTION_NOTE__, undefined)
})

// ── the quiet failure: reachable, but nothing is delivered ───────────────────
//
// The report this answers: the phone page paints, 设置 → 远程控制 says the LAN
// service is fine, no error appears anywhere, and the Workspaces and Sessions
// never load. Every HTTP request succeeds; the Remote streams that carry the
// lists never deliver a frame, because the phone's engine lacks an AbortSignal /
// Promise API the client-side API gateway calls without a feature test. The HTTP
// ladder alone cannot tell that apart from health — which is why the channel gets
// a vote.

test('a page that is reachable but never receives a frame is diagnosed as stalled', () => {
  const { note } = run()
  assert.equal(note.diagnose('ok', { delivered: false, elapsedMs: 0 }), 'ok', 'the page is still booting')
  assert.equal(note.diagnose('ok', { delivered: false, elapsedMs: note.stallAfterMs - 1 }), 'ok')
  assert.equal(note.diagnose('ok', { delivered: false, elapsedMs: note.stallAfterMs }), 'stalled')
  assert.equal(note.diagnose('ok', { delivered: true, elapsedMs: 999999 }), 'ok', 'one frame is proof the channel works')
  // The HTTP ladder outranks the channel: a 403 is a fence problem, not a stall.
  for (const kind of ['untrusted', 'unauthenticated', 'unreachable']) {
    assert.equal(note.diagnose(kind, { delivered: false, elapsedMs: 999999 }), kind)
  }
})

test('the stall note names the engine gap, the fix, and what it could not close', () => {
  const { note } = run({ engineGaps: ['AbortSignal.prototype.throwIfAborted', 'AbortSignal.any', 'Iterator', 'URL.parse'] })
  const text = note.message('stalled', HOST, note.engineFacts())
  assert.match(text, /实时通道/)
  assert.match(text, /工作区与会话列表/)
  assert.match(text, /缺少 4 个较新的 API/)
  assert.match(text, /AbortSignal\.prototype\.throwIfAborted、AbortSignal\.any、Iterator 等/)
  assert.doesNotMatch(text, /URL\.parse/, 'the list is sampled; the log carries all of it')
  assert.doesNotMatch(text, /无法补齐/, 'an engine this page could close entirely is not accused of anything')
  assert.match(text, /desktop-diag\.log/)
  assert.match(text, /下拉刷新/)

  // An API nobody shimmed is a different sentence: the page must not claim it
  // closed something it could not.
  const withAbsent = note.message('stalled', HOST, { missing: ['AbortSignal.any'], absent: ['structuredClone', 'Object.groupBy'] })
  assert.match(withAbsent, /另有 2 个较新的 API 本页无法补齐/)
  assert.match(withAbsent, /页面已自行补齐/)

  // Without any gap the sentences about the engine are absent, not empty: an
  // engine this page cannot explain must not be blamed.
  const generic = note.message('stalled', HOST, { missing: [], absent: [] })
  assert.doesNotMatch(generic, /浏览器引擎缺少/)
  assert.doesNotMatch(generic, /无法补齐/)
  assert.match(note.message('stalled', HOST), /实时通道/, 'facts are optional')
})

test('the page watches its own sockets, and only claims the ones it can observe', async () => {
  const sockets = []
  class FakeSocket {
    constructor(url) { this.url = url; this.listeners = {}; sockets.push(this) }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn) }
    emit(name, event) { for (const fn of this.listeners[name] ?? []) fn(event) }
  }
  const { window, note } = run({ WebSocket: FakeSocket })
  const first = new window.WebSocket('ws://host/api/remote.mux')
  const second = new window.WebSocket('ws://host/api/remote.mux')
  assert.equal(first instanceof FakeSocket, true, 'the wrapper hands back the native instance')
  assert.equal(note.channel.sockets, 2)
  assert.equal(note.diagnose('ok', undefined), 'ok', 'no frames yet, but the page is fresh')
  first.emit('open', {})
  assert.equal(note.channel.opened, 1)
  first.emit('message', { data: 'frame' })
  second.emit('message', { data: 'frame' })
  assert.equal(note.channel.frames, 2)
  // With a frame on the wire, no elapsed time can produce a stall.
  assert.equal(note.diagnose('ok', { delivered: note.channel.frames > 0, elapsedMs: 999999 }), 'ok')
})

test('a page with no observable socket reports nothing rather than stalling', () => {
  // `WebSocket` absent (an old engine, a test page): the channel cannot be
  // judged, and a diagnosis that cannot be judged must not be invented.
  const { note } = run()
  assert.equal(note.channel.sockets, 0)
  assert.equal(note.diagnose('ok', { delivered: false, elapsedMs: note.stallAfterMs * 10 }), 'stalled', 'the clock still decides')
})

test('a stall is written to the desktop log once, naming the engine gap', async () => {
  const run1 = run({ engineGaps: ['AbortSignal.any'] })
  await flush()
  run1.posted.length = 0
  await run1.tick()
  assert.deepEqual(run1.posted, [], 'a fresh page is not stalled yet')

  // Move the page's clock past the stall window and poll again: the note appears
  // AND the log gets one line naming the gap, while a second poll adds nothing.
  run1.note.setClock(() => run1.note.startedAt + run1.note.stallAfterMs + 1)
  await run1.tick()
  const shown = run1.doc.getElementById('dsh-connection-note')
  assert.equal(shown?.getAttribute('data-dsh-connection-note'), 'stalled')
  assert.match(shown.kids.find(kid => kid.className === 'dshConn__text').textContent, /AbortSignal\.any/)
  assert.equal(run1.posted.length, 1)
  assert.equal(run1.posted[0].kind, 'stall')
  assert.equal(run1.posted[0].source, 'phone')
  assert.equal(run1.posted[0].frames, 0)
  assert.deepEqual(run1.posted[0].missing, ['AbortSignal.any'])
  assert.deepEqual(run1.posted[0].absent, [], 'nothing was left open by the shims')
  assert.equal(run1.posted[0].host, HOST)
  assert.equal(run1.posted[0].userAgent, 'TestPhone/1.0 (WebKit)')
  assert.match(run1.posted[0].v, /^connection-note-diag1$/)
  assert.ok(typeof run1.posted[0].at === 'string')

  await run1.tick()
  assert.equal(run1.posted.length, 1, 'a stall cannot change by polling')
})

test('the engine gaps are reported on load, before the lists can fail', async () => {
  const withGaps = run({ engineGaps: ['Iterator', 'AbortSignal.any'], engineAbsent: ['structuredClone'] })
  await flush()
  assert.equal(withGaps.posted.length, 1)
  assert.equal(withGaps.posted[0].kind, 'engine')
  assert.deepEqual(withGaps.posted[0].missing, ['Iterator', 'AbortSignal.any'])
  assert.deepEqual(withGaps.posted[0].absent, ['structuredClone'])
  assert.equal(withGaps.posted[0].host, HOST)

  // A capable engine writes nothing: the log stays a record of exceptions.
  const clean = run()
  await flush()
  assert.deepEqual(clean.posted, [])
})
