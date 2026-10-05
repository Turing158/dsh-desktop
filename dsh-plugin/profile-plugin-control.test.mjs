import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ProfilePluginControl, parseSwitches, startupSwitches, hotCapability } from './plugin-control/profile-model.mjs'
import { presetInventoryRow, createInventoryView } from './plugin-control/inventory-view.mjs'

test('preset switches share global saved intent, restart state and errors in both directions', async () => {
  const { control } = fixture()
  const preset = { id: 'standard', name: 'Standard' }, entry = { moduleName: 'cold-module', enabled: true }
  const project = state => presetInventoryRow(entry, preset, 0, state.rows)
  let alias = project(await control.status())
  assert.equal(alias.switchId, 'include:cold')
  alias = project(await control.setEnabled(alias.switchId, false))
  assert.equal(alias.enabled, false)
  assert.equal(alias.restart, true)
  assert.equal(alias.presetEnabled, true)
  alias = project(await control.setEnabled('include:cold', true))
  assert.equal(alias.enabled, true)
  assert.equal(alias.restart, false)
  const failed = fixture({ apply: async () => { throw Error('failed apply') } })
  const state = await failed.control.setEnabled('include:hot', false)
  const hot = presetInventoryRow({ moduleName: 'hot-module' }, preset, 1, state.rows)
  assert.equal(hot.error, row(state, 'hot').error)
})

test('preset matching preserves protections and refuses missing or ambiguous global targets', () => {
  const preset = { id: 'standard' }, entry = { moduleName: 'module', enabled: 'conditional' }
  const global = { id: 'include:a', entryId: 'include:a', moduleName: 'module', enabled: false, readOnlyReason: 'management-required' }
  assert.equal(presetInventoryRow(entry, preset, 0, [global]).readOnlyReason, 'management-required')
  for (const plugins of [[], [global, { ...global, id: 'include:b', entryId: 'include:b' }]]) {
    const result = presetInventoryRow(entry, preset, 0, plugins)
    assert.equal(result.switchId, undefined)
    assert.equal(result.readOnlyReason, 'unaddressable')
  }
  assert.equal(presetInventoryRow({ ...entry, entryId: 'include:a' }, preset, 0,
    [global, { ...global, id: 'include:b', entryId: 'include:b' }]).switchId, 'include:a')
})

test('preset card switch and retry address the global entry independently from disclosure', () => {
  const calls = [], states = []
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useId: () => 'test', useState: initial => [initial, value => states.push(value)] }
  const plugin = { id: 'include:a', entryId: 'include:a', moduleName: 'module', enabled: false, error: 'failed', readOnlyReason: null }
  const Inventory = createInventoryView({ React, ui: { Switch: 'switch' },
    useStatus: () => ({ plugins: [plugin], agentPresets: [{ id: 'standard', rows: [{ moduleName: 'module', enabled: true }] }] }),
    displayRow: row => ({ ...row, label: 'Module' }), change: (...args) => calls.push(args),
    feedback: () => '', isBusy: () => false, phases: {}, presetName: p => p.id })
  const flatten = node => !node || typeof node !== 'object' ? [] : Array.isArray(node)
    ? node.flatMap(flatten) : [node, ...node.children.flatMap(flatten)]
  const card = flatten(Inventory()).find(node => typeof node.type === 'function' && node.props.row?.source === 'preset')
  const nodes = flatten(card.type(card.props))
  const toggle = nodes.find(node => node.type === 'switch')
  assert.equal(toggle.props.checked, false)
  assert.equal(toggle.props.disabled, false)
  toggle.props.onChange(true)
  nodes.find(node => node.type === 'button' && node.children.includes('重试切换')).props.onClick()
  assert.deepEqual(calls, [['include:a', true, 'profile'], ['include:a', false, 'profile']])
  assert.deepEqual(states, [])
})

function fixture(options = {}) {
  const live = [
    { entryId: 'include:cold', patchId: 'cold', moduleName: 'cold-module', enabled: true, fiberPhase: 'active', hot: false },
    { entryId: 'include:hot', patchId: 'hot', moduleName: 'hot-module', enabled: true, fiberPhase: 'active', hot: true },
    { entryId: 'include:core', moduleName: 'core', enabled: true, readOnlyReason: 'management-required' },
  ]
  let saved = options.saved || [], calls = []
  const control = new ProfilePluginControl({ saved,
    list: async () => ({ rows: live }),
    save: async intent => { saved = [...saved.filter(row => row.patchId !== intent.patchId), intent]; return saved },
    apply: async (row, enabled) => { calls.push([row.entryId, enabled]); const actual = live.find(r => r.entryId === row.entryId); actual.enabled = enabled; actual.fiberPhase = enabled ? 'active' : null },
    ...options,
  })
  return { live, control, calls }
}
const row = (state, id) => state.rows.find(row => row.patchId === id)

test('deferred intent survives another hot apply and cancels when reverted', async () => {
  const { control, live, calls } = fixture()
  let state = await control.setEnabled('include:cold', false)
  assert.equal(row(state, 'cold').restart, true)
  assert.equal(live[0].enabled, true)
  state = await control.setEnabled('include:hot', false)
  assert.equal(row(state, 'hot').phase, 'disabled')
  assert.equal(row(state, 'cold').running, true)
  assert.equal(row(state, 'cold').enabled, false)
  assert.deepEqual(calls, [['include:hot', false]])
  state = await control.setEnabled('include:cold', true)
  assert.equal(state.restartRequired, false)
})

test('startup mismatches and missing dependencies are distinct from pending restarts', async () => {
  const { control, live } = fixture({ saved: [{ patchId: 'cold', moduleName: 'cold-module', enabled: false }] })
  assert.equal(row(await control.status(), 'cold').application, 'overridden')
  live[0].enabled = false; live[0].fiberPhase = null
  assert.equal(row(await control.status(), 'cold').application, 'applied')
  live[1].fiberPhase = 'pending'
  assert.equal(row(await control.status(), 'hot').phase, 'pending')
  assert.equal((await control.status()).restartRequired, false)
})

test('failed hot switches retain saved intent and diagnostics without claiming restart is a remedy', async () => {
  const { control } = fixture({ apply: async () => { throw Error('unload failed; rollback failed') } })
  const state = await control.setEnabled('include:hot', false)
  assert.equal(row(state, 'hot').enabled, false)
  assert.equal(row(state, 'hot').running, true)
  assert.equal(row(state, 'hot').application, 'failed')
  assert.match(row(state, 'hot').error, /rollback failed/)
  assert.equal(state.restartRequired, false)
  assert.equal(row(await control.setEnabled('include:hot', true), 'hot').error, null)
})

test('write failures, protected entries and invalid arguments never apply', async () => {
  const { control, calls } = fixture({ save: async () => { throw Error('disk full') } })
  await assert.rejects(control.setEnabled('include:hot', false), /disk full/)
  assert.equal(row(await control.status(), 'hot').enabled, true)
  await assert.rejects(control.setEnabled('include:core', false), /不可修改/)
  await assert.rejects(control.setEnabled('gone', true), /不存在/)
  await assert.rejects(control.setEnabled('include:hot', 'false'), /无效/)
  assert.deepEqual(calls, [])
})

test('concurrent switches serialize and preserve both saved settings', async () => {
  const { control, calls } = fixture()
  await Promise.all([control.setEnabled('include:hot', false), control.setEnabled('include:cold', false), control.setEnabled('include:hot', true)])
  assert.deepEqual(calls, [['include:hot', false], ['include:hot', true]])
  const state = await control.status()
  assert.equal(row(state, 'hot').enabled, true)
  assert.equal(row(state, 'cold').enabled, false)
})

test('boot patches match both id and module and reject protected, stale or ambiguous targets', () => {
  const protectedModules = JSON.parse(readFileSync(new URL('./plugin-control/protected-modules.json', import.meta.url)))
  const entries = [{ id: 'cold', name: 'cold-module' }, { id: 'core', name: protectedModules[0] }, { id: 'desktop-plugin-control', name: './control' },
    { id: 'duplicate', name: 'one' }, { id: 'duplicate', name: 'two' }]
  const intents = [...entries, { id: 'gone', name: 'gone-module' }, { id: 'cold', name: 'changed-module' }]
    .map(row => ({ patchId: row.id, moduleName: row.name, enabled: false }))
  const boot = startupSwitches(intents, entries, protectedModules)
  assert.deepEqual(boot.patches, [{ id: 'cold', name: 'cold-module', disabled: true }])
  assert.equal(boot.notices.length, intents.length - 1)
  assert.equal(entries[0].disabled, undefined)
})

test('strict saved schema and exact package/runtime capability matching', () => {
  for (const doc of [{ version: 2, entries: [] }, { version: 1, entries: {} }, { version: 1, entries: [{ patchId: 'a', moduleName: 'a', enabled: 'false' }] },
    { version: 1, entries: Array(2).fill({ patchId: 'a', moduleName: 'a', enabled: true }) }]) assert.throws(() => parseSwitches(doc))
  const record = { moduleName: 'module', packageName: 'package', version: '1.0', runtimeVersion: '2.0', hint: 'verified' }
  const saved = { patchId: 'a', moduleName: 'module', enabled: false, runtimeVersion: '2.0' }
  assert.deepEqual(parseSwitches({ version: 1, entries: [saved] }), [saved])
  assert.equal(startupSwitches([saved], [{ id: 'a', name: 'module' }], [], '2.1').patches.length, 0)
  assert.equal(startupSwitches([saved], [{ id: 'a', name: 'module' }], [], '2.0').patches.length, 1)
  assert.equal(hotCapability(record, '2.0', [record], true).hot, true)
  for (const [item, runtime, hmr] of [[record, '2.1', true], [{ ...record, version: '1.1' }, '2.0', true], [record, '2.0', false], [{ ...record, packageName: 'alias' }, '2.0', true]]) {
    assert.equal(hotCapability(item, runtime, [record], hmr).hot, false)
  }
})
