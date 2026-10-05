/**
 * TEMPORARY: prove what the DOM looks like at DOCUMENT-CREATED time.
 *
 * The injected title bar runs as a WebView2 document-created script, which wry
 * documents as running "before the HTML document has been parsed". A script with the
 * same timing is registered here via `Page.addScriptToEvaluateOnNewDocument` (CDP's
 * equivalent), and it records what `document.documentElement` and `document.body`
 * actually are at that moment.
 *
 * This decides whether `document.documentElement.getAttribute(...)` at the top level
 * of the injected bar can throw.
 */

const PORT = process.env.CDP_PORT ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error('no page target')
  process.exit(3)
}
console.error('[timing] inspecting', page.url)

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

await send('Page.enable')
await send('Runtime.enable')

// The recorder. Runs at document-created time, exactly like the app's bar.
const recorder = `
  globalThis.__docStartProbe = (() => {
    const snapshot = {
      documentElementIsNull: document.documentElement === null,
      documentElementTag: document.documentElement ? document.documentElement.tagName : null,
      bodyIsNull: document.body === null,
      headIsNull: document.head === null,
      readyState: document.readyState,
    };
    // The exact call the injected bar makes at its top level.
    try {
      const value = document.documentElement.getAttribute('data-dsh-titlebar');
      snapshot.getAttributeThrew = false;
      snapshot.getAttributeValue = value;
    } catch (error) {
      snapshot.getAttributeThrew = true;
      snapshot.getAttributeError = String(error);
    }
    return snapshot;
  })();
`

const added = await send('Page.addScriptToEvaluateOnNewDocument', { source: recorder })

// A real navigation so document-created runs again.
await send('Page.navigate', { url: page.url })
await new Promise((r) => setTimeout(r, 2500))

const result = await send('Runtime.evaluate', {
  expression: 'JSON.stringify(globalThis.__docStartProbe ?? null)',
  returnByValue: true,
})
console.log('at document-created time:', result.result.value)

await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier })
socket.close()
