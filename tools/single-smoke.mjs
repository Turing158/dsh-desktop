/** Run the shipped single exe outside the checkout with installed Node/DSH/WebView2.
 * A Node preload appends a test probe to the served overlay in memory; the exe
 * and its embedded/cache files remain unchanged during the first launch.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile, unlink } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'dsh-single 空格-'))
const app = join(root, 'app')
await mkdir(app)
const exe = join(app, 'deepseek-harness-desktop.exe')
await copyFile(resolve(process.argv[2] || 'pack/single/deepseek-harness-desktop.exe'), exe)
const resources = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources
const report = { root, checks: [] }
const pass = name => { report.checks.push(name); console.log('PASS ' + name) }
const reg = join(process.env.SystemRoot || 'C:\\Windows', 'System32/reg.exe')
const run = (file, args) => exec(file, args, { windowsHide: true, timeout: 30000 })
const registryKey = 'HKCU\\Software\\Classes\\deepseekharness'
const registryFile = join(root, 'uri-handler.reg')
let hadRegistry = false
try { await run(reg, ['export', registryKey, registryFile, '/y']); hadRegistry = true } catch {}

async function launch(round) {
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
  const url = `http://127.0.0.1:${server.address().port}/${token}`
  const probe = `;(()=>{
    if(window.top!==window)return;
    const timer=setInterval(async()=>{
      if(!window.__DSH_REMOTE_IDENTITY__||!document.querySelector('[data-dsh-titlebar]'))return;
      clearInterval(timer);
      try{
        const invoke=(name)=>window.__TAURI__.core.invoke(name,{identity:window.__DSH_REMOTE_IDENTITY__});
        const profiles=await invoke('terminal_profiles');
        const status=await invoke('remote_status');
        await fetch(${JSON.stringify(url)},{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({ok:true,profiles,state:status.state})});
      }catch(error){await fetch(${JSON.stringify(url)},{method:'POST',body:JSON.stringify({ok:false,error:String(error)})});}
    },200);
  })();`
  const preload = join(root, `probe-${round}.cjs`)
  const runtimeInfo = join(root, `runtime-${round}.json`)
  await writeFile(preload, `const fs=require('node:fs');
    const at=process.argv.indexOf('--patch');
    if(at!==-1)fs.writeFileSync(${JSON.stringify(runtimeInfo)},JSON.stringify({node:process.execPath,dsh:process.argv[1],patch:process.argv[at+1]}));
    const read=fs.readFileSync;
    fs.readFileSync=function(file,...args){const data=read.call(this,file,...args);return String(file).replaceAll('\\\\','/').endsWith('/dsh-plugin/ui-overlay/dom.js')?String(data)+${JSON.stringify(probe)}:data;};
    require('node:module').syncBuiltinESMExports();`)
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(node_options|dsh_home|dsh_desktop_.*|webview2_.*)$/i.test(key)) delete env[key]
  Object.assign(env, {
    DSH_HOME: join(root, 'dsh-home'), DSH_DESKTOP_DEBUG: join(root, `host-${round}.log`),
    WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
    NODE_OPTIONS: '--require=' + JSON.stringify(preload), npm_config_offline: 'true',
  })
  const child = spawn(exe, [], { cwd: app, env, windowsHide: true, stdio: 'ignore' })
  let timer
  try {
    const page = await Promise.race([result,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('No WebView probe response')), 90000) }),
      new Promise((_, reject) => { child.once('error', reject); child.once('exit', code => reject(Error('Desktop exited: ' + code))) }),
    ])
    assert.ok(page.ok, page.error)
    assert.ok(page.profiles.some(p => p.profileId === 'cmd'))
    const runtime = JSON.parse(await readFile(runtimeInfo, 'utf8'))
    assert.equal(resolve(runtime.node).toLowerCase(), resolve(process.execPath).toLowerCase())
    assert.ok(!runtime.patch.startsWith(app))
    assert.ok(runtime.patch.includes('plugins'))
    const cache = dirname(dirname(runtime.patch))
    for (const [source, destination] of Object.entries(resources)) {
      assert.deepEqual(await readFile(join(cache, destination)), await readFile(resolve('src-tauri', source)), destination)
    }
    assert.deepEqual(await readdir(app), ['deepseek-harness-desktop.exe'])
    report['round' + round] = { page, runtime }
    return runtime.patch
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

try {
  const patch = await launch(1)
  pass('Standalone exe loads the real desktop UI and IPC using installed Node/DSH/WebView2')
  pass('Every embedded resource matches its source; no files appear beside the exe')
  const cache = dirname(dirname(patch))
  await writeFile(patch, 'damaged plugin cache')
  await unlink(join(cache, 'dsh-plugin/title-bar/client.js'))
  await launch(2)
  pass('Restart repairs both corrupted and deleted cache files and loads the UI again')
} catch (error) {
  report.error = error.message
  throw error
} finally {
  if (hadRegistry) await run(reg, ['import', registryFile])
  else await run(reg, ['delete', registryKey, '/f']).catch(() => {})
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('Report: ' + join(root, 'report.json'))
}
