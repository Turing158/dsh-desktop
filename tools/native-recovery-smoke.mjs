// Real desktop IPC, restart interruption and cold restoration in an isolated
// data root. No model requests, global installs or user profile writes.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'
import { handleOnboarding, dismissInitialWelcome, openDshMaintenance, offlineModelPatch } from './dsh-ui-helpers.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = await mkdtemp(resolve('src-tauri/target/native-recovery-'))
const home = join(root, 'home'), workspace = join(root, 'workspace'), packages = join(root, 'maintenance/recovery')
await mkdir(join(home, 'profiles'), { recursive: true }); await mkdir(workspace)
await writeFile(join(home, 'cordis.patch.yml'), offlineModelPatch)
const exe = resolve('src-tauri/target/debug/deepseek-harness-desktop.exe')
const bin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
let child, browser, page, command = 0
const report = { root, checks: [] }
const pass = label => { report.checks.push(label); console.log('PASS: ' + label) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function start() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port; await new Promise(resolve => server.close(resolve))
  child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env,
    DSH_HOME: home, DSH_UI_SMOKE_KEY: 'mock-key', DSH_DESKTOP_SMOKE_DIR: root, DSH_DESKTOP_DSH: bin, DSH_DESKTOP_NODE: process.execPath,
    DSH_DESKTOP_WEBVIEW_RESTORE: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } })
  for (let i = 0; i < 400; i++) {
    if (child.exitCode !== null) throw Error('Desktop exited before readiness')
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); break } catch {}
    await sleep(100)
  }
  assert.ok(browser)
  for (let i = 0; i < 400; i++) {
    page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1:') && !page.url().includes(':1430'))
    if (page) break
    await sleep(100)
  }
  assert.ok(page); page.setDefaultTimeout(25000)
  await handleOnboarding(page)
  await page.waitForFunction(() => window.__DSH_SMOKE_CONTEXT__?.sessions.list.getSnapshot().phase === 'ready' && window.__DSH_REMOTE_IDENTITY__)
  return page
}
async function kill() {
  if (child?.exitCode === null) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }
    catch (error) { try { process.kill(child.pid, 0); throw error } catch (missing) { if (missing.code !== 'ESRCH') throw missing } }
  }
  await browser?.close().catch(() => {}); browser = null; await sleep(300)
}
async function entries() { return (await readdir(packages).catch(() => [])).filter(name => name.endsWith('.json')) }
async function journals() {
  const directory = join(root, 'maintenance/operations')
  return Promise.all((await readdir(directory).catch(() => [])).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))))
}
try {
  await start(); await dismissInitialWelcome(page)
  const sessionId = await page.evaluate(async path => {
    const ctx = window.__DSH_SMOKE_CONTEXT__, workspace = await ctx.workspaces.create({ path })
    const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId }); ctx.uiWorkspace.openSession(id); return id
  }, workspace)
  await page.waitForFunction(id => window.__DSH_SMOKE_CONTEXT__.conversation.input.for(window.__DSH_SMOKE_CONTEXT__.sessions.scope(id))?.editor.getRootElement(), sessionId)
  await page.locator('[contenteditable=true]').first().fill('跨进程恢复草稿')
  await page.evaluate(id => {
    const ctx = window.__DSH_SMOKE_CONTEXT__, input = ctx.conversation.input.for(ctx.sessions.scope(id))
    input.addAttachments(ctx.conversation.createDrafts(id, [new File(['durable attachment'], 'keep.txt', { type: 'text/plain' })]).map(asset => asset.id))
  }, sessionId)
  await page.waitForFunction(id => {
    const ctx = window.__DSH_SMOKE_CONTEXT__, input = ctx.conversation.input.for(ctx.sessions.scope(id))
    return input.state.getSnapshot().attachmentIds.every(id => ctx.conversation.fileUploads.getSnapshot()[id]?.status === 'ready')
  }, sessionId)
  await sleep(300)
  const inputStates = await page.evaluate(() => {
    const ctx = window.__DSH_SMOKE_CONTEXT__
    return ctx.sessions.list.getSnapshot().ids.map(id => {
      const scope = ctx.sessions.scope(id), input = scope && ctx.conversation.input.for(scope)
      return { id, state: input?.state.getSnapshot(), composing: input?.editor.isComposing(), pending: ctx.sessions.binding(id)?.session.getSnapshot().pendingSubmissions.length }
    })
  })
  await writeFile(join(root, 'input-states.json'), JSON.stringify(inputStates, null, 2))
  let restartError
  const restarting = page.evaluate(async () => {
    let payload
    try {
      const end = Date.now() + 45000
      while (!payload) {
        try { payload = await window.__DSH_UI_STATE__.prepareRemoteApply('0.2.1-rc.2') }
        catch (error) { if (!error.message.includes('输入或提交') || Date.now() >= end) throw error; await new Promise(resolve => setTimeout(resolve, 500)) }
      }
    }
    catch (error) {
      const ctx = window.__DSH_SMOKE_CONTEXT__
      window.__RECOVERY_PROBE__ = { error: error.message, cause: error.cause?.stack, inputs: ctx.sessions.list.getSnapshot().ids.map(id => {
        const scope = ctx.sessions.scope(id), input = scope && ctx.conversation.input.for(scope)
        return { id, state: input?.state.getSnapshot(), composing: input?.editor.isComposing(), pending: ctx.sessions.binding(id)?.session.getSnapshot().pendingSubmissions.length }
      }) }
      throw error
    }
    return window.__TAURI__.core.invoke('plugins_restart', { identity: window.__DSH_REMOTE_IDENTITY__, payload })
  }).catch(error => { restartError = error.message })
  let saved
  for (let i = 0; i < 2800; i++) {
    for (const name of await entries()) {
      const material=await readFile(join(packages,name),'utf8').then(JSON.parse).catch(()=>null)
      if(material && !material.draftsOnly) {saved=name;break}
    }
    if (saved || restartError) break; await sleep(20)
  }
  if (!saved) await writeFile(join(root, 'capture-failure.json'), JSON.stringify(await page.evaluate(() => window.__RECOVERY_PROBE__), null, 2))
  assert.ok(saved, 'Restart saved a durable package before replacing the backend: ' + restartError)
  const packageText = await readFile(join(packages, saved), 'utf8')
  assert.ok(packageText.includes('跨进程恢复草稿')); assert.ok(packageText.includes('sessionUpdatedAt'))
  let restartJournal
  for (let i = 0; i < 200; i++) {
    restartJournal = (await journals()).find(record => record.checkpointId === saved.replace('.json', ''))
    // checkpoint() persists the reference while the journal is still capturing.
    // Wait for the intended interruption boundary, not merely that reference.
    if (restartJournal && ['checkpointing','starting-candidate','restoring'].includes(restartJournal.stage)) break
    await sleep(10)
  }
  assert.equal(restartJournal?.kind, 'restart')
  assert.ok(['checkpointing', 'starting-candidate', 'restoring'].includes(restartJournal.stage), JSON.stringify(restartJournal))
  assert.equal(JSON.stringify(restartJournal).includes('跨进程恢复草稿'), false)
  await kill(); await restarting
  assert.ok((await entries()).includes(saved)); pass('forced exit during restart retains the durable draft and attachment package')
  await start()
  const interrupted = (await journals()).find(record => record.operationId === restartJournal.operationId)
  assert.equal(interrupted.errorCode, 'maintenance-interrupted')
  assert.equal(['complete', 'resolved', 'rolled-back'].includes(interrupted.stage), false)
  const diagnostics = await page.evaluate(() => window.__TAURI__.core.invoke('desktop_diagnostics', { identity: window.__DSH_REMOTE_IDENTITY__ }))
  assert.ok(diagnostics.incompleteOperations.some(record => record.operationId === interrupted.operationId))
  pass('cold boot preserves the interrupted stage and exposes the durable journal in diagnostics')
  const result = await page.evaluate(() => window.__TAURI__.core.invoke('desktop_recovery_list', { identity: window.__DSH_REMOTE_IDENTITY__ }))
  assert.equal(result.entries.find(entry=>entry.recoveryId===saved.replace('.json','')).canRestore, true)
  assert.equal(JSON.stringify(result).includes('跨进程恢复草稿'), false)
  pass('cold restart lists verified metadata without exposing draft bodies')
  await page.keyboard.press('Escape')
  await page.evaluate(id => window.__DSH_SMOKE_CONTEXT__.uiWorkspace.openSession(id), sessionId)
  await page.waitForFunction(id => window.__DSH_SMOKE_CONTEXT__.conversation.input.for(window.__DSH_SMOKE_CONTEXT__.sessions.scope(id))?.editor.getRootElement(), sessionId)
  await page.locator('[contenteditable=true]').first().fill('新的草稿不能覆盖')
  await page.evaluate(id => window.__TAURI__.core.invoke('desktop_recovery_restore', { identity: window.__DSH_REMOTE_IDENTITY__, recoveryId: id }), saved.replace('.json', ''))
  await page.getByText('当前草稿与恢复包不同，恢复已暂停，两个版本均保留。', { exact: true }).waitFor()
  assert.ok((await entries()).includes(saved))
  const retry = await page.evaluate(async id => {
    try { await window.__TAURI__.core.invoke('desktop_recovery_restore', { identity: window.__DSH_REMOTE_IDENTITY__, recoveryId: id }); return 'unexpected-success' }
    catch (error) { return String(error) }
  }, saved.replace('.json', ''))
  assert.match(retry, /maintenance-busy/)
  await page.getByRole('button', { name: '保留稍后处理', exact: true }).click()
  assert.equal(await page.locator('[contenteditable=true]').first().innerText(), '新的草稿不能覆盖')
  pass('cold recovery refuses a newer draft and Keep for later preserves both versions')
  // Restore the original semantic draft so content checks can complete. Attachments
  // remain absent on this new page and must be recreated from durable bytes.
  await page.locator('[contenteditable=true]').first().fill('跨进程恢复草稿')
  await page.keyboard.press('Escape'); await openDshMaintenance(page,'backup')
  await page.locator('[data-dsh-recovery-id="'+saved.replace('.json','')+'"]').getByRole('button', { name: '恢复未保存内容', exact: true }).click()
  for (let i = 0; i < 300 && (await entries()).includes(saved); i++) await sleep(100)
  assert.equal((await entries()).includes(saved), false, 'Necessary restore acknowledgement removes only the completed package')
  const restored = await page.evaluate(id => {
    const ctx = window.__DSH_SMOKE_CONTEXT__, input = ctx.conversation.input.for(ctx.sessions.scope(id))
    return { text: input.state.getSnapshot().draft, files: ctx.conversation.resolveDraftAttachments(input.state.getSnapshot().attachmentIds).map(a => a.file.name), pending: ctx.sessions.binding(id).session.getSnapshot().pendingSubmissions.length }
  }, sessionId)
  assert.equal(restored.text, '跨进程恢复草稿'); assert.deepEqual(restored.files, ['keep.txt']); assert.equal(restored.pending, 0)
  const records = (await journals()).filter(record => record.checkpointId === saved.replace('.json', ''))
  assert.equal(records.filter(record => record.stage === 'complete').length, 1)
  assert.ok(records.every(record => ['complete', 'resolved'].includes(record.stage)))
  assert.equal(records.find(record => record.operationId === restartJournal.operationId).stage, 'resolved')
  const finishedDiagnostics = await page.evaluate(() => window.__TAURI__.core.invoke('desktop_diagnostics', { identity: window.__DSH_REMOTE_IDENTITY__ }))
  assert.ok(!finishedDiagnostics.operation || (finishedDiagnostics.operation.kind === 'update' && finishedDiagnostics.operation.checkpointId === null))
  assert.equal(finishedDiagnostics.incompleteOperations.length, 0)
  const cleared = await page.evaluate(async id => {
    try { await window.__TAURI__.core.invoke('desktop_recovery_restore', { identity: window.__DSH_REMOTE_IDENTITY__, recoveryId: id }); return 'unexpected-success' }
    catch (error) { return String(error) }
  }, saved.replace('.json', ''))
  assert.match(cleared, /recovery-read-failed|maintenance-busy/)
  pass('settings restoration rebinds current identity, restores attachment bytes and clears the package only after acknowledgement')
  pass('maintenance ownership blocks competing restores and resolves only acknowledged checkpoint references')
  await page.keyboard.press('Escape')
  await page.locator('[data-shortcut-modal="settings"]').waitFor({state:'hidden'})
  await page.locator('[data-dsh-terminal-dock-toggle]').click()
  await page.waitForFunction(()=>{
    const dock=window.__DSH_UPSTREAM_DOCK_SMOKE__,tab=dock?.dock.getSnapshot().tabs[0]
    return tab && dock.registry.view(tab)?.model.state.getSnapshot().writable
  })
  let terminalRestartError
  const terminalRestart=page.evaluate(async()=>{
    const payload=await window.__DSH_UI_STATE__.prepareRemoteApply('0.2.1-rc.2')
    return window.__TAURI__.core.invoke('plugins_restart',{identity:window.__DSH_REMOTE_IDENTITY__,payload})
  }).catch(error=>{terminalRestartError=error.message})
  let terminalPackage,terminalBytes
  for(let i=0;i<600 && !terminalPackage;i++) {
    for(const name of await entries()) {
      const bytes=await readFile(join(packages,name),'utf8'),material=JSON.parse(bytes)
      if(material.payload.dialogs.some(dialog=>dialog.id==='desktop-terminal')) {terminalPackage=material;terminalBytes=bytes;break}
    }
    if(terminalRestartError)throw Error(terminalRestartError)
    if(!terminalPackage)await sleep(50)
  }
  assert.ok(terminalPackage,'real restart persisted terminal metadata before replacing the backend')
  await kill();await terminalRestart;await start()
  await page.evaluate(()=>{
    window.__DSH_SMOKE_CONTEXT__.inject(['webTerminals'],ctx=>{
      const original=ctx.webTerminals.view;window.coldTerminalStarts=0
      ctx.webTerminals.view=function(...args){window.coldTerminalStarts++;return original.apply(this,args)}
    })
  })
  await page.evaluate(id=>window.__DSH_SMOKE_CONTEXT__.uiWorkspace.openSession(id),sessionId)
  await page.waitForFunction(id=>window.__DSH_SMOKE_CONTEXT__.conversation.input.for(window.__DSH_SMOKE_CONTEXT__.sessions.scope(id))?.editor.getRootElement(),sessionId)
  const terminalListing=await page.evaluate(()=>window.__TAURI__.core.invoke('desktop_recovery_list',{identity:window.__DSH_REMOTE_IDENTITY__}))
  assert.equal(terminalListing.entries.find(entry=>entry.recoveryId===terminalPackage.recoveryId)?.hasTerminalState,true)
  const deniedTerminal=await page.evaluate(async id=>{
    try {await window.__TAURI__.core.invoke('desktop_recovery_restore',{identity:window.__DSH_REMOTE_IDENTITY__,recoveryId:id});return 'accepted'}catch(error){return String(error)}
  },terminalPackage.recoveryId)
  assert.match(deniedTerminal,/snapshot-terminal-cold-unavailable/)
  assert.deepEqual(await page.evaluate(()=>window.__TAURI__.core.invoke('terminal_list',{identity:window.__DSH_TERMINAL_IDENTITY__})),[])
  assert.equal(await page.evaluate(()=>window.coldTerminalStarts),0)
  pass('cold terminal metadata is listed and normal recovery refuses before starting a shell')
  // Exercise the reviewable UI action; the native payload excludes only this
  // provider while retaining attachment/draft conflict preflight.
  await page.keyboard.press('Escape');await openDshMaintenance(page,'backup')
  await page.locator('[data-dsh-recovery-id="'+terminalPackage.recoveryId+'"]').getByRole('button',{name:'跳过终端状态，恢复其余内容',exact:true}).click()
  await page.getByRole('button',{name:'保留稍后处理',exact:true}).waitFor()
  assert.equal(await readFile(join(packages,terminalPackage.recoveryId+'.json'),'utf8'),terminalBytes)
  assert.equal(await page.evaluate(()=>window.coldTerminalStarts),0)
  pass('skipping terminal state still refuses a conflicting cleared draft and retains the complete original package')
  await page.getByRole('button',{name:'保留稍后处理',exact:true}).click()
  await page.keyboard.press('Escape')
  await page.locator('[data-shortcut-modal="settings"]').waitFor({state:'hidden'})
  await page.locator('[contenteditable=true]').first().fill('跨进程恢复草稿')
  await openDshMaintenance(page,'backup')
  await page.locator('[data-dsh-recovery-id="'+terminalPackage.recoveryId+'"]').getByRole('button',{name:'跳过终端状态，恢复其余内容',exact:true}).click()
  for(let i=0;i<300;i++) {
    if((await journals()).some(record=>record.checkpointId===terminalPackage.recoveryId && record.stage==='complete' && record.completedSteps.includes('terminal-state-retained')))break
    await sleep(100)
  }
  await page.waitForFunction(()=>!document.querySelector('[data-dsh-ui-status]'))
  const partial=await page.evaluate(id=>{
    const ctx=window.__DSH_SMOKE_CONTEXT__,input=ctx.conversation.input.for(ctx.sessions.scope(id))
    return {text:input.state.getSnapshot().draft,files:ctx.conversation.resolveDraftAttachments(input.state.getSnapshot().attachmentIds).map(a=>a.file.name),frozen:Boolean(document.querySelector('[data-dsh-ui-status]'))}
  },sessionId)
  assert.equal(partial.text,'跨进程恢复草稿');assert.deepEqual(partial.files,['keep.txt']);assert.equal(partial.frozen,false)
  assert.deepEqual(await page.evaluate(()=>window.__TAURI__.core.invoke('terminal_list',{identity:window.__DSH_TERMINAL_IDENTITY__})),[])
  assert.equal(await page.evaluate(()=>window.coldTerminalStarts),0)
  assert.equal(await readFile(join(packages,terminalPackage.recoveryId+'.json'),'utf8'),terminalBytes)
  assert.ok((await journals()).some(record=>record.checkpointId===terminalPackage.recoveryId && record.stage==='complete' && record.completedSteps.includes('terminal-state-retained')))
  pass('explicitly skipping cold terminal state restores drafts and attachments without opening shells or deleting the original package')
  await page.screenshot({ path: join(root, 'restored.png') })
} catch (error) {
  report.error = error.message
  if (page) { await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {}); await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText().catch(() => '')) }
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  if (child?.exitCode === null) { await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: ++command, action: 'quit' })); await sleep(700) }
  await kill(); console.log('Artifacts: ' + root)
}
