/** Inject save/launch failures into an isolated real DSH host. No user data. */
import {spawn} from 'node:child_process'
import {mkdir, writeFile, readFile, rename, rmdir} from 'node:fs/promises'
import {resolve, join} from 'node:path'
import {connect} from './terminal-cdp.mjs'
import assert from 'node:assert/strict'
const root=resolve('src-tauri/target/remote-control-failures'),port=9360,checks=[]
await mkdir(root,{recursive:true})
const real=process.env.REMOTE_REAL_DSH || join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const wrapper=join(root,'runtime-wrapper.mjs'),marker=join(root,'fail-lan')
await writeFile(marker,'injected')
await writeFile(wrapper,`import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';
const args=process.argv.slice(2);if(args.includes('--host')&&existsSync(${JSON.stringify(marker)})){console.error('injected LAN startup failure');process.exit(17)}
const child=spawn(process.execPath,[${JSON.stringify(real)},...args],{stdio:'inherit',windowsHide:true,env:{...process.env,DSH_DESKTOP_DSH_BIN:${JSON.stringify(real)}}});child.on('exit',code=>process.exit(code||0));`)
const configPath=join(root,'remote-control.json')
await writeFile(configPath,JSON.stringify({version:1,enabled:false,bindAddress:'',port:3080,trustedHosts:[]}))
await writeFile(join(root,'command.json'),'{}')
const child=spawn(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'),[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,DSH_HOME:join(root,'dsh-home'),DSH_DESKTOP_DSH:wrapper,DSH_DESKTOP_SMOKE_DIR:root,DSH_DESKTOP_DEBUG:join(root,'host.log'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}})
let c
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const check=(name)=>{checks.push({name,detail:true});console.log('PASS '+name)}
async function until(expression,timeout=65000){const end=Date.now()+timeout;while(Date.now()<end){try{c ||= await connect(port);const result=await c.evaluate(expression);if(result)return result}catch{c?.close();c=null}await sleep(150)}throw Error('failure test timeout: '+expression.slice(0,80))}
const status=()=>c.evaluate(`window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__})`)
async function ready(){
  await until(`Boolean(window.__DSH_REMOTE_IDENTITY__ && window.__DSH_SMOKE_CONTEXT__ && window.__DSH_SMOKE_CONTEXT__.sessions.list.getSnapshot().phase==='ready')`)
  for(let i=0;i<15;i++){await c.evaluate(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='稍后配置')?.click();const beta=[...document.querySelectorAll('[role=dialog]')].find(d=>d.textContent.includes('内测声明'));[...beta?.querySelectorAll('button')||[]].find(b=>b.textContent==='继续')?.click()})()`);await sleep(150)}
  await until(`!document.querySelector('[data-dsh-ui-status]')`)
}
async function apply(config){return c.evaluate(`(async()=>{const s=await window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__});const payload=await window.__DSH_UI_STATE__.prepareRemoteApply(s.frontendVersion);try{return await window.__TAURI__.core.invoke('remote_apply',{identity:window.__DSH_REMOTE_IDENTITY__,config:${JSON.stringify(config)},payload})}catch(e){window.__DSH_UI_STATE__.finishRemoteApply();return {error:e.code}}})()`)}
try{
  await ready()
  const initial=await status();assert.equal(initial.state,'disabled')
  const addresses=await c.evaluate(`window.__TAURI__.core.invoke('remote_lan_addresses',{identity:window.__DSH_REMOTE_IDENTITY__})`)
  assert.ok(addresses.length)
  const address=addresses.find(a=>/WLAN|Wi-Fi|以太网|Ethernet/i.test(a.name)) || addresses[0]
  const config={version:1,enabled:true,bindAddress:address.address,port:13084,trustedHosts:[]}
  // An empty directory at the destination causes atomic persist to fail.
  // Restore the exact original file before testing any successful write.
  await rename(configPath,configPath+'.saved');await mkdir(configPath)
  try{
    const result=await apply(config);assert.equal(result.error,'config-write')
    const now=await status();assert.equal(now.instance,initial.instance);assert.equal(now.active.enabled,false);assert.equal(now.saved.enabled,false);assert.equal(now.applying,false)
    check('atomic configuration write failure preserves running instance and saved choice')
  }finally{await rmdir(configPath);await rename(configPath+'.saved',configPath)}
  const result=await apply(config);assert.equal(result.changed,true)
  await until(`window.__DSH_REMOTE_IDENTITY__?.backendInstance > ${initial.instance}`);await ready()
  const fallback=await status();assert.equal(fallback.state,'local-fallback');assert.equal(fallback.error.code,'start-failed');assert.equal(fallback.active.enabled,false);assert.equal(fallback.saved.enabled,true)
  assert.equal(JSON.parse(await readFile(configPath,'utf8')).enabled,true)
  check('real LAN process startup failure falls back once and retains persisted request')
  assert.equal(fallback.instance,initial.instance+2)
  check('failed candidate and local recovery consume exactly two backend instances')
  const disabled=await apply({...config,enabled:false});assert.equal(disabled.changed,true)
  await until(`window.__DSH_REMOTE_IDENTITY__?.backendInstance > ${fallback.instance}`);await ready()
  const final=await status();assert.equal(final.state,'disabled');assert.equal(final.error,null);assert.equal(final.saved.enabled,false)
  check('disable after failed enable clears error and never reopens LAN')
}finally{
  c?.close()
  if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));await writeFile(join(root,'command.json'),JSON.stringify({sequence:1,action:'quit'}));await Promise.race([exited,sleep(12000).then(()=>{if(child.exitCode===null)child.kill()})])}
  await writeFile(join(root,'remote-control-failures.json'),JSON.stringify({date:new Date().toISOString(),checks},null,2))
}
