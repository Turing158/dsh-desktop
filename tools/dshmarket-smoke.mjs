// Install the real community package through the settings button in a disposable profile.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootPatches } from '../dsh-plugin/plugin-control/model.mjs'
import { openDshSettings } from './dsh-ui-helpers.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/dshmarket-'))
const home = join(root, 'home'), probe = join(root, 'probe'), builtinFile = join(root, 'desktop-plugins.json')
await mkdir(home); await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/market-smoke', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@dsh-desktop/plugin-control'] } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/market-smoke',factory:()=>({inject:['remote','remote.desktopPlugins','modules'],apply(ctx){window.__MARKET_SMOKE__=ctx}})})`)
const patchPath = join(root, 'desktop.patch.yml'), bootPath = join(root, 'boot.json')
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, name) => 'name: ' + pathToFileURL(resolve('dsh-plugin', name)).href)
  + '\n- insert:\n    - id: market-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href
  + '\n- id: ui-settings-models\n  disabled: true\n'
await writeFile(patchPath, patch)
const catalog = JSON.parse(await readFile('dsh-plugin/plugin-control/catalog.json', 'utf8'))
const core = JSON.parse(await readFile('dsh-plugin/plugin-control/core.json', 'utf8'))
await writeFile(builtinFile, JSON.stringify({ version: 1, enabled: {} }))
await writeFile(bootPath, JSON.stringify(bootPatches(catalog, core, {})))
const env = { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_PLUGINS_FILE: builtinFile, DSH_DESKTOP_CHANGES_DIR: join(root, 'changes') }
execFileSync(process.execPath, [resolve('dsh-plugin/plugin-control/prepare-boot.mjs'), patchPath, bootPath], { env, windowsHide: true })
let child, browser, output = '', page
const report = { root, checks: [] }, pageErrors = []
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
const call = (method, ...args) => page.evaluate(async ([method, args]) => {
  const result = await window.__MARKET_SMOKE__.remote.desktopPlugins[method](...args)
  if (!result.ok) throw Error(result.error.message)
  return result.value
}, [method, args])
async function settings() {
  await openDshSettings(page)
  await page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: '插件', exact: true }).click()
  await page.getByRole('tab', { name: '内置插件', exact: true }).click()
}
try {
  child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--patch', bootPath, '--no-open', '--port', '0'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  let url
  for (let i = 0; i < 450; i++) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error(output)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(url, 'DSH starts')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on('pageerror', error => pageErrors.push(error.message))
  for (const name of ['继续', '稍后配置']) await page.addLocatorHandler(page.getByRole('button', { name, exact: true }).and(page.locator(':enabled')), button => button.evaluate(element => element.click()))
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.__MARKET_SMOKE__?.remote.desktopPlugins), undefined, { timeout: 45000 })
  await settings()
  assert.equal((await call('status')).marketplace.installed, false)
  const install = page.getByRole('button', { name: '安装插件市场', exact: true })
  await install.waitFor()
  assert.equal(await install.evaluate(button => {
    const header = button.closest('.dshPlugins__marketplaceHeader')
    const tabs = document.querySelector('[role="tab"][id$="-tab-desktop-builtins"]').closest('[role="tablist"]')
    return !button.closest('[role="tabpanel"]') && header?.nextSibling === tabs
  }), true, 'the prompt belongs to the shared page above the tab bar')
  for (const name of ['插件列表', '内置插件', '插件列表']) {
    await page.getByRole('tab', { name, exact: true }).click()
    assert.equal(await install.isVisible(), true)
    assert.equal(await page.locator('.dshPlugins__marketplaceHeader').count(), 1)
  }
  await page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: '通用设置', exact: true }).click()
  assert.equal(await install.isVisible(), false)
  await settings()
  await install.waitFor()
  await page.keyboard.press('Escape')
  await page.locator('[data-shortcut-modal="settings"]').waitFor({ state: 'hidden' })
  await settings()
  await install.waitFor()
  assert.equal(await page.locator('.dshPlugins__marketplaceHeader').count(), 1)
  pass('shared header stays above both tabs and remounts once when reopening settings')
  await page.screenshot({ path: join(root, 'before.png') })
  await page.setViewportSize({ width: 440, height: 850 })
  await page.screenshot({ path: join(root, 'narrow.png') })
  assert.equal(await page.locator('.dshPlugins__marketplace').evaluate(el => el.scrollWidth <= el.clientWidth), true)
  await page.setViewportSize({ width: 1280, height: 900 })
  await install.click()
  await page.getByRole('button', { name: '正在安装…', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '正在安装…', exact: true }).isDisabled(), true)
  pass('settings offers installation and prevents repeated clicks; narrow layout fits')
  // A second client joins the active operation instead of starting another installation.
  console.log('Installing dshmarket in ' + home)
  const result = await call('installMarketplace')
  await writeFile(join(root, 'install-result.json'), JSON.stringify(result, null, 2))
  assert.equal(result.marketplace.error, '')
  assert.equal(result.marketplace.installed, true)
  await page.locator('.dshPlugins__marketplace').waitFor({ state: 'hidden', timeout: 15000 })
  pass('real dshmarket installation succeeds and removes the install prompt')
  await page.reload()
  await page.waitForFunction(() => Boolean(window.__MARKET_SMOKE__?.remote.desktopPlugins), undefined, { timeout: 45000 })
  await settings()
  assert.equal(await page.getByRole('button', { name: '安装插件市场', exact: true }).count(), 0)
  const marketNav = page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: '插件市场', exact: true })
  await marketNav.click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: join(root, 'market.png') })
  const sync = await page.evaluate(() => window.__MARKET_SMOKE__.modules.entries.state.getSnapshot())
  assert.deepEqual(sync.failures, [])
  assert.deepEqual(pageErrors, [])
  pass('reload keeps the prompt hidden and the community marketplace settings page opens')
} catch (error) {
  report.error = error.stack
  if (page) await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await browser?.close()
  if (child && child.exitCode === null) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }
    catch { try { process.kill(child.pid, 0); throw Error('Failed to stop test DSH') } catch (e) { if (e.code !== 'ESRCH') throw e } }
  }
  await writeFile(join(root, 'host.log'), output)
  await writeFile(join(root, 'report.json'), JSON.stringify({ ...report, pageErrors }, null, 2))
  console.log(root)
}
