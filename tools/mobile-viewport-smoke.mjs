/** Real DSH layout in mobile WebKit/Chromium, with deterministic VisualViewport
 * keyboard/chrome/pan events. Desktop automation cannot open an iOS keyboard.
 * Isolated profile; no model calls. DSH_DESKTOP_DSH_BIN selects another runtime.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = resolve(process.env.DSH_DESKTOP_DSH_BIN || 'pack/portable/runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/mobile-viewport-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home)
await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: off\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/viewport-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({ id: '@dsh-desktop/viewport-smoke',
  factory: () => ({ inject: ['sessions', 'workspaces', 'uiWorkspace', 'conversation', 'sidebarRight'],
    apply(ctx) { window.__VIEWPORT_SMOKE__ = ctx } }) })`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: desktop-viewport-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin },
})
let output = '', browser, page
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const report = { checks: [], samples: [] }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} != ${expected}`)
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }

try {
  let url
  for (let i = 0; i < 300; i++) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error(output.slice(-2000))
    await sleep(100)
  }
  assert.ok(url, 'DSH started')
  for (const engine of ['webkit', 'chromium']) {
    browser = engine === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'msedge', headless: true })
    const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } })
    await context.addInitScript(() => {
      const viewport = window.visualViewport, values = {}
      for (const name of ['height', 'offsetTop', 'scale']) {
        const read = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewport), name).get
        Object.defineProperty(viewport, name, { get: () => values[name] ?? read.call(viewport) })
      }
      window.__setVisibleViewport = (metrics, event = 'resize') => {
        for (const key of Object.keys(values)) delete values[key]
        Object.assign(values, metrics)
        viewport.dispatchEvent(new Event(event))
      }
    })
    page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && message.text().includes('slot entry crashed')) errors.push(message.text()) })
    await page.goto(url)
    await page.waitForFunction(() => window.__VIEWPORT_SMOKE__?.sessions.list.getSnapshot().phase === 'ready')
    // The second browser shares the server profile, which already accepted the
    // beta notice. Its first dialog goes straight to API-key onboarding.
    await page.getByRole('button', { name: /^(继续|稍后配置)$/ }).first().waitFor()
    for (const name of ['继续', '我知道了', '稍后配置']) {
      const button = page.getByRole('button', { name, exact: true })
      if (await button.count()) { await button.click(); await page.waitForTimeout(200) }
    }
    if (await page.locator('[data-shortcut-modal="settings"]').count()) await page.keyboard.press('Escape')
    await page.addLocatorHandler(page.getByRole('button', { name: '稍后配置', exact: true }), button => button.click())
    const id = await page.evaluate(async path => {
      const ctx = window.__VIEWPORT_SMOKE__, workspace = await ctx.workspaces.create({ path })
      const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
      ctx.uiWorkspace.openSession(id)
      ctx.sessions.binding(id).session.beginSubmission({ mode: 'queue', text: Array.from({ length: 20 }, (_, i) => '消息内容 ' + i).join('\n'), attachments: [] })
      ctx.conversation.input.for(ctx.sessions.scope(id)).setDraft('手机输入测试')
      return id
    }, root)
    const editor = page.locator('[data-composer-card] [contenteditable="true"]')
    await editor.waitFor()
    async function sample(name, metrics, event = 'resize') {
      await page.evaluate(({ metrics, event }) => window.__setVisibleViewport(metrics, event), { metrics, event })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const result = await page.evaluate(() => {
        const rect = selector => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, width: r.width } }
        return { root: rect('#root'), bar: rect('.dshTb'), editor: rect('[data-composer-card] [contenteditable="true"]'), card: rect('[data-composer-card]'),
          fontSize: parseFloat(getComputedStyle(document.querySelector('[data-composer-card] [contenteditable="true"]')).fontSize),
          width: innerWidth, scrollWidth: document.documentElement.scrollWidth, scrollY,
          cssHeight: document.documentElement.style.getPropertyValue('--dsh-mobile-height'), cssTop: document.documentElement.style.getPropertyValue('--dsh-mobile-top') }
      })
      report.samples.push({ engine, name, metrics, result })
      return result
    }
    function visible(result, height, top = 0) {
      near(result.root.top, top + result.bar.height, 'content starts below title bar')
      near(result.root.bottom, top + height, 'content fills the visible viewport without a bottom gap')
      near(result.bar.top, top, 'title bar follows the visible viewport')
      assert.ok(result.editor.top >= top + result.bar.height - 1, 'input stays below the title bar')
      assert.ok(result.editor.bottom <= top + height + 1, 'input stays above the keyboard')
      assert.ok(result.card.bottom <= top + height + 1, 'composer controls stay above the keyboard')
      assert.ok(top + height - result.card.bottom < 80, 'only the composer footer sits below the card')
      assert.ok(result.scrollWidth <= result.width + 1, 'no horizontal page overflow')
      assert.ok(result.fontSize >= 16, 'editable text prevents iOS focus zoom')
    }
    visible(await sample('browser bars visible', { height: 660, offsetTop: 0, scale: 1 }), 660)
    await editor.click()
    visible(await sample('keyboard open', { height: 320, offsetTop: 0, scale: 1 }), 320)
    await editor.press('End')
    await editor.pressSequentially(' input')
    visible(await sample('Safari keyboard pan', { height: 320, offsetTop: 140, scale: 1 }, 'scroll'), 320, 140)
    await page.screenshot({ path: join(root, engine + '-keyboard.png') })
    await page.evaluate(id => window.__VIEWPORT_SMOKE__.conversation.input.for(window.__VIEWPORT_SMOKE__.sessions.scope(id)).setDraft(Array.from({ length: 12 }, (_, i) => '多行输入 ' + i).join('\n')), id)
    visible(await sample('long draft with keyboard', { height: 320, offsetTop: 140, scale: 1 }), 320, 140)
    await page.evaluate(id => window.__VIEWPORT_SMOKE__.conversation.input.for(window.__VIEWPORT_SMOKE__.sessions.scope(id)).setDraft('手机输入测试'), id)
    await editor.blur()
    visible(await sample('keyboard closed', { height: 660, offsetTop: 0, scale: 1 }), 660)
    const zoomed = await sample('manual pinch zoom', { height: 330, offsetTop: 100, scale: 2 }, 'scroll')
    assert.equal(zoomed.cssHeight, '660px')
    assert.equal(zoomed.cssTop, '0px')
    visible(await sample('zoom reset', { height: 660, offsetTop: 0, scale: 1 }), 660)
    await page.setViewportSize({ width: 844, height: 390 })
    visible(await sample('landscape', { height: 340, offsetTop: 0, scale: 1 }), 340)
    await page.setViewportSize({ width: 390, height: 844 })
    visible(await sample('portrait restored', { height: 760, offsetTop: 0, scale: 1 }), 760)
    await page.screenshot({ path: join(root, engine + '-restored.png') })
    await page.evaluate(() => window.__VIEWPORT_SMOKE__.sidebarRight.openTab('guide'))
    const panel = page.locator('[data-sidebar-right-panel][data-sidebar-right-open]:visible')
    await panel.waitFor()
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-dsh-mobile-right-open'))
    for (const metrics of [{ height: 320, offsetTop: 140, scale: 1 }, { height: 760, offsetTop: 0, scale: 1 }]) {
      await sample('right panel viewport', metrics, 'scroll')
      const bounds = await panel.boundingBox()
      const header = await page.locator('header:has([data-conversation-header-corner])').boundingBox()
      near(bounds.y, header.y, 'right panel follows the session header when the viewport pans')
      near(bounds.y + bounds.height, metrics.offsetTop + metrics.height, 'right panel fills the visible viewport')
    }
    assert.deepEqual(errors, [])
    assert.equal(await page.locator('[data-slot-error]').count(), 0)
    pass(engine + ': visible composer, no bottom gap, 16px inputs, keyboard pan/close, long drafts, pinch zoom and rotation')
    await browser.close()
    browser = page = undefined
  }
} catch (error) {
  report.error = error.stack
  if (page) await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  console.log('Report: ' + root)
}
