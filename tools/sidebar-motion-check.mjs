/** Browser regressions for sidebar geometry, observer work and interrupted exits. */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createDockMotion } from '../dsh-plugin/sidebar-terminal/dock-motion.mjs'

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
  await page.addScriptTag({ content: `window.createDockMotion = ${createDockMotion.toString()}` })
  await page.evaluate(() => {
    window.hiddenCount = 0
    window.dock = document.querySelector('[data-dsh-terminal-dock]')
    window.motion = createDockMotion(document, () => { hiddenCount++; dock.hidden = true })
    window.measure = () => ({
      visible: dock.hidden ? 0 : 840 - dock.getBoundingClientRect().top,
      padding: parseFloat(getComputedStyle(document.querySelector('.fixture_centerCol')).paddingBottom),
      right: parseFloat(getComputedStyle(document.querySelector('[data-sidebar-right-panel]')).bottom),
    })
  })
}

test('dock slides keep all three edges together and reverse without jumping or per-frame root writes', async t => {
  const page = await fixture(t)
  await installDock(page)
  const result = await page.evaluate(async () => {
    let writes = 0
    const observer = new MutationObserver(records => writes += records.length)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    motion.update(true, 240, dock)
    await nextFrame(); await nextFrame(); await nextFrame()
    const before = measure()
    motion.update(false, 240, dock)
    const after = measure()
    const samples = []
    while (dock.getAnimations().length) { await nextFrame(); samples.push(measure()) }
    observer.disconnect()
    return { before, after, samples, writes, hiddenCount, reserved: document.documentElement.style.getPropertyValue('--dsh-terminal-dock-height') }
  })
  assert.ok(result.before.visible > 0 && result.before.visible < 240)
  assert.ok(Math.abs(result.before.visible - result.after.visible) < 1, 'reversing must start at the currently painted position')
  assert.ok(result.samples.every(s => Math.abs(s.visible - s.padding) < 1 && Math.abs(s.visible - s.right) < 1), 'composer, preview and terminal must move on one timeline: ' + JSON.stringify(result.samples))
  assert.ok(result.writes <= 2, 'only destinations are published to inherited root styles')
  assert.equal(result.hiddenCount, 1)
  assert.equal(result.reserved, '0px')
})

test('disabling motion, resizing and disposing release all owned animation effects', async t => {
  const page = await fixture(t)
  await installDock(page)
  const result = await page.evaluate(async () => {
    motion.update(true, 240, dock)
    await waitForMotion()
    motion.update(false, 240, dock)
    await nextFrame()
    document.documentElement.setAttribute('data-dsh-desktop-animation', 'off')
    await Promise.resolve()
    const disabled = { count: document.getAnimations().length, height: measure().padding, hiddenCount }
    document.documentElement.setAttribute('data-dsh-desktop-animation', 'on')
    dock.hidden = false
    motion.update(true, 240, dock)
    await nextFrame()
    motion.update(true, 300, dock)
    const resized = { count: document.getAnimations().length, height: measure().padding }
    motion.update(false, 300, dock)
    motion.dispose()
    return { disabled, resized, disposed: { count: document.getAnimations().length, height: measure().padding } }
  })
  assert.deepEqual(result.disabled, { count: 0, height: 0, hiddenCount: 1 })
  assert.deepEqual(result.resized, { count: 0, height: 300 })
  assert.deepEqual(result.disposed, { count: 0, height: 0 })
})

test('a right preview becoming fullscreen leaves the bottom animation immediately', async t => {
  const page = await fixture(t)
  await installDock(page)
  const result = await page.evaluate(async () => {
    motion.update(true, 240, dock)
    await nextFrame(); await nextFrame()
    const right = document.querySelector('[data-sidebar-right-panel]')
    right.setAttribute('data-sidebar-right-panel', 'fullscreen')
    await Promise.resolve()
    const fullscreenBottom = getComputedStyle(right).bottom
    right.setAttribute('data-sidebar-right-panel', 'push')
    await Promise.resolve()
    const joined = measure()
    await waitForMotion()
    return { fullscreenBottom, joined, settled: measure() }
  })
  assert.equal(result.fullscreenBottom, '0px')
  assert.ok(Math.abs(result.joined.right - result.joined.padding) < 1)
  assert.equal(result.settled.right, 240)
})
