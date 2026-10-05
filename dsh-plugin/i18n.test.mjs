import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const messages = JSON.parse(readFileSync(new URL('./i18n/en.json', import.meta.url)))
const source = readFileSync(new URL('./i18n/runtime.js', import.meta.url), 'utf8')

function fixture() {
  const window = { __DSH_I18N_MESSAGES__: messages }
  class CustomEvent { constructor(type, options) { this.type = type; this.detail = options.detail } }
  vm.runInNewContext(source, { window, navigator: { language: 'zh-CN' },
    document: { dispatchEvent() {} }, CustomEvent })
  let active = 'zh', dictionary, registrations = 0
  const listeners = new Set()
  const service = {
    register(ns, dict) { assert.equal(ns, 'desktop'); registrations++; dictionary = dict; return () => { registrations-- } },
    bind: () => key => dictionary[active][key],
    getLocale: () => ({ active }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    setLocale(value) { active = value; for (const fn of listeners) fn() },
  }
  return { runtime: window.__DSH_I18N__, service, listeners, count: () => registrations }
}

test('desktop strings follow the host locale in both directions and dispose subscriptions', () => {
  const f = fixture(), revisions = []
  const off = f.runtime.subscribe(() => revisions.push(f.runtime.snapshot()))
  const disconnect = f.runtime.connect(f.service)
  assert.equal(f.runtime.t('外观'), '外观')
  f.service.setLocale('en')
  assert.equal(f.runtime.t('外观'), 'Appearance')
  assert.equal(f.runtime.t('在{region}显示', { region: 'Title bar' }), 'Show in Title bar')
  const unchanged = '我的文件 中文路径.txt'
  assert.equal(f.runtime.t(unchanged), unchanged)
  f.service.setLocale('zh')
  assert.equal(f.runtime.t('Appearance'), '外观')
  assert.equal(new Set(revisions).size, 3)
  off(); disconnect()
  assert.equal(f.listeners.size, 0)
  assert.equal(f.count(), 0)
})

test('every translated template preserves its interpolation placeholders', () => {
  const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  for (const [zh, en] of Object.entries(messages)) {
    assert.equal(typeof en, 'string', zh)
    assert.deepEqual(placeholders(en), placeholders(zh), zh)
  }
})
