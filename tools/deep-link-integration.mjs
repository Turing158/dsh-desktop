/** Live deep-link acceptance against an isolated debug host (CDP).
 *
 * Run the host exactly as the other live tools do, then this script:
 *
 * ```powershell
 * $dir = "src-tauri/target/deep-link-live"
 * $env:DSH_HOME = "$pwd/$dir/dsh-home"
 * $env:DSH_DESKTOP_SMOKE_DIR = "$pwd/$dir"
 * $env:DSH_DESKTOP_DEBUG = "$pwd/$dir/host.log"
 * $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9343"
 * .\src-tauri\target\debug\deepseek-harness-desktop.exe
 * # another shell:
 * node tools/deep-link-integration.mjs
 * ```
 *
 * `CDP_PORT` overrides the port. Evidence lands in `<dir>/deep-link-integration.json`.
 *
 * WHAT IS DRIVEN LIVE, AND WHY. The copy path is driven through REAL mouse input
 * (right-click on a sidebar row, press on the injected item): the row menu exists
 * only inside the app's real React tree, and the injection hangs off the menu's
 * real open state. The activation path is driven through the OS (`start`), which
 * is the whole feature — the registry, the second instance, the single-instance
 * forwarding and the queue are all exercised as shipped, not stubbed.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { connect } from './terminal-cdp.mjs'

const dir = resolve(process.env.LINK_SMOKE_DIR || 'src-tauri/target/deep-link-live')
const port = Number(process.env.CDP_PORT || 9343)
const exe = resolve('src-tauri/target/debug/deepseek-harness-desktop.exe')
const dirAbsolute = resolve(dir)
const evidence = { checks: [] }
const check = (name, detail) => { evidence.checks.push({ name, detail: detail ?? null }); console.log('PASS ' + name) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

let cdp = await connect(port)

async function until(expression, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await cdp.evaluate(expression)) return } catch {}
    await sleep(150)
  }
  throw Error('Timed out: ' + expression)
}

/** The smoke client context — the same ctx the UI-state adapter binds. */
const CTX = 'window.__DSH_SMOKE_CONTEXT__'
const currentSession = () => cdp.evaluate(`${CTX}.sessions.list.getSnapshot().current`)

/** Dismiss the isolated profile's transient dialogs, if they are up.
 *
 * The delayed onboarding dialog (稍后配置) and the one-time 内测声明 beta
 * disclaimer both cover the page in a full-screen mask that would eat every
 * real mouse event the row-menu check sends. Both can appear late and appear
 * one after the other, so this polls until the page has been mask-free for a
 * stretch rather than dismissing once. */
async function dismissOnboarding() {
  let clean = 0
  for (let i = 0; i < 60 && clean < 6; i++) {
    await cdp.evaluate(`(()=>{for(const b of document.querySelectorAll('button')){if(b.textContent==='稍后配置'||b.textContent==='继续')b.click()}})()`)
    const masked = await cdp.evaluate(`Boolean(document.querySelector('[class*="mask"]'))`)
    clean = masked ? 0 : clean + 1
    await sleep(250)
  }
}

/** Two real (non-blank) sessions in the isolated profile.
 *
 * Blank sessions — the provisional 新会话 rows a fresh profile starts with —
 * render no row actions, so the app's own session row menu (and with it the
 * injected deep-link row) cannot open for them; that is the app's own shape,
 * not this feature's. The profile therefore ships with real session logs
 * copied from the developer's `~/.dsh` (see the verification record), and this
 * waits for the projection to surface at least two non-blank ones. */
async function findRealSessions() {
  await until(`${CTX}.sessions.list.getSnapshot().phase==='ready'`)
  const ids = await cdp.evaluate(`(()=>{
    const s=${CTX}.sessions.list.getSnapshot()
    return s.ids.filter(id=>{const v=s.byId[id];return v && !v.blank})
  })()`)
  assert.ok(ids.length >= 2, 'the isolated profile must carry two non-blank sessions; got ' + JSON.stringify(ids))
  await cdp.evaluate(`${CTX}.uiWorkspace.openSession(${JSON.stringify(ids[0])})`)
  await until(`${CTX}.sessions.list.getSnapshot().current===${JSON.stringify(ids[0])}`)
  return { a: ids[0], b: ids[1] }
}

/** Press the title bar's 会话 ▸ 复制... ▸ 复制深度链接 and return the clipboard. */
async function copyFromTitleBar(expectedId) {
  await cdp.evaluate(`(()=>{
    const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='会话')
    if(!button) throw Error('会话 menu button not found')
    button.focus(); button.click()
  })()`)
  await until(`[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='复制...')`)
  await cdp.evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='复制...').click()`)
  await until(`[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='复制深度链接')`)
  const disabled = await cdp.evaluate(
    `[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='复制深度链接').disabled`,
  )
  assert.equal(disabled, false, 'the title-bar item must be enabled with a current session')
  await cdp.evaluate(`(()=>{
    const item=[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='复制深度链接')
    item.click()
  })()`)
  await until(`Boolean(window.__TAURI__)`)
  const text = await cdp.evaluate(`window.__TAURI__.core.invoke('clipboard_read_text')`)
  assert.equal(text, 'deepseekharness://session/' + expectedId.replace(/^session-/, ''), 'the clipboard must hold the short link')
  return text
}

/** Right-click the row whose fiber names `sessionId`, then press the injected
 * deep-link item. The row is found by the same fiber walk the overlay itself
 * performs (`sessionIdFromRow`), so the test clicks the row that really owns
 * the session rather than the first row on screen. */
async function copyFromRowMenu(sessionId) {
  const target = JSON.stringify(sessionId)
  const box = await cdp.evaluate(`(()=>{
    for (const row of document.querySelectorAll('[class*="sessionRow"][role="treeitem"]')) {
      let el = row
      for (let up = 0; up < 8 && el; up++) {
        const key = Object.keys(el).find(k => k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0)
        if (!key) break
        let fiber = el[key]
        for (let d = 0; fiber && d < 20; d++) {
          const props = fiber.memoizedProps
          if (props && props.node && typeof props.node === 'object' && props.node.id) {
            if (props.node.id === ${target}) {
              const r = row.getBoundingClientRect()
              return { x: Math.round(r.x + r.width * 0.35), y: Math.round(r.y + r.height / 2), actions: Boolean(row.querySelector('[class*="rowActions"]')) }
            }
            break
          }
          fiber = fiber.return
        }
        break
      }
    }
    return null
  })()`)
  assert.ok(box, `the row for ${sessionId} must be on screen`)
  assert.ok(box.actions, 'a non-blank session row must expose its actions button')

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 })
  await sleep(150)
  const base = { x: box.x, y: box.y, button: 'right', buttons: 2, clickCount: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
  await until(`Boolean(document.querySelector('[data-dsh-desktop="link-item"]'))`, 15000)
  await cdp.evaluate(`document.querySelector('[data-dsh-desktop="link-item"] [role=menuitem]').click()`)
  await until(`document.querySelector('[data-dsh-desktop="copy-submenu"]')?.style.display === 'flex'`)

  const state = await cdp.evaluate(`(()=>{
    const button=document.querySelector('[data-dsh-desktop="copy-submenu"] [data-action="copy-link"]')
    const r=button.getBoundingClientRect()
    return {disabled:button.disabled, x:r.x+r.width/2, y:r.y+r.height/2}
  })()`)
  assert.equal(state.disabled, false, 'the row item must be enabled for a real session row')

  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: state.x, y: state.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: state.x, y: state.y, button: 'left', clickCount: 1 })
  await sleep(400)
  const text = await cdp.evaluate(`window.__TAURI__.core.invoke('clipboard_read_text')`)
  assert.equal(text, 'deepseekharness://session/' + sessionId.replace(/^session-/, ''), 'the row menu must copy the row’s own session')
  return text
}

/** Open a link through the OS the way a user would. */
function openLink(link) {
  spawn('cmd.exe', ['/c', 'start', '', link], { windowsHide: true, stdio: 'ignore' }).unref()
}

const bootEnv = () => ({
  ...process.env,
  DSH_HOME: resolve(dirAbsolute, 'dsh-home'),
  DSH_DESKTOP_SMOKE_DIR: dirAbsolute,
  DSH_DESKTOP_DEBUG: resolve(dirAbsolute, 'host.log'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
})

try {
  // ── boot ────────────────────────────────────────────────────────────────
  await until(`Boolean(window.__DSH_UI_BOOT__?.smoke) && Boolean(${CTX})`)
  await dismissOnboarding()
  const { a, b } = await findRealSessions()
  check('two real sessions exist in the isolated profile', { a, b })

  // ── registry ────────────────────────────────────────────────────────────
  const registry = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\deepseekharness', '/s'], { encoding: 'utf8' })
  assert.ok(registry.includes('shell\\open\\command'), 'the scheme must carry an open command')
  assert.ok(
    registry.toLowerCase().includes(exe.toLowerCase()),
    'the open command must point at the running build: ' + registry,
  )
  check('HKCU registration points at the running executable')

  // ── copy: title bar ─────────────────────────────────────────────────────
  const fromBar = await copyFromTitleBar(a)
  check('title-bar 会话 menu copies the current session', { link: fromBar })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 })

  // ── copy: sidebar row menu (real right-click, real press) ──────────────
  const fromRow = await copyFromRowMenu(b)
  check('sidebar row menu copies that row’s session', { link: fromRow })

  // ── activation, warm ────────────────────────────────────────────────────
  assert.equal(await currentSession(), a, 'the current session must be the first before the link')
  openLink(fromRow)
  await until(`${CTX}.sessions.list.getSnapshot().current==='${b}'`, 30000)
  check('clicking the link in Windows switches to the named session (warm)', { session: b })

  // A malformed link is dropped, not acted on.
  const before = await currentSession()
  openLink('deepseekharness://session/../system32')
  await sleep(2500)
  assert.equal(await currentSession(), before, 'a malformed link must not change the session')
  check('a malformed link is rejected without touching the session')

  // ── activation, cold ────────────────────────────────────────────────────
  const pid = Number((await readFile(resolve(dirAbsolute, 'host.pid'), 'utf8')).trim() || (await cdp.evaluate(`0`)))
  await writeFile(resolve(dirAbsolute, 'command.json'), JSON.stringify({ sequence: Date.now(), action: 'quit' }))
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0) } catch { break } await sleep(100) }
  try { cdp.close() } catch {}
  await writeFile(resolve(dirAbsolute, 'command.json'), '{}')
  const child = spawn(exe, [fromBar], { windowsHide: true, detached: true, stdio: 'ignore', env: bootEnv() })
  child.unref()
  await writeFile(resolve(dirAbsolute, 'host.pid'), String(child.pid))
  for (let i = 0; i < 150; i++) {
    try {
      cdp = await connect(port)
      if (await cdp.evaluate(`Boolean(window.__DSH_UI_BOOT__?.smoke) && Boolean(${CTX}) && ${CTX}.sessions.list.getSnapshot().phase==='ready'`).catch(() => false)) break
      cdp.close()
    } catch {}
    await sleep(300)
  }
  // The push lands on page-load Finished; the adapter then opens the session
  // asynchronously, so wait for the selection rather than racing it.
  await until(`${CTX}.sessions.list.getSnapshot().current===${JSON.stringify(a)}`, 30000)
  assert.equal(await currentSession(), a, 'a cold start with the link must land on that session')
  check('a cold start carrying the link opens straight into the session', { session: a })

  await writeFile(resolve(dirAbsolute, 'deep-link-integration.json'), JSON.stringify(evidence, null, 2))
  console.log('\nAll deep-link live checks passed. Evidence: ' + resolve(dirAbsolute, 'deep-link-integration.json'))
} finally {
  try { cdp.close() } catch {}
}
