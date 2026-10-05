/** Run against an isolated debug host on CDP_PORT (default 9357).
 * DSH_HOME and DSH_DESKTOP_SMOKE_DIR must point to target/remote-control-live.
 * No model calls. Credentials remain in memory and are excluded from evidence.
 */
import { connect } from './terminal-cdp.mjs'
import { writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { request, createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'

const dir = resolve(process.env.REMOTE_SMOKE_DIR || 'src-tauri/target/remote-control-live')
const c = await connect(Number(process.env.CDP_PORT || 9357)), checks = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
const call = (name, args = {}) => c.evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(name)}, {identity:window.__DSH_REMOTE_IDENTITY__,...${JSON.stringify(args)}})`)
const check = (name, detail = true) => { checks.push({name,detail}); console.log('PASS '+name) }
async function until(expression, timeout = 30000) {
  const end = Date.now()+timeout
  while(Date.now()<end) { try { const result = await c.evaluate(expression); if(result) return result } catch {} await sleep(100) }
  throw Error('Timed out waiting for '+expression.slice(0,120))
}
async function ready() {
  await until(`Boolean(window.__DSH_REMOTE_IDENTITY__ && window.__DSH_SMOKE_CONTEXT__ && window.__DSH_SMOKE_CONTEXT__.sessions.list.getSnapshot().phase === 'ready')`, 60000)
  for (let i=0;i<15;i++) {
    await c.evaluate(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='稍后配置')?.click();const beta=[...document.querySelectorAll('[role=dialog]')].find(d=>d.textContent.includes('内测声明'));[...beta?.querySelectorAll('button')||[]].find(b=>b.textContent==='继续')?.click()})()`)
    await sleep(150)
  }
}
async function settings() {
  await c.evaluate(`(()=>{if(![...document.querySelectorAll('button')].some(b=>b.textContent==='远程控制'))document.querySelector('button[aria-haspopup=dialog]').click()})()`)
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent==='远程控制')`)
  await c.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='远程控制').click()`)
  await until(`Boolean(document.querySelector('#dsh-remote-port'))`)
}
async function apply(config, useForm = false) {
  await settings()
  const old = (await call('remote_status')).instance
  if (useForm) {
    await c.evaluate(`(()=>{const root=document.querySelector('.dshRemote');const checkbox=root.querySelector('input[type=checkbox]');if(checkbox.checked!==${config.enabled})checkbox.click();const port=root.querySelector('#dsh-remote-port');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(port,${JSON.stringify(String(config.port))});port.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await c.evaluate(`(()=>{const pill=document.querySelector('#dsh-remote-address');if(pill.getAttribute('aria-expanded')!=='true')pill.click()})()`)
    await until(`[...document.querySelectorAll('[role=menuitem]')].some(m=>m.textContent.includes(${JSON.stringify(config.bindAddress)}))`)
    await c.evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(m=>m.textContent.includes(${JSON.stringify(config.bindAddress)})).click()`)
    for (const host of config.trustedHosts) {
      await c.evaluate(`[...document.querySelectorAll('.dshRemote button')].find(b=>b.textContent==='添加 Host').click()`)
      await sleep(100)
      await c.evaluate(`(()=>{const input=[...document.querySelectorAll('.dshRemote input[aria-label^="额外 Host"]')].at(-1);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(host)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    }
    await until(`[...document.querySelectorAll('.dshRemote button')].some(b=>b.textContent==='应用并重启 DSH'&&!b.disabled)`)
    await c.evaluate(`[...document.querySelectorAll('.dshRemote button')].find(b=>b.textContent==='应用并重启 DSH').click()`)
    await until(`Boolean(document.querySelector('[role=alertdialog][aria-label="启用远程控制"]'))`)
    await c.evaluate(`[...document.querySelectorAll('.dshRemote button')].find(b=>b.textContent==='确认启用并重启').click()`)
  } else {
    const result = await c.evaluate(`(async()=>{const s=await window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__});const payload=await window.__DSH_UI_STATE__.prepareRemoteApply(s.frontendVersion);try{return await window.__TAURI__.core.invoke('remote_apply',{identity:window.__DSH_REMOTE_IDENTITY__,config:${JSON.stringify(config)},payload})}catch(e){window.__DSH_UI_STATE__.finishRemoteApply();throw e}})()`)
    assert.equal(result.changed,true)
  }
  await until(`window.__DSH_REMOTE_IDENTITY__?.backendInstance > ${old}`, 65000)
  await ready()
  await until(`!document.querySelector('[data-dsh-ui-status]')`, 30000)
  return call('remote_status')
}
async function http(url, headers = {}, method='GET', body) {
  return new Promise((resolve,reject)=>{const req=request(url,{headers,method},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()}))});req.on('error',reject);req.setTimeout(6000,()=>req.destroy(Error('HTTP timeout')));req.end(body)})
}
try {
  await ready()
  let initial = await call('remote_status')
  if(initial.state !== 'disabled') initial = await apply({...initial.saved,enabled:false})
  assert.equal(initial.state,'disabled'); assert.equal(initial.address,null); check('default loopback mode')
  const addresses = await call('remote_lan_addresses'); assert.ok(addresses.length)
  const address = addresses.find(a=>/WLAN|Wi-Fi|以太网|Ethernet/i.test(a.name)) || addresses[0]
  const config = {version:1,enabled:true,bindAddress:address.address,port:13080,trustedHosts:['desktop.local:13080']}
  // Create only a disposable empty session and unsent draft, no provider keys.
  await c.evaluate(`(async()=>{const c=window.__DSH_SMOKE_CONTEXT__;const w=await c.workspaces.create({path:${JSON.stringify(dir)}});await c.uiWorkspace.openWorkspace(w.workspaceId)})()`)
  const id = await until(`window.__DSH_SMOKE_CONTEXT__.sessions.list.getSnapshot().current`)
  await until(`Boolean(window.__DSH_SMOKE_CONTEXT__.conversation.input.for(window.__DSH_SMOKE_CONTEXT__.sessions.scope(${JSON.stringify(id)})))`)
  await c.evaluate(`(()=>{const c=window.__DSH_SMOKE_CONTEXT__;const input=c.conversation.input.for(c.sessions.scope(${JSON.stringify(id)}));input.setDraft('remote restart draft — 未发送');const attachments=c.conversation.createDrafts(${JSON.stringify(id)},[new File(['remote draft attachment — 未发送'],'remote-smoke.txt',{type:'text/plain'})]);input.addAttachments(attachments.map(a=>a.id))})()`)
  await until(`(()=>{const c=window.__DSH_SMOKE_CONTEXT__;const ids=c.conversation.input.for(c.sessions.scope(${JSON.stringify(id)})).state.getSnapshot().attachmentIds;return ids.length===1&&ids.every(id=>c.conversation.fileUploads.getSnapshot()[id]?.status==='ready')})()`)
  await sleep(250)
  const oldIdentity = await c.evaluate('window.__DSH_REMOTE_IDENTITY__')
  const oldOrigin = await c.evaluate('location.origin')
  let status = await apply(config, true)
  assert.equal(status.state,'lan'); assert.equal(status.active.port,13080); check('enable LAN and restore across origin')
  check('real settings form and inline enable confirmation')
  const restored = await c.evaluate(`window.__DSH_SMOKE_CONTEXT__.conversation.input.for(window.__DSH_SMOKE_CONTEXT__.sessions.scope(${JSON.stringify(id)})).state.getSnapshot().draft`)
  assert.equal(restored,'remote restart draft — 未发送'); check('unsent controlled draft restored')
  const attachment=await c.evaluate(`(async()=>{const c=window.__DSH_SMOKE_CONTEXT__;const ids=c.conversation.input.for(c.sessions.scope(${JSON.stringify(id)})).state.getSnapshot().attachmentIds;const values=c.conversation.resolveDraftAttachments(ids);return Promise.all(values.map(async a=>({name:a.file.name,text:await a.file.text()})))})()`)
  assert.deepEqual(attachment,[{name:'remote-smoke.txt',text:'remote draft attachment — 未发送'}]);check('unsent attachment bytes restored across origin')
  const rejected = await c.evaluate(`window.__TAURI__.core.invoke('remote_status',{identity:${JSON.stringify(oldIdentity)}}).then(()=>false,()=>true)`)
  assert.equal(rejected,true); check('stale document identity rejected')
  const forged=await c.evaluate(`window.__TAURI__.core.invoke('remote_status',{identity:{...window.__DSH_REMOTE_IDENTITY__,documentNonce:${JSON.stringify(oldIdentity.documentNonce)}}}).then(()=>false,()=>true)`)
  assert.equal(forged,true);check('current counters with old document nonce rejected')
  const oldServer=createHttpServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<script>(async()=>{const invoke=window.__TAURI__?.core?.invoke||window.__TAURI_INTERNALS__?.invoke;const result=invoke?await invoke('window_is_maximized').then(()=> 'allowed',()=> 'denied'):'no-bridge';parent.postMessage({remoteOldFrame:result},'*')})()</script>`)})
  const oldUrl=new URL(oldOrigin);await new Promise(r=>oldServer.listen(Number(oldUrl.port),oldUrl.hostname,r))
  try {
    await c.evaluate(`(()=>{window.__remoteOldFrame=null;window.addEventListener('message',e=>{if(e.origin===${JSON.stringify(oldOrigin)}&&e.data?.remoteOldFrame)window.__remoteOldFrame=e.data.remoteOldFrame},{once:true});const iframe=document.createElement('iframe');iframe.id='remote-old-frame';iframe.src=${JSON.stringify(oldOrigin)};document.body.append(iframe)})()`)
    const outcome=await until('window.__remoteOldFrame');assert.ok(['denied','no-bridge'].includes(outcome));check('old-origin iframe cannot invoke host command',outcome)
  } finally {await c.evaluate(`document.querySelector('#remote-old-frame')?.remove()`);await new Promise(r=>oldServer.close(r))}
  const info = await call('remote_connection_info')
  assert.ok(info.qrSvg.includes('<svg')); check('local QR generation')
  const base = status.address
  assert.equal((await http(new URL('/api/nonexistent',base))).status,401); check('anonymous API denied')
  assert.equal((await http(new URL('/?token=wrong',base))).status,401); check('wrong token denied')
  const login = await http(info.url); assert.equal(login.status,303)
  const cookie = login.headers['set-cookie'].map(v=>v.split(';')[0]).join('; ')
  const page = await http(base,{Cookie:cookie}); assert.equal(page.status,200); assert.ok(page.text.includes('dshRemote')); check('authenticated HTML includes project assets')
  const rpc=await http(new URL('/api/session/list',base),{Cookie:cookie,'Content-Type':'application/json'},'POST',JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'session/list',payload:{args:{_request:{}}}}))
  assert.equal(rpc.status,200); assert.equal(JSON.parse(rpc.text).result.ok,true); check('authenticated session list RPC')
  assert.equal((await http(new URL('/api/nonexistent',base),{Cookie:cookie})).status,404); check('authenticated API reaches route dispatcher')
  assert.equal((await http(new URL('/api/nonexistent',base),{Cookie:cookie,Host:'untrusted.invalid:13080'})).status,403); check('untrusted Host denied')
  assert.equal((await http(new URL('/api/nonexistent',base),{Cookie:cookie,Origin:'http://attacker.invalid'})).status,403); check('cross-origin denied')
  assert.equal((await http(new URL('/api/nonexistent',base),{Cookie:cookie,'Sec-Fetch-Site':'cross-site'})).status,403); check('cross-site fetch denied')
  const alternate = await http(info.url,{Host:'desktop.local:13080'})
  const alternateCookie = alternate.headers['set-cookie'].map(v=>v.split(';')[0]).join('; ')
  assert.equal((await http(new URL('/api/nonexistent',base),{Host:'desktop.local:13080',Cookie:alternateCookie})).status,404); check('explicit extra Host accepted')
  const withNoHosts = {...config,trustedHosts:[]}; status=await apply(withNoHosts)
  assert.equal((await http(new URL('/api/nonexistent',base),{Host:'desktop.local:13080',Cookie:alternateCookie})).status,403); check('Host removal and same-port restart')
  const changed={...withNoHosts,port:13081}; status=await apply(changed); assert.equal(status.active.port,13081); check('fixed-port change')
  const occupied=createServer(); await new Promise(r=>occupied.listen(13082,address.address,r))
  await settings()
  const preflight=await c.evaluate(`(async()=>{const s=await window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__});const payload=await window.__DSH_UI_STATE__.prepareRemoteApply(s.frontendVersion);try{await window.__TAURI__.core.invoke('remote_apply',{identity:window.__DSH_REMOTE_IDENTITY__,config:${JSON.stringify({...changed,port:13082})},payload});return null}catch(e){return e.code}finally{window.__DSH_UI_STATE__.finishRemoteApply()}})()`)
  occupied.close(); assert.equal(preflight,'port-unavailable'); assert.equal((await call('remote_status')).active.port,13081); check('port conflict preserves running backend')
  status=await apply({...changed,enabled:false}); assert.equal(status.state,'disabled'); assert.equal(status.address,null); check('disable closes LAN and returns to loopback')
  if(process.env.REMOTE_KEEP_LAN==='1')await apply({...changed,enabled:true})
  const log=await readFile(join(dir,'host.log'),'utf8'); const token=new URL(info.url).searchParams.get('token'); assert.ok(!log.includes(token)); check('host diagnostic log contains no launch token')
} finally {
  await writeFile(join(dir,'remote-control-integration.json'),JSON.stringify({date:new Date().toISOString(),checks},null,2))
  c.close()
}
