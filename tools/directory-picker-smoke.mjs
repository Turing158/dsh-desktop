/** Exercise the shipped slots and RPC with a real isolated DSH + Edge. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/directory-picker-smoke-'))
const home = join(root, 'home'), workspace = join(root, 'workspace'), probe = join(root, 'probe')
await Promise.all([home, workspace, probe, join(workspace, '子目录 A'), join(workspace, '子目录 B'), join(workspace, '.hidden')].map(path => mkdir(path, { recursive: true })))
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/directory-smoke', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@dsh-desktop/directory-picker'] } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}\n')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/directory-smoke',factory:()=>({inject:['slots','uiWorkspace','remote','remote.desktopDirectoryPicker','locale'],apply(ctx){window.__DIRECTORY_SMOKE__=ctx}})})`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  // Compose the same pair used for remote access, with a loopback-only test server.
  + '\n- id: directory-picker\n  disabled: true\n- insert:\n    - id: directory-smoke-host\n      name: "@deepseek-ai/dsh-host-directory-picker-browse"\n    - id: directory-smoke-ui\n      name: "@deepseek-ai/dsh-client-ui-directory-picker-browse"\n'
  + '\n- insert:\n    - id: directory-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
await writeFile(join(root, 'patch.yml'), patch)
let child, browser, page, output = ''
const report = { root, checks: [] }, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  child = spawn(process.execPath, [dshBin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--port', '0'], { cwd: workspace, windowsHide: true,
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_CHANGES_DIR: join(root, 'changes') }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  let url
  for (let i = 0; i < 400; i++) { url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]; if (url) break; if (child.exitCode !== null) throw Error(output); await sleep(100) }
  if (!url) throw Error(output)
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.__DIRECTORY_SMOKE__), undefined, { timeout: 40000 })
  await page.getByRole('button', { name: '继续', exact: true }).waitFor()
  await page.waitForFunction(() => {
    for (const button of document.querySelectorAll('button')) {
      if (button.textContent.trim() === '稍后配置') return true
      if (['继续', '我知道了'].includes(button.textContent.trim())) button.click()
    }
    return false
  })
  await page.getByRole('button', { name: '稍后配置', exact: true }).click()
  const dialog = () => page.getByRole('dialog', { name: '选择工作区目录', exact: true })
  const button = name => dialog().getByRole('button', { name, exact: true })
  const location = () => dialog().locator('.dshDirectory__list')
  const at = async path => { await page.waitForFunction(path => document.querySelector('.dshDirectory__list')?.dataset.location === path
    && document.querySelector('.dshDirectory__list')?.getAttribute('aria-busy') === 'false', path) }
  const go = async path => { await dialog().getByRole('combobox', { name: '文件夹路径' }).fill(path); await button('转到').click(); await at(path) }
  await page.getByRole('button', { name: '选择工作区', exact: true }).click()
  await page.getByRole('menuitem', { name: '添加工作区…', exact: true }).click()
  await dialog().waitFor(); await location().filter({ has: page.locator('button') }).waitFor()
  const initial = await location().getAttribute('data-location')
  assert.ok(initial && initial !== 'desktop:roots')
  assert.equal(await button('后退').isDisabled(), true)
  assert.equal(await button('前进').isDisabled(), true)
  await dialog().getByRole('group', { name: '文件夹导航' }).getByRole('button', { name: '此电脑', exact: true }).click()
  await at('desktop:roots')
  assert.equal(await button('打开').isDisabled(), true)
  assert.equal(await button('上一级').isDisabled(), true)
  const roots = await page.evaluate(async () => (await window.__DIRECTORY_SMOKE__.remote.desktopDirectoryPicker.roots(new AbortController().signal)).value)
  assert.ok(roots.some(entry => entry.path === parse(workspace).root), JSON.stringify(roots))
  await button(parse(workspace).root).click(); await at(parse(workspace).root)
  await button('上一级').click(); await at('desktop:roots')
  await button('后退').click(); await at(parse(workspace).root)
  await button('前进').click(); await at('desktop:roots')
  await page.screenshot({ path: join(root, 'drives.png'), animations: 'disabled' })
  report.checks.push('real host drive list, drive roots, parent to drives, back and forward')
  await go(workspace)
  assert.equal(await button('前进').isDisabled(), true)
  assert.equal(await button('.hidden').count(), 0)
  await dialog().getByRole('checkbox', { name: '显示隐藏文件' }).check()
  await button('.hidden').waitFor()
  await button('子目录 A').click(); await at(join(workspace, '子目录 A'))
  await page.keyboard.press('Alt+ArrowUp'); await at(workspace)
  await button('后退').click(); await at(join(workspace, '子目录 A'))
  await button('前进').click(); await at(workspace)
  await mkdir(join(workspace, '刷新后出现'))
  await button('刷新').click(); await button('刷新后出现').waitFor()
  await button('后退').click(); await at(join(workspace, '子目录 A'))
  await button('前进').click(); await at(workspace)
  await dialog().getByRole('combobox', { name: '文件夹路径' }).fill(join(workspace, 'missing'))
  await button('转到').click(); await dialog().getByRole('alert').waitFor()
  assert.equal(await location().getAttribute('data-location'), workspace)
  assert.equal(await button('打开').isDisabled(), true)
  await button('刷新').click(); await at(workspace)
  await dialog().getByRole('alert').waitFor({ state: 'hidden' })
  report.checks.push('absolute paths, hidden folders, keyboard parent, refresh without history and failed navigation recovery')
  await button('新建文件夹').click()
  const create = page.getByRole('dialog', { name: '新建文件夹', exact: true })
  await create.getByRole('textbox', { name: '文件夹名称' }).fill('新文件夹')
  await create.getByRole('button', { name: '创建', exact: true }).click()
  await at(join(workspace, '新文件夹')); assert.ok((await stat(join(workspace, '新文件夹'))).isDirectory())
  await button('上一级').click(); await at(workspace)
  await page.screenshot({ path: join(root, 'folders-light.png'), animations: 'disabled' })
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await page.screenshot({ path: join(root, 'folders-dark.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 375, height: 750 })
  await page.screenshot({ path: join(root, 'folders-mobile.png'), animations: 'disabled' })
  const bounds = await dialog().evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: node.clientWidth, scroll: node.scrollWidth }))
  assert.ok(bounds.left >= 0 && bounds.right <= 375 && bounds.scroll <= bounds.width + 1, JSON.stringify(bounds))
  for (let i = 0; i < 20; i++) { await page.keyboard.press('Tab'); assert.ok(await dialog().evaluate(node => node.contains(document.activeElement))) }
  await button('打开').click(); await dialog().waitFor({ state: 'hidden' })
  report.checks.push('new folder, light/dark/mobile layout, focus trap and workspace adoption')
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.keyboard.press('Control+Alt+o'); await at(initial)
  assert.equal(await button('后退').isDisabled(), true)
  await button('取消').click(); await dialog().waitFor({ state: 'hidden' })
  // The hero uses the same public flow contract and must resolve to this extension too.
  const occupants = await page.evaluate(() => ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']
    .map(name => window.__DIRECTORY_SMOKE__.slots.entriesOfSlot(name).map(entry => entry.options.priority)))
  assert.ok(occupants.every(values => values.includes(-10)), JSON.stringify(occupants))
  const unauthorized = await fetch(new URL('/api/desktopDirectoryPicker/roots', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: {} }) })
  assert.ok([401, 403].includes(unauthorized.status))
  report.checks.push('reopening resets navigation; both owner slots registered; unauthenticated drive requests rejected')
  assert.deepEqual(errors, [])
  report.ok = true
} catch (error) {
  report.error = error.stack
  if (page) { await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {}); await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText().catch(() => '')) }
  throw error
} finally {
  await writeFile(join(root, 'host.log'), output)
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  if (child && child.exitCode === null) { child.kill(); await sleep(500) }
  console.log(JSON.stringify(report, null, 2))
}
