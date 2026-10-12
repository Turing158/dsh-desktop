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
    window.remoteFixture = { instance: 'test', operationId: '1', state: 'disabled', address: null, error: null, frontendVersion: 1, applying: false, saved, active: null }
    window.remoteConnectionCalls = []; window.remoteCopies = []; window.remoteApplyCalls = []; window.remoteSelectionCalls = []
    window.__DSH_REMOTE_IDENTITY__ = 'test'
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      if (command === 'remote_status') return structuredClone(window.remoteFixture)
      if (command === 'remote_lan_addresses') return [{ address: '192.168.1.10', name: 'Ethernet' }]
      if (command === 'remote_select_connection') {
        window.remoteSelectionCalls.push(structuredClone(args.target))
        if (window.remoteDeferSelection) {
          window.remoteDeferSelection = false
          await new Promise(resolve => { window.remoteReleaseSelection = resolve })
        }
        const fixture = window.remoteFixture, target = args.target
        for (const config of [fixture.saved, fixture.active]) {
          if (target.host === config.bindAddress + ':' + config.port) {
            delete config.preferredHost
          } else {
            config.preferredHost = structuredClone(target)
            config.hostSchemes ||= {}
            config.hostSchemes[target.host] = target.scheme
          }
        }
        const [name, explicitPort] = target.host.split(':')
        const port = explicitPort ? Number(explicitPort) : fixture.active.port
        const address = name === 'localhost' ? '127.0.0.1' : name
        const local = fixture.listeners?.some(item => item.address === address && item.port === port)
        fixture.address = target.scheme + '://' + (local ? name + ':' + port : target.host) + '/'
        return structuredClone(fixture)
      }
      if (command === 'remote_connection_info') {
        const active = window.remoteFixture.active
        const target = args.target || active.preferredHost || { host: active.bindAddress + ':' + active.port, scheme: 'http' }
        window.remoteConnectionCalls.push(structuredClone(target))
        const [name, explicitPort] = target.host.split(':')
        const address = name === 'localhost' ? '127.0.0.1' : name
        const port = explicitPort ? Number(explicitPort) : active.port
        const local = window.remoteFixture.listeners?.some(item => item.address === address && item.port === port)
        const origin = new URL(target.scheme + '://' + (local ? name + ':' + port : target.host)).origin
        const result = { instance: 'test', url: origin + '/?token=fixture-login', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" data-test-origin="' + origin + '" viewBox="0 0 32 32"><path d="M0 0h16v16H0z"/></svg>' }
        if (window.remoteDeferConnection) {
          window.remoteDeferConnection = false
          return new Promise((resolve, reject) => {
            window.remoteReleaseConnection = () => resolve(result)
            window.remoteRejectConnection = () => reject(Error('Expired connection request'))
          })
        }
        return result
      }
      if (command === 'clipboard_write_text') { window.remoteCopies.push(args.text); return }
      if (command === 'remote_apply') { window.remoteApplied = structuredClone(args.config); window.remoteApplyCalls.push(window.remoteApplied); return { changed: false, operationId: '1' } }
      throw Error('Unexpected fixture command: ' + command)
    } } }
  })
  await page.locator('button[aria-haspopup="dialog"]').first().evaluate(node => node.click())
  await page.locator('[class*="_navList"] button').filter({ hasText: '远程控制' }).click()
  await page.waitForSelector('#dsh-remote-enabled')
  const remote = page.locator('.dshRemote')
  const remoteMenu = page.locator('.dshRemote__menu:not([data-dsh-ghost] *)')
  async function choose(control, value) {
    await control.click()
    const label = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await remoteMenu.getByRole('menuitem', { name: new RegExp('^' + label + '(?:（局域网）)?$', 'i') }).click()
    await remoteMenu.waitFor({ state: 'detached' })
  }
  async function choices(control) {
    await control.click()
    await remoteMenu.waitFor()
    const labels = await remoteMenu.getByRole('menuitem').allTextContents()
    await page.keyboard.press('Escape')
    await remoteMenu.waitFor({ state: 'detached' })
    assert.equal(await control.evaluate(node => node === document.activeElement), true)
    return labels.map(label => label.replace(/（局域网）$/, ''))
  }
  const phone = remote.getByRole('heading', { name: '手机连接', exact: true })
  assert.equal(await remote.getByRole('status', { name: '运行状态' }).count(), 0)
  assert.equal(await phone.count(), 0)
  assert.deepEqual(await remote.locator('details').evaluateAll(nodes => nodes.map(node => ({ title: node.querySelector('summary').textContent, open: node.open }))), [
    { title: 'Host 白名单', open: false }, { title: '连接帮助', open: false }, { title: '在外面使用Cloudflare Tunnel', open: false },
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
  const lanHost = remote.getByRole('textbox', { name: '局域网 Host（只读）', exact: true })
  const hostProtocol = index => remote.getByLabel('Host ' + index + ' 协议', { exact: true })
  assert.equal(await remote.getByLabel('局域网 Host 协议', { exact: true }).getAttribute('value'), 'http')
  assert.equal(await remote.getByLabel('局域网 Host 协议', { exact: true }).isDisabled(), true)
  assert.equal(await remote.locator('select').count(), 0)
  assert.deepEqual(await choices(hostProtocol(1)), ['HTTPS', 'HTTP'])
  await hostProtocol(1).focus()
  await page.keyboard.press('ArrowDown')
  await remoteMenu.waitFor()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await remoteMenu.waitFor({ state: 'detached' })
  assert.equal(await hostProtocol(1).getAttribute('value'), 'http')
  assert.equal(await hostProtocol(1).evaluate(node => node === document.activeElement), true)
  pass('shared protocol menus support keyboard selection, Escape and returning focus to the trigger')
  assert.equal(await lanHost.inputValue(), '192.168.1.10:13080')
  assert.equal(await lanHost.isEditable(), false)
  assert.equal(await remote.locator('[data-dsh-remote-host="lan"] .dshRemote__ghostDanger').count(), 0)
  assert.equal(await remote.getByRole('radio').count(), 0)
  assert.doesNotMatch(await remote.innerText(), /首选/)
  await remote.getByRole('textbox', { name: '额外 Host 1', exact: true }).fill('Renamed.local:13080')
  assert.equal(await hostProtocol(1).getAttribute('value'), 'http')
  await remote.getByRole('textbox', { name: '额外 Host 1', exact: true }).fill('https://invalid.example')
  assert.equal(await remote.getByRole('button', { name: '应用并重启 DSH', exact: true }).isEnabled(), false)
  await remote.getByRole('textbox', { name: '额外 Host 1', exact: true }).fill('desktop.local:13080')
  await remote.getByRole('button', { name: '添加 Host', exact: true }).click()
  assert.equal(await remote.getByRole('button', { name: '应用并重启 DSH', exact: true }).isEnabled(), false)
  await remote.getByRole('textbox', { name: '额外 Host 2', exact: true }).fill('remote.example.com')
  assert.equal(await hostProtocol(2).getAttribute('value'), 'https')
  assert.equal(await hostProtocol(1).getAttribute('value'), 'http')
  await remote.getByRole('button', { name: '删除 Host 1', exact: true }).click()
  assert.equal(await remote.getByRole('textbox', { name: '额外 Host 1', exact: true }).inputValue(), 'remote.example.com')
  assert.equal(await hostProtocol(1).getAttribute('value'), 'https')
  await remote.getByRole('button', { name: '删除 Host 1', exact: true }).click()
  assert.equal(await lanHost.inputValue(), '192.168.1.10:13080')
  await remote.getByRole('button', { name: '添加 Host', exact: true }).click()
  await remote.getByRole('textbox', { name: '额外 Host 1', exact: true }).fill('desktop.local:13080')
  await choose(hostProtocol(1), 'http')
  pass('each Host owns its protocol through renaming and deletion; LAN Host stays immutable')
  await remote.getByRole('button', { name: '添加 Host', exact: true }).click()
  await remote.getByRole('textbox', { name: '额外 Host 2', exact: true }).fill('127.0.0.1')
  assert.equal(await hostProtocol(2).getAttribute('value'), 'http')
  assert.equal(await hostProtocol(2).isDisabled(), true)
  assert.doesNotMatch(await remote.innerText(), /应用后监听|仅允许此 Host/)
  assert.equal(await remote.locator('.dshRemote__hostRow').evaluateAll(rows => rows.every(row => row.children[0].querySelector('button[aria-haspopup="menu"]') && row.children[1].tagName === 'INPUT')), true)
  await remote.getByRole('textbox', { name: '额外 Host 2', exact: true }).fill('localhost:0')
  assert.equal(await remote.getByRole('button', { name: '应用并重启 DSH', exact: true }).isEnabled(), false)
  assert.ok((await remote.innerText()).includes('本机监听端口须为 1–65535'))
  await remote.getByRole('button', { name: '删除 Host 2', exact: true }).click()
  pass('protocols precede every input, local Hosts use HTTP, row descriptions are removed, and port zero is rejected')
  await remote.locator('summary').filter({ hasText: 'Host 白名单' }).click()
  pass('disclosures support keyboard and preserve edited Host entries when folded')
  for (const state of ['applying', 'failed', 'local-fallback', 'lan']) {
    await page.evaluate(state => {
      Object.assign(window.remoteFixture, { state, applying: state === 'applying', operationId: state })
      window.remoteFixture.active ||= { ...window.remoteFixture.saved }
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
  const connectionHost = remote.getByLabel('访问 Host', { exact: true })
  assert.equal(await remote.getByLabel('访问协议', { exact: true }).count(), 0)
  const connectionQr = remote.getByRole('img', { name: '手机登录二维码，包含访问凭据', exact: true })
  assert.deepEqual(await choices(connectionHost), ['192.168.1.10:13080'])
  pass('unapplied Host edits do not appear among usable connection addresses')
  await remote.locator('summary').filter({ hasText: 'Host 白名单' }).click()
  await page.evaluate(() => {
    window.remoteFixtureBridge = window.__DSH_UI_STATE__
    window.__DSH_UI_STATE__ = { prepareRemoteApply: async () => ({}), finishRemoteApply() {} }
  })
  await remote.getByRole('button', { name: '应用并重启 DSH', exact: true }).click()
  await page.waitForFunction(() => Boolean(window.remoteApplied))
  const applied = await page.evaluate(() => window.remoteApplied)
  assert.equal(applied.preferredHost, undefined)
  assert.equal(applied.bindAddress, '192.168.1.10')
  assert.deepEqual(applied.trustedHosts, ['desktop.local:13080'])
  assert.deepEqual(applied.hostSchemes, { 'desktop.local:13080': 'http' })
  await page.evaluate(() => { window.__DSH_UI_STATE__ = window.remoteFixtureBridge; delete window.remoteFixtureBridge })
  pass('applying changes only whitelist settings and preserves the LAN listener')

  await page.evaluate(() => {
    const active = { ...window.remoteApplied, trustedHosts: ['desktop.local:13080', 'remote.example.com'], hostSchemes: { 'desktop.local:13080': 'http', 'remote.example.com': 'https' }, preferredHost: { host: 'remote.example.com', scheme: 'https' } }
    Object.assign(window.remoteFixture, { active, saved: structuredClone(active), address: 'https://remote.example.com/', operationId: 'multi-host' })
    window.dispatchEvent(new Event('dsh-remote-ready'))
  })
  await page.waitForFunction(() => document.querySelector('#dsh-remote-connection-host')?.value === 'remote.example.com')
  assert.deepEqual(await choices(connectionHost), ['192.168.1.10:13080', 'desktop.local:13080', 'remote.example.com'])
  assert.equal(await remote.locator('.dshRemote__kvValue').innerText(), 'https://remote.example.com/')
  const beforeChoices = await page.evaluate(() => ({ status: structuredClone(window.remoteFixture), applies: window.remoteApplyCalls.length }))
  async function copyConnection(origin) {
    const count = await page.evaluate(() => window.remoteCopies.length)
    await remote.getByRole('button', { name: '复制完整链接', exact: true }).click()
    await page.waitForFunction(count => window.remoteCopies.length === count + 1, count)
    const link = new URL(await page.evaluate(() => window.remoteCopies.at(-1)))
    assert.equal(link.origin, origin)
    assert.equal(link.searchParams.get('token'), 'fixture-login')
  }
  await copyConnection('https://remote.example.com')
  await choose(connectionHost, 'desktop.local:13080')
  await copyConnection('http://desktop.local:13080')
  await remote.getByRole('button', { name: '显示二维码', exact: true }).click()
  await connectionQr.waitFor()
  assert.equal(await connectionQr.locator('svg').getAttribute('data-test-origin'), 'http://desktop.local:13080')
  await choose(connectionHost, '192.168.1.10:13080')
  assert.equal(await connectionQr.count(), 0)
  await copyConnection('http://192.168.1.10:13080')
  assert.equal(await remote.locator('.dshRemote__kvValue').innerText(), 'http://192.168.1.10:13080/')
  assert.doesNotMatch(await remote.innerText(), /fixture-login/)
  pass('both domains and LAN get complete login links; protocols and QR follow the selected address')

  await page.evaluate(() => { window.remoteDeferConnection = true })
  await remote.getByRole('button', { name: '复制完整链接', exact: true }).click()
  await page.waitForFunction(() => Boolean(window.remoteReleaseConnection))
  await choose(connectionHost, 'remote.example.com')
  await remote.getByRole('button', { name: '显示二维码', exact: true }).click()
  await connectionQr.waitFor()
  await page.evaluate(() => window.remoteReleaseConnection())
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => window.remoteCopies.length), 3)
  assert.equal(await connectionQr.locator('svg').getAttribute('data-test-origin'), 'https://remote.example.com')
  await page.evaluate(() => { window.remoteDeferConnection = true; delete window.remoteRejectConnection })
  await remote.getByRole('button', { name: '复制完整链接', exact: true }).click()
  await page.waitForFunction(() => Boolean(window.remoteRejectConnection))
  await choose(connectionHost, 'desktop.local:13080')
  await remote.getByRole('button', { name: '显示二维码', exact: true }).click()
  await connectionQr.waitFor()
  await page.evaluate(() => window.remoteRejectConnection())
  await page.waitForTimeout(100)
  assert.equal(await connectionQr.locator('svg').getAttribute('data-test-origin'), 'http://desktop.local:13080')
  assert.equal(await remote.locator('.dshRemote__pageError').count(), 0)
  const afterChoices = await page.evaluate(() => ({ status: window.remoteFixture, applies: window.remoteApplyCalls.length }))
  assert.equal(afterChoices.applies, beforeChoices.applies)
  for (const key of ['instance', 'operationId', 'state']) assert.equal(afterChoices.status[key], beforeChoices.status[key])
  for (const key of ['saved', 'active']) assert.deepEqual({ ...afterChoices.status[key], preferredHost: undefined }, { ...beforeChoices.status[key], preferredHost: undefined })
  pass('switching connection addresses never applies or restarts; late results and errors cannot replace the current QR or clipboard')

  await page.evaluate(() => { window.remoteDeferSelection = true })
  await choose(connectionHost, 'remote.example.com')
  await page.waitForFunction(() => Boolean(window.remoteReleaseSelection))
  await choose(connectionHost, 'desktop.local:13080')
  await page.evaluate(() => window.remoteReleaseSelection())
  await page.waitForFunction(() => window.remoteFixture.saved.preferredHost?.host === 'desktop.local:13080' && window.remoteFixture.saved.preferredHost?.scheme === 'http')
  assert.equal(await connectionHost.getAttribute('value'), 'desktop.local:13080')
  assert.equal(await remote.locator('.dshRemote__kvValue').innerText(), 'http://desktop.local:13080/')
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'detached' })
  await page.waitForTimeout(260)
  await page.locator('button[aria-haspopup="dialog"]').first().evaluate(node => node.click())
  await page.locator('[class*="_navList"] button').filter({ hasText: '远程控制' }).click()
  await page.waitForFunction(() => document.querySelector('#dsh-remote-connection-host')?.value === 'desktop.local:13080')
  assert.equal(await remote.locator('.dshRemote__kvValue').innerText(), 'http://desktop.local:13080/')
  await remote.locator('summary').filter({ hasText: 'Host 白名单' }).click()
  assert.equal(await hostProtocol(1).getAttribute('value'), 'http')
  assert.equal(await hostProtocol(2).getAttribute('value'), 'https')
  assert.equal(await remote.getByRole('button', { name: '应用并重启 DSH', exact: true }).isEnabled(), false)
  assert.equal(await page.evaluate(() => window.remoteApplyCalls.length), 1)
  assert.doesNotMatch(await remote.innerText(), /首选/)
  pass('rapid Host choices save in order and each saved protocol survives reopening without pending whitelist changes')

  await page.evaluate(() => {
    window.remoteFixture.active.trustedHosts = ['remote.example.com']
    delete window.remoteFixture.active.preferredHost
    window.remoteFixture.saved = structuredClone(window.remoteFixture.active)
    window.remoteFixture.operationId = 'removed-host'
    window.dispatchEvent(new Event('dsh-remote-ready'))
  })
  await page.waitForFunction(() => document.querySelector('#dsh-remote-connection-host')?.value === '192.168.1.10:13080')
  assert.equal(await connectionQr.count(), 0)
  assert.deepEqual(await choices(connectionHost), ['192.168.1.10:13080', 'remote.example.com'])
  await page.evaluate(() => {
    window.remoteFixture.active.trustedHosts = ['desktop.local:13080', 'remote.example.com']
    window.remoteFixture.saved = structuredClone(window.remoteFixture.active)
    window.remoteFixture.operationId = 'restored-host'
    window.dispatchEvent(new Event('dsh-remote-ready'))
  })
  await page.waitForTimeout(100)
  pass('runtime configuration changes clear old QR codes and remove unavailable connection addresses')
  await page.evaluate(() => {
    window.remoteFixture.active.trustedHosts.push('127.0.0.1', 'localhost:13081')
    window.remoteFixture.saved = structuredClone(window.remoteFixture.active)
    window.remoteFixture.listeners = [{ address: '192.168.1.10', port: 13080 }, { address: '127.0.0.1', port: 13080 }, { address: '127.0.0.1', port: 13081 }]
    window.remoteFixture.operationId = 'local-listeners'
    window.dispatchEvent(new Event('dsh-remote-ready'))
  })
  await page.waitForFunction(() => document.querySelector('.dshRemote__runtime')?.textContent.includes('127.0.0.1:13081'))
  assert.equal((await choices(connectionHost)).length, 5)
  await choose(connectionHost, '127.0.0.1')
  await copyConnection('http://127.0.0.1:13080')
  assert.equal(await remote.locator('.dshRemote__kvValue').innerText(), 'http://127.0.0.1:13080/')
  assert.ok((await remote.getByRole('status', { name: '运行状态' }).innerText()).includes('127.0.0.1:13080'))
  assert.ok((await remote.innerText()).includes('回环地址仅供这台电脑或本机隧道使用'))
  await choose(connectionHost, 'localhost:13081')
  await copyConnection('http://localhost:13081')
  await remote.getByRole('button', { name: '显示二维码', exact: true }).click()
  await connectionQr.waitFor()
  assert.equal(await connectionQr.locator('svg').getAttribute('data-test-origin'), 'http://localhost:13081')
  assert.equal(await page.evaluate(() => window.remoteApplyCalls.length), 1)
  await page.evaluate(() => {
    window.remoteFixture.active.trustedHosts = ['desktop.local:13080', 'remote.example.com']
    delete window.remoteFixture.active.preferredHost
    window.remoteFixture.saved = structuredClone(window.remoteFixture.active)
    window.remoteFixture.listeners = [{ address: '192.168.1.10', port: 13080 }]
    window.remoteFixture.operationId = 'removed-local-listeners'
    window.dispatchEvent(new Event('dsh-remote-ready'))
  })
  await page.waitForFunction(() => document.querySelector('#dsh-remote-connection-host')?.value === '192.168.1.10:13080')
  assert.equal((await choices(connectionHost)).length, 3)
  assert.equal(await connectionHost.getAttribute('value'), '192.168.1.10:13080')
  assert.equal(await connectionQr.count(), 0)
  assert.ok(!(await remote.getByRole('status', { name: '运行状态' }).innerText()).includes('127.0.0.1'))
  pass('actual local listeners appear in status; loopback links use HTTP and the correct port; removing them clears selection and QR')
  await choose(connectionHost, 'desktop.local:13080')
  await choose(hostProtocol(1), 'https')
  await page.waitForFunction(() => window.remoteFixture.saved.hostSchemes?.['desktop.local:13080'] === 'https'
    && window.remoteFixture.saved.preferredHost?.host === 'desktop.local:13080'
    && window.remoteFixture.saved.preferredHost?.scheme === 'https')
  assert.equal(await page.evaluate(() => window.remoteApplyCalls.length), 1)
  await page.waitForFunction(() => document.querySelector('.dshRemote__kvValue')?.textContent === 'https://desktop.local:13080/')
  await copyConnection('https://desktop.local:13080')
  assert.equal(await page.evaluate(() => window.remoteApplyCalls.length), 1)
  pass('changing a Host protocol updates its access link immediately without applying or restarting DSH')
  await remote.getByRole('button', { name: '显示二维码', exact: true }).click()
  await remote.getByRole('img', { name: '手机登录二维码，包含访问凭据', exact: true }).waitFor()
  await remote.locator('#dsh-remote-enabled').click()
  await page.getByRole('menuitem', { name: '关闭', exact: true }).click()
  assert.equal(await remote.getByRole('status', { name: '运行状态' }).count(), 0)
  assert.equal(await phone.count(), 0)
  assert.equal(await remote.getByRole('img').count(), 0)
  pass('phone connection appears between enable and address only after LAN is active; disabling hides the entire section and status immediately')
  await remote.locator('#dsh-remote-enabled').click()
  await page.getByRole('menuitem', { name: '开启', exact: true }).click()
  await remote.getByRole('button', { name: '显示二维码', exact: true }).click()
  await connectionQr.waitFor()
  await remote.locator('summary').filter({ hasText: '在外面使用' }).click()
  await connectionHost.scrollIntoViewIfNeeded()
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.__MOTION_SMOKE__.configForms.get('ui-theme').set('preference', theme), theme)
    await page.waitForTimeout(240)
    await page.screenshot({ path: join(root, 'remote-' + theme + '.png') })
    await hostProtocol(1).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(root, 'remote-hosts-' + theme + '.png') })
    await hostProtocol(1).click()
    await remoteMenu.waitFor()
    assert.equal(await remoteMenu.getByRole('menuitem', { name: 'HTTPS', exact: true }).evaluate(node => /selected/.test(node.className)), true)
    assert.equal(await remoteMenu.evaluate(node => !node.closest('[data-shortcut-modal="settings"]')), true)
    await page.screenshot({ path: join(root, 'remote-protocol-menu-' + theme + '.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await remoteMenu.waitFor({ state: 'detached' })
    await connectionHost.scrollIntoViewIfNeeded()
    await connectionHost.click()
    await remoteMenu.waitFor()
    await page.screenshot({ path: join(root, 'remote-host-menu-' + theme + '.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await remoteMenu.waitFor({ state: 'detached' })
  }
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    assert.equal(await remote.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'remote section has no horizontal overflow at ' + width)
    if (width === 375) {
      await hostProtocol(1).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(root, 'remote-hosts-mobile.png') })
      await hostProtocol(1).click()
      await remoteMenu.waitFor()
      assert.equal(await remoteMenu.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight }), true)
      await page.screenshot({ path: join(root, 'remote-protocol-menu-mobile.png'), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await remoteMenu.waitFor({ state: 'detached' })
    }
  }
  pass('shared menus mark the selected item and escape dialog clipping; light/dark settings and narrow-screen menus stay within the viewport')
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
