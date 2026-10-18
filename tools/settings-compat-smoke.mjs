/** Real DSH 0.2 boot, legacy import and durable settings round trip in an isolated home.
 * Usage: node tools/settings-compat-smoke.mjs
 * DSH_DESKTOP_DSH_BIN and PLAYWRIGHT_PATH can select another installed runtime.
 * No user profile or running desktop process is touched.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/settings-rc2-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home); await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), `desktop-appearance:
  animation: off
  ui: vanilla
  fontSizeOverride: 10
desktop-terminal-dock:
  layout: { height: 312, collapsed: false }
  profileId: cmd
  position: right
`)
await writeFile(join(probe, 'package.json'), JSON.stringify({
  name: '@dsh-desktop/settings-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' },
  dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings'] } },
}))
await writeFile(join(probe, 'index.js'), 'export function apply() {}\n')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({
  id: '@dsh-desktop/settings-smoke',
  factory: () => ({ inject: ['configForms', 'slots'], apply(ctx) { window.__SETTINGS_SMOKE__ = ctx } }),
})\n`)
const originalPatch = await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')
const patch = originalPatch.replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: desktop-settings-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)

let child, browser, output = ''
const report = { version: JSON.parse(await readFile(resolve(dshBin, '../../package.json'), 'utf8')).version, root, checks: {} }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function start() {
  output = ''
  child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin },
  })
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  for (let i = 0; i < 300; i++) {
    const url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) return url
    if (child.exitCode !== null) throw Error('DSH exited: ' + output.slice(-4000))
    await sleep(100)
  }
  throw Error('DSH did not become ready: ' + output.slice(-4000))
}
function stop() {
  if (!child || child.exitCode !== null) return
  const pid = child.pid
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch (error) {
    // The process can exit between the exitCode check and taskkill.
    try { process.kill(pid, 0) } catch (probe) { if (probe.code === 'ESRCH') { child = null; return } }
    throw error
  }
  child = null
}
async function ready(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => {
    if (document.body.textContent.includes('Failed to load plugins')) throw Error(document.body.textContent)
    const forms = window.__SETTINGS_SMOKE__?.configForms
    return forms && ['desktop-appearance', 'desktop-terminal-dock', 'ui-theme'].every(ns => forms.get(ns).getSnapshot().status === 'ready')
  }, undefined, { timeout: 30000 })
}
async function values(page) {
  return page.evaluate(() => {
    const forms = window.__SETTINGS_SMOKE__.configForms
    return Object.fromEntries(['desktop-appearance', 'desktop-terminal-dock'].map(ns => [ns, forms.get(ns).getSnapshot().value]))
  })
}
try {
  const firstUrl = await start()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  // Desktop preferences persist on the Host. Ordinary browser pages deliberately
  // keep their palette in localStorage, scoped to the current origin instead.
  await page.addInitScript(() => { window.__DSH_DESKTOP_BOOT_HOST__ = true })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await ready(page, firstUrl)
  const imported = await values(page)
  assert.deepEqual(imported, {
    'desktop-appearance': { animation: 'off', ui: 'vanilla', titlebar: 'full', titlebarHover: 'on', fontSizeOverride: 10 },
    'desktop-terminal-dock': { layout: { height: 312, collapsed: false }, profileId: 'cmd', position: 'right' },
  })
  report.checks.legacyImport = imported
  console.log('PASS: real boot and legacy settings import')

  const saved = await page.evaluate(async () => {
    const forms = window.__SETTINGS_SMOKE__.configForms
    const appearance = forms.get('desktop-appearance'), terminal = forms.get('desktop-terminal-dock')
    document.dispatchEvent(new CustomEvent('dsh-desktop:set-ui-mode', { detail: { mode: 'desktop' } }))
    return [await appearance.set('animation', 'on'), await appearance.set('fontSizeOverride', 18),
      await terminal.set('profileId', 'pwsh'), await terminal.set('position', 'bottom'),
      await terminal.set('layout', { height: 340, collapsed: true })]
  })
  assert.deepEqual(saved, [true, true, true, true, true])
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dsh-ui') === 'desktop'
    && document.documentElement.getAttribute('data-dsh-desktop-animation') === 'on'
    && document.body.style.getPropertyValue('--dsh-content-font-size') === '18px')
  const expected = await values(page)
  assert.equal(expected['desktop-appearance'].ui, 'desktop')
  assert.equal(await page.evaluate(() => window.__SETTINGS_SMOKE__.configForms.get('desktop-terminal-dock').set('profileId', 'invalid')), false)
  assert.deepEqual(await values(page), expected)
  report.checks.writesAndRefusal = expected
  console.log('PASS: settings writes, live appearance and refused invalid write')

  assert.equal(await page.evaluate(() => window.__SETTINGS_SMOKE__.configForms.get('ui-theme').set('preference', 'dark')), true)
  report.checks.upstreamSettingsWrite = true

  await page.reload()
  await ready(page, page.url())
  assert.deepEqual(await values(page), expected)
  report.checks.pageReload = true
  console.log('PASS: settings survive page reload')
  await writeFile(join(root, 'first-host.log'), output)
  stop()
  const secondUrl = await start()
  await ready(page, secondUrl)
  assert.deepEqual(await values(page), expected)
  assert.equal(new URL(firstUrl).port === new URL(secondUrl).port, false)
  report.checks.hostRestartOnNewPort = true
  assert.equal(await page.evaluate(() => window.__SETTINGS_SMOKE__.configForms.get('ui-theme').getSnapshot().value.preference), 'dark')
  assert.deepEqual(pageErrors, [])
  report.checks.noPageErrors = true
  await page.screenshot({ path: join(root, 'loaded.png'), fullPage: true })
  console.log('PASS: settings survive host restart and origin change; no browser errors')
} catch (error) {
  report.error = error.stack
  throw error
} finally {
  await writeFile(join(root, 'last-host.log'), output)
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  stop()
  console.log('Evidence: ' + join(root, 'report.json'))
}
