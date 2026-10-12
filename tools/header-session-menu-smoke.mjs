/** Check shared header/sidebar session actions in an isolated DSH profile. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/header-menu-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home)
await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: on\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/motion-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({ id: '@dsh-desktop/motion-smoke',
  factory: require => ({ inject: ['configForms', 'slots', 'sessions', 'workspaces', 'uiWorkspace', 'sidebarRight'],
    apply(ctx) { window.__MOTION_SMOKE__ = ctx; window.__MENU_REACT__ = require("react"); window.__MENU_PRIMITIVES__ = require("@deepseek-ai/dsh-client-ui-primitives") } }) })`)
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

const errors=[]
try {
 let url
 for(let i=0;i<300;i++){url=output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1];if(url)break;if(child.exitCode!==null)throw Error(output.slice(-2000));await sleep(100)}
 assert.ok(url)
 browser=await chromium.launch({channel:'msedge',headless:true})
 page=await browser.newPage({viewport:{width:1280,height:840}})
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/open-in-app/apps',route=>route.fulfill({json:{apps:['explorer','vscode']}}))
 await page.goto(url)
 await page.waitForFunction(()=>window.__MOTION_SMOKE__?.configForms.get('desktop-appearance').getSnapshot().status==='ready')
 await page.getByRole('button',{name:'继续',exact:true}).waitFor()
 for(const name of ['继续','我知道了','稍后配置']){const b=page.getByRole('button',{name,exact:true});if(await b.count()){await b.click();await page.waitForTimeout(350)}}
 if(await page.locator('[data-shortcut-modal="settings"]').count())await page.keyboard.press('Escape')
 await page.addLocatorHandler(page.getByRole('button',{name:'稍后配置',exact:true}),b=>b.click())
 await page.waitForTimeout(300)
 const ids=await page.evaluate(async path=>{
  const c=window.__MOTION_SMOKE__,w=await c.workspaces.create({path}),ids=[]
  for(const title of ['Header A','Header B']){
   const id=await c.sessions.create({workspaceId:w.workspaceId});c.uiWorkspace.openSession(id)
   await c.sessions.binding(id).session.rename(title)
   c.sessions.binding(id).session.beginSubmission({mode:'queue',text:title,attachments:[]});ids.push(id)
  }
  c.uiWorkspace.openSession(ids[0]);c.sessions.binding(ids[0]).session.beginSubmission({mode:'queue',text:'Header A',attachments:[]});window.__menuCalls=[]
  window.__TAURI__={core:{invoke:async(command,args)=>{window.__menuCalls.push({command,args});return null}}}
  return ids
 },root)
 const trigger=page.getByRole('button',{name:'更多操作',exact:true})
 const menu=page.locator('[role="menu"][data-dsh-header-session-id]:not([data-dsh-ghost])')
 async function open(){await trigger.click();await menu.waitFor();await menu.locator('[data-dsh-desktop="reveal-item"]').waitFor()}
 async function close(){await page.keyboard.press('Escape');await page.waitForTimeout(220)}
 const labels=()=>menu.locator('[role="menuitem"]').allTextContents()
 await open()
 assert.deepEqual((await labels()).map(x=>x.replace(/Ctrl[^\n]*/, '').trim()),['置顶会话','重命名','分叉会话','归档会话','复制...','打开…','下载 Session 日志','反馈'])
 assert.equal(await menu.locator('[data-dsh-header-menu-divider]').count(),1)
 assert.equal(await menu.evaluate(n=>{const d=n.querySelector('[data-dsh-header-menu-divider]');return !!(d.compareDocumentPosition([...n.querySelectorAll('[role="menuitem"]')].find(x=>x.textContent.includes('下载 Session'))) & Node.DOCUMENT_POSITION_FOLLOWING)}),true)
 await page.screenshot({path:join(root,'header-menu-light.png')})
 await menu.getByRole('menuitem',{name:/^置顶会话/}).click()
 await open()
 await menu.getByRole('menuitem',{name:/^取消置顶/}).waitFor()
 pass('all sidebar actions and both submenus precede a separator and the original two actions; pin state stays live')
 await menu.getByRole('menuitem',{name:/^重命名/}).click()
 const dialog=page.getByRole('dialog')
 await dialog.waitFor()
 assert.equal(await dialog.locator('input').inputValue(),'Header A')
 await page.keyboard.press('Escape');await page.waitForTimeout(220)
 pass('rename uses the real sidebar dialog with the current session title')
 await open()
 await menu.getByRole('menuitem',{name:'复制...',exact:true}).click()
 const copyMenu=page.locator('[data-dsh-desktop="copy-submenu"]')
 await copyMenu.waitFor({state:'visible'})
 assert.deepEqual(await copyMenu.getByRole('menuitem').allTextContents(),['复制深度链接','复制会话内容','保存会话内容'])
 await copyMenu.getByRole('menuitem',{name:'复制深度链接',exact:true}).click()
 await page.waitForFunction(link=>window.__menuCalls.some(x=>x.command==='clipboard_write_text' && x.args.text===link),'deepseekharness://session/'+ids[0].replace(/^session-/,''))
 await page.waitForTimeout(220)
 pass('copy submenu uses the same actions and the current session id')
 await page.evaluate(id=>{const c=window.__MOTION_SMOKE__;c.uiWorkspace.openSession(id);c.sessions.binding(id).session.beginSubmission({mode:'queue',text:'Header B',attachments:[]})},ids[1]);await page.waitForTimeout(300)
 await open()
 await menu.getByRole('menuitem',{name:/^置顶会话/}).waitFor()
 assert.equal(await menu.getAttribute('data-dsh-header-session-id'),ids[1])
 await menu.getByRole('menuitem',{name:'打开…',exact:true}).hover()
 await page.waitForTimeout(150)
 assert.equal(await page.getByRole('menuitem',{name:'文件资源管理器',exact:true}).isVisible(),true)
 await close()
 pass('switching sessions updates actions and keeps the open-app submenu available')
 await page.evaluate(()=>{
  const c=window.__MOTION_SMOKE__,React=window.__MENU_REACT__,p=window.__MENU_PRIMITIVES__
  window.__removeMenuContribution=c.slots.register({name:'sidebar.workspaces.session.menu.item',id:'header-smoke',order:250},function Extra(props){const [,close]=props.useMenuOpenState();return React.createElement(p.MenuItemButton,{onSelect(){window.__menuCalls.push({command:'extra',id:props.sessionId});close(false)}},'扩展会话操作')})
 })
 await open()
 await menu.getByRole('menuitem',{name:'扩展会话操作',exact:true}).click()
 assert.equal(await page.evaluate(()=>window.__menuCalls.find(x=>x.command==='extra').id),ids[1])
 await page.evaluate(()=>window.__removeMenuContribution())
 await page.waitForTimeout(220)
 pass('later sidebar menu contributions are mirrored with their original callback and close behavior')
 await open();await trigger.press('ArrowDown')
 assert.match(await page.evaluate(()=>document.activeElement.textContent),/^置顶会话/)
 await page.keyboard.press('End')
 assert.equal(await page.evaluate(()=>document.activeElement.textContent),'反馈')
 await close()
 await page.evaluate(()=>window.__MOTION_SMOKE__.configForms.get('ui-theme').set('preference','dark'))
 await open();await page.screenshot({path:join(root,'header-menu-dark.png')});await close()
 await page.setViewportSize({width:390,height:844});await open()
 const box=await menu.boundingBox();assert.ok(box.x>=0 && box.x+box.width<=390 && box.y+box.height<=844)
 await page.screenshot({path:join(root,'header-menu-mobile.png')});await close()
 pass('keyboard traversal and light/dark/mobile layouts include the complete menu')
 await page.setViewportSize({width:1280,height:840})
 await page.evaluate(()=>window.__MOTION_SMOKE__.configForms.get('desktop-appearance').set('ui','vanilla'))
 await page.waitForTimeout(250);await trigger.click()
 assert.equal(await page.locator('[data-dsh-header-menu-items]').count(),0)
 await close()
 await page.evaluate(()=>window.__MOTION_SMOKE__.configForms.get('desktop-appearance').set('ui','desktop'))
 await page.waitForTimeout(250);await open()
 assert.equal(await menu.locator('[data-dsh-header-menu-divider]').count(),1)
 await close()
 assert.equal(await page.locator('[data-slot-error]').count(),0)
 assert.deepEqual(errors,[])
 pass('vanilla round trip restores the original menu and reapplies the shared menu without duplicates or errors')
} catch(error) {
 report.error=error.stack
 if(page)await page.screenshot({path:join(root,'failure.png')}).catch(()=>{})
 throw error
} finally {
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
 await browser?.close()
 if(child.exitCode===null)execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})
 console.log('Report: '+root)
}
