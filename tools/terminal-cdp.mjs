import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
export async function connect(port = 9341) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find(p => p.type === 'page' && p.webSocketDebuggerUrl)
  if (!page) throw Error('No isolated test WebView')
  const socket = new WebSocket(page.webSocketDebuggerUrl), pending = new Map()
  let next = 0
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once:true }); socket.addEventListener('error', reject, { once:true }) })
  socket.addEventListener('message', e => { const m = JSON.parse(e.data), p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result) } })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
  return { send, close: () => socket.close(), async evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || 'Evaluation failed')
    return r.result.value
  } }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cdp = await connect(Number(process.env.CDP_PORT || 9341))
  try { console.log(JSON.stringify(await cdp.evaluate(await readFile(process.argv[2], 'utf8')), null, 2)) } finally { cdp.close() }
}
