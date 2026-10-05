/**
 * TEMPORARY probe runner: evaluate a file in the live page over CDP.
 * Usage: node tools/_r.mjs <probeFile>
 */
import { readFileSync } from 'node:fs'

const PORT = process.env.CDP_PORT ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error('no page target:', targets.map((t) => `${t.type} ${t.url}`))
  process.exit(3)
}
console.error(`[r] ${page.url}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const send = (method, params) => {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  const slot = pending.get(m.id)
  if (!slot) return
  pending.delete(m.id)
  if (m.error) slot.reject(new Error(JSON.stringify(m.error)))
  else slot.resolve(m.result)
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

const expression = readFileSync(process.argv[2], 'utf8')
const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
if (r.exceptionDetails) {
  console.error('[r] exception:', r.exceptionDetails.exception?.description)
  process.exit(4)
}
console.log(JSON.stringify(r.result.value, null, 1))
socket.close()
