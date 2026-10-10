/** Verify a packaged exe's actual startup/notification path and read-only reuse.
 * Run with all desktop instances closed:
 *   node tools/notification-package-smoke.mjs <single-exe>
 * The Node preload emits one synthetic completion before DSH starts a server.
 * No model task or LAN listener is started. Normal per-user registration is kept
 * pointing to the supplied exe; two test notifications may remain in Action Center.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const exec = promisify(execFile)
const exe = resolve(process.argv[2] || 'pack/single/deepseek-harness-desktop.exe')
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const runPs = (script) => exec(powershell, ['-NoProfile', '-Command', script], {
  windowsHide: true, timeout: 15000,
})
const active = await runPs("Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('dsh-desktop.exe','deepseek-harness-desktop.exe') } | Select-Object -ExpandProperty ProcessId")
assert.equal(active.stdout.trim(), '', 'Close running desktop instances before testing; they will not be stopped by this tool')
await stat(exe)
const root = await mkdtemp(resolve('src-tauri/target/notification-package-'))
const report = { exe, root, rounds: [] }
const history = join(root, 'history.ps1')
await writeFile(history, '\ufeff' + `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
$items = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('com.deepseek.harness.desktop')
foreach ($item in $items) { $item.Content.GetXml() }
`, 'utf8')

async function launch(round) {
  const marker = 'notification-package-' + randomUUID()
  const preload = join(root, `preload-${round}.cjs`)
  const log = join(root, `host-${round}.log`)
  const payload = { kind: 'task-end', reason: 'completed', title: 'DSH 单文件通知测试',
    body: `第 ${round} 次启动验证 · ${marker}`, sessionId: marker }
  await writeFile(preload, `
if (process.argv.includes('web')) {
  require('node:fs').writeSync(1, ${JSON.stringify('__DSH_NOTIFY__ ' + JSON.stringify(payload) + '\n')});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45000);
  process.exit(0);
}
`, 'utf8')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(node_options|dsh_home|dsh_desktop_.*|webview2_.*)$/i.test(key)) delete env[key]
  Object.assign(env, {
    DSH_HOME: join(root, 'dsh-home'), DSH_DESKTOP_DEBUG: log,
    WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
    NODE_OPTIONS: '--require=' + JSON.stringify(preload), npm_config_offline: 'true',
  })
  const child = spawn(exe, [], { cwd: root, env, windowsHide: true, stdio: 'ignore' })
  const exited = new Promise(resolve => child.once('close', resolve))
  let failure
  child.once('error', error => { failure = error })
  const deadline = Date.now() + 30000
  try {
    let output = ''
    while (!output.includes('[notify/submitted]')) {
      if (failure) throw failure
      assert.equal(child.exitCode, null, 'Desktop exited before submitting the notification')
      assert.ok(Date.now() < deadline, 'No notification submission; inspect ' + log)
      output = await readFile(log, 'utf8').catch(() => '')
      assert.ok(!output.includes('[notify/registration-failed]'), output)
      assert.ok(!output.includes('[notify/failed]'), output)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const match = output.match(/\[notify\/registration\] (updated|unchanged) (.+)/)
    assert.ok(match, 'Missing registration result')
    const shortcut = match[2].trim()
    const contents = await readFile(shortcut)
    const modified = (await stat(shortcut)).mtimeMs
    let seen = false
    while (!seen && Date.now() < deadline) {
      const result = await exec(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', history], {
        windowsHide: true, timeout: 15000,
      })
      seen = result.stdout.includes(marker)
      if (!seen) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(seen, 'Submission succeeded but the specific toast did not reach Action Center')
    report.rounds.push({ round, registration: match[1], shortcut, modified, log, history: true })
    console.log(`PASS round ${round}: ${match[1]} registration; real toast in Action Center`)
    return { shortcut, contents, modified }
  } finally {
    if (child.exitCode === null) child.kill()
    await exited
  }
}

try {
  const first = await launch(1)
  const second = await launch(2)
  assert.equal(report.rounds[1].registration, 'unchanged')
  assert.equal(second.shortcut, first.shortcut)
  assert.equal(second.modified, first.modified, 'Second startup rewrote shortcut metadata')
  assert.deepEqual(second.contents, first.contents, 'Second startup rewrote shortcut contents')
  console.log('PASS restart reuses the shortcut without writing it')
} catch (error) {
  report.error = error.message
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('Report: ' + join(root, 'report.json'))
}
