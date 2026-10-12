/** Real changed-file menus, resource tabs and restoration in an isolated DSH. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SnapshotStore } from '../dsh-plugin/sidebar-changes/host/snapshot-store.mjs'
import { hash, absent } from '../dsh-plugin/sidebar-changes/host/paths.mjs'
import { git } from '../dsh-plugin/sidebar-changes/host/git-provider.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/changes-file-menu-'))
const home = join(root, 'home'), workspace = join(root, 'workspace'), probe = join(root, 'probe'), snapshots = join(root, 'changes')
await Promise.all([home, workspace, probe].map(path => mkdir(path)))
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
const first = '中文 # % 文件.ts', second = 'other.txt', deleted = 'removed.txt'
const before = 'const value = "before";\n', recorded = 'const value = "recorded";\n', working = 'const value = "working";\n'
await git(workspace, ['init']); await git(workspace, ['config', 'user.email', 'test@example.invalid']); await git(workspace, ['config', 'user.name', 'Test'])
for (const [name, text] of [[first, before], [second, 'other before\n'], [deleted, 'removed\n']]) await writeFile(join(workspace, name), text)
await git(workspace, ['add', '.']); await git(workspace, ['commit', '-m', 'base'])
await writeFile(join(workspace, first), recorded); await git(workspace, ['add', first]); await writeFile(join(workspace, first), working)
await writeFile(join(workspace, second), 'other after\n'); await unlink(join(workspace, deleted))
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/changes-menu-smoke', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar-right', '@dsh-desktop/sidebar-changes'] } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}\n')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/changes-menu-smoke',factory:()=>({inject:['sessions','workspaces','uiWorkspace','sidebarRight','remote','remote.session','slots'],apply(ctx){window.__CHANGES_MENU__=ctx}})})`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: changes-menu-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
await writeFile(join(root, 'patch.yml'), patch)
let child, browser, page, output = ''
const report = { root, checks: [] }, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const pass = text => { report.checks.push(text); console.log('PASS: ' + text) }
try {
  child = spawn(process.execPath, [dshBin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--port', '0'], { cwd: workspace, windowsHide: true,
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_CHANGES_DIR: snapshots }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  let url
  for (let i = 0; i < 400; i++) { url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]; if (url) break; if (child.exitCode !== null) throw Error(output); await sleep(100) }
  assert.ok(url)
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = [], nativeCalls = []
  page.on('pageerror', error => errors.push(error.message))
  // Stub only native desktop actions; file reads and all diffs use the real Host.
  for (const method of ['canOpenWorkspacePath', 'workspacePathApplications', 'openWorkspacePath']) {
    await page.route('**/api/session/' + method, async route => {
      const request = route.request().postDataJSON()
      const value = method === 'canOpenWorkspacePath' ? true : method === 'workspacePathApplications'
        ? [{ id: 'code', name: 'VS Code', default: true, icon: null }, { id: 'notepad', name: 'Notepad', default: false, icon: null }]
        : { opened: true }
      if (method === 'openWorkspacePath') nativeCalls.push(request.payload.args.request)
      await route.fulfill({ json: { type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } } })
    })
  }
  await page.addInitScript(() => { window.__MENU_PROVIDERS__ = new Map(); window.__DSH_UI_STATE__ = { registerProvider(id, provider) { window.__MENU_PROVIDERS__.set(id, provider); return () => window.__MENU_PROVIDERS__.delete(id) } } })
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.__CHANGES_MENU__))
  await page.getByRole('button', { name: '继续', exact: true }).waitFor()
  await page.waitForFunction(() => {
    for (const button of document.querySelectorAll('button')) {
      if (button.textContent.trim() === '稍后配置') return true
      if (['继续', '我知道了'].includes(button.textContent.trim())) button.click()
    }
    return false
  })
  await page.getByRole('button', { name: '稍后配置', exact: true }).click()
  const sessionId = await page.evaluate(async workspace => {
    const ctx = window.__CHANGES_MENU__, work = await ctx.workspaces.create({ path: workspace })
    const id = await ctx.sessions.create({ workspaceId: work.workspaceId }); await ctx.uiWorkspace.openSession(id)
    ctx.sessions.binding(id).session.beginSubmission({ mode: 'queue', text: 'Changed file menu preview', attachments: [] })
    document.documentElement.removeAttribute('data-dsh-browser')
    const handle = ctx.slots.entriesOfSlot('rightbar.session')[0].store
    ctx.slots.resolveStore(handle, { key: id, ctx: ctx.sessions.scope(id) }).actions.setMode(id, 'push')
    ctx.slots.entriesOfSlot('root')[0].store.create().actions.setRightbar(650)
    return id
  }, workspace)
  const store = new SnapshotStore(snapshots), endpoint = text => ({ exists: true, text, hash: hash(text), reason: null, mode: null })
  for (const [name, a, b] of [[first, before, recorded], [second, 'other before\n', 'other after\n'], [deleted, 'removed\n', null]]) {
    await store.finish({ sessionId, root: workspace }, name, [{ path: name, author: sessionId, callId: 'fixture', sequence: 0, origin: 'structured', finalStatus: 'success', execution: name,
      before: endpoint(a), after: b === null ? absent() : endpoint(b) }])
  }
  await page.evaluate(() => window.__CHANGES_MENU__.sidebarRight.openTab('desktop-changes'))
  await page.locator('.dshChanges__file').first().waitFor()
  const listAddress = await page.evaluate(() => window.__CHANGES_MENU__.sidebarRight.active().contentId)
  const panel = () => page.locator('.dshChanges[data-source]:not(.dshChangeFile):visible')
  const row = name => panel().locator('.dshChanges__file').filter({ hasText: name })
  const menu = () => page.locator('.dshChanges__fileMenu:visible')
  const item = name => menu().getByRole('menuitem', { name, exact: true })
  const nativeClick = async target => {
    const response = page.waitForResponse('**/api/session/openWorkspacePath')
    await target.click(); await response
  }
  const openMenu = async name => { await row(name).click({ button: 'right' }); await item('查看更改').waitFor() }
  const back = async () => { await page.evaluate(address => window.__CHANGES_MENU__.sidebarRight.openResource(address), listAddress); await row(first).waitFor() }
  await openMenu(first)
  assert.deepEqual(await menu().getByRole('menuitem').allTextContents(), ['打开文件', '查看更改', '展开更改', '打开', '在资源管理器中打开'])
  await item('展开更改').click(); assert.equal(await row(first).getAttribute('aria-expanded'), 'true')
  await openMenu(first); await item('收起更改').click(); assert.equal(await row(first).getAttribute('aria-expanded'), 'false')
  await row(first).focus(); await page.keyboard.press('Shift+F10'); await item('查看更改').waitFor()
  await page.keyboard.press('Escape'); assert.equal(await row(first).evaluate(node => node === document.activeElement), true)
  pass('right-click order, expand/collapse, Shift+F10 and Escape focus return')
  await openMenu(first); await item('打开').hover(); await nativeClick(page.getByRole('menuitem', { name: 'VS Code（默认）', exact: true }))
  assert.deepEqual(nativeCalls.at(-1), { path: join(workspace, first), application: 'code' })
  await openMenu(first); await nativeClick(item('在资源管理器中打开'))
  assert.deepEqual(nativeCalls.at(-1), { path: join(workspace, first), action: 'reveal' })
  pass('same file association list as the native open button; explicit application and Explorer target the exact file')
  await openMenu(first); await item('打开文件').click()
  await page.locator('.dshFileEditor:visible .cm-content').waitFor()
  assert.match(await page.locator('.dshFileEditor:visible .cm-content').innerText(), /working/)
  await page.evaluate(() => { const side = window.__CHANGES_MENU__.sidebarRight; side.close(side.active().id) })
  await back()
  pass('open file creates an editor tab using the current on-disk content and encoded filename')
  const detailAddresses = []
  for (const [label, source, text] of [['当前会话', 'session', 'recorded'], ['未提交', 'working', 'working'], ['暂存区', 'staged', 'recorded']]) {
    await back(); await panel().getByRole('button', { name: '更改范围', exact: true }).click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
    await row(first).waitFor(); await openMenu(first); await item('查看更改').click()
    const detail = page.locator('.dshChangeFile:visible')
    await detail.locator('.dshChanges__line[data-kind="+"] code').first().waitFor()
    assert.equal(await detail.getAttribute('data-source'), source)
    assert.match(await detail.locator('.dshChanges__line[data-kind="+"] code').first().innerText(), new RegExp(text))
    assert.equal(await detail.locator('.dshChanges__file').count(), 0)
    detailAddresses.push(await page.evaluate(() => window.__CHANGES_MENU__.sidebarRight.active().contentId))
  }
  assert.equal(new Set(detailAddresses).size, 3)
  pass('dedicated tabs preserve session/worktree/index differences and do not replace the changes list')
  const saved = await page.evaluate(() => window.__MENU_PROVIDERS__.get('desktop-changes').capture())
  assert.equal(saved.sides[0].tabs.filter(tab => tab.address.startsWith('dsh-resource://desktop-change/')).length, 3)
  await page.evaluate(async saved => {
    const ctx = window.__CHANGES_MENU__, side = ctx.sidebarRight
    const ids = side.openTabs.getSnapshot().filter(tab => tab.contentId?.startsWith('dsh-resource://desktop-change/')).map(tab => tab.tabId)
    for (const id of ids) side.close(id)
    await window.__MENU_PROVIDERS__.get('desktop-changes').restore(saved)
  }, saved)
  await page.locator('.dshChangeFile:visible .dshChanges__line').first().waitFor()
  assert.equal(await page.locator('.dshChangeFile:visible').getAttribute('data-source'), 'staged')
  pass('snapshot restores independent file review tabs with the selected scope')
  await back(); await panel().getByRole('button', { name: '更改范围', exact: true }).click(); await page.getByRole('menuitem', { name: '当前会话', exact: true }).click()
  await openMenu(deleted); assert.equal(await item('打开文件').isDisabled(), true)
  await nativeClick(item('在资源管理器中打开'))
  assert.deepEqual(nativeCalls.at(-1), { path: workspace, action: 'reveal' })
  await openMenu(deleted); await item('查看更改').click(); await page.locator('.dshChangeFile:visible .dshChanges__line[data-kind="-"]').first().waitFor()
  pass('deleted files retain a separate diff and reveal their containing folder')
  await back(); await openMenu(first); await item('打开').hover(); await page.getByRole('menuitem', { name: 'Notepad', exact: true }).waitFor()
  await page.screenshot({ path: join(root, 'menu-light.png') })
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await page.screenshot({ path: join(root, 'menu-dark.png') })
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
  await page.evaluate(address => window.__CHANGES_MENU__.sidebarRight.openResource(address), detailAddresses[0])
  await page.locator('.dshChangeFile:visible .dshChanges__line').first().waitFor()
  await page.screenshot({ path: join(root, 'file-diff-dark.png') })
  assert.deepEqual(errors, [])
  report.ok = true
} catch (error) {
  report.error = error.stack; process.exitCode = 1
  if (page) { await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {}); await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText().catch(() => '')) }
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); await writeFile(join(root, 'host.log'), output)
  await browser?.close()
  if (child && child.exitCode === null) { child.kill(); await sleep(500) }
  console.log(JSON.stringify(report, null, 2))
}
