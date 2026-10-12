import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { ROOTS, createNavigation } from './directory-picker/navigation.mjs'
import { listRoots } from './directory-picker/host.mjs'

const listing = (path = 'C:\\Users\\Me') => ({ path, home: 'C:\\Users\\Me', entries: [],
  crumbs: path === 'C:\\' ? [{ path }] : [{ path: 'C:\\' }, { path: 'C:\\Users' }, { path }], truncated: false })
const fixture = overrides => createNavigation({ listDirectory: async path => listing(path), listRoots: async () => [{ name: 'C:\\', path: 'C:\\' }], ...overrides })

test('back/forward cross drive selection; branching drops forward history; refresh does not add entries', async () => {
  const nav = fixture()
  assert.equal(await nav.back(), false)
  await nav.visit(); await nav.visit(ROOTS); await nav.visit('C:\\')
  assert.deepEqual(nav.getSnapshot().history, ['C:\\Users\\Me', ROOTS, 'C:\\'])
  await nav.back(); assert.equal(nav.getSnapshot().location.kind, 'roots')
  await nav.back(); assert.equal(nav.getSnapshot().index, 0)
  assert.equal(await nav.back(), false)
  await nav.forward(); assert.equal(nav.getSnapshot().location.kind, 'roots')
  await nav.refresh(); assert.equal(nav.getSnapshot().history.length, 3)
  await nav.visit('D:\\'); assert.deepEqual(nav.getSnapshot().history, ['C:\\Users\\Me', ROOTS, 'D:\\'])
  assert.equal(await nav.forward(), false)
  await nav.visit('D:\\'); assert.equal(nav.getSnapshot().history.length, 3)
})

test('parent uses full host ancestry and reaches drive selection from the root', async () => {
  const nav = fixture({ listDirectory: async path => ({ ...listing(path), crumbs:
    path === 'C:\\Users' ? [{ path: 'C:\\' }, { path }] : listing(path).crumbs }) })
  await nav.visit(); await nav.parent(); assert.equal(nav.getSnapshot().location.path, 'C:\\Users')
  await nav.parent(); assert.equal(nav.getSnapshot().location.path, 'C:\\')
  await nav.parent(); assert.equal(nav.getSnapshot().location.kind, 'roots')
  assert.equal(await nav.parent(), false)
  await nav.back(); assert.equal(nav.getSnapshot().location.path, 'C:\\')
})

test('UNC and POSIX roots return to the roots view without constructing client paths', async () => {
  for (const path of ['\\\\server\\share\\', '/']) {
    const nav = fixture({ listDirectory: async () => ({ ...listing(path), crumbs: [{ path }] }) })
    await nav.visit(path); await nav.parent(); assert.equal(nav.getSnapshot().location.path, ROOTS)
  }
})

test('failed navigation and failed history reads retain location and history; retry recovers', async () => {
  let fail = false
  const nav = fixture({ listDirectory: async path => { if (fail) throw Error('unavailable'); return listing(path) } })
  await nav.visit(); await nav.visit('D:\\')
  const before = nav.getSnapshot()
  fail = true
  assert.equal(await nav.back(), false)
  assert.equal(nav.getSnapshot().location, before.location)
  assert.equal(nav.getSnapshot().history, before.history)
  assert.equal(nav.getSnapshot().index, 1)
  assert.equal(nav.getSnapshot().loading, false)
  assert.equal(nav.getSnapshot().error, 'unavailable')
  fail = false; await nav.refresh(); assert.equal(nav.getSnapshot().error, null)
  await nav.back(); assert.equal(nav.getSnapshot().index, 0)
})

test('new navigation aborts scans; late success/error and disposal cannot replace the view', async () => {
  const pending = []
  const nav = fixture({ listDirectory: (path, signal) => new Promise((resolve, reject) => pending.push({ path, signal, resolve, reject })) })
  const a = nav.visit('C:\\'), b = nav.visit('D:\\')
  assert.equal(pending[0].signal.aborted, true)
  pending[1].resolve(listing('D:\\')); await b
  pending[0].resolve(listing('C:\\')); await a
  assert.equal(nav.getSnapshot().location.path, 'D:\\')
  assert.deepEqual(nav.getSnapshot().history, ['D:\\'])
  const c = nav.visit('E:\\'), d = nav.visit(ROOTS)
  await d; pending[2].reject(Error('late error')); await c
  assert.equal(nav.getSnapshot().error, null)
  const e = nav.visit('F:\\'), before = nav.getSnapshot()
  nav.dispose(); assert.equal(pending[3].signal.aborted, true)
  pending[3].resolve(listing('F:\\')); await e
  assert.equal(nav.getSnapshot(), before)
})

test('roots enumeration normalizes Windows drive results, handles one drive and POSIX, and propagates failures', async () => {
  const roots = await listRoots(undefined, { platform: 'win32', readDrives: async () => ['d:\\', 'C:\\', 'D:\\'] })
  assert.deepEqual(roots.map(entry => entry.path), ['C:\\', 'D:\\'])
  assert.deepEqual((await listRoots(undefined, { platform: 'win32', readDrives: async () => 'C:\\' })).map(entry => entry.path), ['C:\\'])
  assert.deepEqual(await listRoots(undefined, { platform: 'linux' }), [{ name: '/', path: '/', hidden: false }])
  await assert.rejects(listRoots(undefined, { platform: 'win32', readDrives: async () => ['relative'] }), /Invalid drive list/)
  await assert.rejects(listRoots(undefined, { platform: 'win32', readDrives: async () => { throw Error('timeout') } }), /timeout/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(listRoots(controller.signal), { name: 'AbortError' })
})

test('desktop webview retains the upstream picker without mounting the browser extension', async () => {
  let plugin
  vm.runInNewContext(readFileSync(new URL('./directory-picker/client.js', import.meta.url), 'utf8'), {
    window: { __TAURI__: { core: { invoke() {} } }, __ModuleLoader__: { load({ factory }) { plugin = factory(() => ({})) } } },
  })
  await plugin.apply({ remote: { $mount() { assert.fail('desktop must not mount') } } })
})

test('all directory picker runtime files are included in the desktop bundle', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url)))
  for (const file of ['package.json', 'index.js', 'host.mjs', 'protocol.mjs', 'client.js']) {
    assert.equal(config.bundle.resources['../dsh-plugin/directory-picker/' + file], 'dsh-plugin/directory-picker/' + file)
    assert.ok(readFileSync(new URL('./directory-picker/' + file, import.meta.url)).length)
  }
})

test('ordinary browsers on native-picker hosts keep the existing flow', async () => {
  let plugin, installation
  vm.runInNewContext(readFileSync(new URL('./directory-picker/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load({ factory }) { plugin = factory(() => ({})) } } },
  })
  const ctx = { remote: { $mount: async () => () => {}, desktopDirectoryPicker: { capability: async () => ({ ok: true, value: 'native' }) } },
    inject(deps, install) { installation = install(ctx); return { dispose: async () => {} } } }
  const off = await plugin.apply(ctx)
  await installation // No DOM or slot registration: the original OS picker remains active.
  await off()
})
