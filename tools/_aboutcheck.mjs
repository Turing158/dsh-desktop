/**
 * TEMPORARY: end-to-end check of the 关于 dialog on BOTH title bars, live.
 *
 *   boot bar (injected, before DSH): 更多 → 关于 → .dshBoot__overlay dialog
 *   real bar (DSH client plugin):    更多 → 关于 → the app's Modal (.dshTb__about)
 *
 * Drives each path with element.click() (the handlers are click-based), asserts
 * the dialog opens and closes, and captures a screenshot of each while open.
 *
 * Usage: node tools/_aboutcheck.mjs
 */

import { execSync, spawn } from 'node:child_process'

const ROOT = 'D:/EducationalData/rust/DeepseekHarness-desktop'
const PORT = '9222'
const TOOLS = ROOT + '/tools'

try { execSync('taskkill /IM deepseek-harness-desktop.exe /F', { stdio: 'ignore' }) } catch {}
await new Promise((r) => setTimeout(r, 1200))
spawn(`${ROOT}/pack/portable/deepseek-harness-desktop.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' },
  detached: false,
  stdio: 'ignore',
})

let page = null
for (let i = 0; i < 400 && !page; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  } catch {}
  if (!page) await new Promise((r) => setTimeout(r, 50))
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

/** Click 更多 → 关于 on the INJECTED bar and report what opened. */
async function testBootBar() {
  const opened = await evaluate(`(() => {
    const trigger = document.querySelector('.dshBoot__item')
    if (!trigger) return 'no-bar'
    trigger.click()
    const item = document.querySelector('.dshBoot__menu [role="menuitem"]')
    if (!item) return 'no-menu'
    if (item.textContent !== '关于') return 'wrong-item:' + item.textContent
    item.click()
    return 'clicked'
  })()`)
  await sleep(400)
  const state = await evaluate(`(() => {
    const overlay = document.querySelector('.dshBoot__overlay')
    if (!overlay) return { open: false }
    const dialog = overlay.querySelector('[role="dialog"]')
    return {
      open: true,
      isDialog: !!dialog,
      modal: dialog?.getAttribute('aria-modal'),
      version: overlay.querySelector('.dshBoot__aboutVersion')?.textContent ?? null,
      name: overlay.querySelector('.dshBoot__aboutName')?.textContent ?? null,
    }
  })()`)
  return { opened, state }
}

async function closeBootDialog() {
  return evaluate(`(() => {
    const close = document.querySelector('.dshBoot__aboutClose')
    if (!close) return 'not-open'
    close.click()
    return document.querySelector('.dshBoot__overlay') ? 'still-open' : 'closed'
  })()`)
}

/** Click 更多 → 关于 on the REAL bar and report what opened. */
async function testRealBar() {
  const opened = await evaluate(`(() => {
    const triggers = [...document.querySelectorAll('.dshTb__item')]
    const more = triggers.find((b) => b.textContent === '更多')
    if (!more) return 'no-more'
    more.click()
    return 'clicked'
  })()`)
  await sleep(350)
  const chosen = await evaluate(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    const about = items.find((el) => el.textContent === '关于')
    if (!about) return 'no-about-item'
    about.click()
    return 'clicked'
  })()`)
  await sleep(450)
  const state = await evaluate(`(() => {
    const about = document.querySelector('.dshTb__about')
    if (!about) return { open: false }
    const dialog = about.closest('[role="dialog"], .dsw-modal, [class*="modal"]') || about
    const version = [...about.querySelectorAll('*')].map((el) => el.textContent).find((t) => /^版本/.test(t)) ?? null
    return { open: true, inDialog: dialog !== about, version }
  })()`)
  return { opened, chosen, state }
}

async function closeRealDialog() {
  const clicked = await evaluate(`(() => {
    const about = document.querySelector('.dshTb__about')
    if (!about) return 'not-open'
    const buttons = [...about.closest('body').querySelectorAll('button')]
    const close = buttons.find((b) => b.textContent.trim() === '关闭')
    if (!close) return 'no-close'
    close.click()
    return 'clicked'
  })()`)
  // The app's Modal animates its exit; the element lingers for a few frames.
  await sleep(700)
  const gone = await evaluate(`!document.querySelector('.dshTb__about')`)
  return clicked + ' → ' + (gone ? 'closed' : 'still-open')
}

// ── drive both bars, in whichever order they appear ──────────────────────────
let bootDone = false
let realDone = false
const deadline = Date.now() + 150000

while (Date.now() < deadline && !(bootDone && realDone)) {
  const which = await evaluate(`(() => ({
    boot: !!document.getElementById('dsh-desktop-titlebar-boot'),
    real: !!document.querySelector('.dshTb'),
    url: location.href,
  }))()`).catch(() => ({ boot: false, real: false, url: 'nav' }))
  if (process.env.ABOUT_VERBOSE) console.log('  poll:', JSON.stringify(which))

  if (!bootDone && which.boot) {
    console.log('── boot bar ──')
    const { opened, state } = await testBootBar()
    console.log('  open path:', opened, '| state:', JSON.stringify(state))
    if (state.open) {
      execSync(`node ${ROOT}/tools/_winshot.mjs "$TEMP/dsh-about-boot.png"`.replace(/\$TEMP/g, process.env.TEMP), { stdio: 'inherit' })
      console.log('  close:', await closeBootDialog())
      bootDone = state.open
    }
  }

  if (!realDone && which.real) {
    console.log('── real bar ──')
    const { opened, chosen, state } = await testRealBar()
    console.log('  open path:', opened, chosen, '| state:', JSON.stringify(state))
    if (state.open) {
      execSync(`node ${ROOT}/tools/_winshot.mjs "$TEMP/dsh-about-real.png"`.replace(/\$TEMP/g, process.env.TEMP), { stdio: 'inherit' })
      console.log('  close:', await closeRealDialog())
      realDone = state.open
    }
  }

  if (!(bootDone && realDone)) await sleep(1200)
}

console.log('boot bar tested:', bootDone, '| real bar tested:', realDone)
try { execSync('taskkill /IM deepseek-harness-desktop.exe /F', { stdio: 'ignore' }) } catch {}
socket.close()
console.log('DONE')
