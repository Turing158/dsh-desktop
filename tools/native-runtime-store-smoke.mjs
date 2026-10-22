// Production freeze and startup selection in isolated desktop roots. No npm
// installation, model calls, or writes to the user's runtime/Profile.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createServer } from 'node:net'
import { offlineModelPatch } from './dsh-ui-helpers.mjs'

const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const reuse=process.env.DSH_RUNTIME_STORE_RESUME
const root=reuse?resolve(reuse):await mkdtemp(resolve('src-tauri/target/native-runtime-store-'))
const exe=resolve('src-tauri/target/debug/deepseek-harness-desktop.exe')
const realBin=process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const source=dirname(dirname(realBin)), home=join(root,'home'), appdata=join(root,'isolated-appdata')
const report=reuse?JSON.parse(await readFile(join(root,'report.json'),'utf8')):{schema:1,root,checks:[],realBin}
const pass=async name=>{if(!report.checks.includes(name))report.checks.push(name);await save();console.log('PASS: '+name)}
const has=name=>report.checks.includes(name)
const save=()=>writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
let child,browser
async function waitFor(fn,label,timeout=90000) {
  const deadline=Date.now()+timeout
  while(Date.now()<deadline) {
    try {const result=await fn();if(result)return result}catch{}
    if(child && child.exitCode!==null)throw Error('desktop exited: '+label)
    await sleep(150)
  }
  throw Error('timeout: '+label)
}
async function state(){return JSON.parse(await readFile(join(root,'state.json'),'utf8'))}
async function freePort() {
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port
}
async function start({pin,legacy=false}={}) {
  const port=await freePort(),env={...process.env,DSH_HOME:home,DSH_DESKTOP_SMOKE_DIR:root,DSH_DESKTOP_NODE:process.execPath,
    DSH_UI_SMOKE_KEY:'mock-key',DSH_DESKTOP_WEBVIEW_RESTORE:'1',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}
  delete env.DSH_DESKTOP_DSH
  if(pin)env.DSH_DESKTOP_DSH=pin
  if(!legacy)env.APPDATA=appdata
  await writeFile(join(root,'state.json'),'{}');await writeFile(join(root,'command.json'),'{}')
  child=spawn(exe,[],{cwd:root,windowsHide:true,stdio:'ignore',env})
  await waitFor(async()=>{const s=await state();if(s.backend==='failed')throw Error('backend failed');return s.backend==='running'},'backend ready')
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port)
  const page=await waitFor(()=>browser.contexts().flatMap(ctx=>ctx.pages()).find(p=>p.url().startsWith('http://127.0.0.1:') && !p.url().includes('tauri.localhost')),'DSH page')
  await page.waitForFunction(()=>!!window.__DSH_REMOTE_IDENTITY__)
  return page
}
async function stop() {
  if(browser){await browser.close();browser=undefined}
  if(child?.pid && child.exitCode===null) {
    await writeFile(join(root,'command.json'),JSON.stringify({sequence:Date.now(),action:'quit'}))
    const deadline=Date.now()+12000
    while(child.exitCode===null && Date.now()<deadline)await sleep(100)
    if(child.exitCode===null)try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}
    await sleep(500)
  }
  child=undefined
}
try {
  await mkdir(home,{recursive:true});await mkdir(appdata,{recursive:true})
  await writeFile(join(home,'cordis.patch.yml'),offlineModelPatch)
  await writeFile(join(home,'settings.json'),JSON.stringify({'ui-settings-general':{welcomeNoticeVersion:'2026-09-28.1'}}))
  const frozen='production freeze keeps the actual dependency closure and leaves it unselected'
  if(!has(frozen)) {
    await start({pin:realBin})
    await writeFile(join(root,'command.json'),JSON.stringify({sequence:Date.now(),action:'runtime-prepare',source}))
    const prepared=await waitFor(async()=>JSON.parse(await readFile(join(root,'runtime-prepared.json'),'utf8')),'production runtime freeze',600000)
    assert.ok(!prepared.error,prepared.error);report.runtime=prepared.runtime
    assert.equal(prepared.runtime.source,'managed');assert.equal(prepared.runtime.managed.committed,false)
    assert.equal(await access(join(root,'runtime/selection.json')).then(()=>true,()=>false),false)
    const inventory=JSON.parse(await readFile(join(root,'runtime/versions',prepared.runtime.managed.id,'inventory.json'),'utf8'))
    assert.ok(inventory.files.length>1000);report.fileCount=inventory.files.length
    assert.ok(await access(realBin).then(()=>true,()=>false));await pass(frozen);await stop()
  }
  const committed='pending first install commits only after the actual desktop UI acknowledges readiness'
  if(!has(committed)) {
    const page=await start()
    const selection=await waitFor(async()=>JSON.parse(await readFile(join(root,'runtime/selection.json'),'utf8')),'UI verified selection',180000)
    assert.equal(selection.active,report.runtime.managed.id);assert.equal(selection.backendReady,true);assert.equal(selection.uiReady,true)
    assert.equal(selection.previous,null)
    await page.waitForFunction(()=>!!window.__DSH_UI_STATE__)
    const s=await waitFor(async()=>{const s=await state();return s.runtime?.managed?.committed && s},'native committed state')
    assert.equal(s.runtime.source,'managed')
    report.selection=selection;await pass(committed);await stop()
  }
  const selected='the next launch selects the verified managed tree ahead of an existing global install'
  if(!has(selected)) {
    await start({legacy:true});const s=await state()
    assert.equal(s.runtime.source,'managed');assert.equal(s.runtime.managed.id,report.runtime.managed.id)
    await pass(selected);await stop()
  }
  const pinned='an explicit runtime pin takes precedence even when the managed selection is unreadable'
  if(!has(pinned)) {
    await writeFile(join(root,'runtime/selection.json'),'{"schema":999}')
    const page=await start({pin:realBin})
    const s=await state();assert.equal(s.runtime.source,'configured');assert.equal(resolve(s.runtime.dsh_bin),resolve(realBin))
    assert.ok(await page.evaluate(()=>!!window.__DSH_UI_STATE__))
    await pass(pinned);await stop()
    await writeFile(join(root,'runtime/selection.json'),JSON.stringify(report.selection))
  }
  if(report.error) {report.previousFailures ||= [];report.previousFailures.push(report.error)}
  delete report.error;await save()
} catch(error) {report.error=error.message;await save();throw error}
finally {await stop();console.log('Artifacts: '+root)}
