// Native partial restore, UI ACK, rollback and cold interruption in an isolated
// profile. Only offline fixtures; no model request, npm install or user data.
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises'
import {writeFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {resolve,join} from 'node:path'
import {createServer} from 'node:net'
import {offlineModelPatch,handleOnboarding,dismissInitialWelcome,openDshMaintenance} from './dsh-ui-helpers.mjs'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const profileCheck=process.env.DSH_RESTORE_PROFILE_CHECK==='1'
const dialogOnly=process.env.DSH_RESTORE_DIALOG_ONLY==='1'
const resumeRoot=profileCheck && process.env.DSH_PROFILE_RESTORE_RESUME ? resolve(process.env.DSH_PROFILE_RESTORE_RESUME) : null
if(resumeRoot)assert.ok(resumeRoot.startsWith(resolve('src-tauri/target')+'\\native-profile-restore-'),'resume uses an existing isolated fixture only')
const root=resumeRoot || await mkdtemp(resolve(profileCheck?'src-tauri/target/native-profile-restore-':'src-tauri/target/native-restore-')),home=join(root,'home'),exports=join(root,'exports')
if(!resumeRoot) {await mkdir(home);await mkdir(exports);await writeFile(join(home,'cordis.patch.yml'),offlineModelPatch)}
if(profileCheck) {
  // Fixed onboarding fact belongs only to this disposable test home. A new
  // navigation during capture must not reopen unrelated product onboarding.
  const file=join(home,'cordis.patch.yml'),patch=await readFile(file,'utf8')
  if(!patch.includes('welcomeNoticeVersion'))await writeFile(file,patch+'\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: "2026-09-28.1"\n')
}
const preferences=join(home,'desktop-settings.json'),control=join(root,'backup-restore-control.json')
const pluginIntent=join(root,'desktop-plugins.json')
const selected=['desktop-preferences','plugin-intent',...(profileCheck?['profile-plugins']:[])]
const profileDir=join(home,'profiles/web'),profileSwitches=join(profileDir,'desktop-plugin-switches.json'),profilePatch=join(profileDir,'cordis.patch.yml')
let profileSource,profileSourcePatch
if(profileCheck) {
  const fixture=join(root,'profile-fixture')
  if(!resumeRoot) {
    await mkdir(fixture)
    await writeFile(join(fixture,'package.json'),JSON.stringify({name:'@dsh-desktop/profile-restore-fixture',type:'module',exports:'./index.js'}))
    await writeFile(join(fixture,'index.js'),"export function apply(ctx) {process.stdout.write('PROFILE_RESTORE_FIXTURE_ACTIVE\\n')}")
  }
  const ordinaryModule=pathToFileURL(join(fixture,'index.js')).href
  profileSourcePatch='- insert:\n    - id: profile-restore-fixture\n      name: '+ordinaryModule+'\n'
  // Let the real launcher initialize its shipped profile before adding fixtures.
  profileSource={version:1,entries:[{patchId:'profile-restore-fixture',moduleName:ordinaryModule,enabled:false,runtimeVersion:'0.2.1-rc.2'}]}
}
const source={version:1,namespaces:{'desktop-appearance':{ui:'vanilla',colorScheme:'teal',animation:'off'},other:{token:'local-keep'}}}
if(!resumeRoot) {
  await writeFile(preferences,JSON.stringify(source))
  await writeFile(pluginIntent,JSON.stringify({version:1,enabled:{'desktop-notify':true,local:true},privateField:'local-keep'}))
}
const exe=resolve('src-tauri/target/debug/deepseek-harness-desktop.exe')
const bin=process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
let child,browser,page,archive
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),report={root,checks:[]}
if(resumeRoot) {
  const previous=JSON.parse(await readFile(join(root,'report.json'),'utf8'));assert.equal(previous.root,root)
  report.checks.push(...previous.checks);report.previousFailure=previous.error
  const files=(await readdir(exports)).filter(file=>file.endsWith('.dshbackup'));assert.equal(files.length,1);archive=join(exports,files[0])
}
const pass=name=>{if(!report.checks.includes(name))report.checks.push(name);writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log('PASS: '+name)}
async function readyForNativeAction() {
  await page.keyboard.press('Escape')
  // Actionability invokes the onboarding handlers even for native API tests;
  // raw page.evaluate bypasses them and can leave a late welcome modal open.
  await page.locator('#root').click({trial:true})
  await page.evaluate(() => {
    for(const dialog of document.querySelectorAll('[role=dialog],dialog[open],[aria-modal=true]')) {
      if(dialog.closest('[data-dsh-ghost]'))continue
      for(const button of dialog.querySelectorAll('button')) {
        if(/^(继续|我知道了|Continue|Got it)$/.test(button.textContent?.trim()))button.click()
      }
    }
  })
  await page.waitForFunction(()=>![...document.querySelectorAll('[role=dialog],dialog[open],[aria-modal=true]')]
    .some(dialog=>!dialog.closest('[data-dsh-ghost]') && /预览版说明|Preview/.test(dialog.textContent||'')))
}
async function start(active=true) {
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r))
  child=spawn(exe,[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,DSH_HOME:home,DSH_UI_SMOKE_KEY:'mock-key',DSH_DESKTOP_SMOKE_DIR:root,
    DSH_DESKTOP_DSH:bin,DSH_DESKTOP_NODE:process.execPath,DSH_DESKTOP_DEBUG:join(root,'desktop.log'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}})
  for(let i=0;i<400;i++) {if(child.exitCode!==null)throw Error('Desktop exited');try {browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);break}catch{}await sleep(100)}
  assert.ok(browser)
  if(active) {await running();await handleOnboarding(page)}
  else {page=browser.contexts().flatMap(c=>c.pages())[0];assert.ok(page);page.setDefaultTimeout(25000)}
}
async function running(previous) {
  for(let i=0;i<500;i++) {
    page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:')&&!p.url().includes(':1430'))
    if(page && (!previous || page.url()!==previous)) {
      try {await page.waitForFunction(()=>window.__DSH_REMOTE_IDENTITY__ && window.__DSH_UI_STATE__ && window.__DSH_SMOKE_CONTEXT__,{},{timeout:300});break}catch{}
    }
    await sleep(100)
    if(i===499)throw Error('Backend did not become ready')
  }
  page.setDefaultTimeout(25000);await handleOnboarding(page)
  await page.waitForFunction(()=>!document.querySelector('#root[inert]'),{},{timeout:30000})
}
async function kill() {
  if(child?.exitCode===null) {try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}}
  await browser?.close().catch(()=>{});browser=null;await sleep(300)
}
async function records() {
  const base=join(root,'maintenance/configuration')
  return Promise.all((await readdir(base).catch(()=>[])).filter(n=>!n.startsWith('.')).map(async n=>({directory:join(base,n),...(JSON.parse(await readFile(join(base,n,'transaction.json'),'utf8')))})))
}
async function setCurrent(scheme) {
  const current=JSON.parse(await readFile(preferences,'utf8'));current.namespaces['desktop-appearance'].colorScheme=scheme
  await writeFile(preferences,JSON.stringify(current));return await readFile(preferences,'utf8')
}
async function inspect() {
  if(profileCheck)await readyForNativeAction()
  await writeFile(join(root,'dialog-selection.json'),JSON.stringify({folder:exports,file:archive}))
  const value=await page.evaluate(()=>window.__TAURI__.core.invoke('desktop_backup_inspect',{identity:window.__DSH_REMOTE_IDENTITY__}))
  assert.equal(value.canRestore,true);return value
}
async function restore(preview) {
  if(profileCheck)await readyForNativeAction()
  return page.evaluate(async ({preview,selected})=>{
    let payload
    try {
      const deadline=Date.now()+45000
      while(!payload) {
        try {payload=await window.__DSH_UI_STATE__.prepareRemoteApply(preview.manifest.dshVersion,undefined,{configurationRestore:true})}
        catch(error) {if(!['snapshot-input-busy','snapshot-page-not-ready'].includes(error.cause?.message) || Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,300))}
      }
      return await window.__TAURI__.core.invoke('desktop_backup_restore',{identity:window.__DSH_REMOTE_IDENTITY__,restoreHandle:preview.restoreHandle,components:selected,payload})
    } catch(error) {window.__DSH_UI_STATE__.finishRemoteApply();throw error}
  },{preview,selected})
}
async function waitStage(stage,count=1) {
  for(let i=0;i<500;i++) {const result=(await records()).filter(r=>r.stage===stage);if(result.length>=count)return result;await sleep(50)}
  throw Error('Transaction did not reach '+stage)
}
async function newStage(stage,previous) {
  for(let i=0;i<600;i++) {const result=(await records()).find(record=>record.stage===stage&&!previous.includes(record.operationId));if(result)return result;await sleep(50)}
  throw Error('New transaction did not reach '+stage)
}
async function settled(record) {
  const path=join(root,'maintenance/operations',record.operationId+'.json')
  for(let i=0;i<500;i++) {
    const journal=JSON.parse(await readFile(path,'utf8'))
    if(['complete','rolled-back'].includes(journal.stage) && journal.completedSteps.includes('ui-restored')) {
      await page.waitForFunction(()=>!document.querySelector('[data-dsh-ui-status]'),{},{timeout:30000})
      return
    }
    await sleep(50)
  }
  throw Error('Matching UI acknowledgement did not complete the restore operation')
}
async function clickReviewedRestore() {
  const button=page.getByRole('button',{name:'恢复所选配置',exact:true})
  const deadline=Date.now()+45000
  while(Date.now()<deadline) {
    await button.click()
    for(let i=0;i<60;i++) {
      if((await records()).length)return
      const text=await page.locator('.dshMaintenance__card [role=alert]').allTextContents()
      if(text.length) {
        if(!text.some(value=>value.includes('输入或提交')))throw Error(text.join('\n'))
        break
      }
      await sleep(100)
    }
    await sleep(300)
  }
  throw Error('Input did not settle before reviewed restore')
}
try {
  await start();if(!profileCheck)await dismissInitialWelcome(page)
  if(!resumeRoot) {
  if(profileCheck) {
    await kill();await writeFile(profilePatch,profileSourcePatch);await writeFile(profileSwitches,JSON.stringify(profileSource));await start()
  }
  await page.waitForFunction(()=>window.__DSH_SMOKE_CONTEXT__.sessions.list.getSnapshot().phase==='ready')
  // Capture a source backup using the native dialog path, before changing any config.
  await writeFile(join(root,'dialog-selection.json'),JSON.stringify({folder:exports,file:null}))
  archive=await page.evaluate(selected=>window.__TAURI__.core.invoke('desktop_backup_export',{identity:window.__DSH_REMOTE_IDENTITY__,components:selected}),selected)
  assert.ok(archive)
  await setCurrent('rose')
  await writeFile(pluginIntent,JSON.stringify({version:1,enabled:{'desktop-notify':false,local:true},privateField:'local-keep'}))
  if(profileCheck) {
    await writeFile(profileSwitches,JSON.stringify({...profileSource,localField:'keep',entries:[{...profileSource.entries[0],enabled:true,privateField:'local'},
      {patchId:'local-missing',moduleName:'local-missing',enabled:false,runtimeVersion:'0.2.1-rc.2'}]}))
    // Preview-only rejections occur before any checkpoint or backend stop.
    const manifest=await readFile(join(profileDir,'package.json'),'utf8')
    await writeFile(join(root,'dialog-selection.json'),JSON.stringify({folder:exports,file:archive}))
    const unchanged=await readFile(profileSwitches,'utf8')
    await writeFile(profilePatch,profileSourcePatch.replace(profileSource.entries[0].moduleName,'"@deepseek-ai/dsh-plugin-manager"'))
    await assert.rejects(inspect(),/backup-profile-target/)
    assert.equal(await readFile(profileSwitches,'utf8'),unchanged);assert.equal((await records()).length,0)
    await writeFile(profilePatch,profileSourcePatch)
    const stale=await inspect();await writeFile(profilePatch,profileSourcePatch+'- insert:\n    - id: unrelated-disabled\n      name: unrelated\n      disabled: true\n')
    await assert.rejects(restore(stale),/backup-profile-changed/)
    assert.equal(await readFile(profileSwitches,'utf8'),unchanged);assert.equal((await records()).length,0)
    await writeFile(profilePatch,profileSourcePatch)
    assert.equal(await readFile(join(profileDir,'package.json'),'utf8'),manifest)
    pass('Profile preview rejects protected or changed targets and stale composition before checkpoints, preserving switches and manifest')
  }
  await openDshMaintenance(page,'backup')
  await writeFile(join(root,'dialog-selection.json'),JSON.stringify({folder:exports,file:archive}))
  await page.getByRole('button',{name:'校验备份文件',exact:true}).click()
  await page.getByRole('button',{name:'恢复所选配置',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'恢复所选配置',exact:true}).isEnabled(),false)
  await page.getByLabel('我已核对范围，恢复将替换所选偏好或开关并重启 DSH。',{exact:true}).check()
  const old=page.url();await clickReviewedRestore()
  const [committed]=await waitStage('complete');
  if(profileCheck)pass('native Profile configuration and required runtime verification reached a durable complete transaction')
  await running(old);await settled(committed)
  } else if(!report.checks.includes('reviewed three-component UI restore applies protected Profile intent, requires matching UI ACK and preserves unrelated local fields')) {
    const committed=(await records()).find(record=>record.stage==='complete');assert.ok(committed,'reuse only a durable completed restore')
    await settled(committed)
    pass('reused prior durable three-component restore and runtime confirmation; resumed after the welcome overlay')
  }
  let current
  if(!resumeRoot || !report.checks.includes('reviewed three-component UI restore applies protected Profile intent, requires matching UI ACK and preserves unrelated local fields')) {
  current=JSON.parse(await readFile(preferences,'utf8'))
  assert.equal(current.namespaces['desktop-appearance'].colorScheme,'teal');assert.equal(current.namespaces.other.token,'local-keep')
  const plugins=JSON.parse(await readFile(pluginIntent,'utf8'))
  assert.equal(plugins.enabled['desktop-notify'],true);assert.equal(plugins.enabled.local,true);assert.equal(plugins.privateField,'local-keep')
  if(profileCheck) {
    const switches=JSON.parse(await readFile(profileSwitches,'utf8'))
    assert.equal(switches.entries.find(row=>row.patchId==='profile-restore-fixture').enabled,false)
    assert.equal(switches.entries.find(row=>row.patchId==='profile-restore-fixture').privateField,'local')
    assert.equal(switches.localField,'keep');assert.ok(switches.entries.some(row=>row.patchId==='local-missing'))
    assert.equal((await readFile(join(root,'desktop.log'),'utf8')).includes('PROFILE_RESTORE_FIXTURE_ACTIVE'),false)
    assert.equal(await readFile(profilePatch,'utf8'),profileSourcePatch)
    await assert.rejects(readFile(join(profileDir,'package.json.lock')),{code:'ENOENT'})
  }
  assert.equal((await readdir(join(root,'maintenance/recovery'))).filter(n=>n.endsWith('.json')).length,0)
  pass(profileCheck?'reviewed three-component UI restore applies protected Profile intent, requires matching UI ACK and preserves unrelated local fields':
    'reviewed UI restore commits preferences, restarts DSH, requires matching UI ACK and retains unrelated local settings')
  }
  if(dialogOnly) {
    await openDshMaintenance(page,'backup')
    assert.equal(await page.locator('[data-shortcut-modal="settings"]').count(),0)
    await page.screenshot({path:join(root,'restored.png')})
    pass('independent backup dialog reopens after the native configuration restart')
  } else {
  if(!report.checks.includes('configuration changes after preview are rejected before stopping the active backend')) {
  const recoveryBefore=(await readdir(join(root,'maintenance/recovery'))).filter(n=>n.endsWith('.json'))
  const preview=await inspect(),oldScheme=JSON.parse(await readFile(preferences,'utf8')).namespaces['desktop-appearance'].colorScheme
  const changedScheme=oldScheme==='blue'?'rose':'blue';await setCurrent(changedScheme)
  await assert.rejects(restore(preview),/backup-target-changed/)
  current=JSON.parse(await readFile(preferences,'utf8'));assert.equal(current.namespaces['desktop-appearance'].colorScheme,changedScheme)
  assert.deepEqual((await readdir(join(root,'maintenance/recovery'))).filter(n=>n.endsWith('.json')),recoveryBefore)
  pass('configuration changes after preview are rejected before stopping the active backend')
  }
  // An injected post-commit failure must roll back and restore the same UI package.
  if(!report.checks.includes('failure after durable configuration commit restores byte-exact before-images and restarts the original runtime')) {
  if(profileCheck) {
    const current=JSON.parse(await readFile(profileSwitches,'utf8'));current.entries.find(row=>row.patchId==='profile-restore-fixture').enabled=true
    await writeFile(profileSwitches,JSON.stringify(current))
  }
  const before=await readFile(preferences,'utf8'),failed=await inspect(),oldFailed=page.url()
  const profileBefore=profileCheck?await readFile(profileSwitches,'utf8'):null
  await writeFile(join(root,'rollback-baseline.json'),JSON.stringify({before,profileBefore}))
  const prior=(await records()).map(record=>record.operationId)
  await writeFile(control,JSON.stringify({failAfterCommit:true}))
  await restore(failed).catch(()=>{})
  const rolled=await newStage('rolled-back',prior);await running(oldFailed);await settled(rolled)
  assert.equal(await readFile(preferences,'utf8'),before)
  if(profileCheck)assert.equal(await readFile(profileSwitches,'utf8'),profileBefore)
  pass('failure after durable configuration commit restores byte-exact before-images and restarts the original runtime')
  }
  const {before,profileBefore}=JSON.parse(await readFile(join(root,'rollback-baseline.json'),'utf8'))
  // The debug host rejects one matching UI acknowledgement, then permits
  // the rollback document to finish the same package through real IPC.
  if(!report.checks.includes('required UI restore failure rolls configuration back once and completes only after the rollback document acknowledges')) {
  await writeFile(control,JSON.stringify({failUiRestore:true}))
  const uiFailure=await inspect(),oldUi=page.url(),prior=(await records()).map(record=>record.operationId)
  await restore(uiFailure)
  const uiRolled=await newStage('rolled-back',prior)
  await running(oldUi);await settled(uiRolled)
  assert.equal(await readFile(preferences,'utf8'),before);assert.equal(JSON.parse(await readFile(control,'utf8')).failUiRestore,false)
  if(profileCheck)assert.equal(await readFile(profileSwitches,'utf8'),profileBefore)
  pass('required UI restore failure rolls configuration back once and completes only after the rollback document acknowledges')
  }
  if(!report.checks.includes('forced exit before UI ACK triggers cold configuration rollback and retains the unsaved-content package')) {
  await writeFile(control,JSON.stringify({pauseAfterCommit:true}))
  const interrupted=await inspect(),prior=(await records()).map(record=>record.operationId);const pending=restore(interrupted).catch(()=>{})
  const restoring=await newStage('restoring',prior);assert.ok(restoring.items.some(i=>i.intent))
  await kill();await pending;await writeFile(control,'{}')
  await start()
  assert.equal(await readFile(preferences,'utf8'),before)
  if(profileCheck)assert.equal(await readFile(profileSwitches,'utf8'),profileBefore)
  const recovered=await records();assert.ok(recovered.filter(r=>r.stage==='rolled-back').length>=2)
  assert.ok((await readdir(join(root,'maintenance/recovery'))).some(n=>n.endsWith('.json')))
  pass('forced exit before UI ACK triggers cold configuration rollback and retains the unsaved-content package')
  }
  if(!report.checks.includes('cold rollback preserves conflicting external edits and quarantines their bytes without booting the backend')) {
  await writeFile(control,JSON.stringify({pauseAfterCommit:true}))
  const conflictPreview=await inspect(),prior=(await records()).map(record=>record.operationId);let conflictError
  const conflictPending=restore(conflictPreview).catch(error=>{conflictError=error.message})
  const deadline=Date.now()+45000
  while(!(await records()).some(r=>r.stage==='restoring'&&!prior.includes(r.operationId))) {
    if(conflictError)throw Error(conflictError)
    if(Date.now()>deadline)throw Error('Conflict fixture did not commit')
    await sleep(100)
  }
  const conflicting=await newStage('restoring',prior)
  const beforeScheme=JSON.parse(before).namespaces['desktop-appearance'].colorScheme
  const committedScheme=JSON.parse(await readFile(preferences,'utf8')).namespaces['desktop-appearance'].colorScheme
  const externalScheme=['blue','rose','teal'].find(value=>value!==beforeScheme && value!==committedScheme)
  assert.ok(externalScheme);const external=await setCurrent(externalScheme)
  const externalProfile=profileCheck?JSON.stringify({...JSON.parse(await readFile(profileSwitches,'utf8')),externalEdit:'keep-this-edit'}):null
  if(profileCheck)await writeFile(profileSwitches,externalProfile)
  await kill();await conflictPending;await writeFile(control,'{}');await start(false)
  await page.getByText(/配置检查点恢复未完成/).waitFor({timeout:45000})
  assert.equal(await readFile(preferences,'utf8'),external)
  if(profileCheck)assert.equal(await readFile(profileSwitches,'utf8'),externalProfile)
  assert.ok((await readdir(conflicting.directory)).some(n=>n.endsWith('.quarantine')))
  assert.ok((await readdir(join(root,'maintenance/recovery'))).some(n=>n.endsWith('.json')))
  pass('cold rollback preserves conflicting external edits and quarantines their bytes without booting the backend')
  }
  await page.screenshot({path:join(root,'restored.png')})
  }
} catch(error) {
  report.error=error.message
  await page?.screenshot({path:join(root,'failure.png')}).catch(()=>{})
  if(page)await writeFile(join(root,'failure.txt'),await page.locator('body').innerText().catch(()=>''))
  if(page)await writeFile(join(root,'failure-forms.json'),JSON.stringify(await page.evaluate(()=>({
    dialogs:[...document.querySelectorAll('[role=dialog],dialog[open],[aria-modal=true]')].map(element=>element.outerHTML),
    fields:[...document.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=true]')].map(element=>({
      html:element.outerHTML,ghost:Boolean(element.closest('[data-dsh-ghost]')),visible:element.checkVisibility?.({opacityProperty:true,visibilityProperty:true}),value:element.value}))
  })).catch(()=>null),null,2))
  if(page)await writeFile(join(root,'diagnostics.json'),JSON.stringify(await page.evaluate(()=>window.__TAURI__.core.invoke('desktop_diagnostics',{identity:window.__DSH_REMOTE_IDENTITY__})).catch(()=>null),null,2))
  if(page)await writeFile(join(root,'input-states.json'),JSON.stringify(await page.evaluate(()=>{
    const ctx=window.__DSH_SMOKE_CONTEXT__
    return ctx?.sessions.list.getSnapshot().ids.map(id=>{
      const input=ctx.conversation.input.for(ctx.sessions.scope(id)),root=input?.editor.getRootElement(),selection=document.getSelection()
      return {id,caret:input?.caretSpan(),editor:input?.editor.getEditorState().toJSON(),html:root?.outerHTML,
        focused:root?.contains(document.activeElement),domSelection:selection && {anchor:selection.anchorNode?.nodeName,anchorOffset:selection.anchorOffset,focus:selection.focusNode?.nodeName,focusOffset:selection.focusOffset}}
    })
  }).catch(()=>null),null,2))
  throw error
} finally {
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));await kill();console.log('Artifacts: '+root)
}
