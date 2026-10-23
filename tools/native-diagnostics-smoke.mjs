// Exercise real Tauri ACLs and diagnostics in disposable data roots, including
// a failed backend. No installation or model requests are performed.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { handleOnboarding, dismissInitialWelcome, offlineModelPatch } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = await mkdtemp(resolve('src-tauri/target/native-diagnostics-'))
const exe = resolve(process.env.DSH_DESKTOP_SMOKE_EXE || 'src-tauri/target/debug/deepseek-harness-desktop.exe')
const realBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const report = {root,checks:[]}
const pass = name=> {report.checks.push(name); console.log('PASS: '+name)}
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function freePort() {
  const server = createServer()
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const port = server.address().port
  await new Promise(resolve=>server.close(resolve))
  return port
}
async function scenario(name,bin,failed,enhancementsDisabled=false) {
  const dir = join(root,name),home=join(dir,'home')
  await mkdir(home,{recursive:true})
  await writeFile(join(home,'cordis.patch.yml'),offlineModelPatch)
  if(enhancementsDisabled)await writeFile(join(dir,'desktop-plugins.json'),JSON.stringify({version:1,enabled:{'desktop-ui':false,'desktop-sidebar-terminal':false,'desktop-sidebar-changes':false,'desktop-notify':false}}))
  const port = await freePort()
  const child = spawn(exe,[],{cwd:dir,windowsHide:true,stdio:'ignore',env:{...process.env,
    DSH_HOME:home,DSH_DESKTOP_SMOKE_DIR:dir,DSH_DESKTOP_DSH:bin,DSH_DESKTOP_NODE:process.execPath,
    DSH_UI_SMOKE_KEY:'mock-key',DSH_DESKTOP_WEBVIEW_RESTORE:'1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port,
  }})
  let browser, sequence = 0
  const command = async action => {
    await writeFile(join(dir,'command.json'),JSON.stringify({sequence:++sequence,action}))
  }
  const state = async expected => {
    for(let i=0;i<400;i++) {
      let value={}
      try {value=JSON.parse(await readFile(join(dir,'state.json'),'utf8'))}catch{}
      if(value.command===sequence && expected(value))return value
      await sleep(100)
    }
    throw Error('native window state did not settle')
  }
  const invokeDiagnostics = page => page.evaluate(()=>window.__TAURI__.core.invoke('desktop_diagnostics',{identity:window.__DSH_REMOTE_IDENTITY__}))
  try {
    for(let i=0;i<400;i++) {
      // The debug status file is rewritten by the native smoke bridge. Retry a
      // partially observed write instead of treating it as a product failure.
      let status={}
      try {status=JSON.parse(await readFile(join(dir,'state.json'),'utf8'))}catch{}
      if(status.backend === (failed ? 'failed' : 'running'))break
      if(child.exitCode!==null)throw Error('native app exited before readiness')
      await sleep(100)
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:'+port)
    let page
    for(let i=0;i<100;i++) {
      page = browser.contexts().flatMap(context=>context.pages()).find(page=>failed ? page.url().includes('tauri.localhost') : page.url().startsWith('http://127.0.0.1:'))
      if(page)break
      await sleep(100)
    }
    assert.ok(page,'main desktop page found')
    if(!failed) {
      await page.waitForFunction(()=>window.__DSH_REMOTE_IDENTITY__ && window.__DSH_CAPABILITIES__ && window.__DSH_UI_STATE__)
      await handleOnboarding(page)
      await dismissInitialWelcome(page)
    }
    await command('diagnostics')
    await page.getByRole('dialog').waitFor()
    await state(value=>value.visible && value.windowCount===1)
    assert.equal(browser.contexts().flatMap(context=>context.pages()).length,1)
    await page.getByRole('heading',{name:/故障诊断|诊断|Diagnostics/}).waitFor()
    await page.getByRole('dialog').getByText(/^(实际 dsh 版本|Actual dsh version)$/).waitFor()
    const checkButton = page.getByRole('dialog').getByRole('button',{name:/重新检测|Run checks|Check again/})
    await checkButton.click()
    let value
    for(let i=0;i<300;i++) {
      value = await invokeDiagnostics(page)
      if(value.checkedAt)break
      await sleep(100)
    }
    assert.equal(value.runtime.dshEntry.replace(/\\/g,'/'),bin.replace(/\\/g,'/'))
    assert.equal(value.runtime.dshSource,'configured')
    assert.ok(value.checks.some(check=>check.id==='node' && check.status==='available'))
    assert.ok(value.checkedAt)
    const notification=value.capabilities.find(row=>row.featureId==='window-notifications')
    assert.equal(notification.availability,'limited',JSON.stringify(notification))
    assert.ok(notification.evidence.includes('native-notification-service-selector'))
    assert.ok(notification.reasonCodes.includes('notification-display-preflight-required'))
    assert.ok((await readFile(join(dir,'dsh desktop.lnk'))).byteLength>0)
    pass(name+': real notification transport initializes without sending a test notification or modifying the normal shortcut')
    if(failed) assert.equal(value.phase.kind,'failed')
    else {
      assert.equal(value.runtime.dshVersion,'0.2.1-rc.2')
      assert.equal(value.inventory.roots.dataRoot.replace(/\\/g,'/'),home.replace(/\\/g,'/'))
      assert.ok(value.capabilities.some(row=>row.featureId==='plugin-management' && row.evidence.includes('plugin-control-status')))
      const main = page
      assert.ok(main,'running desktop page found')
      await main.waitForFunction(()=>window.__DSH_REMOTE_IDENTITY__)
      await main.waitForFunction(()=>window.__DSH_CAPABILITIES__ && window.__DSH_UI_STATE__)
      await main.evaluate(()=>window.__DSH_CAPABILITIES__.refresh())
      let selected
      for(let i=0;i<100;i++) {
        selected = await invokeDiagnostics(page)
        if(['file-editor','ui-recovery'].every(id=>selected.capabilities.some(row=>row.featureId===id && row.availability==='limited')))break
        await sleep(100)
      }
      for(const [id,evidence] of [['file-editor','file-editor-service-selector'],['ui-recovery','ui-snapshot-service-selector']]) {
        const row=selected.capabilities.find(row=>row.featureId===id)
        assert.equal(row.availability,'limited',JSON.stringify(row))
        assert.ok(row.evidence.includes(evidence))
        assert.ok(row.verification.some(record=>record.version==='0.2.1-rc.2' && record.architecture==='x86_64' && !record.nativeHostMocked))
      }
      assert.equal(selected.capabilities.find(row=>row.featureId==='ui-recovery').scope,'current-interface')
      const lan=selected.capabilities.find(row=>row.featureId==='lan-mobile')
      assert.equal(lan.availability,'available');assert.equal(lan.pluginState,'user-disabled')
      assert.ok(lan.evidence.includes('remote-status-selector'))
      assert.equal((await main.evaluate(()=>window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__}))).saved.enabled,false)
      value=selected
      const sessionFeature=selected.capabilities.find(row=>row.featureId==='session-links-export')
      assert.equal(sessionFeature.availability,'limited',JSON.stringify(sessionFeature))
      assert.equal(sessionFeature.scope,'current-interface')
      assert.ok(sessionFeature.evidence.includes('session-link-navigation-selector'))
      assert.ok(sessionFeature.evidence.includes('session-export-controller-selector'))
      assert.equal(sessionFeature.reasonCodes.some(code=>code.endsWith('contract-unavailable')),false)
      pass(name+': actual session navigation and native export controllers report per-operation preflight limits')
      if(enhancementsDisabled) {
        for(const id of ['appearance-settings','terminal-dock','session-changes-git','window-notifications'])assert.equal(selected.capabilities.find(row=>row.featureId===id).pluginState,'user-disabled',id)
        assert.equal(selected.capabilities.find(row=>row.featureId==='terminal-dock').availability,'unknown')
        assert.equal(selected.capabilities.find(row=>row.featureId==='session-changes-git').availability,'unknown')
        assert.equal(selected.capabilities.find(row=>row.featureId==='window-notifications').availability,'limited')
        pass('disabled enhancements keep their user intent while core diagnostics and recovery remain available')
      } else {
        await main.evaluate(async()=>{
          const ctx=window.__DSH_SMOKE_CONTEXT__
          ctx.layout.beginNavigation?.()
          if(typeof ctx.sessions.clear==='function')ctx.sessions.clear();else ctx.uiWorkspace.clearMain()
          await window.__DSH_CAPABILITIES__.refresh()
        })
        let changes
        for(let i=0;i<100;i++) {
          const current=await invokeDiagnostics(page)
          changes=current.capabilities.find(row=>row.featureId==='session-changes-git')
          if(changes.reasonCodes.includes('changes-no-current-session'))break
          await sleep(100)
        }
        assert.equal(changes.availability,'unknown',JSON.stringify(changes))
        assert.equal(changes.scope,'current-workspace')
        assert.ok(changes.reasonCodes.includes('changes-no-current-session'))
        // A directory under target/ still belongs to this repository. Put the
        // non-repository fixture outside the checkout so Git cannot find it.
        const repository=join(dir,'git-workspace'),plain=await mkdtemp(join(tmpdir(),'dsh-diagnostics-plain-'))
        await mkdir(repository)
        execFileSync('git',['init','--quiet',repository],{windowsHide:true,stdio:'ignore'})
        await main.waitForFunction(()=>window.__DSH_SMOKE_CONTEXT__?.sessions.list.getSnapshot().phase==='ready')
        const ids=await main.evaluate(async paths=>{
          const ctx=window.__DSH_SMOKE_CONTEXT__,ids=[]
          for (const path of paths) {
            const workspace=await ctx.workspaces.create({path})
            ids.push(await ctx.sessions.create({workspaceId:workspace.workspaceId}))
          }
          await ctx.uiWorkspace.openSession(ids[0]);return ids
        },[repository,plain])
        async function workspaceRow(code) {
          for(let i=0;i<100;i++) {
            const report=await invokeDiagnostics(page)
            const row=report.capabilities.find(row=>row.featureId==='session-changes-git')
            if(row.availability==='limited' && row.reasonCodes.includes(code))return row
            await sleep(100)
          }
          const state=await main.evaluate(()=>({selection:window.__DSH_SMOKE_CONTEXT__.sessions.list.getSnapshot(),identity:window.__DSH_REMOTE_IDENTITY__}))
          const diagnostics=await invokeDiagnostics(page)
          await writeFile(join(dir,'workspace-failure.json'),JSON.stringify({state,diagnostics},null,2))
          throw Error('workspace report not ready: '+code)
        }
        await main.evaluate(()=>window.__DSH_CAPABILITIES__.refresh())
        changes=await workspaceRow('changes-recording-coverage-limited')
        assert.ok(changes.evidence.includes('workspace-git-selector'))
        assert.equal(changes.reasonCodes.includes('changes-workspace-not-git'),false)
        await main.evaluate(id=>window.__DSH_SMOKE_CONTEXT__.uiWorkspace.openSession(id),ids[1])
        changes=await workspaceRow('changes-workspace-not-git')
        assert.equal(changes.scope,'current-workspace')
        assert.equal(JSON.stringify(changes).includes('plain-workspace'),false)
        pass('actual repository and non-repository workspaces recheck on session selection and exclude paths from capability evidence')
        value=await invokeDiagnostics(page)
      }
      pass('real file editor and recovery selectors report current contracts with explicit limits')
      const overrideDenied=await main.evaluate(async()=>{
        try {await window.__TAURI__.core.invoke('desktop_capabilities_report',{identity:window.__DSH_REMOTE_IDENTITY__,report:{featureId:'runtime-rollback',availability:'available',implementation:'desktop',pluginState:'enabled',reasonCodes:[],evidence:['forged-client']}});return false}catch{return true}
      })
      assert.equal(overrideDenied,true)
      const oldIdentity=await main.evaluate(()=>window.__DSH_REMOTE_IDENTITY__)
      await main.reload()
      await main.waitForFunction(old=>window.__DSH_REMOTE_IDENTITY__ && window.__DSH_REMOTE_IDENTITY__.documentGeneration!==old.documentGeneration,oldIdentity)
      const staleDenied=await main.evaluate(async identity=>{
        try {await window.__TAURI__.core.invoke('desktop_capabilities_report',{identity,report:{featureId:'file-editor',availability:'limited',implementation:'hybrid',pluginState:'enabled',reasonCodes:[],evidence:['stale-page']}});return false}catch{return true}
      },oldIdentity)
      assert.equal(staleDenied,true)
      pass('native capability reports reject protected host features and old page identities')
      const denied = await main.evaluate(async()=>{
        try {await window.__TAURI__.core.invoke('desktop_diagnostics',{identity:{...window.__DSH_REMOTE_IDENTITY__,backendInstance:99999}});return false}catch{return true}
      })
      assert.equal(denied,true)
      pass('actual desktop IPC rejects a stale backend identity')
    }
    if(!failed) {
      const denied = await page.evaluate(async()=>{
        try {await window.__TAURI__.core.invoke('retry_boot');return false}catch{return true}
      })
      assert.equal(denied,true,'backend diagnostics dialog retains the main document ACL')
    }
    await command('diagnostics')
    await page.getByRole('dialog').waitFor()
    assert.equal(await page.getByRole('dialog').count(),1)
    await writeFile(join(dir,'diagnostics.json'),JSON.stringify(value,null,2))
    await page.screenshot({path:join(dir,'diagnostics.png')})
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({state:'hidden'})
    await command('close')
    await state(value=>!value.visible && value.windowCount===1)
    await command('diagnostics')
    await page.getByRole('dialog').waitFor()
    await state(value=>value.visible && value.windowCount===1)
    pass(name+': tray diagnostics reuses one dialog and shows the hidden main window with working checks and ACL')
    if(!failed) {
      await page.keyboard.press('Escape')
      await page.waitForFunction(()=>window.__DSH_SMOKE_CONTEXT__?.sessions.list.getSnapshot().phase==='ready' && window.__DSH_SMOKE_CONTEXT__?.workspaces.list.getSnapshot().phase==='ready')
      await command('enter')
      await state(value=>value.phase==='minimal' && value.windowCount===0)
      await browser.close().catch(()=>{})
      await command('diagnostics')
      await state(value=>value.visible && value.windowCount===1 && value.loaded)
      page=undefined
      for(let i=0;i<200;i++) {
        try {
          if(!browser.isConnected())browser=await chromium.connectOverCDP('http://127.0.0.1:'+port)
          page=browser.contexts().flatMap(context=>context.pages()).find(page=>!page.isClosed() && page.url().startsWith('http://127.0.0.1:'))
          if(!page)await browser.close().catch(()=>{})
        } catch {}
        if(page)break
        await sleep(100)
      }
      assert.ok(page,'minimal mode restores the main document')
      await page.getByRole('dialog').waitFor()
      await state(value=>value.visible && value.windowCount===1 && value.phase==='active')
      assert.equal(await page.getByRole('dialog').count(),1)
      pass(name+': tray diagnostics restores the disposed main WebView and opens its dialog')
    }
  } finally {
    await command('quit')
    for(let i=0;i<50 && child.exitCode===null;i++)await sleep(100)
    if(child.exitCode===null)try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}
    await browser?.close().catch(()=>{})
  }
}
try {
  const fake = join(root,'failed-runtime.cjs')
  await writeFile(fake,"if(process.argv.includes('--version'))process.stdout.write('9.8.7');else process.exit(42)")
  await scenario('backend-failed',fake,true)
  await scenario('backend-running',realBin,false)
  await scenario('enhancements-disabled',realBin,false,true)
}finally {
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  console.log('Artifacts: '+root)
}
