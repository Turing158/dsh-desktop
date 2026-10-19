/** Exercise navigation motion against the installed DSH in an isolated profile.
 * Run: node tools/ui-motion-smoke.mjs. Requires the bundled Playwright + Edge.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { offlineModelPatch, handleOnboarding, dismissInitialWelcome, openDshSettings } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/ui-motion-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home)
await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: on\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/motion-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({ id: '@dsh-desktop/motion-smoke',
  factory: () => ({ inject: ['configForms', 'slots', 'sessions', 'workspaces', 'uiWorkspace', 'sidebarRight'],
    apply(ctx) { window.__MOTION_SMOKE__ = ctx } }) })`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + offlineModelPatch
  + '\n- insert:\n    - id: desktop-motion-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_UI_SMOKE_KEY: 'mock-key' },
})
let output = '', browser, page
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { root, checks: [] }
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }
try {
  let url
  for (let i = 0; i < 300; i++) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error('DSH exited: ' + output.slice(-2000))
    await sleep(100)
  }
  assert.ok(url, 'isolated backend starts')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  await handleOnboarding(page)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.motionCalls = []
    const animate = Element.prototype.animate
    Element.prototype.animate = function (frames, options) {
      window.motionCalls.push({ slot: this.getAttribute('data-slot'), className: this.className, id: this.id, dock: this.getAttribute('data-dockkit-content'),
        session: this.getAttribute('data-conversation-session'), frames, options })
      return animate.call(this, frames, options)
    }
  })
  await page.goto(url)
  await page.waitForFunction(() => window.__MOTION_SMOKE__?.configForms.get('desktop-appearance').getSnapshot().status === 'ready')
  await page.waitForSelector('[data-conversation-content]')
  await dismissInitialWelcome(page)
  await page.waitForTimeout(400)
  // The browser overlay relocates this trigger into its chrome.
  await openDshSettings(page)
  await page.waitForSelector('[data-shortcut-modal="settings"]')
  await page.waitForTimeout(250)
  await page.evaluate(() => { window.motionCalls = [] })
  await page.locator('[class*="_navList"] button').filter({ hasText: '外观' }).click()
  await page.waitForTimeout(240)
  assert.ok((await page.evaluate(() => window.motionCalls)).some(call => call.className.includes('_options') && call.frames[0].translate === '6px 0'))
  pass('settings section switches with a 6px slide')
  await page.screenshot({ path: join(root, 'settings-light.png') })
  await page.evaluate(() => window.__MOTION_SMOKE__.configForms.get('ui-theme').set('preference', 'dark'))
  await page.waitForTimeout(100)
  await page.screenshot({ path: join(root, 'settings-dark.png') })
  pass('light and dark settings render')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const ids = await page.evaluate(async path => {
    const ctx = window.__MOTION_SMOKE__, workspace = await ctx.workspaces.create({ path })
    const ids = []
    for (let i = 0; i < 2; i++) ids.push(await ctx.sessions.create({ workspaceId: workspace.workspaceId }))
    return ids
  }, root)
  for (const id of ids) {
    await page.evaluate(id => { window.motionCalls = []; window.__MOTION_SMOKE__.uiWorkspace.openSession(id) }, id)
    await page.waitForTimeout(300)
    assert.ok((await page.evaluate(() => window.motionCalls)).some(call => call.session === id))
  }
  pass('switching sessions animates the retained conversation')
  await page.evaluate(() => {
    window.motionCalls = []
    const content = document.querySelector('[data-conversation-content]')
    const row = document.createElement('p')
    content.appendChild(row)
    row.textContent = 'stream update'
    row.textContent += ' more text'
    row.remove()
  })
  await page.waitForTimeout(250)
  assert.equal((await page.evaluate(() => window.motionCalls)).length, 0)
  pass('streamed content does not replay navigation motion')
  const editor = page.locator('[data-composer-card] [contenteditable="true"]')
  await editor.fill('')
  await editor.evaluate(node => {
    window.motionEditorRoot = node
    window.motionEditor = node.__lexicalEditor
    const probe = document.createElement('div')
    probe.id = 'composition-motion-probe'
    probe.setAttribute('role', 'tablist')
    document.body.append(probe)
  })
  const cdp = await page.context().newCDPSession(page)
  for (const text of ['n', 'ni', 'nih', 'niha', 'nihao']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
    await page.evaluate(async text => {
      motionCalls = []
      // A non-input UI update schedules the real overlay's navigation scan.
      document.getElementById('composition-motion-probe').setAttribute('aria-selected', String(text.length % 2 === 0))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }, text)
    // Lexical keeps a U+200B composition sentinel beside the native IME text.
    assert.equal((await editor.innerText()).replace(/\u200b/g, ''), text)
    assert.deepEqual(await editor.evaluate(node => ({ sameRoot: node === window.motionEditorRoot,
      sameEditor: !!window.motionEditor && node.__lexicalEditor === window.motionEditor,
      focused: document.activeElement === node, composing: node.__lexicalEditor.isComposing(),
      motion: window.motionCalls.length })), { sameRoot: true, sameEditor: true, focused: true, composing: true, motion: 0 })
  }
  await cdp.send('Input.insertText', { text: '你好' })
  assert.equal(await editor.innerText(), '你好')
  await editor.fill('')
  await page.evaluate(() => {
    document.getElementById('composition-motion-probe').remove()
    delete window.motionEditorRoot
    delete window.motionEditor
  })
  await cdp.detach()
  pass('real Lexical composer preserves IME letters, committed Chinese, editor identity and focus during overlay updates')
  for (const kind of ['files', 'guide', 'files']) {
    await page.evaluate(kind => { window.motionCalls = []; window.__MOTION_SMOKE__.sidebarRight.openTab(kind) }, kind)
    await page.waitForTimeout(300)
    assert.equal((await page.evaluate(() => window.motionCalls)).some(call => call.dock), false, kind + ' tab stays still')
  }
  pass('right panel tabs stay still when opened and revisited')
  // Check fast navigation and cancellation before popup anchor measurements.
  await page.evaluate(id => window.__MOTION_SMOKE__.uiWorkspace.openSession(id), ids[0])
  await page.waitForTimeout(35)
  await page.evaluate(id => window.__MOTION_SMOKE__.uiWorkspace.openSession(id), ids[1])
  await page.waitForTimeout(35)
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  assert.equal(await page.locator('[data-conversation-content]').evaluate(node => node.getAnimations().length), 0)
  assert.equal(await page.locator('[data-conversation-content]').evaluate(node => getComputedStyle(node).translate), 'none')
  pass('rapid switching and pointer interaction leave no stale transform')
  // Exercise retained panels even when this DSH version installs only one
  // settings subtab. No native shell is needed for their ARIA contract.
  await page.evaluate(() => {
    const fixture = document.createElement('div')
    fixture.id = 'motion-fixture'
    fixture.innerHTML = '<div role="tablist"><button role="tab" aria-selected="true" aria-controls="motion-a">A</button><button role="tab" aria-selected="false" aria-controls="motion-b">B</button></div><div role="tabpanel" id="motion-a">A</div><div role="tabpanel" id="motion-b" hidden>B</div>'
    document.body.appendChild(fixture)
  })
  await page.waitForTimeout(220)
  for (const id of ['motion-b', 'motion-a', 'motion-b']) {
    await page.evaluate(id => {
      window.motionCalls = []
      document.querySelectorAll('#motion-fixture [role="tab"]').forEach(tab => tab.setAttribute('aria-selected', String(tab.getAttribute('aria-controls') === id)))
      document.querySelectorAll('#motion-fixture [role="tabpanel"]').forEach(panel => { panel.hidden = panel.id !== id })
    }, id)
    await page.waitForTimeout(220)
    assert.ok((await page.evaluate(() => window.motionCalls)).some(call => call.id === id))
  }
  pass('retained settings panels still animate on tab revisit')
  await page.locator('#motion-fixture').evaluate(node => node.remove())
  for (const preference of ['off', 'system', 'on']) {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(preference => window.__MOTION_SMOKE__.configForms.get('desktop-appearance').set('animation', preference), preference)
    await page.evaluate(id => { window.motionCalls = []; window.__MOTION_SMOKE__.uiWorkspace.openSession(id) }, ids[0])
    await page.waitForTimeout(240)
    const calls = await page.evaluate(() => window.motionCalls)
    assert.equal(calls.some(call => call.session === ids[0]), preference === 'on')
    await page.evaluate(id => window.__MOTION_SMOKE__.uiWorkspace.openSession(id), ids[1])
    await page.waitForTimeout(240)
  }
  pass('off, system reduced motion, and explicit on are respected')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openDshSettings(page)
  const opening = await page.evaluate(async () => {
    await new Promise(requestAnimationFrame)
    const panel = document.querySelector('[data-shortcut-modal="settings"]')
    return panel.getAnimations().flatMap(animation => animation.effect.getKeyframes())
  })
  assert.ok(opening.some(frame => frame.translate === '0px 6px' && frame.scale === '0.99'))
  await page.waitForTimeout(220)
  await page.locator('[class*="_navList"] button').filter({ hasText: '外观' }).click()
  await page.waitForTimeout(230)
  const menu = await page.evaluate(async () => {
    document.querySelector('.dshAppearance__selector').click()
    await new Promise(requestAnimationFrame)
    const menu = document.querySelector('[role="menu"]:not([data-dsh-ghost])')
    return menu.getAnimations().flatMap(animation => animation.effect.getKeyframes())
  })
  assert.ok(menu.some(frame => frame.translate === '0px -4px' && frame.scale === '0.985'))
  await page.waitForTimeout(180)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.keyboard.press('Escape')
  const closing = await page.locator('[data-dsh-ghost="layer"] [role="dialog"]').evaluate(node =>
    node.getAnimations().flatMap(animation => animation.effect.getKeyframes()))
  assert.ok(closing.some(frame => frame.translate === '0px 5px' && frame.scale === '0.99'))
  await page.waitForTimeout(280)
  assert.equal(await page.locator('[data-dsh-ghost]').count(), 0)
  pass('menus and dialogs enter and exit with movement and scaling; ghosts are removed')
  await page.setViewportSize({ width: 390, height: 844 })
  await openDshSettings(page)
  await page.waitForTimeout(240)
  await page.locator('[class*="_navList"] button').filter({ hasText: '模型' }).click()
  await page.waitForTimeout(240)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(root, 'settings-mobile.png') })
  pass('390px mobile settings switch without horizontal overflow')
  assert.deepEqual(errors, [])
  pass('no browser errors')
} catch (error) {
  report.error = error.stack
  if (page) {
    report.body = await page.locator('body').innerText().catch(() => '')
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  }
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  console.log('Report: ' + join(root, 'report.json'))
}
