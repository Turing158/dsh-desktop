/**
 * TEMPORARY diagnostic: load the live page in headless Edge and capture every
 * console.error/warning and exception, so a slot crash that the slot system
 * swallows into `data-slot-error` becomes readable.
 *
 * Usage: CDP_PORT=9223 node tools/_console-capture.mjs <url> [waitMs]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const url = process.argv[2]
const waitMs = Number(process.argv[3] || 12000)
const edgePath = process.env.EDGE_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync)
if (!url || !edgePath) {
  console.error('usage: node tools/_console-capture.mjs <url> [waitMs]')
  process.exit(2)
}

const profile = process.env.TEMP + '/dsh-console-capture-profile'
const child = spawn(edgePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  `--remote-debugging-port=9223`,
  `--user-data-dir=${profile}`,
  '--window-size=1280,800',
  url,
], { stdio: 'ignore' })
process.on('exit', () => { try { child.kill() } catch {} })

// Wait for the debug endpoint.
let targets = null
for (let i = 0; i < 60; i++) {
  await delay(500)
  try {
    targets = await (await fetch('http://127.0.0.1:9223/json')).json()
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
const entries = []
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
  const { method, params } = m
  if (method === 'Runtime.consoleAPICalled') {
    const text = params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
    entries.push(`[console.${params.type}] ${text}`)
  } else if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails
    entries.push(`[exception] ${d.exception?.description ?? d.text}`)
  } else if (method === 'Log.entryAdded') {
    entries.push(`[${params.entry.source}] ${params.entry.text}`)
  }
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.reload').catch(() => {})
await delay(waitMs)

const state = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    titlebarAttr: document.documentElement.getAttribute('data-dsh-titlebar'),
    heightProp: document.documentElement.style.getPropertyValue('--dsh-desktop-titlebar-height'),
    hasRealBar: Boolean(document.querySelector('.dshTb')),
    slotError: Boolean(document.querySelector('[data-slot-error="shell.overlay"]')),
  })`,
  returnByValue: true,
})
console.log('PAGE STATE:', state.result.value ?? JSON.stringify(state))
console.log(`CONSOLE (${entries.length} entries):`)
for (const line of entries) console.log('  ' + line.slice(0, 2000))
socket.close()
child.kill()
process.exit(0)
