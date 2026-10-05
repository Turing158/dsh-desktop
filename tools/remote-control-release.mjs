/** Smoke the actual portable release with isolated DSH and WebView data.
 * Reads the desktop's saved remote config, never changes it or model settings.
 * Stops only the child host it starts; its Job Object closes its DSH tree.
 */
import {spawn} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve, join} from 'node:path'
import {createHash} from 'node:crypto'
import {connect} from './terminal-cdp.mjs'
import assert from 'node:assert/strict'
const root=resolve('src-tauri/target/remote-control-release')
const portable=resolve('src-tauri/target/remote-control-package/portable')
await mkdir(root,{recursive:true})
const checks=[]
const check=(name,detail=true)=>{checks.push({name,detail});console.log('PASS '+name)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const resources=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8')).bundle.resources
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
for(const [src,dest] of Object.entries(resources)) assert.equal(digest(await readFile(join(portable,dest))),digest(await readFile(resolve('src-tauri',src))),dest)
check('all portable resource bytes match final sources',Object.keys(resources).length)
const child=spawn(join(portable,'deepseek-harness-desktop.exe'),[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,DSH_HOME:join(root,'dsh-home'),WEBVIEW2_USER_DATA_FOLDER:join(root,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9359'}})
let c
async function until(expression,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){try{c ||= await connect(9359);const result=await c.evaluate(expression);if(result)return result}catch{c?.close();c=null}await sleep(150)}throw Error('release readiness timeout')}
try {
  const status=await until(`window.__DSH_REMOTE_IDENTITY__ && window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__})`)
  assert.equal(status.state,'disabled');assert.equal(status.address,null);check('release default local startup and remote status')
  const controls=await c.evaluate(`(async()=>({maximized:typeof await window.__TAURI__.core.invoke('window_is_maximized'),addresses:(await window.__TAURI__.core.invoke('remote_lan_addresses',{identity:window.__DSH_REMOTE_IDENTITY__})).length}))()`)
  assert.equal(controls.maximized,'boolean');assert.ok(controls.addresses>0);check('release native command ACL and LAN enumeration')
  for(let i=0;i<20;i++){
    await c.evaluate(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='稍后配置')?.click();const beta=[...document.querySelectorAll('[role=dialog]')].find(d=>d.textContent.includes('内测声明'));[...beta?.querySelectorAll('button')||[]].find(b=>b.textContent==='继续')?.click()})()`)
    await sleep(150)
  }
  await c.evaluate(`document.querySelector('button[aria-haspopup=dialog]').click()`)
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent==='远程控制')`)
  await c.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='远程控制').click()`)
  await until(`Boolean(document.querySelector('#dsh-remote-port'))`)
  assert.equal(await c.evaluate(`document.querySelector('#dsh-remote-port').value`),'3080')
  check('portable release settings plugin loads outside source directory')
} finally {
  c?.close()
  if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited}
  await writeFile(join(root,'remote-control-release.json'),JSON.stringify({date:new Date().toISOString(),checks},null,2))
}
