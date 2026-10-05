import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./title-bar/client.js', import.meta.url), 'utf8')
const flush = () => new Promise(setImmediate)
const tags = { latest: '0.1.7-rc.2', next: '0.2.0-rc.1' }

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Render the actual title-bar bundle with stateful hooks; only the external UI
// primitives and native IPC are stubs. Tests click its real handlers and await
// controlled native responses, including repeated clicks before a rerender.
function fixture({ check, install, host = true } = {}) {
  let factory, slot, cursor = 0
  const hooks = [], calls = []
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const at = cursor++
      if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial
      return [hooks[at], value => { hooks[at] = typeof value === 'function' ? value(hooks[at]) : value }]
    },
    useRef(initial) {
      const at = cursor++
      if (!(at in hooks)) hooks[at] = { current: initial }
      return hooks[at]
    },
    useReducer(_reducer, initial) { return this.useState(initial) },
    useEffect() {},
  }
  const sandbox = {
    document: {
      body: {}, addEventListener() {},
      documentElement: { getAttribute: () => null, style: { setProperty() {} } },
    },
    getSelection: () => null,
    __ModuleLoader__: { load: entry => { factory = entry.factory } },
    __TAURI__: host ? { core: { invoke: async (command, args) => {
      calls.push({ command, args })
      if (command === 'check_dsh_update') return check?.()
      if (command === 'install_dsh_update') return install?.(args.channel)
      return ''
    } } } : undefined,
  }
  sandbox.window = sandbox
  vm.runInNewContext(source, sandbox)
  factory(name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: tree => tree }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Menu: 'Menu', Modal: 'Modal', Button: 'Button', Input: 'Input' }
    throw Error(name)
  }).apply({ effect: fn => fn(), slots: {
    inject(_name, fn) { fn() },
    register(_options, component) { slot = component },
  } })

  function render() {
    cursor = 0
    const nodes = []
    function visit(node) {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!node || typeof node !== 'object') return
      if (typeof node.type === 'function') { visit(node.type(node.props)); return }
      nodes.push(node)
      visit(node.props?.children)
      visit(node.props?.anchor)
      visit(node.props?.footer)
    }
    visit(slot())
    return nodes
  }
  const menu = () => render().find(node => node.type === 'Menu' && node.props.anchor.props.children.includes('更多'))
  const item = () => menu().props.items.find(item => item.id === 'dsh-update')
  const button = label => render().find(node => node.type === 'Button' && node.props.children.includes(label))
  function openMore() { menu().props.anchor.props.onClick() }
  function selectUpdate() { menu().props.onSelect('dsh-update') }
  function openDialog() { if (!menu().props.open) openMore(); selectUpdate() }
  const updateCalls = () => calls.filter(call => /dsh_update$/.test(call.command))
  return { render, menu, item, button, openMore, selectUpdate, openDialog, updateCalls }
}

test('checking disables the menu item and suppresses duplicate clicks', async () => {
  const pending = deferred()
  const f = fixture({ check: () => pending.promise })
  assert.equal(f.item().label, '检测dsh更新')
  f.openMore()
  const select = f.menu().props.onSelect
  select('dsh-update'); select('dsh-update')
  assert.equal(f.updateCalls().length, 1)
  assert.equal(f.item().disabled, true)
  assert.match(f.item().label, /正在检测/)
  f.selectUpdate()
  assert.equal(f.updateCalls().length, 1)
  pending.resolve({ current: '0.1.5-rc.2', ...tags })
  await flush()
  assert.equal(f.item().disabled, false)
  assert.equal(f.item().label, 'dsh 可更新')
  f.openDialog()
  assert.ok(f.render().some(node => node.type === 'Modal' && node.props.title === 'dsh 更新'))
  assert.equal(f.updateCalls().length, 1, 'opening the result does not run another check')
})

for (const [current, latest, next, label, stableDisabled, previewDisabled] of [
  [tags.latest, tags.latest, tags.next, 'dsh 已是最新版', true, false],
  [tags.next, tags.latest, tags.next, 'dsh 已是最新预览版', false, true],
  ['0.1.5-rc.2', tags.latest, tags.next, 'dsh 可更新', false, false],
  ['1.0.0', '1.0.0', '1.0.0', 'dsh 已是最新版', true, undefined],
  ['0.9.0', '1.0.0', '1.0.0', 'dsh 可更新', false, undefined],
]) {
  test(`version comparison: ${current} / ${latest} / ${next}`, async () => {
    const f = fixture({ check: async () => ({ current, latest, next }), install: async () => latest })
    f.openMore(); f.selectUpdate(); await flush()
    assert.equal(f.item().label, label)
    f.openDialog()
    assert.equal(f.button('最新稳定版').props.disabled, stableDisabled)
    assert.equal(f.button('最新预览版')?.props.disabled, previewDisabled)
    assert.equal(f.render().some(node => node.type === 'dt' && node.props.children.includes('最新预览版')), latest !== next)
    if (stableDisabled) f.button('最新稳定版').props.onClick()
    if (previewDisabled) f.button('最新预览版').props.onClick()
    assert.equal(f.updateCalls().length, 1, 'a disabled channel cannot start installation')
    if (latest === next && !stableDisabled) {
      f.button('最新稳定版').props.onClick(); await flush()
      assert.equal(f.updateCalls().length, 2)
      assert.equal(f.updateCalls()[1].args.channel, 'latest')
      assert.equal(f.item().label, 'dsh 已是最新版')
      assert.equal(f.button('最新稳定版').props.disabled, true)
      assert.equal(f.button('最新预览版'), undefined)
    }
  })
}

for (const channel of ['latest', 'next']) {
  test(`${channel} installation is exclusive and updates the displayed version`, async () => {
    const pending = deferred()
    const f = fixture({ check: async () => ({ current: '0.1.5-rc.2', ...tags }), install: () => pending.promise })
    f.openMore(); f.selectUpdate(); await flush(); f.openDialog()
    const selected = f.button(channel === 'latest' ? '最新稳定版' : '最新预览版')
    const other = f.button(channel === 'latest' ? '最新预览版' : '最新稳定版')
    selected.props.onClick(); selected.props.onClick(); other.props.onClick()
    assert.equal(f.button('最新稳定版').props.disabled, true)
    assert.equal(f.button('最新预览版').props.disabled, true)
    assert.equal(f.button('重新检测').props.disabled, true)
    const calls = f.updateCalls()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].command, 'install_dsh_update')
    assert.equal(calls[1].args.channel, channel)
    // Dismiss and reopen while installing: status is retained and no new call.
    f.render().find(node => node.type === 'Modal').props.onClose()
    f.openDialog()
    assert.equal(f.button('最新稳定版').props.disabled, true)
    pending.resolve(tags[channel]); await flush()
    assert.equal(f.button('最新稳定版').props.disabled, channel === 'latest')
    assert.equal(f.button('最新预览版').props.disabled, channel === 'next')
    assert.ok(f.render().some(node => node.props.children?.some(text => typeof text === 'string' && text.includes('从托盘退出'))))
  })
}

test('a failed check stays clickable, shows its error, and can be retried', async () => {
  let attempts = 0
  const f = fixture({ check: async () => {
    if (++attempts === 1) throw Error('registry unavailable')
    return { current: tags.latest, ...tags }
  } })
  f.openMore(); f.selectUpdate(); await flush()
  assert.equal(f.item().disabled, false)
  assert.equal(f.item().label, 'dsh 检测失败')
  f.openDialog()
  assert.equal(f.button('最新稳定版').props.disabled, true)
  assert.equal(f.button('最新预览版').props.disabled, true)
  assert.ok(f.render().some(node => node.props.role === 'alert' && node.props.children.includes('registry unavailable')))
  f.button('重新检测').props.onClick(); await flush()
  assert.equal(f.item().label, 'dsh 已是最新版')
  assert.equal(f.button('最新预览版').props.disabled, false)
})

test('failed installation releases both buttons and preserves the last verified version', async () => {
  let attempts = 0
  const f = fixture({ check: async () => ({ current: '0.1.5-rc.2', ...tags }), install: async () => {
    if (++attempts === 1) throw Error('npm EACCES')
    return tags.latest
  } })
  f.openMore(); f.selectUpdate(); await flush(); f.openDialog()
  f.button('最新稳定版').props.onClick(); await flush()
  assert.equal(f.item().label, 'dsh 更新失败')
  assert.equal(f.item().disabled, false)
  assert.equal(f.button('最新稳定版').props.disabled, false)
  assert.equal(f.button('最新预览版').props.disabled, false)
  assert.ok(f.render().some(node => node.props.role === 'alert' && node.props.children.includes('npm EACCES')))
  f.button('最新稳定版').props.onClick(); await flush()
  assert.equal(f.button('最新稳定版').props.disabled, true)
})

test('ordinary browsers do not offer a desktop package update', async () => {
  const f = fixture({ host: false })
  f.openMore()
  assert.equal(f.item(), undefined)
})
