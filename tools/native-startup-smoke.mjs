// Reuse an isolated, committed native-upgrade fixture. No model requests or
// changes to the user's active DSH data/runtime selection.
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {mkdir,readFile,writeFile,copyFile,unlink} from 'node:fs/promises'
import {resolve,join,dirname,sep} from 'node:path'
import {createServer} from 'node:net'
import {handleOnboarding} from './dsh-ui-helpers.mjs'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root=resolve(process.argv[2])
assert.ok(root.startsWith(resolve('src-tauri/target')+sep),'startup fixture must stay inside target')
const selected=JSON.parse(await readFile(join(root,'runtime/selection.json'),'utf8'))
const manifest=JSON.parse(await readFile(join(root,'runtime/versions',selected.active,'manifest.json'),'utf8'))
assert.equal(manifest.id,selected.active)
const receipt=join(root,'runtime/verified',selected.active+'.bin')
await unlink(receipt).catch(error=>{if(error.code!=='ENOENT')throw error})
const exe=join(root,'deepseek-harness-desktop.exe')
await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'),exe)
for(const [source,destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8')).bundle.resources)) {
  await mkdir(dirname(join(root,destination)),{recursive:true});await copyFile(resolve('src-tauri',source),join(root,destination))
}
const report={root,version:manifest.version,files:manifest.fileCount,bytes:manifest.totalBytes,rounds:[],checks:[]}
const save=()=>writeFile(join(root,'startup-report.json'),JSON.stringify(report,null,2))
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
let child,browser
async function until(fn,label,timeout=120000) {
  const end=Date.now()+timeout
  while(Date.now()<end) {
    try {const value=await fn();if(value)return value}catch(error){if(error.fatal)throw error}
    if(child&&child.exitCode!==null)throw Error('desktop exited during '+label+': '+child.exitCode)
    await sleep(100)
  }
  throw Error('timeout '+label)
}
async function quit() {
  if(child?.exitCode===null) {
    await writeFile(join(root,'command.json'),JSON.stringify({sequence:Date.now(),action:'quit'}))
    const end=Date.now()+10000;while(child.exitCode===null&&Date.now()<end)await sleep(100)
    if(child.exitCode===null)execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})
  }
  await browser?.close().catch(()=>{});browser=null
}
try {
  for(let round=1;round<=3;round++) {
    if(round===3) {const bytes=await readFile(receipt);bytes[Math.floor(bytes.length/2)]^=1;await writeFile(receipt,bytes)}
    const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    const port=server.address().port;await new Promise(resolve=>server.close(resolve))
    const log=join(root,'startup-'+round+'.log')
    await writeFile(log,'');await writeFile(join(root,'command.json'),'{}');await writeFile(join(root,'state.json'),'{}')
    const started=Date.now()
    child=spawn(exe,[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,DSH_HOME:join(root,'home'),
      DSH_DESKTOP_DSH:join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js'),DSH_DESKTOP_NODE:process.execPath,
      DSH_DESKTOP_SMOKE_DIR:root,DSH_DESKTOP_DEBUG:log,DSH_UI_SMOKE_KEY:'offline',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}})
    browser=await until(()=>chromium.connectOverCDP('http://127.0.0.1:'+port),'CDP')
    const page=await until(()=>browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().startsWith('http://127.0.0.1:')),'page')
    await handleOnboarding(page)
    const state=await until(async()=>{
      const value=JSON.parse(await readFile(join(root,'state.json'),'utf8'))
      return value.backend==='running'&&value.loaded&&value.phase==='active' ? value : null
    },'active managed UI')
    assert.equal(state.runtime.version,manifest.version);assert.equal(state.runtime.managed.id,manifest.id)
    const elapsedMs=Date.now()-started
    const text=await readFile(log,'utf8'),matches=[...text.matchAll(/verify files=(\d+) hashed=(\d+) cached_layout=(true|false) elapsed_ms=(\d+)/g)]
    assert.ok(matches.length,'verification timing should be logged')
    const match=matches[0],measurement={round,startupMs:elapsedMs,verificationMs:Number(match[4]),hashed:Number(match[2]),cachedLayout:match[3]==='true'}
    if(round===2) {assert.equal(measurement.hashed,0);assert.equal(measurement.cachedLayout,true)}
    else {assert.equal(measurement.hashed,manifest.fileCount);assert.equal(measurement.cachedLayout,false)}
    report.rounds.push(measurement);console.log(JSON.stringify(measurement));await save();await quit()
  }
  report.checks.push('fresh verification reaches the managed UI','a new process reuses the authenticated receipt with no runtime content hashes',
    'corrupt receipt forces complete verification and is repaired without changing selection')
} catch(error){report.error=error.stack;throw error}
finally {await quit();await save();console.log('Report: '+join(root,'startup-report.json'))}
