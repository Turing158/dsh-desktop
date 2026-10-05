import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPreferences, installShortcut, isTerminalShortcut } from './sidebar-terminal/preferences.mjs'
import { SettingsSchema } from './sidebar-terminal/index.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('a configForms refusal preserves accepted preferences and reports failure', async t => {
  const h = harness(t, { status: 'ready', value: { profileId: 'cmd', position: 'right' } })
  h.scope.set = async () => false
  await h.preferences.set('profileId', 'pwsh')
  assert.equal(h.preferences.getSnapshot().profileId, 'cmd')
  assert.equal(h.preferences.getSnapshot().saving, false)
  assert.match(h.preferences.getSnapshot().error, /保存失败/)
})

function harness(t, initial = { status: 'loading' }) {
  let snap = initial, fail = false
  const listeners = new Set(), events = new EventTarget(), writes = []
  const update = value => { snap = value; listeners.forEach(fn => fn()) }
  const scope = {
    getSnapshot: () => snap,
    subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)),
    async set(field, value) {
      if (fail) throw Error('offline')
      writes.push([field, value]); update({ status: 'ready', value: SettingsSchema({ ...snap.value, [field]: value }) })
    },
  }
  const preferences = createPreferences(scope, async () => [{ profileId: 'cmd', name: 'CMD' }], events)
  t.after(() => preferences.dispose())
  return { preferences, update, writes, fail: () => { fail = true }, scope }
}

test('legacy settings retain geometry; invalid shell and position selections are rejected', () => {
  assert.deepEqual(SettingsSchema({ layout: { height: 312, collapsed: false } }), {
    layout: { height: 312, collapsed: false }, profileId: 'auto', position: 'bottom',
  })
  for (const profileId of ['auto', 'cmd', 'pwsh', 'powershell']) assert.equal(SettingsSchema.validate({ profileId, position: 'right' }).profileId, profileId)
  for (const value of [{ profileId: 'bash' }, { position: 'left' }, { profileId: null }, { position: null }]) {
    assert.equal(SettingsSchema.validate(value), undefined)
    assert.ok(SettingsSchema['~standard'].validate(value).issues.length)
  }
})

test('opening waits for saved preferences; field writes preserve dock geometry', async t => {
  const h = harness(t)
  let ready = false
  const waiting = h.preferences.ready().then(() => { ready = true })
  await tick(); assert.equal(ready, false)
  h.update({ status: 'ready', value: { profileId: 'cmd', position: 'right', layout: { height: 320, collapsed: true } } })
  await waiting
  assert.equal(h.preferences.getSnapshot().profileId, 'cmd')
  assert.equal(h.preferences.getSnapshot().position, 'right')
  assert.deepEqual(h.preferences.getSnapshot().profiles, [{ profileId: 'cmd', name: 'CMD' }])
  await h.preferences.set('position', 'bottom')
  assert.deepEqual(h.writes, [['position', 'bottom']])
  assert.equal(h.scope.getSnapshot().value.layout.height, 320)
  assert.equal(h.scope.getSnapshot().value.profileId, 'cmd')
})

test('failed writes retain the accepted preference and expose an error', async t => {
  const h = harness(t, { status: 'ready', value: { profileId: 'cmd', position: 'bottom' } })
  h.fail(); await h.preferences.set('position', 'right')
  assert.equal(h.preferences.getSnapshot().position, 'bottom')
  assert.match(h.preferences.getSnapshot().error, /保存失败/)
  assert.equal(h.preferences.getSnapshot().saving, false)
})

test('a namespace the Host cannot carry opens the terminal on defaults instead of refusing', async t => {
  const h = harness(t)
  // DSH makes every non-loopback page's settings namespace memory-mode: its
  // status is `unavailable` for the page's life. A plain LAN browser is exactly
  // that case — the desktop window declares host ownership and no longer is (see
  // ui-overlay/browser-compat.js) — and refusing here is what produced 启动失败
  // with a live native transport underneath.
  h.update({ status: 'unavailable' })
  await h.preferences.ready()
  assert.equal(h.preferences.getSnapshot().ready, true)
  assert.equal(h.preferences.getSnapshot().profileId, 'auto')
  assert.equal(h.preferences.getSnapshot().position, 'bottom')
  // A choice made in that state is remembered for the session. The scope is not
  // asked at all: a memory-mode write is a no-op it cannot acknowledge, so
  // pretending to persist would be the lie, and the error banner stays clear.
  await h.preferences.set('profileId', 'cmd')
  assert.equal(h.preferences.getSnapshot().profileId, 'cmd')
  assert.equal(h.preferences.getSnapshot().error, '')
  assert.deepEqual(h.writes, [], 'a scope that cannot persist must not be written to')
  // Later notifications from the scope must not undo it.
  h.update({ status: 'unavailable' })
  assert.equal(h.preferences.getSnapshot().profileId, 'cmd')
  assert.equal(h.preferences.getSnapshot().ready, true)
})

test('a loading scope still waits, and teardown rejects pending opens instead of hanging', async t => {
  const h = harness(t)
  let ready = false
  const waiting = h.preferences.ready().then(() => { ready = true })
  await tick(); assert.equal(ready, false)
  h.update({ status: 'ready', value: { profileId: 'auto', position: 'bottom' } })
  await waiting
  assert.equal(h.preferences.getSnapshot().ready, true)
  // A parked waiter is released by the scope going memory-mode rather than left
  // hanging — the open path must always settle.
  const parked = harness(t, { status: 'loading' })
  const settled = parked.preferences.ready()
  await tick(); parked.update({ status: 'unavailable' }); await settled
  const other = harness(t)
  const disposed = assert.rejects(other.preferences.ready(), /已卸载/)
  other.preferences.dispose(); await disposed
})

test('shortcut accepts both backquote variants and excludes AltGr and composition', () => {
  for (const event of [{ code: 'Backquote' }, { code: 'Backquote', shiftKey: true }, { key: '`' }, { key: '~' }]) {
    assert.equal(isTerminalShortcut({ ctrlKey: true, ...event }), true)
  }
  for (const event of [{ ctrlKey: false }, { altKey: true }, { metaKey: true }, { isComposing: true }, { code: 'KeyA', key: 'a' }]) {
    assert.equal(Boolean(isTerminalShortcut({ ctrlKey: true, code: 'Backquote', ...event })), false)
  }
})

test('capture consumes shell input, ignores repeat and pending opens, and cleans up', async () => {
  const target = new EventTarget(), calls = [], errors = []
  let finish
  const off = installShortcut(target, () => { calls.push('open'); return new Promise(resolve => { finish = resolve }) }, error => errors.push(error))
  let leaked = 0
  target.addEventListener('keydown', () => { leaked++ })
  const key = (extra = {}) => {
    const event = new Event('keydown', { cancelable: true })
    Object.assign(event, { ctrlKey: true, code: 'Backquote', ...extra }); target.dispatchEvent(event); return event
  }
  assert.equal(key().defaultPrevented, true)
  key({ repeat: true }); key(); await tick()
  assert.equal(leaked, 0); assert.equal(calls.length, 1)
  finish(); await tick(); key(); await tick()
  assert.equal(calls.length, 2)
  finish(); await tick(); off()
  assert.equal(key().defaultPrevented, false)
  assert.equal(leaked, 1); assert.deepEqual(errors, [])
})
