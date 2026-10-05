/**
 * TEMPORARY diagnostic: drive the 外观 settings section's two new rows in
 * headless Edge with a Tauri bridge stub, so the desktop bar mounts.
 *
 * Verifies: the settings dialog opens, the 外观 section renders the 标题栏 and
 * 标题栏图标悬停 rows, clicking 简易 flips `data-dsh-titlebar-mode`, clicking
 * 关闭 flips `data-dsh-titlebar-hover`, and no error is logged.
 *
 * Usage: node tools/_appearance-probe.mjs <url>
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
  console.error('usage: node tools/_appearance-probe.mjs <url>')
  process.exit(2)
}

const profile = process.env.TEMP + '/dsh-appearance-probe-profile'
const child = spawn(edgePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--remote-debugging-port=9226',
  `--user-data-dir=${profile}`,
  '--window-size=1280,900',
  url,
], { stdio: 'ignore' })
process.on('exit', () => { try { child.kill() } catch {} })

let targets = null
for (let i = 0; i < 60; i++) {
  await delay(500)
  try {
    targets = await (await fetch('http://127.0.0.1:9226/json')).json()
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
    errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 250))
  }
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})
await send('Runtime.enable')
await send('Page.enable')
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

console.log('mounted:', await evalJson(`JSON.stringify({
  bar: Boolean(document.querySelector('.dshTb')),
  remote: document.documentElement.hasAttribute('data-dsh-browser'),
  mode: document.documentElement.getAttribute('data-dsh-titlebar-mode'),
})`))

// Open settings through the trigger the title bar's own 设置 item would click.
const opened = await evalJson(`(() => {
  const trigger = document.querySelector('button[aria-haspopup="dialog"]')
  if (!trigger) return 'no-trigger'
  trigger.click()
  return 'opened'
})()`)
console.log('settings:', opened)
await delay(1500)

// Move to the 外观 section if it is not the active one, then click the row
// options by their visible labels.
const clickOption = async (label) => {
  const result = await evalJson(`(() => {
    const sectionLinks = [...document.querySelectorAll('button, a, [role="tab"]')].filter((el) => el.textContent.trim() === '外观')
    if (sectionLinks.length > 0) sectionLinks[0].click()
    return 'nav:' + sectionLinks.length
  })()`)
  await delay(700)
  const clicked = await evalJson(`(() => {
    // 关闭/开启 appear in BOTH the 动画 row and the 标题栏图标悬停 row; the
    // hover row renders after it, so take the LAST matching option.
    const options = [...document.querySelectorAll('.dshAppearance__option')].filter((el) => el.textContent.trim() === ${JSON.stringify(label)})
    const option = options[options.length - 1]
    if (!option) return 'no-option: ' + [...document.querySelectorAll('.dshAppearance__option')].map((el) => el.textContent.trim()).join('|')
    option.click()
    return 'clicked:' + options.length
  })()`)
  if (!clicked.startsWith('clicked')) throw new Error(label + ' -> ' + clicked)
  await delay(1000)
}

console.log('appearance nav:', await evalJson(`JSON.stringify({
  options: [...document.querySelectorAll('.dshAppearance__option')].map((el) => el.textContent.trim()),
})`))

await clickOption('简易')
console.log('after 简易:', await evalJson(`JSON.stringify({ mode: document.documentElement.getAttribute('data-dsh-titlebar-mode') })`))
await clickOption('完整')
console.log('after 完整:', await evalJson(`JSON.stringify({ mode: document.documentElement.getAttribute('data-dsh-titlebar-mode') })`))
await clickOption('关闭')
console.log('after 关闭:', await evalJson(`JSON.stringify({ hover: document.documentElement.getAttribute('data-dsh-titlebar-hover') })`))
await clickOption('开启')
console.log('after 开启:', await evalJson(`JSON.stringify({ hover: document.documentElement.getAttribute('data-dsh-titlebar-hover') })`))

if (errors.length) console.log('console errors:', errors)
socket.close()
child.kill()
process.exit(0)
