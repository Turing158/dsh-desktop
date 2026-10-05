/** Sidebar motion and Session ZIP regression checks in an isolated WebView2.
 * Build with a separate identifier so a running user app is left alone:
 * $env:TAURI_CONFIG='{"identifier":"com.deepseek.harness.desktop.sidebar-export-test"}'
 * cargo rustc --manifest-path src-tauri/Cargo.toml --bin deepseek-harness-desktop -- -o <absolute path>/src-tauri/target/debug/sidebar-export-smoke.exe
 * Remove-Item Env:\TAURI_CONFIG
 * Run: node tools/sidebar-export-smoke.mjs [--export-only]
 * The native folder picker is interactive: cancel/select the folder printed for each step.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, writeFile, readFile, readdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createServer } from 'node:net'
import { connect } from './terminal-cdp.mjs'

const root = await mkdtemp(resolve('src-tauri/target/sidebar-export-'))
const home = join(root, 'dsh-home')
const exportFolders = [join(root, '日志 A'), join(root, '日志 B')]
for (const folder of exportFolders) await mkdir(folder)
await mkdir(home)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: off\n  ui: desktop\n  titlebar: simple\n  titlebarHover: off\ndesktop-terminal-dock:\n  profileId: cmd\n  position: bottom\n  layout: { height: 312, collapsed: true }\n')
const exe = join(root, 'deepseek-harness-desktop.exe')
await copyFile(resolve('src-tauri/target/debug/sidebar-export-smoke.exe'), exe)
for (const [source, destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources)) {
  const target = join(root, destination)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(process.argv.includes('--packaged') ? resolve('pack/portable', destination) : resolve('src-tauri', source), target)
}
const reserve = createServer()
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
  ...process.env, DSH_HOME: home, DSH_DESKTOP_SMOKE_DIR: root,
  DSH_DESKTOP_DEBUG: join(root, 'host.log'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
} })
let c
const report = { root, checks: [] }
console.log(JSON.stringify({ root, port, pid: child.pid, exportFolders }))
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
    } catch (error) { last = error; c?.close(); c = null }
    await sleep(150)
  }
  throw Error('Desktop timed out: ' + expression + ' ' + (last?.message || ''))
}
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }

const liveMenu = '[role="menu"]:not([data-dsh-ghost])'
async function click(selector, right = false) {
  const p = await c.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.send('Input.dispatchMouseEvent', { type:'mouseMoved', ...p })
  await c.send('Input.dispatchMouseEvent', { type:'mousePressed', ...p, button:right?'right':'left', clickCount:1 })
  await c.send('Input.dispatchMouseEvent', { type:'mouseReleased', ...p, button:right?'right':'left', clickCount:1 })
}
async function shot(name) {
  const {data}=await c.send('Page.captureScreenshot', {format:'png'})
  await writeFile(join(root,name+'.png'),Buffer.from(data,'base64'))
}

const panel = '[data-sidebar-right-panel] [data-dockkit-host="dock"]'
const frame = '[class*="_frame"][data-sidebar-collapsed], [class*="_frame"]:has(> [data-shell-overlay])'
const measure = `(()=>{const n=document.querySelector('${panel}'),s=getComputedStyle(n),f=document.querySelector('${frame}');return {x:n.getBoundingClientRect().x,visibility:s.visibility,animations:n.getAnimations().map(a=>a.transitionProperty),frameTransition:getComputedStyle(f).transitionDuration}})()`
async function toggle(open) {
  await c.evaluate(`document.querySelector('[aria-label="${open ? '打开' : '收起'}右侧边栏"]').click()`)
  await c.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
}
try {
  await until('Boolean(window.__DSH_SMOKE_CONTEXT__)')
  const id = await c.evaluate(`(async()=>{const ctx=window.__DSH_SMOKE_CONTEXT__;const w=await ctx.workspaces.create({path:${JSON.stringify(root)}});const id=await ctx.sessions.create({workspaceId:w.workspaceId});await ctx.uiWorkspace.openSession(id);return id})()`)
  for (let i=0;i<3;i++) {
    await c.evaluate("(()=>{for(const b of document.querySelectorAll('button'))if(['继续','稍后配置'].includes(b.textContent.trim()))b.click()})()")
    await sleep(120)
  }
  if (!process.argv.includes('--export-only')) {
  await until("Boolean(document.querySelector('[aria-label=\"打开右侧边栏\"]'))")
  await toggle(true)
  await until(`Boolean(document.querySelector('${panel}'))`)
  await sleep(400); await toggle(false); await sleep(400)
  for (const dark of [false,true]) {
    await c.evaluate(`document.body.toggleAttribute('data-ds-dark-theme',${dark})`)
    const borders = await c.evaluate("({title:getComputedStyle(document.querySelector('.dshTb')).borderBottomWidth,sidebar:getComputedStyle(document.querySelector('[class*=\"_sidebarCol\"]')).borderRightWidth})")
    assert.equal(borders.title,'0px'); assert.equal(borders.sidebar,'0px')
    await shot(dark?'dark':'light')
  }
  pass('title bar and left sidebar dividers are absent in both themes')
  report.motion=[]
  for (const reduced of [true,false]) {
    await c.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]})
    for (const preference of ['on','off','system']) {
      await c.evaluate(`document.documentElement.setAttribute('data-dsh-desktop-animation','${preference}')`)
      const animated = preference==='on'||preference==='system'&&!reduced
      await toggle(true)
      const opening=await c.evaluate(measure)
      assert.equal(opening.animations.includes('transform'),animated,`${preference}/${reduced} opening`)
      await sleep(400)
      const opened=await c.evaluate(measure)
      await toggle(false)
      const closing=await c.evaluate(measure)
      assert.equal(closing.animations.includes('transform'),animated,`${preference}/${reduced} closing`)
      if(animated) {
        await sleep(80)
        const middle=await c.evaluate(measure)
        assert.equal(middle.visibility,'visible')
        assert.ok(middle.x>opened.x&&middle.x<1280)
      } else assert.equal(closing.frameTransition,'0s')
      await sleep(400)
      const closed=await c.evaluate(measure)
      assert.equal(closed.visibility,'hidden')
      report.motion.push({reduced,preference,opening,closing,closed})
    }
  }
  pass('open and close follow on/off/system with and without OS reduced motion')
  await c.evaluate("document.documentElement.setAttribute('data-dsh-desktop-animation','on')")
  await toggle(true); await sleep(400)
  await c.evaluate("document.querySelector('[aria-label=\"全屏\"]').click()")
  await sleep(400); await toggle(false)
  assert.ok((await c.evaluate(measure)).animations.includes('transform'))
  await sleep(400); await toggle(true); await sleep(400)
  // Reverse the transition mid-flight; the same mounted pane must remain usable.
  await toggle(false); await sleep(50); await toggle(true); await sleep(400)
  assert.equal((await c.evaluate(measure)).visibility,'visible')
  await toggle(false); await sleep(400)
  pass('fullscreen close and rapid close/reopen preserve the panel')
  }

  // A local submission echo mounts the real conversation header without sending
  // a prompt or making a model request. Empty welcome views have no export modal.
  await c.evaluate(`window.__exportEcho=window.__DSH_SMOKE_CONTEXT__.sessions.binding(${JSON.stringify(id)}).session.beginSubmission({mode:'queue',text:'Session 日志导出验证',attachments:[]})`)
  await until("Boolean(document.querySelector('[aria-label=\"更多操作\"]'))")
  await sleep(500)
  await c.evaluate("(()=>{for(const b of document.querySelectorAll('button'))if(b.textContent.trim()==='稍后配置')b.click()})()")
  await sleep(200)

  await c.evaluate("window.__exportEvents=[];window.addEventListener('dsh-desktop:session-export',e=>__exportEvents.push(e.detail))")
  report.downloads=[]
  // Use actual input on the upstream menu, including WebView2's download gesture.
  for (const [index, mode] of ['desktop','desktop','desktop','vanilla'].entries()) {
    await c.evaluate(`document.documentElement.setAttribute('data-dsh-ui','${mode}')`)
    // This is the upstream controller used by the header menu and /export.
    await click('[aria-label="更多操作"]')
    await until(`[...document.querySelectorAll('${liveMenu} [role=menuitem]')].some(n=>n.textContent.includes('下载 Session 日志'))`)
    await c.evaluate(`[...document.querySelectorAll('${liveMenu} [role=menuitem]')].find(n=>n.textContent.includes('下载 Session 日志')).id='export-smoke-action'`)
    await click('#export-smoke-action')
    const folder = exportFolders[index === 3 ? 1 : 0]
    console.log(index === 0 ? 'PICKER: cancel this export' : 'PICKER: save to ' + folder)
    await until(`window.__DSH_SMOKE_CONTEXT__.get('sessionLogDownload').store.getSnapshot().bySession[${JSON.stringify(id)}]?.status !== 'downloading'`, 180000)
    const result=await c.evaluate(`(()=>{const ctrl=window.__DSH_SMOKE_CONTEXT__.get('sessionLogDownload');return {state:ctrl.store.getSnapshot().bySession[${JSON.stringify(id)}],event:window.__exportEvents.at(-1),dialogs:[...document.querySelectorAll('[role=dialog]')].map(n=>n.textContent)}})()`)
    report.lastExport=result
    if (index === 0) {
      assert.equal(result.state.status, 'idle')
      assert.equal(result.state.open, false)
      assert.equal(result.event, undefined)
      assert.deepEqual(await readdir(folder), [])
      pass('cancel closes the native picker without starting a download')
      continue
    }
    assert.equal(result.state.status,'success')
    assert.equal(result.state.open,mode==='vanilla')
    assert.equal(result.event.status,'success')
    assert.equal(dirname(result.event.path), folder)
    const bytes=await readFile(result.event.path)
    assert.equal(bytes.readUInt32LE(0),0x04034b50)
    assert.ok(bytes.length>100)
    report.downloads.push({mode,path:result.event.path,bytes:bytes.length})
    if(mode==='vanilla') {
      await until("[...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('Session 导出已开始下载'))")
      await shot('vanilla-download')
      const borders=await c.evaluate("({title:getComputedStyle(document.querySelector('.dshTb')).borderBottomWidth,sidebar:getComputedStyle(document.querySelector('[class*=\"_sidebarCol\"]')).borderRightWidth})")
      assert.notEqual(borders.title,'0px');assert.notEqual(borders.sidebar,'0px')
      await c.evaluate(`window.__DSH_SMOKE_CONTEXT__.get('sessionLogDownload').dismiss(${JSON.stringify(id)})`)
    } else {
      assert.ok(!result.dialogs.some(text=>text.includes('Session 导出')))
      assert.equal(await c.evaluate("document.querySelectorAll('[data-dsh-toast-key=\"session-export\"]').length"),1)
      await shot('desktop-download')
    }
  }
  assert.equal(new Set(report.downloads.map(item=>item.path)).size,3)
  for (const item of report.downloads) assert.equal((await readFile(item.path)).length,item.bytes)
  pass('real ZIPs save without overwrite; desktop has a toast and vanilla keeps its modal')
  await c.evaluate("document.documentElement.setAttribute('data-dsh-ui','desktop')")
  await c.evaluate("void window.__DSH_SMOKE_CONTEXT__.get('sessionLogDownload').download('session-not-found')")
  console.log('PICKER: save to ' + exportFolders[1] + ' to verify the HTTP error')
  await until("window.__DSH_SMOKE_CONTEXT__.get('sessionLogDownload').store.getSnapshot().bySession['session-not-found']?.status === 'error'", 180000)
  const failure=await c.evaluate("window.__DSH_SMOKE_CONTEXT__.get('sessionLogDownload').store.getSnapshot().bySession['session-not-found']")
  assert.equal(failure.status,'error');assert.equal(failure.open,false)
  await until("[...document.querySelectorAll('[data-dsh-desktop=toast]')].some(n=>n.textContent.includes('404'))")
  pass('missing Session returns an actionable failure rather than success')
} catch(error) {
  report.error=error.stack
  if(c) try { report.page=await c.evaluate('document.body.innerText.slice(0,4000)');await shot('failure') } catch{}
  throw error
} finally {
  c?.close()
  if(child.exitCode===null) execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  console.log('Evidence: '+join(root,'report.json'))
}
