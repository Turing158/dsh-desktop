/**
 * Verify menu layering, dismissal and intrinsic sizing in the live app over CDP.
 *
 * ## Why this exists
 *
 * These invariants are properties of the LIVE page, not of any file:
 *
 *   - **A menu is never painted under the title bar.** That is decided by the
 *     running cascade plus which ancestors happen to create a stacking context.
 *     A stylesheet that reads correctly can still lose the fight, and the failure
 *     is geometric — an item 20px under the bar — which a DOM stub has no layout
 *     engine to be wrong about.
 *   - **A menu does not close when the pointer leaves it.** That is decided by
 *     React's synthetic event tree over a portal to `document.body`, i.e. by the
 *     app's real component graph at runtime.
 *   - **Menu width follows its options and stays within the viewport.** Font
 *     metrics, flex sizing and the runtime cascade decide the actual width;
 *     long unbroken labels must wrap without hiding behind the maximum width.
 *
 * `inspect-live.mjs` is the sibling instrument: it PRINTS measurements for a human
 * to read against the README. This one ASSERTS the two invariants and exits
 * non-zero when one is broken, so a regression is caught rather than described.
 *
 * ## Running it
 *
 * The webview must expose a debugger, which WebView2 only does when asked:
 *
 * ```powershell
 * $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
 * .\src-tauri\target\debug\deepseek-harness-desktop.exe
 * ```
 *
 * Then, in another shell:
 *
 * ```powershell
 * node tools/check-menus.mjs
 * ```
 *
 * `CDP_PORT` overrides the port. Uses Node's global `WebSocket` (22+), so it needs
 * no dependency.
 *
 * WHAT THIS CANNOT CHECK, AND WHY IT IS STILL WORTH RUNNING. The pointer-leave
 * check drives real mouse input through CDP (`Input.dispatchMouseEvent`), because
 * React synthesizes enter/leave from real pointer transitions and a synthetic
 * `dispatchEvent` does not reproduce the boundary crossing — the original bug was
 * invisible to a synthetic event. Only the *positions* it moves to are computed
 * from the live geometry, so a layout change moves the test with it rather than
 * invalidating it.
 */

const PORT = process.env.CDP_PORT ?? '9222'

/** The page this app serves its own UI and the DSH GUI from. */
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error(
    `no page target on port ${PORT}. Is the app running with\n` +
      `  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${PORT} ?`,
  )
  process.exit(3)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()

/** Send one CDP command and await its result. */
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

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
  }
  return result.result.value
}

/** Move the real cursor, so React observes a genuine pointer transition. */
async function moveMouse(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await sleep(120)
}

/** A real pointer click at a point, as the user performs one. */
async function clickMouse(x, y, button = 'right') {
  const base = { x, y, button, buttons: button === 'right' ? 2 : 1, clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
  await sleep(400)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
const checks = []

/** Record one assertion, so the report lists every invariant either way. */
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  if (!pass) failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const layout = await evaluate(`({
  overlay: document.documentElement.getAttribute('data-dsh-ui') !== 'vanilla',
  cap: Math.min(360, window.innerWidth - 16),
  viewportWidth: window.innerWidth,
})`)

function checkBounds(name, menu) {
  if (!layout.overlay) return
  check(`${name} fits the menu cap and viewport`,
    menu.width <= layout.cap + 1 && menu.left >= 7 && menu.right <= layout.viewportWidth - 7,
    { width: menu.width, left: menu.left, right: menu.right, cap: layout.cap })
}

/** Clone real markup only for a synchronous layout measurement, before paint.
 * The ghost marker prevents the overlay from decorating or replaying the probe.
 * Deliberate inline widths exercise pickers that size themselves from anchors.
 */
async function checkIntrinsicSizing() {
  if (!layout.overlay) return
  const sizes = await evaluate(`(() => {
    const source = document.querySelector('[role="menu"]:not([data-dsh-ghost])')
    if (!source) return null
    const menu = source.cloneNode(true)
    menu.setAttribute('data-dsh-ghost', 'size-probe')
    menu.style.cssText = 'position:fixed;left:8px;top:52px;width:600px;min-width:600px;max-width:600px'
    const labels = [...menu.querySelectorAll('[class*="_itemLabel"]')]
    if (!labels.length) return null
    document.body.appendChild(menu)
    try {
      for (const label of labels) label.textContent = '短'
      const short = { width: menu.getBoundingClientRect().width, height: labels[0].getBoundingClientRect().height }
      for (const label of labels) label.textContent = 'LongUnbrokenMenuOption'.repeat(12)
      const long = {
        width: menu.getBoundingClientRect().width,
        height: labels[0].getBoundingClientRect().height,
        fits: labels.every(label => label.scrollWidth <= label.clientWidth + 1),
      }
      return { short, long }
    } finally {
      menu.remove()
    }
  })()`)
  check('real menu labels size the panel despite inline anchor widths',
    !!sizes && sizes.short.width < sizes.long.width && sizes.long.width <= layout.cap + 1, sizes)
  check('long unbroken labels wrap without horizontal clipping',
    !!sizes && sizes.long.fits && sizes.long.height > sizes.short.height, sizes)
}

/** Close whatever is open, so each step starts from a known state. */
async function reset() {
  for (let i = 0; i < 3; i += 1) {
    const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    await sleep(120)
  }
  await moveMouse(1100, 780)
  await sleep(250)
}

// ── the bar, and the layer every menu must beat ─────────────────────────────
const bar = await evaluate(`(() => {
  const el = document.querySelector('.dshTb') || document.getElementById('dsh-desktop-titlebar-boot')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { z: Number(getComputedStyle(el).zIndex), height: Math.round(r.bottom) }
})()`)

if (bar === null) {
  console.error('no title bar on the page; start the app with the overlay, not a plain dsh web')
  socket.close()
  process.exit(3)
}

// ── A: a row menu, checked for item reachability ─────────────────────────────
//
// WHAT THIS CAN AND CANNOT ESTABLISH. A sidebar row can never sit in the bar's
// strip: the sidebar header occupies it, and measured across the row list's whole
// scroll range the highest reachable row top is y≈190 — well below the bar's 44.
// So a row menu cannot be *opened* under the bar by a real click, and the paint
// order between the two is not observable from here.
//
// What IS observable, and what this checks, is that a menu opened from a row is
// on the top layer and every item is reachable. The paint-order claim itself is
// established by the bar's own menus below, which hang from the bar and always
// overlap its lower edge — that is the pair that actually competes.
const rowPoint = await evaluate(`(() => {
  const row = document.querySelector('[class*="_projectRow"]') || document.querySelector('[class*="_sessionRow"]')
  if (!row) return null
  const r = row.getBoundingClientRect()
  // The row's own centre, verified against the hit test so a scrollbar or a badge
  // that happens to cover it does not silently turn into a false failure.
  const x = Math.round(r.left + r.width * 0.35)
  let y = Math.round(r.top + r.height / 2)
  let at = document.elementFromPoint(x, y)
  for (let i = 0; i < 10 && at && !row.contains(at); i += 1) {
    y += 2
    at = document.elementFromPoint(x, y)
  }
  return { point: { x, y }, rowTop: Math.round(r.top), onRow: !!at && row.contains(at) }
})()`)

check('a sidebar row is under the cursor to right-click', rowPoint !== null && rowPoint.onRow, rowPoint)

if (rowPoint === null || !rowPoint.onRow) {
  console.error('no sidebar row could be right-clicked')
  socket.close()
  process.exit(3)
}

await reset()
await moveMouse(rowPoint.point.x, rowPoint.point.y)
await clickMouse(rowPoint.point.x, rowPoint.point.y)

const opened = await evaluate(`(() => {
  const menu = document.querySelector('[role="menu"]')
  if (!menu) return null
  const r = menu.getBoundingClientRect()
  const items = [...menu.querySelectorAll('[role="menuitem"]')]
  return {
    z: Number(getComputedStyle(menu).zIndex),
    width: r.width, left: r.left, right: r.right,
    top: Math.round(r.top),
    centre: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
    parentIsBody: menu.parentElement === document.body,
    items: items.map((item) => {
      const ir = item.getBoundingClientRect()
      const top = document.elementFromPoint(
        Math.round(ir.left + ir.width / 2),
        Math.round(ir.top + ir.height / 2),
      )
      return { label: item.textContent.trim(), top: Math.round(ir.top), clickable: !!top && menu.contains(top) }
    }),
  }
})()`)

check('a right-click on a row opens its menu', opened !== null)

if (opened) {
  checkBounds('the row menu', opened)
  check('the menu is portalled to the body plane', opened.parentIsBody)
  check(`the menu outranks the bar (${opened.z} > ${bar.z})`, opened.z > bar.z, {
    menuZ: opened.z,
    barZ: bar.z,
  })
  for (const item of opened.items) {
    if (item.top >= bar.height) continue
    check(`“${item.label}” (top ${item.top}) is clickable under the bar`, item.clickable)
  }
  check('every menu item is reachable', opened.items.every((i) => i.clickable), opened.items)

  // ── B: the pointer enters the menu, then leaves it ────────────────────────
  await moveMouse(opened.centre.x, opened.centre.y)
  await sleep(400)
  check('the menu stays open while the pointer is on it', await evaluate(`!!document.querySelector('[role="menu"]')`))

  await moveMouse(1080, 700)
  await sleep(700)
  check(
    'the menu STAYS OPEN after the pointer leaves it',
    await evaluate(`!!document.querySelector('[role="menu"]')`),
  )

  // Leaving must not have cost the dismissals the user does want.
  // A primary click dismisses without opening another surface's context menu
  // (for example the terminal, which can occupy this part of the window).
  await clickMouse(1080, 700, 'left')
  await sleep(500)
  check(
    'a click outside still dismisses the menu',
    !(await evaluate(`!!document.querySelector('[role="menu"]')`)),
  )
} else {
  // Report WHY, so a failure here is actionable rather than a bare "false". The
  // usual cause is the click point missing the row, which is geometry rather than
  // the overlay's right-click takeover.
  const why = await evaluate(`(() => {
    const at = document.elementFromPoint(${rowPoint.point.x}, ${rowPoint.point.y})
    return {
      point: ${JSON.stringify(rowPoint.point)},
      atPoint: at ? { tag: at.tagName.toLowerCase(), cls: String(at.className || '').slice(0, 44) } : null,
      rowStillUnderCursor: !!(at && at.closest('[class*="_projectRow"], [class*="_sessionRow"]')),
    }
  })()`)
  check('the right-click point is still on a row', why.rowStillUnderCursor, why)
}

// ── A again, for the bar's own menus ────────────────────────────────────────
//
// These hang from the bar itself, so their top edge always overlaps the strip.
// They are listed by label rather than counted, so a renamed menu fails loudly.
const barItems = await evaluate(
  `[...document.querySelectorAll('.dshTb__item')].map((b) => b.textContent.trim())`,
)
let sizingChecked = false

for (const label of barItems) {
  await reset()
  const clicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.dshTb__item')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!clicked) continue
  await sleep(500)

  const menu = await evaluate(`(() => {
    const menu = document.querySelector('[role="menu"]')
    if (!menu) return null
    const r = menu.getBoundingClientRect()
    const items = [...menu.querySelectorAll('[role="menuitem"]')]
    return {
      z: Number(getComputedStyle(menu).zIndex),
      width: r.width, left: r.left, right: r.right,
      top: Math.round(r.top),
      items: items.map((item) => {
        const ir = item.getBoundingClientRect()
        const top = document.elementFromPoint(
          Math.round(ir.left + ir.width / 2),
          Math.round(ir.top + ir.height / 2),
        )
        return { label: item.textContent.trim(), top: Math.round(ir.top), clickable: !!top && menu.contains(top) }
      }),
    }
  })()`)

  check(`the bar's “${label}” menu opens`, menu !== null)
  if (!menu) continue

  checkBounds(`the bar's “${label}” menu`, menu)
  if (!sizingChecked) {
    await checkIntrinsicSizing()
    sizingChecked = true
  }

  check(`the bar's “${label}” menu outranks the bar`, menu.z > bar.z, { menuZ: menu.z, barZ: bar.z })
  for (const item of menu.items) {
    if (item.top >= bar.height) continue
    check(`the bar's “${label}” ▸ “${item.label}” is clickable`, item.clickable)
  }
}

await reset()

// ── report ──────────────────────────────────────────────────────────────────
for (const entry of checks) {
  console.log(`${entry.pass ? 'ok  ' : 'FAIL'}  ${entry.name}`)
}
console.log(
  `\n${checks.length - failures.length}/${checks.length} checks passed` +
    (failures.length === 0 ? '' : `\n\nfailures:\n${failures.map((f) => '  - ' + f).join('\n')}`),
)

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
