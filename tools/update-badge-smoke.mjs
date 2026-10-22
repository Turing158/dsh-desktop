/** Real DSH sidebar + update controller, with isolated state and mocked native installation. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { handleOnboarding, dismissInitialWelcome, offlineModelPatch } from './dsh-ui-helpers.mjs'
import { checkUpdateBadgeMotion } from './update-badge-motion-check.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = await mkdtemp(resolve('src-tauri/target/update-badge-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home); await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/update-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/update-smoke',factory:()=>({
  inject:['sessions','theme','layout','configForms'],apply(ctx){window.updateContext=ctx}
})})`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + offlineModelPatch + '\n- insert:\n    - id: desktop-update-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_UI_SMOKE_KEY: 'mock-key' },
})
let output = '', browser, page
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const report = { root, checks: [], errors: [] }
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }
try {
  let url
  for (let i = 0; i < 300; i++) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error(output.slice(-2000))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(url, 'isolated backend starts')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale: 'zh-CN' })
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('slot entry crashed')) report.errors.push(message.text()) })
  await handleOnboarding(page)
  await page.addInitScript(() => {
    window.updateCalls = []
    window.updateVersions = { current: '0.1.9', latest: '0.2.0', preview: '0.3.0-alpha.1', stableUpdateAvailable: true }
    window.__DSH_UI_STATE__ = {
      prepareRemoteApply: async () => { window.updateCalls.push('capture'); return { page: { kind: 'dsh' } } },
      finishRemoteApply: () => window.updateCalls.push('unfreeze'),
      registerProvider: () => () => {},
    }
    window.__TAURI__ = { app: { getVersion: async () => '0.1.3' }, core: { invoke: async command => {
      window.updateCalls.push(command)
      if (command === 'check_dsh_update') return window.updateVersions
      if (command === 'check_desktop_update') return { current: '0.1.3', release: null }
      if (command === 'remote_status') return { frontendVersion: '0.1.9' }
      if (command === 'install_dsh_update') return new Promise((resolve, reject) => { window.finishUpdate = { resolve, reject } })
      return false
    } } }
  })
  await page.goto(url)
  await page.waitForFunction(() => window.updateContext && window.__DSH_DSH_UPDATE__)
  await dismissInitialWelcome(page)
  if (await page.locator('[data-shortcut-modal="settings"]').count()) await page.keyboard.press('Escape')
  const badge = page.locator('.dshUpdateBadge')
  await badge.waitFor()
  assert.equal(await page.getByRole('dialog', { name: '检测更新', exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => window.updateCalls.filter(value => value === 'check_dsh_update').length), 1)
  assert.equal(await badge.getAttribute('aria-label'), '更新到 dsh 稳定版 0.2.0')
  const bounds = await badge.boundingBox(), settings = await page.locator('.dshSidebarSettings__button').boundingBox()
  assert.ok(bounds.x + bounds.width <= settings.x, 'badge precedes settings without overlap')
  pass('silent startup check displays a stable update badge before settings')

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.updateContext.theme.setTheme(theme), theme)
    await page.waitForTimeout(180)
    await page.screenshot({ path: join(root, theme + '.png') })
    await badge.locator('..').screenshot({ path: join(root, theme + '-badge.png') })
  }
  await page.evaluate(() => window.updateContext.layout.toggleSidebar())
  await page.waitForFunction(() => document.querySelector('.dshUpdateBadge')?.dataset.compact === 'true')
  assert.ok((await badge.boundingBox()).width <= 36)
  await page.screenshot({ path: join(root, 'collapsed.png') })
  await page.evaluate(() => window.updateContext.layout.toggleSidebar())
  await page.waitForFunction(() => document.querySelector('.dshUpdateBadge')?.dataset.compact === 'false')
  pass('light, dark and collapsed sidebar layouts render')

  await checkUpdateBadgeMotion(page)
  pass('hover, content crossfade, width and spinner follow on/off/system, including interrupted transitions')

  await page.evaluate(() => {
    window.backgroundRunning = true
    const list = window.updateContext.sessions.list, read = list.getSnapshot.bind(list)
    let previous, running, cached
    list.getSnapshot = () => {
      const state = read()
      if (previous !== state || running !== window.backgroundRunning) {
        previous = state; running = window.backgroundRunning
        cached = { ...state, byId: { ...state.byId, 'background-fixture': { running } } }
      }
      return cached
    }
  })
  await badge.click()
  await page.waitForFunction(() => document.querySelector('.dshUpdateBadge')?.dataset.state === 'waiting')
  assert.equal(await page.evaluate(() => window.updateCalls.includes('capture')), false)
  const spinner = badge.locator('.dshUpdateBadge__spinner')
  const before = await spinner.evaluate(node => getComputedStyle(node).transform)
  await page.waitForTimeout(200)
  assert.notEqual(await spinner.evaluate(node => getComputedStyle(node).transform), before)
  await page.screenshot({ path: join(root, 'waiting.png') })
  // The same badge opens progress and its cancellation action while waiting.
  await badge.click()
  const dialog = page.getByRole('dialog', { name: '检测更新', exact: true })
  await dialog.getByRole('button', { name: '取消等待', exact: true }).click()
  await dialog.getByRole('button', { name: '关闭窗口', exact: true }).click()
  assert.equal(await badge.getAttribute('data-state'), 'available')
  await badge.click()
  await page.evaluate(() => { window.backgroundRunning = false })
  await page.waitForFunction(() => window.updateCalls.includes('install_dsh_update'))
  assert.equal(await badge.getAttribute('data-state'), 'installing')
  assert.equal(await badge.isDisabled(), true)
  assert.equal(await page.evaluate(() => window.updateCalls.filter(value => value === 'install_dsh_update').length), 1)
  await page.screenshot({ path: join(root, 'installing.png') })
  pass('click animates, waits without capture, supports cancellation, and installs once after idle')

  await page.evaluate(() => window.finishUpdate.reject('测试安装失败'))
  await page.waitForFunction(() => document.querySelector('.dshUpdateBadge')?.dataset.state === 'error')
  assert.equal(await page.evaluate(() => window.updateCalls.at(-1)), 'unfreeze')
  await badge.click()
  await dialog.getByText('测试安装失败', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '关闭窗口', exact: true }).click()
  await page.evaluate(() => { window.updateVersions.stableUpdateAvailable = false; window.__DSH_DSH_UPDATE__.show() })
  await dialog.getByRole('button', { name: '重新检测', exact: true }).click()
  await badge.waitFor({ state: 'detached' })
  pass('failure is recoverable; no badge is shown when latest is not newer')
  assert.deepEqual(report.errors, [])
  assert.match(output, /__DSH_UPDATE_ACTIVITY__ \{"running":false\}/, 'host publishes initial idle activity independently of the browser')
} catch (error) {
  report.error = error.stack
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(join(root, 'backend.log'), output)
  await browser?.close()
  child.kill()
  console.log('Report: ' + root)
}
