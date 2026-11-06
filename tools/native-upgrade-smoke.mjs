// Run after a debug build with a separate TAURI_CONFIG identifier. Uses an
// isolated DSH_HOME, downloads only the requested public npm package, and
// exercises real UI/native IPC without model requests.
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp,mkdir,rmdir,writeFile,readFile,copyFile,cp,symlink,lstat,readlink,readdir,appendFile} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {createServer} from 'node:net'
import {offlineModelPatch,handleOnboarding} from './dsh-ui-helpers.mjs'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root=process.env.DSH_UPGRADE_SOURCE_ROOT ? resolve(process.env.DSH_UPGRADE_SOURCE_ROOT)
  : process.env.DSH_UPGRADE_RESUME || await mkdtemp(resolve('src-tauri/target/native-upgrade-'))
const home=join(root,'home'),workspace=join(root,'workspace'),exe=join(root,'deepseek-harness-desktop.exe')
const bin=join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const report=process.env.DSH_UPGRADE_RESUME
  ? JSON.parse(await readFile(join(root,'report.json'),'utf8')) : {root,checks:[],stages:[]}
if(report.error){(report.previousFailures??=[]).push(report.error);delete report.error}
const save=()=>writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
const pass=async name=>{if(!report.checks.includes(name))report.checks.push(name);await save();console.log('PASS: '+name)}
await mkdir(home,{recursive:true});await mkdir(workspace,{recursive:true})
if(!process.env.DSH_UPGRADE_RESUME) await writeFile(join(home,'cordis.patch.yml'),offlineModelPatch)
if(!process.env.DSH_UPGRADE_RESUME && process.env.DSH_UPGRADE_PERF_DATA_SOURCE)
  await cp(resolve(process.env.DSH_UPGRADE_PERF_DATA_SOURCE),join(home,'update-perf-data'),{recursive:true})
// Reproduce the shared npm dependency junctions present in real, older homes.
const external=join(root,'external-package'),moduleLink=join(home,'profiles/node_modules/checkpoint-regression')
if(!process.env.DSH_UPGRADE_RESUME) {
  await mkdir(external,{recursive:true});await writeFile(join(external,'sentinel'),'external dependency is untouched')
  await mkdir(dirname(moduleLink),{recursive:true});await symlink(external,moduleLink,'junction')
  await symlink(join(root,'absent-package'),join(dirname(moduleLink),'checkpoint-dangling'),'junction')
}
// Legacy successful, partial, and rolled-back upgrade folders must all be
// removed by the next successful commit, including nested dependency links.
const obsolete=(await readdir(root)).filter(name=>/^\.dsh-update-[0-9a-f-]{36}-(before|failed)$/.test(name)).map(name=>join(root,name))
for(const suffix of process.env.DSH_UPGRADE_RESUME ? [] : ['before','before','failed']) {
  const path=join(root,`.dsh-update-${randomUUID()}-${suffix}`)
  await mkdir(path);await writeFile(join(path,'sentinel'),'obsolete update data')
  await symlink(external,join(path,'external-package'),'junction');obsolete.push(path)
}
let cachedTarget,cachedSource,cachedDestination
if(process.env.DSH_UPGRADE_CANDIDATE_ROOT) {
  const cached=JSON.parse(await readFile(join(process.env.DSH_UPGRADE_CANDIDATE_ROOT,'runtime/update.json'),'utf8')).target
  const destination=cachedDestination=join(root,'runtime/versions',cached.managed.id)
  cachedSource=join(process.env.DSH_UPGRADE_CANDIDATE_ROOT,'runtime/versions',cached.managed.id)
  cachedTarget={...cached,dsh_bin:join(destination,'tree/node_modules/@deepseek-ai/dsh/lib/bin.js')}
}
const builtHost=resolve(process.env.DSH_UPGRADE_EXE || 'src-tauri/target/debug/deepseek-harness-desktop.exe')
if(builtHost!==exe)await copyFile(builtHost,exe)
for(const [source,destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8')).bundle.resources)) {
  const path=join(root,destination);await mkdir(dirname(path),{recursive:true});await copyFile(resolve('src-tauri',source),path)
}
let child,browser,page,lockChild
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),state=async()=>JSON.parse(await readFile(join(root,'state.json'),'utf8'))
async function wait(fn,label,timeout=120000) {
  const end=Date.now()+timeout;let last
  while(Date.now()<end) {try {const v=await fn();if(v)return v}catch(e){if(e.fatal)throw e;last=e.message}
    if(child?.exitCode!==null && child?.exitCode!==undefined)throw Object.assign(Error('desktop exited during '+label+': '+child.exitCode),{fatal:true})
    await sleep(250)}
  throw Error('timeout '+label+(last?' ('+last+')':''))
}
async function start({offline=false}={}) {
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r))
  await writeFile(join(root,'state.json'),'{}');await writeFile(join(root,'command.json'),'{}')
  const env={...process.env,DSH_HOME:home,DSH_DESKTOP_DSH:bin,DSH_DESKTOP_NODE:process.execPath,
    DSH_DESKTOP_SMOKE_DIR:root,DSH_DESKTOP_DEBUG:join(root,'debug.log'),DSH_UI_SMOKE_KEY:'offline',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}
  if(process.env.DSH_UPGRADE_SOURCE_ROOT)delete env.DSH_DESKTOP_DSH
  if(offline)Object.assign(env,{npm_config_registry:'http://127.0.0.1:1/',npm_config_offline:'true',npm_config_fetch_retries:'0'})
  child=spawn(exe,[],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe'],env})
  await writeFile(join(root,'cdp-port.txt'),String(port))
  child.stderr.on('data',data=>appendFile(join(root,'stderr.log'),data).catch(()=>{}))
  child.on('exit',(code,signal)=>writeFile(join(root,'child-exit.json'),JSON.stringify({code,signal,time:Date.now()})).catch(()=>{}))
  browser=await wait(()=>chromium.connectOverCDP('http://127.0.0.1:'+port),'CDP')
  page=await wait(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:')),'page')
  await handleOnboarding(page)
  await wait(async()=>{const s=await state();return s.backend==='running'&&s.loaded},'backend')
  await page.waitForFunction(offline=>window.__DSH_SMOKE_CONTEXT__ && window.__DSH_UI_STATE__ && (offline || window.__DSH_DSH_UPDATE__?.getSnapshot()?.versions),offline)
}
async function quit(force=false) {
  if(child?.exitCode===null) {
    if(!force){await writeFile(join(root,'command.json'),JSON.stringify({sequence:Date.now(),action:'quit'}));await wait(()=>child.exitCode!==null,'quit',10000).catch(()=>{})}
    if(child.exitCode===null)try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}
  }
  await browser?.close().catch(()=>{});browser=null
}
async function holdFile(path) {
  lockChild=spawn('powershell.exe',['-NoProfile','-Command',"$checkpointStream=[IO.File]::Open($env:DSH_CHECKPOINT_TEST_FILE,'Open','Read','None'); Write-Output 'LOCKED'; [Console]::ReadLine() | Out-Null; $checkpointStream.Dispose()"],
    {windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,DSH_CHECKPOINT_TEST_FILE:path}})
  let locked=false;lockChild.stdout.on('data',data=>{if(String(data).includes('LOCKED'))locked=true})
  await wait(()=>locked,'exclusive checkpoint file',10000)
}
async function importCachedTarget() {
  if(!cachedTarget)return
  // Startup and an earlier rollback may reclaim an unreferenced candidate.
  // Re-import the isolated fixture only after reclamation finishes.
  await wait(async()=>!(await state()).runtimeCleanupPending,'reclamation before fixture import')
  if(!await lstat(join(cachedDestination,'manifest.json')).then(()=>true,()=>false))await cp(cachedSource,cachedDestination,{recursive:true})
}
try {
  await start();console.log('Test directory: '+root)
  await importCachedTarget()
  const initial=await state();report.sourceVersion=initial.runtime.version
  if(process.env.DSH_UPGRADE_SOURCE_ROOT)assert.equal(initial.runtime.source,'managed')
  const versions=await page.evaluate(()=>window.__DSH_DSH_UPDATE__.getSnapshot().versions);report.targetVersion=versions.preview
  assert.equal(versions.stagedUpdate,true);assert.notEqual(versions.current,versions.preview)
  const id=await page.evaluate(async path=>{
    const ctx=window.__DSH_SMOKE_CONTEXT__,workspace=await ctx.workspaces.create({path});const id=await ctx.sessions.create({workspaceId:workspace.workspaceId});
    await ctx.uiWorkspace.openSession(id);return id
  },workspace);report.sessionId=id
  await page.waitForFunction(id=>window.__DSH_SMOKE_CONTEXT__.conversation.input.for(window.__DSH_SMOKE_CONTEXT__.sessions.scope(id))?.editor.getRootElement(),id)
  const draft='升级后仍然保留的测试草稿'
  // Set the documented draft model. Filling contenteditable's DOM directly
  // can leave Lexical's state empty, which cannot test draft restoration.
  await page.evaluate(({id,draft})=>{
    const ctx=window.__DSH_SMOKE_CONTEXT__;ctx.conversation.input.for(ctx.sessions.scope(id)).setDraft(draft)
  },{id,draft})
  async function verifyDraft() {
    await page.waitForFunction(({id,draft})=>{
      const ctx=window.__DSH_SMOKE_CONTEXT__,input=ctx.conversation.input.for(ctx.sessions.scope(id))
      return input?.state.getSnapshot().draft===draft&&input.editor.getRootElement()?.textContent.includes(draft)
    },{id,draft},{timeout:15000})
  }
  await verifyDraft()
  async function switchTo(target) {
    await verifyDraft()
    // Manual IPC bypasses locator handlers. Run their actionability check so
    // initial welcome dialogs finish before the native snapshot is captured.
    await page.locator('#root').click({trial:true})
    await importCachedTarget()
    await writeFile(join(root,'upgrade-reused.json'),'{}')
    await writeFile(join(root,'command.json'),JSON.stringify({sequence:Date.now(),action:'upgrade-reuse-candidate',target}))
    const reused=await wait(async()=>{const value=JSON.parse(await readFile(join(root,'upgrade-reused.json'),'utf8'));return value.ready||value.error ? value : null},'verified cached candidate',300000)
    assert.equal(reused.ready,true,reused.error)
    const attempt=Date.now()
    await page.evaluate(async target=>{
      window.upgradeError=undefined
      const payload=await window.__DSH_UI_STATE__.prepareRemoteApply(window.__DSH_DSH_UPDATE__.getSnapshot().versions.current,'正在更新…')
      window.upgradePending=window.__TAURI__.core.invoke('install_dsh_update',{identity:window.__DSH_REMOTE_IDENTITY__,payload,channel:'preview',targetVersion:target.version,candidateId:target.managed.id})
        .catch(error=>{window.upgradeError=String(error)})
    },target)
    return attempt
  }
  if (cachedTarget && process.env.DSH_UPGRADE_TEST_ROLLBACK) {
    const checkpointCheck='checkpoint failure restores old UI, shows the original error, preserves the journal cause, and removes partial copies'
    const publicationCheck='record publication failure removes the unpublished checkpoint while preserving historical recovery data'
    if(!report.checks.includes(checkpointCheck)) {
    const lockFile=join(home,'checkpoint-locked');await writeFile(lockFile,'locked checkpoint regression')
    await holdFile(lockFile)
    const checkpointAttempt=await switchTo(cachedTarget)
    await wait(async()=>{const s=await state();const p=await page.evaluate(()=>window.__TAURI__.core.invoke('dsh_update_progress')).catch(()=>null)
      return p?.startedAt>=checkpointAttempt&&p.step==='rolled-back'&&s.phase==='active'&&!s.hasSnapshot},'checkpoint failure restores original UI')
    const failure=await page.evaluate(()=>window.__TAURI__.core.invoke('dsh_update_progress'))
    assert.ok(failure.error);assert.equal((await state()).runtime.version,versions.current)
    await verifyDraft()
    await wait(async()=>!(await state()).runtimeCleanupPending && !await lstat(join(root,'runtime/versions',cachedTarget.managed.id)).then(()=>true,()=>false),'failed checkpoint candidate reclaimed')
    await page.evaluate(()=>window.__DSH_DSH_UPDATE__.show())
    await page.locator('.dshTb__updateError').waitFor({timeout:120000});assert.equal(await page.locator('.dshTb__updateError').textContent(),failure.error)
    await page.getByRole('dialog').getByRole('button',{name:/^(关闭窗口|Close window)$/}).click()
    const journals=await Promise.all((await readdir(join(root,'maintenance/operations'))).map(async name=>JSON.parse(await readFile(join(root,'maintenance/operations',name),'utf8'))))
    assert.ok(journals.some(j=>j.stage==='rolled-back'&&j.errorCode==='update-checkpoint-failed'))
    const leftovers=await readdir(root)
    assert.equal(leftovers.filter(name=>name.startsWith('.dsh-update-')&&name.endsWith('-before')).length,obsolete.filter(path=>path.endsWith('-before')).length)
    for(const path of obsolete)assert.equal(await readFile(join(path,'sentinel'),'utf8'),'obsolete update data')
    lockChild.stdin.end('\n');await wait(()=>lockChild.exitCode!==null,'unlock checkpoint',10000);lockChild=null
    await pass(checkpointCheck)
    }
    if(!report.checks.includes(publicationCheck)) {
    const recordPath=join(root,'runtime/update.json')
    await mkdir(recordPath)
    const recordAttempt=await switchTo(cachedTarget)
    await wait(async()=>{const s=await state();const p=await page.evaluate(()=>window.__TAURI__.core.invoke('dsh_update_progress')).catch(()=>null)
      return p?.startedAt>=recordAttempt&&p.step==='rolled-back'&&s.phase==='active'&&!s.hasSnapshot},'record save failure restores original UI')
    assert.equal((await page.evaluate(()=>window.__TAURI__.core.invoke('dsh_update_progress'))).error,'update-record-save-failed')
    assert.equal((await state()).runtime.version,versions.current)
    await verifyDraft()
    assert.equal((await readdir(root)).filter(name=>name.startsWith('.dsh-update-')&&name.endsWith('-before')).length,obsolete.filter(path=>path.endsWith('-before')).length)
    await rmdir(recordPath)
    await pass(publicationCheck)
    }
    if(obsolete.length)await holdFile(join(obsolete[0],'sentinel'))
  }
  const started=Date.now()
  if (process.env.DSH_UPGRADE_RESUME || cachedTarget) {
    const target=cachedTarget || JSON.parse(await readFile(join(root,'runtime/update.json'),'utf8')).target
    assert.equal(target.version,versions.preview,'reused candidate must match the current registry version')
    await switchTo(target)
  } else {
    await page.evaluate(()=>window.__DSH_DSH_UPDATE__.show())
    await page.getByRole('button',{name:/^(最新预览版|Latest preview)$/}).click()
  }
  let last
  await wait(async()=>{
    let currentProgress
    try {
      const progress=await page.evaluate(()=>window.__TAURI__.core.invoke('dsh_update_progress'))
      if(progress?.updatedAt>=started)currentProgress=progress
      if(currentProgress?.step&&currentProgress.step!==last){last=currentProgress.step;report.stages.push(last);console.log('STAGE: '+last);await save()}
    }catch{}
    const s=await state()
    if(currentProgress?.step==='rolled-back'&&s.phase==='active')throw Object.assign(Error(currentProgress.error||'upgrade rolled back; inspect debug.log'),{fatal:true})
    if(Date.now()-started>5000 && s.backend==='running') {
      const error=await page.evaluate(()=>window.upgradeError).catch(()=>null)
      if(error)throw Object.assign(Error(error),{fatal:true})
    }
    return s.runtime?.version===report.targetVersion&&s.phase==='active'&&!s.hasSnapshot
  },'upgrade commit',900000)
  const record=JSON.parse(await readFile(join(root,'runtime/update.json'),'utf8'))
  report.upgradeElapsedMs=Date.now()-started
  assert.equal((await page.evaluate(()=>window.__TAURI__.core.invoke('dsh_update_progress'))).error,null)
  assert.equal(record.stage,'committed');assert.equal(record.target.version,versions.preview)
  await wait(async()=>{
    const selection=JSON.parse(await readFile(join(root,'runtime/selection.json'),'utf8'))
    const directories=await readdir(join(root,'runtime/versions'))
    return selection.previous===null && directories.length===1 && directories[0]===record.target.managed.id && !(await state()).runtimeCleanupPending
  },'retain only the committed runtime',300000)
  const selection=JSON.parse(await readFile(join(root,'runtime/selection.json'),'utf8'));assert.equal(selection.active,record.target.managed.id)
  assert.equal(selection.previous,null)
  assert.deepEqual(await readdir(join(root,'runtime/candidates')).catch(error=>{if(error.code!=='ENOENT')throw error;return []}),[])
  assert.deepEqual(await readdir(join(root,'runtime/installing')).catch(error=>{if(error.code!=='ENOENT')throw error;return []}),[])
  if(initial.runtime.managed)assert.equal(await lstat(join(root,'runtime/versions',initial.runtime.managed.id)).then(()=>true,()=>false),false)
  assert.equal(await lstat(bin).then(()=>true,()=>false),true)
  await pass('full update commit retains only the current runtime and reclaims previous versions and installation staging')
  assert.match(await page.locator('[contenteditable=true]').first().textContent(),/升级后仍然保留/)
  assert.equal((await lstat(moduleLink)).isSymbolicLink(),true)
  assert.equal(await readlink(moduleLink),external)
  assert.equal(await readFile(join(external,'sentinel'),'utf8'),'external dependency is untouched')
  assert.equal(record.checkpoint.files.some(entry=>entry.path.replaceAll('\\','/').startsWith('profiles/node_modules/checkpoint-regression/')),false)
  await pass('shared and dangling npm junctions survive update without traversing external dependency targets')
  assert.equal(await lstat(record.checkpoint.saved).then(()=>true,()=>false),false)
  assert.equal((await readdir(root)).filter(name=>name.startsWith('.dsh-update-')&&/-(before|failed)$/.test(name)).length,lockChild?1:0)
  await pass('successful commit deletes its backup, obsolete backups, partial captures and failed update data')
  await page.screenshot({path:join(root,'upgraded.png')});await pass('actual preview installs, checkpoints data, restores draft, and commits selection')
  if(lockChild) {
    assert.match(await readFile(join(root,'debug.log'),'utf8'),/checkpoint cleanup will retry on startup/)
    lockChild.stdin.end('\n');await wait(()=>lockChild.exitCode!==null,'unlock obsolete checkpoint',10000);lockChild=null
    await pass('a locked historical backup does not roll back a successful upgrade or block other deletions')
  }
  await quit();await start({offline:true});assert.equal((await state()).runtime.version,versions.preview)
  await wait(async()=>!(await state()).runtimeCleanupPending,'cold-start runtime reclamation')
  assert.deepEqual(await readdir(join(root,'runtime/versions')),[record.target.managed.id])
  assert.equal((await readdir(root)).some(name=>name.startsWith('.dsh-update-')&&/-(before|failed)$/.test(name)),false)
  assert.equal(await readFile(join(external,'sentinel'),'utf8'),'external dependency is untouched')
  await pass('cold startup retries cleanup from the committed record and leaves external dependencies intact')
  await pass('cold restart uses the committed version even when the original configured entry remains present')
  await pass('an unavailable npm registry does not prevent cold startup of the sole retained runtime')
} catch(error){report.error=error.stack;await save();if(page)await page.screenshot({path:join(root,'failure.png')}).catch(()=>{});throw error}
finally {if(lockChild){lockChild.stdin.end('\n');lockChild.kill()}await quit();await save();console.log('Artifacts: '+root)}
