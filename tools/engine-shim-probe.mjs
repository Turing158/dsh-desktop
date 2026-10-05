/**
 * Prove the engine shims against a real engine, the real served bundle, and a
 * real worker realm.
 *
 * `node --test` cannot answer these three, and they are the ones that matter:
 *
 *   1. DO THE SHIMS AGREE WITH A NATIVE IMPLEMENTATION? Chromium's own base64,
 *      hex and Math.sumPrecise are the reference the phone's newer siblings
 *      have, so each shim is compared with the native it replaces, case by case,
 *      in one page.
 *   2. DOES THE REAL BUNDLE STILL FAIL WITHOUT `Iterator`? The installed
 *      `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js` is
 *      loaded twice in one page — once with `Iterator` deleted, once with the
 *      shim — and its factory is called, which is what the plugin loader does
 *      when it reports "failed to import loader entry … Can't find variable:
 *      Iterator" on a phone.
 *   3. DOES THE WORKER REALM FAIL THE SAME WAY? The plugin builds the pdf.js
 *      worker from a string and runs it as a blob MODULE worker. A second realm
 *      inherits nothing from the page, and this probe cannot delete a global out
 *      of a worker from outside either — so the worker deletes `Iterator` on
 *      itself, which is the phone's engine, and the seam's own output is then
 *      re-run there to repair it.
 *
 * Run: node tools/engine-shim-probe.mjs
 * Requires Edge (set EDGE_PATH for a custom installation) and an installed
 * document-preview bundle ($DSH_HOME, or ~/.dsh).
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const edgePath = process.env.EDGE_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync)
assert.ok(edgePath, 'Edge is required; set EDGE_PATH for a custom installation')

const shim = readFileSync(new URL('../dsh-plugin/ui-overlay/browser-compat.js', import.meta.url), 'utf8')

const home = process.env.DSH_HOME || join(process.env.USERPROFILE, '.dsh')
const bundlePath = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar-documentpreview', 'lib', 'client.js')
const bundle = existsSync(bundlePath) ? readFileSync(bundlePath, 'utf8') : null

/** The unguarded read that threw on the phone, transcribed from that bundle. */
const PDFJS_STATEMENT = `if (typeof Iterator.prototype.join !== "function") Iterator.prototype.join = function(separator) {
  return [...this].join(separator);
};`

const NATIVES = [
  'globalThis.Iterator',
  'globalThis.Promise.try',
  'globalThis.Promise.withResolvers',
  'globalThis.Math.sumPrecise',
  'globalThis.AbortSignal.prototype.throwIfAborted',
  'globalThis.AbortSignal.any',
  'globalThis.Uint8Array.fromBase64',
  'globalThis.Uint8Array.fromHex',
  'globalThis.Uint8Array.prototype.toBase64',
  'globalThis.Uint8Array.prototype.toHex',
  'globalThis.URL.parse',
]

// ── corpora ──────────────────────────────────────────────────────────────────
const base64Corpus = [
  '', '=', '==', 'A', 'AA', 'AA=', 'AA==', 'AAA', 'AAA=', 'AAAA', 'aGVsbG8=', 'aGVsbG8', 'aGVsbG8==',
  'aGVsbG8===', 'aGVsbG8=extra', ' aGVs\nbG8=\t', 'aGVs*bG8=', 'aGVs-bG8=', '////', '++++', '____',
  'AAECAwQFBgcICQ==', 'YWJj', 'YWJjZA==', 'YWJjZGU=', 'AB', 'ABC',
]
const hexCorpus = ['', '0', '00', 'ff', 'FF', 'aB', '0011ff', ' ff 00\n10 ', 'ff 00', 'ff\n00', 'abc', 'zz', '0x11', '000102030405']
const encodeCorpus = [[], [0], [1, 2, 3], [255, 0, 16], [104, 101, 108, 108, 111], Array.from({ length: 40 }, (_, index) => (index * 53) & 255)]
for (let length = 0; length <= 33; length++) {
  const bytes = Array.from({ length }, (_, index) => (index * 37 + 11) & 0xff)
  base64Corpus.push(Buffer.from(bytes).toString('base64'))
  base64Corpus.push(Buffer.from(bytes).toString('base64url'))
  hexCorpus.push(Buffer.from(bytes).toString('hex'))
}
const sums = [
  [], [0], [-0], [-0, -0], [0, -0], [1], [1, 2, 3], [1.5, -2.25], [0.1, 0.2], [0.1, 0.2, 0.3],
  [1e100, 1, -1e100], [Number.MAX_SAFE_INTEGER, 1], [1e-320, 1e-320], [255, 0, 16],
  [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], [1 / 3, 1 / 7, 1 / 11], [1e16, 1, -1e16],
  [Infinity], [Infinity, 1], [Infinity, -Infinity], [NaN, 1], [1, NaN, 2],
]
/**
 * Sum inputs whose answer is allowed to differ from Chromium's. EMPTY, and meant
 * to stay that way: the shim agreed on every case, including the empty list and
 * the intermediate overflow. It exists so that a future disagreement has to be
 * argued here and printed, rather than quietly weakening the comparison.
 */
const knownSumDivergences = []

/**
 * `AbortSignal.any` scenarios. Each one builds its argument, may pre-abort an
 * input, fuses, then may abort an input afterwards — and the state of the fused
 * signal is what must match the native implementation case by case.
 */
const anyCorpus = [
  { label: 'no signals', shape: 'array', pre: [], abort: [] },
  { label: 'two live signals', shape: 'array', pre: [], abort: [] },
  { label: 'abort the second after fusing', shape: 'array', pre: [], abort: [1] },
  { label: 'abort the first after fusing', shape: 'array', pre: [], abort: [0] },
  { label: 'abort both after fusing', shape: 'array', pre: [], abort: [0, 1] },
  { label: 'first already aborted', shape: 'array', pre: [0], abort: [] },
  { label: 'both already aborted', shape: 'array', pre: [0, 1], abort: [] },
  { label: 'second already aborted', shape: 'array', pre: [1], abort: [] },
  { label: 'a Set of signals', shape: 'set', pre: [], abort: [0] },
  { label: 'a generator of signals', shape: 'generator', pre: [], abort: [1] },
  { label: 'undefined', shape: 'undefined', pre: [], abort: [] },
  { label: 'null', shape: 'null', pre: [], abort: [] },
  { label: 'a number', shape: 'number', pre: [], abort: [] },
  { label: 'a string', shape: 'string', pre: [], abort: [] },
  { label: 'a non-signal element', shape: 'mixed', pre: [], abort: [] },
]

/** `AbortSignal.prototype.throwIfAborted` scenarios, including the default reason. */
const throwCorpus = [
  { label: 'a live signal', abort: false },
  { label: 'a string reason', abort: true, reason: 'why' },
  { label: 'no reason at all', abort: true },
  { label: 'an Error reason', abort: true, error: 'boom' },
]

/** `URL.parse` inputs, with the base each is parsed against (or none). */
const parseCorpus = [
  ['https://example.com/a', null],
  ['/a', 'https://example.com/b/c'],
  ['/a', null],
  ['not a url', null],
  ['', null],
  ['', 'https://example.com/'],
  ['#frag', 'https://example.com/x'],
  ['?q=1', 'https://example.com/x'],
  ['//host/path', 'https://example.com/x'],
  ['https://例え.jp/パス', null],
  ['mailto:a@b.c', null],
  ['http://[::1]:8080/x', null],
  ['x', 'not a base'],
  ['/x', null],
  ['https://a b/', null],
  ['ftp://host/path', 'https://example.com/'],
  ['HTTP://EXAMPLE.COM/A?B#C', null],
]

// ── fixture ──────────────────────────────────────────────────────────────────
const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>engine shim probe</title></head>
<body>
<script>
window.__entry = undefined
window.__rawSeam = URL.createObjectURL
window.__ModuleLoader__ = { load(entry) { window.__entry = entry } }
// A module registry that answers anything: the bundle factory's top level only
// asks its dependencies for names, and none of them is executed here.
window.__requireStub = new Proxy(function () {}, {
  get: (target, key) => (key === Symbol.toPrimitive || key === 'then' ? undefined : window.__requireStub),
  apply: () => window.__requireStub,
  construct: () => window.__requireStub,
})
window.__probe = {
  deleteModern() { for (const path of ${JSON.stringify(NATIVES)}) (0, eval)('delete ' + path) },
  installShim() { (0, eval)(${JSON.stringify(shim)}) },
  typeOfAll() { const types = {}; for (const path of ${JSON.stringify(NATIVES)}) types[path] = eval('typeof ' + path); return types },
  async loadBundle(bust) {
    delete window.__entry
    await new Promise((resolve) => {
      const script = document.createElement('script')
      script.src = '/client.js?bust=' + bust
      script.onload = resolve
      script.onerror = resolve
      document.head.append(script)
    })
    if (!window.__entry) return { error: 'the bundle did not register a loader entry' }
    try { window.__entry.factory(window.__requireStub); return { ok: true } }
    catch (error) { return { error: String(error) } }
  },
  async runWorker(source, seam) {
    const create = seam ? URL.createObjectURL : window.__rawSeam
    const url = create.call(URL, new Blob([source], { type: 'text/javascript' }))
    const worker = new Worker(url, { type: 'module', name: 'probe-pdf' })
    const outcome = await new Promise((resolve) => {
      worker.addEventListener('message', (event) => resolve({ message: event.data }))
      worker.addEventListener('error', (event) => resolve({ error: String(event.message || event) }))
      setTimeout(() => resolve({ error: 'timeout' }), 5000)
    })
    worker.terminate()
    URL.revokeObjectURL(url)
    return outcome
  },
  /** Exactly what the blob seam prepends to a javascript blob, as source text. */
  async seamPrefix() {
    const marker = '/*dsh-probe-marker*/'
    const url = URL.createObjectURL(new Blob([marker], { type: 'text/javascript' }))
    const wrapped = await (await fetch(url)).text()
    URL.revokeObjectURL(url)
    if (!wrapped.endsWith(marker)) return null
    return wrapped.slice(0, wrapped.length - marker.length)
  },
}
</script>
</body></html>`

const workerSource = (body) => `const native = typeof Iterator\n${body.map((line) => line.trim()).join('\n')}\n`
const controlWorker = workerSource([
  `let broken = null`,
  `delete globalThis.Iterator`,
  `try { ${PDFJS_STATEMENT} } catch (error) { broken = String(error) }`,
  `self.postMessage({ native, broken })`,
])

// ── server, browser, CDP ─────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'dsh-engine-shim-probe-'))
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname
  if (path === '/client.js' && bundle !== null) {
    response.writeHead(200, { 'content-type': 'text/javascript' })
    return response.end(bundle)
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(FIXTURE)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}/`

const edge = spawn(edgePath, [
  '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + join(dir, 'profile'),
  '--no-first-run', '--disable-gpu', '--window-size=900,700', origin,
], { stdio: 'ignore', windowsHide: true })
const stopped = once(edge, 'exit').catch(() => {})
let launchError
edge.on('error', (error) => { launchError = error })
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

let send
try {
  const activePort = join(dir, 'profile', 'DevToolsActivePort')
  for (let attempt = 0; !existsSync(activePort); attempt++) {
    if (launchError) throw launchError
    assert.ok(attempt < 100 && edge.exitCode === null, 'Edge did not start')
    await delay(100)
  }
  const port = Number(readFileSync(activePort, 'utf8').split('\n')[0])
  let target
  for (let attempt = 0; target === undefined; attempt++) {
    assert.ok(attempt < 50, 'The probe page never appeared')
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    target = targets.find((page) => page.type === 'page' && page.url.startsWith(origin))
    if (target === undefined) await delay(100)
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail })
  let nextId = 0
  const pending = new Map()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data), waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    message.error ? waiter.fail(Error(message.error.message)) : waiter.done(message.result)
  }
  send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); fail(Error('CDP timed out: ' + method)) }, 30000)
    pending.set(id, { done, fail, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    for (let attempt = 0; ; attempt++) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (!result.exceptionDetails) return result.result.value
      const message = result.exceptionDetails.exception?.description || 'Page error'
      // A navigation in flight destroys the context; the retry re-reads it.
      if (attempt >= 20 || !/Execution context was destroyed|Cannot find context/.test(message)) throw Error(message)
      await delay(100)
    }
  }
  /** A fresh realm for every phase: navigation is what restores deleted globals. */
  const fresh = async () => {
    await send('Page.navigate', { url: origin })
    for (let attempt = 0; !(await evaluate('document.readyState === "complete" && !!window.__probe')); attempt++) {
      assert.ok(attempt < 60, 'The probe page did not load')
      await delay(100)
    }
  }

  const FAILURES = []
  const check = (condition, message, detail) => {
    if (condition) return console.log(`  ok   ${message}`)
    FAILURES.push(message)
    console.log(`  FAIL ${message}${detail === undefined ? '' : ' — ' + detail}`)
  }

  // ── 1. What does this engine ship, and does the shim touch what it has? ────
  await fresh()
  const before = await evaluate(`(() => { window.__seamBefore = URL.createObjectURL; return { version: navigator.userAgent, types: window.__probe.typeOfAll() } })()`)
  const after = await evaluate(`(() => { window.__probe.installShim(); return { types: window.__probe.typeOfAll(), seamClaimed: URL.createObjectURL !== window.__seamBefore } })()`)
  const missing = Object.entries(before.types).filter(([, type]) => type === 'undefined').map(([path]) => path)
  console.log(`engine: ${before.version}`)
  console.log(`native: ${JSON.stringify(before.types)}`)
  check(Object.values(after.types).every((type) => type === 'function'), 'every shimmed API is a function once the shim has run', JSON.stringify(after.types))
  if (missing.length === 0) check(after.seamClaimed === false, 'an engine that ships them all keeps its own URL.createObjectURL')
  else console.log(`  note  this engine is missing ${missing.join(', ')} — the seam is claimed here, and the phone's engine is older still`)

  // ── 2. Do the shims answer exactly what the native implementations answer? ─
  await fresh()
  const differential = await evaluate(`(async () => {
    const natives = {
      fromBase64: Uint8Array.fromBase64, fromHex: Uint8Array.fromHex,
      toBase64: Uint8Array.prototype.toBase64, toHex: Uint8Array.prototype.toHex,
      sumPrecise: Math.sumPrecise, withResolvers: Promise.withResolvers,
      throwIfAborted: AbortSignal.prototype.throwIfAborted, any: AbortSignal.any,
      urlParse: URL.parse,
    }
    const available = {}
    for (const [name, fn] of Object.entries(natives)) available[name] = typeof fn === 'function'
    const answer = (fn) => { try { return { value: fn() } } catch (error) { return { threw: error.name } } }
    const describe = (result) => result.threw !== undefined ? 'threw ' + result.threw
      : (typeof result.value === 'number' ? (Number.isNaN(result.value) ? 'NaN' : Object.is(result.value, -0) ? '-0' : String(result.value)) : JSON.stringify(Array.from(result.value)))
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
    /** A reason compared by what a caller can read off it, never by object identity. */
    const reasonText = (reason) => reason === undefined ? 'undefined'
      : (reason !== null && typeof reason === 'object' && reason.name !== undefined ? String(reason.name) + ': ' + String(reason.message) : String(reason))
    const signalState = (signal) => ({ aborted: signal.aborted, reason: reasonText(signal.reason) })
    const buildArgument = (shape, controllers) => {
      const list = [controllers[0].signal, controllers[1].signal]
      if (shape === 'set') return new Set(list)
      if (shape === 'generator') return (function * () { yield list[0]; yield list[1] })()
      if (shape === 'undefined') return undefined
      if (shape === 'null') return null
      if (shape === 'number') return 42
      if (shape === 'string') return 'ab'
      if (shape === 'mixed') return [list[0], {}]
      return list
    }
    const anyCase = (fn, spec) => {
      const controllers = [new AbortController(), new AbortController()]
      for (const index of spec.pre) controllers[index].abort('pre-' + index)
      try {
        const signal = fn(buildArgument(spec.shape, controllers))
        for (const index of spec.abort) controllers[index].abort('post-' + index)
        return signalState(signal)
      } catch (error) { return { threw: error.name } }
    }
    const throwCase = (fn, spec) => {
      const controller = new AbortController()
      if (spec.abort) controller.abort(spec.reason !== undefined ? spec.reason : (spec.error !== undefined ? new Error(spec.error) : undefined))
      try { fn.call(controller.signal); return 'returned' } catch (error) { return 'threw ' + reasonText(error) }
    }
    // A static is called as a METHOD everywhere on the page (Promise.withResolvers());
    // called as a bare function its 'this' is undefined, which both the standard
    // and the shim refuse. The receiver is therefore passed explicitly.
    const withResolversCase = async (fn, receiver) => {
      const outcome = {}
      const resolved = fn.call(receiver); resolved.resolve('value'); outcome.resolved = await resolved.promise
      const rejected = fn.call(receiver); rejected.reject(new TypeError('nope'))
      outcome.rejected = await rejected.promise.then(() => 'resolved', (error) => error.name + ': ' + error.message)
      class Sub extends Promise {}
      try {
        const sub = fn.call(Sub)
        outcome.subclass = { isSub: sub.promise instanceof Sub, isPromise: sub.promise instanceof Promise }
      } catch (error) { outcome.subclass = 'threw ' + error.name }
      try { fn.call({}); outcome.nonConstructor = 'returned' } catch (error) { outcome.nonConstructor = 'threw ' + error.name }
      try { fn(); outcome.noReceiver = 'returned' } catch (error) { outcome.noReceiver = 'threw ' + error.name }
      // A capability is usable exactly once per side, as the standard's is.
      const once = fn.call(receiver); once.resolve('first'); once.resolve('second'); once.reject(new Error('late'))
      outcome.firstWins = await once.promise
      return outcome
    }
    const parseCase = (fn, [url, base]) => {
      try {
        const parsed = base === null ? fn(url) : fn(url, base)
        return parsed === null ? null : parsed.href
      } catch (error) { return 'threw ' + error.name }
    }
    window.__probe.deleteModern()
    window.__probe.installShim()
    const report = { available, base64: [], hex: [], sums: [], any: [], throwIf: [], withResolvers: [], urlParse: [] }
    if (available.fromBase64) for (const text of ${JSON.stringify(base64Corpus)}) {
      const native = answer(() => natives.fromBase64(text))
      const shimmed = answer(() => Uint8Array.fromBase64(text))
      if (!same(native, shimmed)) report.base64.push({ text, native: describe(native), shimmed: describe(shimmed) })
    }
    if (available.fromHex) for (const text of ${JSON.stringify(hexCorpus)}) {
      const native = answer(() => natives.fromHex(text))
      const shimmed = answer(() => Uint8Array.fromHex(text))
      if (!same(native, shimmed)) report.hex.push({ decode: text, native: describe(native), shimmed: describe(shimmed) })
    }
    if (available.toBase64) for (const values of ${JSON.stringify(encodeCorpus)}) {
      const native = answer(() => natives.toBase64.call(Uint8Array.from(values)))
      const shimmed = answer(() => Uint8Array.from(values).toBase64())
      if (!same(native, shimmed)) report.base64.push({ encode: values, native: describe(native), shimmed: describe(shimmed) })
    }
    if (available.toHex) for (const values of ${JSON.stringify(encodeCorpus)}) {
      const native = answer(() => natives.toHex.call(Uint8Array.from(values)))
      const shimmed = answer(() => Uint8Array.from(values).toHex())
      if (!same(native, shimmed)) report.hex.push({ encode: values, native: describe(native), shimmed: describe(shimmed) })
    }
    if (available.sumPrecise) for (const numbers of ${JSON.stringify(sums)}) {
      const native = answer(() => natives.sumPrecise(numbers))
      const shimmed = answer(() => Math.sumPrecise(numbers))
      if (describe(native) !== describe(shimmed)) report.sums.push({ numbers, native: describe(native), shimmed: describe(shimmed) })
    }
    for (const spec of ${JSON.stringify(anyCorpus)}) {
      const native = anyCase(natives.any, spec)
      const shimmed = anyCase(AbortSignal.any, spec)
      if (JSON.stringify(native) !== JSON.stringify(shimmed)) report.any.push({ label: spec.label, native, shimmed })
    }
    for (const spec of ${JSON.stringify(throwCorpus)}) {
      const native = throwCase(natives.throwIfAborted, spec)
      const shimmed = throwCase(AbortSignal.prototype.throwIfAborted, spec)
      if (native !== shimmed) report.throwIf.push({ label: spec.label, native, shimmed })
    }
    if (available.withResolvers) {
      const native = await withResolversCase(natives.withResolvers, Promise)
      const shimmed = await withResolversCase(Promise.withResolvers, Promise)
      if (JSON.stringify(native) !== JSON.stringify(shimmed)) report.withResolvers.push({ native, shimmed })
    }
    if (available.urlParse) for (const entry of ${JSON.stringify(parseCorpus)}) {
      const native = parseCase(natives.urlParse, entry)
      const shimmed = parseCase(URL.parse, entry)
      if (native !== shimmed) report.urlParse.push({ input: entry, native, shimmed })
    }
    return report
  })()`)
  for (const [name, available] of Object.entries(differential.available)) {
    if (!available) console.log(`  skip  this engine has no native ${name} to compare against`)
  }
  if (differential.available.fromBase64 || differential.available.toBase64) {
    check(differential.base64.length === 0, `base64 codec agrees with the native one on ${base64Corpus.length + encodeCorpus.length} inputs`, JSON.stringify(differential.base64.slice(0, 4)))
  }
  if (differential.available.fromHex || differential.available.toHex) {
    check(differential.hex.length === 0, `hex codec agrees with the native one on ${hexCorpus.length + encodeCorpus.length} inputs`, JSON.stringify(differential.hex.slice(0, 4)))
  }
  if (differential.available.sumPrecise) {
    const unexpected = differential.sums.filter((mismatch) => !knownSumDivergences.some((numbers) => JSON.stringify(numbers) === JSON.stringify(mismatch.numbers)))
    for (const mismatch of differential.sums) {
      if (unexpected.includes(mismatch)) continue
      console.log(`  note  accepted sum divergence ${JSON.stringify(mismatch.numbers)}: native ${mismatch.native}, shim ${mismatch.shimmed}`)
    }
    check(unexpected.length === 0, `Math.sumPrecise agrees with the native one on all ${sums.length} inputs`, JSON.stringify(unexpected.slice(0, 6)))
  }
  // The transport APIs: `AbortSignal.any` and `throwIfAborted` are what the
  // client-side API gateway walks every Remote stream through, and
  // `Promise.withResolvers` is what its timer helpers park on. Agreement here is
  // what makes the shim a substitute rather than a different behaviour.
  check(differential.any.length === 0, `AbortSignal.any agrees with the native one on all ${anyCorpus.length} scenarios`, JSON.stringify(differential.any.slice(0, 5)))
  check(differential.throwIf.length === 0, `AbortSignal.prototype.throwIfAborted agrees on all ${throwCorpus.length} cases`, JSON.stringify(differential.throwIf.slice(0, 5)))
  if (differential.available.withResolvers) {
    check(differential.withResolvers.length === 0, 'Promise.withResolvers agrees with the native one, including `this` and the first settlement', JSON.stringify(differential.withResolvers))
  }
  if (differential.available.urlParse) {
    check(differential.urlParse.length === 0, `URL.parse agrees with the native one on all ${parseCorpus.length} inputs, null included`, JSON.stringify(differential.urlParse.slice(0, 5)))
  }

  // ── 3. The real worker realm, and the real bundle, without and with shims ──
  await fresh()
  const control = await evaluate(`window.__probe.deleteModern(); window.__probe.runWorker(${JSON.stringify(controlWorker)}, false)`)
  console.log(`  info  the control realm shipped Iterator natively: ${control.message?.native ?? 'unknown'}; after deleting it: ${control.message?.broken ?? control.error}`)
  check(
    /Iterator/.test(control.message?.broken || ''),
    'a worker realm without Iterator dies on the pdf.js statement, as the phone did',
    JSON.stringify(control),
  )

  let bundleWithout
  if (bundle === null) console.log(`  skip  no installed bundle at ${bundlePath}`)
  else {
    bundleWithout = await evaluate('window.__probe.loadBundle(1)')
    check(
      /Iterator/.test(bundleWithout.error || ''),
      'the installed document-preview factory throws the phone error when Iterator is missing',
      JSON.stringify(bundleWithout).slice(0, 240),
    )
  }

  await evaluate('window.__probe.installShim()')
  const prefix = await evaluate('window.__probe.seamPrefix()')
  check(typeof prefix === 'string' && prefix.includes('installEngineShims') && prefix.includes('globalThis'), 'the blob seam prepends the engine-shim installer to a javascript blob', String(prefix).slice(0, 60))
  const repairWorker = workerSource([
    `let broken = null`,
    `let repaired = false`,
    `delete globalThis.Iterator`,
    `try { ${PDFJS_STATEMENT} } catch (error) { broken = String(error) }`,
    `try { ${prefix} } catch (error) { broken = broken || 'the installer threw: ' + error }`,
    `try { ${PDFJS_STATEMENT}; repaired = true } catch (error) {}`,
    `self.postMessage({ broken, repaired, join: typeof Iterator.prototype.join })`,
  ])
  const repair = await evaluate(`window.__probe.runWorker(${JSON.stringify(repairWorker)}, false)`)
  check(
    /Iterator/.test(repair.message?.broken || '') && repair.message?.repaired === true && repair.message?.join === 'function',
    'the installer the seam ships repairs that realm from inside the worker',
    JSON.stringify(repair),
  )

  const throughSeam = await evaluate(`window.__probe.runWorker(${JSON.stringify(workerSource(['self.postMessage({ ready: true })']))}, true)`)
  check(throughSeam.message?.ready === true, 'a blob module worker created through the seam still starts and speaks', JSON.stringify(throughSeam))

  if (bundle !== null) {
    const bundleWith = await evaluate('window.__probe.loadBundle(2)')
    check(
      !/Iterator/.test(bundleWith.error || ''),
      'the shim removes exactly that failure from the real bundle',
      JSON.stringify(bundleWith).slice(0, 240),
    )
    console.log(`  info  without shim: ${(bundleWithout.error || 'no error').slice(0, 140)}`)
    console.log(`  info  with shim:    ${(bundleWith.error || 'no error').slice(0, 140)}`)
    console.log(`  note  ${/typeof Iterator\.prototype\.join/.test(bundle) ? 'the installed bundle still reads Iterator unguarded — the phone failure is still reachable' : 'the installed bundle no longer reads Iterator unguarded — the shim is redundant, not wrong'}`)
  }

  console.log(FAILURES.length === 0 ? '\nPASS engine shims: native agreement, worker realm, and the real bundle' : `\nFAIL ${FAILURES.length} check(s)`)
  if (FAILURES.length !== 0) process.exitCode = 1
} finally {
  try { await send?.('Browser.close') } catch {}
  edge.kill()
  await Promise.race([stopped, delay(2000)])
  server.close()
  await Promise.race([once(server, 'close').catch(() => {}), delay(1000)])
  rmSync(dir, { recursive: true, force: true })
}
