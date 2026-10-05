// Isolated real DSH/browser acceptance; no user settings or running app touched.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootPatches } from '../dsh-plugin/plugin-control/model.mjs'
import { checkPluginMotion } from './plugin-control-motion-checks.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/plugin-control-'))
const home = join(root, 'home'), probe = join(root, 'probe'), file = join(root, 'desktop-plugins.json')
await mkdir(home); await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/plugin-smoke', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@dsh-desktop/plugin-control'] } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/plugin-smoke',factory:()=>({inject:['remote','remote.desktopPlugins','slots','modules','loader','configForms'],apply(ctx){window.__PLUGIN_SMOKE__=ctx}})})`)
const original = await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')
const patch = original.replace(/name: \.\/([^\s]+)/g, (_, name) => 'name: ' + pathToFileURL(resolve('dsh-plugin', name)).href)
  + '\n- insert:\n    - id: plugin-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml'), bootPath = join(root, 'boot.json')
await writeFile(patchPath, patch)
const catalog = JSON.parse(await readFile('dsh-plugin/plugin-control/catalog.json', 'utf8'))
const core = JSON.parse(await readFile('dsh-plugin/plugin-control/core.json', 'utf8'))
await writeFile(file, JSON.stringify({ version: 1, enabled: Object.fromEntries([...core, 'desktop-appearance'].map(id => [id, false])) }))
let child, browser, page, output = ''
async function start() {
  let saved = {}
  try { saved = JSON.parse(await readFile(file, 'utf8')).enabled } catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeFile(bootPath, JSON.stringify(bootPatches(catalog, core, saved)))
  output = ''
  child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--patch', bootPath, '--no-open', '--port', '0'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_PLUGINS_FILE: file, DSH_DESKTOP_CHANGES_DIR: join(root, 'changes') },
  })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  for (let i = 0; i < 300; i++) {
    const url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) return url
    if (child.exitCode !== null) throw Error(output)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error('Boot timeout: ' + output)
}
function stop() {
  if (child && child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  child = null
}
try {
  const url = await start()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  for (const name of ['继续', '稍后配置']) {
    // A delayed onboarding prompt can land behind settings. Dismiss only these
    // incidental, enabled buttons through their handlers; plugin switches below
    // still use real pointer input and must pass the browser's hit testing.
    await page.addLocatorHandler(page.getByRole('button', { name, exact: true }).and(page.locator(':enabled')),
      button => button.evaluate(element => element.click()))
  }
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.__PLUGIN_SMOKE__?.remote.desktopPlugins), undefined, { timeout: 40000 })
  const call = (method, ...args) => page.evaluate(async ([method, args]) => {
    const result = await window.__PLUGIN_SMOKE__.remote.desktopPlugins[method](...args)
    if (!result.ok) throw Error(result.error.message)
    return result.value
  }, [method, args])
  let state = await call('status')
  assert.equal(state.restartRequired, false)
  async function openSettings() {
    await page.locator('button[aria-haspopup="dialog"]').first().evaluate(button => button.click())
    await page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: '插件', exact: true }).click()
    await page.getByRole('tab', { name: '插件', exact: true }).click()
    await page.locator('.dshPlugins__card').last().waitFor()
  }
  // The desktop title bar delegates to this trigger, hidden in collapsed mode.
  await openSettings()
  assert.equal(await page.locator('.dshPlugins__card').count(), 4)
  assert.equal(state.rows.find(row => row.id === 'desktop-ui').enabled, true, 'old appearance-entry switch does not override the merged feature')
  for (const id of core) await assert.rejects(call('setEnabled', id, false))
  const disclosure = page.getByRole('button', { name: '桌面通知详情', exact: true })
  assert.equal(await page.locator('.dshPlugins input[type=checkbox]').count(), 0)
  await disclosure.press('Enter')
  await page.waitForFunction(() => document.querySelector('[data-plugin-id="desktop-notify"] .dshPlugins__disclosure')?.getAttribute('aria-expanded') === 'true')
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'true')
  await page.locator('#dsh-plugin-details-desktop-notify').waitFor()
  await disclosure.press('Space')
  await page.waitForFunction(() => document.querySelector('[data-plugin-id="desktop-notify"] .dshPlugins__disclosure')?.getAttribute('aria-expanded') === 'false')
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false')
  await page.screenshot({ path: join(root, 'settings.png') })
  const clientIds = {
    'desktop-appearance': '@dsh-desktop/appearance',
    'desktop-remote-control': '@dsh-desktop/remote-control',
    'desktop-ui-state': '@dsh-desktop/ui-state',
  }
  async function clientState(id, enabled) {
    if (!clientIds[id]) return
    await page.waitForFunction(([id, enabled]) => {
      const ctx = window.__PLUGIN_SMOKE__
      const entry = [...ctx.loader.entries()].find(entry => entry.options.name === id)
      const state = ctx.modules.entries.state.getSnapshot()
      return !state.syncing && !state.failures.length && (enabled ? entry?.fiber?.state === 2 : !entry || entry.disabled)
    }, [clientIds[id], enabled])
  }
  for (const id of Object.keys(clientIds)) await clientState(id, true)
  async function switchPlugin(id, enabled) {
    const input = page.locator('[data-plugin-id="' + id + '"]').getByRole('switch')
    assert.notEqual(await input.getAttribute('aria-checked'), String(enabled))
    // The controlled input commits its value only after the host saves it.
    await input.click()
    await page.waitForFunction(([id, enabled]) => {
      const input = document.querySelector('[data-plugin-id="' + id + '"] [role=switch]')
      return input?.getAttribute('aria-checked') === String(enabled) && !input.disabled
    }, [id, enabled])
    return call('status')
  }
  const layouts = []
  async function checkRestartCard(label) {
    await page.locator('.dshPlugins__restart').scrollIntoViewIfNeeded()
    const layout = await page.evaluate(() => {
      const card = document.querySelector('.dshPlugins__restart'), rect = card.getBoundingClientRect()
      const settings = document.querySelector('[data-shortcut-modal="settings"]')
      return {
        card: rect.toJSON(), rootTop: document.getElementById('root').getBoundingClientRect().top,
        insideDialog: settings.contains(card), position: getComputedStyle(card).position,
        introBottom: document.querySelector('.dshPlugins__intro').getBoundingClientRect().bottom,
        listTop: document.querySelector('.dshPlugins__cards').getBoundingClientRect().top,
        unobstructed: card.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)),
        width: innerWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        oldBanner: Boolean(document.querySelector('.dshPlugins__banner')),
      }
    })
    assert.ok(layout.insideDialog && layout.unobstructed, label + ': visible inside settings')
    assert.equal(layout.position, 'static')
    assert.equal(layout.oldBanner, false)
    assert.equal(layout.rootTop, beforeBannerTop, label + ': main page stays in place')
    assert.ok(layout.introBottom <= layout.card.top && layout.listTop >= layout.card.bottom, label + ': card between intro and plugins')
    assert.ok(layout.card.right <= layout.width && !layout.horizontalOverflow, label + ': no horizontal overflow')
    layouts.push({ label, ...layout })
  }
  async function checkNoCard() {
    await page.locator('.dshPlugins__restart').waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-dsh-plugin-restart')), false)
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-plugin-banner-height')), '')
  }
  for (const row of catalog.filter(row => row.hot)) {
    state = await switchPlugin(row.id, false)
    assert.equal(state.rows.find(r => r.id === row.id).hot, true, 'real runtime supports hot reload')
    assert.equal(state.rows.find(r => r.id === row.id).error, null)
    assert.equal(state.rows.find(r => r.id === row.id).phase, 'disabled')
    assert.equal(state.restartRequired, false)
    await clientState(row.id, false)
    const section = { 'desktop-appearance': '外观', 'desktop-remote-control': '远程控制' }[row.id]
    if (section) await page.getByRole('button', { name: section, exact: true }).waitFor({ state: 'hidden' })
    state = await switchPlugin(row.id, true)
    assert.equal(state.rows.find(r => r.id === row.id).error, null)
    assert.equal(state.rows.find(r => r.id === row.id).phase, 'active')
    await clientState(row.id, true)
    if (section) await page.getByRole('button', { name: section, exact: true }).waitFor()
  }
  console.log('PASS: settings switches and real host/client hot activation and disposal')
  await checkPluginMotion(page, root)
  let beforeBannerTop = await page.locator('#root').evaluate(element => element.getBoundingClientRect().top)
  state = await switchPlugin('desktop-ui', false)
  assert.equal(state.restartRequired, true)
  await page.locator('.dshPlugins__restart').waitFor()
  await checkRestartCard('desktop')
  await page.screenshot({ path: join(root, 'restart-card.png') })
  for (const row of catalog.filter(row => !row.hot && row.id !== 'desktop-ui')) await switchPlugin(row.id, false)
  for (const row of catalog.filter(row => !row.hot)) assert.ok((await page.locator('.dshPlugins__restart').innerText()).includes(row.label))
  for (const dark of [false, true]) for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 840 })
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
    await checkRestartCard((dark ? 'dark' : 'light') + '-' + width)
    await page.screenshot({ path: join(root, 'restart-card-' + (dark ? 'dark' : 'light') + '-' + width + '.png') })
  }
  for (const row of catalog.filter(row => !row.hot && row.id !== 'desktop-ui')) {
    assert.equal((await switchPlugin(row.id, true)).restartRequired, true, 'one remaining change must keep the banner')
  }
  await page.setViewportSize({ width: 1280, height: 840 })
  await checkRestartCard('desktop after resize')
  state = await switchPlugin('desktop-ui', true)
  assert.equal(state.restartRequired, false)
  await checkNoCard()
  assert.equal(await page.locator('#root').evaluate(element => element.getBoundingClientRect().top), beforeBannerTop)
  await call('setEnabled', 'desktop-ui', false)
  await call('setEnabled', 'desktop-notify', false)
  stop()
  await page.goto(await start())
  await page.waitForFunction(() => Boolean(window.__PLUGIN_SMOKE__?.remote.desktopPlugins), undefined, { timeout: 40000 })
  state = await call('status')
  assert.equal(state.restartRequired, false)
  for (const id of ['desktop-ui', 'desktop-notify']) {
    assert.equal(state.rows.find(row => row.id === id).running, false)
    assert.equal(state.rows.find(row => row.id === id).phase, 'disabled')
  }
  await openSettings()
  await clientState('desktop-appearance', false)
  await clientState('desktop-ui-state', true)
  await clientState('desktop-remote-control', true)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).enabled, { 'desktop-ui': false, 'desktop-sidebar-changes': true, 'desktop-sidebar-terminal': true, 'desktop-notify': false })
  assert.equal((await call('setEnabled', 'desktop-ui', true)).restartRequired, true)
  await page.locator('.dshPlugins__restart').waitFor()
  // Disabling the appearance overlay changes the baseline layout independently.
  beforeBannerTop = await page.locator('#root').evaluate(element => element.getBoundingClientRect().top)
  await checkRestartCard('without optional appearance overlay')
  await page.screenshot({ path: join(root, 'without-overlay.png') })
  assert.equal((await call('setEnabled', 'desktop-ui', false)).restartRequired, false)
  await checkNoCard()
  await writeFile(join(root, 'card-layouts.json'), JSON.stringify(layouts, null, 2))
  assert.deepEqual(pageErrors, [])
  console.log('PASS: all hot switches, restart card, reverting switches, restart persistence', root)
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
    await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText().catch(() => '') + '\n' + error.stack)
  }
  console.error('Evidence:', root)
  throw error
} finally {
  await writeFile(join(root, 'host.log'), output)
  await browser?.close(); stop()
}

