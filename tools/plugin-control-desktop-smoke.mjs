// Real restart button, native ACL, draft/attachment preservation. Isolated app.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, writeFile, readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createServer } from 'node:net'
import { connect } from './terminal-cdp.mjs'

const root = await mkdtemp(resolve('src-tauri/target/plugin-dialog-desktop-'))
const home = join(root, 'dsh-home')
await mkdir(home)
await writeFile(join(root, 'desktop-plugins.json'), JSON.stringify({ version: 1, enabled: {
  'desktop-ui': !process.argv.includes('--without-overlay'), 'desktop-appearance': false,
  'desktop-title-bar': false, 'desktop-ui-state': false, 'desktop-remote-control': false,
} }))
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: off\n  ui: desktop\ndesktop-terminal-dock:\n  profileId: cmd\n  position: bottom\n  layout: { height: 260, collapsed: true }\n')
const exe = join(root, 'deepseek-harness-desktop.exe')
await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'), exe)
for (const [source, destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources)) {
  const target = join(root, destination)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(resolve('src-tauri', source), target)
}
const reserve = createServer()
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
  ...process.env, DSH_HOME: home, DSH_DESKTOP_SMOKE_DIR: root,
  DSH_DESKTOP_DEBUG: join(root, 'host.log'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
} })
let c
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { root, checks: [] }
async function until(expression, timeout = 45000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    if (child.exitCode !== null) throw Error('Isolated app exited: ' + child.exitCode)
    try { c ||= await connect(port); const value = await c.evaluate(expression); if (value) return value }
    catch (e) { last = e; c?.close(); c = null }
    await sleep(150)
  }
  throw Error('Timed out: ' + expression.slice(0, 160) + ' ' + (last?.message || ''))
}
const context = 'window.__DSH_PLUGIN_SMOKE_CONTEXT__'
const invoke = (command, args = {}) => c.evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(command)},{identity:window.__DSH_REMOTE_IDENTITY__,...${JSON.stringify(args)}})`)
const pluginStatus = () => c.evaluate(`(async()=>{const r=await ${context}.remote.desktopPlugins.status();if(!r.ok)throw Error(r.error.message);return r.value})()`)
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
async function ready() {
  await until(`Boolean(${context} && window.__DSH_REMOTE_IDENTITY__ && ${context}.sessions.list.getSnapshot().phase==='ready')`)
  await until("!document.querySelector('[data-dsh-ui-status]')")
  for (let i = 0; i < 8; i++) {
    await c.evaluate("(()=>{for(const b of document.querySelectorAll('button'))if(['继续','稍后配置'].includes(b.textContent.trim()))b.click()})()")
    await sleep(120)
  }
}
async function click(selector) {
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  const { x, y } = await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e.disabled)throw Error('Button disabled');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
async function settings() {
  await c.evaluate("(()=>{if(!document.querySelector('[data-shortcut-modal=settings]'))document.querySelector('button[aria-haspopup=dialog]').click()})()")
  await until("Boolean(document.querySelector('[data-shortcut-modal=settings]'))")
  await c.evaluate("(()=>{const p=document.querySelector('[data-shortcut-modal=settings]');[...p.querySelectorAll('button')].find(b=>b.textContent.trim()==='插件')?.click()})()")
  await until("Boolean(document.querySelector('[role=tab]'))")
  await c.evaluate("[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent==='插件').click()")
  await until("document.querySelectorAll('.dshPlugins__card').length===4")
}
async function setPlugin(id, enabled) {
  const selector = `[data-plugin-id="${id}"] [role=switch]`
  await click(selector)
  await until(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-checked')===${JSON.stringify(String(enabled))}&&!document.querySelector(${JSON.stringify(selector)}).disabled`)
}
async function screenshot(name) {
  const result = await c.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, name + '.png'), Buffer.from(result.data, 'base64'))
}
async function checkTitleBar() {
  const result = await c.evaluate(`(()=>{
    const bar=document.querySelector('.dshTb'),r=bar?.getBoundingClientRect(),style=bar&&getComputedStyle(bar);
    const controls=[...document.querySelectorAll('.dshTb__control')];
    return {position:style?.position,display:style?.display,top:r?.top,height:r?.height,width:r?.width,viewport:innerWidth,
      contentTop:document.getElementById('root').getBoundingClientRect().top,
      controls:controls.length,clickable:controls.every(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))}),
      menus:[...document.querySelectorAll('.dshTb__nav button')].map(b=>b.textContent.trim())}
  })()`)
  assert.equal(result.position, 'fixed', 'title bar must not depend on optional appearance styles')
  assert.equal(result.display, 'flex')
  assert.equal(result.top, 0)
  assert.equal(result.height, 44)
  assert.equal(result.width, result.viewport)
  assert.ok(result.contentTop >= result.height)
  assert.equal(result.controls, 3)
  assert.equal(result.clickable, true, 'window controls stay above the settings mask')
  assert.deepEqual(result.menus, ['编辑', '会话', '项目', '更多'])
}
try {
  await ready()
  await checkTitleBar()
  for (const id of ['@dsh-desktop/ui-state', '@dsh-desktop/remote-control']) {
    await until(`(()=>{const e=[...${context}.loader.entries()].find(e=>e.options.name===${JSON.stringify(id)});return e?.fiber?.state===2})()`)
  }
  pass('legacy disabled core switches cannot remove title bar, state recovery or remote settings')
  const sessionId = await c.evaluate(`(async()=>{const ctx=${context};const w=await ctx.workspaces.create({path:${JSON.stringify(root)}});const id=await ctx.sessions.create({workspaceId:w.workspaceId});await ctx.uiWorkspace.openSession(id);return id})()`)
  await until(`Boolean(${context}.conversation.input.for(${context}.sessions.scope(${JSON.stringify(sessionId)})))`)
  await c.evaluate(`(()=>{const ctx=${context},input=ctx.conversation.input.for(ctx.sessions.scope(${JSON.stringify(sessionId)}));input.setDraft('插件重启后保留的草稿');const files=ctx.conversation.createDrafts(${JSON.stringify(sessionId)},[new File(['keep attachment bytes'],'plugin-restart.txt',{type:'text/plain'})]);input.addAttachments(files.map(f=>f.id))})()`)
  await until(`(()=>{const ctx=${context};const ids=ctx.conversation.input.for(ctx.sessions.scope(${JSON.stringify(sessionId)})).state.getSnapshot().attachmentIds;return ids.length===1&&ids.every(id=>ctx.conversation.fileUploads.getSnapshot()[id]?.status==='ready')})()`)
  // An orphaned legacy PTY without a UI provider must refuse snapshot capture,
  // display the error, and keep the original process running until addressed.
  const terminal = await c.evaluate(`window.__TAURI__.core.invoke('terminal_open',{identity:window.__DSH_TERMINAL_IDENTITY__,resourceKey:'dsh-resource://desktop-terminal/plugin-restart-smoke',profileId:'cmd',cwd:${JSON.stringify(root)}})`)
  assert.ok(terminal)
  for (const firstRestart of [true, false]) {
    await settings()
    await checkTitleBar()
    await setPlugin('desktop-sidebar-changes', !firstRestart)
    const profilePlugin = (await pluginStatus()).plugins.find(row => row.patchId === 'ui-settings-models')
    assert.ok(profilePlugin && !profilePlugin.readOnlyReason && !profilePlugin.hot)
    await c.evaluate(`(async()=>{const r=await ${context}.remote.desktopPlugins.setPluginEnabled(${JSON.stringify(profilePlugin.entryId)},${!firstRestart});if(!r.ok)throw Error(r.error.message)})()`)
    assert.equal((await pluginStatus()).restartRequired, true)
    await c.evaluate("document.querySelector('.dshPlugins__restart').scrollIntoView({block:'center'})")
    await screenshot(firstRestart ? 'restart-card' : 'restart-again')
    const before = await invoke('remote_status')
    const oldIdentity = await c.evaluate('window.__DSH_REMOTE_IDENTITY__')
    if (firstRestart) {
      await click('.dshPlugins__restartButton')
      await until("document.querySelector('.dshPlugins__restart [role=alert]')?.textContent.includes('无法保留桌面终端')")
      assert.equal((await invoke('remote_status')).instance, before.instance)
      const kept = await c.evaluate("window.__TAURI__.core.invoke('terminal_list',{identity:window.__DSH_TERMINAL_IDENTITY__})")
      assert.ok(kept.some(t => t.terminalId === terminal.terminalId && t.state === 'running'))
      await c.evaluate(`window.__TAURI__.core.invoke('terminal_close',{identity:window.__DSH_TERMINAL_IDENTITY__,terminalId:${JSON.stringify(terminal.terminalId)},runId:${terminal.runId}})`)
      pass('failed capture shows an inline error and leaves the original backend and terminal running')
    }
    await click('.dshPlugins__restartButton')
    await until(`window.__DSH_REMOTE_IDENTITY__?.backendInstance>${before.instance}`)
    await ready()
    await checkTitleBar()
    const after = await invoke('remote_status')
    assert.deepEqual(after.saved, before.saved)
    assert.deepEqual(after.active, before.active)
    const state = await pluginStatus()
    assert.equal(state.restartRequired, false)
    assert.equal(state.rows.find(row => row.id === 'desktop-sidebar-changes').running, !firstRestart)
    assert.equal(state.plugins.find(row => row.patchId === 'ui-settings-models').running, !firstRestart)
    const draft = await c.evaluate(`${context}.conversation.input.for(${context}.sessions.scope(${JSON.stringify(sessionId)})).state.getSnapshot().draft`)
    assert.equal(draft, '插件重启后保留的草稿')
    const attachments = await c.evaluate(`(async()=>{const ctx=${context},ids=ctx.conversation.input.for(ctx.sessions.scope(${JSON.stringify(sessionId)})).state.getSnapshot().attachmentIds;return Promise.all(ctx.conversation.resolveDraftAttachments(ids).map(async a=>({name:a.file.name,text:await a.file.text()})))})()`)
    assert.deepEqual(attachments, [{ name: 'plugin-restart.txt', text: 'keep attachment bytes' }])
    assert.equal(await c.evaluate(`(async()=>{const bridge=window.__DSH_UI_STATE__;const payload=await bridge.prepareRemoteApply(${JSON.stringify(after.frontendVersion)});try{return await window.__TAURI__.core.invoke('plugins_restart',{identity:${JSON.stringify(oldIdentity)},payload}).then(()=>false,()=>true)}finally{bridge.finishRemoteApply()}})()`), true)
    assert.equal((await invoke('remote_status')).instance, after.instance)
    pass('native restart preserves listener, draft and attachment with core state recovery')
  }
  const saved = JSON.parse(await readFile(join(root, 'desktop-plugins.json'), 'utf8'))
  for (const id of ['desktop-ui-state', 'desktop-title-bar', 'desktop-remote-control', 'desktop-appearance']) assert.equal(saved.enabled[id], undefined)
  assert.equal(saved.enabled['desktop-sidebar-changes'], true)
  await settings(); await screenshot('after-restart')
  assert.equal(await c.evaluate("Boolean(document.querySelector('.dshPlugins__restart'))"), false)
  pass('persisted switches match the restarted backend; card disappears')
  pass('title bar, menu and window controls survive settings and backend restarts')
} catch (error) {
  report.error = error.stack
  if (c) { try { await screenshot('failure'); report.page = await c.evaluate('document.body.innerText.slice(0,6000)') } catch {} }
  throw error
} finally {
  if (c) {
    try { await c.evaluate("(async()=>{const identity=window.__DSH_TERMINAL_IDENTITY__;for(const t of await window.__TAURI__.core.invoke('terminal_list',{identity}))await window.__TAURI__.core.invoke('terminal_close',{identity,terminalId:t.terminalId,runId:t.runId})})()") } catch {}
    c.close()
  }
  if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Evidence: ' + root)
}
