/**
 * The remote page's quick actions, built by the overlay's DOM tier.
 *
 * On the 远程控制 page (`data-dsh-browser`) the sidebar is a drawer and its
 * collapsed rail is gone; `ui-overlay/dom.js` rebuilds the rail's controls —
 * 新建会话, the workspace search, the Cordis 插件 trigger — as icon+text
 * buttons inside the title bar's own `dshTb__quick` container, which sits
 * beside the mark. The container is rendered empty by the title-bar plugin
 * and filled here, so the two stay decoupled.
 *
 * The rail's OWN drawer toggle is NOT among them: the bar's mark already
 * carries that action as an icon with the app's hover swap, so a labelled
 * duplicate was removed. The mark, not this tier, is the drawer's entry point.
 *
 * These tests run the REAL `dom.js` — the way `vanilla-behaviour.test.mjs`
 * loads it — against a stub that answers exactly the selectors the pass
 * touches, and hold five behaviours in place:
 *
 *   1. the cluster mirrors the rail — labels, icons, rail order — minus the
 *      drawer toggle, which the stub DOES offer so the skip is what is tested;
 *   2. a re-sync with no rail change leaves the DOM untouched, a changed rail
 *      rebuilds;
 *   3. a click re-finds the CURRENT original and clicks that, so the action is
 *      the app's own handler even after the sidebar re-rendered;
 *   4. a click on a closed drawer opens it through the bar's mark and waits
 *      for the animation, because the Cordis panel anchors to its badge's rect;
 *   5. 新建会话 does NOT open the drawer, because the drawer would cover
 *      the composer the tap just revealed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const source = readFileSync(new URL('./ui-overlay/dom.js', import.meta.url), 'utf8')

/**
 * A fake element with the attribute and child bookkeeping the tier touches.
 *
 * @param {object} [overrides] - extra members stamped onto the element.
 * @returns {object} the element.
 */
function element(overrides = {}) {
  return {
    attrs: {},
    kids: [],
    get children() { return this.kids },
    name: '',
    clickLog: null,
    listeners: {},
    getAttribute(name) { return this.attrs[name] ?? null },
    setAttribute(name, value) { this.attrs[name] = String(value) },
    removeAttribute(name) { delete this.attrs[name] },
    appendChild(kid) { this.kids.push(kid); return kid },
    removeChild(kid) { this.kids = this.kids.filter(k => k !== kid) },
    get firstChild() { return this.kids[0] ?? null },
    get isConnected() { return true },
    cloneNode() { return element({ tag: this.tag }) },
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn) },
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
    click() {
      if (this.clickLog) this.clickLog.push(this.name)
      // A built quick item's handler rides addEventListener, so a synthetic
      // click must dispatch to it the way a real tap would.
      for (const fn of this.listeners.click ?? []) fn({ target: this })
    },
    ...overrides,
  }
}

/**
 * A rail control with an aria-label, a text body, and a glyph.
 *
 * @param {string} label - the control's aria-label.
 * @param {string[]} clicks - the shared click log.
 * @returns {object} the control.
 */
function railButton(label, clicks) {
  return element({
    name: label,
    clickLog: clicks,
    aria: label,
    textContent: label,
    getAttribute(name) { return name === 'aria-label' ? this.aria : this.attrs[name] ?? null },
    querySelector(tag) { return tag === 'svg' ? this.glyph : null },
  })
}

/**
 * The loaded overlay plus the stub nodes a test asserts on.
 *
 * The script's own `begin()` runs one pass at evaluation — the stub answers the
 * composer selector, so that pass is a "ready" pass and the quick actions are
 * built on the spot. Later passes are driven through the mode listener the
 * script registers, which is the file's own re-entry point for an immediate
 * pass. `requestAnimationFrame` is queued, not run, so a test can observe the
 * middle of a click chain.
 *
 * @param {object} [options] - `drawerClosed` seeds the frame attribute.
 * @returns {object} the stubs, the click log, `pass()`, and `flushRaf()`.
 */
function fixture({ drawerClosed = true, pluginPanel = false } = {}) {
  const clicks = []
  const rafQueue = []
  let modeListener = null

  // The sidebar's own collapse toggle: two glyphs — the rail's mark and the
  // panel icon the app swaps in on hover, tagged apart so a test can tell which
  // one the cluster cloned — and the label the CURRENT state gives it, which is
  // what the rail renders while the drawer is closed. It is offered to the tier
  // on purpose: the cluster must SKIP it, because the bar's mark is that
  // control.
  const toggle = railButton('打开侧边栏', clicks)
  toggle.glyphs = [element({ tag: 'svg-mark' }), element({ tag: 'svg-panel' })]
  toggle.querySelectorAll = tag => (tag === 'svg' ? toggle.glyphs : [])
  const newSession = railButton('新建会话', clicks)
  const search = railButton('搜索会话', clicks)
  const cordis = railButton('Cordis 插件', clicks)
  const plugins = railButton('插件', clicks)
  plugins.glyph = element({ tag: 'svg' })
  newSession.glyph = element({ tag: 'svg' })
  search.glyph = element({ tag: 'svg' })
  cordis.glyph = element({ tag: 'svg' })

  const root = element({
    querySelectorAll(selector) {
      if (selector.includes('_toggle')) return [toggle]
      if (selector.includes('_newSession')) return [newSession]
      if (selector.includes('_searchButton')) return [search]
      if (selector.includes('_panelList')) return pluginPanel ? [plugins] : []
      if (selector.includes('_footerActions')) return [cordis]
      return []
    },
    querySelector(selector) {
      if (selector.includes("'打开侧边栏'")) return toggle
      if (selector.includes("'新建会话'")) return newSession
      if (selector.includes("'搜索会话'")) return search
      if (selector.includes("'Cordis 插件'")) return cordis
      if (selector.includes("'插件'")) return plugins
      return null
    },
  })
  const sidebarCol = element({ firstElementChild: root })
  const frame = element({
    getAttribute(name) { return name === 'data-sidebar-collapsed' && drawerClosed ? 'true' : null },
  })
  const mark = element({ name: 'mark', clickLog: clicks })
  mark.addEventListener('click', () => { drawerClosed = !drawerClosed })
  const quick = element({})
  const composer = element({})

  const documentElement = element({ attrs: { 'data-dsh-browser': '' } })
  const timers = []

  const sandbox = {
    document: {
      documentElement,
      querySelector(selector) {
        if (selector === "[class*='_sidebarCol']") return sidebarCol
        if (selector === "[class*='_frame']") return frame
        if (selector === '.dshTb__mark') return mark
        if (selector === '.dshTb__quick') return quick
        if (typeof selector === 'string' && selector.includes('_input')) return composer
        return null
      },
      querySelectorAll: () => [],
      addEventListener(_name, fn) { if (_name === 'dsh-desktop:ui-mode') modeListener = fn },
      createElement: tag => element({ tag }),
      body: element({}),
      title: '',
    },
    requestAnimationFrame: fn => { rafQueue.push(fn) },
    setTimeout: (fn, ms) => { if (ms === 240) timers.push(fn); return 0 },
    setInterval: () => 0,
    clearTimeout() {},
    clearInterval() {},
  }
  sandbox.window = sandbox
  const windowEvents = new EventTarget()
  sandbox.addEventListener = windowEvents.addEventListener.bind(windowEvents)
  sandbox.removeEventListener = windowEvents.removeEventListener.bind(windowEvents)
  sandbox.dispatchEvent = windowEvents.dispatchEvent.bind(windowEvents)
  vm.runInNewContext(source, sandbox)

  return {
    clicks,
    quick,
    frame,
    mark,
    root,
    toggle,
    newSession,
    search,
    cordis,
    /** Run one more overlay pass, the way a mode change would. */
    pass: () => modeListener(),
    /** Run everything currently queued on requestAnimationFrame. */
    flushRaf: () => { while (rafQueue.length > 0) rafQueue.shift()() },
    sidebarCol,
    documentElement,
    flushTimers: () => { while (timers.length) timers.shift()() },
  }
}

/** The rebuilt cluster, as label texts. */
function labelsOf(quick) {
  return quick.kids.map(item => {
    const label = item.kids.find(kid => kid.className === 'dshTb__quickLabel')
    return label === undefined ? null : label.textContent
  })
}

test('the cluster mirrors the rail without the drawer toggle the mark already is', () => {
  const f = fixture()
  assert.deepEqual(
    labelsOf(f.quick),
    ['新建会话', '搜索会话', 'Cordis 插件'],
    'the rail controls are rebuilt in the bar, in rail order; 设置 stays out',
  )
  assert.equal(
    f.quick.getAttribute('data-dsh-quick-signature'),
    '新建会话\n搜索会话\nCordis 插件\n',
    'the signature records what was built',
  )
  // The rail really does carry the toggle — the stub offers it — and the
  // cluster must skip it: the bar's mark IS that control, hover swap and all,
  // so a labelled copy here would be the same command twice.
  assert.notEqual(f.toggle, undefined, 'the stub rail carries the drawer toggle')
  assert.ok(
    !labelsOf(f.quick).includes('打开侧边栏'),
    'the drawer toggle is not mirrored: the bar’s mark owns that action',
  )
  // Each item announces its own label and wears the app's own glyph.
  const first = f.quick.kids[0]
  assert.equal(first.attrs['aria-label'], '新建会话')
  assert.equal(first.className, 'dshTb__quickItem')
  assert.equal(first.kids[0].className, 'dshTb__quickIcon')
  assert.equal(first.kids[0].kids[0].tag, 'svg', 'the rail control’s icon is cloned in')
})

test('a re-sync with no rail change leaves the DOM untouched; a changed rail rebuilds', () => {
  const f = fixture()
  const before = f.quick.kids.slice()
  f.pass()
  assert.deepEqual(f.quick.kids, before, 'an equal signature must skip the rebuild')

  // A panel appeared in the rail: the cluster follows on the next pass.
  const panel = railButton('文件', f.clicks)
  panel.glyph = element({ tag: 'svg' })
  f.root.querySelectorAll = selector => {
    if (selector.includes('_toggle')) return [f.toggle]
    if (selector.includes('_newSession')) return [f.newSession]
    if (selector.includes('_panelList')) return [panel]
    if (selector.includes('_footerActions')) return [f.cordis]
    return []
  }
  f.root.querySelector = selector => {
    if (selector.includes("'打开侧边栏'")) return f.toggle
    if (selector.includes("'新建会话'")) return f.newSession
    if (selector.includes("'文件'")) return panel
    if (selector.includes("'Cordis 插件'")) return f.cordis
    return null
  }
  f.pass()
  assert.deepEqual(labelsOf(f.quick), ['新建会话', '文件', 'Cordis 插件'], 'the cluster follows the rail')
})

test('a click re-finds the current original and clicks that', () => {
  const f = fixture({ drawerClosed: false })
  const item = f.quick.kids[1] // 搜索会话
  item.click()
  f.flushRaf()
  assert.deepEqual(f.clicks, ['搜索会话'], 'the original was clicked, the drawer was not opened')

  // A re-render replaced the root's buttons between build and click: the
  // replacement — the fresh node the selector now resolves to — is the one
  // clicked, not a captured stale node.
  const replacement = railButton('搜索会话', f.clicks)
  f.root.querySelector = selector => (selector.includes("'搜索会话'") ? replacement : null)
  f.clicks.length = 0
  item.click()
  f.flushRaf()
  assert.deepEqual(f.clicks, ['搜索会话'], 'exactly the replacement was clicked')
})

test('a quick action waits for the drawer animation before measuring its anchor', () => {
  const f = fixture({ drawerClosed: true })
  f.quick.kids[2].click() // Cordis 插件 — the panel that anchors to its badge

  assert.deepEqual(f.clicks, ['mark'], 'the mark opened the drawer; nothing else clicked yet')
  f.flushRaf()
  assert.deepEqual(f.clicks, ['mark'], 'wait until the anchor stops moving')
  f.flushTimers()
  assert.deepEqual(f.clicks, ['mark', 'Cordis 插件'], 'the original is clicked once the geometry is final')
})

test('a quick action runs immediately when animation is off', () => {
  const f = fixture({ drawerClosed: true })
  f.documentElement.setAttribute('data-dsh-desktop-animation', 'off')
  f.quick.kids[2].click()
  f.flushRaf()
  assert.deepEqual(f.clicks, ['mark', 'Cordis 插件'])
})

test('closing the drawer during a quick action cancels its delayed click', () => {
  const f = fixture({ drawerClosed: true })
  f.quick.kids[2].click()
  f.flushRaf()
  f.mark.click()
  f.flushTimers()
  assert.deepEqual(f.clicks, ['mark', 'mark'])
})

test('the group list drops the drawer toggle rather than routing it to the mark', () => {
  // The removal is a REMOVAL, not a redirection: the tier must not carry the
  // toggle as a button whose click forwards to the mark. The rail's own toggle
  // group is out of `RAIL_GROUPS`, and the only use of the mark left in the
  // click path opens the drawer for a panel-anchored action.
  const groups = source.slice(source.indexOf('var RAIL_GROUPS'), source.indexOf('var RAIL_GROUPS') + 600)
  assert.ok(!groups.includes("class*='_toggle'"), 'the toggle group must not be among the mirrored groups')
  assert.ok(source.includes(".dshTb__mark"), 'quick actions still drive the bar’s mark')
  assert.ok(
    groups.includes("_newSession") && groups.includes("_searchButton"),
    'and the controls a phone cannot otherwise reach stay',
  )
})

test('新建会话 does not open the drawer over the composer it opens', () => {
  const f = fixture({ drawerClosed: true })
  f.quick.kids[0].click() // 新建会话
  f.flushRaf()

  assert.deepEqual(f.clicks, ['新建会话'], 'the app’s own handler ran, and the drawer stayed shut')
  assert.equal(f.sidebarCol.getAttribute('data-dsh-quick-open'), null, 'no snap flag is left behind')
})

test('插件 opens its main view without opening the closed drawer', () => {
  const f = fixture({ pluginPanel: true })
  f.quick.kids[2].click()
  f.flushRaf()
  assert.deepEqual(f.clicks, ['插件'])
  assert.equal(f.sidebarCol.getAttribute('data-dsh-quick-open'), null)
})
