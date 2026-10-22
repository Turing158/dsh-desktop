/** Render the otherwise empty update window, including unavailable/slow IPC.
 * Run: node tools/update-animation-smoke.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = await mkdtemp(resolve('src-tauri/target/update-animation-'))
const boot = await readFile('dsh-plugin/title-bar/boot.js', 'utf8')
const bridge = await readFile('dsh-plugin/ui-state/bridge.js', 'utf8')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  for (const dark of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, reducedMotion: 'reduce' })
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>body{margin:0;background:${dark ? '#111' : '#f9fafb'}}</style></head><body ${dark ? 'data-ds-dark-theme' : ''}></body></html>` }))
    await page.goto('http://localhost')
    await page.evaluate(() => {
      window.__DSH_DESKTOP_BOOT_HOST__ = true
      window.__DSH_UI_BOOT__ = { windowGeneration: 1 }
      window.__TAURI__ = { core: { invoke: command => command === 'desktop_boot_context' ? new Promise(resolve => { window.resolveBootContext = resolve }) : Promise.resolve(false) } }
    })
    await page.addScriptTag({ content: boot })
    const loading = page.locator('#dsh-desktop-titlebar-boot-loading')
    assert.ok(await loading.isVisible(), 'pending IPC cannot leave an empty window')
    const rotation = () => loading.locator('.dshBoot__spinner').evaluate(node => getComputedStyle(node).transform)
    const before = await rotation()
    await page.waitForTimeout(150)
    assert.notEqual(await rotation(), before, 'the update ring moves even with reduced motion enabled')
    await page.screenshot({ path: join(root, `pending-${dark ? 'dark' : 'light'}.png`) })
    const expectedPalette = { dark, background: dark ? 'rgb(27, 27, 28)' : 'rgb(249, 250, 251)',
      foreground: dark ? 'rgb(249, 250, 251)' : 'rgb(15, 17, 21)', border: 'rgb(90, 90, 90)',
      contentBackground: dark ? 'rgb(18, 18, 18)' : 'rgb(255, 255, 255)',
      secondaryForeground: dark ? 'rgb(170, 172, 178)' : 'rgb(92, 96, 104)' }
    const palette = await page.evaluate(expected => {
      const bar = document.createElement('div')
      bar.className = 'dshTb'
      bar.innerHTML = '<span class="dshTb__wordmark">dsh</span>'
      bar.style.cssText = 'position:fixed;visibility:hidden;background-color:' + (expected.dark ? '#000' : '#fff')
        + ';background-image:linear-gradient(#8882,#8882);border-bottom:1px solid #222;'
      for (const [token, color] of Object.entries({ '--dsw-specific-sidebar-fill': expected.background,
        '--dsw-alias-bg-base': expected.contentBackground, '--dsw-alias-label-primary': expected.foreground,
        '--dsw-alias-label-secondary': expected.secondaryForeground, '--dsw-alias-border-l2': expected.border })) bar.style.setProperty(token, color)
      document.body.append(bar)
      const palette = window.__DSH_DESKTOP_BOOT__.capturePalette()
      if (bar.children.length !== 1) throw new Error('palette capture leaked its color probe')
      bar.remove()
      return palette
    }, expectedPalette)
    assert.deepEqual(palette, expectedPalette, 'capture uses theme tokens rather than the background-image canvas')
    await page.evaluate(palette => window.resolveBootContext({ local: false, updating: true, restoring: true, palette }), palette)
    await page.waitForFunction(() => document.querySelector('.dshBoot__loadingLabel')?.textContent === '正在更新 dsh…')
    assert.equal(await loading.evaluate(node => getComputedStyle(node).backgroundColor), palette.contentBackground)
    assert.equal(await loading.evaluate(node => getComputedStyle(node).color), palette.foreground)
    assert.equal(await loading.locator('.dshBoot__loadingHint').evaluate(node => getComputedStyle(node).color), palette.secondaryForeground)
    assert.equal(await page.locator('#dsh-desktop-titlebar-boot').evaluate(node => getComputedStyle(node).backgroundColor), palette.background)
    await page.screenshot({ path: join(root, `updating-${dark ? 'dark' : 'light'}.png`) })
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-dsh-titlebar', '')
      document.dispatchEvent(new Event('dsh-desktop:titlebar-ready'))
    })
    assert.ok(await loading.isVisible(), 'a ready title bar cannot remove pending restoration feedback')
    // Exercise the actual state bridge after the real title bar has mounted.
    await page.addScriptTag({ content: bridge })
    await page.evaluate(async () => {
      window.__DSH_UI_STATE__.registerRestartAdapter(() => ({ capture: async () => ({ page: { kind: 'dsh' } }) }))
      await window.__DSH_UI_STATE__.prepareRemoteApply('0.2.0', '正在保存界面并更新 dsh…')
    })
    assert.equal(await loading.count(), 0, 'the state overlay takes over without stacking two statuses')
    assert.ok(await page.locator('[data-dsh-ui-status] .dshBoot__spinner').isVisible())
    assert.equal(await page.locator('[data-dsh-ui-status]').evaluate(node => getComputedStyle(node).backgroundColor), palette.contentBackground)
    const savingRotation = () => page.locator('[data-dsh-ui-status] .dshBoot__spinner').evaluate(node => getComputedStyle(node).transform)
    const savingBefore = await savingRotation()
    await page.waitForTimeout(150)
    assert.notEqual(await savingRotation(), savingBefore, 'the saving ring moves even with reduced motion enabled')
    await page.screenshot({ path: join(root, `saving-${dark ? 'dark' : 'light'}.png`) })
    await page.evaluate(() => window.__DSH_UI_STATE__.finishRemoteApply())
    assert.equal(await page.locator('[data-dsh-ui-status]').count(), 0)
    // The local installation page uses the same captured content and text colors.
    const local = await browser.newPage({ viewport: { width: 1280, height: 840 } })
    const localCss = await readFile('src-tauri/ui/style.css', 'utf8')
    await local.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>' + localCss + '</style></head><body></body></html>' }))
    await local.goto('http://localhost')
    await local.evaluate(palette => {
      window.__DSH_DESKTOP_BOOT_HOST__ = true
      window.__TAURI__ = { core: { invoke: async command => command === 'desktop_boot_context' ? { local: true, updating: true, restoring: true, palette } : false } }
    }, palette)
    await local.addScriptTag({ content: boot })
    await local.waitForFunction(() => document.documentElement.hasAttribute('data-dsh-boot-scheme'))
    assert.equal(await local.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), palette.contentBackground)
    assert.equal(await local.locator('body').evaluate(node => getComputedStyle(node).color), palette.foreground)
    await local.screenshot({ path: join(root, `local-${dark ? 'dark' : 'light'}.png`) })
    await local.close()
    await page.close()
  }
  console.log('PASS: light/dark theme colors survive image canvases, installation and restoration; loading stays visible and animated')
  console.log('Screenshots: ' + root)
} finally { await browser.close() }
