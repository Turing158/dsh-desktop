/** Exercise navigation motion against the installed DSH in an isolated profile.
 * Run: node tools/remote-settings-dialog-smoke.mjs. Requires the bundled Playwright + Edge.
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
const root = await mkdtemp(resolve('src-tauri/target/remote-settings-dialog-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home)
await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: on\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/motion-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({ id: '@dsh-desktop/motion-smoke',
  factory: () => ({ inject: ['configForms', 'slots', 'sessions', 'workspaces', 'uiWorkspace', 'sidebarRight'],
    apply(ctx) { window.__MOTION_SMOKE__ = ctx } }) })`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: desktop-motion-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin },
})
let output = '', browser, page
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { root, checks: [] }
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }

try {
  let url
  for (let i = 0; i < 300; i++) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error('DSH exited: ' + output.slice(-2000))
    await sleep(100)
  }
  assert.ok(url, 'isolated backend starts')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(() => window.__MOTION_SMOKE__?.configForms.get('desktop-appearance').getSnapshot().status === 'ready')
  await page.waitForSelector('[data-conversation-content]')
  // Dismiss onboarding in this fresh test profile only.
  await page.getByRole('button', { name: '继续', exact: true }).waitFor()
  for (const label of ['继续', '我知道了', '稍后配置']) {
    const button = page.getByRole('button', { name: label, exact: true })
    if (await button.count()) await button.click()
  }
  await page.waitForTimeout(350)
  if (await page.locator('[data-shortcut-modal="settings"]').count()) await page.keyboard.press('Escape')
  await page.waitForTimeout(260)
  await page.evaluate(() => {
    window.dialogStarts = []
    document.addEventListener('animationstart', event => {
      if (event.target.matches('[role="dialog"]') && !event.target.closest('[data-dsh-ghost]')) window.dialogStarts.push(event.animationName)
    })
  })
  const settings = page.locator('[data-shortcut-modal="settings"]:not([data-dsh-ghost] *)')
  async function opening(trigger, selector) {
    const first = await page.evaluate(async ({ trigger, selector }) => {
      window.dialogStarts = []
      // Exercise a preceding DOM batch, followed by asynchronous dialog mount.
      const pending = document.createElement('span')
      document.body.append(pending)
      await Promise.resolve()
      if (trigger === 'settings') document.querySelector('button[aria-haspopup="dialog"]').click()
      else window.feedbackMotion.openDialog('motion-fixture-message', trigger)
      pending.remove()
      await new Promise(requestAnimationFrame)
      const panel = document.querySelector(selector)
      window.openingPanel = panel
      return { animation: getComputedStyle(panel).animationName, opacity: +getComputedStyle(panel).opacity,
        layer: panel.parentElement.getAttribute('data-dsh-chrome') }
    }, { trigger, selector })
    assert.equal(first.layer, 'layer')
    assert.equal(first.animation, 'dsh-desktop-panel-in')
    assert.ok(first.opacity < 1, 'first rendered frame is already entering')
    const samples = await page.evaluate(async selector => {
      const frames = []
      const end = performance.now() + 280
      while (performance.now() < end) {
        await new Promise(requestAnimationFrame)
        const node = document.querySelector(selector)
        frames.push({ same: node === window.openingPanel, opacity: node ? +getComputedStyle(node).opacity : -1 })
      }
      return { frames, starts: window.dialogStarts }
    }, selector)
    assert.ok(samples.frames.every(frame => frame.same), 'dialog stays mounted throughout entrance: ' + JSON.stringify({first, samples}))
    assert.ok(samples.frames.every((frame, i) => !i || frame.opacity + .01 >= samples.frames[i - 1].opacity), 'entrance never resets to invisible')
    assert.deepEqual(samples.starts, ['dsh-desktop-panel-in'])
  }
  for (let i = 0; i < 8; i++) {
    await opening('settings', '[data-shortcut-modal="settings"]:not([data-dsh-ghost] *)')
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'detached' })
    await page.waitForTimeout(260)
  }
  pass('settings opens eight times with one continuous animation from the first frame')

  const sessionId = await page.evaluate(async path => {
    const ctx = window.__MOTION_SMOKE__, workspace = await ctx.workspaces.create({ path })
    const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
    ctx.uiWorkspace.openSession(id)
    return id
  }, root)
  await page.waitForFunction(id => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id, sessionId)
  await page.evaluate(id => {
    const entry = window.__MOTION_SMOKE__.slots.entries('conversation.chat.assistant-actions').find(entry => entry.options.id === 'feedback')
    window.feedbackMotion = entry.inject(id)
  }, sessionId)
  const feedbackSelector = '[role="dialog"]:has(textarea):not([data-dsh-ghost] *)'
  for (let i = 0; i < 8; i++) {
    await opening(i % 2 ? 'negative' : 'positive', feedbackSelector)
    await page.keyboard.press('Escape')
    await page.locator(feedbackSelector).waitFor({ state: 'detached' })
    await page.waitForTimeout(260)
  }
  pass('both message feedback actions open the real dialog eight times without flashing or remounting')

  // Render the real remote settings component with a deterministic desktop bridge.
  // This never restarts DSH, changes the firewall, or exposes a network listener.
  await page.evaluate(() => {
    const saved = { version: 1, enabled: false, bindAddress: '192.168.1.10', port: 13080, trustedHosts: [] }
    window.remoteFixture = { instance: 'test', operationId: '1', state: 'disabled', address: null, error: null, frontendVersion: 1, applying: false, saved, active: { ...saved } }
    window.__DSH_REMOTE_IDENTITY__ = 'test'
    window.__TAURI__ = { core: { invoke: async command => {
      if (command === 'remote_status') return structuredClone(window.remoteFixture)
      if (command === 'remote_lan_addresses') return [{ address: '192.168.1.10', name: 'Ethernet' }]
      if (command === 'remote_connection_info') return { instance: 'test', url: 'http://192.168.1.10:13080/', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M0 0h16v16H0z"/></svg>' }
      if (command === 'clipboard_write_text') return
      throw Error('Unexpected fixture command: ' + command)
    } } }
  })
  await page.locator('button[aria-haspopup="dialog"]').first().evaluate(node => node.click())
  await page.locator('[class*="_navList"] button').filter({ hasText: '远程控制' }).click()
  await page.waitForSelector('#dsh-remote-enabled')
  const remote = page.locator('.dshRemote')
  const phone = remote.getByRole('heading', { name: '手机连接', exact: true })
  assert.equal(await remote.getByRole('status', { name: '运行状态' }).count(), 0)
  assert.equal(await phone.count(), 0)
  assert.deepEqual(await remote.locator('details').evaluateAll(nodes => nodes.map(node => ({ title: node.querySelector('summary').textContent, open: node.open }))), [
    { title: 'Host 白名单', open: false }, { title: '连接帮助', open: false }, { title: '在外面使用待实现', open: false },
  ])
  await remote.locator('#dsh-remote-enabled').click()
  await page.getByRole('menuitem', { name: '开启', exact: true }).click()
  assert.equal(await remote.getByRole('status', { name: '运行状态' }).count(), 0)
  assert.equal(await phone.count(), 0)
  pass('all three disclosures start closed; disabled and unapplied enable hide the entire phone connection section')
  await remote.locator('summary').filter({ hasText: 'Host 白名单' }).focus()
  await page.keyboard.press('Enter')
  await remote.getByRole('button', { name: '添加 Host', exact: true }).click()
  await remote.getByRole('textbox', { name: '额外 Host 1', exact: true }).fill('desktop.local:13080')
  await remote.locator('summary').filter({ hasText: 'Host 白名单' }).click()
  await remote.locator('summary').filter({ hasText: 'Host 白名单' }).click()
  assert.equal(await remote.getByRole('textbox', { name: '额外 Host 1', exact: true }).inputValue(), 'desktop.local:13080')
  await remote.locator('summary').filter({ hasText: 'Host 白名单' }).click()
  pass('disclosures support keyboard and preserve edited Host entries when folded')
  for (const state of ['applying', 'failed', 'local-fallback', 'lan']) {
    await page.evaluate(state => {
      Object.assign(window.remoteFixture, { state, applying: state === 'applying', operationId: state })
      window.remoteFixture.active.enabled = state === 'lan'
      window.dispatchEvent(new Event('dsh-remote-ready'))
    }, state)
    await page.waitForTimeout(100)
    assert.equal(await remote.getByRole('status', { name: '运行状态' }).count(), state === 'lan' ? 1 : 0)
    assert.equal(await phone.count(), state === 'lan' ? 1 : 0)
  }
  assert.equal(await remote.evaluate(node => {
    const enable = node.querySelector('#dsh-remote-enabled'), phone = [...node.querySelectorAll('h3')].find(n => n.textContent === '手机连接'), address = node.querySelector('#dsh-remote-address')
    return Boolean(enable.compareDocumentPosition(phone) & Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(phone.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING)
  }), true)
  assert.equal(await remote.locator('.dshRemote__row:has(#dsh-remote-enabled) [aria-label="运行状态"]').count(), 1)
  await remote.getByRole('button', { name: '显示二维码', exact: true }).click()
  await remote.getByRole('img', { name: '手机登录二维码，包含访问凭据', exact: true }).waitFor()
  await remote.locator('#dsh-remote-enabled').click()
  await page.getByRole('menuitem', { name: '关闭', exact: true }).click()
  assert.equal(await remote.getByRole('status', { name: '运行状态' }).count(), 0)
  assert.equal(await phone.count(), 0)
  assert.equal(await remote.getByRole('img').count(), 0)
  pass('phone connection appears between enable and address only after LAN is active; disabling hides the entire section and status immediately')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.__MOTION_SMOKE__.configForms.get('ui-theme').set('preference', theme), theme)
    await page.waitForTimeout(240)
    await page.screenshot({ path: join(root, 'remote-' + theme + '.png') })
  }
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    assert.equal(await remote.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'remote section has no horizontal overflow at ' + width)
  }
  pass('remote settings render in light/dark and at 375/768/1024/1440px without overflow')
  assert.deepEqual(errors, [])
  pass('no browser errors')
} catch (error) {
  report.error = error.stack
  if (page) {
    report.body = await page.locator('body').innerText().catch(() => '')
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  }
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  console.log('Report: ' + join(root, 'report.json'))
}
