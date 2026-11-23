/** Browser regressions for sidebar geometry, observer work and immediate disclosures. */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createDockLayout } from '../dsh-plugin/sidebar-terminal/dock-layout.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const browser = await chromium.launch({ headless: true, channel: 'msedge' })
after(() => browser.close())

async function fixture(t) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  t.after(() => page.close())
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  t.after(() => assert.deepEqual(errors, []))
  await page.setContent(`<style>
    body { margin:0 }
    .fixture_centerCol { height:840px; box-sizing:border-box; padding-bottom:min(var(--dsh-terminal-dock-height,0px),100%); }
    [data-sidebar-right-panel] { position:fixed; right:0; top:44px; width:300px; bottom:var(--dsh-terminal-dock-height,0px) }
    [data-sidebar-right-panel=fullscreen] { inset:44px 0 0; width:auto }
    [data-dsh-terminal-dock] { position:fixed; left:0; right:0; bottom:0; height:240px }
  </style><div id="root"><div class="fixture_centerCol"><div id="conversation">
    <div data-conversation-content data-conversation-region="chat"><div data-chat-flow>
    ${'<p>Long response <code>const value = 42</code></p>'.repeat(300)}
    </div><div data-conversation-region="composer"><div data-composer-card><textarea></textarea></div></div></div>
  </div></div><aside data-sidebar-right-panel="push"></aside></div><div data-dsh-terminal-dock></div>`)
  await page.evaluate(() => {
    window.nextFrame = () => new Promise(requestAnimationFrame)
    window.waitForMotion = async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); await nextFrame() }
    document.documentElement.setAttribute('data-dsh-desktop-animation', 'on')
  })
  return page
}

test('conversation width measurements skip the layer sweep; real style and popup changes still run', async t => {
  const page = await fixture(t)
  await page.addScriptTag({ content: readFileSync('dsh-plugin/ui-overlay/dom.js', 'utf8') })
  const result = await page.evaluate(async () => {
    await nextFrame(); await nextFrame()
    const root = document.querySelector('#conversation'), reads = []
    const nativeStyle = window.getComputedStyle
    window.getComputedStyle = function (node, ...args) {
      if (node === root || root.contains(node)) reads.push(node.tagName)
      return nativeStyle.call(this, node, ...args)
    }
    for (let i = 0; i < 16; i++) {
      root.style.setProperty('--dsh-conversation-column-width', (700 + i) + 'px')
      root.style.setProperty('--dsh-chat-user-width', (680 + i) + 'px')
      await nextFrame()
    }
    const geometryReads = reads.length
    // A style change bundled with a width measurement must still be inspected.
    root.style.cssText += ';position:fixed;inset:0'
    await Promise.resolve(); await Promise.resolve()
    const tagged = root.getAttribute('data-dsh-chrome')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.style.cssText = 'position:fixed;inset:0'
    root.querySelector('[data-chat-flow]').appendChild(dialog)
    await Promise.resolve(); await Promise.resolve()
    return { geometryReads, tagged, dialog: dialog.getAttribute('data-dsh-chrome') }
  })
  assert.equal(result.geometryReads, 0, 'resizing must not read every conversation descendant’s computed style')
  assert.equal(result.tagged, 'layer', 'real positioning changes still run before paint')
  assert.equal(result.dialog, 'layer', 'a dialog mounted inside content is still discovered before paint')
})

async function installDock(page) {
  await page.addScriptTag({ content: `window.createDockLayout = ${createDockLayout.toString()}` })
  await page.evaluate(() => {
    window.hiddenCount = 0
    window.dock = document.querySelector('[data-dsh-terminal-dock]')
    window.layout = createDockLayout(document, () => { hiddenCount++; dock.hidden = true })
    window.measure = () => ({
      visible: dock.hidden ? 0 : 840 - dock.getBoundingClientRect().top,
      padding: parseFloat(getComputedStyle(document.querySelector('.fixture_centerCol')).paddingBottom),
      right: parseFloat(getComputedStyle(document.querySelector('[data-sidebar-right-panel]')).bottom),
    })
  })
}

test('dock disclosures immediately align all three edges without animation or per-frame root writes', async t => {
  const page = await fixture(t)
  await installDock(page)
  const result = await page.evaluate(async () => {
    let writes = 0
    const observer = new MutationObserver(records => writes += records.length)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    layout.update(true, 240)
    const before = measure()
    layout.update(false, 240)
    const after = measure()
    const samples = []
    for (let i = 0; i < 4; i++) { await nextFrame(); samples.push(measure()) }
    observer.disconnect()
    return { before, after, samples, writes, hiddenCount, animations: document.getAnimations().length,
      reserved: document.documentElement.style.getPropertyValue('--dsh-terminal-dock-height') }
  })
  assert.deepEqual(result.before, { visible: 240, padding: 240, right: 240 })
  assert.deepEqual(result.after, { visible: 0, padding: 0, right: 0 })
  assert.ok(result.samples.every(s => s.visible === 0 && s.padding === 0 && s.right === 0))
  assert.ok(result.writes <= 2, 'only destinations are published to inherited root styles')
  assert.equal(result.animations, 0)
  assert.equal(result.hiddenCount, 1)
  assert.equal(result.reserved, '0px')
})

test('animation preferences, resizing and disposal leave no delayed dock layout', async t => {
  const page = await fixture(t)
  await installDock(page)
  const result = await page.evaluate(async () => {
    layout.update(true, 240)
    layout.update(false, 240)
    document.documentElement.setAttribute('data-dsh-desktop-animation', 'off')
    await Promise.resolve()
    const disabled = { count: document.getAnimations().length, height: measure().padding, hiddenCount }
    document.documentElement.setAttribute('data-dsh-desktop-animation', 'on')
    dock.hidden = false
    layout.update(true, 240)
    layout.update(true, 300)
    const resized = { count: document.getAnimations().length, height: measure().padding }
    layout.update(false, 300)
    layout.dispose()
    return { disabled, resized, disposed: { count: document.getAnimations().length, height: measure().padding } }
  })
  assert.deepEqual(result.disabled, { count: 0, height: 0, hiddenCount: 1 })
  assert.deepEqual(result.resized, { count: 0, height: 300 })
  assert.deepEqual(result.disposed, { count: 0, height: 0 })
})

test('a right preview immediately switches between fullscreen and reserved dock space', async t => {
  const page = await fixture(t)
  await installDock(page)
  const result = await page.evaluate(async () => {
    layout.update(true, 240)
    const right = document.querySelector('[data-sidebar-right-panel]')
    right.setAttribute('data-sidebar-right-panel', 'fullscreen')
    const fullscreenBottom = getComputedStyle(right).bottom
    right.setAttribute('data-sidebar-right-panel', 'push')
    const joined = measure()
    await nextFrame()
    return { fullscreenBottom, joined, settled: measure() }
  })
  assert.equal(result.fullscreenBottom, '0px')
  assert.ok(Math.abs(result.joined.right - result.joined.padding) < 1)
  assert.equal(result.settled.right, 240)
})
