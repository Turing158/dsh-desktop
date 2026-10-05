/** Verify built-in terminal ownership in an isolated Windows WebView2/DSH profile. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, writeFile, readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createServer } from 'node:net'
import { connect } from './terminal-cdp.mjs'
import { checkTerminalTabMenus } from './upstream-terminal-menu-check.mjs'
import { checkTerminalInteractions } from './upstream-terminal-interactions-check.mjs'
import { checkDockSidebarLayout } from './terminal-dock-layout-check.mjs'

const root = await mkdtemp(resolve('src-tauri/target/upstream-terminal-'))
const exe = join(root, 'deepseek-harness-desktop.exe')
await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'), exe)
for (const [source, destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources)) {
  const target = join(root, destination)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(resolve('src-tauri', source), target)
}
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
  ...process.env, DSH_HOME: join(root, 'dsh-home'), DSH_DESKTOP_SMOKE_DIR: root,
  DSH_DESKTOP_DEBUG: join(root, 'host.log'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
} })
let c
const report = { root, checks: [] }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(expression, timeout = 40000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    if (child.exitCode !== null) throw Error('Isolated desktop exited: ' + child.exitCode)
    try {
      c ||= await connect(port)
      const value = await c.evaluate(expression)
      if (value) return value
    } catch (error) { last = error }
    await sleep(150)
  }
  throw Error('Timed out: ' + expression + ' ' + (last?.message || ''))
}
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }
const noDesktop = `(() => ({
  types: T.sidebarRightTabs.entries().filter(t => t.kind === 'desktop-terminal').length,
  surfaces: document.querySelectorAll('[data-dsh-terminal], [data-dsh-terminal-dock], .dshTerminalDock').length,
  settings: T.slots.entriesOfSlot('settings.general.item').filter(e => JSON.stringify(e.options || {}).includes('desktop-terminal')).length,
  runtime: Boolean(window.__DSH_TERMINAL_SMOKE__)
}))()`
async function ready() {
  await until("window.__DSH_SMOKE_CONTEXT__?.sessions.list.getSnapshot().phase === 'ready'")
  await c.evaluate(`(()=>{window.__DSH_SMOKE_CONTEXT__.inject(['sidebarRightTabs', 'sidebarRight', 'webTerminals', 'configForms'], ctx => { window.T = ctx })})()`)
  await until("Boolean(window.T?.sidebarRightTabs.get('terminal'))")
  for (let i = 0; i < 8; i++) {
    await c.evaluate(`(()=>{for(const b of document.querySelectorAll('button'))if(['稍后配置','继续'].includes(b.textContent))b.click()})()`)
    await sleep(150)
  }
}
try {
  await ready()
  assert.deepEqual(await c.evaluate(noDesktop), { types: 0, surfaces: 0, settings: 2, runtime: false })
  assert.equal(await c.evaluate("document.body.textContent.includes('Failed to load plugins')"), false)
  await until('Boolean(window.__DSH_UPSTREAM_DOCK_SMOKE__)')
  pass('built-in DSH terminal keeps the dock runtime with two preference rows and no native PTYs')
  await c.evaluate(`(async()=>{const ctx=window.__DSH_SMOKE_CONTEXT__;const w=await ctx.workspaces.create({path:${JSON.stringify(root)}});const id=await ctx.sessions.create({workspaceId:w.workspaceId});ctx.uiWorkspace.openSession(id)})()`)
  await until('Boolean(T.sidebarRight.mounted.getSnapshot())')
  report.guide = await c.evaluate("T.sidebarRightTabs.guide().map(e => ({kind:e.kind,title:e.title()}))")
  assert.equal(report.guide.filter(e => /terminal/.test(e.kind)).length, 1)
  assert.ok(report.guide.some(e => e.kind === 'terminal'))
  pass('right sidebar offers only the built-in terminal')
  await c.evaluate(`(()=>{window.dockErrors=[];const error=console.error;console.error=(...args)=>{dockErrors.push(args.map(x=>x?.stack||String(x)).join(' '));error.apply(console,args)};window.addEventListener('error',e=>dockErrors.push(e.error?.stack||e.message))})()`)
  await until("Boolean(document.querySelector('[data-dsh-terminal-dock-toggle]'))")
  await c.evaluate("document.querySelector('[data-dsh-terminal-dock-toggle]').click()")
  await until(`(()=>{
    const d=window.__DSH_UPSTREAM_DOCK_SMOKE__, tab=d.dock.getSnapshot().tabs[0];
    window.dockModel=tab && d.registry.view(tab)?.model;
    return dockModel?.state.getSnapshot().writable && document.querySelector('[data-dsh-terminal-dock] [data-sidebar-terminal] .xterm-helper-textarea');
  })()`)
  await c.evaluate("document.querySelector('[data-dsh-terminal-dock] .xterm-helper-textarea').focus()")
  await c.send('Input.insertText', { text: 'echo UPSTREAM_DOCK_OK_915' })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until("(document.querySelector('[data-dsh-terminal-dock] .xterm-rows')?.textContent || '').split('UPSTREAM_DOCK_OK_915').length >= 3")
  let dockId = await c.evaluate('dockModel.id')
  pass('header button opens the DSH terminal in the bottom dock and runs a real command')
  await checkDockSidebarLayout(c, root, pass)
  await checkTerminalInteractions(c, until, root, pass, { seat: 'bottom', selector: '[data-dsh-terminal-dock] .xterm', model: 'dockModel', marker: 'UPSTREAM_DOCK_OK_915' })
  assert.ok(await c.evaluate(`(()=>{const a=document.querySelector('[data-dsh-terminal-dock-toggle]').getBoundingClientRect(),b=document.querySelector('[data-sidebar-right-expand]').getBoundingClientRect();return a.right<=b.left+1 && b.left-a.right<24})()`))
  const projectOne = await c.evaluate('T.sidebarRight.mounted.getSnapshot()')
  const secondFolder = join(root, 'second-project')
  await mkdir(secondFolder)
  await c.evaluate(`(async()=>{const ctx=window.__DSH_SMOKE_CONTEXT__,w=await ctx.workspaces.create({path:${JSON.stringify(secondFolder)}});window.dockProjectTwo=await ctx.sessions.create({workspaceId:w.workspaceId});ctx.uiWorkspace.openSession(dockProjectTwo)})()`)
  await until(`(()=>{const d=window.__DSH_UPSTREAM_DOCK_SMOKE__,tab=d.dock.getSnapshot().tabs[0];window.secondDockModel=tab&&d.registry.view(tab)?.model;return secondDockModel?.id!==${JSON.stringify(dockId)} && secondDockModel?.state.getSnapshot().writable})()`)
  assert.equal((await c.evaluate('secondDockModel.state.getSnapshot().info.cwd')).toLowerCase(), secondFolder.toLowerCase())
  await c.evaluate('window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.resize(300)')
  await until("document.querySelector('[data-dsh-terminal-dock]').getBoundingClientRect().height===300")
  await c.evaluate("(()=>{const d=window.__DSH_UPSTREAM_DOCK_SMOKE__.dock;d.close(d.getSnapshot().active)})()")
  await until("secondDockModel.state.getSnapshot().phase==='closed'")
  await c.evaluate(`window.__DSH_SMOKE_CONTEXT__.uiWorkspace.openSession(${JSON.stringify(projectOne)})`)
  await until('dockModel.state.getSnapshot().writable')
  assert.equal(await c.evaluate('window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().tabs.length'), 1)
  pass('projects keep separate DSH terminals; resize works and close terminates only its own terminal')
  await c.evaluate("document.dispatchEvent(new CustomEvent('dsh-desktop:set-ui-mode',{detail:{mode:'vanilla'}}))")
  await until("!document.querySelector('[data-dsh-terminal-dock]') && !document.querySelector('[data-dsh-terminal-dock-toggle]')")
  await c.evaluate("document.dispatchEvent(new CustomEvent('dsh-desktop:set-ui-mode',{detail:{mode:'desktop'}}))")
  await until("document.querySelector('[data-dsh-terminal-dock]') && dockModel.state.getSnapshot().writable")
  pass('appearance mode round trip keeps the same dock terminal')
  await c.evaluate("document.querySelector('[data-dsh-terminal-dock-toggle]').click()")
  await until("!document.querySelector('[data-dsh-terminal-dock]')")
  // Persisted desktop records must disappear without removing upstream records.
  await c.evaluate(`(()=>{
    const ctx=window.__DSH_SMOKE_CONTEXT__, id=T.sidebarRight.mounted.getSnapshot();
    const entry=ctx.slots.entriesOfSlot('rightbar.session')[0];
    const store=ctx.slots.resolveStore(entry.store || entry.options.store,{key:id,ctx:ctx.sessions.scope(id)});
    store.actions.openContent(id,{kind:'desktop-terminal',contentId:'dsh-resource://desktop-terminal/old',title:'旧终端'},()=>{});
    T.sidebarRight.openTab('terminal');
  })()`)
  await until("!T.sidebarRight.openTabs.getSnapshot().some(t => t.kind === 'desktop-terminal')")
  await until(`(()=>{
    const el=document.querySelector('[data-sidebar-terminal] .xterm-helper-textarea');
    const target=el && T.sidebarRight.commandTarget(el), nav=target?.occurrence?.navigation.getSnapshot();
    if(!nav)return false;
    window.model=T.webTerminals.view(target.sessionId,target.tabId,nav.address,nav.params?.terminalId,nav.params?.shellPath);
    return model.state.getSnapshot().writable;
  })()`)
  pass('stale desktop tabs are removed while the built-in terminal starts normally')
  await c.evaluate("document.querySelector('[data-dsh-terminal-dock-toggle]').click()")
  await until("dockModel.state.getSnapshot().writable && document.querySelector('[data-dsh-terminal-dock] .xterm-helper-textarea')")
  assert.equal(await c.evaluate('dockModel.id'), dockId)
  await until("document.querySelector('[data-dsh-terminal-dock] .xterm-rows')?.textContent.includes('UPSTREAM_DOCK_OK_915')")
  pass('collapsed dock keeps the same terminal and output across right sidebar changes')
  dockId = await checkTerminalTabMenus(c, until, root, pass)
  const screenshot = await c.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, 'upstream-dock.png'), Buffer.from(screenshot.data, 'base64'))
  await c.evaluate("document.querySelector('[data-dsh-terminal-dock-toggle]').click()")
  await c.evaluate("document.querySelector('[data-sidebar-terminal] .xterm-helper-textarea').focus()")
  await c.send('Input.insertText', { text: 'echo UPSTREAM_TERMINAL_OK_731' })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until(`(()=>{const text=document.querySelector('[data-sidebar-terminal] .xterm-rows')?.textContent || '';return text.split('UPSTREAM_TERMINAL_OK_731').length>=3})()`)
  pass('built-in terminal accepts a real command and displays its output')
  await checkTerminalInteractions(c, until, root, pass, { seat: 'right', selector: '[data-sidebar-terminal] .xterm', model: 'model', marker: 'UPSTREAM_TERMINAL_OK_731' })
  await c.evaluate("T.configForms.get('desktop-terminal-dock').set('position','right')")
  const count = await c.evaluate("T.sidebarRight.openTabs.getSnapshot().filter(t => t.kind === 'terminal').length")
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, modifiers: 2 })
  await until(`T.sidebarRight.openTabs.getSnapshot().filter(t => t.kind === 'terminal').length === ${count + 1}`)
  assert.deepEqual(await c.evaluate(noDesktop), { types: 0, surfaces: 0, settings: 2, runtime: false })
  assert.deepEqual(await c.evaluate("window.__TAURI__.core.invoke('terminal_list',{identity:window.__DSH_TERMINAL_IDENTITY__})"), [])
  pass('Ctrl+backquote creates only an upstream terminal and no desktop PTY')
  assert.deepEqual(await c.evaluate('window.dockErrors'), [])
  await c.send('Page.reload')
  await ready()
  assert.deepEqual(await c.evaluate(noDesktop), { types: 0, surfaces: 0, settings: 2, runtime: false })
  await until("Boolean(document.querySelector('[data-dsh-terminal-dock-toggle]'))")
  await c.evaluate("document.querySelector('[data-dsh-terminal-dock-toggle]').click()")
  await until(`(()=>{const d=window.__DSH_UPSTREAM_DOCK_SMOKE__, tab=d?.dock.getSnapshot().tabs[0];window.dockModel=tab&&d.registry.view(tab)?.model;return dockModel?.state.getSnapshot().writable})()`)
  assert.equal(await c.evaluate('dockModel.id'), dockId)
  pass('reload restores the same DSH dock terminal while starting with the panel collapsed')
  await c.evaluate("document.querySelector('[data-dsh-terminal-dock-toggle]').click()")
  await c.evaluate("T.sidebarRight.openTab('guide')")
  await until("Boolean(document.querySelector('[data-sidebar-right-guide-entry=terminal]'))")
  const guideScreenshot = await c.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, 'upstream-terminal.png'), Buffer.from(guideScreenshot.data, 'base64'))
} catch (error) {
  report.error = error.stack
  if (c) try { report.page = await c.evaluate('document.body.innerText.slice(0, 5000)') } catch {}
  if (c) try { report.dock = await c.evaluate('({state:window.__DSH_UPSTREAM_DOCK_SMOKE__?.dock.getSnapshot(),model:window.dockModel?.state.getSnapshot(),errors:window.dockErrors})'); console.log(report.dock) } catch {}
  if (c) try { const shot=await c.send('Page.captureScreenshot',{format:'png'});await writeFile(join(root,'failure.png'),Buffer.from(shot.data,'base64')) } catch {}
  throw error
} finally {
  if (c) {
    try { await c.evaluate("(()=>{const d=window.__DSH_UPSTREAM_DOCK_SMOKE__?.dock;for(const t of d?.getSnapshot().tabs||[])d.close(t.contentId)})()") } catch {}
    try { await c.evaluate("(()=>{for(const tab of T.sidebarRight.openTabs.getSnapshot())if(tab.kind==='terminal')T.sidebarRight.close(tab.tabId)})()") } catch {}
    c.close()
  }
  if (child.exitCode === null) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }
    catch (error) {
      await sleep(200)
      try { process.kill(child.pid, 0); report.cleanupError = error.message }
      catch { /* The process tree already exited during taskkill. */ }
    }
  }
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Evidence: ' + join(root, 'report.json'))
}
