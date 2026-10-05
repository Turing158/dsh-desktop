/** Run only against an isolated debug host with DSH_DESKTOP_SMOKE_DIR set. */
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, rmdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { connect } from './terminal-cdp.mjs'

const dir = resolve(process.env.DOCK_SMOKE_DIR || 'src-tauri/target/bottom-terminal-live')
await mkdir(dir, { recursive: true })
const cdp = await connect(Number(process.env.CDP_PORT || 9342))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const checks = [], screenshots = []
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name) }
async function until(expression, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { const value = await cdp.evaluate(`(async()=>Boolean(await (${expression})))()`); if (value) return value } catch {}
    await sleep(120)
  }
  throw Error('Timed out: ' + expression)
}
const init = () => cdp.evaluate(`(() => {
  const smoke=window.__DSH_TERMINAL_SMOKE__;
  window.D={ctx:smoke.ctx,registry:smoke.registry,store:smoke.dock,
    invoke:(name,args={})=>window.__TAURI__.core.invoke(name,{identity:window.__DSH_TERMINAL_IDENTITY__,...args}),
    list:()=>D.invoke('terminal_list'),
    tabs:()=>D.store.getSnapshot().tabs,
    active:()=>D.store.getSnapshot().active,
    view:()=>D.registry.view(D.tabs().find(t=>t.contentId===D.active())),
    root:()=>document.querySelector('[data-dsh-terminal-dock]'),
    screen:()=>document.querySelector('.dshTerminalDock .xterm-rows')?.textContent || '',
    select:key=>D.store.activate(key),
    wire:s=>({terminalId:s.terminalId,runId:s.runId})};
  for(const b of document.querySelectorAll('button'))if(b.textContent==='稍后配置')b.click();
})()`)
async function key(key, code = key, text) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...(text ? { text, unmodifiedText: text } : {}), windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0 })
}
async function type(command, surface = '.dshTerminalDock') {
  if (surface === '.dshTerminalDock') await until(`D.root().querySelector('.dshTerminal__screen')===D.view()?.element`)
  await until(`document.querySelector(${JSON.stringify(surface + ' .xterm-rows')})?.textContent.includes('>')`)
  await cdp.evaluate(`document.querySelector(${JSON.stringify(surface + ' .xterm-helper-textarea')}).focus()`)
  await sleep(400)
  // The isolated profile has no API key; its delayed onboarding dialog can
  // appear after a refresh. Dismiss it before sending real keyboard events.
  await until(`(()=>{for(const b of document.querySelectorAll('button'))if(b.textContent==='稍后配置')b.click();const el=document.querySelector(${JSON.stringify(surface + ' .xterm-helper-textarea')});el?.focus();return el && document.activeElement===el})()`)
  if (surface === '.dshTerminalDock') await until(`D.view().readyForInput`)
  await sleep(200)
  for (const ch of command) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: 0 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: 0 })
  }
  await key('Enter', 'Enter', '\r')
}
async function menu(label) {
  await cdp.evaluate(`(()=>{const b=D.root().querySelector('[data-dsh-terminal-more]');b.focus();b.click()})()`)
  await until(`document.querySelector('[role=menu]')`)
  if (label) await cdp.evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent===${JSON.stringify(label)}).click()`)
}
async function shot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(resolve(dir, name + '.png'), Buffer.from(data, 'base64')); screenshots.push(name + '.png')
}
const alive = pid => execFileSync('powershell', ['-NoProfile', '-Command', `if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { 'alive' }`], { encoding: 'utf8' }).trim() === 'alive'
let sequence = Date.now()
async function lifecycle(action) {
  await writeFile(resolve(dir, 'command.json'), JSON.stringify({ sequence: ++sequence, action }))
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try { const s = JSON.parse(await readFile(resolve(dir, 'state.json'), 'utf8')); if (s.command === sequence) return s } catch {}
    await sleep(120)
  }
  throw Error('No lifecycle acknowledgement: ' + action)
}

try {
  await until('Boolean(window.__DSH_UI_BOOT__?.smoke && window.__DSH_TERMINAL_SMOKE__?.dock && window.__DSH_TERMINAL_IDENTITY__)')
  // Start each run clean within this disposable profile, retaining the app itself.
  //
  // The dock is left COLLAPSED, which is the shipped default: this run needs a
  // known-empty panel and then opens it through the header control, so the open
  // path is the one under test rather than an assumption the setup made for it.
  await init()
  await cdp.evaluate(`(async()=>{for(const t of [...D.tabs()])D.store.close(t.contentId);for(const s of await D.list())await D.invoke('terminal_close',D.wire(s));D.store.resize(240);D.store.collapse(true)})()`)
  await cdp.send('Page.reload')
  await until('Boolean(window.__DSH_TERMINAL_SMOKE__?.dock && window.__DSH_TERMINAL_IDENTITY__)')
  await init()
  await until(`!D.store.getSnapshot().restoring`)
  // ── the default: closed, nothing reserved, and the header control is the way in ──
  check('the panel starts closed and reserves no layout space', await cdp.evaluate(`D.store.getSnapshot().collapsed===true && !document.querySelector('[data-dsh-terminal-dock]') && getComputedStyle(document.querySelector('[class*="_centerCol"]')).paddingBottom==='0px'`))
  check('the header offers 打开底部侧边栏 while the panel is closed', await cdp.evaluate(`Boolean(document.querySelector('[data-dsh-terminal-dock-toggle]')) && document.querySelector('[data-dsh-terminal-dock-toggle]').getAttribute('aria-label')==='打开底部侧边栏'`))
  check('the header control precedes the shipped 打开侧边栏 button', await cdp.evaluate(`(()=>{const t=document.querySelector('[data-dsh-terminal-dock-toggle]'),c=document.querySelector('[data-sidebar-right-expand]');if(!c)return false;return t.getBoundingClientRect().right<=c.getBoundingClientRect().left+1})()`))
  const cwd = dir.replaceAll('\\', '/')
  await cdp.evaluate(`(async()=>{const w=await D.ctx.workspaces.create({path:${JSON.stringify(cwd)}});const id=await D.ctx.sessions.create({workspaceId:w.workspaceId});D.ctx.sessions.open(id)})()`)
  await until(`D.ctx.sessions.list.getSnapshot().current && D.ctx.workspaces.list.getSnapshot().phase==='ready'`)
  // Opening an EMPTY panel must start a terminal rather than show an empty frame.
  await cdp.evaluate(`document.querySelector('[data-dsh-terminal-dock-toggle]').click()`)
  await until(`D.view()?.info?.state==='running'`)
  const first = await cdp.evaluate(`D.active()`)
  check('opening an empty panel starts a terminal and keeps the header toggle available', await cdp.evaluate(`D.tabs().length===1 && document.querySelector('[data-dsh-terminal-dock-toggle]')?.getAttribute('aria-expanded')==='true'`))
  await cdp.evaluate(`document.querySelector('[data-dsh-terminal-dock-toggle]').click()`)
  await until(`!D.root()`)
  check('the same header button closes the bottom panel', await cdp.evaluate(`document.querySelector('[data-dsh-terminal-dock-toggle]')?.getAttribute('aria-expanded')==='false' && getComputedStyle(document.querySelector('[class*="_centerCol"]')).paddingBottom==='0px'`))
  await cdp.evaluate(`document.querySelector('[data-dsh-terminal-dock-toggle]').click()`)
  await until(`D.root() && D.view()?.info?.state==='running'`)
  check('reopening from the header preserves the existing terminal', await cdp.evaluate(`D.tabs().length===1 && D.active()===${JSON.stringify(first)}`))
  check('the seeded terminal runs in the current workspace', await cdp.evaluate(`D.view().info.cwd.replaceAll('\\\\','/').toLowerCase()===${JSON.stringify(cwd.toLowerCase())}`))
  await type("$global:dockCounter=1; Write-Output ('DOCK'+'-READY')")
  await until(`D.screen().includes('DOCK-READY')`)
  check('real keyboard input reaches the dock PTY', true)
  const parentFile = resolve(dir, 'shell-' + sequence + '.pid').replaceAll('\\', '/')
  const childFile = resolve(dir, 'child-' + sequence + '.pid').replaceAll('\\', '/')
  await type(`[IO.File]::WriteAllText('${parentFile}',[string]$PID); $p=Start-Process ping.exe -ArgumentList '-t 127.0.0.1' -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText('${childFile}',[string]$p.Id)`)
  await until(`D.screen().includes('>')`)
  for (let i=0; i<30; i++) { try { await readFile(childFile); break } catch { await sleep(100) } }
  const parentPid = Number(await readFile(parentFile, 'utf8')), childPid = Number(await readFile(childFile, 'utf8'))
  check('shell and child are alive before close', alive(parentPid) && alive(childPid))
  await cdp.evaluate(`D.root().querySelector('.dshTerminalDock__add').click()`)
  await until(`D.active()!==${JSON.stringify(first)} && D.view()?.info?.state==='running'`)
  const second = await cdp.evaluate(`D.active()`)
  await type("Write-Output ('SECOND'+'-READY')")
  await until(`D.screen().includes('SECOND-READY')`)
  await cdp.evaluate(`D.ctx.sidebarRight.openTab('desktop-terminal')`)
  await until(`document.querySelector('.dshTerminal:not(.dshTerminalDock) [data-dsh-terminal-status=running]')`)
  await type("Write-Output ('SIDE'+'-READY')", '.dshTerminal:not(.dshTerminalDock)')
  await until(`document.querySelector('.dshTerminal:not(.dshTerminalDock) .xterm-rows')?.textContent.includes('SIDE-READY')`)
  check('dock and sidebar coexist and take keyboard control independently', (await cdp.evaluate(`D.list()`)).length === 3)
  check('sidebar keeps its header and dock has one controls row', await cdp.evaluate(`D.root().querySelectorAll('.dshTerminal__header').length===0 && document.querySelectorAll('.dshTerminal:not(.dshTerminalDock) .dshTerminal__header').length===1 && D.root().querySelectorAll('select').length===1`))
  check('status dots precede titles and normal status is only accessible text', await cdp.evaluate(`[...D.root().querySelectorAll('[role=tab]')].every(t=>t.firstElementChild.classList.contains('dshTerminal__dot') && /^终端 [0-9]+$/.test(t.textContent) && t.getAttribute('aria-label').includes('运行中'))`))
  // ── the region: the panel is the frame's bottom strip MINUS the left column ──
  const geometry = await cdp.evaluate(`(() => {
    const f=document.querySelector('[data-shell-overlay]').parentElement, d=D.root().getBoundingClientRect();
    const side=document.querySelector('[class*="_sidebarCol"]'), center=document.querySelector('[class*="_centerCol"]');
    const right=document.querySelector('[data-sidebar-right-panel]');
    return {dock:d.toJSON(),
      framePad:getComputedStyle(f).paddingBottom,
      framePadTop:getComputedStyle(f).paddingTop,
      sidebar:side?side.getBoundingClientRect().toJSON():null,
      sidebarPad:side?getComputedStyle(side).paddingBottom:null,
      center:center?center.getBoundingClientRect().toJSON():null,
      centerPad:center?getComputedStyle(center).paddingBottom:null,
      rightPanel:right?right.getBoundingClientRect().toJSON():null,
      columns:[...f.children].filter(e=>getComputedStyle(e).position==='static').map(e=>e.getBoundingClientRect().toJSON()),
      sideTab:[...document.querySelectorAll('[role=tab]')].filter(e=>!D.root().contains(e)).map(e=>({height:e.getBoundingClientRect().height,font:getComputedStyle(e).fontSize,radius:getComputedStyle(e).borderRadius}))}})()`)
  await writeFile(resolve(dir, 'geometry.json'), JSON.stringify(geometry, null, 2))
  // The panel starts where the sidebar ends — that is the whole "excludes the left
  // sidebar" claim, and it is read as one absolute comparison rather than from the
  // published variable, which would only prove the variable equals itself.
  check('dock starts at the left column\'s right edge', geometry.sidebar !== null && Math.abs(geometry.dock.left - geometry.sidebar.right) <= 1)
  check('dock reaches the window\'s right edge', Math.abs(geometry.dock.right - 1280) <= 1)
  check('the left column is NOT shortened by the dock', geometry.sidebar !== null && Math.abs(geometry.sidebar.bottom - geometry.dock.bottom) <= 1 && geometry.sidebarPad === '0px')
  check('the frame itself reserves nothing at the bottom', geometry.framePad === '0px')
  check('the center column concedes exactly the dock height', geometry.center !== null && geometry.centerPad === geometry.dock.height + 'px')
  check('chat columns end above the dock with no overlap', geometry.columns.every(r=>r.bottom <= geometry.dock.top + 1))
  await cdp.evaluate(`D.root().querySelector('[role=tab]').focus()`)
  await until(`document.querySelector('#dsh-terminal-dock-tip')`)
  check('keyboard focus exposes the complete state and start directory', await cdp.evaluate(`document.querySelector('#dsh-terminal-dock-tip').textContent.includes('启动目录')`))
  await key('Escape')
  await menu()
  await key('Escape')
  check('Escape dismisses the menu and returns focus to its trigger', await cdp.evaluate(`!document.querySelector('[role=menu]') && document.activeElement.matches('[data-dsh-terminal-more]')`))
  // The icon button beside "..." is the dock's own way out, and it comes BEFORE the
  // menu item in the row, so it is exercised as a pointer control.
  check('the collapse control sits right of the "..." menu', await cdp.evaluate(`(()=>{const m=D.root().querySelector('[data-dsh-terminal-more]'),c=D.root().querySelector('[data-dsh-terminal-collapse]');return Boolean(c)&&c.getBoundingClientRect().left>=m.getBoundingClientRect().right-1})()`))
  await cdp.evaluate(`D.root().querySelector('[data-dsh-terminal-collapse]').click()`)
  await until(`!document.querySelector('[data-dsh-terminal-dock]')`)
  check('collapse hides the panel completely and keeps all PTYs', (await cdp.evaluate(`D.list()`)).length === 3 && await cdp.evaluate(`getComputedStyle(document.querySelector('[data-shell-overlay]').parentElement).paddingBottom==='0px'`))
  check('a hidden panel reserves no space and leaves the composer at the frame bottom', await cdp.evaluate(`document.querySelector('[class*="_centerCol"]').getBoundingClientRect().bottom===innerHeight`))
  check('collapse hands focus to the header control that reopens it', await cdp.evaluate(`document.activeElement.matches('[data-dsh-terminal-dock-toggle]')`))
  // The way back in is the header's own button, and it restores the active tab.
  await cdp.evaluate(`document.querySelector('[data-dsh-terminal-dock-toggle]').click()`)
  await until(`D.root()?.querySelector('[role=tab]')`)
  check('the header control reopens the dock at its remembered height and tab', await cdp.evaluate(`D.active()===${JSON.stringify(second)} && D.root().getBoundingClientRect().height===240`))
  // Actual pointer capture drag, not a direct store write.
  const pos = await cdp.evaluate(`(()=>{const r=D.root().querySelector('[role=separator]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+2}})()`)
  await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed',...pos,button:'left',clickCount:1 })
  await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved',x:pos.x,y:pos.y-60,button:'left',buttons:1 })
  await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased',x:pos.x,y:pos.y-60,button:'left',clickCount:1 })
  check('pointer drag changes and persists height', await until(`D.store.getSnapshot().height===300 && JSON.parse(localStorage.getItem('dsh-terminal-dock')).height===300`))
  await cdp.evaluate(`D.select(${JSON.stringify(first)})`)
  await type("$global:dockCounter++; Write-Output ('COUNT='+$global:dockCounter)")
  await until(`D.screen().includes('COUNT=2')`)
  const before = await cdp.evaluate(`D.list()`)
  await cdp.send('Page.reload')
  await until('Boolean(window.__DSH_TERMINAL_SMOKE__?.dock && window.__DSH_TERMINAL_IDENTITY__)'); await init()
  check('reload starts with the bottom panel hidden', await cdp.evaluate(`D.store.getSnapshot().collapsed && !D.root()`))
  await cdp.evaluate(`D.store.open()`)
  await until(`D.tabs().length===2 && D.view()?.info?.state==='running'`)
  check('refresh retains resource keys and the native run identity', (await cdp.evaluate(`D.list()`)).every(s=>before.some(b=>b.terminalId===s.terminalId && b.runId===s.runId)))
  await type("$global:dockCounter++; Write-Output ('COUNT='+$global:dockCounter)")
  await until(`D.screen().includes('COUNT=3')`)
  check('refresh reconnects the original shell without rerunning commands', true)
  check('dock recovery excludes owned sessions from orphan list', await cdp.evaluate(`D.registry.orphans().every(s=>!D.tabs().some(t=>t.contentId===s.resourceKey))`))
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('dsh-desktop:set-ui-mode',{detail:{mode:'vanilla'}}))`)
  await until(`!document.querySelector('[data-dsh-terminal-dock]')`)
  // Read the CENTER column, not the frame: the frame never carries this padding
  // now (that is what keeps the sidebar full-height), so asserting on it would pass
  // whether or not 原版 withdrew anything.
  check('vanilla hides the panel, its header control and its reserved space', await cdp.evaluate(`getComputedStyle(document.querySelector('[class*="_centerCol"]')).paddingBottom==='0px' && !document.querySelector('[data-dsh-terminal-dock-toggle]')`))
  check('vanilla preserves both surfaces native sessions', (await cdp.evaluate(`D.list()`)).length===3)
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('dsh-desktop:set-ui-mode',{detail:{mode:'desktop'}}))`)
  await until(`D.root()?.querySelector('[role=tab]')`)
  check('returning to desktop restores height and active key', await cdp.evaluate(`D.store.getSnapshot().height===300 && D.active()===${JSON.stringify(first)}`))
  await lifecycle('enter')
  for(let i=0;i<50;i++){const s=JSON.parse(await readFile(resolve(dir,'state.json'),'utf8'));if(s.error==='snapshot-terminal-active')break;await sleep(100)}
  const gate=JSON.parse(await readFile(resolve(dir,'state.json'),'utf8'))
  check('minimal-mode destruction is blocked by a dock PTY', gate.error==='snapshot-terminal-active' && gate.windowCount===1)
  await lifecycle('show')
  await until(`document.querySelector('[data-dsh-ui-status]')`)
  check('existing bottom notices stay above the dock', await cdp.evaluate(`document.querySelector('[data-dsh-ui-status]').getBoundingClientRect().bottom<=D.root().getBoundingClientRect().top`))
  await cdp.evaluate(`document.querySelector('[data-dsh-ui-status] button')?.click()`)
  // Closing the terminal must end both the shell and its spawned process.
  await cdp.evaluate(`D.store.close(${JSON.stringify(first)})`)
  await until(`D.list().then(list=>!list.some(s=>s.resourceKey===${JSON.stringify(first)}))`)
  check('closing a dock tab ends the shell and child process tree', !alive(parentPid) && !alive(childPid))
  check('closing dock leaves sidebar and adjacent dock alive', (await cdp.evaluate(`D.list()`)).length===2)
  // Change profile without restart, then exercise the explicit restart action.
  const runBefore = await cdp.evaluate(`D.view().info.runId`)
  await cdp.evaluate(`(()=>{const el=D.root().querySelector('select');el.value='cmd';el.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  check('profile selection does not restart the running process', await cdp.evaluate(`D.view().info.runId===${JSON.stringify(runBefore)}`))
  await menu('重启')
  await until(`D.view().info?.profileId==='cmd' && D.view().info?.state==='running'`)
  await type('echo CMD-READY')
  await until(`D.screen().includes('CMD-READY')`)
  check('restart uses the current tab selected shell', true)
  const exiting = await cdp.evaluate(`D.active()`)
  await type('exit /b 7')
  // The exit code has no row of its own any more: it rides the tab's tooltip and its
  // accessible name, which is where every condition lives now.
  await until(`D.view().info?.state==='exited' && [...D.root().querySelectorAll('[role=tab]')].some(t=>t.title?.includes('已退出（7）'))`)
  check('shell exit shows its exit code without a permanent running label', true)
  await cdp.evaluate(`D.root().querySelector('.dshTerminalDock__add').click()`)
  await until(`D.view()?.info?.state==='running' && D.view().info.profileId!=='cmd'`)
  check('plus always uses the default shell', true)
  check('inactive tab retains the exited state', await cdp.evaluate(`[...D.root().querySelectorAll('[role=tab]')].find(t=>t.dataset.resourceKey===${JSON.stringify(exiting)}).getAttribute('aria-label').includes('已退出')`))
  // Register a fresh empty test directory, then remove only that empty directory.
  const missing=resolve(dir,'missing-cwd-'+Date.now());await mkdir(missing)
  await cdp.evaluate(`(async()=>{const w=await D.ctx.workspaces.create({path:${JSON.stringify(missing)}});const id=await D.ctx.sessions.create({workspaceId:w.workspaceId});D.ctx.sessions.open(id)})()`)
  await rmdir(missing)
  await cdp.evaluate(`D.root().querySelector('.dshTerminalDock__add').click()`)
  // A REAL directory failure, waited on through the tooltip: the tab's dot must have
  // gone red and its tooltip must carry the reason. This is the replacement for the
  // removed notice row, asserted on the live page rather than in a stub — the whole
  // question is whether the reason is still reachable once the row is gone.
  await until(`[...D.root().querySelectorAll('[role=tab]')].some(t=>t.dataset.dshTerminalTone==='bad' && t.title?.includes('目录'))`)
  check('a real directory failure turns its dot red and puts the reason in the tooltip', true)
  await menu('在主目录重试')
  await until(`D.view().info?.state==='running' && D.view().info.cwd!==${JSON.stringify(missing)}`)
  check('the failed terminal still recovers through 在主目录重试', true)
  // And the warning CLEARS with the condition, so a red dot cannot stick.
  await until(`[...D.root().querySelectorAll('[role=tab]')].every(t=>t.dataset.dshTerminalTone!=='bad')`)
  check('recovering clears the red dot', true)
  await cdp.evaluate(`D.store.close(D.active());const w=D.ctx.workspaces.list.getSnapshot().items.find(w=>w.path.replaceAll('\\\\','/').toLowerCase()===${JSON.stringify(cwd.toLowerCase())});D.ctx.sessions.open(w.sessionIds[0])`)
  // Native limit is shared across surfaces; keep the sidebar open while filling.
  while ((await cdp.evaluate(`D.list()`)).length < 16) {
    const count=(await cdp.evaluate(`D.list()`)).length
    await cdp.evaluate(`D.root().querySelector('.dshTerminalDock__add').click()`)
    await until(`D.list().then(s=>s.length>${count})`)
  }
  await cdp.evaluate(`D.root().querySelector('.dshTerminalDock__add').click()`)
  await until(`[...D.root().querySelectorAll('[role=tab]')].some(t=>t.dataset.dshTerminalTone==='bad' && t.title?.includes('16'))`)
  check('shared 16-session limit raises the dot and stays readable in the tooltip', await cdp.evaluate(`!D.root().querySelector('.dshTerminalDock__add').disabled`))
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:420,height:620,deviceScaleFactor:1,mobile:false})
  await sleep(250)
  check('narrow window keeps plus, shell and menu reachable', await cdp.evaluate(`['.dshTerminalDock__add','select','[data-dsh-terminal-more]'].every(q=>{const r=D.root().querySelector(q).getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth})`))
  await cdp.evaluate(`D.store.resize(120)`); await menu()
  check('menu flips upward at the viewport bottom', await cdp.evaluate(`document.querySelector('[role=menu]').getBoundingClientRect().bottom<=innerHeight`))
  await shot('dock-narrow-dark'); await key('Escape'); await until(`!document.querySelector('[role=menu]')`)
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await cdp.evaluate(`D.store.resize(300)`)
  await shot('dock-dark')
  await cdp.evaluate(`document.body.removeAttribute('data-ds-dark-theme');document.documentElement.style.colorScheme='light'`)
  await shot('dock-light')
  // Drop failed limit tab on refresh; native session count must not increase.
  const count=(await cdp.evaluate(`D.list()`)).length
  await cdp.send('Page.reload'); await until('Boolean(window.__DSH_TERMINAL_SMOKE__?.dock && window.__DSH_TERMINAL_IDENTITY__)');await init()
  await until(`!D.store.getSnapshot().restoring`)
  check('refresh discards keys without native sessions without creating shells', await cdp.evaluate(`D.tabs().length===${count-1}`) && (await cdp.evaluate(`D.list()`)).length===count)
  await cdp.evaluate(`for(const tab of [...D.tabs()].slice(2))D.store.close(tab.contentId);D.store.activate(D.tabs().at(-1).contentId)`)
  await until(`D.root().querySelector('.dshTerminal__screen')===D.view()?.element`)
  await type("Write-Output ('BOTTOM'+' TERMINAL READY')")
  await until(`D.screen().includes('BOTTOM TERMINAL READY')`)
  await shot('dock-final')
} catch (error) {
  try { await shot('dock-failure'); console.log(JSON.stringify(await cdp.evaluate(`({text:document.body.innerText.slice(-2500),active:document.activeElement?.outerHTML.slice(0,600),info:D.view()?.info,message:D.view()?.message,tabs:D.tabs().map(t=>t.contentId)})`),null,2)) } catch {}
  throw error
} finally {
  try { await cdp.send('Emulation.clearDeviceMetricsOverride'); await cdp.evaluate(`(async()=>{for(const t of [...D.tabs()])D.store.close(t.contentId);for(const s of await D.list())await D.invoke('terminal_close',D.wire(s));D.store.resize(240);D.store.collapse(false)})()`) } catch {}
  cdp.close()
  await writeFile(resolve(dir,'dock-integration.json'),JSON.stringify({checks,screenshots},null,2))
}
