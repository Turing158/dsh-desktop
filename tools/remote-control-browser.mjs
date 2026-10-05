// Ordinary browser QA against the same isolated DSH used by the native host.
import { connect } from './terminal-cdp.mjs'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dir=resolve(process.env.REMOTE_SMOKE_DIR || 'src-tauri/target/remote-control-live')
let c,info
for(let i=0;i<300 && !info;i++){
  try{c ||= await connect(Number(process.env.CDP_PORT || 9357));info=await c.evaluate(`window.__DSH_REMOTE_IDENTITY__ && window.__TAURI__.core.invoke('remote_connection_info',{identity:window.__DSH_REMOTE_IDENTITY__})`)}
  catch{c?.close();c=null}
  if(!info)await new Promise(r=>setTimeout(r,200))
}
c?.close()
assert.ok(info,'isolated host must have LAN enabled')
const browser=await chromium.launch({channel:'msedge',headless:true})
const checks=[]
try {
  for (const theme of ['light','dark']) {
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,colorScheme:theme})
    const page=await context.newPage(), errors=[]
    let sockets=0, frames=0
    page.on('websocket', socket=>{if(new URL(socket.url()).pathname==='/api/remote.mux'){sockets++;socket.on('framereceived',()=>frames++)}})
    page.on('pageerror',e=>errors.push(e.message))
    await page.goto(info.url)
    await page.locator('.dshTb').waitFor()
    for(let i=0;i<12;i++) {
      const beta=page.getByRole('dialog').filter({hasText:'内测声明'})
      if(await beta.isVisible()) await beta.getByRole('button',{name:'继续',exact:true}).click()
      const later=page.getByRole('button',{name:'稍后配置',exact:true}); if(await later.isVisible()) await later.click()
      await page.waitForTimeout(150)
    }
    assert.equal(await page.evaluate(()=>Boolean(window.__TAURI__)),false)
    assert.equal(await page.evaluate(()=>isSecureContext),false)
    assert.ok(sockets>0 && frames>0,'authenticated WebSocket must exchange frames')
    for(const [width,height] of [[360,780],[390,844],[430,932],[844,390]]) {
      await page.setViewportSize({width,height}); await page.waitForTimeout(150)
      const overflow=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().width && e.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(e=>({tag:e.tagName,cls:e.className,right:Math.round(e.getBoundingClientRect().right)}))}))
      checks.push({theme,width,height,overflow})
      await page.screenshot({path:join(dir,`browser-${theme}-${width}.png`)})
      assert.ok(overflow.scroll<=overflow.viewport+1,JSON.stringify({theme,width,overflow}))
    }
    await page.setViewportSize({width:390,height:844})
    // 设置 lives inside the sidebar drawer on a phone page — the rail's gear is
    // behind the closed drawer — so open it the way a phone user does before
    // reaching for the trigger: the title bar's mark, which IS the drawer's
    // control (the labelled 打开侧边栏 button this bar used to carry is gone).
    if(await page.evaluate(()=>document.querySelector("[class*='_frame']")?.getAttribute('data-sidebar-collapsed')??null)!==null){
      await page.locator('.dshTb__mark').click()
      await page.waitForTimeout(800)
    }
    await page.locator('button[aria-haspopup=dialog]:visible').first().click()
    await page.getByRole('button',{name:'远程控制',exact:true}).click()
    await page.getByText('请在电脑桌面应用中修改远程控制设置',{exact:true}).waitFor()
    assert.equal(await page.locator('.dshRemote :is(button,input,select)').count(),0)
    const settingsSize=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}))
    checks.push({theme,settingsSize,browserOnly:true,errors})
    await page.screenshot({path:join(dir,`browser-${theme}-settings.png`)})
    assert.ok(settingsSize.scroll<=settingsSize.width+1)
    assert.deepEqual(errors,[])

    // ── the phone page itself: the conversation owns the viewport while the
    // drawer is shut, and the drawer is where the workspace and session list
    // lives. Both halves have been broken at once by a frame whose columns were
    // auto-placed around an absolutely positioned sidebar: the centre column
    // landed on the 0px track and the app painted nothing but its own bar, so
    // the session list looked missing and 新建会话 looked dead.
    await page.goto(info.url)
    await page.waitForTimeout(1200)
    for(let i=0;i<12;i++){
      const beta=page.getByRole('dialog').filter({hasText:'内测声明'})
      if(await beta.isVisible()) await beta.getByRole('button',{name:'继续',exact:true}).click()
      const later=page.getByRole('button',{name:'稍后配置',exact:true}); if(await later.isVisible()) await later.click()
      await page.waitForTimeout(150)
    }
    const geometry=await page.evaluate(()=>{
      const width=sel=>{const el=document.querySelector(sel);return el===null?null:Math.round(el.getBoundingClientRect().width)}
      return {center:width("[class*='_centerCol']"),composer:width('[contenteditable="true"]'),viewport:innerWidth}
    })
    assert.ok(geometry.center>geometry.viewport-100,`the conversation column must own the viewport: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.composer>200,`the composer must be laid out, not collapsed: ${JSON.stringify(geometry)}`)
    // The drawer's only control on this page is the bar's mark. The cluster
    // mirrors 新建会话 / 搜索会话 / the panel rows — the controls a phone cannot
    // reach without opening the drawer first — and must NOT mirror the rail's own
    // drawer toggle, which the mark already is.
    const quickLabels=await page.evaluate(()=>[...document.querySelectorAll('.dshTb__quickLabel')].map(el=>el.textContent))
    assert.ok(
      !quickLabels.includes('打开侧边栏'),
      `the drawer toggle must not be mirrored into the bar beside the mark: ${JSON.stringify(quickLabels)}`,
    )
    await page.locator('.dshTb__mark').click()
    let drawer={workspaces:0,visible:null,left:null}
    // Wait for the drawer to be IN PLACE, not merely un-hidden: the rows exist
    // while it is still sliding, and a screenshot taken mid-slide shows a page
    // that looks as if nothing happened.
    for(let i=0;i<24 && (drawer.workspaces===0 || drawer.left<0);i++){
      drawer=await page.evaluate(()=>{
        const col=document.querySelector("[class*='_sidebarCol']")
        return {workspaces:document.querySelectorAll('[role="treeitem"][class*="projectRow"]').length,visible:col===null?null:getComputedStyle(col).visibility,left:col===null?null:Math.round(col.getBoundingClientRect().x)}
      })
      if(drawer.workspaces===0 || drawer.left<0)await page.waitForTimeout(250)
    }
    assert.equal(drawer.visible,'visible','the bar’s mark must open the sidebar drawer')
    assert.ok(drawer.left>=0,`the drawer must slide into place: ${JSON.stringify(drawer)}`)
    assert.ok(drawer.workspaces>0,`the drawer must list the workspace folders: ${JSON.stringify(drawer)}`)
    await page.screenshot({path:join(dir,`browser-${theme}-drawer.png`)})
    // 新建会话 belongs to the conversation: snapping the drawer over the
    // composer it just revealed is the "no effect" report.
    await page.locator('.dshTb__mark').click()
    await page.waitForTimeout(700)
    await page.getByRole('button',{name:'新建会话',exact:true}).first().click()
    await page.waitForTimeout(900)
    const afterNew=await page.evaluate(()=>({
      collapsed:document.querySelector("[class*='_frame']")?.getAttribute('data-sidebar-collapsed')??null,
      composer:Math.round(document.querySelector('[contenteditable="true"]')?.getBoundingClientRect().width??0),
    }))
    assert.equal(afterNew.collapsed,'true','新建会话 must leave the drawer shut')
    assert.ok(afterNew.composer>200,`the composer must stay usable after 新建会话: ${JSON.stringify(afterNew)}`)
    checks.push({theme,geometry,drawer,afterNew})

    const before=sockets, beforeFrames=frames
    await context.setOffline(true); await page.waitForTimeout(300); await context.setOffline(false)
    for(let i=0;i<40 && (sockets===before || frames===beforeFrames);i++) await page.waitForTimeout(250)
    assert.ok(sockets>before,'WebSocket reconnects after network loss')
    assert.ok(frames>beforeFrames,'new connection receives real frames')
    checks.push({theme,sockets,frames,reconnected:true})
    await context.close()
  }
  console.log('PASS ordinary LAN HTTP browser: both themes, four viewport sizes, read-only remote settings')
} finally {await browser.close();await writeFile(join(dir,'remote-control-browser.json'),JSON.stringify({date:new Date().toISOString(),browser:'Microsoft Edge '+browser.version(),checks},null,2))}
