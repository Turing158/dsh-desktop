import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./lan-web-runtime.mjs', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^const upstream = .*$/m, '').replace(/^export /gm, '')

function fixture({ host = '192.168.1.20', connection = {}, settled, entries = [] } = {}) {
  const lines = [], applications = [], cleanups = [], emissions = []
  const webServer = { host, port: 43123 }
  const ctx = {
    webServer, connection,
    get(name) { return name === 'loader' ? { await: () => settled } : this[name] },
    inject(names, callback) { callback(this) },
    effect(callback) { cleanups.push(callback()) },
    emit(server, event, origin, collector) {
      emissions.push({ server, event, origin })
      collector.push(...entries)
    },
  }
  const upstream = { apply: (...args) => applications.push(args) }
  const apply = vm.runInNewContext(source + '\napply', {
    upstream, nodeModule: {}, setImmediate,
    console: { log: line => lines.push(line) },
  })
  const config = { printUrl: true, openBrowser: true, surfaceContext: false }
  return { ctx, config, lines, applications, emissions,
    start: async () => apply(ctx, config), dispose: () => cleanups.forEach(fn => fn()) }
}

test('LAN startup on stable DSH preserves the authenticated loopback callback', async () => {
  const connection = { authenticatedUrl(origin) { assert.equal(this, connection); return origin + '/?token=stable' } }
  const f = fixture({ connection })
  await f.start()
  assert.deepEqual(f.lines, ['dsh web: http://127.0.0.1:43123/?token=stable'])
  assert.equal(f.emissions.length, 0)
  assert.equal(f.applications[0][1].printUrl, false)
  assert.equal(f.applications[0][1].openBrowser, false)
  assert.equal(f.applications[0][1].surfaceContext, false)
})

test('preview DSH uses its authentication provider instead of the removed Connection method', async () => {
  let resolve
  const settled = new Promise(done => { resolve = done })
  const f = fixture({ settled, entries: [
    { label: 'other provider', url: 'http://192.168.1.20:43123/help', open: false },
    { label: 'dsh web', url: 'http://127.0.0.1:43123/?token=preview', open: true },
  ] })
  await f.start()
  assert.deepEqual(f.lines, [], 'readiness must wait for all providers to initialize')
  resolve()
  await settled
  assert.deepEqual(f.lines, ['dsh web: http://127.0.0.1:43123/?token=preview'])
  assert.deepEqual(f.emissions, [{ server: f.ctx.webServer, event: 'webserver/entry-url', origin: 'http://127.0.0.1:43123' }])
})

test('disposed or failed startup cannot publish a stale ready URL', async () => {
  for (const failed of [false, true]) {
    let resolve, reject
    const settled = new Promise((done, fail) => { resolve = done; reject = fail })
    const f = fixture({ settled, entries: [{ url: 'http://127.0.0.1:43123/?token=stale', open: true }] })
    await f.start()
    if (failed) reject(Error('loader failed'))
    else { f.dispose(); resolve() }
    await settled.catch(() => {})
    assert.deepEqual(f.lines, [])
    assert.deepEqual(f.emissions, [])
  }
})

test('missing preview authentication never falls back to an unauthenticated origin', async () => {
  const f = fixture()
  await assert.rejects(f.start(), /no authenticated desktop entry URL/)
  assert.deepEqual(f.lines, [])
})

test('loopback-only startup keeps the upstream readiness and browser handoff', async () => {
  const f = fixture({ host: '127.0.0.1' })
  await f.start()
  assert.equal(f.applications[0][0], f.ctx)
  assert.equal(f.applications[0][1], f.config)
  assert.deepEqual(f.emissions, [])
  assert.deepEqual(f.lines, [])
})

test('LAN surface context stays with upstream instead of registering a duplicate prompt', async () => {
  const f = fixture({ connection: { authenticatedUrl: origin => origin + '/?token=stable' } })
  f.config.surfaceContext = true
  await f.start()
  assert.equal(f.applications[0][1].surfaceContext, true)
})
