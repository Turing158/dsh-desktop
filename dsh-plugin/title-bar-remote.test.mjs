/**
 * The remote page's reduced title bar.
 *
 * The 远程控制 page — the one a phone opens over the LAN, marked
 * `data-dsh-browser` by the injected `browser-compat.js` — gets a reduced bar:
 * the mark and its hover swap stay, the four menus and the wordmark go, a
 * theme switch appears at the right end, and an empty `dshTb__quick` container
 * waits for the overlay's DOM tier to fill it. The desktop window keeps the
 * full bar. These tests render the real bundle in both states and hold the
 * difference in place.
 *
 * The fixture is `dsh-update.test.mjs`'s: the real bundle with stateful hooks,
 * stubs only for the primitives and the host, and a `theme` service that
 * records what the switch writes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const clientPath = new URL('./title-bar/client.js', import.meta.url)
const domPath = new URL('./ui-overlay/dom.js', import.meta.url)
const mobilePath = new URL('./ui-overlay/mobile.css', import.meta.url)
const source = readFileSync(clientPath, 'utf8')

const flush = () => new Promise(setImmediate)

/** The attribute both halves read to recognise the remote page. */
const BROWSER_ATTRIBUTE = 'data-dsh-browser'

function fixture({ browser = false, preference = 'light' } = {}) {
  let factory, slot, cursor = 0
  const hooks = [], calls = []
  const preferences = [preference]
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
      documentElement: {
        getAttribute: name => (browser && name === BROWSER_ATTRIBUTE ? '' : null),
        style: { setProperty() {} },
      },
    },
    getSelection: () => null,
    matchMedia: () => ({ matches: false }),
    __ModuleLoader__: { load: entry => { factory = entry.factory } },
    __TAURI__: undefined,
  }
  sandbox.window = sandbox
  vm.runInNewContext(source, sandbox)
  factory(name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: tree => tree }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Menu: 'Menu', Modal: 'Modal', Button: 'Button', Input: 'Input' }
    }
    throw Error(name)
  }).apply({
    effect: fn => fn(),
    slots: {
      inject(_name, fn) { fn() },
      register(_options, component) { slot = component },
    },
    theme: {
      getTheme: () => ({ preference: preferences[0] }),
      setTheme: value => { preferences[0] = value; calls.push({ command: 'setTheme', value }) },
    },
    on() {},
  })

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
  return {
    render,
    calls,
    currentPreference: () => preferences[0],
    bar: () => render().find(node => node.props?.className === 'dshTb'),
    menus: () => render().filter(node => node.type === 'Menu'),
    themeButton: () => render().find(node => node.props?.className === 'dshTb__theme'),
  }
}

test('the remote bar drops the menus and the wordmark, and keeps the mark', () => {
  const f = fixture({ browser: true })

  const bar = f.bar()
  assert.ok(bar, 'the bar must render on a browser page')
  assert.equal(f.menus().length, 0, 'no menu may render: the desktop affordances are gone')
  assert.ok(
    !JSON.stringify(bar).includes('deepseek') && !JSON.stringify(bar).includes('HARNESS'),
    'the wordmark and badge stay off the remote bar',
  )
  assert.ok(
    JSON.stringify(bar).includes('dshTb__mark'),
    'the mark stays, hover swap and sidebar toggle included',
  )
})

test('the remote bar keeps the mark at the top-left, quick actions beside it', () => {
  const f = fixture({ browser: true })

  const bar = f.bar()
  const children = Array.isArray(bar.props.children) ? bar.props.children : [bar.props.children]
  const classes = children.filter(child => child && typeof child === 'object').map(child => child.props?.className)
  assert.equal(classes[0], 'dshTb__brand', 'the mark stays the bar’s first element, at the top-left corner')
  assert.equal(classes[1], 'dshTb__quick', 'the quick actions render directly beside the mark')
  assert.ok(f.themeButton(), 'the theme switch renders at the right end')
})

test('the remote theme switch cycles system, light, dark and back to system', () => {
  const f = fixture({ browser: true, preference: 'system' })
  for (const [next, label] of [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']]) {
    const button = f.themeButton()
    assert.match(button.props['aria-label'], new RegExp(label))
    assert.equal(button.props['data-theme-preference'], f.currentPreference())
    button.props.onClick()
    assert.equal(f.currentPreference(), next)
  }
  assert.deepEqual(f.calls.map(call => call.value), ['light', 'dark', 'system'])
  assert.match(f.themeButton().props.title, /当前：跟随系统/)
})

test('light and dark preferences each enter the same three-state cycle', () => {
  const f = fixture({ browser: true, preference: 'light' })
  assert.match(f.themeButton().props['aria-label'], /深色/, 'a light page is offered the dark theme')

  const dark = fixture({ browser: true, preference: 'dark' })
  dark.themeButton().props.onClick()
  assert.deepEqual(dark.calls, [{ command: 'setTheme', value: 'system' }])
})

test('the desktop bar keeps every menu and gains no theme switch', () => {
  const f = fixture({ browser: false })

  assert.equal(f.menus().length, 4, 'the desktop bar keeps 编辑 / 会话 / 项目 / 更多')
  assert.equal(f.themeButton(), undefined, 'the switch is a remote-page control only')
  assert.equal(
    f.bar().props.children.filter(child => child && typeof child === 'object' && child.props?.className === 'dshTb__quick').length,
    0,
    'and no quick container renders into it',
  )
})

test('the remote page wiring agrees across the three files', () => {
  const dom = readFileSync(domPath, 'utf8')
  const css = readFileSync(mobilePath, 'utf8')

  // One attribute names the remote page, spelled identically in the tier that
  // renders the reduced bar, the tier that fills it, and the sheet that turns
  // the sidebar into a drawer.
  for (const [name, text] of [['title-bar/client.js', source], ['ui-overlay/dom.js', dom]]) {
    assert.ok(text.includes(BROWSER_ATTRIBUTE), `${name} must read ${BROWSER_ATTRIBUTE}`)
  }
  assert.ok(css.includes(`html[data-dsh-browser]`), 'mobile.css must gate its remote rules on the attribute')

  // The container is the contract between the renderer and the filler: the bar
  // renders it empty, the DOM tier finds it by class and fills it with the
  // item/icon/label structure, the stylesheet dresses all of it.
  assert.ok(source.includes('dshTb__quick'), 'title-bar/client.js must render the quick container')
  for (const className of ['dshTb__quick', 'dshTb__quickItem', 'dshTb__quickIcon', 'dshTb__quickLabel']) {
    assert.ok(dom.includes(className), `dom.js must reference ${className}`)
    assert.ok(css.includes(className), `mobile.css must style ${className}`)
  }

  // The drawer keys on the layout store's own attributes, not class hashes.
  for (const hook of ["[class*='_frame']", "[class*='_sidebarCol']", 'data-sidebar-collapsed', 'data-rightbar-collapsed']) {
    assert.ok(css.includes(hook), `mobile.css must key the drawer on ${hook}`)
  }

  // And every column of the frame NAMES its track. The drawer takes the sidebar
  // out of grid flow, so without these pins auto-placement shifts the centre
  // column onto track 1 — the 0px sidebar track — and the empty right bar takes
  // the viewport: a phone page with no conversation, no composer, and an empty
  // sidebar, which is the reported "session list never loads, 新会话 does
  // nothing". A pin dropped here is invisible in the desktop webview (the rules
  // are gated on data-dsh-browser) and only shows up on a phone.
  for (const [column, track] of [['_centerCol', 2], ['_rightbarCol', 3]]) {
    const rule = new RegExp(`> \\[class\\*='${column}'\\] \\{[^}]*grid-column: ${track}`, 's')
    assert.ok(rule.test(css), `mobile.css must pin ${column} to grid track ${track} inside the drawer frame`)
  }
  assert.ok(
    /\[class\*='_overlayLayer'\] \{[^}]*grid-column: 1 \/ -1/.test(css),
    'mobile.css must let the overlay layer span every drawer track',
  )

  // And the rail groups the quick actions rebuild, in rail order. 设置 is
  // deliberately absent — the open drawer's own footer carries it — and the
  // workspace search takes the slot.
  assert.ok(!dom.includes("_settingsArea"), 'the settings gear must not be collected into the bar')
  for (const group of ["_toggle", "_newSession", "_searchButton", "_panelList", "_footerActions"]) {
    assert.ok(dom.includes(`'${group}'`) || dom.includes(`"${group}"`), `dom.js must collect the ${group} rail controls`)
  }
})
