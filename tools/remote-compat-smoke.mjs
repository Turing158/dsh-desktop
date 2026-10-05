/** Isolated Windows WebView2 acceptance for capability-based remote restarts.
 * Build first: cargo build --manifest-path src-tauri/Cargo.toml
 * Run: node tools/remote-compat-smoke.mjs [--packaged]
 * Creates disposable sessions and unsent attachments; makes no model calls.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, writeFile, readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { connect } from './terminal-cdp.mjs'

const root = await mkdtemp(resolve('src-tauri/target/remote-compat-'))
const home = join(root, 'dsh-home')
await mkdir(home)
const exe = join(root, 'deepseek-harness-desktop.exe')
await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'), exe)
const portable = resolve(process.env.REMOTE_PORTABLE_DIR || 'pack/remote-compat/portable')
for (const [source, destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources)) {
  const target = join(root, destination)
  await mkdir(dirname(target), { recursive: true })
  const original = resolve('src-tauri', source)
  const resource = process.argv.includes('--packaged') ? join(portable, destination) : original
  assert.equal(createHash('sha256').update(await readFile(resource)).digest('hex'), createHash('sha256').update(await readFile(original)).digest('hex'), destination)
  await copyFile(resource, target)
}
if (process.argv.includes('--packaged')) {
  const binary = await readFile(join(portable, 'deepseek-harness-desktop.exe'))
  for (const name of ['adapter.js', 'bridge.js']) assert.ok(binary.includes(await readFile(resolve('dsh-plugin/ui-state', name))), 'release embeds current ' + name)
}
let runtimeOverride = {}
if (process.env.REMOTE_COMPAT_VERSION) {
  const real = process.env.DSH_DESKTOP_DSH || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
  const wrapper = join(root, 'version-wrapper.mjs')
  await writeFile(wrapper, `import {spawn} from 'node:child_process';
const args=process.argv.slice(2);if(args.includes('--version')){console.log(${JSON.stringify(process.env.REMOTE_COMPAT_VERSION)})}
else{const child=spawn(process.execPath,[${JSON.stringify(real)},...args],{stdio:'inherit',windowsHide:true,env:{...process.env,DSH_DESKTOP_DSH_BIN:${JSON.stringify(real)}}});child.on('exit',code=>process.exit(code||0))}`)
  runtimeOverride = { DSH_DESKTOP_DSH: wrapper }
}
async function freePort(address = '127.0.0.1') {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, address, resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
const cdpPort = await freePort()
const child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
  ...process.env, ...runtimeOverride, DSH_HOME: home, DSH_DESKTOP_SMOKE_DIR: root,
  DSH_DESKTOP_DEBUG: join(root, 'host.log'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdpPort,
} })
let c
const report = { root, checks: [] }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(expression, timeout = 45000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    if (child.exitCode !== null) throw Error('Isolated desktop exited: ' + child.exitCode)
    try {
      c ||= await connect(cdpPort)
      const value = await c.evaluate(expression)
      if (value) return value
    } catch (error) { last = error; c?.close(); c = null }
    await sleep(150)
  }
  throw Error('Desktop timed out: ' + expression + ' ' + (last?.message || ''))
}
const invoke = (name, args = {}) => c.evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(name)}, {identity:window.__DSH_REMOTE_IDENTITY__,...${JSON.stringify(args)}})`)
const selected = `(()=>{const l=window.__DSH_SMOKE_CONTEXT__.sessions.list.getSnapshot();return l.current??Object.values(l.byId).find(r=>(r.retainedBy?.mainView??0)>0)?.id})()`
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }
async function ready() {
  await until("Boolean(window.__DSH_UI_BOOT__?.smoke && window.__DSH_REMOTE_IDENTITY__ && window.__DSH_SMOKE_CONTEXT__?.sessions.list.getSnapshot().phase === 'ready')")
  for (let i = 0; i < 6; i++) {
    await c.evaluate("(()=>{for(const b of document.querySelectorAll('button'))if(['稍后配置','继续'].includes(b.textContent))b.click()})()")
    await sleep(150)
  }
}
async function apply(config, useForm = false) {
  const previous = await invoke('remote_status')
  if (useForm) {
    await c.evaluate("document.querySelector('button[aria-haspopup=dialog]').click()")
    await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='远程控制')")
    await c.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='远程控制').click()")
    await until("Boolean(document.querySelector('#dsh-remote-enabled'))")
    await c.evaluate("document.querySelector('#dsh-remote-enabled').click()")
    await until("[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent==='开启')")
    await c.evaluate("[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent==='开启').click()")
    await c.evaluate("document.querySelector('#dsh-remote-address').click()")
    await until(`[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent.includes(${JSON.stringify(config.bindAddress)}))`)
    await c.evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.includes(${JSON.stringify(config.bindAddress)})).click()`)
    await c.evaluate(`(()=>{const input=document.querySelector('#dsh-remote-port');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(config.port))});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await until("[...document.querySelectorAll('.dshRemote button')].some(b=>b.textContent==='应用并重启 DSH'&&!b.disabled)")
    await c.evaluate("[...document.querySelectorAll('.dshRemote button')].find(b=>b.textContent==='应用并重启 DSH').click()")
    await until("Boolean(document.querySelector('.dshRemote [role=alertdialog]'))")
    await c.evaluate("[...document.querySelectorAll('.dshRemote button')].find(b=>b.textContent==='确认启用并重启').click()")
  } else {
    const result = await c.evaluate(`(async()=>{
    const status=await window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__});
    const payload=await window.__DSH_UI_STATE__.prepareRemoteApply(status.frontendVersion);
    try{return await window.__TAURI__.core.invoke('remote_apply',{identity:window.__DSH_REMOTE_IDENTITY__,config:${JSON.stringify(config)},payload})}
    catch(error){window.__DSH_UI_STATE__.finishRemoteApply();throw error}
  })()`)
    assert.equal(result.changed, true)
  }
  await until(`window.__DSH_REMOTE_IDENTITY__?.backendInstance > ${previous.instance}`, 65000)
  await ready()
  await until("!document.querySelector('[data-dsh-ui-status]')")
  return invoke('remote_status')
}
async function verifyDrafts(ids, expectedFiles) {
  const result = await c.evaluate(`(async()=>{
    const ctx=window.__DSH_SMOKE_CONTEXT__,ids=${JSON.stringify(ids)};
    const files=[];const drafts=[];
    for(const id of ids){
      ctx.uiWorkspace.openSession(id);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const input=ctx.conversation.input.for(ctx.sessions.scope(id));drafts.push(input.state.getSnapshot().draft);
      files.push(await Promise.all(ctx.conversation.resolveDraftAttachments(input.state.getSnapshot().attachmentIds).map(async a=>({name:a.file.name,text:await a.file.text()}))));
    }
    ctx.uiWorkspace.openSession(ids[0]);return {drafts,files};
  })()`)
  assert.deepEqual(result.drafts, ['remote compatibility draft 0\nline two', 'remote compatibility draft 1\nline two'])
  assert.deepEqual(result.files, expectedFiles)
}
async function verifyTerminals(expected) {
  const items = await c.evaluate("window.__TAURI__.core.invoke('terminal_list',{identity:window.__DSH_TERMINAL_IDENTITY__})")
  assert.deepEqual(items.map(({ terminalId, runId, resourceKey }) => ({ terminalId, runId, resourceKey })), expected)
  assert.ok(items.every(item => item.state === 'running'))
}
try {
  await ready()
  report.version = (await invoke('remote_status')).frontendVersion
  if (process.env.REMOTE_COMPAT_VERSION) assert.equal(report.version, process.env.REMOTE_COMPAT_VERSION)
  await c.evaluate(`(async()=>{
    const ctx=window.__DSH_SMOKE_CONTEXT__,w=await ctx.workspaces.create({path:${JSON.stringify(root)}});
    window.__REMOTE_COMPAT_IDS__=[];window.__REMOTE_COMPAT_REFS__=[];
    for(let i=0;i<2;i++){
      const id=await ctx.sessions.create({workspaceId:w.workspaceId});window.__REMOTE_COMPAT_IDS__.push(id);
      if(ctx.sessions.retain)window.__REMOTE_COMPAT_REFS__.push(ctx.sessions.retain(id,{source:'remoteCompatSmoke'}));
      ctx.uiWorkspace.openSession(id);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const input=ctx.conversation.input.for(ctx.sessions.scope(id));input.setDraft('remote compatibility draft '+i+'\\nline two');
      const assets=ctx.conversation.createDrafts(id,[new File(['attachment '+i],'remote-'+i+'.txt',{type:'text/plain'})]);input.addAttachments(assets.map(a=>a.id));
    }
    ctx.uiWorkspace.openSession(window.__REMOTE_COMPAT_IDS__[0]);
  })()`)
  const ids = await c.evaluate('window.__REMOTE_COMPAT_IDS__')
  await until(`(()=>{const ctx=window.__DSH_SMOKE_CONTEXT__;return ${JSON.stringify(ids)}.every(id=>ctx.conversation.input.for(ctx.sessions.scope(id)).state.getSnapshot().attachmentIds.every(a=>ctx.conversation.fileUploads.getSnapshot()[a]?.status==='ready'))})()`)
  const expectedFiles = ids.map((_, i) => [{ name: 'remote-' + i + '.txt', text: 'attachment ' + i }])
  assert.equal(await c.evaluate(selected), ids[0])
  pass('real DSH boot and two unsent drafts with uploaded attachments')
  await until('Boolean(window.__DSH_TERMINAL_SMOKE__)')
  await c.evaluate('window.__DSH_TERMINAL_SMOKE__.dock.open()')
  await until("window.__TAURI__.core.invoke('terminal_list',{identity:window.__DSH_TERMINAL_IDENTITY__}).then(items=>items.length===1&&items[0].state==='running')")
  const terminals = (await c.evaluate("window.__TAURI__.core.invoke('terminal_list',{identity:window.__DSH_TERMINAL_IDENTITY__})")).map(({ terminalId, runId, resourceKey }) => ({ terminalId, runId, resourceKey }))
  const addresses = await invoke('remote_lan_addresses')
  assert.ok(addresses.length)
  const address = addresses.find(a => /WLAN|Wi-Fi|Ethernet|以太网/.test(a.name)) || addresses[0]
  const port = await freePort(address.address)
  const config = { version: 1, enabled: true, bindAddress: address.address, port, trustedHosts: [] }
  const previousOrigin = await c.evaluate('location.origin')
  let status = await apply(config, true)
  assert.equal(status.state, 'lan')
  assert.notEqual(await c.evaluate('location.origin'), previousOrigin)
  assert.equal(await c.evaluate(selected), ids[0])
  await verifyDrafts(ids, expectedFiles)
  await verifyTerminals(terminals)
  pass('enable LAN with selection, multiple drafts and attachment bytes restored across origins')
  const info = await invoke('remote_connection_info')
  const login = await fetch(info.url, { redirect: 'manual' })
  assert.equal(login.status, 303)
  const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ')
  assert.equal((await fetch(new URL('/api/nonexistent', status.address))).status, 401)
  const page = await fetch(status.address, { headers: { Cookie: cookie } })
  assert.equal(page.status, 200)
  assert.ok((await page.text()).includes('dshRemote'))
  pass('LAN listener keeps upstream authentication and serves the shared frontend')
  status = await apply({ ...config, enabled: false })
  assert.equal(status.state, 'disabled')
  assert.equal(await c.evaluate(selected), ids[0])
  await verifyDrafts(ids, expectedFiles)
  await verifyTerminals(terminals)
  pass('disable LAN and preserve drafts and attachments through a second restart')
  pass('both remote restarts keep the same running native terminal process')
  const refused = await c.evaluate(`(async()=>{
    const ctx=window.__DSH_SMOKE_CONTEXT__,original=ctx.conversation.createDrafts;ctx.conversation.createDrafts=undefined;
    try{await window.__DSH_UI_STATE__.prepareRemoteApply(${JSON.stringify(report.version)});return null}
    catch(error){return error.message}finally{ctx.conversation.createDrafts=original}
  })()`)
  assert.match(refused, /接口/)
  assert.equal(await c.evaluate("Boolean(document.querySelector('[data-dsh-ui-status]'))"), false)
  pass('missing required capability refuses restart and unfreezes the page')
} catch (error) {
  report.error = error.stack
  if (c) try { report.page = await c.evaluate('document.body.innerText.slice(0, 5000)') } catch {}
  throw error
} finally {
  c?.close()
  if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Evidence: ' + join(root, 'report.json'))
}
