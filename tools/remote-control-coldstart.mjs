/** Cold-start and native LAN regression matrix. Owns only isolated processes. */
import {spawn} from 'node:child_process'
import {mkdir,writeFile,readFile,copyFile} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {networkInterfaces} from 'node:os'
import {createServer} from 'node:net'
import {request} from 'node:http'
import {connect} from './terminal-cdp.mjs'
import assert from 'node:assert/strict'
const root=resolve('src-tauri/target/remote-control-cold'),port=9358,checks=[]
await mkdir(root,{recursive:true})
const exe=join(root,'deepseek-harness-desktop.exe')
await copyFile(resolve(process.env.DSH_DESKTOP_TEST_EXE || 'src-tauri/target/debug/deepseek-harness-desktop.exe'),exe)
const resources=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8')).bundle.resources
for(const [src,dest] of Object.entries(resources)){const target=join(root,dest);await mkdir(dirname(target),{recursive:true});await copyFile(resolve('src-tauri',src),target)}
const address=Object.values(networkInterfaces()).flat().find(i=>i?.family==='IPv4'&&!i.internal&&/^192\.168\./.test(i.address))?.address
assert.ok(address,'a LAN adapter is required')
const config={version:1,enabled:true,bindAddress:address,port:13083,trustedHosts:[]}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
let processHandle,c,sequence=0
async function stop(){c?.close();c=null;if(!processHandle)return;if(processHandle.exitCode!==null){processHandle=null;return}await writeFile(join(root,'command.json'),JSON.stringify({sequence:++sequence,action:'quit'}));await Promise.race([new Promise(r=>processHandle.once('exit',r)),sleep(12000).then(()=>{throw Error('Host did not stop')})]);processHandle=null}
async function start(value){
  await writeFile(join(root,'remote-control.json'),typeof value==='string'?value:JSON.stringify(value))
  await writeFile(join(root,'command.json'),'{}');sequence=0
  processHandle=spawn(exe,[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,DSH_HOME:join(root,'dsh-home'),DSH_DESKTOP_SMOKE_DIR:root,DSH_DESKTOP_DEBUG:join(root,'host.log'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}})
  const end=Date.now()+70000
  while(Date.now()<end){if(processHandle.exitCode!==null)throw Error('Test host exited before startup; another desktop instance may already be running');try{c ||= await connect(port); const s=await c.evaluate(`window.__DSH_REMOTE_IDENTITY__ && window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__})`);if(s)return s}catch{c?.close();c=null}await sleep(150)}
  throw Error('Cold-start timeout')
}
const check=(name,detail=true)=>{checks.push({name,detail});console.log('PASS '+name)}
function hostRequest(host, path, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: address, port: config.port, path, method, headers: { Host: host, ...headers } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.setTimeout(6000, () => req.destroy(Error('Host request timeout')))
    req.end(body)
  })
}
try{
  for(const [name,value,code] of [['corrupt configuration','{bad','config-invalid'],['unknown version',{...config,version:7},'config-version'],['invalid address',{...config,bindAddress:'0.0.0.0'},'address-invalid'],['unlisted preferred Host',{...config,preferredHost:{host:'unlisted.example.com',scheme:'https'}},'preferred-host-untrusted']]){
    const s=await start(value);assert.equal(s.state,'local-fallback');assert.equal(s.error.code,code);assert.equal(s.active.enabled,false);check(name+' falls back locally');await stop()
  }
  const occupied=createServer();await new Promise(r=>occupied.listen(config.port,address,r))
  try{const s=await start(config);assert.equal(s.state,'local-fallback');assert.equal(s.error.code,'port-unavailable');assert.equal(s.saved.enabled,true);check('occupied cold-start port retains saved choice');await stop()}finally{occupied.close()}
  for(const bindAddress of ['10.255.255.254','']){
    const s=await start({...config,bindAddress});assert.equal(s.state,'lan');assert.equal(s.error,null)
    const available=await c.evaluate(`window.__TAURI__.core.invoke('remote_lan_addresses',{identity:window.__DSH_REMOTE_IDENTITY__})`)
    assert.ok(available.some(a=>a.address===s.active.bindAddress));assert.notEqual(s.active.bindAddress,bindAddress)
    assert.deepEqual(s.saved,s.active);assert.deepEqual(JSON.parse(await readFile(join(root,'remote-control.json'),'utf8')),s.active)
    assert.equal(s.active.port,config.port);assert.deepEqual(s.active.trustedHosts,config.trustedHosts)
    check((bindAddress?'stale':'empty')+' saved address selects and persists a live LAN adapter');await stop()
  }
  for(const preferredHost of [{host:'remote.example.com',scheme:'https'},{host:'desktop.local:13083',scheme:'http'}]){
    const s=await start({...config,trustedHosts:[preferredHost.host],preferredHost})
    assert.equal(s.state,'lan');assert.equal(s.active.bindAddress,address);assert.deepEqual(s.saved.preferredHost,preferredHost)
    assert.equal(s.address,`${preferredHost.scheme}://${preferredHost.host}/`)
    assert.equal(await c.evaluate('location.origin'),`http://${address}:${config.port}`)
    const info=await c.evaluate(`window.__TAURI__.core.invoke('remote_connection_info',{identity:window.__DSH_REMOTE_IDENTITY__})`)
    const link=new URL(info.url);assert.equal(link.origin,new URL(s.address).origin);assert.ok(info.qrSvg.includes('<svg'))
    assert.ok(link.searchParams.get('token'));assert.ok(!JSON.stringify(s).includes(link.searchParams.get('token')))
    // Redeem the generated link locally with its selected Host; no public DNS
    // or tunnel is contacted, and the credential never enters the report.
    const status=await new Promise((resolve,reject)=>{
      const req=request(`http://${address}:${config.port}/${link.search}`,{headers:{Host:preferredHost.host}},res=>{res.resume();resolve(res.statusCode)})
      req.on('error',reject);req.setTimeout(6000,()=>req.destroy(Error('Login timeout')));req.end()
    })
    assert.equal(status,303)
    check(preferredHost.scheme+' preferred Host is restored and its generated login credential is valid');await stop()
  }
  const multiHost = { ...config, trustedHosts: ['first.example.test', 'second.example.test:8443'], preferredHost: { host: 'first.example.test', scheme: 'https' } }
  const before = await start(multiHost)
  assert.equal(before.state, 'lan')
  const persisted = await readFile(join(root, 'remote-control.json'), 'utf8')
  const cookies = new Map()
  for (const target of [multiHost.preferredHost, { host: 'second.example.test:8443', scheme: 'https' }, { host: `${address}:${config.port}`, scheme: 'http' }]) {
    const info = await c.evaluate(`window.__TAURI__.core.invoke('remote_connection_info',{identity:window.__DSH_REMOTE_IDENTITY__,target:${JSON.stringify(target)}})`)
    const link = new URL(info.url)
    assert.equal(link.origin, new URL(`${target.scheme}://${target.host}`).origin)
    assert.equal(info.instance, before.instance)
    assert.ok(link.searchParams.get('token'))
    assert.ok(info.qrSvg.includes('<svg'))
    // Only the local listener is contacted. Different Host and Origin headers
    // exercise the real authentication and allowlist used by both domains.
    assert.equal((await hostRequest(target.host, '/')).status, 401)
    assert.equal((await hostRequest(target.host, '/api/nonexistent')).status, 401)
    const login = await hostRequest(target.host, link.pathname + link.search)
    assert.equal(login.status, 303)
    const cookie = login.headers['set-cookie'].map(value => value.split(';')[0]).join('; ')
    cookies.set(target.host, cookie)
    const headers = { Cookie: cookie, Origin: link.origin, 'Sec-Fetch-Site': 'same-origin' }
    assert.equal((await hostRequest(target.host, '/', headers)).status, 200)
    const rpc = await hostRequest(target.host, '/api/session/list', { ...headers, 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }))
    assert.equal(rpc.status, 200)
    assert.equal(JSON.parse(rpc.text).result.ok, true)
  }
  assert.equal((await hostRequest('second.example.test:8443', '/api/nonexistent', { Cookie: cookies.get('first.example.test') })).status, 401)
  assert.equal((await hostRequest('unlisted.example.test', '/api/nonexistent')).status, 403)
  const rejected = await c.evaluate(`window.__TAURI__.core.invoke('remote_connection_info',{identity:window.__DSH_REMOTE_IDENTITY__,target:{host:'unlisted.example.test',scheme:'https'}}).then(()=>null,error=>error.code)`)
  assert.equal(rejected, 'access-host-untrusted')
  const after = await c.evaluate(`window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__})`)
  assert.equal(after.instance, before.instance)
  assert.equal(after.operationId, before.operationId)
  assert.deepEqual(after.active, before.active)
  assert.deepEqual(after.saved, before.saved)
  assert.equal(await readFile(join(root, 'remote-control.json'), 'utf8'), persisted)
  check('two domains and LAN authenticate and load sessions in one backend instance without changing settings')
  check('domain sessions remain independent and unlisted connection targets are rejected')
  await stop()
  const s=await start(config);assert.equal(s.state,'lan');assert.equal(s.active.bindAddress,address);check('saved LAN configuration starts on exact address')
  const native=await c.evaluate(`(async()=>{
    const invoke=(name,args={})=>window.__TAURI__.core.invoke(name,args)
    const max=await invoke('window_is_maximized');await invoke('window_toggle_maximize');await invoke('window_toggle_maximize')
    const original=await invoke('clipboard_read_text');await invoke('clipboard_write_text',{text:'DSH remote control smoke'});const copied=await invoke('clipboard_read_text');await invoke('clipboard_write_text',{text:original||''})
    const identity=window.__DSH_TERMINAL_IDENTITY__,t=(name,args={})=>invoke(name,{identity,...args})
    const profiles=await t('terminal_profiles')
    const opened=await t('terminal_open',{resourceKey:'dsh-resource://desktop-terminal/remote-smoke',profileId:'cmd',cwd:${JSON.stringify(root)}})
    await new Promise(r=>setTimeout(r,800));const active=await t('terminal_list');await t('terminal_close',{terminalId:opened.terminalId,runId:opened.runId})
    return {maximized:await invoke('window_is_maximized')===max,clipboard:copied==='DSH remote control smoke',terminal:active.some(v=>v.terminalId===opened.terminalId&&v.state==='running'),profiles:profiles.length}
  })()`)
  assert.equal(native.maximized,true);assert.equal(native.clipboard,true);assert.equal(native.terminal,true);check('LAN title bar, clipboard and native terminal',native)
  await c.evaluate(`window.__TAURI__.core.invoke('window_close')`);await sleep(300)
  const hidden=JSON.parse(await readFile(join(root,'state.json'),'utf8'));assert.equal(hidden.visible,false);assert.equal(hidden.backend,'running');check('tray hiding keeps backend running')
  await writeFile(join(root,'command.json'),JSON.stringify({sequence:++sequence,action:'show'}));await sleep(500)
  assert.equal(JSON.parse(await readFile(join(root,'state.json'),'utf8')).visible,true);check('tray restore on LAN origin')
  await stop()
}finally{if(processHandle)await stop();await writeFile(join(root,'remote-control-coldstart.json'),JSON.stringify({date:new Date().toISOString(),checks},null,2))}
