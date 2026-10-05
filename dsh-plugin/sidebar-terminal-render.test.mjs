/**
 * Renders the terminal surface's title row and asserts its shape.
 *
 * ## Why this file exists, and why it renders rather than greps
 *
 * The row was rebuilt on request: the 终端 heading is gone, the state moved to the
 * left as ` · <状态>` with a dot, three buttons (清空 / 重连 / 重启) collapsed into
 * one "..." control, and the 启动目录 and notice rows were replaced by a tooltip on
 * the state. Every one of those is a claim about the TREE — which nodes exist,
 * which do not, and what the survivors carry — and none of them is decidable from
 * the source text: `h('span', …)` appears dozens of times, so a grep would pass
 * whether or not the element it found is the one that reaches the header.
 *
 * So this file CALLS the component and walks what it returned. The React stub is
 * deliberately thin (the same shape `sidebar-terminal.test.mjs` uses): the
 * component is invoked as a function, hooks are stubbed to run inline, and the
 * returned element tree is walked. No renderer, no layout engine — this asserts
 * structure and props, and it does not try to assert what a stylesheet does with
 * them.
 *
 * ## How `runtime.mjs` becomes importable
 *
 * It imports `@xterm/xterm` and `@xterm/addon-fit`, which are browser-only and
 * would throw on import in Node. Both are ALIASED to a stub by the esbuild call
 * below, so the module evaluates for real — its `createBody` is the shipped code,
 * not a copy — while the one thing that cannot run here is replaced. Nothing else
 * is stubbed at build time; the DOM and the Tauri bridge are stubbed per test, as
 * values in the sandbox the component reads.
 *
 * Run with: `node --test dsh-plugin/`
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * `createBody`, built once for the whole file.
 *
 * @type {(React: object, registry: object, primitives?: object) => Function}
 */
let createBody

/**
 * The shared UI factory, imported beside {@link createBody} from the same bundle.
 *
 * @type {(React: object, primitives?: object) => object}
 */
let createTerminalUI

/** The two xterm classes `runtime.mjs` imports, reduced to the shape it uses. */
const XTERM_STUB = `
export class Terminal {
  constructor() {}
  loadAddon() {}
  onData() {}
  attachCustomKeyEventHandler() {}
  open() {}
  reset() {}
  dispose() {}
  clear() {}
  write(_data, done) { if (typeof done === 'function') done() }
  resize() {}
  paste() {}
  getSelection() { return '' }
  hasSelection() { return false }
  get options() { return this._options ?? {} }
  set options(value) { this._options = value }
  get cols() { return 80 }
  get rows() { return 24 }
}
`

const FIT_STUB = `
export class FitAddon {
  proposeDimensions() { return { cols: 80, rows: 24 } }
}
`

let scratch

before(async () => {
  const { build } = await import('esbuild')
  scratch = await mkdtemp(join(tmpdir(), 'dsh-terminal-render-'))
  const xterm = join(scratch, 'xterm.mjs')
  const fit = join(scratch, 'fit.mjs')
  await writeFile(xterm, XTERM_STUB)
  await writeFile(fit, FIT_STUB)
  const out = join(scratch, 'runtime.mjs')
  await build({
    absWorkingDir: here,
    entryPoints: [join(here, 'sidebar-terminal', 'runtime.mjs')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    // The ONLY substitutions: the two browser-only modules, for the reason the
    // module header gives.
    alias: { '@xterm/xterm': xterm, '@xterm/addon-fit': fit },
  })
  ;({ createBody, createTerminalUI } = await import(pathToFileURL(out).href))
})

/**
 * The shared presentation factory, built over the same thin React stub.
 *
 * `makeUI` exists so a test can read what `presentation()` RETURNS rather than only
 * what the rendered tree shows. The two are not the same question: a field can be
 * returned and read by nobody (which is what `notice` became), and only the returned
 * object can answer whether it is still there.
 *
 * @returns the factory's `presentation`-carrying object.
 */
function makeUI() {
  return createTerminalUI(createReact(), null)
}

test.after?.(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

/**
 * The thinnest React that can run this component, as an element-tree factory.
 *
 * Hooks run inline and state is a fixed `false`: the component's only state is the
 * menu's open flag, and every assertion here is about the CLOSED surface, which is
 * what a user sees before touching anything.
 *
 * @returns the stub, with `cleanups` recording effect teardowns.
 */
function createReact() {
  const react = {
    createElement: (type, props, ...children) => ({
      type: typeof type === 'function' ? type.name || 'component' : type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
      component: typeof type === 'function' ? type : null,
    }),
    useReducer: (_reducer, initial) => [initial, () => {}],
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial ?? null }),
    useMemo: (fn) => fn(),
    useEffect: (fn) => { react.cleanups.push(fn()) },
    useLayoutEffect: (fn) => { react.cleanups.push(fn()) },
    cleanups: [],
  }
  return react
}

/**
 * The `window` the component reads: the Tauri bridge marks the surface as desktop.
 *
 * A falsy one is a plain browser, which is the 桌面连接不可用 path.
 *
 * @param desktop - whether the Tauri bridge should look present.
 * @returns the stub global.
 */
function createWindow(desktop = true) {
  return desktop ? { __TAURI__: { core: { Channel: function Channel() {} } } } : {}
}

/** A view stub: the shape `createBody` calls, with nothing that touches the DOM. */
function createView() {
  return {
    element: { remove() {} },
    // Every read is lazy, off the module-level `currentInfo`, so a test's own
    // `info` is what the component sees. The view is a LIVE object in the real
    // plugin — its `info` changes as the terminal runs — so a stub that captured
    // one snapshot would be testing the harness rather than the surface.
    get info() { return currentInfo },
    get message() { return currentInfo?.message ?? '' },
    get profiles() { return currentInfo?.profiles ?? DEFAULT_PROFILES },
    get profileId() { return currentInfo?.profileId ?? 'powershell' },
    mount() {},
    clear() {},
    connect() {},
    restart() {},
  }
}

/** The shells a real `terminal_profiles` call reports on this machine. */
const DEFAULT_PROFILES = [
  { profileId: 'powershell', name: 'Windows PowerShell' },
  { profileId: 'cmd', name: 'CMD' },
]

/** A registry stub. */
function createRegistry(primitives) {
  return {
    view: () => createView(),
    subscribe: () => () => {},
    orphans: () => [],
    restore() {},
    close() {},
    primitives,
  }
}

/** The info the view reports, set per test. */
let currentInfo = { state: 'running', cwd: 'D:\\Work', profileId: 'powershell' }

/**
 * Render the surface and walk it.
 *
 * @param options - `info` for the view, `desktop`, and the primitives to hand in.
 * @returns every element in the tree, plus the header and its direct children.
 */
function render(options = {}) {
  currentInfo = options.info ?? { state: 'running', cwd: 'D:\\Work', profileId: 'powershell' }
  const react = createReact()
  // The component reads `window` off the global object, so it is installed and
  // removed around the call rather than passed in.
  const previous = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = createWindow(options.desktop !== false)
  // `createView` is never reached for a plain browser, but `createRegistry` builds
  // its closure regardless; a document stub keeps any stray read from throwing.
  globalThis.document = { documentElement: { colorScheme: '', getAttribute: () => null, classList: { contains: () => false } } }
  try {
    const Live = createBody(react, createRegistry(options.primitives), options.primitives)
    const tree = Live({ tab: { signal: {}, contentId: 'dsh-resource://desktop-terminal/x' } })
    const elements = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (node.type) elements.push(node)
      for (const child of node.children ?? []) walk(child)
    }
    walk(tree)
    const header = elements.find((element) => element.props?.className === 'dshTerminal__header')
    return { tree, elements, header, children: header?.children ?? [] }
  } finally {
    globalThis.window = previous
    globalThis.document = previousDocument
  }
}

/** Every string in a subtree, so copy is asserted where it is rendered. */
function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return [node.props?.children, ...(node.children ?? [])]
    .flat(Infinity)
    .map(textOf)
    .join('')
}

/** The elements in a subtree, by class name. */
function byClass(node, className) {
  const found = []
  const walk = (candidate) => {
    if (candidate === null || candidate === undefined || typeof candidate !== 'object') return
    if (candidate.props?.className === className) found.push(candidate)
    for (const child of candidate.children ?? []) walk(child)
  }
  walk(node)
  return found
}

// ── the heading is gone, and the state leads ─────────────────────────────────

test('the title row carries no 终端 heading', () => {
  const { header, elements } = render()

  assert.ok(header, 'the row must still exist: it holds the state and the controls')
  assert.deepEqual(
    byClass(header, 'dshTerminal__title'),
    [],
    'the 终端 word is the tab chip\'s job; a second copy in this row is what the user asked to remove',
  )
  assert.equal(
    elements.some((element) => element.type === 'h2'),
    false,
    'and nothing replaced it with another heading',
  )
  // The section still names itself for assistive technology, which is not the same
  // thing as printing the word on screen.
  const section = elements.find((element) => element.props?.className === 'dshTerminal')
  assert.equal(section?.props?.['aria-label'], '终端')
})

test('the state is rendered as a leading space, a dot, and a state word', () => {
  const { header } = render({ info: { state: 'running', cwd: 'D:\\Work' } })

  const status = byClass(header, 'dshTerminal__status')[0]
  assert.ok(status, 'the state must be in the row, and it is the first thing in it')
  assert.equal(
    textOf(status),
    '  运行中',
    'a real leading space, the dot, then the word: the row reads ` · 运行中` as asked, with the dot drawn in the space',
  )
  assert.deepEqual(
    byClass(status, 'dshTerminal__dot').length,
    1,
    'exactly one dot, and it is a real element so it can be tinted per state',
  )
  assert.equal(
    header.children[0],
    status,
    'it comes first, so the row reads state -> shell -> actions',
  )
  assert.equal(
    status.props.role,
    'status',
    'the state word is the live region, which is the job the removed notice row used to do',
  )
})

test('the controls travel together in one right-aligned group', () => {
  const { header } = render({ primitives: { Menu: function Menu() {} } })

  // The GROUP carries the right alignment, not each control. That matters when the
  // shell picker is absent: a per-control auto margin would let the menu drift left
  // on its own, which is the bug this grouping exists to prevent.
  const group = byClass(header, 'dshTerminal__actions')[0]
  assert.ok(group, 'the controls live in one group')
  assert.equal(header.children[1], group, 'and the group is the row\'s second child')

  // TWO Menus, one group: the shell picker and the "..." control are both the
  // app's selector shape now — pill button anchored under the Menu primitive —
  // found through their anchors rather than as the group's own children.
  const menus = group.children.filter((child) => child?.component?.name === 'Menu')
  assert.equal(menus.length, 2, 'the shell picker and the "..." menu both ride the Menu primitive')
  assert.ok(
    menus.some((menu) => menu.props.anchor?.props?.className === 'dshTerminal__shell'),
    'the shell picker is inside the group',
  )
  assert.ok(
    menus.some((menu) => menu.props.anchor?.props?.['data-dsh-terminal-more'] === true),
    'and so is the "..." menu',
  )
})

test('the dot is toned by state, and the word spells the state out', () => {
  // Colour alone would say nothing to a reader who cannot separate the tints, so
  // each case asserts BOTH halves: the tone attribute and the word beside it.
  const cases = [
    ['running', 'ok', '运行中'],
    ['starting', 'busy', '创建中'],
    ['failed', 'bad', '启动失败'],
    ['exited', 'idle', '已退出（0）'],
  ]
  for (const [state, expectedTone, expectedWord] of cases) {
    const { header } = render({ info: { state, cwd: 'D:\\Work', exitCode: 0 } })
    const status = byClass(header, 'dshTerminal__status')[0]
    assert.equal(status.props['data-dsh-terminal-tone'], expectedTone, `tone for ${state}`)
    assert.equal(status.props['data-dsh-terminal-status'], state, `status attribute for ${state}`)
    assert.match(textOf(status), new RegExp(expectedWord), `the word for ${state}`)
  }
})

test('a state the mapping does not name reads as reconnecting, and is toned busy', () => {
  const { header } = render({ info: { state: 'weird', cwd: 'C:\\' } })
  const status = byClass(header, 'dshTerminal__status')[0]
  assert.match(textOf(status), /重新连接中/)
  assert.equal(status.props['data-dsh-terminal-tone'], 'busy', 'in flight, not settled')
})

// ── a live condition is the dot's job, and the tooltip's ─────────────────────

test('a live condition tones the dot, which the STATE alone would leave green', () => {
  // This is the whole point of the escalation, and the case that motivated it: the
  // shell is still `running`, so a tone keyed on state alone says everything is
  // fine while the terminal is in fact refusing to work. The reason lives in
  // `message`, which is where `fail()` writes it.
  const healthy = render({ info: { state: 'running', cwd: 'C:\\' } })
  assert.equal(
    byClass(healthy.header, 'dshTerminal__status')[0].props['data-dsh-terminal-tone'],
    'ok',
    'a running shell with no condition is not a warning',
  )

  const broken = render({ info: { state: 'running', cwd: 'C:\\', message: '桌面连接中断，请重新连接。' } })
  const status = byClass(broken.header, 'dshTerminal__status')[0]
  assert.equal(status.props['data-dsh-terminal-status'], 'running', 'the state itself is still truthful')
  assert.equal(status.props['data-dsh-terminal-tone'], 'bad', 'but the dot reports the condition')
  assert.notEqual(
    status.props['data-dsh-terminal-tone'],
    'busy',
    'and never `busy`: amber already means "working on it", which is the opposite of what this asks of the user',
  )
})

test('recovering clears the warning, so a red dot cannot stick', () => {
  // A tone that only ever escalates would leave a permanently red dot on a terminal
  // that recovered, which is worse than no signal at all.
  const { header } = render({ info: { state: 'running', cwd: 'C:\\', message: '' } })
  assert.equal(byClass(header, 'dshTerminal__status')[0].props['data-dsh-terminal-tone'], 'ok')
})

test('the removed condition field is not returned at all, so it cannot come back', () => {
  // `presentation()` used to return `notice`, and the dock gated a visible row on it.
  // The row is gone, so the field has no reader — and a field nothing reads is how a
  // later change reintroduces a surface nobody meant to restore. This asserts the
  // key is ABSENT rather than empty, which is the difference between "removed" and
  // "disabled", and it is asserted through the real exported factory rather than by
  // grepping the file, so a re-added `notice: ''` fails here.
  const ui = makeUI()
  const data = ui.presentation({ info: { state: 'failed', cwd: 'C:\\', message: 'x' }, message: 'x' }, true)
  assert.equal('notice' in data, false, 'no notice field survives')
  assert.equal('condition' in data, false, 'and no half-exposed condition flag either')
  assert.deepEqual(
    Object.keys(data).sort(),
    ['description', 'state', 'tip', 'tone', 'word'],
    'the returned shape is exactly what the two surfaces read',
  )
})

test('a page with no desktop bridge says so and is idle, not alarming', () => {
  const { header } = render({ desktop: false })
  const status = byClass(header, 'dshTerminal__status')[0]
  assert.match(textOf(status), /桌面连接不可用/)
  assert.equal(status.props['data-dsh-terminal-status'], 'offline')
  assert.equal(status.props['data-dsh-terminal-tone'], 'idle')
})

// ── the two removed rows became one tooltip ──────────────────────────────────

test('the 启动目录 row is gone and the directory is the tooltip', () => {
  const { elements, header } = render({ info: { state: 'running', cwd: 'D:\\Work\\Project' } })

  assert.equal(
    elements.some((element) => element.props?.className === 'dshTerminal__cwd'),
    false,
    'the row must be gone from the tree, not merely hidden',
  )
  const status = byClass(header, 'dshTerminal__status')[0]
  assert.match(
    status.props.title,
    /^启动目录：D:\\Work\\Project/,
    'the directory survives one hover away, spelled exactly as the row spelled it',
  )
})

test('the notice no longer has a row, and becomes the second line of the tooltip', () => {
  const info = { state: 'failed', cwd: 'D:\\Work', message: '启动失败，请检查 shell 和目录后重试。' }
  const { elements, header } = render({ info })

  assert.equal(
    elements.some((element) => element.props?.className === 'dshTerminal__notice'),
    false,
    'the notice row is what the user asked to remove',
  )
  const status = byClass(header, 'dshTerminal__status')[0]
  assert.equal(
    status.props.title,
    '启动目录：D:\\Work\n启动失败，请检查 shell 和目录后重试。',
    'directory first, then the condition: both facts, in the order the rows appeared',
  )
  // The row is gone, so the dot is the only thing left that can warn — the reason
  // being reachable on hover is what makes removing the row safe rather than lossy.
  assert.equal(
    status.props['data-dsh-terminal-tone'],
    'bad',
    'and the dot carries the warning the row used to be',
  )
})

test('a paused terminal reports buffer-full in the tooltip, composed with any message', () => {
  const pausedOnly = render({ info: { state: 'running', cwd: 'C:\\', paused: true } })
  assert.match(
    byClass(pausedOnly.header, 'dshTerminal__status')[0].props.title,
    /输出缓存已满/,
    'the back-pressure text is shown where the row used to show it',
  )
  assert.equal(
    pausedOnly.elements.some((element) => element.props?.className === 'dshTerminal__notice'),
    false,
    'still without a row',
  )

  // Both conditions can hold at once, and a composed tooltip must not drop one.
  const both = render({ info: { state: 'running', cwd: 'C:\\', paused: true, message: '输入已切换到另一个标签，点击此终端重新取得控制权。' } })
  const tip = byClass(both.header, 'dshTerminal__status')[0].props.title
  assert.match(tip, /输入已切换/)
  assert.match(tip, /输出缓存已满/)
  assert.ok(tip.indexOf('输入已切换') < tip.indexOf('输出缓存已满'), 'the live condition leads')
})

test('the directory retry rides the menu, because its row is gone', () => {
  const info = { state: 'failed', cwd: 'D:\\Work', message: '启动目录不存在或不可访问，可选择在主目录重试。' }
  const { elements } = render({ info, primitives: { Menu: function Menu() {} } })

  assert.equal(
    elements.some((element) => element.props?.className === 'dshTerminal__notice'),
    false,
    'no notice row to hold the button',
  )
  const menu = elements.find(
    (element) => element.component?.name === 'Menu' && element.props.anchor?.props?.['data-dsh-terminal-more'] === true,
  )
  assert.ok(menu, 'the menu is rendered, so the item lands somewhere the user can reach')
  assert.ok(
    menu.props.items.some((item) => item.id === 'home' && item.label === '在主目录重试'),
    'the retry is still offered, as a menu item',
  )
})

test('the retry item is absent when nothing is wrong with the directory', () => {
  const { elements } = render({ info: { state: 'running', cwd: 'D:\\Work' }, primitives: { Menu: function Menu() {} } })
  const menu = elements.find(
    (element) => element.component?.name === 'Menu' && element.props.anchor?.props?.['data-dsh-terminal-more'] === true,
  )
  assert.deepEqual(
    menu.props.items.map((item) => item.id),
    ['clear', 'reconnect', 'restart'],
    'the menu holds exactly the three actions when the directory is fine',
  )
})

// ── three buttons became one control ─────────────────────────────────────────

test('one "..." control replaces 清空/重连/重启, and the three live in its menu', () => {
  const { elements } = render({ primitives: { Menu: function Menu() {} } })

  // THE TRIGGER IS INSIDE THE MENU, NOT BESIDE IT. `Menu` wraps its `anchor` in
  // its own measured span and positions the popup against it, which is what the
  // app's own rows do — so the button is found through the Menu's props rather
  // than among the header's own children. Asserting the header's children instead
  // is the mistake this test made first: it reported 0 buttons and looked like a
  // missing control, when the control was one level in.
  //
  // The SHELL picker is a Menu now too, and it comes first in the row — so the
  // "..." menu is found through its anchored trigger, not merely by being first.
  const menu = elements.find(
    (element) => element.component?.name === 'Menu' && element.props.anchor?.props?.['data-dsh-terminal-more'] === true,
  )
  assert.ok(menu, 'the app\'s own Menu primitive carries the popup')
  const more = menu.props.anchor
  assert.ok(more, 'the Menu wraps the trigger, as the app\'s own rows do')
  assert.equal(textOf(more), '...', 'spelled as the user asked')
  assert.equal(more.props['data-dsh-terminal-more'], true, 'tagged, so a test or a stylesheet can find it')
  assert.equal(more.props['aria-haspopup'], 'menu')
  assert.equal(
    more.props['aria-label'],
    '更多终端操作',
    'a glyph-only control needs a name for assistive technology',
  )

  // The old buttons must be gone from the tree entirely, not merely restyled.
  const stale = ['清空', '重连', '重启'].filter((label) =>
    elements.some((element) => element.type === 'button' && textOf(element) === label),
  )
  assert.deepEqual(stale, [], 'none of the three survives as a button of its own')

  assert.deepEqual(menu.props.items.map((item) => item.label), ['清空', '重连', '重启'])
  assert.equal(menu.props.portal, true, 'portalled, so it is the same surface every other dropdown is')
  assert.equal(menu.props.align, 'end', 'right-aligned: the trigger is at the row\'s right edge')
})

test('the actions are absent before a view exists, so no dead control is drawn', () => {
  // A desktop page with no terminal yet: `v` is null, so there is nothing to act
  // on. The row must not offer 清空 for a terminal that does not exist.
  const react = createReact()
  const previous = globalThis.window
  globalThis.window = createWindow(true)
  globalThis.document = { documentElement: { colorScheme: '', getAttribute: () => null, classList: { contains: () => false } } }
  try {
    const registry = { ...createRegistry({ Menu: function Menu() {} }), view: () => null }
    const Live = createBody(react, registry, { Menu: function Menu() {} })
    const tree = Live({ tab: { signal: {}, contentId: 'dsh-resource://desktop-terminal/x' } })
    const elements = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (node.type) elements.push(node)
      for (const child of node.children ?? []) walk(child)
    }
    walk(tree)
    assert.deepEqual(byClass(tree, 'dshTerminal__more'), [], 'no "..." before there is anything to do')
    assert.equal(
      elements.some((element) => element.component?.name === 'Menu'),
      false,
      'and no empty menu either',
    )
    const status = elements.find((element) => element.props?.className === 'dshTerminal__status')
    assert.match(textOf(status), /重新连接中/, 'the state still reports where the surface is')
  } finally {
    globalThis.window = previous
    delete globalThis.document
  }
})

test('a page with no Menu primitive falls back to a working list, not a dead button', () => {
  const { header, elements } = render({ primitives: null })

  // With no Menu, the trigger is the header's own child and the wrapper owns the
  // toggle — which is the one behavioural difference between the two paths.
  const more = byClass(header, 'dshTerminal__more')[0]
  assert.ok(more, 'the control is still drawn, so the surface is not left without its actions')
  assert.equal(more.props['aria-haspopup'], 'menu', 'the fallback now implements a keyboard menu too')
  assert.equal(typeof more.props.onClick, 'function', 'the fallback trigger must actually toggle its menu')
  assert.equal(more.props['data-dsh-terminal-more'], true, 'still findable by the same tag')
  assert.ok(byClass(header, 'dshTerminal__moreHost').length === 1, 'the fallback wrapper is in place')
  assert.equal(
    elements.some((element) => element.component?.name === 'Menu'),
    false,
    'no Menu was resolved, so none is rendered',
  )
})

// ── the Shell control wears 通用设置's selector ───────────────────────────────

/**
 * The shell picker's Menu in a rendered surface, found through its anchored pill.
 *
 * @param elements - every element in the tree.
 * @returns the shell Menu element, or undefined.
 */
function shellMenuOf(elements) {
  return elements.find(
    (element) => element.component?.name === 'Menu' && element.props.anchor?.props?.className === 'dshTerminal__shell',
  )
}

test('the shell picker is the settings selector: a pill button opening the app\'s Menu', () => {
  const { elements } = render({
    info: { state: 'running', cwd: 'D:\\Work', profileId: 'cmd', profiles: DEFAULT_PROFILES },
    primitives: { Menu: function Menu() {} },
  })

  const shellMenu = shellMenuOf(elements)
  assert.ok(shellMenu, 'the shell picker rides the app\'s Menu primitive')
  const pill = shellMenu.props.anchor
  assert.equal(pill.type, 'button', 'the closed control is a button, so a click draws no focus ring')
  assert.equal(pill.props['aria-haspopup'], 'menu')
  assert.equal(pill.props['aria-expanded'], false, 'the closed surface is what these assertions read')
  assert.equal(pill.props.disabled, false)
  assert.equal(pill.props['aria-label'], '新建或重新启动时使用的 shell')
  assert.equal(textOf(pill), 'CMD', 'the pill reads the profile in use')

  // The popup is 通用设置's selector menu: the current id rides `selectedId` so
  // the Menu's own check marks it, and the panel is portalled and hung from the
  // pill's right edge — the choice the app's own selectors make for a pill at the
  // row's right edge.
  assert.equal(shellMenu.props.selectedId, 'cmd')
  assert.equal(shellMenu.props.portal, true)
  assert.equal(shellMenu.props.align, 'end')

  // The values the app's own `_selector` rule uses, read from
  // `dsh-client-ui-permission-presets` (and `-locale`, `-theme`, `-chat`). They are
  // asserted literally because the point of the change is that this control looks
  // like THAT control: a test that re-derived them from a token would pass while
  // the two drifted apart.
  const style = pill.props.style
  assert.equal(style.height, '36px', 'the settings selector is 36px tall')
  assert.equal(style.borderRadius, '18px', 'and fully rounded: 36 / 2')
  assert.equal(style.border, 'none', 'the app\'s selector has no border, unlike an input')
  assert.equal(style.padding, '0 34px 0 14px', '14px of leading padding, room for the chevron on the right')
  assert.equal(style.fontSize, '14px')
  assert.equal(style.background, 'var(--dsw-alias-bg-module-platform)')
  assert.equal(style.color, 'var(--dsw-alias-label-primary)')
  assert.equal(style.appearance, 'none', 'structural on the fallback select, inert on this button')
  assert.match(style.backgroundImage, /^url\("data:image\/svg\+xml/, 'the app\'s chevron, drawn back in as a background')
})

test('the shell picker still offers the profiles and reports the current one', () => {
  const { elements } = render({
    info: { state: 'running', cwd: 'D:\\Work', profileId: 'cmd', profiles: DEFAULT_PROFILES },
    primitives: { Menu: function Menu() {} },
  })
  const shellMenu = shellMenuOf(elements)
  assert.deepEqual(
    shellMenu.props.items.map((item) => item.id),
    ['powershell', 'cmd'],
    'every discovered shell is still offered',
  )
  assert.deepEqual(
    shellMenu.props.items.map((item) => item.label),
    ['Windows PowerShell', 'CMD'],
  )
  assert.equal(shellMenu.props.selectedId, 'cmd', 'and the current one is what the Menu marks')
})

test('a page with no Menu primitive falls back to a working list, not a dead button', () => {
  const { header, elements } = render({ primitives: null })

  // With no Menu, the trigger is the header's own child and the wrapper owns the
  // toggle — which is the one behavioural difference between the two paths.
  const more = byClass(header, 'dshTerminal__more')[0]
  assert.ok(more, 'the control is still drawn, so the surface is not left without its actions')
  assert.equal(more.props['aria-haspopup'], 'menu', 'the fallback now implements a keyboard menu too')
  assert.equal(typeof more.props.onClick, 'function', 'the fallback trigger must actually toggle its menu')
  assert.equal(more.props['data-dsh-terminal-more'], true, 'still findable by the same tag')
  assert.ok(byClass(header, 'dshTerminal__moreHost').length === 1, 'the fallback wrapper is in place')
  assert.equal(
    elements.some((element) => element.component?.name === 'Menu'),
    false,
    'no Menu was resolved, so none is rendered',
  )

  // The shell picker degrades on the same path, to the native `<select>` it used
  // to be — same pill (the style object is shared with the Menu path), the
  // engine's own popup list.
  const select = byClass(header, 'dshTerminal__shell')[0]
  assert.equal(select?.type, 'select', 'the shell picker falls back to the native select')
  assert.equal(select.props.style.height, '36px', 'wearing the same measurements the Menu-path pill asserts')
})
