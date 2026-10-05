/**
 * TEMPORARY diagnostic: drive the DESKTOP title bar's new switches in headless
 * Edge, with a Tauri bridge stub injected before page scripts so the page runs
 * the desktop bar rather than the reduced remote one.
 *
 * Verifies, against the real served page and the real 0.2 primitives:
 *   1. the full bar mounts with the four triggers and no slot error;
 *   2. 更多 ▸ 简易标题栏 removes the three service triggers and persists
 *      `data-dsh-titlebar-mode="simple"`;
 *   3. 更多 ▸ 完整标题栏 restores them;
 *   4. 更多 ▸ 关闭图标悬停 publishes `data-dsh-titlebar-hover="off"` and the
 *      gated hover rule stops matching a real bar item;
 *   5. 更多 ▸ 开启图标悬停 restores it.
 *
 * Usage: node tools/_titlebar-probe.mjs <url>
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const url = process.argv[2]
const edgePath = process.env.EDGE_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync)
if (!url || !edgePath) {
  console.error('usage: node tools/_titlebar-probe.mjs <url>')
  process.exit(2)
}

const profile = process.env.TEMP + '/dsh-titlebar-probe-profile'
const child = spawn(edgePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--remote-debugging-port=9224',
  `--user-data-dir=${profile}`,
  '--window-size=1280,800',
  url,
], { stdio: 'ignore' })
process.on('exit', () => { try { child.kill() } catch {} })

let targets = null
for (let i = 0; i < 60; i++) {
  await delay(500)
  try {
    targets = await (await fetch('http://127.0.0.1:9224/json')).json()
    if (targets.some((t) => t.type === 'page' && t.url.startsWith('http'))) break
  } catch {}
}
const page = targets && targets.find((t) => t.type === 'page' && t.url.startsWith('http'))
if (!page) {
  console.error('no page target:', JSON.stringify(targets, null, 1))
  process.exit(3)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const send = (method, params = {}) => {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
const errors = []
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.id !== undefined) {
    const slot = pending.get(m.id)
    if (!slot) return
    pending.delete(m.id)
    if (m.error) slot.reject(new Error(JSON.stringify(m.error)))
    else slot.resolve(m.result)
    return
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  }
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})
await send('Runtime.enable')
await send('Page.enable')

// The desktop shell injects `__TAURI__` into its own webview; a page without it
// is, by design, the REMOTE page (browser-compat marks it). This probe wants the
// desktop bar, so provide the same seam the shell would, with inert commands.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__TAURI__ = {
    core: { invoke: (cmd) => (cmd === 'window_is_maximized' ? Promise.resolve(false) : Promise.resolve(undefined)) },
    app: { getVersion: () => Promise.resolve('0.0.0-probe') },
  }`,
})
await send('Page.reload').catch(() => {})
await delay(10000)

const evalJson = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result.value
}

const state = () => evalJson(`(() => {
  const items = [...document.querySelectorAll('.dshTb__nav .dshTb__item')].map(b => b.textContent)
  return JSON.stringify({
    triggers: items,
    mode: document.documentElement.getAttribute('data-dsh-titlebar-mode'),
    hover: document.documentElement.getAttribute('data-dsh-titlebar-hover'),
    hasBar: Boolean(document.querySelector('.dshTb')),
    remote: document.documentElement.hasAttribute('data-dsh-browser'),
    slotError: Boolean(document.querySelector('[data-slot-error="shell.overlay"]')),
  })
})()`)

console.log('initial:', await state())

/** Open 更多, click the row named `label`, and settle. */
const clickMenuItem = async (label) => {
  const clicked = await evalJson(`(() => {
    const more = [...document.querySelectorAll('.dshTb__nav .dshTb__item')].find(b => b.textContent === '更多')
    if (!more) return 'no-more'
    more.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'opened'
  })()`)
  if (clicked !== 'opened') throw new Error(clicked)
  await delay(700)
  const row = await evalJson(`(() => {
    const row = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(b => b.textContent.trim() === ${JSON.stringify(label)})
    if (!row) return 'no-row: ' + [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(b => b.textContent.trim()).join('|')
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'clicked'
  })()`)
  if (row !== 'clicked') throw new Error(label + ': ' + row)
  await delay(1000)
}

const hoverProbe = () => evalJson(`(() => {
  const item = document.querySelector('.dshTb__nav .dshTb__item')
  let hoverRules = 0
  for (const sheet of document.styleSheets) {
    for (const r of sheet.cssRules) {
      if (r.selectorText && r.selectorText.includes('.dshTb__item:hover')) hoverRules += 1
    }
  }
  return JSON.stringify({
    hoverRuleWouldMatch: item ? item.matches("html:not([data-dsh-titlebar-hover='off']) .dshTb__item:hover") : null,
    hoverRulesInSheets: hoverRules,
  })
})()`)

await clickMenuItem('简易标题栏')
console.log('after 简易标题栏:', await state())
await clickMenuItem('完整标题栏')
console.log('after 完整标题栏:', await state())
await clickMenuItem('关闭图标悬停')
console.log('after 关闭图标悬停:', await state(), await hoverProbe())
await clickMenuItem('开启图标悬停')
console.log('after 开启图标悬停:', await state(), await hoverProbe())

if (errors.length) console.log('console errors:', errors)
socket.close()
child.kill()
process.exit(0)
