import test from 'node:test'
import assert from 'node:assert/strict'
import { PluginControl, normalizeSaved, bootPatches } from './plugin-control/model.mjs'
import { readFileSync } from 'node:fs'
import { createMarketplaceInstaller } from './plugin-control/marketplace.mjs'
import { createMarketplacePrompt } from './plugin-control/marketplace-view.mjs'
const catalog = [{ id: 'hot', hot: true }, { id: 'cold', hot: false }]
const features = JSON.parse(readFileSync(new URL('./plugin-control/catalog.json', import.meta.url)))
const core = JSON.parse(readFileSync(new URL('./plugin-control/core.json', import.meta.url)))

test('legacy appearance intent controls both modules; core cannot be disabled', async () => {
  assert.equal(features.length, 4)
  for (const overlay of [true, false, undefined]) for (const appearance of [true, false]) {
    const saved = { 'desktop-appearance': appearance, ...Object.fromEntries(core.map(id => [id, false])), 'desktop-notify': false }
    if (overlay !== undefined) saved['desktop-ui'] = overlay
    const migrated = normalizeSaved(features, saved)
    assert.equal(migrated['desktop-ui'], overlay)
    assert.equal(migrated['desktop-notify'], false)
    assert.equal(migrated['desktop-appearance'], undefined)
    const patches = bootPatches(features, core, saved)
    for (const id of ['desktop-ui', 'desktop-appearance']) assert.equal(patches.find(row => row.id === id).disabled, overlay === false)
    for (const id of core) assert.equal(patches.find(row => row.id === id).disabled, false)
    const { control, changes, writes } = fixture({ catalog: features, saved, running: { 'desktop-ui': overlay !== false } })
    assert.equal(control.status().rows.filter(row => row.id === 'desktop-ui').length, 1)
    await control.setEnabled('desktop-ui', overlay === false)
    assert.equal(control.status().restartRequired, true)
    await control.setEnabled('desktop-ui', overlay !== false)
    assert.equal(control.status().rows.find(row => row.id === 'desktop-ui').restart, false)
    assert.deepEqual(changes, [])
    for (const id of [...core, 'desktop-appearance']) {
      await assert.rejects(control.setEnabled(id, false))
      assert.equal(writes.at(-1)[id], undefined)
    }
  }
})
function fixture(options = {}) {
  const writes = [], changes = []
  const control = new PluginControl({ catalog, save: async value => writes.push(value),
    apply: async (...args) => changes.push(args), phase: () => 'active', ...options })
  return { control, writes, changes }
}
test('hot changes apply once; cold changes cancel restart when reverted', async () => {
  const { control, changes } = fixture()
  assert.equal((await control.setEnabled('hot', false)).restartRequired, false)
  await control.setEnabled('hot', false)
  assert.deepEqual(changes, [['hot', false]])
  assert.equal((await control.setEnabled('cold', false)).restartRequired, true)
  assert.equal((await control.setEnabled('cold', true)).restartRequired, false)
})
test('a disabled boot generation compares against disabled, not factory defaults', async () => {
  const { control } = fixture({ saved: { cold: false }, running: { cold: false } })
  assert.equal(control.status().restartRequired, false)
  assert.equal((await control.setEnabled('cold', true)).restartRequired, true)
  assert.equal((await control.setEnabled('cold', false)).restartRequired, false)
})
test('failed hot apply retains intent and exposes error; retry can recover', async () => {
  let fail = true
  const { control } = fixture({ apply: async () => { if (fail) throw Error('activation failed') } })
  let state = await control.setEnabled('hot', false)
  assert.equal(state.restartRequired, true)
  assert.match(state.rows[0].error, /activation failed/)
  fail = false
  state = await control.setEnabled('hot', false)
  assert.equal(state.restartRequired, false)
  assert.equal(state.rows[0].error, null)
})
test('write failure does not apply; concurrent switches serialize and retain both values', async () => {
  const { control, changes } = fixture({ save: async () => { throw Error('disk full') } })
  await assert.rejects(control.setEnabled('hot', false), /disk full/)
  assert.equal(control.status().rows[0].enabled, true)
  assert.deepEqual(changes, [])
  const next = fixture()
  await Promise.all([next.control.setEnabled('hot', false), next.control.setEnabled('cold', false)])
  assert.deepEqual(next.writes.at(-1), { hot: false, cold: false })
  await assert.rejects(next.control.setEnabled('settings', false))
  await assert.rejects(next.control.setEnabled('hot', 'false'))
})
test('without runtime hot reload every changed switch requires restart', async () => {
  const { control, changes } = fixture({ hotAvailable: false })
  assert.equal((await control.setEnabled('hot', false)).restartRequired, true)
  assert.deepEqual(changes, [])
})

test('market installation survives concurrent clients and does not reinstall disabled bundles', async () => {
  let bundles = [], finish
  const calls = []
  const market = createMarketplaceInstaller(() => ({ listBundles: async () => bundles,
    installBundle: async (...args) => {
      calls.push(args)
      await new Promise(resolve => { finish = resolve })
      bundles = [{ name: 'dshmarket', installed: true, enabled: true }]
      return { application: 'applied' }
    } }))
  assert.equal((await market.status()).installed, false)
  const first = market.install(), second = market.install()
  assert.equal(first, second)
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  assert.equal((await market.status()).installing, true)
  assert.deepEqual(calls, [['dshmarket', { enabled: true }]])
  finish(); await first
  assert.equal((await market.status()).installed, true)
  bundles[0].enabled = false
  await market.install()
  assert.equal(calls.length, 1)
  assert.equal((await market.status()).installing, false)
  bundles = []
  assert.equal((await market.status()).installed, false, 'external removal restores the install entry')
})

test('market failures remain visible after reconnect and retry uses the native manager again', async () => {
  let attempt = 0, bundles = []
  const market = createMarketplaceInstaller(() => ({ listBundles: async () => bundles,
    installBundle: async () => {
      if (++attempt === 1) return { application: 'failed', packageResult: { output: 'registry unavailable' } }
      bundles = [{ name: 'dshmarket', enabled: true }]
      return { application: 'restart-required' }
    } }))
  await market.install()
  let state = await market.status()
  assert.equal(state.installed, false)
  assert.equal(state.installing, false)
  assert.match(state.error, /registry unavailable/)
  await market.install()
  state = await market.status()
  assert.equal(state.error, '')
  assert.equal(state.restartRequired, true)
  bundles = []
  assert.equal((await market.status()).restartRequired, false)
})

test('unavailable or unreadable inventories never trigger an installation', async () => {
  const absent = createMarketplaceInstaller(() => null)
  await absent.install()
  assert.equal((await absent.status()).available, false)
  let installs = 0
  const unreadable = createMarketplaceInstaller(() => ({ listBundles: async () => { throw Error('unreadable profile') },
    installBundle: async () => { installs++ } }))
  await unreadable.install()
  assert.equal(installs, 0)
  assert.equal((await unreadable.status()).installed, null)
  assert.match((await unreadable.status()).error, /unreadable profile/)
})

test('market installer reports compatibility and build refusals without bypassing native checks', async () => {
  for (const [result, message] of [
    [{ application: 'failed', error: { code: 'incompatible-version' } }, /不兼容/],
    [{ application: 'failed', pendingBuilds: ['dependency'] }, /构建脚本/],
    [{ application: 'overridden' }, /未能启用/],
  ]) {
    const market = createMarketplaceInstaller(() => ({ listBundles: async () => [], installBundle: async () => result }))
    await market.install()
    assert.match((await market.status()).error, message)
  }
})

test('market prompt installs from settings, prevents repeated clicks, and disappears for installed bundles', () => {
  let market = { installed: false, available: true }, installs = 0, checks = 0
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) }
  const Prompt = createMarketplacePrompt(React, { useStatus: () => ({ marketplace: market }),
    install: () => installs++, refresh: () => checks++, isBusy: () => false })
  const button = () => Prompt().children.find(node => node?.type === 'button')
  assert.equal(button().children[0], '安装插件市场')
  button().props.onClick(); assert.equal(installs, 1)
  market.installing = true
  assert.equal(button().props.disabled, true)
  market = { installed: true, available: true, enabled: false }
  assert.equal(Prompt(), null)
  market = { installed: null, available: true, error: 'check failed' }
  button().props.onClick(); assert.equal(checks, 1); assert.equal(installs, 1)
  market.available = false
  assert.equal(button().props.disabled, true)
})
