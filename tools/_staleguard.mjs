/**
 * TEMPORARY: A/B test for the stale-drag guard (`src-tauri/src/drag_guard.rs`).
 *
 * Reproduces the exact race deterministically instead of hoping a cold start
 * is slow enough: post `WM_NCLBUTTONDOWN(HTCAPTION)` to the window while no
 * button is held — the message tao's `handle_os_dragging` posts, which an
 * unguarded window turns into a modal move loop on the next pump. The loop
 * captures the mouse, so the next REAL click (SendInput) is eaten before it
 * reaches the page; the click after that un-sticks the loop.
 *
 *   unguarded exe: stale post → click 1 eaten (mousedowns 0) → click 2 lands
 *   guarded exe:   stale post → click 1 lands (mousedowns 1) — the subclass
 *                  swallowed the message, no loop ever existed
 *
 * A real drag on the title bar finishes the run, so a fix that swallowed
 * everything would also be caught: the window must still move.
 *
 * Usage: node tools/_staleguard.mjs <path-to-exe>
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

// Attach to the page target, but only once its URL has stopped moving: the
// boot page navigates to the DSH server, and a recorder armed before that is
// destroyed with the document.
let page = null
let stable = 0
for (let i = 0; i < 300 && stable < 2; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const found = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (found && page && found.url === page.url) stable += 1
    else stable = 0
    page = found
  } catch {}
  await new Promise((r) => setTimeout(r, 100))
}
if (!page) {
  console.log('RESULT: no page target appeared')
  process.exit(1)
}
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

await evaluate(`
  window.__diag = { mousedowns: 0 }
  document.addEventListener('mousedown', () => window.__diag.mousedowns++, true)
  'ok'
`)

const rectOut = ps('-rect')
const [L, T] = rectOut.split('|').map(Number)
console.log('window at:', L, T)

// The stale drag: the exact message an unguarded pump turns into the loop.
console.log(execSync(
  `powershell -NoProfile -ExecutionPolicy Bypass -File "${TOOLS}/_stalepost.ps1"`,
  { encoding: 'utf8', timeout: 30000 },
).trim())
await sleep(400)

const downs = async () => (await evaluate('window.__diag.mousedowns'))

// Click 1: eaten by the modal loop on an unguarded exe; reaches the page when
// the guard swallowed the stale message.
await ps(`-x ${L + 600} -y ${T + 300}`)
await sleep(300)
const afterFirst = await downs()
console.log('mousedowns after click 1:', afterFirst)

// Click 2: on an unguarded exe its UP is what releases the loop.
await ps(`-x ${L + 600} -y ${T + 320}`)
await sleep(300)
const afterSecond = await downs()
console.log('mousedowns after click 2:', afterSecond)

// A real drag must still work: press on the bar, move, release.
const before = ps('-rect')
await ps(`-x ${L + 500} -y ${T + 20} -drag -x2 ${L + 590} -y2 ${T + 70}`)
const after = ps('-rect')
console.log('drag rect:', before, '->', after)

try { execSync('taskkill /IM deepseek-harness-desktop.exe /F', { stdio: 'ignore' }) } catch {}
socket.close()
console.log('DONE')
