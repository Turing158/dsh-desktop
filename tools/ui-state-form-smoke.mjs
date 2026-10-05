/** Real DSH settings + snapshot adapter in an isolated profile.
 * Run: node tools/ui-state-form-smoke.mjs. Uses bundled Playwright and Edge.
 * Native apply is mocked: no LAN listener, user settings, or model calls.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/ui-state-form-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home)
await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: on\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/form-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({ id: '@dsh-desktop/form-smoke',
  factory: () => ({ inject: ['configForms', 'slots', 'sessions', 'workspaces', 'uiWorkspace', 'conversation', 'layout'],
    apply(ctx) { window.__FORM_SMOKE__ = ctx } }) })`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: desktop-form-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin },
})
let output = '', browser, page
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const report = { root, checks: [] }
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }

try {
  let url
  for (let i = 0; i < 300; i++) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error('DSH exited: ' + output.slice(-2000))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(url, 'isolated backend starts')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(() => window.__FORM_SMOKE__?.sessions.list.getSnapshot().phase === 'ready')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: '稍后配置', exact: true }).click()
  if (await page.locator('[data-shortcut-modal="settings"]').count()) await page.keyboard.press('Escape')
  await page.evaluate(async root => {
    const ctx = window.__FORM_SMOKE__
    const workspace = await ctx.workspaces.create({ path: root })
    const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
    ctx.uiWorkspace.openSession(id)
    window.formSessionId = id
  }, root)
  await page.waitForFunction(() => window.__FORM_SMOKE__.conversation.input.for(window.__FORM_SMOKE__.sessions.scope(window.formSessionId)))
  await page.evaluate(() => {
    const ctx = window.__FORM_SMOKE__
    ctx.conversation.input.for(ctx.sessions.scope(window.formSessionId)).setDraft('保留这条未发送草稿')
    const saved = { version: 1, enabled: false, bindAddress: '192.168.1.10', port: 13080, trustedHosts: [] }
    window.remoteFixture = { instance: 'test', operationId: '1', state: 'disabled', address: null, error: null, frontendVersion: 'test', applying: false, saved, active: { ...saved } }
    window.appliedPayloads = []
    window.__DSH_REMOTE_IDENTITY__ = 'test'
    window.__DSH_UI_BOOT__ = { windowGeneration: 1, restoring: false }
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      if (command === 'remote_status') return structuredClone(window.remoteFixture)
      if (command === 'remote_lan_addresses') return [{ address: '192.168.1.10', name: 'Ethernet' }]
      if (command === 'remote_apply') { window.appliedPayloads.push(args); return { changed: false } }
      throw Error('Unexpected fixture command: ' + command)
    } } }
  })
  await page.addScriptTag({ path: resolve('dsh-plugin/ui-state/adapter.js') })
  await page.addScriptTag({ path: resolve('dsh-plugin/ui-state/bridge.js') })
  await page.evaluate(() => {
    window.formAdapter = window.__DSH_CREATE_UI_ADAPTER__(window.__FORM_SMOKE__)
    window.__DSH_UI_STATE__.registerRestartAdapter(() => window.formAdapter)
    window.formAudits = []
    const capture = window.formAdapter.capture.bind(window.formAdapter)
    window.formAdapter.capture = options => {
      window.formAudits.push({ ghostConfirmations: document.querySelectorAll('.dshRemote [role=alertdialog][data-dsh-ghost]').length })
      return capture(options)
    }
  })
  // Desktop chrome hides the upstream trigger; this browser fixture has no native title bar.
  await page.locator('button[aria-haspopup="dialog"]').first().evaluate(node => node.click())
  await page.getByRole('button', { name: '远程控制', exact: true }).click()
  const remote = page.locator('.dshRemote')
  await remote.locator('#dsh-remote-enabled').click()
  await page.getByRole('menuitem', { name: '开启', exact: true }).click()
  await remote.getByRole('button', { name: '应用并重启 DSH', exact: true }).click()
  const captureError = () => page.evaluate(async () => {
    try { await window.__DSH_UI_STATE__.prepareRemoteApply('test'); return null }
    catch (error) { return error.message }
    finally { window.__DSH_UI_STATE__.finishRemoteApply() }
  })
  assert.match(await captureError(), /弹窗或表单/)
  assert.equal(await page.evaluate(() => window.appliedPayloads.length), 0)
  pass('live confirmation still prevents capture')
  await remote.getByRole('button', { name: '确认启用并重启', exact: true }).click()
  await page.waitForFunction(() => window.appliedPayloads.length || document.querySelector('.dshRemote__pageError'))
  const applied = await page.evaluate(() => window.appliedPayloads)
  report.audit = await page.evaluate(() => window.formAudits)
  assert.ok(report.audit.at(-1).ghostConfirmations > 0, 'capture runs while the real exit-animation clone is still present')
  assert.equal(applied.length, 1, (await remote.locator('.dshRemote__pageError').allTextContents()).join(''))
  const sessionId = await page.evaluate(() => window.formSessionId)
  assert.equal(applied[0].payload.drafts.find(draft => draft.sessionId === sessionId)?.text, '保留这条未发送草稿')
  pass('real remote settings apply reaches native command with the unsent draft intact')
  await page.evaluate(() => {
    const dialog = document.createElement('div')
    dialog.id = 'unsaved-form-fixture'
    dialog.setAttribute('role', 'dialog')
    const field = document.createElement('textarea')
    field.value = '尚未提交的表单'
    dialog.append(field)
    document.body.append(dialog)
  })
  assert.match(await captureError(), /弹窗或表单/)
  assert.equal(await page.locator('#unsaved-form-fixture textarea').inputValue(), '尚未提交的表单')
  await page.locator('#unsaved-form-fixture').evaluate(node => node.remove())
  pass('unrelated unsaved form remains protected')
  assert.deepEqual(errors, [])
} catch (error) {
  report.error = error.stack
  if (page) {
    report.nodes = await page.locator('[role=dialog],[role=alertdialog],input,textarea,select,[contenteditable=true]').evaluateAll(nodes => nodes.map(node => ({
      tag: node.tagName, role: node.getAttribute('role'), ghost: Boolean(node.closest('[data-dsh-ghost]')), html: node.outerHTML.slice(0, 1000),
    }))).catch(() => [])
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  }
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  console.log('Report: ' + join(root, 'report.json'))
}
