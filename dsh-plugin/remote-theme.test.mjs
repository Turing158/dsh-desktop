import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./ui-overlay/remote-theme.js', import.meta.url), 'utf8')
const key = 'dsh.desktop.remote-theme'
function fixture({ saved, dark = false, desktop = false, bootHost = false, blocked = false, available = true } = {}) {
  const storage = new Map(saved === undefined ? [] : [[key, saved]])
  const events = new Map(), attributes = new Map(), mediaEvents = new Map(), bodyAttributes = new Map()
  const media = { matches: dark, addEventListener: (name, fn) => mediaEvents.set(name, fn) }
  const window = { addEventListener: (name, fn) => events.set(name, fn), matchMedia: () => media,
    localStorage: { getItem: key => { if (blocked) throw Error('denied'); return storage.get(key) },
      setItem: (key, value) => { if (blocked) throw Error('denied'); storage.set(key, value) } },
    __TAURI__: desktop ? { core: { invoke() {} } } : undefined, __DSH_DESKTOP_BOOT_HOST__: bootHost }
  const document = { documentElement: { setAttribute: (key, value) => attributes.set(key, value), style: {} },
    head: { append() {} }, createElement: () => ({ remove() {} }),
    body: { toggleAttribute: (key, value) => bodyAttributes.set(key, value) } }
  vm.runInNewContext(source, { window, document })
  let host = { status: available ? 'ready' : 'unavailable', mode: available ? 'host' : 'memory',
    value: available ? { preference: 'dark', fontSize: 14 } : undefined }
  const hostListeners = new Set(), writes = [], disposers = []
  const form = {
    getSnapshot: () => host,
    subscribe: fn => { hostListeners.add(fn); return () => hostListeners.delete(fn) },
    set: (field, value) => form.mutate([{ op: 'set', path: [field], value }]),
    unset: field => form.mutate([{ op: 'unset', path: [field] }]),
    mutate: async ops => { writes.push(...ops); return true },
  }
  const original = { ...form }
  // The runtime retains its original subscription before the adapter mounts.
  let current = host.value?.preference ?? 'system'
  form.subscribe(() => { current = form.getSnapshot().value?.preference ?? current })
  const theme = { getTheme: () => ({ preference: current, fontSize: 14 }), setTheme(value) {
    if (current === value) return
    current = value; form.set('preference', value)
  } }
  const ctx = { theme, effect: fn => disposers.push(fn()) }
  const bind = () => window.__DSH_REMOTE_THEME__?.bind(ctx, form)
  return { window, storage, events, attributes, media, mediaEvents, bodyAttributes, form, theme, original, writes, bind, disposers,
    hostChange(preference) { host = { ...host, value: { preference, fontSize: 16 } }; for (const fn of hostListeners) fn() },
    storageChange(value) { if (value === undefined) storage.delete(key); else storage.set(key, value); events.get('storage')({ key, storageArea: window.localStorage }) },
  }
}

test('remote boot uses the device system palette or its own saved preference', () => {
  const light = fixture(), dark = fixture({ dark: true }), saved = fixture({ saved: 'light', dark: true })
  assert.equal(light.bodyAttributes.get('data-ds-dark-theme'), false)
  assert.equal(dark.bodyAttributes.get('data-ds-dark-theme'), true)
  assert.equal(saved.bodyAttributes.get('data-ds-dark-theme'), false)
  dark.media.matches = false; dark.mediaEvents.get('change')()
  assert.equal(dark.bodyAttributes.get('data-ds-dark-theme'), false)
  assert.equal(fixture({ saved: 'bad' }).attributes.get('data-ds-theme-source'), 'system')
})

test('theme choices and Host invalidations stay independent in both persistence modes', async () => {
  for (const available of [true, false]) {
    const f = fixture({ available }); f.bind()
    assert.equal(f.theme.getTheme().preference, 'system')
    f.theme.setTheme('light')
    assert.equal(f.storage.get(key), 'light')
    f.hostChange('dark')
    assert.equal(f.theme.getTheme().preference, 'light')
    assert.equal(f.form.getSnapshot().value.fontSize, 16, 'other theme fields still come from their owner')
    assert.equal(f.form.getSnapshot(), f.form.getSnapshot(), 'snapshots stay stable')
    assert.deepEqual(f.writes, [])
    await f.form.set('fontSize', 17)
    assert.deepEqual(f.writes, [{ op: 'set', path: ['fontSize'], value: 17 }])
  }
})

test('direct settings writes, clears and atomic operations never send a theme preference to the Host', async () => {
  const f = fixture(); f.bind()
  await f.form.set('preference', 'dark')
  assert.equal(f.theme.getTheme().preference, 'dark')
  await f.form.unset('preference')
  assert.equal(f.theme.getTheme().preference, 'system')
  await f.form.mutate([{ op: 'set', path: ['preference'], value: 'light' }, { op: 'set', path: ['fontSize'], value: 16 }])
  assert.equal(f.theme.getTheme().preference, 'light')
  assert.deepEqual(f.writes, [{ op: 'set', path: ['fontSize'], value: 16 }])
  assert.throws(() => f.form.mutate([{ op: 'set', path: ['preference', 'x'], value: 'dark' }]), /Invalid/)
  assert.throws(() => f.form.set('preference', 'unknown'), /Invalid/)
  assert.equal(f.storage.get(key), 'light')
})

test('reload restores a choice and same-browser storage changes reach existing theme subscribers', () => {
  const f = fixture({ saved: 'dark' }); f.bind()
  assert.equal(f.theme.getTheme().preference, 'dark')
  let changes = 0
  const dispose = f.form.subscribe(() => changes++)
  f.storageChange('light')
  assert.equal(f.theme.getTheme().preference, 'light')
  assert.equal(changes, 1)
  f.storageChange(undefined)
  assert.equal(f.theme.getTheme().preference, 'system')
  dispose()
  f.storageChange('dark')
  assert.equal(changes, 2)
  assert.deepEqual(f.writes, [])
})

test('blocked storage keeps page-local choices through page restore', () => {
  const f = fixture({ blocked: true }); f.bind()
  f.theme.setTheme('dark')
  f.events.get('pageshow')()
  assert.equal(f.theme.getTheme().preference, 'dark')
  f.hostChange('light')
  assert.equal(f.theme.getTheme().preference, 'dark')
  assert.deepEqual(f.writes, [])
})

test('shared bindings release the form only after the last consumer disposes', () => {
  const f = fixture(); f.bind(); f.bind()
  f.disposers[0]()
  assert.notEqual(f.form.set, f.original.set)
  f.disposers[1]()
  assert.equal(f.form.set, f.original.set)
  assert.equal(f.form.getSnapshot, f.original.getSnapshot)
})

test('native bridge and boot host pages leave theme, storage and listeners alone', () => {
  for (const config of [{ desktop: true }, { bootHost: true }]) {
    const f = fixture(config); f.bind()
    assert.equal(f.window.__DSH_REMOTE_THEME__, undefined)
    assert.equal(f.attributes.size, 0)
    assert.equal(f.events.size, 0)
    assert.equal(f.storage.size, 0)
    assert.equal(f.form.set, f.original.set)
  }
})
