/** Check shared header/sidebar session actions in an isolated DSH profile. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { offlineModelPatch, handleOnboarding, dismissInitialWelcome } from './dsh-ui-helpers.mjs'

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
  + offlineModelPatch
  + '\n- insert:\n    - id: desktop-motion-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_UI_SMOKE_KEY: 'mock-key' },
})
let output = '', browser, page
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { root, checks: [] }
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }

const errors=[], launches=[]
try {
 let url
 for(let i=0;i<300;i++){url=output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1];if(url)break;if(child.exitCode!==null)throw Error(output.slice(-2000));await sleep(100)}
 assert.ok(url)
 browser=await chromium.launch({channel:'msedge',headless:true})
 page=await browser.newPage({viewport:{width:1280,height:840}})
 await handleOnboarding(page)
 page.on('pageerror',e=>errors.push(e.message))
 page.on('console',message=>{if(message.type()==='error'&&message.text().includes('slot entry crashed'))errors.push(message.text())})
 await page.route('**/open-in-app/apps',route=>route.fulfill({json:{apps:['explorer','vscode']}}))
 await page.route('**/open-in-app/open',route=>{launches.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}})})
 await page.goto(url)
 await page.waitForFunction(()=>window.__MOTION_SMOKE__?.configForms.get('desktop-appearance').getSnapshot().status==='ready')
 await dismissInitialWelcome(page)
 if(await page.locator('[data-shortcut-modal="settings"]').count())await page.keyboard.press('Escape')
 await page.waitForTimeout(300)
 const ids=await page.evaluate(async path=>{
  const c=window.__MOTION_SMOKE__,w=await c.workspaces.create({path}),ids=[]
  // Newer DSH publishes optimistic messages only after host admission. Project
  // that acceptance locally so this menu fixture never sends a model request.
  window.__showMenuSession=(id,text)=>{
   const session=c.sessions.binding(id).session
   const submission=session.beginSubmission({mode:'queue',text,attachments:[]})
   const settlement=session.submissionSettlements?.get(submission.requestId)
   if(settlement && session.refreshAcceptedSubmissions){settlement.accepted=true;session.promptAttempted=true;session.refreshAcceptedSubmissions();session.notifier.markDirty()}
  }
  for(const title of ['Header A','Header B']){
   const id=await c.sessions.create({workspaceId:w.workspaceId});c.uiWorkspace.openSession(id)
   await c.sessions.binding(id).session.rename(title)
   window.__showMenuSession(id,title);ids.push(id)
  }
  c.uiWorkspace.openSession(ids[0]);window.__showMenuSession(ids[0],'Header A');window.__menuCalls=[]
  window.__TAURI__={core:{invoke:async(command,args)=>{window.__menuCalls.push({command,args});return null}}}
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__menuCalls.push({command:'native-clipboard',text})}}})
  return ids
 },root)
 const trigger=page.getByRole('button',{name:'更多操作',exact:true})
 const menu=page.locator('[role="menu"][data-dsh-header-session-id]:not([data-dsh-ghost])')
 async function open(){await trigger.click();await menu.waitFor();await menu.locator('[data-dsh-desktop="reveal-item"]').waitFor()}
 async function close(){await page.keyboard.press('Escape');await page.waitForTimeout(220)}
 const labels=()=>menu.locator('[role="menuitem"]:visible').allTextContents()
 async function checkDividers(layout){
  await menu.evaluate(async n=>{await Promise.all(n.getAnimations().map(animation=>animation.finished.catch(()=>{})))})
  const near=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<.05,message)
  const geometry=await menu.evaluate(n=>{
   const rows=[...n.querySelectorAll('[role="menuitem"]')].map(item=>item.getBoundingClientRect()).filter(box=>box.height)
   return [...n.querySelectorAll('[role="separator"]')].map(divider=>{
    const box=divider.getBoundingClientRect(),style=getComputedStyle(divider)
    const before=rows.filter(row=>row.bottom<=box.top).at(-1),after=rows.find(row=>row.top>=box.bottom)
    return {x:box.x,width:box.width,height:box.height,color:style.backgroundColor,before:before&&box.top-before.bottom,after:after&&after.top-box.bottom}
   }).filter(box=>box.height)
  })
  report[layout+'Dividers']=geometry
  assert.equal(geometry.length,registryMenu?3:2,layout+': only group boundaries have dividers')
  for(const divider of geometry){
   near(divider.height,1,layout+': each divider is one pixel tall')
   near(divider.x,geometry[0].x,layout+': left edges align')
   near(divider.width,geometry[0].width,layout+': widths match')
   assert.equal(divider.color,geometry[0].color,layout+': colors match')
   near(divider.before,4,layout+': spacing above is uniform')
   near(divider.after,4,layout+': spacing below is uniform')
  }
 }
 const registryMenu=await page.evaluate(()=>Boolean(window.__MOTION_SMOKE__.get('contextMenus')?.resolve))
 await open()
 await checkDividers('light')
 assert.deepEqual((await labels()).map(x=>x.replace(/Ctrl[^\n]*/, '').trim()),registryMenu
  ? ['置顶会话','重命名','分叉会话','在文件夹显示','复制...','打开…','归档会话','下载 Session 日志','反馈']
  : ['置顶会话','重命名','分叉会话','归档会话','复制...','打开…','下载 Session 日志','反馈'])
 assert.equal(await menu.locator('[data-dsh-header-menu-divider]').count(),1)
 assert.equal(await menu.evaluate(n=>{const d=n.querySelector('[data-dsh-header-menu-divider]');return !!(d.compareDocumentPosition([...n.querySelectorAll('[role="menuitem"]')].find(x=>x.textContent.includes('下载 Session'))) & Node.DOCUMENT_POSITION_FOLLOWING)}),true)
 if(registryMenu){
  const headerLabels=(await labels()).map(x=>x.replace(/Ctrl[^\n]*/, '').trim())
  await close()
  await page.evaluate(id=>{
   const c=window.__MOTION_SMOKE__,state=c.sessions.list.getSnapshot()
   c.sessions.list.set({...state,byId:{...state.byId,[id]:{...state.byId[id],blank:false}}})
   c.get('layout').toggleSidebar()
  },ids[0])
  const row=page.locator('[role="treeitem"][data-row-key="session:'+ids[0]+'"]')
  await row.click({button:'right'})
  const sidebarMenu=page.locator('[role="menu"]:not([data-dsh-ghost])').filter({has:page.locator('[data-dsh-desktop="reveal-item"]')}).first()
  await sidebarMenu.waitFor()
  assert.deepEqual((await sidebarMenu.locator('[role="menuitem"]:visible').allTextContents()).map(x=>x.replace(/Ctrl[^\n]*/, '').trim()),headerLabels.slice(0,-2))
  await close();await page.evaluate(()=>window.__MOTION_SMOKE__.get('layout').toggleSidebar());await open()
  pass('header options match an actual sidebar right-click, followed only by download and feedback')
 }
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
 const title=page.locator('[data-dsh-session-title-rename]')
 await title.waitFor({timeout:5000})
 assert.equal(await title.textContent(),'Header A')
 await title.click()
 await dialog.waitFor()
 assert.equal(await dialog.locator('input').inputValue(),'Header A')
 await dialog.locator('input').fill('Header A renamed')
 await dialog.getByRole('button',{name:'重命名',exact:true}).click()
 await dialog.waitFor({state:'hidden'})
 await page.waitForFunction(id=>window.__MOTION_SMOKE__.sessions.list.getSnapshot().byId[id].displayTitle==='Header A renamed',ids[0])
 assert.equal(await title.textContent(),'Header A renamed')
 await title.focus();await page.keyboard.press('Enter');await dialog.waitFor()
 assert.equal(await dialog.locator('input').inputValue(),'Header A renamed')
 await page.keyboard.press('Escape');await page.waitForTimeout(220)
 await title.focus();await page.keyboard.press('Space');await dialog.waitFor()
 await page.keyboard.press('Escape');await page.waitForTimeout(220)
 pass('click, Enter and Space on the session title use the native rename dialog and update the displayed title')
 await open()
 await menu.getByRole('menuitem',{name:'复制...',exact:true}).click()
 const copyMenu=page.locator('[data-dsh-desktop="copy-submenu"]')
 await copyMenu.waitFor({state:'visible'})
 assert.deepEqual(await copyMenu.getByRole('menuitem').allTextContents(),['复制 Session ID','复制深度链接','复制会话内容','保存会话内容'])
 await menu.locator('[data-dsh-desktop="copy-id-source"]').waitFor({state:'attached'})
 assert.equal(await menu.locator('[data-dsh-desktop="copy-id-source"]').isVisible(),false)
 assert.equal(await menu.locator('[data-dsh-desktop="copy-id-source"]').isDisabled(),true)
 await copyMenu.getByRole('menuitem',{name:'复制 Session ID',exact:true}).click()
 await page.waitForFunction(id=>window.__menuCalls.some(x=>x.command==='native-clipboard'&&x.text===id),ids[0])
 await page.waitForTimeout(220)
 await open()
 await menu.getByRole('menuitem',{name:'复制...',exact:true}).click()
 await copyMenu.getByRole('menuitem',{name:'复制深度链接',exact:true}).click()
 await page.waitForFunction(link=>window.__menuCalls.some(x=>x.command==='clipboard_write_text' && x.args.text===link),'deepseekharness://session/'+ids[0].replace(/^session-/,''))
 await page.waitForTimeout(220)
 pass('copy submenu uses the same actions and the current session id')
 await page.evaluate(id=>{const c=window.__MOTION_SMOKE__;c.uiWorkspace.openSession(id);window.__showMenuSession(id,'Header B')},ids[1]);await page.waitForTimeout(300)
 await open()
 await menu.getByRole('menuitem',{name:/^置顶会话/}).waitFor()
 assert.equal(await menu.getAttribute('data-dsh-header-session-id'),ids[1])
 await menu.getByRole('menuitem',{name:'打开…',exact:true}).hover()
 await page.waitForTimeout(150)
 assert.equal(await page.getByRole('menuitem',{name:'文件资源管理器',exact:true}).isVisible(),true)
 await close()
 pass('switching sessions updates actions and keeps the open-app submenu available')
 await title.click();await dialog.waitFor()
 assert.equal(await dialog.locator('input').inputValue(),'Header B')
 await page.keyboard.press('Escape');await page.waitForTimeout(220)
 // Exercise the upstream breadcrumb renderer with a projected child summary.
 // No subagent or model turn is created by this UI-only fixture.
 await page.evaluate(ids=>{
  const c=window.__MOTION_SMOKE__,state=c.sessions.list.getSnapshot()
  window.__rootHeaderSummary=state.byId[ids[1]]
  window.__rootHeaderProjection=state.projectionsBySession[ids[0]]
  c.sessions.list.set({...state,
   byId:{...state.byId,[ids[1]]:{...state.byId[ids[1]],origin:'subagent',parentId:ids[0]}},
   projectionsBySession:{...state.projectionsBySession,[ids[0]]:{...state.projectionsBySession[ids[0]],state:'idle',values:{...state.projectionsBySession[ids[0]]?.values,subagentCatalog:[{id:ids[1],createdAt:Date.now(),mode:'one-shot',label:'Header B'}]}}}
  })
 },ids)
 await title.waitFor({state:'detached'})
 const hierarchy=page.getByRole('navigation',{name:'会话层级',exact:true})
 await hierarchy.getByText('Header B',{exact:true}).click()
 assert.equal(await dialog.count(),0)
 await page.getByRole('tree').waitFor()
 await page.keyboard.press('Escape')
 await hierarchy.getByRole('button',{name:'Header A renamed',exact:true}).click()
 await page.waitForFunction(id=>window.__MOTION_SMOKE__.sessions.list.getSnapshot().byId[id].retainedBy.mainView>0,ids[0])
 await page.evaluate(ids=>{
  const c=window.__MOTION_SMOKE__,state=c.sessions.list.getSnapshot()
  c.sessions.list.set({...state,byId:{...state.byId,[ids[1]]:window.__rootHeaderSummary},projectionsBySession:{...state.projectionsBySession,[ids[0]]:window.__rootHeaderProjection}})
  c.uiWorkspace.openSession(ids[1]);window.__showMenuSession(ids[1],'Header B')
 },ids)
 await title.waitFor()
 pass('subagent titles keep their switcher, ancestor titles navigate, and returning to a root session restores rename')
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
 if(registryMenu){
  await page.evaluate(()=>{
   window.__removeRegistryContribution=window.__MOTION_SMOKE__.get('contextMenus').register({id:'menu-smoke',target:'session',order:350,resolve:target=>[
    {id:'disabled',label:'不可用操作',disabled:true},
    {id:'nested',label:'扩展子菜单',children:[{id:'run',label:'执行扩展操作',run:()=>window.__menuCalls.push({command:'registry-extra',id:target.sessionId})}]},
   ]})
  })
  await open()
  assert.equal(await menu.getByRole('menuitem',{name:'不可用操作',exact:true}).isDisabled(),true)
  await menu.getByRole('menuitem',{name:'扩展子菜单',exact:true}).hover()
  await page.getByRole('menuitem',{name:'执行扩展操作',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.__menuCalls.find(x=>x.command==='registry-extra').id),ids[1])
  await page.evaluate(()=>window.__removeRegistryContribution())
  await page.waitForTimeout(220)
  pass('registry contributions preserve disabled states, nested menus and the captured session')
 }
 await open();await trigger.press('ArrowDown')
 assert.match(await page.evaluate(()=>document.activeElement.textContent),/^置顶会话/)
 await page.keyboard.press('End')
 assert.equal(await page.evaluate(()=>document.activeElement.textContent),'反馈')
 await close()
 await page.evaluate(()=>window.__MOTION_SMOKE__.configForms.get('ui-theme').set('preference','dark'))
 await open();await checkDividers('dark');await page.screenshot({path:join(root,'header-menu-dark.png')});await close()
 await page.setViewportSize({width:390,height:844});await open()
 const box=await menu.boundingBox();assert.ok(box.x>=0 && box.x+box.width<=390 && box.y+box.height<=844)
 await checkDividers('mobile')
 await page.screenshot({path:join(root,'header-menu-mobile.png')});await close()
 pass('keyboard traversal and light/dark/mobile layouts include the complete menu')
 await page.evaluate(()=>{delete window.__TAURI__})
 const openTarget=page.locator('[data-slot="conversation.session.header.utilities"] [data-open-target="directory"]')
 assert.equal(await openTarget.count(),1)
 for(const width of [390,1280]){
  await page.setViewportSize({width,height:844})
  assert.equal(await openTarget.isVisible(),false)
  await open()
  assert.equal(await menu.locator('[data-dsh-desktop="link-item"]').count(),0)
  await menu.getByRole('menuitem',{name:'打开…',exact:true}).click()
  const apps=page.locator('[data-dsh-desktop="reveal-submenu"]:visible')
  assert.deepEqual(await apps.getByRole('menuitem').allTextContents(),['文件资源管理器','VS Code'])
  await page.screenshot({path:join(root,'header-menu-remote-'+width+'.png')})
  await Promise.all([
   page.waitForResponse(response=>response.url().endsWith('/open-in-app/open') && response.ok()),
   apps.getByRole('menuitem',{name:'VS Code',exact:true}).click(),
  ])
  assert.deepEqual(launches.at(-1),{app:'vscode',path:root})
  await close()
 }
 pass('remote wide and mobile pages hide the header launcher and launch from Open without a native bridge')
 await page.setViewportSize({width:1280,height:840})
 await page.evaluate(()=>window.__MOTION_SMOKE__.configForms.get('desktop-appearance').set('ui','vanilla'))
 await page.waitForTimeout(250);await trigger.click()
 assert.equal(await title.count(),0)
 assert.equal(await page.locator('[data-dsh-header-menu-items]').count(),0)
 assert.equal(await openTarget.isVisible(),true)
 await close()
 await page.evaluate(()=>window.__MOTION_SMOKE__.configForms.get('desktop-appearance').set('ui','desktop'))
 await page.waitForTimeout(250);await open()
 await title.waitFor()
 assert.equal(await menu.locator('[data-dsh-header-menu-divider]').count(),1)
 await close()
 await page.evaluate(()=>document.documentElement.removeAttribute('data-dsh-browser'))
 assert.equal(await openTarget.isVisible(),true)
 assert.equal(await page.locator('[data-slot-error]').count(),0)
 assert.deepEqual(errors,[])
 pass('vanilla round trip restores the original menu and reapplies the shared menu without duplicates or errors')
 await page.evaluate(()=>window.__MOTION_SMOKE__.sidebarRight.openTab('terminal'))
 await page.waitForFunction(()=>{
  const c=window.__MOTION_SMOKE__,tab=c.sidebarRight.openTabs.getSnapshot().find(t=>t.kind==='terminal')
  if(!tab)return false
  const nav=c.sidebarRight.tabDomain.occurrence(tab.sessionId,{id:tab.tabId}).navigation.getSnapshot()
  window.__menuTerminal=c.get('webTerminals').view(tab.sessionId,tab.tabId,nav.address,nav.params?.terminalId,nav.params?.shellPath)
  return window.__menuTerminal.state.getSnapshot().writable
 })
 await page.evaluate(()=>window.__menuTerminal.write('echo DESKTOP_MENU_TERMINAL_OK\r'))
 await page.waitForFunction(()=>(document.querySelector('[data-sidebar-terminal] .xterm-rows')?.textContent||'').split('DESKTOP_MENU_TERMINAL_OK').length>=3)
 await page.evaluate(async()=>{await window.__menuTerminal.close();const c=window.__MOTION_SMOKE__;for(const tab of c.sidebarRight.openTabs.getSnapshot())if(tab.kind==='terminal')c.sidebarRight.close(tab.tabId)})
 assert.deepEqual(errors,[])
 pass('terminal opened from the real DSH UI runs a shell command with the packaged compatibility plugin')
} catch(error) {
 report.error=error.stack
 report.pageErrors=errors
 if(page)report.state=await page.evaluate(()=>{
  const c=window.__MOTION_SMOKE__,list=c?.sessions.list.getSnapshot()
  return {list,sessions:list?.ids.map(id=>({id,state:c.sessions.binding(id)?.session.getSnapshot()})),body:document.body.innerText.slice(0,3000)}
 }).catch(()=>null)
 if(page)report.menus=await page.locator('[role="menu"]').evaluateAll(nodes=>nodes.map(node=>node.outerHTML)).catch(()=>null)
 if(page)report.header=await page.locator('[data-slot="conversation.session.header"] nav').evaluateAll(nodes=>nodes.map(node=>node.outerHTML)).catch(()=>null)
 if(page)await page.screenshot({path:join(root,'failure.png')}).catch(()=>{})
 throw error
} finally {
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
 await browser?.close()
 if(child.exitCode===null)execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})
 console.log('Report: '+root)
}
