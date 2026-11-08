// Run against an isolated, committed fixture created by startup-benchmark.mjs.
// Exercises actual Tauri IPC, backend failure, integrity diagnostics and retry.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, copyFile, unlink, lstat } from 'node:fs/promises'
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path'
import { createServer } from 'node:net'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
assert.ok(process.argv[2], 'Pass an isolated startup-benchmark fixture root')
const root = resolve(process.argv[2]), boundary = resolve('src-tauri/target'), part = relative(boundary, root)
assert.ok(part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part))
for (let path = root; ; path = dirname(path)) {
  assert.ok(!(await lstat(path)).isSymbolicLink(), 'fixture ancestors must not be linked')
  if (path === dirname(path)) break
}
const selectionPath = join(root, 'runtime/selection.json'), selectionBytes = await readFile(selectionPath)
const selected = JSON.parse(selectionBytes), versionRoot = join(root, 'runtime/versions', selected.active)
const manifest = JSON.parse(await readFile(join(versionRoot, 'manifest.json'), 'utf8'))
const inventory = JSON.parse(await readFile(join(versionRoot, 'inventory.json'), 'utf8'))
const entry = join(versionRoot, 'tree', manifest.entry), originalEntry = await readFile(entry)
const receipt = join(root, 'runtime/verified', selected.active + '.bin')
const originalReceipt = await readFile(receipt).catch(e => { if (e.code !== 'ENOENT') throw e })
const extra = join(dirname(entry), 'startup-integrity-unexpected.txt')
for (const target of [entry, receipt, extra]) {
  const part = relative(root, target)
  assert.ok(part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part))
  for (let path = target; path !== root; path = dirname(path)) {
    const info = await lstat(path).catch(e => { if (e.code !== 'ENOENT') throw e })
    assert.ok(!info?.isSymbolicLink(), 'mutation path must not be linked')
  }
}
assert.equal(await lstat(extra).catch(e => { if (e.code !== 'ENOENT') throw e }), undefined)
const exe = join(root, 'integrity-check.exe')
await copyFile(resolve(process.argv[3] || 'src-tauri/target/debug/deepseek-harness-desktop.exe'), exe)
for (const [source, destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources)) {
  await mkdir(dirname(join(root, destination)), { recursive: true })
  await copyFile(resolve('src-tauri', source), join(root, destination))
}
const report = { schema: 1, version: manifest.version, files: manifest.fileCount, checks: [] }
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, browser, page, log
async function until(fn, description, timeout = 180000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw Error('desktop exited during ' + description)
    try { const value = await fn(); if (value) return value } catch (e) {
      if (/Execution context was destroyed|Cannot read properties of undefined.*(?:core|invoke)/.test(e.message)) { await sleep(100); continue }
      if (!['ENOENT', 'ECONNREFUSED'].includes(e.code) && !(e instanceof SyntaxError)) throw e
    }
    await sleep(100)
  }
  throw Error('timeout: ' + description)
}
const state = async () => JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
const invoke = command => page.evaluate(command => window.__TAURI__.core.invoke(command, { identity: window.__DSH_REMOTE_IDENTITY__ }), command)
const integrity = value => value.checks.find(check => check.id === 'runtime-integrity')
async function activePage(failed = false) {
  page = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => failed ? p.url().includes('tauri.localhost') : p.url().startsWith('http://127.0.0.1:')), 'main page')
  await page.waitForFunction(() => !!window.__TAURI__)
  if (!failed) await page.waitForFunction(() => !!window.__DSH_REMOTE_IDENTITY__ && !!window.__DSH_UI_STATE__ && document.querySelector('#root')?.childElementCount > 0, null, { timeout: 120000 })
}
async function start(label, failed = false) {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  log = join(root, 'integrity-' + label + '.log')
  for (const file of ['state.json', 'command.json']) await writeFile(join(root, file), '{}')
  await writeFile(log, '')
  const env = { ...process.env, APPDATA: join(root, 'appdata'), DSH_HOME: join(root, 'home'), DSH_DESKTOP_SMOKE_DIR: root,
    DSH_DESKTOP_NODE: process.execPath, DSH_DESKTOP_DEBUG: log, DSH_UI_SMOKE_KEY: 'offline', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port }
  delete env.DSH_DESKTOP_DSH
  child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: 'ignore', env })
  await until(async () => (await state()).backend === (failed ? 'failed' : 'running'), 'backend state')
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  await activePage(failed)
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
  for (const mode of ['missing', 'corrupt']) {
    if (mode === 'missing') await unlink(receipt).catch(e => { if (e.code !== 'ENOENT') throw e })
    else await writeFile(receipt, 'invalid receipt')
    await start(mode)
    assert.equal((await state()).runtime.source, 'managed')
    const text = await readFile(log, 'utf8')
    assert.match(text, /selection mode=lightweight/)
    assert.doesNotMatch(text, /verify files=/)
    assert.equal((await invoke('desktop_diagnostics')).checks.length, 0)
    pass(mode + ' verification receipt does not trigger a startup scan')
    if (mode === 'corrupt') {
      let result = await invoke('desktop_diagnostics_check')
      assert.equal(integrity(result).status, 'available')
      const verified = [...(await readFile(log, 'utf8')).matchAll(/verify files=(\d+) hashed=(\d+)/g)]
      assert.ok(verified.some(m => Number(m[1]) === inventory.files.length && Number(m[2]) === inventory.files.length))
      pass('manual diagnostics rehash every file and repair the receipt')
      await writeFile(extra, 'unexpected content')
      result = await invoke('desktop_diagnostics_check')
      assert.equal(integrity(result).reasonCode, 'runtime-integrity-failed')
      await unlink(extra)
      pass('manual diagnostics detect an unexpected file while the backend remains usable')
    }
    await stop()
  }
  await writeFile(entry, 'throw new Error("isolated-startup-integrity-failure")')
  await start('broken-entry', true)
  await until(async () => integrity(await invoke('desktop_diagnostics'))?.reasonCode === 'runtime-integrity-failed', 'automatic failure diagnosis')
  assert.match(await readFile(log, 'utf8'), /selection mode=lightweight/)
  pass('actual backend startup fails and triggers full integrity diagnostics')
  await writeFile(entry, originalEntry)
  await invoke('retry_boot')
  await until(async () => (await state()).backend === 'running', 'repaired retry')
  await activePage()
  assert.equal((await invoke('desktop_diagnostics')).checks.length, 0, 'previous failure must not describe the new backend')
  pass('repair and retry start successfully and discard stale diagnostic results')
  await stop()
  await unlink(entry)
  await start('missing-entry', true)
  await until(async () => integrity(await invoke('desktop_diagnostics'))?.reasonCode === 'runtime-integrity-failed', 'missing entry diagnosis')
  assert.doesNotMatch(await readFile(log, 'utf8'), /stage=backend-spawned/)
  pass('missing entry fails before spawn without switching to another installation')
  assert.deepEqual(await readFile(selectionPath), selectionBytes)
} catch (error) { report.error = error.stack; throw error }
finally {
  await stop()
  await writeFile(entry, originalEntry)
  await unlink(extra).catch(e => { if (e.code !== 'ENOENT') throw e })
  if (originalReceipt) await writeFile(receipt, originalReceipt)
  else await unlink(receipt).catch(e => { if (e.code !== 'ENOENT') throw e })
  await writeFile(join(root, 'startup-integrity-report.json'), JSON.stringify(report, null, 2))
}
