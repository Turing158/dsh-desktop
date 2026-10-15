import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { ROOTS, createNavigation } from './directory-picker/navigation.mjs'
import { listRoots, listFiles, readAttachment, MAX_FILE_BYTES } from './directory-picker/host.mjs'
import { contribution } from './directory-picker/protocol.mjs'

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

test('retry repeats the failed home, directory or history request without corrupting history', async () => {
  let fail = true
  const calls = [], nav = fixture({ listDirectory: async path => {
    calls.push(path)
    if (fail) throw Error('access denied')
    return listing(path)
  } })
  assert.equal(await nav.visit(), false)
  fail = false
  assert.equal(await nav.retry(), true)
  assert.deepEqual(calls, [undefined, undefined])
  fail = true
  assert.equal(await nav.visit('D:\\'), false)
  fail = false
  assert.equal(await nav.retry(), true)
  assert.deepEqual(calls.slice(-2), ['D:\\', 'D:\\'])
  assert.deepEqual(nav.getSnapshot().history, ['C:\\Users\\Me', 'D:\\'])
  fail = true
  assert.equal(await nav.back(), false)
  fail = false
  assert.equal(await nav.retry(), true)
  assert.equal(nav.getSnapshot().index, 0)
  assert.equal(await nav.forward(), true)
  assert.deepEqual(nav.getSnapshot().history, ['C:\\Users\\Me', 'D:\\'])
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

async function desktopPicker() {
  let plugin, cursor = 0
  const hooks = [], queued = [], entries = [], disposed = [], picks = [], outcomes = []
  const React = {
    useRef(value) { return hooks[cursor++] ??= { current: value } },
    useEffect(setup, deps) {
      const index = cursor++, previous = hooks[index]
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
      queued.push(() => { previous?.cleanup?.(); hooks[index] = { setup, deps, cleanup: setup() } })
    },
  }
  vm.runInNewContext(readFileSync(new URL('./directory-picker/client.js', import.meta.url), 'utf8'), {
    window: { __TAURI__: { core: { invoke(command) {
      assert.equal(command, 'pick_workspace_directory')
      return new Promise((resolve, reject) => picks.push({ resolve, reject }))
    } } }, __ModuleLoader__: { load({ factory }) { plugin = factory(name => name === 'react' ? React : {}) } } },
  })
  const off = await plugin.apply({
    remote: { $mount() { assert.fail('desktop must not mount the browse RPC') } },
    uiWorkspace: { pickDirectory() { assert.fail('desktop must not use the shared host picker') } },
    slots: {
      inject(name, register) { const dispose = register(); return () => { disposed.push(name); dispose() } },
      register(options, Flow) { entries.push({ ...options, Flow }); return () => {} },
    },
  })
  let props = { open: false, busy: false, onPicked: path => outcomes.push(['picked', path]),
    onCancel: () => outcomes.push(['cancel']), onError: message => outcomes.push(['error', message]) }
  const render = changes => {
    props = { ...props, ...changes }; cursor = 0
    assert.equal(entries[0].Flow(props), null, 'the desktop flow renders no HTML dialog')
    queued.splice(0).forEach(run => run())
  }
  return { entries, picks, outcomes, disposed, off, render,
    replay() { hooks.forEach(hook => hook.cleanup?.()); hooks.forEach(hook => { if (hook.setup) hook.cleanup = hook.setup() }) },
    unmount() { hooks.forEach(hook => hook.cleanup?.()) },
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('remote attachment listing includes sorted files, hidden entries and absolute ancestry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-attachment-list-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '子目录'))
  await Promise.all(['a.txt', '中文 文件.txt', '.hidden'].map(name => writeFile(join(root, name), name)))
  const result = await listFiles(root)
  assert.equal(result.path, root)
  assert.equal(result.entries[0].directory, true)
  assert.equal(result.entries.find(entry => entry.name === '.hidden').hidden, true)
  assert.equal(result.entries.find(entry => entry.name === '中文 文件.txt').directory, false)
  assert.equal(result.crumbs[0].path, parse(root).root)
  assert.equal(result.crumbs.at(-1).path, root)
  assert.equal(result.truncated, false)
  await assert.rejects(listFiles('relative'), /absolute/)
  await assert.rejects(listFiles(join(root, 'missing')))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(listFiles(root, controller.signal), { name: 'AbortError' })
})

test('remote attachment reads preserve binary bytes, names and image types and reject unsafe reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-attachment-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, '中文 图片.PNG'), bytes = Buffer.from([0, 255, 128, 13, 10, 42])
  await writeFile(path, bytes)
  const result = await readAttachment(path)
  assert.equal(result.name, '中文 图片.PNG')
  assert.equal(result.type, 'image/png')
  assert.ok(result.lastModified > 0)
  assert.deepEqual(Buffer.from(result.data, 'base64'), bytes)
  await writeFile(join(root, 'empty.txt'), '')
  assert.equal((await readAttachment(join(root, 'empty.txt'))).data, '')
  await assert.rejects(readAttachment(root))
  await assert.rejects(readAttachment('relative'), /absolute/)
  await assert.rejects(readAttachment(undefined), /absolute/)
  const handle = await open(join(root, 'large.bin'), 'w')
  try { await handle.truncate(MAX_FILE_BYTES + 1) } finally { await handle.close() }
  await assert.rejects(readAttachment(join(root, 'large.bin')), /100 MB/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(readAttachment(path, controller.signal), { name: 'AbortError' })
})

test('attachment RPC path codecs reject malformed values before accessing the filesystem', () => {
  const codec = contribution.descriptors.find(item => item.method === 'files').parameters[0].codec.create()
  assert.equal(codec.parse(undefined), undefined, 'listing may start at the host home')
  for (const value of [null, {}, 42, '', 'a\0b', 'x'.repeat(32769)]) assert.throws(() => codec.parse(value))
})

test('desktop owns both workspace slots without using the shared host picker', async () => {
  const f = await desktopPicker()
  assert.deepEqual(f.entries.map(({ name, priority }) => ({ name, priority })), [
    { name: 'conversation.hero.workspace.directoryFlow', priority: -10 },
    { name: 'sidebar.workspaces.directoryFlow', priority: -10 },
  ])
  assert.equal(f.entries[0].Flow, f.entries[1].Flow)
  f.render(); await tick(); assert.equal(f.picks.length, 0)
  f.render({ open: true }); f.replay(); await tick()
  assert.equal(f.picks.length, 1, 'effect replay must not open a second native dialog')
  f.render({ onPicked: path => f.outcomes.push(['latest owner', path]) })
  f.picks[0].resolve('D:\\中文 工作区'); await tick()
  assert.deepEqual(f.outcomes, [['latest owner', 'D:\\中文 工作区']])
  f.render({ busy: true }); f.render({ busy: false }); await tick()
  assert.equal(f.picks.length, 1, 'adoption and rerenders must not repeat selection')
  await f.off()
  assert.deepEqual(f.disposed, ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow'])
})

test('native cancellation and errors close the current flow and allow another selection', async () => {
  const f = await desktopPicker()
  for (const error of [null, 'native picker failed', new Error('access denied')]) {
    f.render({ open: false }); f.render({ open: true }); await tick()
    if (error === null) f.picks.at(-1).resolve(null)
    else f.picks.at(-1).reject(error)
    await tick()
  }
  assert.deepEqual(f.outcomes, [['cancel'], ['error', 'native picker failed'], ['error', 'access denied']])
  assert.equal(f.picks.length, 3)
})

test('withdrawn or unmounted native requests cannot add a workspace to a later flow', async () => {
  const f = await desktopPicker()
  f.render({ open: true }); await tick()
  f.render({ open: false })
  f.picks[0].resolve('C:\\closed'); await tick()
  f.render({ open: true }); await tick()
  f.render({ open: false }); f.render({ open: true }); await tick()
  f.picks[1].reject('stale error'); await tick()
  assert.deepEqual(f.outcomes, [])
  f.unmount(); f.picks[2].resolve('C:\\unmounted'); await tick()
  assert.deepEqual(f.outcomes, [])
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
