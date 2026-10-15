/** Verify the distributed ZIP through its real WebView and production IPC.
 * A probe is appended to the extracted boot script, never the distributed ZIP.
 * It reports over loopback so release WebView2 need not expose a debug port.
 * Pass --missing-dsh to verify first-launch installation with npm forced offline.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const exec = promisify(execFile)
const windows = process.env.SystemRoot || 'C:\\Windows'
const powershell = join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const reg = join(windows, 'System32/reg.exe')
const run = (file, args) => exec(file, args, { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })
const version = JSON.parse(await readFile(resolve('src-tauri/tauri.conf.json'), 'utf8')).version
const missingDsh = process.argv.includes('--missing-dsh')
const installedMode = process.argv.includes('--installed')
const zipFile = process.argv.slice(2).find(arg => !arg.startsWith('--')) || `pack/dsh-desktop-v${version}-portable-win-x64.zip`
// DSH is a separately installed fixture, never a file inside the ZIP.
const dshBin = resolve(process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js'))
if (!missingDsh) await access(dshBin)
const root = await mkdtemp(resolve('src-tauri/target/offline-smoke 空格-'))
const portable = join(root, 'portable')
await mkdir(portable)
if (installedMode) await cp(resolve(zipFile), portable, { recursive: true })
else await run(join(windows, 'System32/tar.exe'), ['-xf', resolve(zipFile), '-C', portable])
const installation = installedMode ? JSON.parse(await readFile(join(portable, 'runtime/installed.json'), 'utf8')) : null
const manifest = installedMode ? { versions: installation } : JSON.parse(await readFile(join(portable, 'runtime/runtime.json'), 'utf8'))
if (!installedMode) {
  assert.equal(manifest.platform, 'win32')
  assert.deepEqual((await readdir(join(portable, 'runtime'))).sort(), ['node', 'runtime.json', 'webview2'])
  assert.ok(Object.keys(manifest.files).every(file => /^(node|webview2)\//.test(file)))
  assert.ok(!('dsh' in manifest.versions))
}

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
  if(${missingDsh}){
   try{
    const state=await window.__TAURI__.core.invoke('probe_state');
    if(state.phase.kind!=='failed')return;
    clearInterval(timer);
    await send({ok:true,startup:state});
   }catch{}
   return;
  }
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
  if (/^(path|node_options|node_path|npm_config_.*|appdata|localappdata|userprofile|programfiles|programfiles\(x86\)|programw6432|dsh_home|dsh_desktop_.*|webview2_.*)$/i.test(name)) delete env[name]
}
const appData = join(root, 'home/AppData/Roaming')
const localAppData = join(root, 'home/AppData/Local')
// Windows known-folder APIs expand USERPROFILE independently of APPDATA.
// Use the standard profile layout so Tauri can locate its own settings too.
for (const folder of [appData, localAppData, join(appData, 'Microsoft/Windows/Start Menu/Programs'), join(root, 'programfiles'), join(root, 'dsh-home')]) {
  await mkdir(folder, { recursive: true })
}
const npmPrefix = join(appData, 'npm')
await mkdir(npmPrefix)
if (!missingDsh) {
  await symlink(resolve(dirname(dshBin), '../../..'), join(npmPrefix, 'node_modules'), 'junction')
  await writeFile(join(npmPrefix, 'dsh.cmd'), '@"node" "%~dp0node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n')
}
Object.assign(env, {
  PATH: [join(windows, 'System32'), join(windows, 'System32/WindowsPowerShell/v1.0')].join(';'),
  APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: join(root, 'home'),
  ProgramFiles: join(root, 'programfiles'), 'ProgramFiles(x86)': join(root, 'programfiles'), ProgramW6432: join(root, 'programfiles'),
  DSH_HOME: join(root, 'dsh-home'), DSH_DESKTOP_DEBUG: join(root, 'host.log'),
  DSH_DESKTOP_NODE: join(root, 'missing-node.exe'), DSH_DESKTOP_DSH: join(root, 'missing-dsh.js'),
  NODE_OPTIONS: '--require=' + JSON.stringify(guard),
  npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:1',
  npm_config_cache: join(root, 'npm-cache'),
  npm_config_userconfig: join(root, 'user.npmrc'), npm_config_globalconfig: join(root, 'global.npmrc'),
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
  if (missingDsh) {
    assert.equal(page.startup.phase.kind, 'failed')
    assert.equal(page.startup.phase.manual_install, true)
    assert.match(page.startup.phase.message, /自动安装 dsh 失败/)
    assert.ok(page.startup.phase.details.some(line => /ENOTCACHED/.test(line)), 'npm must attempt installation against the deliberately empty offline cache')
    assert.equal(resolve(page.startup.node_path), join(portable, 'runtime/node/node.exe'))
    pass('Missing DSH starts npm installation using bundled Node and reports the offline failure')
  } else {
  // Tauri's Windows known-folder API can still read the existing remote-control
  // setting. Do not change it; either a normal local boot or safe local fallback
  // is valid here. DSH sessions and browser data use fresh test directories.
  assert.ok(['disabled', 'local-fallback'].includes(page.status.state))
  pass(installedMode ? 'Installed app loads the full UI with the selected runtime paths and a separate DSH installation' : 'ZIP excludes DSH and loads the full UI using a separate global DSH installation and bundled Node/WebView2')
  assert.ok(page.profiles.some(p => p.profileId === 'cmd'))
  assert.ok(page.profiles.some(p => p.profileId === 'powershell'))
  assert.ok(!page.profiles.some(p => p.profileId === 'pwsh'))
  pass('Missing PowerShell 7 is hidden; Windows shells remain', page.profiles.map(p => p.profileId))
  assert.ok(!page.updateMessage.includes('完整 portable'))
  assert.match(page.updateMessage, /npm view/, 'update check should reach npm, whose registry is deliberately offline')
  pass('Portable DSH update checks use the normal npm flow')
  const { stdout } = await run(powershell, ['-NoProfile', '-Command', `$all=Get-CimInstance Win32_Process; $ids=@(${child.pid}); do { $next=@($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId }); $ids+=$next } while ($next.Count); $all | Where-Object { $ids -contains $_.ProcessId } | Select-Object Name,ExecutablePath | ConvertTo-Json -Compress`])
  const processes = JSON.parse(stdout)
  if (installedMode) {
    assert.ok(processes.some(p => p.Name === 'node.exe' && resolve(p.ExecutablePath).toLowerCase() === resolve(installation.nodePath).toLowerCase()))
    assert.ok(processes.some(p => p.Name === 'msedgewebview2.exe' && (installation.webview2Path ? p.ExecutablePath.startsWith(installation.webview2Path) : !p.ExecutablePath.includes('runtime\\webview2\\'))))
    pass('Installed app uses the Node and WebView2 selected by the installer')
  } else {
    assert.ok(processes.some(p => p.Name === 'node.exe' && p.ExecutablePath.includes('runtime\\node\\')))
    assert.ok(processes.some(p => p.Name === 'msedgewebview2.exe' && p.ExecutablePath.includes('runtime\\webview2\\')))
    pass('Actual Node and WebView2 processes run from inside the extracted ZIP')
  }
  pass('External Node connections blocked and npm forced offline', (await readFile(networkLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean))
  }
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
