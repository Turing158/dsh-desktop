/** Owns an isolated host/profile. Verifies PTY continuity and ordinary-browser UI. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, writeFile, readFile, unlink } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { connect } from './terminal-cdp.mjs'

const root = await mkdtemp(resolve('src-tauri/target/remote-terminal-'))
const checks = [], sleep = ms => new Promise(r => setTimeout(r, ms))
const check = (name, detail = true) => { checks.push({ name, detail }); console.log('PASS ' + name) }
async function freePort(host) {
  const server = createServer(); await new Promise(r => server.listen(0, host, r))
  const port = server.address().port; await new Promise(r => server.close(r)); return port
}
const cdpPort = await freePort('127.0.0.1')
const exe = join(root, 'deepseek-harness-desktop.exe')
await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'), exe)
for (const [source, destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources)) {
  const target = join(root, destination); await mkdir(dirname(target), { recursive: true }); await copyFile(resolve('src-tauri', source), target)
}
const real = join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const wrapper = join(root, 'runtime-wrapper.mjs'), marker = join(root, 'fail-lan')
await writeFile(wrapper, `import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';
const args=process.argv.slice(2);if(args.includes('--host')&&existsSync(${JSON.stringify(marker)})){console.error('injected LAN startup failure');process.exit(17)}
const child=spawn(process.execPath,[${JSON.stringify(real)},...args],{stdio:'inherit',windowsHide:true,env:{...process.env,DSH_DESKTOP_DSH_BIN:${JSON.stringify(real)}}});child.on('exit',code=>process.exit(code||0));`)
await writeFile(join(root, 'command.json'), '{}')
const child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env,
  DSH_HOME: join(root, 'dsh-home'), DSH_DESKTOP_DSH: wrapper, DSH_DESKTOP_SMOKE_DIR: root,
  DSH_DESKTOP_DEBUG: join(root, 'host.log'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdpPort,
} })
let c, browser, shellPid
const call = (name, args = {}) => c.evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(name)}, {identity:window.__DSH_REMOTE_IDENTITY__,...${JSON.stringify(args)}})`)
async function until(expression, timeout = 65000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try { c ||= await connect(cdpPort); const value = await c.evaluate(expression); if (value) return value } catch (e) { last = e.message }
    await sleep(100)
  }
  throw Error('Timed out: ' + expression.slice(0, 150) + (last ? '\n' + last : ''))
}
async function ready() {
  await until(`Boolean(window.__DSH_REMOTE_IDENTITY__ && window.__DSH_TERMINAL_SMOKE__ && window.__DSH_SMOKE_CONTEXT__?.sessions.list.getSnapshot().phase==='ready')`)
  for (let i = 0; i < 10; i++) {
    await c.evaluate(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='稍后配置')?.click();const beta=[...document.querySelectorAll('[role=dialog]')].find(d=>d.textContent.includes('内测声明'));[...beta?.querySelectorAll('button')||[]].find(b=>b.textContent==='继续')?.click()})()`)
    await sleep(150)
  }
  await until(`!document.querySelector('[data-dsh-ui-status]')`, 30000)
  await c.evaluate(`window.D=window.__DSH_TERMINAL_SMOKE__;D.view=()=>D.registry.view(D.dock.getSnapshot().tabs.find(t=>t.contentId===D.dock.getSnapshot().active));D.list=()=>window.__TAURI__.core.invoke('terminal_list',{identity:window.__DSH_TERMINAL_IDENTITY__})`)
}
async function enter(command) {
  await until(`(()=>{document.querySelector('.dshTerminalDock .xterm-helper-textarea')?.focus();return D.view()?.readyForInput})()`, 20000)
  await c.send('Input.insertText', { text: command })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}
const psPath = name => "'" + join(root, name).replaceAll("'", "''") + "'"
async function progress() { return (await readFile(join(root, 'progress.txt'), 'utf8')).trim().split(/\r?\n/).filter(Boolean) }
let before, dockKey, sideKey
async function apply(config, name) {
  const old = await c.evaluate('window.__DSH_TERMINAL_IDENTITY__')
  const priorTicks = (await progress()).length
  const result = await c.evaluate(`(async()=>{const status=await window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__});const payload=await window.__DSH_UI_STATE__.prepareRemoteApply(status.frontendVersion);try{return await window.__TAURI__.core.invoke('remote_apply',{identity:window.__DSH_REMOTE_IDENTITY__,config:${JSON.stringify(config)},payload})}catch(error){window.__DSH_UI_STATE__.finishRemoteApply();throw error}})()`)
  assert.equal(result.changed, true)
  await until(`window.__DSH_REMOTE_IDENTITY__?.backendInstance > ${old.backendInstance}`)
  await ready()
  const after = await c.evaluate(`D.list()`)
  assert.deepEqual(after.map(({ terminalId, runId, resourceKey }) => ({ terminalId, runId, resourceKey })).sort((a,b)=>a.terminalId.localeCompare(b.terminalId)), before)
  assert.equal(await c.evaluate('D.dock.getSnapshot().active'), dockKey)
  assert.equal(await c.evaluate('D.dock.getSnapshot().collapsed'), false)
  assert.equal(await c.evaluate('D.ctx.sidebarRight.active()?.contentId'), sideKey)
  try {
    await until(`document.querySelector('.dshTerminalDock .xterm-rows')?.textContent.includes('terminal-alive')`, 15000)
  } catch(error) {
    console.error(await c.evaluate(`({message:D.view().message,info:D.view().info,mounted:D.view().mounted,connected:D.view().element.isConnected,text:document.querySelector('.dshTerminalDock')?.textContent,rows:[...document.querySelectorAll('.xterm-rows')].map(n=>n.textContent)})`))
    throw error
  }
  const ticks = await progress()
  assert.ok(ticks.length > priorTicks, 'the command must keep making progress during restart')
  assert.ok(ticks.every(pid => Number(pid) === shellPid), 'no replacement shell may produce the output')
  assert.equal(await c.evaluate(`window.__TAURI__.core.invoke('terminal_list',{identity:${JSON.stringify(old)}}).then(()=>false,()=>true)`), true)
  check(name, { shellPid, terminalIds: after.map(s => s.terminalId), progressLines: ticks.length })
  return call('remote_status')
}
try {
  await ready()
  const address = (await call('remote_lan_addresses'))[0]?.address; assert.ok(address)
  const port = await freePort(address)
  const config = { version: 1, enabled: true, bindAddress: address, port, trustedHosts: [] }
  await c.evaluate(`(async()=>{const ctx=window.__DSH_SMOKE_CONTEXT__;const w=await ctx.workspaces.create({path:${JSON.stringify(root)}});await ctx.uiWorkspace.openWorkspace(w.workspaceId)})()`)
  await until(`D.ctx.sessions.list.getSnapshot().current`)
  await c.evaluate(`D.dock.open()`)
  await enter(`$global:remoteMarker = 'kept'; $PID | Set-Content -LiteralPath ${psPath('pid.txt')}; while ($true) { $PID | Add-Content -LiteralPath ${psPath('progress.txt')}; Write-Output 'terminal-alive'; Start-Sleep -Milliseconds 350 }`)
  for (let i=0; i<100; i++) { try { shellPid=Number((await readFile(join(root,'pid.txt'),'utf8')).trim()); if(shellPid)break } catch {} await sleep(100) }
  assert.ok(shellPid)
  dockKey = await c.evaluate('D.dock.getSnapshot().active')
  sideKey = await c.evaluate(`D.registry.openSidebar('auto')`)
  await until(`D.list().then(items=>items.length===2&&items.every(t=>t.state==='running'))`)
  before = (await c.evaluate('D.list()')).map(({ terminalId, runId, resourceKey }) => ({ terminalId, runId, resourceKey })).sort((a,b)=>a.terminalId.localeCompare(b.terminalId))
  await c.evaluate(`window.DSHTerminal.createRemoteState(D.ctx,D.registry,D.dock).capture()`)
  let status = await apply(config, 'enable LAN preserves both terminal surfaces and the running command')
  assert.equal(status.state, 'lan')
  const port2 = await freePort(address)
  const changed = { ...config, port: port2 }
  status = await apply(changed, 'changing LAN port reconnects existing terminal processes')
  assert.equal(status.active.port, port2)

  const info = await call('remote_connection_info')
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(info.url)
  await page.locator('.dshTb').waitFor()
  for(let i=0;i<10;i++) {
    const beta=page.getByRole('dialog').filter({hasText:'内测声明'}); if(await beta.isVisible())await beta.getByRole('button',{name:'继续',exact:true}).click()
    const later=page.getByRole('button',{name:'稍后配置',exact:true});if(await later.isVisible())await later.click()
    await page.waitForTimeout(150)
  }
  assert.equal(await page.evaluate(()=>Boolean(window.__TAURI__)), false)
  await page.evaluate(()=>localStorage.setItem('dsh-terminal-dock', JSON.stringify({ tabs: ['dsh-resource://desktop-terminal/stale-mobile'], collapsed: false })))
  await page.reload(); await page.locator('.dshTb').waitFor()
  for(let i=0;i<10;i++) {
    const beta=page.getByRole('dialog').filter({hasText:'内测声明'}); if(await beta.isVisible())await beta.getByRole('button',{name:'继续',exact:true}).click()
    const later=page.getByRole('button',{name:'稍后配置',exact:true});if(await later.isVisible())await later.click()
    await page.waitForTimeout(150)
  }
  assert.equal(await page.locator('[data-dsh-terminal], [data-dsh-terminal-dock], [data-dsh-terminal-dock-toggle]').count(), 0)
  assert.equal(await page.getByText('请在桌面应用中打开终端。', {exact:true}).count(), 0)
  await page.locator('.dshTb__mark').click()
  await page.locator('button[aria-haspopup=dialog]:visible').first().click()
  assert.equal(await page.getByText('默认终端类型', {exact:true}).count(), 0)
  assert.equal(await page.getByText('终端显示位置', {exact:true}).count(), 0)
  await page.getByRole('button', {name:'远程控制',exact:true}).click()
  await page.getByText('请在电脑桌面应用中修改远程控制设置', {exact:true}).waitFor()
  assert.deepEqual(errors, [])
  await page.screenshot({ path: join(root, 'mobile-no-terminal.png') })
  check('mobile browser has no terminal UI or settings while remote settings still work')
  await browser.close(); browser = null

  status = await apply({ ...changed, enabled: false }, 'disabling remote access preserves desktop terminal commands')
  assert.equal(status.state, 'disabled')
  await writeFile(marker, 'injected')
  status = await apply(changed, 'failed LAN launch and local fallback preserve the same terminal processes')
  assert.equal(status.state, 'local-fallback'); assert.equal(status.error.code, 'start-failed')
  await unlink(marker)
  await until(`(()=>{document.querySelector('.dshTerminalDock .xterm-helper-textarea')?.focus();return D.view().readyForInput})()`)
  await c.send('Input.dispatchKeyEvent', {type:'keyDown',key:'c',code:'KeyC',modifiers:2,windowsVirtualKeyCode:67})
  await c.send('Input.dispatchKeyEvent', {type:'keyUp',key:'c',code:'KeyC',modifiers:2,windowsVirtualKeyCode:67})
  await sleep(500)
  await enter(`$global:remoteMarker | Set-Content -LiteralPath ${psPath('input-restored.txt')}`)
  for(let i=0;i<100;i++){try{if((await readFile(join(root,'input-restored.txt'),'utf8')).trim()==='kept')break}catch{}await sleep(100)}
  assert.equal((await readFile(join(root,'input-restored.txt'),'utf8')).trim(),'kept')
  check('restored terminal accepts input and retains shell variables')
} finally {
  await browser?.close(); c?.close()
  if(child.exitCode===null) {
    const exited=new Promise(r=>child.once('exit',r)); await writeFile(join(root,'command.json'),JSON.stringify({sequence:Date.now(),action:'quit'}))
    await Promise.race([exited,sleep(12000).then(()=>{if(child.exitCode===null)child.kill()})])
  }
  if(shellPid) { await sleep(500); assert.throws(()=>process.kill(shellPid,0),'quitting the host must terminate the retained shell'); check('host exit terminates retained terminal processes') }
  await writeFile(join(root,'remote-terminal-integration.json'),JSON.stringify({date:new Date().toISOString(),checks},null,2))
  console.log('Evidence: '+root)
}
