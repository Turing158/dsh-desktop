/** Verify navigation surfaces share one transparency setting and visible paint. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { colorSchemes } from '../dsh-plugin/ui-overlay/color-schemes.mjs'
import { handleOnboarding, dismissInitialWelcome, offlineModelPatch } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = await mkdtemp(resolve('src-tauri/target/navigation-colors-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home); await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: off\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({
  name: '@dsh-desktop/navigation-colors-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } },
}))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({
  id: '@dsh-desktop/navigation-colors-smoke',
  factory: () => ({ inject: ['configForms', 'theme'], apply(ctx) { window.navigationContext = ctx } }),
})`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + offlineModelPatch + '\n- insert:\n    - id: navigation-colors-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml'); await writeFile(patchPath, patch)
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_UI_SMOKE_KEY: 'offline-fixture' },
})
let logs = '', browser, page
child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data)
const report = { root, checks: [], errors: [] }
async function set(changes) {
  await page.evaluate(async changes => {
    const form = window.navigationContext.configForms.get('desktop-appearance')
    for (const [key, value] of Object.entries(changes)) await form.set(key, value)
  }, changes)
}
async function paint() {
  const screenshot = await page.screenshot({ scale: 'css' })
  return page.evaluate(async data => {
    const image = new Image(); image.src = data; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
    const read = (selector, y) => {
      const style = getComputedStyle(document.querySelector(selector))
      return { background: style.backgroundColor, image: style.backgroundImage,
        pixels: [...context.getImageData(4, y, 1, 1).data] }
    }
    const bar = document.querySelector('.dshTb').getBoundingClientRect()
    const sidebar = document.querySelector('[class*="_sidebarCol"]').getBoundingClientRect()
    const rows = new Set([Math.floor(bar.height * .2), Math.floor(bar.height * .5), Math.floor(bar.height * .9)])
    for (let y = Math.floor(bar.bottom) - 6; y <= Math.ceil(sidebar.top) + 8; y++) rows.add(y)
    return { titlebar: read('.dshTb', Math.floor(bar.height * .5)), sidebar: read('[class*="_sidebarCol"]', 300),
      seam: [...rows].map(y => ({ y, pixels: [...context.getImageData(4, y, 1, 1).data] })) }
  }, 'data:image/png;base64,' + screenshot.toString('base64'))
}
function compare(actual, label) {
  assert.equal(actual.titlebar.background, actual.sidebar.background, label + ' canvas')
  assert.equal(actual.titlebar.image, actual.sidebar.image, label + ' background layers')
  assert.deepEqual(actual.titlebar.pixels, actual.sidebar.pixels, label + ' visible pixels')
  for (const sample of actual.seam) {
    assert.deepEqual(sample.pixels, actual.sidebar.pixels, label + ' uniform navigation at y=' + sample.y)
  }
  report.checks.push(label)
}
async function openPage(options) {
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 850 }, ...options })
  page.on('pageerror', error => report.errors.push(error.message))
  await page.addInitScript(() => {
    window.__DSH_UI_BOOT__ = { smoke: true }
    window.__TAURI__ = { core: { Channel: class {}, invoke: async () => null }, event: { listen: async () => () => {} } }
  })
  await handleOnboarding(page)
  await page.goto(report.url)
  await page.waitForFunction(() => window.navigationContext && document.querySelector('.dshTb'))
  if (!options) await dismissInitialWelcome(page)
  if (await page.locator('[data-shortcut-modal="settings"]').count()) await page.keyboard.press('Escape')
}
try {
  let url
  for (let i = 0; i < 300; i++) {
    url = logs.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error(logs.slice(-3000))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(url, logs.slice(-3000))
  report.url = url
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  await openPage()
  // A uniform photograph isolates surface tint from differences in image content.
  const picture = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64
    const context = canvas.getContext('2d'); context.fillStyle = '#537fa3'; context.fillRect(0, 0, 64, 64)
    return canvas.toDataURL()
  })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.navigationContext.theme.setTheme(theme), theme)
    for (const scheme of ['default', ...colorSchemes.map(scheme => scheme.id)]) {
      await set({ colorScheme: scheme, backgroundImage: '' })
      compare(await paint(), theme + '/' + scheme + '/opaque')
      await set({ backgroundImage: picture, backgroundNavigation: true, backgroundTransparency: 25 })
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-dsh-background-titlebar')
        && document.documentElement.hasAttribute('data-dsh-background-left'))
      for (const blur of [0, 65]) {
        await set({ backgroundBlur: blur })
        for (const alpha of [0, 50, 100]) {
          await set({ backgroundNavigationSurfaceTransparency: alpha })
          compare(await paint(), theme + '/' + scheme + '/blur-' + blur + '/transparency-' + alpha)
        }
      }
    }
    console.log('PASS: ' + theme + ' navigation pixels match across seven palettes, three transparencies and both blur modes')
  }
  await set({ backgroundBlur: 0, backgroundTitlebarSurfaceTransparency: 20, backgroundLeftSurfaceTransparency: 80 })
  compare(await paint(), 'shared transparency overrides differing legacy values')
  await set({ colorScheme: 'blue', backgroundNavigationSurfaceTransparency: 50 })
  await page.screenshot({ path: join(root, 'matching-navigation.png') })
  await set({ backgroundNavigation: false })
  for (const selector of ['.dshTb', '[class*="_sidebarCol"]']) {
    assert.equal(await page.locator(selector).evaluate(node => getComputedStyle(node).backgroundImage), 'none')
  }
  await set({ backgroundNavigation: true })
  compare(await paint(), 'shared image switch restores both navigation regions')
  await set({ backgroundImage: '' })
  compare(await paint(), 'removal restores equal opaque surfaces')
  assert.equal(await page.locator('[class*="_sidebarCol"]').evaluate(node => getComputedStyle(node).willChange), 'auto')
  assert.equal(await page.locator('.dshTb').evaluate(node => getComputedStyle(node).boxShadow), 'none')
  assert.equal(await page.locator('[class*="_sidebarCol"]').evaluate(node => getComputedStyle(node).boxShadow), 'none')
  // Fractional display scales and page zoom put the seam between device pixels.
  // Check a nonuniform picture too: vertical stripes have equal colors at every
  // height, so a mismatch exposes a paint seam rather than wallpaper content.
  for (const deviceScaleFactor of [1.25, 1.5]) {
    await page.context().close()
    await openPage({ deviceScaleFactor })
    const stripedPicture = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 850
      const context = canvas.getContext('2d')
      for (let x = 0; x < canvas.width; x += 80) {
        context.fillStyle = x % 160 === 0 ? '#537fa3' : '#c29569'; context.fillRect(x, 0, 80, canvas.height)
      }
      return canvas.toDataURL()
    })
    await set({ backgroundImage: stripedPicture, backgroundNavigation: true })
    for (const zoom of [1, .9]) {
      await page.evaluate(zoom => document.documentElement.style.zoom = String(zoom), zoom)
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => window.navigationContext.theme.setTheme(theme), theme)
        for (const scheme of ['default', 'blue']) {
          await set({ colorScheme: scheme })
          for (const blur of [0, 65]) {
            await set({ backgroundBlur: blur, backgroundNavigationSurfaceTransparency: 15 })
            compare(await paint(), 'scale-' + deviceScaleFactor + '/zoom-' + zoom + '/' + theme + '/' + scheme + '/blur-' + blur)
          }
        }
      }
    }
  }
  console.log('PASS: navigation has no color bands at the seam across fractional display scales, page zoom and striped wallpaper')
  assert.deepEqual(report.errors, [])
  console.log('PASS: shared navigation switch, transparency and background removal retain expected behavior')
} catch (error) {
  report.failure = error.stack
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  console.error(error.stack); process.exitCode = 1
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(join(root, 'backend.log'), logs)
  await browser?.close()
  if (child.exitCode === null) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  }
  console.log('Report: ' + root)
}
