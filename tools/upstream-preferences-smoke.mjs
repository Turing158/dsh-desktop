/** Real DSH shell preferences and keyboard routing in an isolated backend and Edge page.
 * Usage: node tools/upstream-preferences-smoke.mjs
 * DSH_DESKTOP_DSH_BIN and PLAYWRIGHT_PATH can select another installed runtime.
 * No user profile or running desktop process is touched.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/upstream-preferences-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home); await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), `desktop-appearance:
  animation: off
  ui: desktop
  fontSizeOverride: 10
desktop-terminal-dock:
  layout: { height: 312, collapsed: false }
  profileId: auto
  position: bottom
`)
await writeFile(join(probe, 'package.json'), JSON.stringify({
  name: '@dsh-desktop/settings-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' },
  dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings'] } },
}))
await writeFile(join(probe, 'index.js'), 'export function apply() {}\n')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({
  id: '@dsh-desktop/settings-smoke',
  factory: () => ({ inject: ['configForms', 'slots', 'sessions', 'workspaces', 'uiWorkspace', 'sidebarRight', 'webTerminals'], apply(ctx) { window.__SETTINGS_SMOKE__ = ctx } }),
})\n`)
const originalPatch = await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')
const patch = originalPatch.replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: desktop-settings-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)

let child, browser, output = ''
const report = { version: JSON.parse(await readFile(resolve(dshBin, '../../package.json'), 'utf8')).version, root, checks: {} }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function start() {
  output = ''
  child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin },
  })
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  for (let i = 0; i < 300; i++) {
    const url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) return url
    if (child.exitCode !== null) throw Error('DSH exited: ' + output.slice(-4000))
    await sleep(100)
  }
  throw Error('DSH did not become ready: ' + output.slice(-4000))
}
function stop() {
  if (!child || child.exitCode !== null) return
  const pid = child.pid
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch (error) {
    // The process can exit between the exitCode check and taskkill.
    try { process.kill(pid, 0) } catch (probe) { if (probe.code === 'ESRCH') { child = null; return } }
    throw error
  }
  child = null
}
async function ready(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => {
    if (document.body.textContent.includes('Failed to load plugins')) throw Error(document.body.textContent)
    const forms = window.__SETTINGS_SMOKE__?.configForms
    return forms && ['desktop-appearance', 'desktop-terminal-dock'].every(ns => forms.get(ns).getSnapshot().status === 'ready')
  }, undefined, { timeout: 30000 })
}
async function values(page) {
  return page.evaluate(() => {
    const forms = window.__SETTINGS_SMOKE__.configForms
    return Object.fromEntries(['desktop-appearance', 'desktop-terminal-dock'].map(ns => [ns, forms.get(ns).getSnapshot().value]))
  })
}
try {
  const firstUrl = await start()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  await page.addInitScript(()=>{window.__TAURI__={core:{Channel:class{},invoke:async cmd=>cmd==='terminal_list'||cmd==='terminal_profiles'?[]:cmd==='window_is_maximized'?false:undefined},app:{getVersion:async()=> 'test'}};window.__DSH_UI_BOOT__={smoke:true}})
  await page.addLocatorHandler(page.getByRole('button',{name:'稍后配置',exact:true}),async b=>b.click())
  await page.addLocatorHandler(page.getByRole('button',{name:'继续',exact:true}).and(page.locator(':enabled')),async b=>b.click())
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await ready(page, firstUrl)
  await page.waitForFunction(()=>window.__DSH_UPSTREAM_DOCK_SMOKE__)
  const rowCount=()=>page.evaluate(()=>window.__SETTINGS_SMOKE__.slots.entriesOfSlot('settings.general.item').filter(e=>String(e.options.id).startsWith('desktop-terminal-')).length)
  assert.equal(await rowCount(),2)
  await page.evaluate(async root=>{const ctx=window.__SETTINGS_SMOKE__;const w=await ctx.workspaces.create({path:root});const id=await ctx.sessions.create({workspaceId:w.workspaceId});ctx.uiWorkspace.openSession(id)},root)
  await page.waitForFunction(()=>window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().workspaceKey)
  await page.getByRole('button',{name:'稍后配置',exact:true}).click({timeout:3000}).catch(()=>{})
  const shells=await page.evaluate(()=>{const c=window.__SETTINGS_SMOKE__;return c.webTerminals.launchShells(c.sidebarRight.mounted.getSnapshot())})
  assert.ok(shells.shells.length)
  const chosen=shells.shells[0].path
  await page.locator('button[aria-haspopup="dialog"]').first().evaluate(e=>e.click())
  await page.getByRole('button',{name:'默认终端类型',exact:true}).click()
  await page.getByText(shells.shells[0].name,{exact:true}).last().click()
  await page.waitForFunction(path=>window.__SETTINGS_SMOKE__.configForms.get('desktop-terminal-dock').getSnapshot().value.shellPath===path,chosen)
  await page.keyboard.press('Escape')
  if(await page.locator('[data-shortcut-modal="settings"]').count()) {
    await page.locator('[data-slot="settings.close"] button').click()
    await page.locator('[data-shortcut-modal="settings"]').waitFor({state:'detached'})
  }
  await page.evaluate(()=>document.querySelector('[data-dsh-terminal-dock-toggle]').click())
  await page.waitForFunction(()=>{const d=window.__DSH_UPSTREAM_DOCK_SMOKE__,t=d.dock.getSnapshot().tabs[0];window.prefModel=t&&d.registry.view(t)?.model;return prefModel?.state.getSnapshot().writable})
  assert.equal(await page.evaluate(()=>prefModel.shellPath),chosen)
  await page.evaluate(()=>prefModel.write('echo DSH_PREFERENCE_OK_218\r'))
  await page.waitForFunction(()=>(document.querySelector('[data-dsh-terminal-dock] .xterm-rows')?.textContent||'').split('DSH_PREFERENCE_OK_218').length>=3)
  console.log('PASS: General shell selection starts a real built-in terminal in the bottom dock')
  await page.getByRole('button',{name:'新建终端',exact:true}).click()
  await page.waitForFunction(()=>window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().tabs.length===2)
  await page.waitForFunction(()=>{const d=window.__DSH_UPSTREAM_DOCK_SMOKE__;window.secondModel=d.registry.view(d.dock.getSnapshot().tabs[1]).model;return secondModel.state.getSnapshot().writable})
  const titles=['前端开发服务','构建 <preview> & 测试 / '+'自定义长标题'.repeat(12)]
  const identities=await page.evaluate(()=>window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().tabs.map(t=>t.contentId))
  await page.evaluate(async titles=>{await prefModel.rename(titles[0]);await secondModel.rename(titles[1])},titles)
  await page.waitForFunction(titles=>JSON.stringify([...document.querySelectorAll('.dshTerminalDock__title')].map(e=>e.textContent))===JSON.stringify(titles),titles)
  assert.ok((await page.locator('.dshTerminalDock__label').first().getAttribute('title')).startsWith(titles[0]+'\n'))
  assert.ok((await page.locator('.dshTerminalDock__label').last().getAttribute('aria-label')).startsWith(titles[1]+'\n'))
  assert.equal(await page.locator('.dshTerminalDock__close').last().getAttribute('aria-label'),'关闭'+titles[1])
  assert.ok(await page.locator('.dshTerminalDock__title').last().evaluate(e=>e.scrollWidth>e.clientWidth&&getComputedStyle(e).textOverflow==='ellipsis'),'long title is ellipsized')
  await page.locator('.dshTerminalDock__label').first().focus()
  await page.waitForFunction(title=>document.querySelector('#dsh-terminal-dock-tip')?.textContent.startsWith(title+'\n'),titles[0])
  await page.evaluate(()=>{const d=window.__DSH_UPSTREAM_DOCK_SMOKE__.dock;d.collapse(true);d.open();d.activate(d.getSnapshot().tabs[0].contentId)})
  assert.deepEqual(await page.locator('.dshTerminalDock__title').allTextContents(),titles)
  assert.deepEqual(await page.evaluate(()=>window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().tabs.map(t=>t.contentId)),identities,'rename never recreates a terminal')
  console.log('PASS: custom titles update active and inactive dock tabs, tooltips and accessible names without recreating terminals')
  await page.locator('.dshTerminalDock__close').first().click()
  assert.equal(await page.evaluate(()=>window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().collapsed),false,'a remaining terminal keeps the dock open')
  for(const action of ['button','keyboard','menu']) {
    const previous=await page.evaluate(()=>window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().active)
    if(action==='button') await page.locator('.dshTerminalDock__close').click()
    else if(action==='keyboard') {
      await page.locator('.dshTerminalDock [role=tab]').focus()
      await page.keyboard.press('Delete')
    } else {
      await page.locator('.dshTerminalDock [role=tab]').click({button:'right'})
      await page.getByRole('menuitem',{name:'关闭',exact:true}).click()
    }
    await page.waitForFunction(()=>{const s=window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot();return s.collapsed&&s.tabs.length===0})
    await page.locator('[data-dsh-terminal-dock]').waitFor({state:'detached'})
    assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--dsh-terminal-dock-height').trim()),'0px')
    await page.waitForFunction(()=>document.activeElement?.hasAttribute('data-dsh-terminal-dock-toggle'))
    await page.getByRole('button',{name:'打开底部侧边栏',exact:true}).click()
    await page.waitForFunction(()=>{const d=window.__DSH_UPSTREAM_DOCK_SMOKE__,s=d.dock.getSnapshot();window.prefModel=s.tabs[0]&&d.registry.view(s.tabs[0])?.model;return !s.collapsed&&s.tabs.length===1&&prefModel?.state.getSnapshot().writable})
    assert.notEqual(await page.evaluate(()=>window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().active),previous)
    assert.equal(await page.evaluate(()=>prefModel.shellPath),chosen)
  }
  console.log('PASS: last-tab close via button, Delete and menu collapses the dock; reopening starts one fresh terminal')
  await page.evaluate(()=>window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.collapse(true))
  await page.keyboard.press('Control+Backquote')
  await page.waitForFunction(()=>!window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().collapsed)
  assert.equal(await page.evaluate(()=>window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().tabs.length),1)
  assert.equal(await page.evaluate(()=>window.__SETTINGS_SMOKE__.sidebarRight.openTabs.getSnapshot().filter(t=>t.kind==='terminal').length),0)
  const secondShell=shells.shells.at(-1).path
  await page.evaluate(path=>window.__SETTINGS_SMOKE__.configForms.get('desktop-terminal-dock').set('shellPath',path),secondShell)
  await page.evaluate(()=>window.__SETTINGS_SMOKE__.configForms.get('desktop-terminal-dock').set('position','right'))
  await page.keyboard.press('Control+Backquote')
  await page.waitForFunction(()=>window.__SETTINGS_SMOKE__.sidebarRight.openTabs.getSnapshot().filter(t=>t.kind==='terminal').length===1)
  const params=await page.evaluate(()=>{const c=window.__SETTINGS_SMOKE__,t=c.sidebarRight.openTabs.getSnapshot().find(t=>t.kind==='terminal');return c.sidebarRight.tabDomain.occurrence(t.sessionId,{id:t.tabId}).navigation.getSnapshot().params})
  assert.equal(params.shellPath,secondShell)
  await page.waitForFunction(()=>{const c=window.__SETTINGS_SMOKE__,t=c.sidebarRight.openTabs.getSnapshot().find(t=>t.kind==='terminal');if(!t)return false;const nav=c.sidebarRight.tabDomain.occurrence(t.sessionId,{id:t.tabId}).navigation.getSnapshot();window.rightModel=c.webTerminals.view(t.sessionId,t.tabId,nav.address,nav.params?.terminalId,nav.params?.shellPath);return rightModel.state.getSnapshot().writable})
  assert.equal(await page.evaluate(()=>rightModel.shellPath),secondShell)
  await page.evaluate(()=>rightModel.write('echo DSH_RIGHT_PREF_OK_219\r'))
  await page.waitForFunction(()=>(document.querySelector('[data-sidebar-right-panel] .xterm-rows')?.textContent||'').split('DSH_RIGHT_PREF_OK_219').length>=3)
  assert.equal(await page.evaluate(()=>prefModel.shellPath),chosen,'existing shell does not change')
  console.log('PASS: Ctrl+backquote obeys bottom/right preferences with no duplicate terminal')
  await page.evaluate(async()=>{await rightModel.rename('右侧自定义终端');await prefModel.rename('底部自定义终端')})
  await page.locator('[data-sidebar-right-panel] [data-dockkit-tab]').filter({hasText:'右侧自定义终端'}).waitFor()
  await page.waitForFunction(()=>document.querySelector('.dshTerminalDock__title')?.textContent==='底部自定义终端')
  await page.screenshot({path:join(root,'terminals.png'),fullPage:true})
  const expected=(await values(page))['desktop-terminal-dock']
  await page.reload();await ready(page,page.url())
  await page.waitForFunction(()=>window.__DSH_UPSTREAM_DOCK_SMOKE__)
  assert.deepEqual((await values(page))['desktop-terminal-dock'],expected)
  assert.equal(await rowCount(),2)
  await page.waitForFunction(()=>window.__SETTINGS_SMOKE__.sidebarRight.mounted.getSnapshot())
  await page.evaluate(()=>window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.open())
  await page.waitForFunction(()=>document.querySelector('.dshTerminalDock__title')?.textContent==='底部自定义终端')
  await page.locator('[data-sidebar-right-panel] [data-dockkit-tab]').filter({hasText:'右侧自定义终端'}).waitFor()
  console.log('PASS: right and bottom custom titles survive page reload')
  await page.evaluate(()=>{const d=window.__DSH_UPSTREAM_DOCK_SMOKE__.dock;for(const t of d.getSnapshot().tabs)d.close(t.contentId);const c=window.__SETTINGS_SMOKE__;for(const t of c.sidebarRight.openTabs.getSnapshot())if(t.kind==='terminal')c.sidebarRight.close(t.tabId)})
  assert.deepEqual(pageErrors,[])
  console.log('PASS: persisted shell and position reload with exactly two settings rows')
  report.checks={settings:true,shell:true,titles:true,closeLastAndReopen:true,position:true,reload:true,noPageErrors:true}
} catch (error) {
  report.error = error.stack
  throw error
} finally {
  await writeFile(join(root, 'last-host.log'), output)
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  stop()
  console.log('Evidence: ' + join(root, 'report.json'))
}
