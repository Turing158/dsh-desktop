/** Verify the distributed ZIP through its real WebView and production IPC.
 * A probe is appended to the extracted boot script, never the distributed ZIP.
 * It reports over loopback so release WebView2 need not expose a debug port.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const exec = promisify(execFile)
const windows = process.env.SystemRoot || 'C:\\Windows'
const powershell = join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const reg = join(windows, 'System32/reg.exe')
const run = (file, args) => exec(file, args, { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })
const root = await mkdtemp(resolve('src-tauri/target/offline-smoke 空格-'))
const portable = join(root, 'portable')
await mkdir(portable)
await run(join(windows, 'System32/tar.exe'), ['-xf', resolve(process.argv[2] || 'pack/DeepseekHarness-portable-win-x64.zip'), '-C', portable])
const manifest = JSON.parse(await readFile(join(portable, 'runtime/runtime.json'), 'utf8'))
assert.equal(manifest.platform, 'win32')
assert.ok(!Object.keys(manifest.files).some(file => /^(pwsh|git)\//.test(file)))

const guard = join(root, 'no-external-network.cjs')
const networkLog = join(root, 'network-attempts.log')
await writeFile(guard, `const net=require('node:net'),fs=require('node:fs');
const original=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const first=Array.isArray(args[0])?args[0][0]:args[0];
 const opts=typeof first==='object'?first:{};
 const host=opts.host||(typeof first==='number'&&typeof args[1]==='string'?args[1]:'localhost');
 if(!opts.path&&!['localhost','127.0.0.1','::1'].includes(host)){
  fs.appendFileSync(${JSON.stringify(networkLog)},String(host)+'\\n');
  throw Error('Offline smoke test blocked external network: '+host);
 }
 return original.apply(this,args);
};`)

let receive
const result = new Promise(resolve => { receive = resolve })
const token = randomUUID()
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method !== 'POST' || req.url !== '/' + token) { res.writeHead(404); res.end(); return }
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 20000) { req.destroy(); return }
  }
  try { receive(JSON.parse(body)); res.end('ok') } catch { res.writeHead(400); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const reportUrl = `http://127.0.0.1:${server.address().port}/${token}`
const bootFile = join(portable, 'dsh-plugin/title-bar/boot.js')
const boot = await readFile(bootFile)
await writeFile(bootFile, Buffer.concat([boot, Buffer.from(`
;(()=>{
 if(window.top!==window)return;
 const send=value=>fetch(${JSON.stringify(reportUrl)},{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(value)});
 const timer=setInterval(async()=>{
  if(!window.__DSH_REMOTE_IDENTITY__||!document.querySelector('[data-dsh-titlebar]'))return;
  clearInterval(timer);
  try{
   const invoke=(name,args={})=>window.__TAURI__.core.invoke(name,{identity:window.__DSH_REMOTE_IDENTITY__,...args});
   const status=await invoke('remote_status');
   const profiles=await invoke('terminal_profiles');
   const updateMessage=await invoke('check_dsh_update').then(()=>'',e=>String(e));
   await send({ok:true,status,profiles,updateMessage});
  }catch(error){await send({ok:false,error:String(error),text:document.body.innerText.slice(0,3000)});}
 },200);
 setTimeout(()=>{clearInterval(timer);send({ok:false,error:'UI readiness timed out',text:document.body.innerText.slice(0,3000)});},75000);
})();
`)]))

const env = { ...process.env }
for (const name of Object.keys(env)) {
  if (/^(path|node_options|node_path|appdata|localappdata|userprofile|programfiles|programfiles\(x86\)|programw6432|dsh_home|dsh_desktop_.*|webview2_.*)$/i.test(name)) delete env[name]
}
for (const folder of ['appdata', 'localappdata', 'home', 'programfiles', 'dsh-home']) await mkdir(join(root, folder))
Object.assign(env, {
  PATH: [join(windows, 'System32'), join(windows, 'System32/WindowsPowerShell/v1.0')].join(';'),
  APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), USERPROFILE: join(root, 'home'),
  ProgramFiles: join(root, 'programfiles'), 'ProgramFiles(x86)': join(root, 'programfiles'), ProgramW6432: join(root, 'programfiles'),
  DSH_HOME: join(root, 'dsh-home'), DSH_DESKTOP_DEBUG: join(root, 'host.log'),
  DSH_DESKTOP_NODE: join(root, 'missing-node.exe'), DSH_DESKTOP_DSH: join(root, 'missing-dsh.js'),
  NODE_OPTIONS: '--require=' + JSON.stringify(guard),
  npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:1',
  WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: join(root, 'missing-webview'),
  WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
})
// Startup refreshes the URI handler; preserve the user's existing association.
const registryKey = 'HKCU\\Software\\Classes\\deepseekharness'
const registryFile = join(root, 'uri-handler.reg')
let hadRegistry = false
try { await run(reg, ['export', registryKey, registryFile, '/y']); hadRegistry = true } catch {}
const child = spawn(join(portable, 'deepseek-harness-desktop.exe'), [], { cwd: root, env, windowsHide: true, stdio: 'ignore' })
console.log('Isolated launch: ' + root)
const report = { root, versions: manifest.versions, checks: [] }
const pass = (name, detail = true) => { report.checks.push({ name, detail }); console.log('PASS ' + name) }
let timer
try {
  const page = await Promise.race([result,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('No WebView probe response')), 90000) }),
    new Promise((_, reject) => { child.once('exit', code => reject(Error('Desktop exited: ' + code))); child.once('error', reject) }),
  ])
  report.page = page
  assert.ok(page.ok, page.error + ': ' + page.text)
  // Tauri's Windows known-folder API can still read the existing remote-control
  // setting. Do not change it; either a normal local boot or safe local fallback
  // is valid here. DSH sessions and browser data use fresh test directories.
  assert.ok(['disabled', 'local-fallback'].includes(page.status.state))
  pass('ZIP loads the full UI with fresh DSH/WebView profiles and no system Node/DSH/WebView2')
  assert.ok(page.profiles.some(p => p.profileId === 'cmd'))
  assert.ok(page.profiles.some(p => p.profileId === 'powershell'))
  assert.ok(!page.profiles.some(p => p.profileId === 'pwsh'))
  pass('Missing PowerShell 7 is hidden; Windows shells remain', page.profiles.map(p => p.profileId))
  assert.ok(page.updateMessage.includes('完整 portable'))
  pass('Bundled DSH cannot trigger a global npm update')
  const escapedRoot = root.replaceAll("'", "''")
  const { stdout } = await run(powershell, ['-NoProfile', '-Command', `$p=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${escapedRoot}*' }; $p | Select-Object Name,ExecutablePath | ConvertTo-Json -Compress`])
  const processes = JSON.parse(stdout)
  assert.ok(processes.some(p => p.Name === 'node.exe' && p.ExecutablePath.includes('runtime\\node\\')))
  assert.ok(processes.some(p => p.Name === 'msedgewebview2.exe' && p.ExecutablePath.includes('runtime\\webview2\\')))
  pass('Actual Node and WebView2 processes run from inside the extracted ZIP')
  pass('External Node connections blocked and npm forced offline', (await readFile(networkLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean))
} catch (error) {
  report.error = error.message
  throw error
} finally {
  clearTimeout(timer)
  if (child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill()
    await exited
  }
  await writeFile(bootFile, boot)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  if (hadRegistry) await run(reg, ['import', registryFile])
  else await run(reg, ['delete', registryKey, '/f'])
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('Report: ' + join(root, 'report.json'))
}
