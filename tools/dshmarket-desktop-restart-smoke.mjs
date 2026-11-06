// Real marketplace self-update/restart in an isolated Windows desktop profile.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, writeFile, readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createServer } from 'node:net'
import { connect } from './terminal-cdp.mjs'
import { offlineModelPatch } from './dsh-ui-helpers.mjs'

const root = process.env.DSH_MARKET_RESTART_RESUME ? resolve(process.env.DSH_MARKET_RESTART_RESUME) : await mkdtemp(resolve('src-tauri/target/dshmarket-'))
const home = join(root, 'home'), exe = join(root, 'deepseek-harness-desktop.exe')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
await mkdir(home, { recursive: true })
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
console.log('Preparing older marketplace release in ' + home)
execFileSync(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', 'dshmarket@1.73.11'], {
  cwd: root, env: { ...process.env, DSH_HOME: home }, windowsHide: true, timeout: 180000,
})
const profilePath = join(home, 'profiles/web/package.json')
const profile = JSON.parse(await readFile(profilePath, 'utf8'))
if (!profile.dsh.profile.bundles.includes('dshmarket')) profile.dsh.profile.bundles.push('dshmarket')
await writeFile(profilePath, JSON.stringify(profile, null, 2))
await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'), exe)
for (const [source, destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources)) {
  const target = join(root, destination)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(resolve('src-tauri', source), target)
}
const patch = join(root, 'dsh-plugin/desktop-notify.patch.yml')
await writeFile(patch, (await readFile(patch, 'utf8')) + offlineModelPatch)
const reserve = createServer()
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const desktopEnv = {
  ...process.env, DSH_HOME: home, DSH_DESKTOP_SMOKE_DIR: root,
  DSH_DESKTOP_DSH_BIN: dshBin,
  DSH_DESKTOP_DEBUG: join(root, 'host.log'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
}
const child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: 'ignore', env: desktopEnv })
let c, nativeWindowHandle
const report = { schema: 1, checks: [] }
const context = 'window.__DSH_PLUGIN_SMOKE_CONTEXT__'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
async function until(expression, timeout = 90000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error('Isolated desktop exited: ' + child.exitCode)
    try { c ||= await connect(port); const result = await c.evaluate(expression); if (result) return result }
    catch (error) { last = error; c?.close(); c = null }
    await sleep(150)
  }
  throw Error('Timed out: ' + expression.slice(0, 160) + ' ' + (last?.message || ''))
}
async function ready() {
  await until(`Boolean(${context} && window.__DSH_REMOTE_IDENTITY__ && typeof window.__dshHostShell?.restart==='function' && ${context}.sessions.list.getSnapshot().phase==='ready')`)
  await until("!document.querySelector('[data-dsh-ui-status]')")
  for (let i = 0; i < 8; i++) {
    await c.evaluate("(()=>{for(const b of document.querySelectorAll('button'))if(['继续','我知道了','稍后配置'].includes(b.textContent.trim()))b.click()})()")
    await sleep(120)
  }
  // A restored session can reopen the upstream account onboarding. Dismiss
  // that independent dialog before testing a settings-owned restart.
  for (let i = 0; i < 2; i++) {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(300)
  }
}
const invoke = command => c.evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(command)},{identity:window.__DSH_REMOTE_IDENTITY__})`)
async function waitForRestart(instance) {
  const result = await until(`(()=>{if(window.__DSH_REMOTE_IDENTITY__?.backendInstance>${instance})return{ok:true};const alert=document.querySelector('[data-dsh-ui-status][role=alert]');return alert?{error:alert.textContent}:null})()`, 180000)
  if (result.error) throw Error('Native restart refused: ' + result.error)
}
async function click(expression) {
  const { x, y } = await c.evaluate(`(()=>{const e=${expression};if(!e||e.disabled)throw Error('Button unavailable');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
function native(action = '') {
  const script = `
    Add-Type -TypeDefinition @'
    using System;
    using System.Runtime.InteropServices;
    public static class MarketWindowProbe {
      [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
      [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
      [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
      [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
      [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
      [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
      [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    }
'@
    $probeWindow = ${nativeWindowHandle ? `[IntPtr]::new(${nativeWindowHandle})` : `(Get-Process -Id ${child.pid}).MainWindowHandle`}
    ${action}
    $probeRect = New-Object MarketWindowProbe+RECT
    [void][MarketWindowProbe]::GetWindowRect($probeWindow, [ref]$probeRect)
    @{ handle=$probeWindow.ToInt64().ToString(); left=$probeRect.Left; top=$probeRect.Top; minimized=[MarketWindowProbe]::IsIconic($probeWindow); maximized=[MarketWindowProbe]::IsZoomed($probeWindow); visible=[MarketWindowProbe]::IsWindowVisible($probeWindow) } | ConvertTo-Json -Compress
  `
  const state = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }))
  // MainWindowHandle can select the tray receiver after the main window hides.
  // Keep checking the original native HWND throughout all controls and restarts.
  nativeWindowHandle ||= state.handle
  return state
}
async function physicalClick(expression) {
  const hit = await c.evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  return native(`
    $clickRect = New-Object MarketWindowProbe+RECT
    [void][MarketWindowProbe]::GetWindowRect($probeWindow, [ref]$clickRect)
    [void][MarketWindowProbe]::SetCursorPos($clickRect.Left + ${hit.x}, $clickRect.Top + ${hit.y})
    [MarketWindowProbe]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    try { Start-Sleep -Milliseconds 150 } finally { [MarketWindowProbe]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 500
  `)
}
try {
  console.log('Isolated evidence: ' + root)
  await ready()
  await c.send('Page.bringToFront')
  const sessionId = await c.evaluate(`(async()=>{const ctx=${context};const w=await ctx.workspaces.create({path:${JSON.stringify(root)}});const id=await ctx.sessions.create({workspaceId:w.workspaceId});await ctx.uiWorkspace.openSession(id);return id})()`)
  await until(`${context}.conversation.input.for(${context}.sessions.scope(${JSON.stringify(sessionId)}))?.state.getSnapshot()`)
  await c.evaluate(`(()=>{const ctx=${context},input=ctx.conversation.input.for(ctx.sessions.scope(${JSON.stringify(sessionId)}));input.setDraft('插件市场重启后保留的草稿');input.addAttachments(ctx.conversation.createDrafts(${JSON.stringify(sessionId)},[new File(['market restart attachment'],'market-restart.txt',{type:'text/plain'})]).map(f=>f.id))})()`)
  await until(`(()=>{const ctx=${context},ids=ctx.conversation.input.for(ctx.sessions.scope(${JSON.stringify(sessionId)})).state.getSnapshot().attachmentIds;return ids.length===1&&ids.every(id=>ctx.conversation.fileUploads.getSnapshot()[id]?.status==='ready')})()`)
  for (let i = 0; i < 2; i++) {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(300)
  }
  const installed = await c.evaluate(`(async()=>{const r=await ${context}.remote.desktopPlugins.installMarketplace();if(!r.ok)throw Error(r.error.message);return r.value})()`)
  assert.equal(installed.marketplace.error, '')
  assert.equal(installed.marketplace.installed, true)
  const initial = await invoke('remote_status')
  // The first native restart mounts the newly installed real market package.
  await c.evaluate('void window.__dshHostShell.restart()')
  console.log('Waiting for initial native restart')
  await waitForRestart(initial.instance)
  await ready()
  pass('real marketplace installation mounts through the native host restart')
  const market = await c.evaluate("fetch('/dsh-market/status').then(r=>r.json())")
  assert.equal(typeof market.boot, 'string')
  report.marketVersion = market.marketVersion || market.version
  // Update the real older package. Its server module stays loaded until restart.
  const update = await c.evaluate("fetch('/dsh-market/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'dshmarket'})}).then(async r=>({status:r.status,body:await r.json()}))")
  assert.equal(update.status, 200, JSON.stringify(update.body))
  assert.equal(update.body.ok, true, JSON.stringify(update.body))
  assert.notEqual(update.body.skipped, 'current')
  report.update = { ok: update.body.ok, activation: update.body.activation, installed: update.body.installed,
    exitCode: update.body.exitCode, timedOut: update.body.timedOut }
  await c.evaluate("(()=>{if(!document.querySelector('[data-shortcut-modal=settings]'))document.querySelector('.dshSidebarSettings__button, .dshAccount__settings, button[aria-haspopup=dialog]').click()})()")
  await until("Boolean(document.querySelector('[data-shortcut-modal=settings]'))")
  await c.evaluate("[...document.querySelectorAll('[data-shortcut-modal=settings] button')].find(b=>b.textContent.trim()==='插件市场').click()")
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='立即重启'&&!b.disabled)")
  await until("Boolean(document.querySelector('[data-dsh-market-root] [class*=_searchInput] input'))")
  await c.evaluate("(()=>{const input=document.querySelector('[data-dsh-market-root] [class*=_searchInput] input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'restart filter');input.dispatchEvent(new Event('input',{bubbles:true}))})()")
  const before = await invoke('remote_status')
  const oldIdentity = await c.evaluate('window.__DSH_REMOTE_IDENTITY__')
  await click("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='立即重启')")
  await waitForRestart(before.instance)
  await ready()
  const after = await invoke('remote_status')
  assert.deepEqual(after.active, before.active)
  assert.deepEqual(after.saved, before.saved)
  assert.notEqual(await c.evaluate("fetch('/dsh-market/status').then(r=>r.json()).then(r=>r.boot)"), market.boot)
  assert.equal(await c.evaluate(`${context}.conversation.input.for(${context}.sessions.scope(${JSON.stringify(sessionId)})).state.getSnapshot().draft`), '插件市场重启后保留的草稿')
  assert.deepEqual(await c.evaluate(`(async()=>{const ctx=${context},ids=ctx.conversation.input.for(ctx.sessions.scope(${JSON.stringify(sessionId)})).state.getSnapshot().attachmentIds;return Promise.all(ctx.conversation.resolveDraftAttachments(ids).map(async a=>({name:a.file.name,text:await a.file.text()})))})()`), [{ name: 'market-restart.txt', text: 'market restart attachment' }])
  assert.equal(await c.evaluate(`window.__TAURI__.core.invoke('remote_status',{identity:${JSON.stringify(oldIdentity)}}).then(()=>false,()=>true)`), true)
  pass('marketplace self-update and its actual restart button preserve drafts, attachments, listener settings and reject the old identity')
  await click("document.querySelectorAll('.dshTb__control')[1]")
  await sleep(250)
  assert.equal(native().maximized, true)
  await click("document.querySelectorAll('.dshTb__control')[1]")
  await sleep(250)
  assert.equal(native().maximized, false)
  pass('title bar maximizes and restores the real native window after the marketplace restart')
  const beforeDrag = native()
  const hit = await c.evaluate("(()=>{const e=document.querySelector('.dshTb__spacer'),r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()")
  const moved = native(`
    [void][MarketWindowProbe]::SetForegroundWindow($probeWindow)
    $dragRect = New-Object MarketWindowProbe+RECT
    [void][MarketWindowProbe]::GetWindowRect($probeWindow, [ref]$dragRect)
    $dragX = $dragRect.Left + ${hit.x}; $dragY = $dragRect.Top + ${hit.y}
    [void][MarketWindowProbe]::SetCursorPos($dragX, $dragY)
    [MarketWindowProbe]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    try {
      Start-Sleep -Milliseconds 250
      [void][MarketWindowProbe]::SetCursorPos($dragX + 70, $dragY + 60)
      Start-Sleep -Milliseconds 250
    } finally { [MarketWindowProbe]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 200
  `)
  assert.ok(moved.left !== beforeDrag.left || moved.top !== beforeDrag.top, 'a physical caption drag moves the native window')
  pass('a physical title bar drag moves the real native window after the marketplace restart')
  assert.equal((await physicalClick("document.querySelectorAll('.dshTb__control')[0]")).minimized, true)
  // Use the same lifecycle owner as the tray's Show action, which restores
  // both the native window and its child WebView after minimization.
  execFileSync(exe, [], { cwd: root, env: desktopEnv, windowsHide: true, stdio: 'ignore', timeout: 15000 })
  await sleep(250)
  assert.equal(native().minimized, false)
  pass('title bar minimizes the real native window after the marketplace restart')
  // Dispatch through the React button after restoring the minimized WebView;
  // its native HWND then confirms the same close-to-tray behavior.
  await c.evaluate("document.querySelectorAll('.dshTb__control')[2].click()")
  await sleep(500)
  assert.equal(native().visible, false)
  assert.equal(child.exitCode, null, 'close retains the desktop background runtime')
  pass('title bar close hides the native window to the tray after the marketplace restart')
} catch (error) {
  report.error = error.stack
  if (c) { try { report.page = await c.evaluate(`({body:document.body.innerText.slice(0,6000),suspended:window.__DSH_UI_STATE__?.isConnectionSuspended(),identity:window.__DSH_REMOTE_IDENTITY__,dialogs:[...document.querySelectorAll('[role=dialog],dialog[open],[aria-modal=true]')].map(e=>({class:e.className,market:!!e.querySelector('[data-dsh-market-root]'),ghost:!!e.closest('[data-dsh-ghost]'),alerts:e.querySelectorAll('[role=alertdialog]').length})),fields:[...document.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=true]')].map(e=>({type:e.type,tag:e.tagName,class:e.className,valueLength:e.value?.length,market:!!e.closest('[data-dsh-market-root]'),ghost:!!e.closest('[data-dsh-ghost]'),visible:e.checkVisibility()}))})`) } catch {} }
  throw error
} finally {
  c?.close()
  if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Evidence: ' + root)
}
