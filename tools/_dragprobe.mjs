/**
 * TEMPORARY: probe what actually happens on a real title-bar drag, end to end.
 *
 * Reports, in order:
 *   - whether the injected bar exists, and its rect
 *   - whether __TAURI__ is present
 *   - every capture-phase mousedown (target + coords), so a bar handler that
 *     never fires is visible
 *   - the RESULT of the window_start_drag invoke (resolved value / rejection),
 *     logged from the page the moment the drag press happens
 *   - focusin/focusout — wry's parent subclass calls MoveFocus on
 *     WM_ENTERSIZEMOVE, so a focus event during the drag is evidence the modal
 *     loop DID start
 *   - the window rect before/after
 *
 * Usage: node tools/_dragprobe.mjs <path-to-exe>
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

const state = await evaluate(`(() => {
  const bar = document.getElementById('dsh-desktop-titlebar-boot')
  const real = document.querySelector('.dshTb')
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height] }
  return {
    bootBar: !!bar, bootBarRect: r(bar),
    realBar: !!real, realBarRect: r(real),
    tauri: typeof window.__TAURI__,
    invoke: window.__TAURI__?.core ? 'ok' : 'missing',
    phase: (document.querySelector('.dshBoot__phase')||{}).textContent || document.body.textContent.slice(0, 60),
  }
})()`)
console.log('page state:', JSON.stringify(state, null, 1))

await evaluate(`
  window.__log = []
  document.addEventListener('mousedown', (e) => {
    const t = e.target
    window.__log.push(['md', e.clientX, e.clientY, t.id || t.className || t.tagName])
  }, true)
  document.addEventListener('focusin', () => window.__log.push(['focusin', document.activeElement?.tagName]))
  document.addEventListener('focusout', () => window.__log.push(['focusout']))
  window.__probeInvoke = () => {
    window.__TAURI__.core.invoke('window_start_drag').then(
      (v) => window.__log.push(['invoke-ok', JSON.stringify(v)]),
      (e) => window.__log.push(['invoke-err', String(e)]),
    )
  }
  // Wrap the bar handler's own invoke by listening on the bar itself, in
  // addition to its handler, and calling invoke with the same payload the bar
  // would send.
  const bar = document.getElementById('dsh-desktop-titlebar-boot') || document.querySelector('.dshTb')
  if (bar) bar.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('button')) window.__log.push(['bar-md']) })
  'armed'
`)

const rectOut = ps('-rect')
const [L, T] = rectOut.split('|').map(Number)
console.log('window at:', L, T)

console.log('--- real drag on the bar (long hold, so the IPC cannot be late) ---')
const before = ps('-rect')
console.log(ps(`-x ${L + 500} -y ${T + 20} -drag -x2 ${L + 590} -y2 ${T + 70} -holdms 1500`))
const after = ps('-rect')
console.log('rect:', before, '->', after)

const log = await evaluate('JSON.stringify(window.__log)')
console.log('page log:', log)

console.log('--- direct invoke with button up (guard should skip silently) ---')
await evaluate('window.__log = []; window.__probeInvoke()')
await sleep(400)
console.log('page log:', await evaluate('JSON.stringify(window.__log)'))

try { execSync('taskkill /IM deepseek-harness-desktop.exe /F', { stdio: 'ignore' }) } catch {}
socket.close()
console.log('DONE')
