/** Real DSH settings, Forge activation, desktop previews, and persisted visibility.
 * DSH_DESKTOP_DSH_BIN selects the runtime; Forge checks run where it is shipped.
 * Uses an isolated profile and offline model, without touching the user's app.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { handleOnboarding, openDshSettings, offlineModelPatch } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/changes-smoke-'))
const home = join(root, 'home'), probe = join(root, 'probe'), workspace = join(root, 'workspace')
await Promise.all([home, probe, workspace].map(path => mkdir(path)))
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/changes-visibility-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' },
  dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-plugin-manager', '@dsh-desktop/sidebar-changes'] } } }))
await writeFile(join(probe, 'index.js'), `import { writeFile } from 'node:fs/promises'
import { runtimeImport } from ${JSON.stringify(pathToFileURL(resolve('dsh-plugin/runtime-import.mjs')).href)}
export const inject = ['sessions', 'sessionPersistence']
export async function apply(ctx) {
  const { createUserMessage } = await runtimeImport('@deepseek-ai/dsh-llm')
  const session = ctx.sessions.create(undefined, { meta: { cwd: ${JSON.stringify(workspace)} } })
  session.append('turn/start', { turn: 0 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Isolated changes visibility fixture' }] }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
  await ctx.sessions.flush(session)
  await writeFile(${JSON.stringify(join(root, 'fixture-session.json'))}, JSON.stringify({ sessionId: session.id }))
}\n`)
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({ id: '@dsh-desktop/changes-visibility-smoke', factory: () => ({
  inject: ['configForms', 'slots', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.pluginManager', 'sessions', 'workspaces', 'uiWorkspace'],
  apply(ctx) { window.__CHANGES_VISIBILITY__ = ctx },
}) })\n`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g,
  (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + offlineModelPatch + '\n- insert:\n    - id: changes-visibility-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'patch.yml')
await writeFile(patchPath, patch)

let child, browser, output = '', sessionId
const report = { runtime: JSON.parse(await readFile(resolve(dshBin, '../../package.json'), 'utf8')).version, checks: [] }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function start() {
  output = ''
  child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
    cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_CHANGES_DIR: join(root, 'changes'),
      DSH_UI_SMOKE_KEY: 'offline-fixture', DEEPSEEK_API_KEY: 'offline-fixture' },
  })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  for (let i = 0; i < 400; i++) {
    const url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) return url
    if (child.exitCode !== null) throw Error(output.slice(-6000))
    await sleep(100)
  }
  throw Error('DSH startup timed out: ' + output.slice(-6000))
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const pid = child.pid, stopped = new Promise(resolve => child.once('exit', resolve))
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }
  catch (error) {
    try { process.kill(pid, 0) }
    catch (probe) { if (probe.code === 'ESRCH') { await stopped; child = null; return } }
    throw error
  }
  await stopped; child = null
}
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }
async function ready(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => window.__CHANGES_VISIBILITY__?.configForms.get('desktop-changes').getSnapshot().status === 'ready', undefined, { timeout: 40000 })
  sessionId = JSON.parse(await readFile(join(root, 'fixture-session.json'), 'utf8')).sessionId
  await page.waitForFunction(id => window.__CHANGES_VISIBILITY__.sessions.list.getSnapshot().byId[id]?.blank === false, sessionId)
  await page.evaluate(async ({ sessionId, workspace }) => {
    const ctx = window.__CHANGES_VISIBILITY__
    await ctx.workspaces.create({ path: workspace }); await ctx.uiWorkspace.openSession(sessionId)
  }, { sessionId, workspace })
}
async function desktopVisible(page, enabled) {
  await page.waitForFunction(enabled => Boolean(window.__CHANGES_VISIBILITY__.sidebarRightTabs.get('desktop-changes')) === enabled, enabled)
  assert.equal(await page.evaluate(() => window.__CHANGES_VISIBILITY__.sidebarRightTabs.guide().some(entry => entry.kind === 'desktop-changes')), enabled)
}
const switchOf = page => page.locator('[data-dsh-changes-setting]').getByRole('switch', { name: '更改功能', exact: true })
async function settings(page) {
  if (!(await page.locator('[data-dsh-changes-setting]').count())) {
    await openDshSettings(page)
    await page.getByRole('button', { name: /^(通用设置|General)$/, exact: true }).click()
  }
  await switchOf(page).waitFor()
  await switchOf(page).scrollIntoViewIfNeeded()
}
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await handleOnboarding(page)
  await ready(page, await start())
  await desktopVisible(page, true)
  await settings(page); assert.equal(await switchOf(page).isChecked(), true)
  pass('General shows the desktop changes toggle; disabled Forge keeps the original default')
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__CHANGES_VISIBILITY__.sidebarRight.openTab('desktop-changes'))
  await page.locator('[data-dsh-changes]').waitFor()
  const bundles = await page.evaluate(async () => {
    const result = await window.__CHANGES_VISIBILITY__.remote.pluginManager.listBundles()
    if (!result.ok) throw Error(result.error.message)
    return result.value
  })
  if (bundles.some(bundle => bundle.name === '@deepseek-ai/dsh-experimental-forge-bundle')) {
    async function forge(enabled) {
      const result = await page.evaluate(async enabled => {
        const result = await window.__CHANGES_VISIBILITY__.remote.pluginManager.setBundleEnabled('@deepseek-ai/dsh-experimental-forge-bundle', enabled)
        if (!result.ok) throw Error(result.error.message)
        return result.value
      }, enabled)
      assert.ok(['applied', 'restart-required'].includes(result.application), JSON.stringify(result))
      if (result.application === 'restart-required') { await stop(); await ready(page, await start()) }
      await page.waitForFunction(enabled => window.__CHANGES_VISIBILITY__.slots.entriesOfSlot('sidebar.right.pane.tab')
        .some(entry => entry.options.key === '@deepseek-ai/dsh-experimental-client-ui-forge') === enabled, enabled, { timeout: 40000 })
    }
    await forge(true); await desktopVisible(page, false)
    assert.equal(await page.evaluate(() => window.__CHANGES_VISIBILITY__.sidebarRight.openTabs.getSnapshot().filter(tab => tab.kind === 'desktop-changes').length), 0)
    assert.equal(await page.evaluate(() => Boolean(window.__CHANGES_VISIBILITY__.sidebarRightTabs.get('forge-panel'))), true)
    await settings(page); assert.equal(await switchOf(page).isChecked(), false)
    await page.screenshot({ path: join(root, 'general-forge-enabled.png') })
    pass('enabling real Forge removes only desktop guides/types/previews and defaults the switch to off')
    await page.keyboard.press('Escape')
    await forge(false); await desktopVisible(page, true)
    await forge(true); await desktopVisible(page, false)
    await ready(page, page.url())
    await desktopVisible(page, false)
    pass('automatic defaults follow hot activation and remain hidden after page reload')
  } else pass('this runtime does not ship Forge; desktop changes remain available')

  await settings(page)
  if (!(await switchOf(page).isChecked())) await switchOf(page).click()
  await desktopVisible(page, true)
  assert.equal(await page.locator('[data-dsh-changes-setting]').count(), 1, 'the toggle keeps General settings open')
  await switchOf(page).click(); await desktopVisible(page, false)
  assert.equal(await switchOf(page).isChecked(), false)
  await ready(page, page.url())
  await desktopVisible(page, false)
  await settings(page); assert.equal(await switchOf(page).isChecked(), false)
  await switchOf(page).click(); await desktopVisible(page, true)
  await stop(); await ready(page, await start()); await desktopVisible(page, true)
  await settings(page); assert.equal(await switchOf(page).isChecked(), true)
  assert.equal(JSON.parse(await readFile(join(home, 'desktop-settings.json'), 'utf8')).namespaces['desktop-changes'].enabled, true)
  await page.screenshot({ path: join(root, 'general-manual-enabled.png') })
  pass('manual choices apply immediately and persist across page reload and backend restart')
  assert.deepEqual(errors, [])
  pass('no browser runtime errors')
} catch (error) {
  report.error = error.stack
  report.output = output.slice(-8000)
  const page = browser?.contexts()[0]?.pages()[0]
  if (page) {
    report.page = await page.locator('body').innerText().catch(() => '')
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  }
  throw error
} finally {
  await browser?.close(); await stop()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Evidence: ' + join(root, 'report.json'))
}
