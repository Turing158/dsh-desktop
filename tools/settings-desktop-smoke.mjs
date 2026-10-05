/** Windows WebView2 check with an isolated DSH profile and real terminal.
 * Build the debug host first: cargo build --manifest-path src-tauri/Cargo.toml
 * Run: node tools/settings-desktop-smoke.mjs [--packaged]
 * --packaged tests resources collected by pack.ps1 with the debug smoke bridge.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, writeFile, readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createServer } from 'node:net'
import { connect } from './terminal-cdp.mjs'

const root = await mkdtemp(resolve('src-tauri/target/settings-desktop-'))
const home = join(root, 'dsh-home')
await mkdir(home)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: off\n  ui: desktop\ndesktop-terminal-dock:\n  profileId: cmd\n  position: bottom\n  layout: { height: 312, collapsed: true }\n')
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
try {
  await until('Boolean(window.__DSH_UI_BOOT__?.smoke && window.__DSH_TERMINAL_SMOKE__ && window.__DSH_TERMINAL_IDENTITY__)')
  assert.equal(await c.evaluate("document.body.textContent.includes('Failed to load plugins')"), false)
  await until("window.__DSH_TERMINAL_SMOKE__.ctx.configForms.get('desktop-terminal-dock').getSnapshot().status === 'ready'")
  const imported = await c.evaluate("window.__DSH_TERMINAL_SMOKE__.ctx.configForms.get('desktop-terminal-dock').getSnapshot().value")
  assert.equal(imported.profileId, 'cmd')
  assert.equal(imported.layout.height, 312)
  pass('both desktop plugins activate in WebView2 with migrated settings')
  assert.equal(await c.evaluate("window.__DSH_TERMINAL_SMOKE__.ctx.configForms.get('desktop-appearance').set('fontSizeOverride', 18)"), true)
  await until("document.body.style.getPropertyValue('--dsh-content-font-size') === '18px'")
  await c.evaluate(`(async()=>{const ctx=window.__DSH_SMOKE_CONTEXT__;const w=await ctx.workspaces.create({path:${JSON.stringify(root)}});const id=await ctx.sessions.create({workspaceId:w.workspaceId});ctx.uiWorkspace.openSession(id)})()`)
  await until("Boolean(window.__DSH_TERMINAL_SMOKE__.dock.getSnapshot().workspaceKey)")
  await c.evaluate("(()=>{for(const b of document.querySelectorAll('button'))if(['稍后配置','继续'].includes(b.textContent))b.click();window.__DSH_TERMINAL_SMOKE__.dock.open()})()")
  await until("(()=>{const s=window.__DSH_TERMINAL_SMOKE__;const v=s.registry.viewFor(s.dock.getSnapshot().active);return v?.info?.state==='running' && v.element.isConnected})()")
  const sessions = await c.evaluate("window.__TAURI__.core.invoke('terminal_list', { identity: window.__DSH_TERMINAL_IDENTITY__ })")
  assert.ok(sessions.some(s => s.profileId === 'cmd'))
  assert.ok(sessions.some(s => s.cwd.toLowerCase() === root.toLowerCase()))
  pass('terminal opens a real CMD process using the saved profile')
  await c.evaluate('window.__DSH_TERMINAL_SMOKE__.dock.resize(338)')
  await until("window.__DSH_TERMINAL_SMOKE__.ctx.configForms.get('desktop-terminal-dock').getSnapshot().value.layout.height === 338")
  await c.send('Page.reload')
  await until("window.__DSH_TERMINAL_SMOKE__?.ctx.configForms.get('desktop-terminal-dock').getSnapshot().value?.layout?.height === 338")
  await until("document.body.style.getPropertyValue('--dsh-content-font-size') === '18px'")
  pass('native dock geometry and appearance survive a WebView reload')
  report.saved = JSON.parse(await readFile(join(home, 'desktop-settings.json'), 'utf8'))
  assert.equal(report.saved.namespaces['desktop-terminal-dock'].layout.height, 338)
  assert.equal(report.saved.namespaces['desktop-appearance'].fontSizeOverride, 18)
} catch (error) {
  report.error = error.stack
  if (c) try { report.page = await c.evaluate('document.body.innerText.slice(0, 5000)') } catch {}
  throw error
} finally {
  if (c) {
    try { await c.evaluate("(async()=>{const identity=window.__DSH_TERMINAL_IDENTITY__;for(const s of await window.__TAURI__.core.invoke('terminal_list',{identity}))await window.__TAURI__.core.invoke('terminal_close',{identity,terminalId:s.terminalId,runId:s.runId})})()") } catch {}
    c.close()
  }
  if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Evidence: ' + join(root, 'report.json'))
}
