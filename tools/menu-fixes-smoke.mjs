/** Menu regression checks in an isolated real WebView2 and DSH profile.
 * Build the debug host first: cargo build --manifest-path src-tauri/Cargo.toml
 * Run: node tools/menu-fixes-smoke.mjs [--packaged]
 * --packaged tests resources collected by pack.ps1 with the debug smoke bridge.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, writeFile, readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createServer } from 'node:net'
import { connect } from './terminal-cdp.mjs'

const root = await mkdtemp(resolve('src-tauri/target/menu-fixes-'))
const home = join(root, 'dsh-home')
await mkdir(home)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: off\n  ui: desktop\n  titlebar: simple\n  titlebarHover: off\ndesktop-terminal-dock:\n  profileId: cmd\n  position: bottom\n  layout: { height: 312, collapsed: true }\n')
const exe = join(root, 'deepseek-harness-desktop.exe')
await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'), exe)
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
let clipboardBefore
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
    } catch (error) { last = error; c?.close(); c = null }
    await sleep(150)
  }
  throw Error('Desktop timed out: ' + expression + ' ' + (last?.message || ''))
}
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }

const liveMenu = '[role="menu"]:not([data-dsh-ghost])'
async function escape() {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
async function click(selector, right = false) {
  const p = await c.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.send('Input.dispatchMouseEvent', { type:'mouseMoved', ...p })
  await c.send('Input.dispatchMouseEvent', { type:'mousePressed', ...p, button:right?'right':'left', clickCount:1 })
  await c.send('Input.dispatchMouseEvent', { type:'mouseReleased', ...p, button:right?'right':'left', clickCount:1 })
}
async function bar(label) {
  await c.evaluate(`(()=>{const b=[...document.querySelectorAll('.dshTb__item')].find(b=>b.textContent===${JSON.stringify(label)});if(b.getAttribute('aria-expanded')!=='true')b.click()})()`)
  await until(`!!document.querySelector('${liveMenu}')`)
}
async function shot(name) {
  const {data}=await c.send('Page.captureScreenshot', {format:'png'})
  await writeFile(join(root,name+'.png'),Buffer.from(data,'base64'))
}
try {
  await until('Boolean(window.__DSH_UI_BOOT__?.smoke && window.__DSH_SMOKE_CONTEXT__ && window.__DSH_TERMINAL_SMOKE__)')
  clipboardBefore = await c.evaluate("window.__TAURI__.core.invoke('clipboard_read_text')")
  await until("window.__DSH_TERMINAL_SMOKE__.ctx.configForms.get('desktop-appearance').getSnapshot().status === 'ready'")
  await c.evaluate("(()=>{for(const b of document.querySelectorAll('button'))if(['稍后配置','继续'].includes(b.textContent))b.click()})()")
  assert.deepEqual(await c.evaluate("[...document.querySelectorAll('.dshTb__item')].map(b=>b.textContent)"), ['编辑','会话','项目','更多'])
  assert.equal(await c.evaluate("document.documentElement.getAttribute('data-dsh-titlebar-hover')"), 'on')
  await bar('更多')
  const labels=await c.evaluate(`[...document.querySelectorAll('${liveMenu} [role="menuitem"]')].map(n=>n.textContent)`)
  assert.ok(!labels.some(l=>/简易标题栏|关闭图标悬停/.test(l)))
  await escape()
  pass('old saved simple/off preferences cannot hide title-bar controls; removed More entries stay absent')
  const id = await c.evaluate(`(async()=>{const ctx=window.__DSH_SMOKE_CONTEXT__;const w=await ctx.workspaces.create({path:${JSON.stringify(root)}});const id=await ctx.sessions.create({workspaceId:w.workspaceId});await ctx.uiWorkspace.openSession(id);return id})()`)
  await until(`Boolean(window.__DSH_SMOKE_CONTEXT__.sessions.list.getSnapshot().byId[${JSON.stringify(id)}]?.retainedBy?.mainView)`)
  await sleep(200)
  await c.evaluate("(()=>{for(const b of document.querySelectorAll('button'))if(['稍后配置','继续'].includes(b.textContent.trim()))b.click()})()")
  await bar('会话')
  const actions=await c.evaluate(`[...document.querySelectorAll('${liveMenu} [role="menuitem"]')].slice(0,4).map(n=>({label:n.textContent,disabled:n.disabled,height:n.getBoundingClientRect().height}))`)
  assert.equal(actions.length,4)
  assert.ok(actions.every(a=>!a.disabled),JSON.stringify(actions))
  assert.ok(actions.every(a=>a.height===28),JSON.stringify(actions))
  pass('existing DSH 0.2 session enables all four actions with 28px menu rows')
  await until(`Boolean(document.querySelector('${liveMenu} [aria-haspopup="menu"]:not(:disabled)'))`)
  const parent=`${liveMenu} [aria-haspopup="menu"]`
  assert.notEqual(await c.evaluate(`getComputedStyle(document.querySelector('${parent}'),'::after').clipPath`),'none')
  const p=await c.evaluate(`(()=>{const r=document.querySelector('${parent}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p})
  await until(`!!document.querySelector('[role="menu"] [data-dsh-desktop="nested-menu"]')`)
  const sub=await c.evaluate(`(()=>{const r=document.querySelector('[role="menu"] [role="menu"]').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`)
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:sub.x-2,y:p.y})
  await sleep(550)
  assert.equal(await c.evaluate(`!!document.querySelector('[role="menu"] [role="menu"]')`),true,'submenu survives pause in gap')
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:sub.x+20,y:sub.y+15})
  await sleep(180)
  assert.equal(await c.evaluate(`!!document.querySelector('[role="menu"] [role="menu"]')`),true,'submenu stays open under pointer')
  await shot('session-menu')
  pass('submenu triangle is visible and real pointer movement through the gap keeps the submenu open')
  await escape()
  await bar('会话')
  await c.evaluate(`[...document.querySelectorAll('${liveMenu} [role="menuitem"]')].find(n=>n.textContent==='复制...').click()`)
  await until(`[...document.querySelectorAll('${liveMenu} [role="menuitem"]')].some(n=>n.textContent==='复制深度链接')`)
  await c.evaluate(`[...document.querySelectorAll('${liveMenu} [role="menuitem"]')].find(n=>n.textContent==='复制深度链接').click()`)
  assert.equal(await c.evaluate("window.__TAURI__.core.invoke('clipboard_read_text')"),'deepseekharness://session/'+id)
  pass('session action copies the selected session id')
  await bar('会话')
  await c.evaluate(`[...document.querySelectorAll('${liveMenu} [role="menuitem"]')].find(n=>n.textContent==='重命名').click()`)
  await until("!!document.querySelector('[role=dialog] input')")
  await c.evaluate("document.querySelector('[role=dialog] input').focus();document.querySelector('[role=dialog] input').select()")
  await c.send('Input.insertText',{text:'菜单测试会话'})
  await c.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='确定').click()")
  await until(`window.__DSH_SMOKE_CONTEXT__.sessions.list.getSnapshot().byId[${JSON.stringify(id)}]?.title === '菜单测试会话'`)
  pass('title-bar rename writes to the selected session')
  // Capture a real upstream shortcut and its rendered key geometry.
  await bar('编辑')
  await sleep(200)
  report.shortcut=await c.evaluate(`[...document.querySelectorAll('${liveMenu} kbd')].map(n=>({text:n.textContent,height:n.getBoundingClientRect().height,bg:getComputedStyle(n).backgroundColor,margin:getComputedStyle(n).margin}))`)
  assert.ok(report.shortcut.some(k=>k.text==='+'),'upstream shortcut is exercised')
  assert.ok(report.shortcut.every(k=>k.height>1&&k.margin==='0px'),JSON.stringify(report.shortcut))
  await shot('shortcut-menu')
  await escape()
  pass('upstream shortcut plus signs render as text, not menu dividers')
  await c.evaluate(`(()=>{const region=document.querySelector('[data-conversation-region="chat"]');const p=document.createElement('p');p.id='dsh-menu-test-text';p.textContent='会话文本复制测试';region.prepend(p);const range=document.createRange();range.selectNodeContents(p);const s=getSelection();s.removeAllRanges();s.addRange(range)})()`)
  await click('#dsh-menu-test-text',true)
  await until("!!document.querySelector('.dshTextMenu')")
  assert.equal(await c.evaluate("!!document.querySelector('.dshTextMenu button:focus')"),false)
  assert.deepEqual(await c.evaluate("[...document.querySelectorAll('.dshTextMenu button')].map(b=>({label:b.firstChild.textContent,disabled:b.disabled}))"),[
    {label:'剪切',disabled:true},{label:'复制',disabled:false},{label:'粘贴',disabled:true},{label:'全选',disabled:false}])
  await shot('text-menu')
  await click('.dshTextMenu button:nth-child(2)')
  await until("!document.querySelector('.dshTextMenu')")
  assert.equal(await c.evaluate("window.__TAURI__.core.invoke('clipboard_read_text')"),'会话文本复制测试')
  await c.evaluate("document.querySelector('#dsh-menu-test-text').remove()")
  pass('transcript context menu preserves the selection and copies it through the native clipboard')
  // CDP mouse events do not activate the OS window; native edit chords require it.
  await writeFile(join(root,'command.json'),JSON.stringify({sequence:1,action:'show'}))
  await sleep(250)
  await c.send('Page.bringToFront')
  const editor='[contenteditable="true"]'
  await click(editor)
  await c.send('Input.insertText',{text:'alpha beta'})
  await until(`document.querySelector('${editor}').innerText.trim() === 'alpha beta'`)
  await c.evaluate(`(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector('${editor}'));const s=getSelection();s.removeAllRanges();s.addRange(r)})()`)
  await click(editor,true)
  await until("!!document.querySelector('.dshTextMenu')")
  assert.equal(await c.evaluate("document.querySelector('.dshTextMenu button').disabled"),false)
  await click('.dshTextMenu button:nth-child(1)')
  await until(`document.querySelector('${editor}').innerText.trim() === ''`)
  assert.equal(await c.evaluate("window.__TAURI__.core.invoke('clipboard_read_text')"),'alpha beta')
  await click(editor,true)
  await click('.dshTextMenu button:nth-child(3)')
  await until(`document.querySelector('${editor}').innerText.trim() === 'alpha beta'`)
  pass('native Cut and Paste edit the real controlled composer after restoring its selection')
  await click(editor,true)
  for(const [key,code,windowsVirtualKeyCode] of [['End','End',35],['Enter','Enter',13]]) {
    await c.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode})
    await c.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode})
  }
  assert.equal(await c.evaluate("String(getSelection()).trim()"),'alpha beta')
  pass('keyboard navigation activates Select All within the composer')
  await bar('更多')
  await c.evaluate(`[...document.querySelectorAll('${liveMenu} [role="menuitem"]')].find(n=>n.textContent==='设置').click()`)
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='外观')")
  await c.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='外观').click()")
  await until("!!document.querySelector('.dshAppearance')")
  assert.equal(await c.evaluate("document.querySelector('.dshAppearance').textContent.includes('标题栏')"),false)
  await shot('appearance-dark')
  await c.evaluate("[...document.querySelectorAll('.dshAppearance button')].find(b=>b.textContent.trim()==='浅色').click()")
  await until("!document.body.hasAttribute('data-ds-dark-theme')")
  await shot('appearance-light')
  await escape()
  await bar('编辑')
  await shot('shortcut-menu-light')
  await escape()
  pass('Appearance exposes only theme, font size and animation; menus render in both themes')
  await shot('complete')
} catch(error) {
  report.error=error.stack
  if(c) {
    try { report.page=await c.evaluate('document.body.innerText.slice(0,8000)'); await shot('failure') } catch{}
  }
  throw error
} finally {
  if(c && clipboardBefore !== undefined) try {
    await c.evaluate(`window.__TAURI__.core.invoke('clipboard_write_text',{text:${JSON.stringify(clipboardBefore)}})`)
  } catch {}
  c?.close()
  if(child.exitCode===null) execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  console.log('Evidence: '+join(root,'report.json'))
}

