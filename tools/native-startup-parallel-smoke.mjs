// Force both sides of the startup ordering in isolated native instances.
// Usage: node tools/native-startup-parallel-smoke.mjs DEBUG_EXE
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { offlineModelPatch } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const sourceExe = resolve(process.argv[2] || 'src-tauri/target/debug/deepseek-harness-desktop.exe')
const realBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/native-diagnostics-'))
const report = { root, checks: [], timings: {} }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, browser, directory
async function until(fn, label, timeout = 90000, allowExit = false) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    if (!allowExit && child?.exitCode !== null) throw Error('desktop exited: ' + label)
    await sleep(50)
  }
  throw Error('timeout: ' + label)
}
async function state() {
  try { return JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}; throw error }
}
async function timings() {
  const text = await readFile(join(directory, 'startup.log'), 'utf8')
  return Object.fromEntries([...text.matchAll(/\[startup-perf\] stage=([a-z-]+) elapsed_ms=(\d+)/g)].map(m => [m[1], Number(m[2])]))
}
async function start(name, { invalidNode = false, failSetup = false, delay = 2500, slowVersion = false } = {}) {
  directory = join(root, name)
  const home = join(directory, 'home'), exe = join(directory, 'startup-check.exe')
  await mkdir(home, { recursive: true }); await mkdir(join(directory, 'appdata'))
  await writeFile(join(home, 'cordis.patch.yml'), offlineModelPatch)
  await writeFile(join(home, 'settings.json'), JSON.stringify({ 'ui-settings-general': { welcomeNoticeVersion: '2026-09-28.1' } }))
  await copyFile(sourceExe, exe)
  const resources = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources
  for (const [source, destination] of Object.entries(resources)) {
    await mkdir(dirname(join(directory, destination)), { recursive: true })
    await copyFile(resolve('src-tauri', source), join(directory, destination))
  }
  const node = invalidNode ? join(directory, 'node.exe') : process.execPath
  if (invalidNode) await writeFile(node, 'invalid executable')
  // Delay only the version probe; the entry still uses the actual DSH runtime
  // for both resolution and execution, including its import.meta.main guard.
  let bin = realBin
  if (slowVersion) {
    bin = join(directory, 'slow-bin.mjs')
    await writeFile(bin, `import { spawnSync } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      if (process.argv.includes('--version')) {
        writeFileSync(${JSON.stringify(join(directory, 'probe-pid.json'))}, JSON.stringify(process.pid));
        await new Promise(r => setTimeout(r, ${failSetup ? 10000 : 1500}));
      }
      const result = spawnSync(process.execPath, [${JSON.stringify(realBin)}, ...process.argv.slice(2)], {stdio:'inherit',windowsHide:true});
      process.exit(result.status ?? 1);
    `)
    // For this timing case, pin the wrapper only for --version and delegate
    // module resolution to the real installed runtime using a junction.
    execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', join(directory, 'node_modules'), join(dirname(dirname(realBin)), 'node_modules')], { windowsHide: true, stdio: 'ignore' })
  }
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port; await new Promise(resolve => server.close(resolve))
  const env = { ...process.env, DSH_HOME: home, APPDATA: join(directory, 'appdata'), DSH_DESKTOP_SMOKE_DIR: directory,
    DSH_DESKTOP_NODE: node, DSH_DESKTOP_DSH: bin, DSH_DESKTOP_DEBUG: join(directory, 'startup.log'),
    DSH_DESKTOP_SMOKE_SETUP_DELAY_MS: String(delay), DSH_UI_SMOKE_KEY: 'offline',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port }
  delete env.DSH_DESKTOP_SMOKE_SETUP_FAIL
  if (failSetup) env.DSH_DESKTOP_SMOKE_SETUP_FAIL = '1'
  child = spawn(exe, [], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''; child.stderr.on('data', data => { stderr += data })
  if (failSetup) {
    await until(() => child.exitCode !== null, 'failed setup exits', 30000, true)
    assert.notEqual(child.exitCode, 0); assert.match(stderr, /smoke-setup-failed/)
    const stages = await timings()
    if (slowVersion) {
      const probePid = JSON.parse(await readFile(join(directory, 'probe-pid.json'), 'utf8'))
      await until(() => {
        try { process.kill(probePid, 0); return false }
        catch (error) { if (error.code === 'ESRCH') return true; throw error }
      }, 'setup failure reaps the running version probe', 3000, true)
    } else assert.ok(stages['boot-prepared'] < delay, JSON.stringify(stages))
    assert.equal(stages['backend-spawned'], undefined)
    assert.equal(stages['setup-ready'], undefined)
    report.timings[name] = stages
    return
  }
  await until(async () => (await state()).visible, 'native window')
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  if (invalidNode) {
    const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('tauri.localhost'))
    assert.ok(page)
    const status = await until(async () => {
      const value = await page.evaluate(() => window.__TAURI__.core.invoke('probe_state'))
      return value.phase.kind === 'needs-node' && value
    }, 'early failure displayed')
    assert.ok(status)
    const stages = await timings()
    assert.ok(stages['boot-prepared'] < stages['window-created'], JSON.stringify(stages))
    assert.equal(stages['backend-spawned'], undefined)
    report.timings['early-error'] = stages
    await copyFile(process.execPath, node)
    await page.evaluate(() => window.__TAURI__.core.invoke('retry_boot'))
  }
  await until(async () => {
    const s = await state()
    if (s.backend === 'failed') throw Error('backend failed: ' + directory)
    return s.backend === 'running' && s.loaded
  }, 'backend running')
  const page = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1:')), 'business page')
  await page.waitForFunction(() => !!window.__DSH_UI_STATE__ && document.querySelector('#root')?.childElementCount > 0)
  const stages = await timings()
  if (!invalidNode) {
    assert.ok(stages['boot-start'] < stages['window-created'], JSON.stringify(stages))
    assert.ok(slowVersion ? stages['setup-ready'] < stages['boot-prepared'] : stages['boot-prepared'] < stages['window-created'], JSON.stringify(stages))
  }
  assert.ok(stages['backend-spawned'] >= stages['setup-ready'], JSON.stringify(stages))
  assert.equal((await state()).identity.backendInstance, 1, 'only one backend starts')
  report.timings[name] = stages
}
async function stop() {
  await browser?.close().catch(() => {}); browser = undefined
  if (child?.exitCode === null) {
    await writeFile(join(directory, 'command.json'), JSON.stringify({ sequence: Date.now(), action: 'quit' }))
    const deadline = Date.now() + 10000
    while (child.exitCode === null && Date.now() < deadline) await sleep(50)
    if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
  child = undefined
}
try {
  for (const [name, options] of [
    ['preparation-first', {}],
    ['window-first', { delay: 0, slowVersion: true }],
    ['early-error-retry', { invalidNode: true }],
    ['setup-failed', { failSetup: true }],
    ['setup-failed-during-probe', { failSetup: true, slowVersion: true, delay: 1000 }],
  ]) {
    await start(name, options); await stop()
    report.checks.push(name); console.log('PASS: ' + name)
  }
} catch (error) { report.error = error.stack; throw error }
finally { await stop(); await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log('Report: ' + join(root, 'report.json')) }
