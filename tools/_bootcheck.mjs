/**
 * TEMPORARY: navigate the live webview to the app's OWN boot page and inspect
 * whether the injected bar mounts there, capturing console output.
 *
 * The boot page is served from `http://tauri.localhost/`. A document-created script
 * runs on every navigation, so going back to it re-injects the bar — which makes
 * this a clean reproduction of what the user sees before DSH is up.
 */

const PORT = process.env.CDP_PORT ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error('no page target')
  process.exit(3)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const events = []
const send = (method, params) => {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.id === undefined) {
    // Console / log / exception notifications.
    if (m.method === 'Runtime.consoleAPICalled') {
      events.push({
        kind: 'console.' + m.params.type,
        text: (m.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '),
      })
    } else if (m.method === 'Log.entryAdded') {
      events.push({ kind: 'log.' + m.params.entry.level, text: m.params.entry.text })
    } else if (m.method === 'Runtime.exceptionThrown') {
      events.push({
        kind: 'exception',
        text: m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails),
      })
    }
    return
  }
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

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')

// Navigate to the app's own boot page.
await send('Page.navigate', { url: 'http://tauri.localhost/' })
await new Promise((r) => setTimeout(r, 2500))

const probe = `
(() => {
  const boot = document.getElementById('dsh-desktop-titlebar-boot');
  const style = document.getElementById('dsh-desktop-titlebar-boot-style');
  const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  return {
    url: location.href,
    readyState: document.readyState,
    bodyExists: !!document.body,
    bodyChildren: document.body ? [...document.body.children].map((n) => n.id || String(n.className).slice(0, 34) || n.tagName) : null,
    hasBootBar: !!boot,
    bootBarBox: boot ? box(boot) : null,
    bootBarZ: boot ? getComputedStyle(boot).zIndex : null,
    hasStyleTag: !!style,
    heightProp: getComputedStyle(document.documentElement).getPropertyValue('--dsh-desktop-titlebar-height'),
    guardFlag: window.__dshDesktopTitleBarBoot === true,
    hasTauri: !!(window.__TAURI__ && window.__TAURI__.core),
    hasTauriInternals: !!window.__TAURI_INTERNALS__,
    topIsSelf: (() => { try { return window.top === window } catch (e) { return 'throws' } })(),
  };
})()
`

const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true })
if (r.exceptionDetails) {
  console.error('probe exception:', r.exceptionDetails.exception?.description)
} else {
  console.log(JSON.stringify(r.result.value, null, 1))
}
console.log('\n=== console/log events ===')
console.log(JSON.stringify(events, null, 1))
socket.close()
