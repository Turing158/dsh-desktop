/** Cross-origin restart check for an isolated debug host. Never runs on a normal profile. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { connect } from './terminal-cdp.mjs'
const dir=resolve(process.env.DOCK_SMOKE_DIR || 'src-tauri/target/bottom-terminal-live')
const port=Number(process.env.CDP_PORT || 9342)
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
let c=await connect(port)
let before
try {
  assert.ok(await c.evaluate(`Boolean(window.__DSH_UI_BOOT__?.smoke && window.__DSH_TERMINAL_SMOKE__?.dock)`))
  before=await c.evaluate(`(async()=>{const s=window.__DSH_TERMINAL_SMOKE__;s.dock.resize(314);s.dock.open();return {origin:location.origin,state:s.dock.getSnapshot(),settings:s.ctx.settingsScope.bind({namespace:'desktop-terminal-dock'}).getSnapshot()}})()`)
  assert.equal(before.state.collapsed,false,'leave the panel open before quitting')
  const end=Date.now()+8000
  while(Date.now()<end) {
    if(await c.evaluate(`(()=>{const v=window.__DSH_TERMINAL_SMOKE__.ctx.settingsScope.bind({namespace:'desktop-terminal-dock'}).getSnapshot().value;return v?.layout?.height===314 && v.layout.collapsed===true})()`))break
    await sleep(100)
  }
  await sleep(700)
  await writeFile(resolve(dir,'command.json'),JSON.stringify({sequence:Date.now(),action:'quit'}))
} finally {c.close()}
const oldPid=Number((await readFile(resolve(dir,'host.pid'),'utf8')).trim())
for(let i=0;i<80;i++) { try {process.kill(oldPid,0)}catch{break} await sleep(100) }
assert.throws(()=>process.kill(oldPid,0),'old isolated host must exit before restarting')
await writeFile(resolve(dir,'command.json'),'{}')
const child=spawn(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'),[],{windowsHide:true,detached:true,stdio:'ignore',env:{...process.env,
  DSH_HOME:resolve(dir,'dsh-home'),DSH_DESKTOP_SMOKE_DIR:dir,DSH_DESKTOP_WEBVIEW_RESTORE:'1',DSH_DESKTOP_DEBUG:resolve(dir,'host.log'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port,
}})
child.unref();await writeFile(resolve(dir,'host.pid'),String(child.pid))
let after
for(let i=0;i<100;i++) {
  try {
    c=await connect(port)
    after=await c.evaluate(`(()=>{const s=window.__DSH_TERMINAL_SMOKE__;return s?.dock ? {origin:location.origin,state:s.dock.getSnapshot(),settings:s.ctx.settingsScope.bind({namespace:'desktop-terminal-dock'}).getSnapshot()} : null})()`)
    c.close()
    if(after?.settings?.status==='ready')break
  } catch {} await sleep(200)
}
assert.ok(after,'restarted host exposes the dock')
assert.notEqual(after.origin,before.origin,'test must cross HTTP origins')
assert.equal(after.state.height,314)
assert.equal(after.state.collapsed,true)
await writeFile(resolve(dir,'restart.json'),JSON.stringify({before,after},null,2))
console.log('PASS height survives a full host restart while the panel always starts closed')
