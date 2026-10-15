/** Real DSH changes over an insecure HTTP origin. Only the test hostname resolves
 * to loopback; authentication, RPC, Git reads and sidebar rendering stay real. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SnapshotStore } from '../dsh-plugin/sidebar-changes/host/snapshot-store.mjs'
import { hash } from '../dsh-plugin/sidebar-changes/host/paths.mjs'
import { git } from '../dsh-plugin/sidebar-changes/host/git-provider.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const desktop = process.argv.includes('--desktop'), hostname = 'changes-remote.test'
const root = await mkdtemp(resolve('src-tauri/target/remote-changes-'))
const home = join(root, 'home'), workspace = join(root, 'workspace'), probe = join(root, 'probe'), snapshots = join(root, 'changes')
await Promise.all([home, workspace, probe].map(path => mkdir(path)))
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/remote-changes-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@dsh-desktop/sidebar-changes'] } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}\n')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/remote-changes-smoke',factory:()=>({
  inject:['sessions','workspaces','uiWorkspace','sidebarRight','remote','remote.desktopChanges'],apply(ctx){window.__REMOTE_CHANGES_SMOKE__=ctx}})})`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: remote-changes-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
await writeFile(join(root, 'patch.yml'), patch)
const name = '中文 文件.txt', before = 'before\n', staged = 'staged change\n', working = 'working change\n'
await git(workspace, ['init'])
await git(workspace, ['config', 'user.name', 'Test']); await git(workspace, ['config', 'user.email', 'test@example.invalid'])
await writeFile(join(workspace, name), before); await git(workspace, ['add', '.']); await git(workspace, ['commit', '-m', 'test: initial commit'])
await writeFile(join(workspace, name), staged); await git(workspace, ['add', '.']); await writeFile(join(workspace, name), working)

let child, browser, page, output = ''
const report = { root, desktop, checks: [] }, errors = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const pass = text => { report.checks.push(text); console.log('PASS: ' + text) }
try {
  child = spawn(process.execPath, [dshBin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--port', '0', '--trusted-host', hostname], {
    cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_CHANGES_DIR: snapshots },
  })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  let url
  for (let i = 0; i < 400; i++) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error(output)
    await sleep(100)
  }
  assert.ok(url, 'isolated DSH starts')
  const remote = new URL(url); remote.hostname = hostname
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--host-resolver-rules=MAP ' + hostname + ' 127.0.0.1', '--no-proxy-server'] })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript(desktop => {
    window.__UUID_BEFORE_BOOT__ = typeof crypto.randomUUID
    if (desktop) window.__DSH_DESKTOP_BOOT_HOST__ = true
  }, desktop)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('slot entry crashed')) errors.push(message.text()) })
  for (const label of ['继续', '我知道了', '稍后配置']) {
    await page.addLocatorHandler(page.getByRole('button', { name: label, exact: true }).and(page.locator(':enabled')), button => button.click())
  }
  await page.goto(remote.href)
  await page.waitForFunction(() => Boolean(window.__REMOTE_CHANGES_SMOKE__), undefined, { timeout: 40000 })
  assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, uuidBeforeBoot: window.__UUID_BEFORE_BOOT__, browser: document.documentElement.hasAttribute('data-dsh-browser') })),
    { secure: false, uuidBeforeBoot: 'undefined', browser: !desktop })
  pass('real HTTP origin has no native randomUUID and preserves desktop/remote classification')
  const sessionId = await page.evaluate(async path => {
    const ctx = window.__REMOTE_CHANGES_SMOKE__, workspace = await ctx.workspaces.create({ path })
    const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId }); ctx.uiWorkspace.openSession(id); return id
  }, workspace)
  const store = new SnapshotStore(snapshots)
  await store.finish({ sessionId, root: workspace }, name, [{ path: name, author: sessionId, callId: 'fixture', sequence: 0, origin: 'structured', finalStatus: 'success', execution: name,
    before: { exists: true, text: before, hash: hash(before), reason: null, mode: null },
    after: { exists: true, text: staged, hash: hash(staged), reason: null, mode: null } }])
  await page.evaluate(() => window.__REMOTE_CHANGES_SMOKE__.sidebarRight.openTab('desktop-changes'))
  const panel = () => page.locator('.dshChanges:visible')
  const file = () => panel().getByRole('button', { name: /^中文 文件.txt，/ })
  await file().waitFor({ timeout: 12000 })
  await file().click()
  const added = text => panel().locator('.dshChanges__line[data-kind="+"] code').filter({ hasText: text }).waitFor()
  await added('staged change')
  pass('new Changes tab loads recorded session files and expands the real diff')
  const source = async label => {
    await panel().getByRole('button', { name: '更改范围', exact: true }).click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  }
  await source('未提交'); await file().click(); await added('working change')
  await source('暂存区'); await file().click(); await added('staged change')
  await source('提交记录'); await page.getByRole('button', { name: '提交：test: initial commit', exact: true }).click()
  await page.locator('.dshHistory__message').filter({ hasText: 'test: initial commit' }).waitFor()
  pass('working, staged and commit-history views load their distinct contents')
  await page.route('**/api/desktopChanges/listChanges', route => route.fulfill({ status: 503, body: 'temporary test failure' }), { times: 1 })
  await source('当前会话'); await panel().getByRole('alert').waitFor()
  await panel().getByRole('button', { name: '重试', exact: true }).click(); await file().waitFor()
  pass('temporary RPC failure exposes Retry and recovers')
  await page.evaluate(() => window.__REMOTE_CHANGES_SMOKE__.sidebarRight.openTab('desktop-changes'))
  await file().waitFor(); await file().click(); await added('staged change')
  if (!desktop) {
    await page.setViewportSize({ width: 390, height: 844 })
    await panel().waitFor()
    await page.screenshot({ path: join(root, 'remote-changes-mobile.png') })
    assert.equal(await panel().evaluate(node => node.scrollWidth <= node.clientWidth + 1), true)
  }
  pass('another Changes tab opens correctly and the file diff fits the remote viewport')
  const next = await page.evaluate(async path => {
    const ctx = window.__REMOTE_CHANGES_SMOKE__, workspace = await ctx.workspaces.create({ path })
    const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId }); ctx.uiWorkspace.openSession(id); ctx.sidebarRight.openTab('desktop-changes'); return id
  }, workspace)
  assert.notEqual(next, sessionId)
  await panel().getByText('尚无已记录的文件更改', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  pass('new sessions show the correct empty state with no browser errors')
  report.ok = true
} catch (error) {
  report.error = error.stack; report.browserErrors = errors
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
    await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText().catch(() => ''))
  }
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); await writeFile(join(root, 'host.log'), output)
  await browser?.close()
  if (child && child.exitCode === null) { child.kill(); await sleep(500) }
  console.log(JSON.stringify(report, null, 2))
}
