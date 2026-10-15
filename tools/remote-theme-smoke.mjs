/** Three independent device contexts over one real DSH backend. No model calls.
 * The native context uses the desktop boot marker; OS themes use browser media
 * emulation. Requires the bundled Playwright runtime and Edge/WebKit. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium, webkit } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = resolve(process.env.DSH_DESKTOP_DSH_BIN || 'pack/portable/runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/remote-theme-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home); await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'ui-theme:\n  preference: dark\ndesktop-appearance:\n  animation: off\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/theme-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({ id: '@dsh-desktop/theme-smoke',
  factory: () => ({ inject: ['theme', 'configForms', 'slots', 'sessions', 'workspaces', 'uiWorkspace'],
    apply(ctx) { window.__THEME_SMOKE__ = ctx } }) })`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: desktop-theme-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin },
})
let output = '', edge, safari, page
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const report = { checks: [] }, errors = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }

async function expectTheme(target, preference, scheme) {
  page = target
  await target.waitForFunction(({ preference, scheme }) => {
    const snapshot = window.__THEME_SMOKE__?.theme.getTheme()
    return snapshot?.preference === preference && snapshot.active.colorScheme === scheme
      && document.body.hasAttribute('data-ds-dark-theme') === (scheme === 'dark')
      && document.documentElement.style.colorScheme === scheme
  }, { preference, scheme })
}
async function ready(target) {
  page = target
  await target.waitForFunction(() => window.__THEME_SMOKE__?.configForms.get('ui-theme').getSnapshot().status === 'ready')
  await target.locator('.dshTb').waitFor()
}
async function watch(context) {
  const target = await context.newPage()
  target.on('pageerror', error => errors.push(error.message))
  target.on('console', message => { if (message.type() === 'error' && message.text().includes('slot entry crashed')) errors.push(message.text()) })
  for (const name of ['继续', '我知道了', '稍后配置']) {
    await target.addLocatorHandler(target.getByRole('button', { name, exact: true }).and(target.locator(':enabled')), button => button.click())
  }
  return target
}

try {
  let url
  for (let i = 0; i < 300; i++) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error(output.slice(-2000))
    await sleep(100)
  }
  assert.ok(url, 'DSH started')
  edge = await chromium.launch({ channel: 'msedge', headless: true })
  safari = await webkit.launch({ headless: true })
  const native = await edge.newContext({ colorScheme: 'dark', viewport: { width: 1280, height: 900 } })
  await native.addInitScript(() => { window.__DSH_DESKTOP_BOOT_HOST__ = true })
  const deviceA = await edge.newContext({ colorScheme: 'light', viewport: { width: 1000, height: 800 } })
  const deviceB = await safari.newContext({ colorScheme: 'dark', viewport: { width: 1000, height: 800 } })
  const desktop = await watch(native), a = await watch(deviceA), b = await watch(deviceB)
  await desktop.goto(url); await ready(desktop)
  assert.equal(await desktop.evaluate(() => Boolean(window.__DSH_REMOTE_THEME__)), false)
  await expectTheme(desktop, 'dark', 'dark')
  await a.goto(url); await ready(a)
  await b.goto(url); await ready(b)
  await expectTheme(a, 'system', 'light'); await expectTheme(b, 'system', 'dark')
  pass('new remote browsers use their own system theme, independent of the desktop preference')

  await a.locator('.dshTb__theme').click()
  await expectTheme(a, 'light', 'light')
  await a.locator('.dshTb__theme').click()
  await expectTheme(a, 'dark', 'dark')
  await expectTheme(b, 'system', 'dark')
  assert.equal(await desktop.evaluate(() => window.__THEME_SMOKE__.configForms.get('ui-theme').getSnapshot().value.preference), 'dark')
  await desktop.evaluate(() => window.__THEME_SMOKE__.configForms.get('ui-theme').set('preference', 'light'))
  await expectTheme(desktop, 'light', 'light'); await expectTheme(a, 'dark', 'dark'); await expectTheme(b, 'system', 'dark')
  pass('remote toolbar and desktop settings do not overwrite one another')

  await a.reload(); await ready(a); await expectTheme(a, 'dark', 'dark')
  await a.emulateMedia({ colorScheme: 'dark' }); await expectTheme(a, 'dark', 'dark')
  await b.emulateMedia({ colorScheme: 'light' }); await expectTheme(b, 'system', 'light')
  await desktop.evaluate(() => window.__THEME_SMOKE__.configForms.get('ui-theme').set('preference', 'system'))
  await expectTheme(desktop, 'system', 'dark'); await expectTheme(b, 'system', 'light')
  await desktop.emulateMedia({ colorScheme: 'light' }); await expectTheme(desktop, 'system', 'light')
  await expectTheme(a, 'dark', 'dark')
  pass('reload restores the local preference; each system theme responds only to its own device')

  const sibling = await watch(deviceA)
  await sibling.goto(url); await ready(sibling); await expectTheme(sibling, 'dark', 'dark')
  await a.locator('.dshTb__theme').click()
  await expectTheme(a, 'system', 'dark'); await expectTheme(sibling, 'system', 'light')
  await a.emulateMedia({ colorScheme: 'light' }); await expectTheme(a, 'system', 'light')
  pass('tabs in the same browser share the saved choice while resolving system locally')

  // Open the real settings section and use its theme buttons as a second entry.
  await a.evaluate(() => document.querySelector('button[aria-haspopup="dialog"]').click())
  await a.getByRole('button', { name: '外观', exact: true }).click()
  const group = a.getByRole('group', { name: '主题', exact: true })
  await group.getByRole('button', { name: '深色', exact: true }).click()
  await expectTheme(a, 'dark', 'dark'); await expectTheme(sibling, 'dark', 'dark')
  await expectTheme(b, 'system', 'light'); await expectTheme(desktop, 'system', 'light')
  assert.equal(await group.getByRole('button', { name: '深色', exact: true }).getAttribute('aria-pressed'), 'true')
  await group.getByRole('button', { name: '跟随系统', exact: true }).click()
  await expectTheme(a, 'system', 'light')
  await a.screenshot({ path: join(root, 'remote-appearance.png') })
  pass('settings page and toolbar share one local preference without changing the desktop')
  assert.deepEqual(errors, [])
} catch (error) {
  report.error = error.stack
  report.errors = errors
  if (page) {
    report.state = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 5000),
      theme: window.__THEME_SMOKE__?.theme.getTheme(), form: window.__THEME_SMOKE__?.configForms.get('ui-theme').getSnapshot() })).catch(() => null)
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  }
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await edge?.close(); await safari?.close()
  if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  console.log('Report: ' + root)
}
