/** Real WebView2 settings/import/preview and native notification checks.
 * Build with a separate app identity if another desktop instance is running:
 * PowerShell: $env:TAURI_CONFIG='{"identifier":"com.deepseek.harness.desktop.sound-smoke"}'
 * Then: cargo build --manifest-path src-tauri/Cargo.toml
 * Runs only in an isolated profile; existing desktop instances are not stopped.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createServer } from 'node:net'
import { handleOnboarding, dismissInitialWelcome, openDshSettings, offlineModelPatch } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = await mkdtemp(resolve('target/settings-desktop-')), home = join(root, 'home')
await mkdir(home)
await writeFile(join(home, 'cordis.patch.yml'), offlineModelPatch)
const exe = join(root, 'deepseek-harness-desktop.exe')
await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'), exe)
for (const [source, destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources)) {
  const target = join(root, destination)
  await mkdir(dirname(target), { recursive: true }); await copyFile(resolve('src-tauri', source), target)
}
const probe = join(root, 'dsh-plugin/sound-probe')
await mkdir(probe)
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/sound-probe', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings'] } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}\n')
await writeFile(join(probe, 'client.js'), "window.__ModuleLoader__.load({ id: '@dsh-desktop/sound-probe', factory: () => ({ inject: ['configForms'], apply(ctx) { window.__SOUND_SMOKE__ = ctx } }) })\n")
const patchFile = join(root, 'dsh-plugin/desktop-notify.patch.yml')
await writeFile(patchFile, await readFile(patchFile, 'utf8') + '\n- insert:\n    - id: desktop-sound-probe\n      name: ./sound-probe/index.js\n')
const report = { root, checks: [] }, errors = []
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, browser, page, sequence = 0
async function until(read, accept, timeout = 30000) {
  const deadline = Date.now() + timeout
  let last
  let failure
  while (Date.now() < deadline) {
    try { last = await read(); if (accept(last)) return last } catch (error) { failure = error }
    await sleep(100)
  }
  throw Error('Condition timed out: ' + JSON.stringify(last) + ' ' + (failure?.message || ''))
}
const state = () => readFile(join(root, 'state.json'), 'utf8').then(JSON.parse)
async function start() {
  await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: 0, action: 'none' }))
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const bin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
  child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
    ...process.env, DSH_HOME: home, DSH_DESKTOP_SMOKE_DIR: root, DSH_DESKTOP_DSH: bin,
    DSH_DESKTOP_NODE: process.execPath, DSH_UI_SMOKE_KEY: 'offline-fixture',
    DSH_DESKTOP_DEBUG: join(root, 'host.log'), DSH_DESKTOP_WEBVIEW_RESTORE: '1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
  } })
  await until(async () => {
    if (child.exitCode !== null) throw Error('Isolated desktop exited')
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); return browser
  }, Boolean, 40000)
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1:')), Boolean, 40000)
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) console.error(message.text()) })
  await handleOnboarding(page)
  await page.waitForFunction(() => window.__SOUND_SMOKE__?.configForms.get('desktop-appearance').getSnapshot().status === 'ready')
  await until(state, s => s.loaded && s.phase === 'active')
  // Onboarding is optional on restart; acknowledge it explicitly before another
  // modal opens, so its async close cannot dismiss the settings dialog.
  const welcome = page.getByRole('button', { name: /^(继续|我知道了|Continue|Got it)$/, includeHidden: true }).first()
  await welcome.waitFor({ state: 'attached', timeout: 2000 }).catch(() => {})
  if (await welcome.count()) await dismissInitialWelcome(page)
  await page.waitForFunction(() => !document.querySelector('#root')?.inert)
}
async function stop() {
  if (child?.exitCode === null) {
    await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: ++sequence, action: 'quit' }))
    await until(() => child.exitCode, code => code !== null, 15000).catch(() => {
      // This PID belongs to this script's isolated child, never the user's app.
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    })
  }
  await browser?.close().catch(() => {}); browser = null
}
const prefs = () => page.evaluate(() => window.__SOUND_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value.notifications)
async function openSound() {
  await openDshSettings(page)
  await page.getByRole('button', { name: '声音提醒', exact: true }).click()
  await page.locator('.dshSound').waitFor()
}
async function command(action, payload) {
  await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: ++sequence, action, payload }))
  await until(state, state => state.command === sequence)
}
function wav(seconds) {
  const count = Math.round(seconds * 22050), data = Buffer.alloc(44 + count * 2)
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(22050, 24); data.writeUInt32LE(44100, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34)
  data.write('data', 36); data.writeUInt32LE(count * 2, 40)
  for (let i = 0; i < count; i++) data.writeInt16LE(Math.sin(i / 22050 * Math.PI * 2 * 660) * 3000 * Math.min(1, i / 300, (count - i) / 300), 44 + i * 2)
  return data
}
try {
  await start(); await openSound()
  const nav = await page.locator('[data-shortcut-modal="settings"] nav button').allTextContents()
  assert.equal(nav[nav.findIndex(text => text.trim() === '外观') + 1].trim(), '声音提醒')
  assert.equal(await page.getByRole('switch', { name: '开启提醒', exact: true }).isChecked(), true)
  assert.equal(await page.getByRole('switch', { name: '播放声音', exact: true }).isChecked(), true)
  await page.screenshot({ path: join(root, 'sound-light.png') })
  pass('settings navigation places sound reminders immediately below appearance')

  await page.getByRole('switch', { name: '开启提醒', exact: true }).click()
  await until(state, s => !s.notifications.enabled)
  assert.equal(await page.getByRole('switch', { name: '播放声音', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '试听音效', exact: true }).isDisabled(), true)
  await command('notify', { kind: 'task-end', title: 'Muted fixture', body: '', sessionId: 'sound-muted' })
  assert.match(await readFile(join(root, 'host.log'), 'utf8'), /\[notify\/suppressed\] sound-muted/)
  await page.getByRole('switch', { name: '开启提醒', exact: true }).click()
  await until(state, s => s.notifications.enabled)
  await page.getByRole('switch', { name: '播放声音', exact: true }).click()
  await until(state, s => !s.notifications.soundEnabled)
  await command('notify', { kind: 'task-end', title: 'Silent fixture', body: 'Native silent notification', sessionId: 'sound-silent' })
  assert.match(await readFile(join(root, 'host.log'), 'utf8'), /\[notify\/submitted\] Silent fixture/)
  await page.getByRole('switch', { name: '播放声音', exact: true }).click()
  await until(state, s => s.notifications.soundEnabled)
  pass('notification and sound switches reach the native host; disabled notifications are suppressed')

  for (const label of ['默认', '系统']) {
    await page.locator('.dshSound__option').filter({ hasText: label }).click()
    await page.locator('.dshSound[aria-busy=false]').waitFor()
    await page.getByRole('button', { name: '试听音效', exact: true }).click()
    await page.getByRole('button', { name: '试听音效', exact: true }).waitFor()
    assert.equal(await page.locator('.dshSound [role=alert]').count(), 0)
  }
  pass('system and default presets preview through the native playback command')

  await page.locator('.dshSound input[type=file]').setInputFiles({ name: '自定义 提示.wav', mimeType: 'audio/wav', buffer: wav(.5) })
  await until(prefs, p => p?.sound === 'custom' && p.customName === '自定义 提示.wav')
  await until(state, s => s.notifications.sound === 'custom' && s.notifications.audioBytes > 44)
  const saved = await prefs()
  await page.getByRole('button', { name: '试听音效', exact: true }).click()
  await page.getByRole('button', { name: '停止试听', exact: true }).click()
  assert.equal(await page.locator('.dshSound [role=alert]').count(), 0)
  await page.locator('.dshSound input[type=file]').setInputFiles({ name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('broken') })
  await page.locator('.dshSound [role=alert]').waitFor()
  assert.deepEqual(await prefs(), saved)
  await page.locator('.dshSound input[type=file]').setInputFiles({ name: 'long.wav', mimeType: 'audio/wav', buffer: wav(31) })
  await page.getByRole('alert').filter({ hasText: '请选择不超过 30 秒的音频' }).waitFor()
  assert.deepEqual(await prefs(), saved)
  pass('custom audio imports, plays and stops; corrupt and long files preserve the previous clip')

  // Re-open to dismiss transient import errors, then verify dark palette.
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByRole('group', { name: '主题', exact: true }).getByRole('button', { name: '深色', exact: true }).click()
  await openSound()
  await page.screenshot({ path: join(root, 'sound-dark.png') })
  assert.equal(await page.locator('.dshSound').evaluate(el => el.scrollWidth <= el.clientWidth), true)
  await stop(); await start(); await openSound()
  assert.deepEqual(await prefs(), saved)
  await until(state, s => s.notifications.customName === saved.customName)
  await page.getByRole('button', { name: '试听音效', exact: true }).click()
  await page.getByRole('button', { name: '试听音效', exact: true }).waitFor()
  assert.equal(await page.locator('.dshSound [role=alert]').count(), 0)
  pass('custom sound survives a full desktop restart and previews without the source file')

  await page.keyboard.press('Escape')
  await command('close')
  assert.equal((await state()).visible, false)
  await command('notify', { kind: 'task-end', title: 'Tray fixture', body: 'Custom sound with hidden window', sessionId: 'sound-tray' })
  assert.match(await readFile(join(root, 'host.log'), 'utf8'), /\[notify\/submitted\] Tray fixture/)
  assert.doesNotMatch(await readFile(join(root, 'host.log'), 'utf8'), /\[notify\/audio-failed\]/)
  await command('show'); await openSound()
  await page.getByRole('button', { name: '移除音频', exact: true }).click()
  await until(prefs, p => p.sound === 'system' && p.customAudio === '' && p.customName === '')
  pass('tray notifications retain the custom sound; removing the clip restores system sound')
  assert.deepEqual(errors, [])
} catch (error) {
  report.error = error.stack
  if (page) {
    report.page = await page.locator('body').innerText().catch(() => '')
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  }
  throw error
} finally {
  await stop()
  report.pageErrors = errors
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Evidence: ' + root)
}
