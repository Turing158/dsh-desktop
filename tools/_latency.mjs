/**
 * TEMPORARY: A/B for the UI-thread stall (`probe_state` on the main thread).
 *
 * Samples the IPC round-trip (`window_is_maximized`) from the moment the page
 * appears, through every boot phase change, with a 2.5 s watchdog per sample.
 * A synchronous `probe_state` blocks the message pump for as long as its
 * `node --version` spawn takes, and every queued invoke only answers after
 * that — so the stalled build shows multi-second samples while the page keeps
 * animating. The fixed build answers within the sample loop's own period.
 *
 * A real title-bar drag finishes the run: on the stalled build the drag's IPC
 * is processed after the release (the guard then refuses it) and the window
 * does not move; on the fixed build the command runs while the button is down
 * and the window follows.
 *
 * Usage: node tools/_latency.mjs <path-to-exe>
 */

import { execSync, spawn } from 'node:child_process'

const ROOT = 'D:/EducationalData/rust/DeepseekHarness-desktop'
const PORT = '9222'
const TOOLS = ROOT + '/tools'
const EXE = process.argv[2] ?? `${ROOT}/pack/portable/deepseek-harness-desktop.exe`

function ps(args) {
  return execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${TOOLS}/_click.ps1" ${args}`,
    { encoding: 'utf8', timeout: 30000 },
  ).trim()
}

try { execSync('taskkill /IM deepseek-harness-desktop.exe /F', { stdio: 'ignore' }) } catch {}
await new Promise((r) => setTimeout(r, 1200))
spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' },
  detached: false,
  stdio: 'ignore',
})

let page = null
for (let i = 0; i < 400 && !page; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  } catch {}
  if (!page) await new Promise((r) => setTimeout(r, 50))
}
if (!page) { console.log('no page target'); process.exit(1) }
console.log('attached to:', page.url)

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
function send(method, params) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const slot = pending.get(message.id)
  if (!slot) return
  pending.delete(message.id)
  if (message.error) slot.reject(new Error(JSON.stringify(message.error)))
  else slot.resolve(message.result)
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
  return result.result.value
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── the latency samples ────────────────────────────────────────────────────
const samples = []
const start = Date.now()
while (Date.now() - start < 20000) {
  const began = Date.now()
  let outcome
  try {
    outcome = await evaluate(`new Promise((res) => {
      const t = setTimeout(() => res('STALLED'), 2500)
      try {
        window.__TAURI__.core.invoke('window_is_maximized').then(
          () => { clearTimeout(t); res('ok') },
          (e) => { clearTimeout(t); res('err:' + e) },
        )
      } catch (e) { clearTimeout(t); res('no-bridge') }
    })`)
  } catch {
    // The document was replaced mid-sample (boot page → DSH navigation).
    outcome = 'nav'
  }
  samples.push({ at: Date.now() - start, ms: Date.now() - began, outcome })
  await sleep(120)
}

const stalled = samples.filter((s) => s.outcome === 'STALLED')
const slow = samples.filter((s) => s.outcome !== 'STALLED' && s.ms > 500)
console.log(`samples=${samples.length} stalled=${stalled.length} slow(>500ms)=${slow.length}`)
for (const s of samples) {
  console.log(`  +${String(s.at).padStart(6)}ms  took ${String(s.ms).padStart(6)}ms  ${s.outcome}`)
}

// ── a real drag on the title bar ───────────────────────────────────────────
const rectOut = ps('-rect')
const [L, T] = rectOut.split('|').map(Number)
const before = ps('-rect')
console.log(ps(`-x ${L + 500} -y ${T + 20} -drag -x2 ${L + 590} -y2 ${T + 70} -holdms 1200`))
const after = ps('-rect')
console.log('drag rect:', before, '->', after, before === after ? '(NOT MOVED)' : '(moved)')

try { execSync('taskkill /IM deepseek-harness-desktop.exe /F', { stdio: 'ignore' }) } catch {}
socket.close()
console.log('DONE')
