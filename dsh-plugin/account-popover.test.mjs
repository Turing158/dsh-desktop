import test from 'node:test'
import assert from 'node:assert/strict'
import { formatBalance, balanceRows, platformHref } from './account-popover/model.mjs'
import { mountAccountPopover } from './account-popover/mount.mjs'

test('nested launcher adapters retain native child rendering and follow notification replacement', () => {
  const window = {}
  vm.runInNewContext(readFileSync(new URL('./ui-overlay/slot-compat.js', import.meta.url), 'utf8'), { window })
  const React = { useCallback: fn => fn, createElement: (Component, props) => Component(props) }
  const entries = new Map(), declarations = new Set(['launcher', 'notifications']), listeners = new Map()
  const slots = {
    entries: key => entries.get(key) || [],
    subscribe(key, fn) { const rows = listeners.get(key) || new Set(); listeners.set(key, rows); rows.add(fn); return () => rows.delete(fn) },
    register(options, component) {
      assert.ok(declarations.has(options.name), 'registration targets a declared child')
      for (const key of Object.keys(options.children || {})) { assert.ok(!declarations.has(key), 'child has one owner'); declarations.add(key) }
      const entry = { options, component, children: options.children, select: options.select, inject: options.inject, locale: options.locale, store: options.store }
      entries.set(options.name, [...slots.entries(options.name), entry])
      return () => {
        entries.set(options.name, slots.entries(options.name).filter(value => value !== entry))
        for (const key of Object.keys(options.children || {})) declarations.delete(key)
      }
    },
  }
  const source = { options: {}, children: { notifications: { kind: 'single', scope: 'root' } },
    component: props => props.renderSlot('notifications', { active: true }, { only: 'notice' }) }
  const notice = { options: { priority: 3 }, component: () => 'notice', inject: () => ({ hooks: {} }), select: owner => owner }
  entries.set('notifications', [notice])
  const account = window.__DSH_SLOT_CHILDREN__(React, slots, source, 'account')
  const offAccount = slots.register({ name: 'launcher', children: account.children }, account.component)
  const unmountAccount = account.mount()
  const accountEntry = slots.entries('launcher')[0]
  const settings = window.__DSH_SLOT_CHILDREN__(React, slots, accountEntry, 'settings')
  const offSettings = slots.register({ name: 'launcher', children: settings.children }, settings.component)
  const unmountSettings = settings.mount()
  const result = settings.component({ renderSlot: (key, owner, options) => {
    assert.equal(key, 'settings.account.notifications')
    assert.equal(owner.active, true); assert.equal(options.only, 'notice')
    return slots.entries(key)[0].component({})
  } })
  assert.equal(result, 'notice')
  assert.equal(slots.entries('account.notifications')[0].inject, notice.inject)
  assert.equal(slots.entries('account.notifications')[0].select, notice.select)
  entries.set('notifications', [{ ...notice, component: () => 'replacement' }])
  for (const fn of listeners.get('notifications')) fn()
  for (const fn of listeners.get('account.notifications')) fn()
  assert.equal(slots.entries('settings.account.notifications').length, 1)
  assert.equal(slots.entries('settings.account.notifications')[0].component({}), 'replacement')
  unmountSettings(); offSettings(); unmountAccount(); offAccount()
  assert.equal(slots.entries('notifications').length, 1)
  assert.equal(slots.entries('account.notifications').length, 0)
  assert.equal(slots.entries('settings.account.notifications').length, 0)
  assert.ok([...listeners.values()].every(rows => rows.size === 0))
})
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

test('wallet display retains decimal precision, sub-cent values and signed rounding', () => {
  for (const [value, expected] of [['0', '¥0.00'], ['0.40', '¥0.40'], ['0.005', '<¥0.01'],
    ['1.239999', '¥1.23'], ['-0.0001', '-¥0.01'], ['-1.235', '-¥1.24'], ['-0', '¥0.00'],
    ['9999999999999999999.999', '¥9,999,999,999,999,999,999.99'], ['1e-3', '<¥0.01']]) {
    assert.equal(formatBalance(value).text, expected)
  }
  assert.equal(formatBalance('2.5', 'USD').text, '$2.50')
  assert.equal(formatBalance('NaN'), null)
  assert.equal(formatBalance('1e999999'), null)
})

test('loading and failed balances never become fabricated zeroes; known empty grants do', () => {
  assert.equal(balanceRows(undefined), null)
  assert.equal(balanceRows({ balance: { status: 'failed' } }, true), null)
  const details = { balance: { status: 'ready', value: [{ currency: 'USD', balance: '10' }], bonusWallets: [] } }
  assert.deepEqual(balanceRows(details, true), [{ currency: 'USD', balance: '0' }])
  details.balance.bonusWallets = [{ currency: 'CNY', balance: '0.05' }, { currency: 'USD', balance: '2' }]
  assert.deepEqual(balanceRows(details, true), details.balance.bonusWallets)
})

test('platform actions use the account URLs and reject non-web schemes', () => {
  const view = { links: { topUpUrl: 'https://platform.deepseek.com/top_up', usageUrl: 'https://platform.deepseek.com/usage' } }
  assert.equal(platformHref(view, 'top-up'), view.links.topUpUrl)
  assert.equal(platformHref(view, 'usage'), view.links.usageUrl)
  assert.equal(platformHref(undefined, 'usage'), undefined)
  assert.equal(platformHref({ links: { usageUrl: 'javascript:alert(1)' } }, 'usage'), undefined)
})

test('launcher follows upstream arrival/replacement, vanilla mode, and teardown without duplicates', () => {
  let notify, modeChanged, mode = 'desktop'
  const previousObserver = globalThis.MutationObserver
  globalThis.MutationObserver = class { constructor(fn) { modeChanged = fn } observe() {} disconnect() { modeChanged = null } }
  const native = component => ({ options: { name: 'settings.launcher', priority: 2 }, locale: 'settings.account',
    component, inject: () => ({ hooks: { account: {} } }), store: {} })
  const a = native(function A() {}), b = native(function B() {})
  const entries = []
  const slots = { entries: () => entries, entriesOfSlot: () => [...entries].sort((a, b) => a.options.priority - b.options.priority).slice(0, 1),
    subscribe: (_, fn) => { notify = fn; return () => { notify = null } },
    register(options, component) {
      const entry = { options, component, locale: options.locale, inject: options.inject, store: options.store }
      entries.push(entry); notify?.()
      return () => { entries.splice(entries.indexOf(entry), 1); notify?.() }
    } }
  try {
    const off = mountAccountPopover(slots, () => function Enhanced() {}, { getAttribute: () => mode })
    entries.push(a); notify()
    assert.equal(entries.length, 2)
    assert.equal(entries[1].options.priority, -8)
    assert.equal(entries[1].inject, a.inject)
    assert.equal(entries[1].store, a.store)
    notify(); assert.equal(entries.length, 2)
    // The appearance plugin wraps the winning launcher to add its settings gear.
    // Its lower priority puts it before the native account in the real ledger.
    const settings = native(Object.assign(function Settings() {}, { __dshSettingsLauncher: true }))
    settings.options.priority = -9
    entries.unshift(settings); notify()
    assert.equal(entries.length, 3)
    assert.equal(entries[2].inject, a.inject)
    entries.shift(); notify()
    mode = 'vanilla'; modeChanged(); assert.deepEqual(entries, [a])
    mode = 'desktop'; modeChanged(); assert.equal(entries.length, 2)
    entries[0] = b; notify(); assert.equal(entries.length, 2); assert.equal(entries[1].inject, b.inject)
    off(); assert.deepEqual(entries, [b]); assert.equal(notify, null); assert.equal(modeChanged, null)
  } finally { globalThis.MutationObserver = previousObserver }
})

test('account and existing settings adapters converge in either load order without duplicate priorities', () => {
  const appearance = readFileSync(new URL('./ui-client/client.js', import.meta.url), 'utf8')
  const settingsBinder = appearance.match(/function bindSettingsLauncher\(ctx\) \{[\s\S]*?\r?\n    \}/)?.[0]
  assert.ok(settingsBinder, 'settings launcher binder is present')
  const previousObserver = globalThis.MutationObserver
  try {
    for (const accountFirst of [true, false]) {
      let mode = 'desktop', queued = false
      const observers = new Set(), listeners = new Set(), disposers = []
      const root = { getAttribute: () => mode }
      globalThis.MutationObserver = class {
        constructor(fn) { this.fn = fn }
        observe() { observers.add(this.fn) }
        disconnect() { observers.delete(this.fn) }
      }
      const native = { component: function Native() {}, locale: 'settings.account', options: { priority: 0 }, inject: () => ({}) }
      let entries = [native]
      const slots = {
        entries: () => entries,
        inject: (_, start) => { disposers.push(start()) },
        subscribe: (_, fn) => { listeners.add(fn); return () => listeners.delete(fn) },
        register(options, component) {
          assert.ok(!entries.some(e => e.options.priority === options.priority), 'single slots reject duplicate priorities')
          const entry = { options, component, locale: options.locale, inject: options.inject }
          entries = [...entries, entry].sort((a, b) => a.options.priority - b.options.priority)
          queued = true
          return () => { entries = entries.filter(e => e !== entry); queued = true }
        },
      }
      function flush() {
        let iterations = 0
        while (queued) {
          assert.ok(++iterations < 20, 'adapters must settle instead of wrapping one another repeatedly')
          queued = false
          for (const listener of [...listeners]) listener()
        }
      }
      const bindAccount = () => disposers.push(mountAccountPopover(slots, () => function Account() {}, root))
      const bindSettings = () => vm.runInNewContext(`(${settingsBinder})({ slots })`, {
        slots, primitives: { IconSettingsOutlineMedium() {} }, document: { documentElement: root },
        window: {}, React: {},
        MODE_ATTRIBUTE: 'data-dsh-ui', VANILLA: 'vanilla', MutationObserver: globalThis.MutationObserver,
      })
      for (const bind of accountFirst ? [bindAccount, bindSettings] : [bindSettings, bindAccount]) { bind(); flush() }
      assert.equal(entries.length, 3)
      assert.equal(entries[0].component.__dshSettingsLauncher, true)
      assert.equal(entries[1].component.name, 'Account')
      for (const next of ['vanilla', 'desktop']) {
        mode = next; for (const observer of [...observers]) observer(); flush()
        assert.equal(entries.length, next === 'vanilla' ? 1 : 3)
      }
      disposers.reverse().forEach(dispose => dispose?.()); flush()
      assert.deepEqual(entries, [native])
    }
  } finally { globalThis.MutationObserver = previousObserver }
})
