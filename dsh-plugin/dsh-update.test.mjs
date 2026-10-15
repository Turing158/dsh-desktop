import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./title-bar/client.js', import.meta.url), 'utf8')
const flush = () => new Promise(setImmediate)
const tags = { latest: '0.2.0-rc.2', preview: '0.2.1-alpha.2' }
const desktopRelease = { current: '0.1.0', release: { version: '0.2.0', name: 'Desktop v0.2.0', notes: '## Changes\n- Fixes',
  publishedAt: '2026-10-05T14:59:05Z', prerelease: false, updateAvailable: true,
  url: 'https://github.com/Turing158/dsh-desktop/releases/tag/v0.2.0' } }

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Render the actual title-bar bundle with stateful hooks; only the external UI
// primitives and native IPC are stubs. Tests click its real handlers and await
// controlled native responses, including repeated clicks before a rerender.
function fixture({ check = async () => ({ current: tags.latest, ...tags }), install,
  checkDesktop = async () => desktopRelease, openRelease, host = true } = {}) {
  let factory, slot, cursor = 0
  const hooks = [], calls = [], focused = []
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
      getElementById: id => ({ focus: () => focused.push(id) }),
      documentElement: { getAttribute: () => null, style: { setProperty() {} } },
    },
    getSelection: () => null,
    __ModuleLoader__: { load: entry => { factory = entry.factory } },
    __TAURI__: host ? { core: { invoke: async (command, args) => {
      calls.push({ command, args })
      if (command === 'check_dsh_update') return check?.()
      if (command === 'install_dsh_update') return install?.(args.channel, args.targetVersion)
      if (command === 'check_desktop_update') return checkDesktop()
      if (command === 'open_desktop_release') return openRelease?.(args.url)
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
  function closeDialog() { render().find(node => node.type === 'Modal').props.onClose() }
  const tab = id => render().find(node => node.props.id === 'dsh-update-tab-' + id)
  function selectTab(id) { tab(id).props.onClick() }
  const status = () => render().find(node => node.props.role === 'status')?.props.children[0]
  const updateCalls = () => calls.filter(call => /dsh_update$/.test(call.command))
  const desktopCalls = () => calls.filter(call => call.command === 'check_desktop_update')
  return { render, menu, item, button, openMore, selectUpdate, openDialog, closeDialog, updateCalls, desktopCalls, calls, tab, selectTab, status, focused }
}

test('one click opens the dialog and starts both checks without duplicate requests', async () => {
  const pending = deferred(), desktop = deferred()
  const f = fixture({ check: () => pending.promise, checkDesktop: () => desktop.promise })
  assert.equal(f.item().label, '检测更新...')
  f.openMore()
  const select = f.menu().props.onSelect
  select('dsh-update'); select('dsh-update')
  assert.equal(f.updateCalls().length, 1)
  assert.equal(f.desktopCalls().length, 1)
  assert.equal(f.menu().props.open, false)
  assert.ok(f.render().some(node => node.type === 'Modal' && node.props.title === '检测更新'))
  assert.equal(f.tab('desktop').props['aria-selected'], true)
  assert.equal(f.status(), '正在检测软件更新…')
  assert.equal(f.button('重新检测').props.disabled, true)
  f.selectTab('dsh')
  assert.equal(f.status(), '正在检测 dsh 更新…')
  desktop.resolve(desktopRelease); await flush()
  assert.equal(f.status(), '正在检测 dsh 更新…', 'desktop completion does not clear the dsh spinner')
  f.selectTab('desktop')
  assert.equal(f.status(), '发现新版本')
  pending.resolve({ current: '0.1.5-rc.2', ...tags })
  await flush()
  f.selectTab('dsh')
  assert.equal(f.status(), 'dsh 可更新')
  assert.equal(f.item().label, '检测更新...')
  assert.equal(f.updateCalls().length, 1, 'switching tabs does not run another check')
})

for (const [current, latest, preview, label, stableDisabled, previewDisabled] of [
  [tags.latest, tags.latest, tags.preview, 'dsh 已是最新版', true, false],
  [tags.preview, tags.latest, tags.preview, 'dsh 已是最新预览版', false, true],
  ['0.1.5-rc.2', tags.latest, tags.preview, 'dsh 可更新', false, false],
  ['1.0.0', '1.0.0', '1.0.0', 'dsh 已是最新版', true, undefined],
  ['0.9.0', '1.0.0', '1.0.0', 'dsh 可更新', false, undefined],
  ['1.1.0-beta.1', '1.0.0', '1.1.0-beta.1', 'dsh 已是最新预览版', false, true],
  ['1.1.0', '1.0.0', '1.1.0', 'dsh 已是最新预览版', false, true],
  ['0.2.1-alpha.1', tags.latest, tags.preview, 'dsh 可更新', false, false],
]) {
  test(`version comparison: ${current} / ${latest} / ${preview}`, async () => {
    const f = fixture({ check: async () => ({ current, latest, preview }), install: async () => latest })
    f.openMore(); f.selectUpdate(); await flush()
    f.selectTab('dsh')
    assert.equal(f.status(), label)
    assert.equal(f.tab('dsh').props.children.some(node => node?.props?.className === 'dshTb__updateDot'), label === 'dsh 可更新')
    assert.equal(f.button('最新稳定版').props.disabled, stableDisabled)
    assert.equal(f.button('最新预览版')?.props.disabled, previewDisabled)
    assert.equal(f.render().some(node => node.type === 'dt' && node.props.children.includes('最新预览版')), latest !== preview)
    if (latest !== preview) assert.ok(f.render().some(node => node.type === 'code' && node.props.children.includes(preview)))
    if (stableDisabled) f.button('最新稳定版').props.onClick()
    if (previewDisabled) f.button('最新预览版').props.onClick()
    assert.equal(f.updateCalls().length, 1, 'a disabled channel cannot start installation')
    if (latest === preview && !stableDisabled) {
      f.button('最新稳定版').props.onClick(); await flush()
      assert.equal(f.updateCalls().length, 2)
      assert.equal(f.updateCalls()[1].args.channel, 'latest')
      assert.equal(f.status(), 'dsh 已是最新版')
      assert.equal(f.button('最新稳定版').props.disabled, true)
      assert.equal(f.button('最新预览版'), undefined)
    }
  })
}

for (const channel of ['latest', 'preview']) {
  test(`${channel} installation is exclusive and updates the displayed version`, async () => {
    const pending = deferred()
    const f = fixture({ check: async () => ({ current: '0.1.5-rc.2', ...tags }), install: () => pending.promise })
    f.openDialog(); await flush(); f.selectTab('dsh')
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
    assert.equal(calls[1].args.targetVersion, channel === 'preview' ? tags.preview : undefined)
    // Dismiss and reopen while installing: status is retained and no new call.
    f.render().find(node => node.type === 'Modal').props.onClose()
    f.openDialog()
    f.selectTab('dsh')
    assert.equal(f.button('最新稳定版').props.disabled, true)
    pending.resolve(tags[channel]); await flush()
    assert.equal(f.button('最新稳定版').props.disabled, channel === 'latest')
    assert.equal(f.button('最新预览版').props.disabled, channel !== 'latest')
    assert.ok(f.render().some(node => node.props.children?.some(text => typeof text === 'string' && text.includes('从托盘退出'))))
  })
}

test('preview installation pins the checked version until an explicit recheck', async () => {
  let current = tags.latest, published = tags.preview
  const f = fixture({ check: async () => ({ current, latest: tags.latest, preview: published }),
    install: async (_channel, targetVersion) => { current = targetVersion; return current } })
  f.openDialog(); await flush(); f.selectTab('dsh')
  published = '0.2.1-alpha.3'
  f.button('最新预览版').props.onClick(); await flush()
  assert.equal(f.updateCalls()[1].args.channel, 'preview')
  assert.equal(f.updateCalls()[1].args.targetVersion, tags.preview)
  assert.equal(f.status(), 'dsh 已是最新预览版')
  assert.equal(f.button('最新预览版').props.disabled, true)
  assert.equal(f.render().filter(node => node.type === 'code' && node.props.children.includes(tags.preview)).length, 2)
  f.button('重新检测').props.onClick(); await flush()
  assert.equal(f.status(), 'dsh 可更新')
  assert.equal(f.button('最新预览版').props.disabled, false)
  f.button('最新预览版').props.onClick(); await flush()
  assert.equal(f.updateCalls().at(-1).args.targetVersion, published)
  assert.equal(f.status(), 'dsh 已是最新预览版')
})

test('preview display and installation ignore next and alpha tags', async () => {
  const f = fixture({ check: async () => ({ current: tags.latest, ...tags, next: tags.latest, alpha: '0.2.1-alpha.1' }),
    install: async (_channel, targetVersion) => targetVersion })
  f.openDialog(); await flush(); f.selectTab('dsh')
  assert.ok(f.render().some(node => node.type === 'code' && node.props.children.includes(tags.preview)))
  f.button('最新预览版').props.onClick(); await flush()
  assert.equal(f.updateCalls()[1].args.targetVersion, tags.preview)
  assert.equal(f.status(), 'dsh 已是最新预览版')
})

test('a failed check stays clickable, shows its error, and can be retried', async () => {
  let attempts = 0
  const f = fixture({ check: async () => {
    if (++attempts === 1) throw Error('registry unavailable')
    return { current: tags.latest, ...tags }
  } })
  f.openMore(); f.selectUpdate(); await flush()
  assert.equal(Boolean(f.item().disabled), false)
  f.selectTab('dsh')
  assert.equal(f.status(), 'dsh 检测失败')
  assert.equal(f.button('最新稳定版').props.disabled, true)
  assert.equal(f.button('最新预览版').props.disabled, true)
  assert.ok(f.render().some(node => node.props.role === 'alert' && node.props.children.includes('registry unavailable')))
  f.button('重新检测').props.onClick(); await flush()
  assert.equal(f.status(), 'dsh 已是最新版')
  assert.equal(f.button('最新预览版').props.disabled, false)
})

test('failed installation releases both buttons and preserves the last verified version', async () => {
  let attempts = 0
  const f = fixture({ check: async () => ({ current: '0.1.5-rc.2', ...tags }), install: async () => {
    if (++attempts === 1) throw Error('npm EACCES')
    return tags.latest
  } })
  f.openDialog(); await flush(); f.selectTab('dsh')
  f.button('最新稳定版').props.onClick(); await flush()
  assert.equal(f.status(), 'dsh 更新失败')
  assert.equal(Boolean(f.item().disabled), false)
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

test('each reopen refreshes both results, and pending checks survive closing', async () => {
  const desktop = deferred(), dsh = deferred()
  const f = fixture({ checkDesktop: () => desktop.promise, check: () => dsh.promise })
  f.openDialog(); f.closeDialog(); f.openDialog()
  assert.equal(f.desktopCalls().length, 1)
  assert.equal(f.updateCalls().length, 1)
  desktop.resolve(desktopRelease); dsh.resolve({ current: tags.latest, ...tags }); await flush()
  f.closeDialog(); f.openDialog()
  assert.equal(f.desktopCalls().length, 2)
  assert.equal(f.updateCalls().length, 2)
  await flush()
})

test('a failed desktop check leaves dsh usable and retries only the selected component', async () => {
  let attempts = 0
  const f = fixture({ checkDesktop: async () => {
    if (++attempts === 1) throw Error('GitHub unavailable')
    return desktopRelease
  } })
  f.openDialog(); await flush()
  assert.equal(f.status(), '软件更新检测失败')
  assert.ok(f.render().some(node => node.props.role === 'alert' && node.props.children.includes('GitHub unavailable')))
  f.selectTab('dsh')
  assert.equal(f.status(), 'dsh 已是最新版')
  assert.equal(f.button('最新预览版').props.disabled, false)
  f.selectTab('desktop')
  const retry = f.button('重新检测').props.onClick
  retry(); retry(); await flush()
  assert.equal(f.desktopCalls().length, 2)
  assert.equal(f.updateCalls().length, 1)
  assert.equal(f.status(), '发现新版本')
})

test('desktop release details, empty results and current versions render distinct states', async () => {
  for (const [release, status, button] of [
    [desktopRelease.release, '发现新版本', '前往下载'],
    [{ ...desktopRelease.release, updateAvailable: false }, '当前已是最新版本', '查看发布页'],
    [null, '暂无已发布版本', null],
  ]) {
    const f = fixture({ checkDesktop: async () => ({ current: '0.1.0', release }) })
    f.openDialog(); await flush()
    assert.equal(f.status(), status)
    if (button) assert.equal(f.button(button).props.disabled, false)
    else assert.equal(f.button('前往下载'), undefined)
    assert.ok(f.render().some(node => node.type === 'code' && node.props.children.includes('0.1.0')))
    if (release) assert.ok(f.render().some(node => node.props.children.includes(release.notes)))
  }
})

test('release opening is explicit, exclusive and recovers from errors without losing check results', async () => {
  const pending = deferred()
  const f = fixture({ openRelease: () => pending.promise })
  f.openDialog(); await flush()
  assert.equal(f.calls.some(call => call.command === 'open_desktop_release'), false)
  const open = f.button('前往下载').props.onClick
  open(); open()
  const calls = f.calls.filter(call => call.command === 'open_desktop_release')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.url, desktopRelease.release.url)
  assert.equal(f.button('正在打开…').props.disabled, true)
  pending.reject(Error('browser unavailable')); await flush()
  assert.equal(f.status(), '发现新版本')
  assert.equal(f.button('前往下载').props.disabled, false)
  assert.ok(f.render().some(node => node.props.role === 'alert' && node.props.children.includes('browser unavailable')))
})

test('tabs support arrow and Home/End navigation with associated panels', async () => {
  const f = fixture()
  f.openDialog(); await flush()
  for (const [key, next] of [['ArrowRight', 'dsh'], ['Home', 'desktop'], ['End', 'dsh'], ['ArrowLeft', 'desktop']]) {
    const active = f.tab('desktop').props['aria-selected'] ? 'desktop' : 'dsh'
    let prevented = false
    f.tab(active).props.onKeyDown({ key, preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(f.tab(next).props['aria-selected'], true)
    assert.equal(f.tab(next).props.tabIndex, 0)
    assert.equal(f.focused.at(-1), f.tab(next).props.id)
    const panel = f.render().find(node => node.props.id === f.tab(next).props['aria-controls'])
    assert.equal(panel.props.hidden, false)
    assert.equal(panel.props['aria-labelledby'], f.tab(next).props.id)
  }
  assert.equal(f.desktopCalls().length, 1)
  assert.equal(f.updateCalls().length, 1)
})
