/** Cold-start and native LAN regression matrix. Owns only isolated processes. */
import {spawn} from 'node:child_process'
import {mkdir,writeFile,readFile,copyFile} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {networkInterfaces} from 'node:os'
import {createServer} from 'node:net'
import {connect} from './terminal-cdp.mjs'
import assert from 'node:assert/strict'
const root=resolve('src-tauri/target/remote-control-cold'),port=9358,checks=[]
await mkdir(root,{recursive:true})
const exe=join(root,'deepseek-harness-desktop.exe')
await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'),exe)
const resources=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8')).bundle.resources
for(const [src,dest] of Object.entries(resources)){const target=join(root,dest);await mkdir(dirname(target),{recursive:true});await copyFile(resolve('src-tauri',src),target)}
const address=Object.values(networkInterfaces()).flat().find(i=>i?.family==='IPv4'&&!i.internal&&/^192\.168\./.test(i.address))?.address
assert.ok(address,'a LAN adapter is required')
const config={version:1,enabled:true,bindAddress:address,port:13083,trustedHosts:[]}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
let processHandle,c,sequence=0
async function stop(){c?.close();c=null;if(!processHandle)return;await writeFile(join(root,'command.json'),JSON.stringify({sequence:++sequence,action:'quit'}));await Promise.race([new Promise(r=>processHandle.once('exit',r)),sleep(12000).then(()=>{throw Error('Host did not stop')})]);processHandle=null}
async function start(value){
  await writeFile(join(root,'remote-control.json'),typeof value==='string'?value:JSON.stringify(value))
  await writeFile(join(root,'command.json'),'{}');sequence=0
  processHandle=spawn(exe,[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,DSH_HOME:join(root,'dsh-home'),DSH_DESKTOP_SMOKE_DIR:root,DSH_DESKTOP_DEBUG:join(root,'host.log'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}})
  const end=Date.now()+70000
  while(Date.now()<end){try{c ||= await connect(port); const s=await c.evaluate(`window.__DSH_REMOTE_IDENTITY__ && window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__})`);if(s)return s}catch{c?.close();c=null}await sleep(150)}
  throw Error('Cold-start timeout')
}
const check=(name,detail=true)=>{checks.push({name,detail});console.log('PASS '+name)}
try{
  for(const [name,value,code] of [['corrupt configuration','{bad','config-invalid'],['unknown version',{...config,version:7},'config-version'],['missing interface',{...config,bindAddress:'10.255.255.254'},'address-unavailable']]){
    const s=await start(value);assert.equal(s.state,'local-fallback');assert.equal(s.error.code,code);assert.equal(s.active.enabled,false);check(name+' falls back locally');await stop()
  }
  const occupied=createServer();await new Promise(r=>occupied.listen(config.port,address,r))
  try{const s=await start(config);assert.equal(s.state,'local-fallback');assert.equal(s.error.code,'port-unavailable');assert.equal(s.saved.enabled,true);check('occupied cold-start port retains saved choice');await stop()}finally{occupied.close()}
  const s=await start(config);assert.equal(s.state,'lan');assert.equal(s.active.bindAddress,address);check('saved LAN configuration starts on exact address')
  const native=await c.evaluate(`(async()=>{
    const invoke=(name,args={})=>window.__TAURI__.core.invoke(name,args)
    const max=await invoke('window_is_maximized');await invoke('window_toggle_maximize');await invoke('window_toggle_maximize')
    const original=await invoke('clipboard_read_text');await invoke('clipboard_write_text',{text:'DSH remote control smoke'});const copied=await invoke('clipboard_read_text');await invoke('clipboard_write_text',{text:original||''})
    const identity=window.__DSH_TERMINAL_IDENTITY__,t=(name,args={})=>invoke(name,{identity,...args})
    const profiles=await t('terminal_profiles')
    const opened=await t('terminal_open',{resourceKey:'dsh-resource://desktop-terminal/remote-smoke',profileId:'cmd',cwd:${JSON.stringify(root)}})
    await new Promise(r=>setTimeout(r,800));const active=await t('terminal_list');await t('terminal_close',{terminalId:opened.terminalId,runId:opened.runId})
    return {maximized:await invoke('window_is_maximized')===max,clipboard:copied==='DSH remote control smoke',terminal:active.some(v=>v.terminalId===opened.terminalId&&v.state==='running'),profiles:profiles.length}
  })()`)
  assert.equal(native.maximized,true);assert.equal(native.clipboard,true);assert.equal(native.terminal,true);check('LAN title bar, clipboard and native terminal',native)
  await c.evaluate(`window.__TAURI__.core.invoke('window_close')`);await sleep(300)
  const hidden=JSON.parse(await readFile(join(root,'state.json'),'utf8'));assert.equal(hidden.visible,false);assert.equal(hidden.backend,'running');check('tray hiding keeps backend running')
  await writeFile(join(root,'command.json'),JSON.stringify({sequence:++sequence,action:'show'}));await sleep(500)
  assert.equal(JSON.parse(await readFile(join(root,'state.json'),'utf8')).visible,true);check('tray restore on LAN origin')
  await stop()
}finally{if(processHandle)await stop();await writeFile(join(root,'remote-control-coldstart.json'),JSON.stringify({date:new Date().toISOString(),checks},null,2))}
