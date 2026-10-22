// Actual npm + native IPC, served by a local fixture registry. No downloads,
// model calls, global installation, selection change, or real-data migration.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { offlineModelPatch, handleOnboarding } from './dsh-ui-helpers.mjs'

const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root=process.env.DSH_CANDIDATE_RESUME ? resolve(process.env.DSH_CANDIDATE_RESUME) : await mkdtemp(resolve('src-tauri/target/native-candidate-'))
const report=process.env.DSH_CANDIDATE_RESUME ? JSON.parse(await readFile(join(root,'report.json'),'utf8')) : {schema:1,root,checks:[]}
const save=()=>writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
const pass=async name=>{report.checks.push(name);await save();console.log('PASS: '+name)}
const home=join(root,'home'),pkg=join(root,'fixture')
const source=process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const npm=join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')
const version='9.8.7-candidate.1'
let child,browser,mode='success',pendingRequest
await mkdir(home,{recursive:true});await mkdir(pkg,{recursive:true})
const probe=join(root,'probe');await mkdir(probe,{recursive:true})
await writeFile(join(probe,'package.json'),JSON.stringify({name:'@dsh-desktop/candidate-smoke',type:'module',main:'index.js',exports:{'.':'./index.js','./client':'./client.js'},dsh:{client:{platform:'web'}}}))
await writeFile(join(probe,'index.js'),'export function apply() {}')
await writeFile(join(probe,'client.js'),"window.__ModuleLoader__.load({id:'@dsh-desktop/candidate-smoke',factory:()=>({inject:['locale'],apply(ctx){window.candidateSmokeContext=ctx}})})")
await writeFile(join(home,'cordis.patch.yml'),offlineModelPatch+'\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: "2026-09-28.1"\n- insert:\n    - id: candidate-smoke-probe\n      name: '+pathToFileURL(join(probe,'index.js')).href+'\n')
await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version,bin:{dsh:'lib/bin.js'},scripts:{postinstall:'node install.cjs'}}))
await writeFile(join(pkg,'install.cjs'),"require('node:fs').writeFileSync('install-env.json',JSON.stringify({home:process.env.DSH_HOME,cwd:process.cwd()}))")
await mkdir(join(pkg,'lib'),{recursive:true})
await writeFile(join(pkg,'lib/bin.js'),`#!/usr/bin/env node\nif (!process.env.DSH_HOME.endsWith('probe-home')) process.exit(1);process.stdout.write('${version}')\n`)
const packed=JSON.parse(execFileSync(process.execPath,[npm,'pack','--json','--ignore-scripts','--cache',join(root,'pack-cache')],{cwd:pkg,windowsHide:true,encoding:'utf8'}))[0]
const tarball=await readFile(join(pkg,packed.filename))
const registry=createServer((req,res)=>{
  if(mode==='fail') {res.writeHead(503);res.end('unavailable');return}
  if(mode==='hang') {pendingRequest=req;return}
  if(req.url==='/fixture.tgz') {res.writeHead(200,{'content-type':'application/octet-stream'});res.end(tarball);return}
  const manifest={name:'@deepseek-ai/dsh',version,bin:{dsh:'lib/bin.js'},scripts:{postinstall:'node install.cjs'},dist:{tarball:`http://127.0.0.1:${registry.address().port}/fixture.tgz`,
    shasum:createHash('sha1').update(tarball).digest('hex')}}
  res.writeHead(200,{'content-type':'application/json'})
  res.end(JSON.stringify(req.url.endsWith('/dist-tags') ? {latest:version} : req.url.endsWith('/versions') ? [version]
    : {name:manifest.name,'dist-tags':{latest:version},versions:{[version]:manifest}}))
})
await new Promise(resolve=>registry.listen(0,'127.0.0.1',resolve))
const cdp=createServer();await new Promise(resolve=>cdp.listen(0,'127.0.0.1',resolve));const port=cdp.address().port;await new Promise(resolve=>cdp.close(resolve))
async function wait(fn,label,timeout=90000) {
  const end=Date.now()+timeout
  while(Date.now()<end) {if(child?.exitCode!==null && child?.exitCode!==undefined)throw Error('desktop exited');try{const v=await fn();if(v)return v}catch{}await new Promise(r=>setTimeout(r,150))}
  throw Error('timeout: '+label)
}
async function state(){return JSON.parse(await readFile(join(root,'state.json'),'utf8'))}
try {
  await writeFile(join(root,'command.json'),'{}');await writeFile(join(root,'state.json'),'{}')
  child=spawn(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'),[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,
    DSH_HOME:home,DSH_DESKTOP_SMOKE_DIR:root,DSH_DESKTOP_DSH:source,DSH_DESKTOP_NODE:process.execPath,DSH_UI_SMOKE_KEY:'mock-key',
    npm_config_registry:`http://127.0.0.1:${registry.address().port}/`,npm_config_cache:join(root,'npm-cache'),npm_config_userconfig:join(root,'npmrc'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}})
  await wait(async()=>{const s=await state();return s.backend==='running'&&s.loaded},'source backend')
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port)
  const page=await wait(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:')&&!p.url().includes('tauri.localhost')),'source page')
  await handleOnboarding(page)
  const sourceState=await state()
  const identity=await page.evaluate(()=>window.__DSH_REMOTE_IDENTITY__)
  const invoke=(command,args)=>page.evaluate(async({command,args})=>{
    try{return {value:await window.__TAURI__.core.invoke(command,args)}}catch(error){return {error:String(error?.message||error)}}
  },{command,args})
  const unchanged=async()=>{
    const s=await state();assert.equal(s.backend,'running');assert.equal(s.identity.backendInstance,sourceState.identity.backendInstance)
    assert.equal(s.runtime.dsh_bin,sourceState.runtime.dsh_bin);assert.equal(s.hasSnapshot,false)
    assert.equal(await readFile(join(root,'runtime/selection.json')).then(()=>true,()=>false),false)
    assert.equal(await readFile(join(root,'runtime/first-install.json')).then(()=>true,()=>false),false)
  }
  const failure='failed local registry installation keeps backend and selection unchanged'
  if(!report.checks.includes(failure)) {
    mode='fail'
    const result=await invoke('prepare_dsh_candidate',{identity,requestId:randomUUID(),targetVersion:version})
    assert.match(result.error,/runtime-candidate-install-failed/);await unchanged();await pass(failure)
  }
  const cancellation='cancellation terminates actual npm and releases preparation without stopping backend'
  if(!report.checks.includes(cancellation)) {
    mode='hang';pendingRequest=undefined;const requestId=randomUUID()
    await page.evaluate(({identity,requestId,version})=>{
      window.candidatePending=window.__TAURI__.core.invoke('prepare_dsh_candidate',{identity,requestId,targetVersion:version})
        .then(value=>({value}),error=>({error:String(error?.message||error)}))
    },{identity,requestId,version})
    await wait(()=>pendingRequest,'npm registry request')
    const cancel=await invoke('cancel_dsh_candidate',{identity,requestId});assert.ok(!cancel.error,cancel.error)
    const result=await page.evaluate(()=>window.candidatePending);assert.match(result.error,/runtime-candidate-cancelled/)
    registry.closeAllConnections();await unchanged();await pass(cancellation)
  }
  const success='actual exact-version npm candidate freezes successfully without selection or first-install mutation'
  if(!report.checks.includes(success)) {
    mode='success'
    const result=await invoke('prepare_dsh_candidate',{identity,requestId:randomUUID(),targetVersion:version})
    assert.ok(!result.error,result.error);assert.equal(result.value.version,version);assert.equal(result.value.switchAvailable,false)
    const manifest=JSON.parse(await readFile(join(root,'runtime/versions',result.value.id,'manifest.json'),'utf8'))
    assert.equal(manifest.version,version);assert.equal(manifest.fingerprint,result.value.fingerprint)
    await unchanged();report.candidate=result.value;await pass(success)
  }
  const stale='stale identity and moving version tags are refused before candidate installation'
  if(!report.checks.includes(stale)) {
    const dirs=await readdir(join(root,'runtime/candidates'))
    assert.ok((await invoke('prepare_dsh_candidate',{identity:{...identity,documentGeneration:identity.documentGeneration+1},requestId:randomUUID(),targetVersion:version})).error)
    assert.match((await invoke('prepare_dsh_candidate',{identity,requestId:randomUUID(),targetVersion:'latest'})).error,/version-invalid/)
    assert.deepEqual(await readdir(join(root,'runtime/candidates')),dirs);await unchanged();await pass(stale)
  }
  const legacy='cached legacy update request is rejected before global installation or backend stop'
  if(!report.checks.includes(legacy)) {
    // The retired command must reject before it inspects or stores a payload.
    // Use a deserializable empty page so this test has no capture side effects.
    const payload={schemaVersion:1,frontendVersion:sourceState.runtime.version,page:{kind:'dsh',route:'/',sessionId:null,workspaceId:null},
      drafts:[],assets:[],layout:{sidebar:240,narrowExpanded:false,rightbar:null,panel:null},scrolls:[],dialogs:[],capabilities:[],blocked:[],sessionStorage:{}}
    const result=await invoke('install_dsh_update',{identity,payload,channel:'preview',targetVersion:version})
    assert.match(result.error,/安全数据检查点与迁移契约尚未完成/);await unchanged();await pass(legacy)
  }
  const actualButtons='actual desktop update buttons show candidate-only status and cancel without capturing UI'
  if(!report.checks.includes(actualButtons)) {
    await page.waitForFunction(()=>!!window.__DSH_DSH_UPDATE__?.getSnapshot()?.versions && !!window.candidateSmokeContext)
    await page.evaluate(()=>window.candidateSmokeContext.locale.setLocale('zh'))
    await page.evaluate(()=>window.__DSH_DSH_UPDATE__.show())
    await page.getByText('当前操作只准备独立候选版本。准备完成后继续使用当前版本，自动切换与回退尚未开放。',{exact:true}).waitFor()
    mode='hang';pendingRequest=undefined
    await page.getByRole('button',{name:'最新稳定版',exact:true}).click()
    await page.getByText('正在准备候选版本…',{exact:true}).waitFor()
    await page.getByText('正在安装并校验独立候选版本，请稍候…',{exact:true}).waitFor()
    await wait(()=>pendingRequest,'button starts npm')
    await unchanged();await page.screenshot({path:join(root,'candidate-preparing-zh.png')})
    await page.getByRole('button',{name:'取消准备',exact:true}).click()
    await page.getByText('候选准备已取消，当前版本继续运行。',{exact:true}).waitFor();registry.closeAllConnections()
    mode='success';await unchanged()
    await page.evaluate(()=>window.candidateSmokeContext.locale.setLocale('en'))
    await page.getByText('This prepares an independent candidate version. The current version keeps running; automatic switching and rollback are not yet available.',{exact:true}).waitFor()
    await page.getByText('Candidate preparation was cancelled. The current version keeps running.',{exact:true}).waitFor()
    await page.screenshot({path:join(root,'candidate-cancelled-en.png')})
    await pass(actualButtons)
  }
  const locale='preparation text and cancelled result follow the current locale after switching languages'
  if(!report.checks.includes(locale)) {
    await page.waitForFunction(()=>!!window.__DSH_DSH_UPDATE__?.getSnapshot()?.versions && !!window.candidateSmokeContext)
    await page.evaluate(()=>window.candidateSmokeContext.locale.setLocale('zh'))
    await page.evaluate(()=>window.__DSH_DSH_UPDATE__.show());mode='hang';pendingRequest=undefined
    await page.getByRole('button',{name:'最新稳定版',exact:true}).click()
    await page.getByText('正在安装并校验独立候选版本，请稍候…',{exact:true}).waitFor()
    await wait(()=>pendingRequest,'locale scenario npm')
    await page.screenshot({path:join(root,'candidate-preparing-zh.png')})
    await page.getByRole('button',{name:'取消准备',exact:true}).click()
    await page.getByText('候选准备已取消，当前版本继续运行。',{exact:true}).waitFor();registry.closeAllConnections();mode='success'
    await page.evaluate(()=>window.candidateSmokeContext.locale.setLocale('en'))
    await page.getByText('Candidate preparation was cancelled. The current version keeps running.',{exact:true}).waitFor()
    await page.screenshot({path:join(root,'candidate-cancelled-en.png')});await unchanged();await pass(locale)
  }
  const isolated='npm lifecycle scripts and both version probes use an isolated candidate home'
  if(!report.checks.includes(isolated)) {
    mode='success'
    const result=await invoke('prepare_dsh_candidate',{identity,requestId:randomUUID(),targetVersion:version})
    assert.ok(!result.error,result.error)
    const fixture=JSON.parse(await readFile(join(root,'runtime/versions',result.value.id,'tree/node_modules/@deepseek-ai/dsh/install-env.json'),'utf8'))
    assert.ok(fixture.home.startsWith(join(root,'runtime/candidates')))
    assert.ok(fixture.home.endsWith('probe-home'));assert.notEqual(fixture.home,home)
    await unchanged();await pass(isolated)
  }
  if(report.error)(report.previousFailures ||= []).push(report.error);delete report.error;await save()
} catch(error){report.error=error.stack;await save();throw error}
finally {
  if(browser)await browser.close()
  if(child?.pid && child.exitCode===null) {
    await writeFile(join(root,'command.json'),JSON.stringify({sequence:Date.now(),action:'quit'}))
    const end=Date.now()+10000;while(child.exitCode===null && Date.now()<end)await new Promise(r=>setTimeout(r,100))
    if(child.exitCode===null)try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}
  }
  registry.closeAllConnections();await new Promise(resolve=>registry.close(resolve))
  console.log('Artifacts: '+root)
}
