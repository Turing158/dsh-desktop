/**
 * TEMPORARY: point the running app's webview at a plain 127.0.0.1 page, then
 * inspect whether the injected title bar mounted there.
 *
 * WHY THIS IS THE RIGHT EXPERIMENT. `boot.js` refuses any origin that is not the
 * app's own protocol or its loopback server, so this page qualifies — and it is a
 * NORMAL document, unlike the app's boot page, which is served from
 * `tauri.localhost`. Navigating a real WebView2 window to it reproduces the exact
 * document-created timing that broke the bar, with none of the app's own boot
 * machinery in the way.
 *
 * If the bar mounts here, the timing fix works; if it does not, the bug is still
 * live and this reports the console error verbatim.
 */

const PORT = process.env.CDP_PORT ?? '9222'
const TARGET_URL = process.argv[2] ?? 'http://127.0.0.1:18080/'

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error('no page target:', JSON.stringify(targets.map((t) => `${t.type} ${t.url}`)))
  process.exit(3)
}
console.error('[nav] from', page.url, '->', TARGET_URL)

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
    if (m.method === 'Runtime.exceptionThrown') {
      events.push({
        kind: 'exception',
        text:
          m.params.exceptionDetails?.exception?.description ??
          JSON.stringify(m.params.exceptionDetails).slice(0, 300),
      })
    } else if (m.method === 'Runtime.consoleAPICalled') {
      events.push({
        kind: 'console.' + m.params.type,
        text: (m.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300),
      })
    } else if (m.method === 'Log.entryAdded') {
      events.push({ kind: 'log.' + m.params.entry.level, text: m.params.entry.text.slice(0, 300) })
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
await send('Page.navigate', { url: TARGET_URL })
await new Promise((r) => setTimeout(r, 3000))

const probe = `
(() => {
  const boot = document.getElementById('dsh-desktop-titlebar-boot');
  const style = document.getElementById('dsh-desktop-titlebar-boot-style');
  const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  return {
    url: location.href,
    readyState: document.readyState,
    hasBootBar: !!boot,
    bootBarBox: boot ? box(boot) : null,
    bootBarZ: boot ? getComputedStyle(boot).zIndex : null,
    bootBarParent: boot ? boot.parentElement.tagName : null,
    buttons: boot ? [...boot.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) : null,
    menuLabels: boot ? [...boot.querySelectorAll('.dshBoot__item')].map((b) => b.textContent.trim()) : null,
    brandText: boot ? (boot.querySelector('.dshBoot__brand') || {}).textContent : null,
    controlsHost: boot ? (boot.querySelector('.dshBoot__controls') || {}).getAttribute?.('data-host') : null,
    hasStyle: !!style,
    heightProp: getComputedStyle(document.documentElement).getPropertyValue('--dsh-desktop-titlebar-height'),
    guardFlag: window.__dshDesktopTitleBarBoot === true,
    hasTauri: !!(window.__TAURI__ && window.__TAURI__.core),
  };
})()
`
const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(r.result.value, null, 1))
console.log('\n=== events ===')
console.log(JSON.stringify(events, null, 1))
socket.close()
