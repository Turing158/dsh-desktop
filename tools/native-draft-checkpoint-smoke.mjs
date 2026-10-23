// Actual idle draft saves and cold recovery. All homes/workspaces are disposable;
// no model calls, global installation or normal notification shortcut writes.
import assert from 'node:assert/strict'
import { spawn,execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp,mkdir,writeFile,readFile,readdir,copyFile } from 'node:fs/promises'
import { resolve,join,dirname } from 'node:path'
import { createServer } from 'node:net'
import { handleOnboarding,dismissInitialWelcome,offlineModelPatch } from './dsh-ui-helpers.mjs'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root=await mkdtemp(resolve('src-tauri/target/native-draft-checkpoints-')),home=join(root,'home'),workspace=join(root,'workspace'),packages=join(root,'maintenance/recovery')
await mkdir(home);await mkdir(workspace);await writeFile(join(home,'cordis.patch.yml'),offlineModelPatch)
const exe=join(root,'deepseek-harness-desktop.exe'),bin=process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'),exe)
for(const [source,destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8')).bundle.resources)) {
  const target=join(root,destination);await mkdir(dirname(target),{recursive:true});await copyFile(resolve('src-tauri',source),target)
}
let child,browser,page,sequence=0
const report={root,checks:[]},pass=name=>{report.checks.push(name);console.log('PASS: '+name)},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function start() {
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve))
  child=spawn(exe,[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,DSH_HOME:home,DSH_DESKTOP_SMOKE_DIR:root,DSH_DESKTOP_DSH:bin,DSH_DESKTOP_NODE:process.execPath,DSH_UI_SMOKE_KEY:'mock-key',DSH_DESKTOP_WEBVIEW_RESTORE:'1',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}})
  for(let i=0;i<400;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);break}catch{}if(child.exitCode!==null)throw Error('desktop exited');await sleep(100)}
  for(let i=0;i<400;i++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().startsWith('http://127.0.0.1:') && !page.url().includes(':1430'));if(page)break;await sleep(100)}
  assert.ok(page);page.setDefaultTimeout(25_000);await handleOnboarding(page)
  await page.waitForFunction(()=>window.__DSH_SMOKE_CONTEXT__?.sessions.list.getSnapshot().phase==='ready' && window.__DSH_REMOTE_IDENTITY__ && window.__DSH_CREATE_DRAFT_CHECKPOINTS__)
}
async function kill() {
  if(child?.exitCode===null)try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}
  await browser?.close().catch(()=>{});browser=undefined;await sleep(300)
}
async function listPackages() {
  const names=(await readdir(packages).catch(()=>[])).filter(name=>name.endsWith('.json'))
  return Promise.all(names.map(async name=>JSON.parse(await readFile(join(packages,name),'utf8'))))
}
async function waitPackage(text) {
  for(let i=0;i<500;i++) {
    const rows=await listPackages(),found=rows.find(row=>row.draftsOnly && row.payload.drafts.some(draft=>draft.text===text))
    if(found)return found
    await sleep(100)
  }
  const status=await page.evaluate(()=>window.__DSH_UI_STATE__.checkpointStatus())
  throw Error('background checkpoint missing: '+JSON.stringify(status))
}
async function open(id) {
  await page.evaluate(id=>window.__DSH_SMOKE_CONTEXT__.uiWorkspace.openSession(id),id)
  await page.waitForFunction(id=>window.__DSH_SMOKE_CONTEXT__.conversation.input.for(window.__DSH_SMOKE_CONTEXT__.sessions.scope(id))?.editor.getRootElement(),id)
}
try {
  await start();await dismissInitialWelcome(page)
  const ids=await page.evaluate(async path=>{
    const ctx=window.__DSH_SMOKE_CONTEXT__,workspace=await ctx.workspaces.create({path})
    return [await ctx.sessions.create({workspaceId:workspace.workspaceId}),await ctx.sessions.create({workspaceId:workspace.workspaceId})]
  },workspace)
  await open(ids[0]);await page.locator('[contenteditable=true]').first().fill('后台草稿一')
  await page.evaluate(id=>{
    const ctx=window.__DSH_SMOKE_CONTEXT__,input=ctx.conversation.input.for(ctx.sessions.scope(id))
    input.addAttachments(ctx.conversation.createDrafts(id,[new File(['durable idle bytes'],'idle.txt',{type:'text/plain'})]).map(a=>a.id))
  },ids[0])
  const first=await waitPackage('后台草稿一');assert.equal(first.payload.dialogs.length,0);assert.equal(first.payload.assets[0].name,'idle.txt')
  assert.equal(Buffer.from(first.payload.assets[0].data,'base64').toString(),'durable idle bytes')
  assert.equal(first.payload.drafts[0].editor,null);assert.equal(first.payload.page.sessionId,null)
  pass('idle WebView input saves semantic drafts and exact attachment bytes without a maintenance restart')
  await page.locator('[contenteditable=true]').first().fill('后台草稿二')
  const second=await waitPackage('后台草稿二');assert.equal(second.recoveryId,first.recoveryId);assert.equal((await listPackages()).filter(row=>row.draftsOnly).length,1)
  pass('later input atomically replaces only the same-page checkpoint within bounded write frequency')
  const throttle=await page.evaluate(async payload=>{
    try {await window.__TAURI__.core.invoke('desktop_draft_checkpoint',{identity:window.__DSH_REMOTE_IDENTITY__,payload});return 'accepted'}catch(error){return String(error)}
  },second.payload);assert.match(throttle,/recovery-checkpoint-throttled/)
  pass('native checkpoint command enforces write frequency independently of frontend scheduling')
  await kill();await start();await open(ids[1])
  await page.evaluate(id=>window.__TAURI__.core.invoke('desktop_recovery_restore',{identity:window.__DSH_REMOTE_IDENTITY__,recoveryId:id}),second.recoveryId)
  for(let i=0;i<300 && (await listPackages()).some(row=>row.recoveryId===second.recoveryId);i++)await sleep(100)
  assert.ok(!(await listPackages()).some(row=>row.recoveryId===second.recoveryId))
  const restored=await page.evaluate(id=>{
    const ctx=window.__DSH_SMOKE_CONTEXT__,input=ctx.conversation.input.for(ctx.sessions.scope(id)),list=ctx.sessions.list.getSnapshot()
    return {text:input.state.getSnapshot().draft,files:ctx.conversation.resolveDraftAttachments(input.state.getSnapshot().attachmentIds).map(a=>a.file.name),current:Object.values(list.byId).find(row=>row.retainedBy.mainView>0)?.id,pending:ctx.sessions.binding(id).session.getSnapshot().pendingSubmissions.length}
  },ids[0])
  assert.equal(restored.text,'后台草稿二');assert.deepEqual(restored.files,['idle.txt']);assert.equal(restored.current,ids[1]);assert.equal(restored.pending,0)
  pass('forced exit recovers stable draft and attachments into their original session while preserving current selection')
  const third=await waitPackage('后台草稿二')
  // New document checkpoints must not retire a package from a previous one.
  const previous=structuredClone(first);previous.recoveryId='c36f6b5d-32e4-4ca4-9757-60e9c3f1e6b';
  await writeFile(join(packages,previous.recoveryId+'.json'),JSON.stringify(previous))
  await page.evaluate(ids=>{
    const ctx=window.__DSH_SMOKE_CONTEXT__
    for(const id of ids) {
      const input=ctx.conversation.input.for(ctx.sessions.scope(id));if(!input)continue
      input.setDraft('');for(const attachment of input.state.getSnapshot().attachmentIds)input.removeAttachment(attachment)
    }
    window.__DSH_UI_STATE__.draftsChanged()
  },ids)
  for(let i=0;i<500 && (await listPackages()).some(row=>row.recoveryId===third.recoveryId);i++)await sleep(100)
  assert.ok(!(await listPackages()).some(row=>row.recoveryId===third.recoveryId));assert.ok((await listPackages()).some(row=>row.recoveryId===previous.recoveryId))
  pass('clearing drafts removes the current-page checkpoint while retaining older unresolved materials')
  const stale=await page.evaluate(async payload=>{
    try {await window.__TAURI__.core.invoke('desktop_draft_checkpoint',{identity:{...window.__DSH_REMOTE_IDENTITY__,documentGeneration:9999},payload});return false}catch{return true}
  },third.payload);assert.equal(stale,true)
  await writeFile(join(root,'command.json'),JSON.stringify({sequence:++sequence,action:'diagnostics'}))
  await page.locator('.dshMaintenance__dialog').waitFor()
  assert.equal(browser.contexts().flatMap(context=>context.pages()).length,1)
  const staleDialogDenied=await page.evaluate(async payload=>{
    try {await window.__TAURI__.core.invoke('desktop_draft_checkpoint',{identity:{backendInstance:1,documentGeneration:1,windowGeneration:1,documentNonce:[]},payload});return false}catch{return true}
  },third.payload);assert.equal(staleDialogDenied,true)
  pass('native IPC rejects stale checkpoint reports while tray diagnostics stays in the main dialog')
  await page.screenshot({path:join(root,'restored.png')})
} catch(error) {
  report.error=error.message
  if(page)await page.screenshot({path:join(root,'failure.png')}).catch(()=>{})
  throw error
} finally {
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  if(child?.exitCode===null){await writeFile(join(root,'command.json'),JSON.stringify({sequence:++sequence,action:'quit'}));await sleep(700)}
  await kill();console.log('Artifacts: '+root)
}
