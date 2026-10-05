/* Full real-input reproduction during the boot phase of the RELEASE exe.
   SendInput = OS-level physical input (what the user's mouse does). */
import { execSync, spawn } from 'node:child_process'

const ROOT = 'D:/EducationalData/rust/DeepseekHarness-desktop'
const PORT = '9222'
const TOOLS = ROOT + '/tools'

function ps(args) {
  return execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${TOOLS}/_click.ps1" ${args}`,
    { encoding: 'utf8', timeout: 30000 },
  ).trim()
}

try { execSync('taskkill /IM deepseek-harness-desktop.exe /F', { stdio: 'ignore' }) } catch {}
await new Promise((r) => setTimeout(r, 1200))
spawn(`${ROOT}/pack/portable/deepseek-harness-desktop.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' },
  detached: false,
  stdio: 'ignore',
})

let page = null
for (let i = 0; i < 200; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    page = targets.find((t) => t.type === 'page' && t.url.indexOf('tauri.localhost') !== -1)
    if (page) break
  } catch {}
  await new Promise((r) => setTimeout(r, 50))
}
if (!page) {
  console.log('RESULT: boot page never appeared (boot too fast to test)')
  process.exit(0)
}
console.log('attached to boot page')

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
  return result.result.value
}

const ipcCheck = async (label) => {
  const r = await evaluate(`new Promise((resolve) => {
    const t = setTimeout(() => resolve('BLOCKED'), 2500)
    window.__TAURI__.core.invoke('window_is_maximized').then((v) => { clearTimeout(t); resolve('OK ' + v) }, (e) => { clearTimeout(t); resolve('ERR ' + e) })
  })`)
  console.log(`  IPC[${label}]: ${r}`)
  return r
}

const rectOut = ps('-rect')
const [L, T] = rectOut.split('|').map(Number)
console.log('window at:', L, T)

await evaluate(`
  window.__diag = { mousedowns: [], clicks: [] }
  document.addEventListener('mousedown', (e) => window.__diag.mousedowns.push([e.clientX, e.clientY]), true)
  document.addEventListener('click', (e) => window.__diag.clicks.push([e.clientX, e.clientY]), true)
  'ok'
`)

console.log('STEP 1: SendInput quick click on bar drag area')
console.log('  ps:', ps(`-x ${L + 500} -y ${T + 20}`))
await sleep(300)
let diag = await evaluate('JSON.stringify(window.__diag)')
console.log('  diag:', diag)
await ipcCheck('after quick click')

console.log('STEP 2: SendInput click on 更多')
console.log('  ps:', ps(`-x ${L + 189} -y ${T + 20}`))
await sleep(400)
const menuState = await evaluate(`(() => {
  const m = document.querySelector('.dshBoot__menu')
  return { menuOpen: !!m }
})()`)
console.log('  menu open:', JSON.stringify(menuState))
diag = await evaluate('JSON.stringify(window.__diag)')
console.log('  diag:', diag)
await ipcCheck('after menu click')

console.log('STEP 3: SendInput DRAG on bar (press, move +80/+40, release)')
const before = ps('-rect')
console.log('  ps:', ps(`-x ${L + 500} -y ${T + 20} -drag -x2 ${L + 580} -y2 ${T + 60}`))
const after = ps('-rect')
console.log('  rect before:', before, ' after:', after)
diag = await evaluate('JSON.stringify(window.__diag)')
console.log('  diag:', diag)
await ipcCheck('after drag')

const phase = await evaluate(
  `document.querySelector('.dshBoot__phase') ? document.querySelector('.dshBoot__phase').textContent : document.body.textContent.slice(0, 80)`,
)
console.log('boot phase text:', JSON.stringify(phase))

socket.close()
console.log('DONE — app left running')
