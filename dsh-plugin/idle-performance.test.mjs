import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { watchUpdateControl } from './desktop-maintenance/update-control.mjs'
import { createVisibleRefresh } from './plugin-control/visible-refresh.mjs'
import { watchClientBundles, insideImmutableRoot } from './idle/bundle-watches.mjs'
import { createDocuments } from './file-editor/documents.mjs'
import { deferredToolRegistry } from './idle/deferred-tools.mjs'
import { createLazyEditor } from './file-editor/lazy-editor.mjs'
import { editorAssetHandler } from './file-editor/editor-asset.mjs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { supportsIdleRuntime, runtimeRedirects } from './idle/runtime-hooks.mjs'

const settle = () => new Promise(done => setImmediate(done))
function control(options = {}) {
  let request, reads = 0, flushes = 0, exits = 0, event, fallback
  const replies = [], watcher = new EventEmitter()
  watcher.close = () => {}
  const dispose = watchUpdateControl({ directory: resolve('fixture'),
    read: () => { reads++; if (!request) throw Error('ENOENT'); return JSON.stringify(request) },
    write: (_file, text) => replies.push(JSON.parse(text)),
    flush: async () => { flushes++ }, exit: () => { exits++ },
    observe: (_directory, _options, fn) => { event = fn; return watcher },
    repeat: (fn, ms) => { fallback = { fn, ms }; return 1 }, cancel() {}, ...options,
  })
  return { dispose, replies, set: value => { request = value }, notify: (file = 'request.json') => event('rename', file),
    fallback: () => fallback, counts: () => ({ reads, flushes, exits }) }
}

test('idle update control ignores unrelated events; atomic requests flush once without waiting for a poll', async () => {
  const f = control()
  for (let i = 0; i < 100; i++) f.notify('reply.json')
  assert.deepEqual(f.counts(), { reads: 1, flushes: 0, exits: 0 })
  assert.equal(f.fallback().ms, 2000)
  f.set({ id: 'one' }); f.notify(); f.notify(); await settle()
  assert.equal(f.counts().flushes, 1); assert.equal(f.counts().exits, 1)
  assert.deepEqual(f.replies, [{ id: 'one', flushed: true }])
  f.fallback().fn(); await settle(); assert.equal(f.counts().exits, 1)
  f.dispose()
})

test('cancelled or disposed update requests cannot shut down a resumed backend', async () => {
  for (const dispose of [false, true]) {
    let finish
    const f = control({ flush: () => new Promise(done => { finish = done }) })
    f.set({ id: 'one' }); f.notify()
    if (dispose) f.dispose(); else f.set(undefined)
    finish(); await settle()
    assert.deepEqual(f.replies, []); assert.equal(f.counts().exits, 0)
    f.dispose()
  }
})

test('unavailable update watches retain a bounded fallback and failed flushes acknowledge failure', async () => {
  const f = control({ observe: () => { throw Error('unavailable') }, flush: async () => { throw Error('busy') } })
  f.set({ id: 'one' }); f.fallback().fn(); await settle()
  assert.deepEqual(f.replies, [{ id: 'one', flushed: false }]); assert.equal(f.counts().exits, 0)
  f.dispose()
})

test('invalid update-control payloads remain idle without an unhandled rejection', async () => {
  for (const payload of ['null', '{', '[]', '{"id":4}']) {
    const f = control({ read: () => payload })
    f.notify(); f.fallback().fn(); await settle()
    assert.equal(f.counts().flushes, 0); assert.equal(f.counts().exits, 0)
    f.dispose()
  }
})

test('real directory notifications observe atomic replacement of request.json', async t => {
  const root = await mkdtemp(resolve('src-tauri/target/diagnostics-'))
  let finish
  const completed = new Promise(done => { finish = done })
  const dispose = watchUpdateControl({ directory: root, flush: async () => {}, exit: finish, fallbackMs: 30000 })
  t.after(async () => { dispose(); await rm(root, { recursive: true, force: true }) })
  await writeFile(join(root, 'pending.json'), JSON.stringify({ id: 'atomic' }))
  await rename(join(root, 'pending.json'), join(root, 'request.json'))
  let timeout
  try { await Promise.race([completed, new Promise((_done, reject) => { timeout = setTimeout(() => reject(Error('notification timeout')), 3000) })]) }
  finally { clearTimeout(timeout) }
})

test('closed and hidden plugin views have no polling timer; showing refreshes once and cache expiry is cancellable', () => {
  const events = new Map(), timers = new Set()
  let calls = 0, expirations = 0, expiry
  const document = { hidden: false, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) }
  const view = createVisibleRefresh({ document, refresh: () => { calls++ },
    repeat: fn => { timers.add(fn); return fn }, cancel: fn => timers.delete(fn),
    schedule: fn => { expiry = fn; return fn }, unschedule: fn => { if (expiry === fn) expiry = null }, onIdle: () => { expirations++ } })
  view.changed(); assert.equal(calls, 0); assert.equal(timers.size, 0)
  const release = view.acquire(); assert.equal(calls, 1); assert.equal(timers.size, 1)
  document.hidden = true; events.get('visibilitychange')(); view.changed(); assert.equal(calls, 1); assert.equal(timers.size, 0)
  document.hidden = false; events.get('visibilitychange')(); assert.equal(calls, 2); assert.equal(timers.size, 1)
  release(); assert.equal(timers.size, 0)
  const again = view.acquire(); assert.equal(expiry, null); again(); expiry(); assert.equal(expirations, 1)
  view.dispose(); assert.equal(events.size, 0)
})

test('immutable bundles have no watches or file reads; mutable changes rebuild only the affected module', () => {
  const root = resolve('immutable-tree'), mutable = resolve('mutable-plugin/client.js'), frozen = join(root, 'client.js')
  let changed, event, tick, reads = 0, now = 1
  const rebuilt = [], watched = []
  const modules = { graph: () => ({ entries: [{ id: 'fixed' }, { id: 'mutable' }] }),
    artifactBaseline: id => ({ path: id === 'fixed' ? frozen : mutable, mtimeMs: 1, ctimeMs: 1, size: 10 }),
    onGraphChanged: fn => { changed = fn; return () => {} }, rebuilt: id => rebuilt.push(id) }
  const dispose = watchClientBundles(modules, { immutableRoot: root,
    observe: (directory, options, fn) => { watched.push([directory, options]); event = fn; return { close() {}, on() {} } },
    stat: () => { reads++; return { mtimeMs: now, ctimeMs: now, size: 10 } },
    repeat: fn => { tick = fn; return 1 }, cancel() {}, schedule: fn => { fn(); return null }, unschedule() {} })
  assert.equal(watched.length, 1); assert.equal(watched[0][1].persistent, false); assert.equal(reads, 0)
  now = 2; event('change', 'unrelated.txt'); assert.equal(reads, 0)
  event('change', 'client.js'); assert.deepEqual(rebuilt, ['mutable'])
  tick(); assert.deepEqual(rebuilt, ['mutable'])
  assert.equal(insideImmutableRoot(frozen, root), true)
  assert.equal(insideImmutableRoot(join(root + '-sibling', 'client.js'), root), false)
  dispose(); changed()
})

test('clean document cache is bounded while dirty, subscribed and in-flight buffers remain intact', async () => {
  const remote = { read: async () => ({ ok: true, value: { text: 'text', version: 'v1' } }) }
  const docs = createDocuments(remote, { maxCachedDocuments: 2, maxCachedBytes: 64 })
  const address = name => 'dsh-resource://file/session/session-a/' + name
  const dirty = docs.get(address('dirty')); await dirty.load(); dirty.edit('unsaved')
  const active = docs.get(address('active')), off = active.subscribe(() => {}); await active.load()
  for (let i = 0; i < 8; i++) await docs.get(address('file-' + i)).load()
  assert.equal(docs.documents.size, 4)
  assert.equal(docs.documents.get(dirty.address), dirty); assert.equal(dirty.getSnapshot().text, 'unsaved')
  assert.equal(docs.documents.get(active.address), active)
  off(); assert.equal(docs.documents.size, 3)
})

test('MCP servers stay unstarted until tool admission, start once across concurrent tasks and preserve service scope', async () => {
  class Tools {
    layers = {}; owner = 'caller'
    async resolve(context) { return { owner: this.owner, agent: context.agent } }
  }
  const original = Tools.prototype.resolve, tools = new Tools(), unrelated = new Tools()
  const registry = deferredToolRegistry(tools), agent = {}, other = {}
  let starts = 0, scoped = 0, closes = 0
  const a = registry.defer(() => { starts++; return { ready: Promise.resolve(), dispose: async () => { closes++ } } })
  const b = registry.defer(() => { scoped++; return { ready: Promise.resolve(), dispose: async () => { closes++ } } }, other)
  assert.equal(starts, 0); assert.equal((await a.ready).current().state, 'closed')
  await unrelated.resolve({ agent }); assert.equal(starts, 0)
  const [first, second] = await Promise.all([tools.resolve({ agent }), tools.resolve({ agent })])
  assert.equal(starts, 1); assert.equal(scoped, 0)
  assert.deepEqual(first, { owner: 'caller', agent }); assert.deepEqual(second, first)
  await tools.resolve({ agent: other }); assert.equal(scoped, 1)
  await a.dispose(); await b.dispose(); assert.equal(closes, 2)
  assert.equal(Tools.prototype.resolve, original)
})

test('cancelled tasks and disposed deferred MCP entries do not start servers', async () => {
  class Tools { layers = {}; async resolve() { return true } }
  const tools = new Tools(), registry = deferredToolRegistry(tools)
  let starts = 0
  const handle = registry.defer(() => { starts++; return { ready: Promise.resolve(), dispose: async () => {} } })
  const signal = AbortSignal.abort(Error('cancelled'))
  await assert.rejects(tools.resolve({ agent: {}, signal }), /cancelled/)
  assert.equal(starts, 0)
  await handle.dispose(); await tools.resolve({ agent: {} }); assert.equal(starts, 0)
})

test('editor engine is imported once on demand, and failed loads can retry', async () => {
  let calls = 0
  const load = createLazyEditor(async () => { calls++; if (calls === 1) throw Error('network'); return { mountEditor() {} } })
  assert.equal(calls, 0)
  await assert.rejects(load(), /network/)
  const [a, b] = await Promise.all([load(), load()])
  assert.equal(calls, 2); assert.equal(a, b); assert.equal(await load(), a)
})

test('lazy editor asset respects authentication and exact content revision without caching a large buffer', () => {
  const bytes = Buffer.from('export const editor = true'), revision = createHash('sha256').update(bytes).digest('hex')
  let reads = 0
  const response = () => ({ statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value }, end(body) { this.body = body } })
  const denied = editorAssetHandler({ reject: () => 401, read: () => { reads++; return bytes } }), a = response()
  denied({ method: 'GET', url: '/asset?v=' + revision }, a); assert.equal(a.statusCode, 401); assert.equal(reads, 0)
  const handler = editorAssetHandler({ read: () => { reads++; return bytes } }), stale = response(), good = response()
  handler({ method: 'GET', url: '/asset?v=old' }, stale); assert.equal(stale.statusCode, 409)
  handler({ method: 'GET', url: '/asset?v=' + revision }, good); assert.equal(good.statusCode, 200); assert.equal(good.body, bytes)
  assert.equal(good.headers['Content-Type'], 'text/javascript; charset=utf-8')
})

test('runtime adapters resolve the original package even from another helper generation', async t => {
  const root = await mkdtemp(resolve('src-tauri/target/diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pkg = join(root, 'node_modules/@deepseek-ai/dsh-client-hmr')
  await mkdir(pkg, { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-client-hmr', type: 'module', main: 'index.js' }))
  await writeFile(join(pkg, 'index.js'), 'export const marker="original"')
  await mkdir(join(root, 'lib'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.3-alpha.2' }))
  const entry = join(root, 'lib/bin.js'), helper = pathToFileURL(resolve('dsh-plugin/idle/runtime-hooks.mjs')).href
  assert.equal(runtimeRedirects(entry).size, 1)
  const script = `import {createRequire} from 'node:module';import {installIdleRuntimeHooks} from ${JSON.stringify(helper)};
    process.env.DSH_DESKTOP_DSH_BIN=${JSON.stringify(entry)};installIdleRuntimeHooks(process.env.DSH_DESKTOP_DSH_BIN);
    const {originalRuntimeImport}=await import(${JSON.stringify(helper + '?another-generation')});
    const original=await originalRuntimeImport('@deepseek-ai/dsh-client-hmr');
    const resolved=createRequire(process.env.DSH_DESKTOP_DSH_BIN).resolve('@deepseek-ai/dsh-client-hmr');
    console.log(JSON.stringify({marker:original.marker,resolved,metadataUrl:import.meta.resolve(${JSON.stringify(pathToFileURL(join(pkg, 'index.js')).href)})}));`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, NODE_OPTIONS: '', DSH_DESKTOP_IDLE_OPTIMIZATIONS: '1' } })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.marker, 'original'); assert.equal(output.resolved, join(pkg, 'index.js'))
  assert.equal(output.metadataUrl, pathToFileURL(join(pkg, 'index.js')).href)
})

test('older and unknown runtimes retain upstream startup without incompatible adapters', async t => {
  const root = await mkdtemp(resolve('src-tauri/target/diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'lib'))
  const entry = join(root, 'lib/bin.js')
  assert.equal(supportsIdleRuntime(entry), false)
  for (const version of ['0.2.1-rc.2', '0.2.2', '0.3.0', 'invalid']) {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
    assert.equal(supportsIdleRuntime(entry), false)
    assert.equal(runtimeRedirects(entry).size, 0)
  }
})
