/** Verify cold startup with a legacy update record in an isolated profile. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { offlineModelPatch } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = await mkdtemp(resolve('src-tauri/target/native-upgrade-'))
const home = join(root, 'home'), exe = join(root, 'deepseek-harness-desktop.exe')
const bin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const version = JSON.parse(await readFile(join(dirname(dirname(bin)), 'package.json'), 'utf8')).version
await mkdir(home); await mkdir(join(root, 'runtime'))
await writeFile(join(home, 'cordis.patch.yml'), offlineModelPatch)
await copyFile(resolve(process.env.DSH_LEGACY_UPDATE_EXE || 'src-tauri/target/debug/deepseek-harness-desktop.exe'), exe)
for (const [source, destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources)) {
  await mkdir(dirname(join(root, destination)), { recursive: true })
  await copyFile(resolve('src-tauri', source), join(root, destination))
}
const checkpoint = randomUUID()
const runtime = { node_exe: process.execPath, dsh_bin: bin, source: 'configured', version }
const recordPath = join(root, 'runtime/update.json')
const record = JSON.stringify({ schema: 1, stage: 'committed', source: runtime, target: runtime,
  checkpoint: { home, saved: join(root, `.dsh-update-${checkpoint}-before`),
    failed: join(root, `.dsh-update-${checkpoint}-failed`), files: [] },
  ui_checkpoint: randomUUID(), selection: null })
await writeFile(recordPath, record)
await writeFile(join(root, 'command.json'), '{}')
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
  ...process.env, APPDATA: join(root, 'appdata'), DSH_HOME: home, DSH_DESKTOP_DSH: bin,
  DSH_DESKTOP_NODE: process.execPath, DSH_DESKTOP_SMOKE_DIR: root, DSH_UI_SMOKE_KEY: 'offline',
  DSH_DESKTOP_DEBUG: join(root, 'debug.log'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
} })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let browser
const report = { root, checks: [] }
try {
  let ready = false
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error('isolated desktop exited before startup')
    const state = await readFile(join(root, 'state.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (state?.backend === 'failed') throw Error('isolated backend failed; inspect debug.log')
    if (state?.backend === 'running' && state.loaded) {
      assert.equal(state.phase, 'active'); assert.equal(state.hasSnapshot, false)
      ready = true; break
    }
    await sleep(200)
  }
  assert.equal(ready, true, 'legacy update record permits normal startup')
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  let page
  const pageDeadline = Date.now() + 30000
  while (Date.now() < pageDeadline) {
    page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1:'))
    if (page) break
    if (child.exitCode !== null) throw Error('isolated desktop exited during navigation')
    await sleep(100)
  }
  assert.ok(page, 'desktop navigates from boot to the DSH page')
  await page.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0)
  assert.equal(await page.locator('[data-dsh-ui-status]').count(), 0)
  assert.equal(await readFile(recordPath, 'utf8'), record)
  assert.doesNotMatch(await readFile(join(root, 'debug.log'), 'utf8'), /update-record-invalid/)
  report.checks.push('legacy update record starts normally without rewriting it or restoring UI state')
  console.log('PASS: ' + report.checks[0])
} catch (error) {
  report.error = error.stack; throw error
} finally {
  await browser?.close().catch(() => {})
  if (child.exitCode === null) {
    await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: Date.now(), action: 'quit' }))
    const deadline = Date.now() + 10000
    while (child.exitCode === null && Date.now() < deadline) await sleep(100)
    if (child.exitCode === null) {
      child.kill()
      await new Promise(resolve => child.once('exit', resolve))
    }
  }
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Report: ' + root)
}
