// Real DSH + browser verification in a disposable home. Never uses user profiles.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootPatches } from '../dsh-plugin/plugin-control/model.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/profile-plugin-control-'))
const home = join(root, 'home'), probe = join(root, 'probe'), builtinFile = join(root, 'desktop-plugins.json'), lifecycle = join(root, 'lifecycle.log')
await mkdir(home); await mkdir(probe); await mkdir(join(root, 'cold'))
await writeFile(join(root, 'cold/package.json'), JSON.stringify({ name: 'profile-cold-probe', type: 'module' }))
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/profile-smoke', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@dsh-desktop/plugin-control'] } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/profile-smoke',factory:()=>({inject:['remote','remote.desktopPlugins','modules','loader','sidebarRightTabs','sidebarRight','sessions','workspaces','uiWorkspace'],apply(ctx){window.__PROFILE_SMOKE__=ctx}})})`)
await writeFile(join(root, 'cold/index.mjs'), `import { appendFileSync } from 'node:fs';export function apply(ctx){appendFileSync(${JSON.stringify(lifecycle)},'start\\n');ctx.on('dispose',()=>appendFileSync(${JSON.stringify(lifecycle)},'stop\\n'))}`)
const patchPath = join(root, 'desktop.patch.yml'), bootPath = join(root, 'boot.json')
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, name) => 'name: ' + pathToFileURL(resolve('dsh-plugin', name)).href)
  + '\n- insert:\n    - id: profile-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href
  + '\n    - id: profile-cold-probe\n      name: ' + pathToFileURL(join(root, 'cold/index.mjs')).href + '\n'
// Suppress first-run model setup in this plugin-only fixture.
await writeFile(patchPath, patch + '\n- id: ui-settings-models\n  disabled: true\n')
const catalog = JSON.parse(await readFile('dsh-plugin/plugin-control/catalog.json', 'utf8'))
const core = JSON.parse(await readFile('dsh-plugin/plugin-control/core.json', 'utf8'))
await writeFile(builtinFile, JSON.stringify({ version: 1, enabled: {} }))
const env = { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_PLUGINS_FILE: builtinFile, DSH_DESKTOP_CHANGES_DIR: join(root, 'changes') }
let child, browser, page, output = '', generation = 0
const report = { root, checks: [] }, pageErrors = []
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
async function start() {
  await writeFile(bootPath, JSON.stringify(bootPatches(catalog, core, JSON.parse(await readFile(builtinFile, 'utf8')).enabled)))
  execFileSync(process.execPath, [resolve('dsh-plugin/plugin-control/prepare-boot.mjs'), patchPath, bootPath], { env, windowsHide: true })
  output = ''; generation++
  child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--patch', bootPath, '--no-open', '--port', '0'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  for (let i = 0; i < 400; i++) {
    const url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) return url
    if (child.exitCode !== null) throw Error(output)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error('Boot timeout: ' + output)
}
async function stop() {
  if (child && child.exitCode === null) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }
    catch (error) {
      // taskkill may report a descendant exiting while it walks the tree.
      try { process.kill(child.pid, 0) } catch (missing) { if (missing.code === 'ESRCH') { child = null } else throw missing }
      if (child) throw error
    }
  }
  await writeFile(join(root, `host-${generation}.log`), output)
  child = null
}
const call = (method, ...args) => page.evaluate(async ([method, args]) => {
  const result = await window.__PROFILE_SMOKE__.remote.desktopPlugins[method](...args)
  if (!result.ok) throw Error(result.error.message)
  return result.value
}, [method, args])
const statusRow = (state, id) => state.plugins.find(row => row.patchId === id)
async function ready(url) {
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.__PROFILE_SMOKE__?.remote.desktopPlugins), undefined, { timeout: 45000 })
}
async function settings() {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!await page.locator('[data-shortcut-modal="settings"]').count()) await page.locator('button[aria-haspopup="dialog"]').first().evaluate(button => button.click())
    try {
      await page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: '插件', exact: true }).click({ timeout: 3000 })
      await page.getByRole('tab', { name: '插件列表', exact: true }).click({ timeout: 3000 }); break
    }
    catch (error) { if (attempt === 2 || await page.locator('[data-shortcut-modal="settings"]').count()) throw error }
  }
  await page.getByRole('searchbox', { name: '搜索插件' }).waitFor()
}
async function browserState(enabled) {
  await page.waitForFunction(enabled => {
    const ctx = window.__PROFILE_SMOKE__, state = ctx.modules.entries.state.getSnapshot()
    const entry = [...ctx.loader.entries()].find(e => e.options.name === '@deepseek-ai/dsh-client-ui-sidebar-browser')
    return !state.syncing && !state.failures.length && (enabled ? entry?.fiber?.state === 2 : !entry || entry.disabled)
      && Boolean(ctx.sidebarRightTabs.get('browser')) === enabled
  }, enabled)
}
try {
  const url = await start()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on('pageerror', error => pageErrors.push(error.message))
  for (const name of ['继续', '稍后配置']) await page.addLocatorHandler(page.getByRole('button', { name, exact: true }).and(page.locator(':enabled')), button => button.evaluate(element => element.click()))
  await ready(url); await settings()
  let state = await call('status')
  await writeFile(join(root, 'initial-state.json'), JSON.stringify(state, null, 2))
  const cold = statusRow(state, 'profile-cold-probe'), hot = statusRow(state, 'ui-sidebar-browser')
  assert.equal(cold.hot, false); assert.equal(cold.readOnlyReason, null)
  assert.equal(hot.hot, true); assert.equal(hot.version, state.runtimeVersion)
  const manager = state.plugins.find(row => row.moduleName === '@deepseek-ai/dsh-plugin-manager')
  assert.equal(manager.readOnlyReason, 'management-required')
  await assert.rejects(call('setPluginEnabled', manager.entryId, false), /不可修改/)
  await assert.rejects(call('setPluginEnabled', 'include:desktop-plugin-control', false), /不可修改/)
  pass('inventory exposes exact versions and protects manager and desktop controls')
  await page.route('https://plugin-control.test/**', route => route.fulfill({ contentType: 'text/html', body: '<p>plugin-frame-ready</p>' }))
  const sessionId = await page.evaluate(async path => {
    const ctx = window.__PROFILE_SMOKE__, workspace = await ctx.workspaces.create({ path })
    const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
    await ctx.uiWorkspace.openSession(id)
    return id
  }, root)
  await page.waitForFunction(id => window.__PROFILE_SMOKE__.sidebarRight.mounted.getSnapshot() === id, sessionId)
  await page.evaluate(() => window.__PROFILE_SMOKE__.sidebarRight.openTab('browser', { params: { url: 'https://plugin-control.test/' } }))
  await page.frameLocator('iframe[src="https://plugin-control.test/"]').getByText('plugin-frame-ready').waitFor()
  const profilePatch = join(home, 'profiles/web/cordis.patch.yml')
  const beforePatch = await readFile(profilePatch, 'utf8')
  const search = page.getByRole('searchbox', { name: '搜索插件' })
  await search.fill('profile-cold-probe')
  const coldSwitch = page.locator('[data-plugin-id="include:profile-cold-probe"]').getByRole('switch')
  await coldSwitch.click()
  await page.waitForFunction(() => document.querySelector('[data-plugin-id="include:profile-cold-probe"] [role=switch]')?.getAttribute('aria-checked') === 'false')
  state = await call('status')
  assert.equal(statusRow(state, 'profile-cold-probe').running, true)
  assert.equal(statusRow(state, 'profile-cold-probe').restart, true)
  await page.locator('[data-dsh-plugin-inventory] .dshPlugins__restart').waitFor()
  await page.screenshot({ path: join(root, 'pending-restart.png') })
  const started = await readFile(lifecycle, 'utf8')
  // Reconcile from both controllers while a deferred edit is saved.
  await call('setEnabled', 'desktop-notify', false)
  await browserState(true)
  for (let i = 0; i < 3; i++) {
    state = await call('setPluginEnabled', hot.entryId, false)
    assert.equal(statusRow(state, 'ui-sidebar-browser').error, null)
    await browserState(false)
    assert.equal(await page.locator('iframe[src="https://plugin-control.test/"]').count(), 0, 'the mounted browser frame must be disposed')
    state = await call('setPluginEnabled', hot.entryId, true)
    assert.equal(statusRow(state, 'ui-sidebar-browser').error, null)
    await browserState(true)
  }
  assert.equal(await readFile(lifecycle, 'utf8'), started, 'cold plugin never unloads during unrelated HMR')
  assert.equal(statusRow(state, 'profile-cold-probe').restart, true)
  pass('real host/client browser plugin unloads and re-registers without duplicates; deferred plugin stays running')
  await page.reload(); await page.waitForFunction(() => Boolean(window.__PROFILE_SMOKE__))
  await settings(); await search.fill('profile-cold-probe')
  await page.locator('[data-dsh-plugin-inventory] .dshPlugins__restart').waitFor()
  await coldSwitch.click()
  await page.locator('[data-dsh-plugin-inventory] .dshPlugins__restart').waitFor({ state: 'hidden' })
  assert.equal((await call('status')).restartRequired, false)
  pass('reconnect retains pending state and reverting the switch cancels the restart')
  await search.fill('ui-sidebar-browser')
  await page.screenshot({ path: join(root, 'hot-plugin.png') })
  await page.setViewportSize({ width: 375, height: 840 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: join(root, 'mobile-list.png') })
  await search.fill('a-nonexistent-plugin-12345')
  await page.getByText('没有匹配的插件', { exact: true }).waitFor()
  await call('setPluginEnabled', cold.entryId, false)
  await stop(); await ready(await start())
  state = await call('status')
  assert.equal(statusRow(state, 'profile-cold-probe').running, false)
  assert.equal(statusRow(state, 'profile-cold-probe').restart, false)
  assert.equal(await readFile(lifecycle, 'utf8'), started, 'disabled plugin must not mount at next boot')
  assert.equal(await readFile(profilePatch, 'utf8'), beforePatch)
  assert.equal((await call('setPluginEnabled', cold.entryId, true)).restartRequired, true)
  await stop(); await ready(await start())
  state = await call('status')
  assert.equal(statusRow(state, 'profile-cold-probe').phase, 'active')
  assert.equal(state.restartRequired, false)
  assert.equal(await readFile(lifecycle, 'utf8'), started + started)
  assert.equal(await readFile(profilePatch, 'utf8'), beforePatch)
  assert.deepEqual(pageErrors, [])
  pass('restart applies disabled/enabled intent before mount and never modifies native profile patches')
} catch (error) {
  report.error = error.stack
  if (page) { await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {}); await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText().catch(() => '') + '\n' + error.stack) }
  throw error
} finally {
  await browser?.close(); await stop()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Evidence: ' + root)
}
