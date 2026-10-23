/** Real WebView2 + installed DSH account UI against a loopback OAuth fixture.
 * Run after cargo build: node tools/account-login-smoke.mjs
 * Capture only the OS-launch boundary, then visit each authorization URL in
 * an independent browser profile with no desktop authentication cookies.
 * Credentials, browser data and DSH settings stay in an isolated test directory.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, unlink, symlink } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = await mkdtemp(resolve('src-tauri/target/account-login-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home); await mkdir(probe)
const bin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
await symlink(join(dirname(dirname(bin)), 'node_modules'), join(root, 'node_modules'), 'junction')
let authorization, initializations = 0, exchanges = 0
const platform = createServer(async (req, res) => {
  const url = new URL(req.url, platformOrigin)
  let body = ''; for await (const chunk of req) body += chunk
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: value } })) }
  if (url.pathname.endsWith('/auth_init')) {
    authorization = JSON.parse(body); initializations++
    // Exercise the asynchronous about:blank -> authorization page handoff.
    await new Promise(resolve => setTimeout(resolve, 200))
    return json({ authorize_url: platformOrigin + '/dsh/authorize', authorize_id: 'fixture-' + initializations, expires_in: 600 })
  }
  if (url.pathname.endsWith('/auth_exchange')) {
    assert.equal(JSON.parse(body).redirect_uri, authorization.redirect_uri)
    exchanges++
    return json({ token: 'isolated-fixture-token', authorized_url: platformOrigin + '/dsh/authorized' })
  }
  if (url.pathname.endsWith('/auth_cancel') || url.pathname.endsWith('/logout')) return json({})
  if (url.pathname === '/dsh/authorize') {
    const callback = new URL(authorization.redirect_uri)
    callback.searchParams.set('state', authorization.state)
    callback.searchParams.set('code', 'fixture-code')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end('<title>Test authorization</title><a href="' + callback.href.replaceAll('&', '&amp;') + '">Authorize test account</a>')
  }
  if (url.pathname === '/dsh/authorized') return res.end('Test account authorized')
  res.writeHead(404).end()
})
await new Promise(resolve => platform.listen(0, '127.0.0.1', resolve))
const platformOrigin = 'http://127.0.0.1:' + platform.address().port
if (process.argv.includes('--lan')) {
  const address = Object.values(networkInterfaces()).flat().find(i => i?.family === 'IPv4' && !i.internal && /^192\.168\./.test(i.address))?.address
  assert.ok(address, 'LAN test requires a private IPv4 adapter')
  const listener = createServer()
  await new Promise(resolve => listener.listen(0, address, resolve))
  const lanPort = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  await writeFile(join(root, 'remote-control.json'), JSON.stringify({ version: 1, enabled: true, bindAddress: address, port: lanPort, trustedHosts: [] }))
}
const portServer = createServer()
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve))
const port = portServer.address().port
await new Promise(resolve => portServer.close(resolve))
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/account-smoke', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/account-smoke',factory:()=>({inject:['remote','remote.account'],apply(ctx){window.__ACCOUNT_SMOKE__=ctx}})})`)
await writeFile(join(root, 'account.patch.yml'), `- id: deepseek-account
  config:
    platformOrigin: ${platformOrigin}
    allowLoopbackHttp: true
- insert:
    - id: account-smoke
      name: ${pathToFileURL(join(probe, 'index.js')).href}
`)
const entry = join(root, 'dsh.mjs')
await writeFile(entry, `if(process.argv.includes('--version')) console.log('0.2.1-rc.1'); else {process.argv.splice(3,0,'--patch',${JSON.stringify(join(root, 'account.patch.yml'))}); const cli=await import(${JSON.stringify(pathToFileURL(bin).href)}); await cli.runCli()}`)
// Preserve the two native registrations startup refreshes, even in smoke mode.
const shortcut = join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/dsh desktop.lnk')
const previousShortcut = await readFile(shortcut).catch(error => { if (error.code === 'ENOENT') return null; throw error })
const scheme = 'HKCU\\Software\\Classes\\deepseekharness', backup = join(root, 'scheme.reg')
const hadScheme = spawnSync('reg.exe', ['export', scheme, backup, '/y'], { windowsHide: true, stdio: 'ignore' }).status === 0
const child = spawn(resolve(process.env.DSH_DESKTOP_TEST_EXE || 'src-tauri/target/debug/deepseek-harness-desktop.exe'), [], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_SMOKE_DIR: root, DSH_DESKTOP_DEBUG: join(root, 'host.log'),
    DSH_DESKTOP_DSH: entry, DSH_DESKTOP_DSH_BIN: bin, DSH_DESKTOP_SMOKE_CAPTURE_BROWSER: '1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
})
let browser, page, externalBrowser
let output = ''
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const report = { checks: [], errors: [] }, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function pass(name) { report.checks.push(name); console.log('PASS ' + name) }
async function until(fn, timeout = 45000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { try { const value = await fn(); if (value) return value } catch {} await sleep(100) }
  throw Error('Timed out waiting for account state')
}
// Native sibling windows do not surface as Playwright page events. Check CDP's
// complete inventory to catch leaked hidden windows after the browser handoff.
async function targets() {
  return fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
}
async function launches() {
  const content = await readFile(join(root, 'browser-open.jsonl'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error
  })
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line).url)
}
async function onlyMainWindow() {
  const pages = (await targets()).filter(target => target.type === 'page')
  return pages.length === 1 && new URL(pages[0].url).origin === report.origin
}
try {
  await Promise.race([until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok),
    new Promise((_, reject) => child.once('exit', code => reject(Error('Desktop exited (' + code + '): ' + output))))])
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  page = browser.contexts()[0].pages()[0]
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') console.log('BROWSER ' + message.text()) })
  await until(() => page.evaluate(() => Boolean(window.__ACCOUNT_SMOKE__)))
  for (let i = 0; i < 15; i++) {
    await page.evaluate(() => { for (const name of ['继续', '稍后配置']) [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent === name)?.click() })
    await sleep(100)
  }
  report.origin = new URL(page.url()).origin
  assert.equal(new URL(page.url()).hostname, '127.0.0.1')
  // Closing while auth_init is pending must also destroy the native container.
  await page.evaluate(() => { const popup = window.open('about:blank', '_blank'); popup.close() })
  await until(onlyMainWindow)
  assert.deepEqual(await launches(), [])
  pass('a cancelled blank window is cleaned up without opening a browser')
  await page.evaluate(() => {
    const open = window.open
    window.open = function (...args) { const popup = open.apply(this, args); window.__SMOKE_POPUP__ = popup; return popup }
  })
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await until(async () => initializations > 0 || await page.getByText('登录失败', { exact: true }).isVisible())
  assert.ok(initializations > 0, 'login must reach the backend; ' + report.errors.join('; '))
  const firstUrl = await until(async () => (await launches())[0])
  assert.ok(firstUrl.startsWith(platformOrigin + '/dsh/authorize'))
  await until(onlyMainWindow)
  assert.equal(await page.evaluate(() => window.__SMOKE_POPUP__.closed), true)
  assert.ok(await page.getByText('等待登录', { exact: true }).isVisible())
  pass('login hands its real URL to the default-browser launcher and removes the hidden window')

  externalBrowser = await chromium.launch({ channel: 'msedge', headless: true })
  const externalContext = await externalBrowser.newContext()
  assert.deepEqual(await externalContext.cookies(), [])
  const externalPage = await externalContext.newPage()
  await externalPage.goto(firstUrl)
  assert.equal(await externalPage.evaluate(() => typeof window.__TAURI_INTERNALS__), 'undefined')
  const staleCallback = await externalPage.getByRole('link', { name: 'Authorize test account' }).getAttribute('href')
  pass('authorization opens in a separate browser profile without desktop cookies or capabilities')

  await page.getByRole('button', { name: '取消', exact: true }).evaluate(button => button.click())
  await until(() => page.evaluate(async () => (await window.__ACCOUNT_SMOKE__.remote.account.getState()).value?.attempt?.phase === 'cancelled'))
  const cancelledResponse = await externalContext.request.get(staleCallback)
  assert.ok(cancelledResponse.status() >= 400, 'cancelled authorization cannot complete')
  assert.equal(exchanges, 0)
  // Cancelling dismisses the onboarding card. The desktop account button now
  // starts sign-in directly, without an intermediate account menu.
  await page.getByRole('button', { name: '未登录', exact: true }).click()
  const retryUrl = await until(async () => (await launches())[1])
  await until(onlyMainWindow)
  assert.equal(initializations, 2)
  await externalPage.goto(retryUrl)
  const callback = await externalPage.getByRole('link', { name: 'Authorize test account' }).getAttribute('href')
  assert.notEqual(callback, staleCallback)
  assert.equal((await externalContext.request.get(staleCallback)).status(), 400)
  assert.equal(exchanges, 0)
  assert.deepEqual(await externalContext.cookies(report.origin), [])
  pass('cancellation invalidates the old callback and retry opens a fresh browser authorization')

  await externalPage.getByRole('link', { name: 'Authorize test account' }).click()
  await until(() => page.evaluate(async () => (await window.__ACCOUNT_SMOKE__.remote.account.getState()).value?.status === 'credential-stored'))
  await until(async () => await page.locator('[data-dsh-account-trigger]').getAttribute('data-signed-out') === 'false')
  assert.equal(exchanges, 1)
  assert.equal(new URL(authorization.redirect_uri).origin, report.origin)
  assert.ok(externalPage.url().startsWith(platformOrigin + '/dsh/authorized'))
  assert.equal((await launches()).length, 2)
  assert.ok(await onlyMainWindow())
  assert.deepEqual(report.errors, [])
  pass('an external-browser OAuth callback updates the desktop account without shared cookies')
} catch (error) {
  report.error = error.stack
  report.pages = browser?.contexts().flatMap(context => context.pages().map(page => page.url()))
  report.targets = await targets().catch(() => [])
  report.launches = await launches().catch(() => [])
  report.accountState = await page?.evaluate(async () => (await window.__ACCOUNT_SMOKE__.remote.account.getState())).catch(() => null)
  report.popup = await page?.evaluate(() => ({ exists: Boolean(window.__SMOKE_POPUP__), closed: window.__SMOKE_POPUP__?.closed })).catch(() => null)
  report.body = await page?.locator('body').innerText().catch(() => '')
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: Date.now(), action: 'quit' }))
  await browser?.close()
  await externalBrowser?.close()
  await until(() => child.exitCode !== null, 10000).catch(() => child.kill())
  platform.closeAllConnections(); await new Promise(resolve => platform.close(resolve))
  if (previousShortcut) await writeFile(shortcut, previousShortcut)
  else await unlink(shortcut).catch(error => { if (error.code !== 'ENOENT') throw error })
  spawnSync('reg.exe', hadScheme ? ['import', backup] : ['delete', scheme, '/f'], { windowsHide: true, stdio: 'ignore' })
  console.log('Report: ' + root)
}
