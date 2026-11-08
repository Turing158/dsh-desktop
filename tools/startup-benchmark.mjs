// Repeated native launches with an isolated profile and a real managed runtime.
// Usage: node tools/startup-benchmark.mjs ROOT LABEL EXE [RESOURCE_PROJECT] [ROUNDS]
// Use the same ROOT for before/after; resources and executable are copied per run.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, copyFile, lstat } from 'node:fs/promises'
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path'
import { createServer } from 'node:net'
import { offlineModelPatch } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const [rootArg, label, exeArg, resourceArg = '.', roundsArg = '5'] = process.argv.slice(2)
assert.ok(rootArg && exeArg && /^[a-z0-9-]+$/i.test(label), 'ROOT LABEL EXE required')
const root = resolve(rootArg), boundary = resolve('src-tauri/target'), part = relative(boundary, root)
assert.ok(part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part), 'fixture must stay inside src-tauri/target')
for (let path = root; ; path = dirname(path)) {
  const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  assert.ok(!info?.isSymbolicLink(), 'fixture ancestors must not be linked')
  if (path === dirname(path)) break
}
const rounds = Number(roundsArg)
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 20)
const resources = resolve(resourceArg), home = join(root, 'home'), exe = join(root, 'startup-check.exe')
const realBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
await mkdir(home, { recursive: true })
await mkdir(join(root, 'appdata'), { recursive: true })
await writeFile(join(home, 'cordis.patch.yml'), offlineModelPatch)
await writeFile(join(home, 'settings.json'), JSON.stringify({ 'ui-settings-general': { welcomeNoticeVersion: '2026-09-28.1' } }))
await copyFile(resolve(exeArg), exe)
const config = JSON.parse(await readFile(join(resources, 'src-tauri/tauri.conf.json'), 'utf8'))
for (const [source, destination] of Object.entries(config.bundle.resources)) {
  await mkdir(dirname(join(root, destination)), { recursive: true })
  await copyFile(resolve(resources, 'src-tauri', source), join(root, destination))
}
const report = { schema: 1, label, node: process.version, rounds: [] }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, browser, log, started, windowMs, backendMs
const state = async () => JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
async function until(fn, description, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw Error('desktop exited during ' + description)
    try { const value = await fn(); if (value) return value } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) && !(error instanceof SyntaxError)) throw error
    }
    await sleep(50)
  }
  throw Error('timeout: ' + description)
}
async function start(name, pin) {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  log = join(root, label + '-' + name + '.log')
  for (const file of ['state.json', 'command.json']) await writeFile(join(root, file), '{}')
  await writeFile(log, '')
  const env = { ...process.env, APPDATA: join(root, 'appdata'), DSH_HOME: home, DSH_DESKTOP_SMOKE_DIR: root,
    DSH_DESKTOP_NODE: process.execPath, DSH_DESKTOP_DEBUG: log, DSH_UI_SMOKE_KEY: 'offline',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port }
  delete env.DSH_DESKTOP_DSH
  if (pin) env.DSH_DESKTOP_DSH = pin
  started = Date.now(); windowMs = undefined; backendMs = undefined
  child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: 'ignore', env })
  await until(async () => {
    const s = await state()
    if (s.visible && windowMs === undefined) windowMs = Date.now() - started
    if (s.backend === 'failed') throw Error('backend failed; see ' + log)
    if (s.backend === 'running') { backendMs = Date.now() - started; return true }
  }, 'backend')
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  const page = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1:')), 'backend page')
  await page.waitForFunction(() => !!window.__DSH_UI_STATE__ && document.querySelector('#root')?.childElementCount > 0, null, { timeout: 120000 })
  const uiMs = Date.now() - started
  const s = await state(), text = await readFile(log, 'utf8')
  const stages = Object.fromEntries([...text.matchAll(/\[startup-perf\] stage=([a-z-]+) elapsed_ms=(\d+)/g)].map(m => [m[1], Number(m[2])]))
  const verify = text.match(/verify files=(\d+) hashed=(\d+) cached_layout=(true|false) elapsed_ms=(\d+)/)
  const light = text.match(/selection mode=lightweight elapsed_ms=(\d+)/)
  return { windowMs, backendMs, uiMs, stages, selectionMode: light ? 'lightweight' : 'full',
    ...(light ? { selectionMs: Number(light[1]), verificationMs: 0, hashed: 0 } : {}),
    ...(verify ? { verificationMs: Number(verify[4]), hashed: Number(verify[2]), files: Number(verify[1]) } : {}), runtimeVersion: s.runtime?.version }
}
async function stop() {
  await browser?.close().catch(() => {}); browser = undefined
  if (child?.exitCode === null) {
    await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: Date.now(), action: 'quit' }))
    const deadline = Date.now() + 10000
    while (child.exitCode === null && Date.now() < deadline) await sleep(100)
    if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
  child = undefined
}
try {
  const selected = await readFile(join(root, 'runtime/selection.json'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error })
  if (!selected) {
    await start('prepare', realBin)
    await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: Date.now(), action: 'runtime-prepare', source: dirname(dirname(realBin)) }))
    const prepared = await until(async () => JSON.parse(await readFile(join(root, 'runtime-prepared.json'), 'utf8')), 'managed runtime preparation', 600000)
    assert.ok(!prepared.error, prepared.error)
    await stop()
  }
  await start('warmup')
  await until(async () => JSON.parse(await readFile(join(root, 'runtime/selection.json'), 'utf8')).uiReady, 'managed UI acknowledgement')
  await stop()
  for (let round = 1; round <= rounds; round++) {
    const measurement = await start(String(round))
    assert.equal((await state()).runtime.source, 'managed')
    assert.equal(measurement.hashed, 0, 'normal warm launches should not hash runtime files')
    if (measurement.selectionMode === 'lightweight') assert.equal(measurement.verificationMs, 0, 'lightweight startup must not scan the inventory')
    report.rounds.push({ round, ...measurement })
    console.log(JSON.stringify(report.rounds.at(-1)))
    await stop()
  }
  const median = key => report.rounds.map(r => r[key]).sort((a, b) => a - b)[Math.floor(rounds / 2)]
  report.median = Object.fromEntries(['windowMs', 'backendMs', 'uiMs', 'verificationMs'].map(key => [key, median(key)]))
  console.log(JSON.stringify({ label, median: report.median }))
} catch (error) { report.error = error.stack; throw error }
finally { await stop(); await writeFile(join(root, label + '-report.json'), JSON.stringify(report, null, 2)) }
