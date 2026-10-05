/**
 * The phone page's Workspace list, measured on a real LAN origin.
 *
 * WHAT THIS IS FOR. A phone browser opens the app's LAN login link; the page
 * paints its bar, its conversation and its Workspace picker, and the list is
 * empty — no error, no empty-state text, just a list that stays on its loading
 * state. The lists are carried by Remote streams on ONE multiplexed WebSocket,
 * opened by `@deepseek-ai/dsh-api-gateway/client` through `AbortSignal` and
 * `Promise.withResolvers` calls it never feature-tests, so an engine that lacks
 * one of them produces exactly that page. This probe reproduces the phone
 * outside the phone: the app's own debug exe, the working tree's plugin
 * resources, an isolated DSH_HOME (a copy of the real one by default, so the
 * Workspace/Session projection has real data to carry), and a headless Edge in a
 * phone viewport whose engine has the newer APIs DELETED before any page script
 * runs — the only way to ask "would this page work on that phone" from a desktop
 * engine.
 *
 * TWO DIRECTIONS, ONE BACKEND. `PHONE_REPRO_LEGACY_ENGINE=1` measures the build
 * BEFORE the engine-shim fix: the same crippled engine, with the four newer
 * shims made unreachable in the copied `browser-compat.js` (the record call
 * stays, so the page still reports what it was missing). That run must reproduce
 * the report — zero Workspace rows, zero frames on the mux — and must show the
 * phone-side diagnosis calling it what it is. The default run then measures the
 * fix on the same engine: the rows arrive and the mux moves frames.
 *
 * Usage:
 *   node tools/phone-workspace-list-probe.mjs
 *   $env:PHONE_REPRO_LEGACY_ENGINE='1'; node tools/phone-workspace-list-probe.mjs
 *
 * Environment:
 *   PHONE_REPRO_DIR            smoke root           (target/phone-workspace-probe)
 *   PHONE_REPRO_PORT           LAN port of the host (13094)
 *   PHONE_REPRO_ADDRESS        bind address         (the WLAN private IPv4)
 *   DSH_SEED_HOME              populated DSH_HOME   (~/.dsh, copied once into the root)
 *   CDP_PORT                   app window CDP port  (9371)
 *   PLAYWRIGHT_PATH            playwright package   (the codex runtime copy)
 *   PHONE_REPRO_DELETE_GLOBALS override the crippled-engine API list (comma separated)
 *   PHONE_REPRO_LEGACY_ENGINE  `1` measures the build before the fix
 *   PHONE_REPRO_EVIDENCE       evidence directory   (plan/phone-workspace-list-evidence)
 *   PHONE_REPRO_KEEP_HOME      `1` reuses an existing copy of the DSH_HOME
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, copyFile, cp, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join, dirname } from 'node:path'
import { networkInterfaces } from 'node:os'
import assert from 'node:assert/strict'
import { connect } from './terminal-cdp.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')

const root = resolve(process.env.PHONE_REPRO_DIR || 'src-tauri/target/phone-workspace-probe')
const evidence = resolve(process.env.PHONE_REPRO_EVIDENCE || 'plan/phone-workspace-list-evidence')
const lanPort = Number(process.env.PHONE_REPRO_PORT || 13094)
const cdpPort = Number(process.env.CDP_PORT || 9371)
const seedSource = process.env.DSH_SEED_HOME || join(process.env.USERPROFILE || '', '.dsh')
const legacy = process.env.PHONE_REPRO_LEGACY_ENGINE === '1'
const suffix = legacy ? '.legacy-engine' : ''

/**
 * The APIs the phone that reported the empty list does not have, and that
 * `browser-compat.js` now shims. Deleting them is how a desktop engine is made
 * to behave like that phone. `Iterator`, `Promise.try`, `Math.sumPrecise` and the
 * `Uint8Array` codecs were already shimmed by the previous fix; the last four are
 * the ones this run is about.
 */
const OLD_ENGINE_APIS = [
  'Iterator',
  'Promise.try',
  'Math.sumPrecise',
  'Uint8Array.fromBase64',
  'Uint8Array.fromHex',
  'Uint8Array.prototype.toBase64',
  'Uint8Array.prototype.toHex',
  'AbortSignal.prototype.throwIfAborted',
  'AbortSignal.any',
  'Promise.withResolvers',
  'URL.parse',
]
const deleteGlobals = (process.env.PHONE_REPRO_DELETE_GLOBALS || OLD_ENGINE_APIS.join(',')).split(',').map(value => value.trim()).filter(Boolean)

/**
 * The four shims this fix added, made unreachable in the copied script — the
 * `record()` call and `installed = true` beside each one stay, so the LEGACY page
 * still reports the engine gap it cannot fill. Each insertion is asserted to have
 * landed: a probe that silently measured the wrong build would be worthless.
 */
const LEGACY_NEUTRALISE = [
  "      Object.defineProperty(scope.Promise, 'withResolvers', {",
  "      Object.defineProperty(scope.AbortSignal.prototype, 'throwIfAborted', {",
  "      Object.defineProperty(scope.AbortSignal, 'any', {",
  "      Object.defineProperty(scope.URL, 'parse', {",
]

/** The APIs the build before this fix cannot close, in the fingerprint's spelling. */
const LEGACY_UNCLOSED = ['Promise.withResolvers', 'AbortSignal.prototype.throwIfAborted', 'AbortSignal.any', 'URL.parse']

const sleep = ms => new Promise(r => setTimeout(r, ms))
const report = { date: new Date().toISOString(), legacy, lanPort, deleteGlobals, checks: {} }

/** The private IPv4 this machine reaches the LAN on. */
function lanAddress() {
  const named = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list || []).map(entry => ({ name, ...entry })))
  const candidates = named.filter(entry => entry.family === 'IPv4' && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))
  const preferred = candidates.find(entry => /WLAN|Wi-Fi|以太网|Ethernet/i.test(entry.name)) || candidates[0]
  if (!preferred) throw Error('a private IPv4 LAN adapter is required')
  return preferred.address
}

async function connectWhenReady(port, timeout = 90000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const client = await connect(port).catch(() => undefined)
    if (client) return client
    await sleep(250)
  }
  throw Error(`no CDP target on port ${port}`)
}

async function until(client, expression, timeout = 60000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await client.evaluate(expression)
      if (last) return last
    } catch (error) { last = error.message }
    await sleep(150)
  }
  throw Error(`timed out waiting for ${expression.slice(0, 140)} (last: ${JSON.stringify(last)})`)
}

/** Dismiss the two first-run surfaces without deciding anything for the user. */
const DISMISS = `(()=>{
  const beta=[...document.querySelectorAll('[role=dialog]')].find(d=>d.textContent.includes('内测声明'))
  ;[...beta?.querySelectorAll('button')||[]].find(b=>b.textContent==='继续')?.click()
  ;[...document.querySelectorAll('button')].find(b=>b.textContent==='稍后配置')?.click()
})()`

/** One page's Workspace surfaces plus the two diagnostic surfaces this run reads. */
const READ_PAGE = `(()=>{
  const rows = sel => [...document.querySelectorAll(sel)]
  const drawer = document.querySelector("[class*='_sidebarCol']")
  const frame = document.querySelector("[class*='_frame']")
  const noteEl = document.getElementById('dsh-connection-note')
  const engine = window.__DSH_ENGINE__
  return {
    href: location.href.replace(/token=[^&]+/, 'token=…'),
    root: document.querySelector('#root')?.childElementCount ?? 0,
    bar: Boolean(document.querySelector('.dshTb')),
    browserDocument: document.documentElement.hasAttribute('data-dsh-browser'),
    frameAttrs: frame === null ? null : {
      rightbarCollapsed: frame.getAttribute('data-rightbar-collapsed'),
      sidebarCollapsed: frame.getAttribute('data-sidebar-collapsed'),
    },
    workspaceRows: rows('[role=treeitem][class*=projectRow]').length,
    treeRows: rows('[role=treeitem]').length,
    sessionRows: rows('[role=treeitem]').length - rows('[role=treeitem][class*=projectRow]').length,
    drawerLeft: drawer === null ? null : Math.round(drawer.getBoundingClientRect().x),
    drawerVisibility: drawer === null ? null : getComputedStyle(drawer).visibility,
    drawerText: (drawer?.innerText || '').slice(0, 400),
    pickerLabels: rows('button').filter(b => /选择工作区|DeepseekHarness|工作区/.test(b.textContent || '')).map(b => (b.textContent || '').trim()).slice(0, 6),
    noteKind: noteEl === null ? null : noteEl.getAttribute('data-dsh-connection-note'),
    noteText: noteEl === null ? null : noteEl.innerText.slice(0, 400),
    engineMissing: engine === undefined ? null : engine.missing,
    engineAbsent: engine === undefined ? null : engine.absent,
    engineUserAgent: engine === undefined ? null : engine.userAgent,
  }
})()`

let app, appClient, browser
try {
  await mkdir(root, { recursive: true })
  await mkdir(evidence, { recursive: true })

  // ── the exe and the plugin resources this run must measure ────────────────
  const exe = join(root, 'deepseek-harness-desktop.exe')
  await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'), exe)
  const resources = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources
  for (const [src, dest] of Object.entries(resources)) {
    const target = join(root, dest)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(resolve('src-tauri', src), target)
  }

  if (legacy) {
    const file = join(root, 'dsh-plugin/ui-overlay/browser-compat.js')
    const source = await readFile(file, 'utf8')
    let stripped = source
    for (const call of LEGACY_NEUTRALISE) {
      assert.equal(stripped.split(call).length, 2, `expected exactly one ${call.trim()}`)
      stripped = stripped.replace(call, `      if (false) ${call.trim()}`)
    }
    assert.notEqual(stripped, source)
    await writeFile(file, stripped)
    console.log('PHONE_REPRO_LEGACY_ENGINE: the four new shims are unreachable in this copy')
  }

  // ── the DSH_HOME: the real profile, copied once, so the projection carries
  // the Workspaces and Sessions the user actually has ────────────────────────
  const seedHome = join(root, 'dsh-home')
  if (process.env.PHONE_REPRO_KEEP_HOME !== '1' || !(await stat(seedHome).catch(() => undefined))) {
    await mkdir(seedHome, { recursive: true })
    for (const entry of ['sessions', 'storages', 'profiles']) {
      await cp(join(seedSource, entry), join(seedHome, entry), { recursive: true, force: true, errorOnExist: false }).catch(error => {
        console.log(`seed: skipped ${entry}: ${error.message}`)
      })
    }
    for (const file of ['settings.yaml', '.credentials.yaml', '.anonymous-user-id', 'cordis.patch.yml']) {
      await copyFile(join(seedSource, file), join(seedHome, file)).catch(() => {})
    }
  }
  const diagPath = join(seedHome, 'desktop-diag.log')
  const diagBefore = await readFile(diagPath, 'utf8').catch(() => '')

  // ── LAN on, this run's own port ───────────────────────────────────────────
  const address = process.env.PHONE_REPRO_ADDRESS || lanAddress()
  await writeFile(join(root, 'remote-control.json'), JSON.stringify({ version: 1, enabled: true, bindAddress: address, port: lanPort, trustedHosts: [] }, null, 2))
  console.log(`${legacy ? 'LEGACY ENGINE' : 'CRIPPLED ENGINE + SHIMS'}  LAN ${address}:${lanPort}  DSH_HOME ${seedHome}`)

  app = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DSH_HOME: seedHome,
      DSH_DESKTOP_SMOKE_DIR: root,
      DSH_DESKTOP_DEBUG: join(root, 'host.log'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    },
  })
  appClient = await connectWhenReady(cdpPort)
  const identity = await until(appClient, `window.__DSH_REMOTE_IDENTITY__ && window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__})`)
  report.desktopHost = { state: identity.state, address: identity.active?.bindAddress, port: identity.active?.port }
  assert.equal(identity.state, 'lan', `the desktop host must be on the LAN: ${JSON.stringify(identity)}`)
  for (let i = 0; i < 15; i++) { await appClient.evaluate(DISMISS); await sleep(150) }

  // The desktop window's own view, for the same data and the same backend: the
  // phone report only means something next to it. (Its engine is the WebView2 —
  // untouched by the deletions, which apply to the browser context only.)
  report.desktopWindow = await appClient.evaluate(READ_PAGE)
  assert.ok(report.desktopWindow.workspaceRows > 0, 'the desktop window must list the workspaces')
  assert.equal(report.desktopWindow.browserDocument, false, 'the desktop window is still the host own document')
  assert.equal(report.desktopWindow.noteKind ?? null, null, 'a healthy desktop window shows no connection note')
  await appClient.evaluate(DISMISS)

  const info = await appClient.evaluate(`window.__TAURI__.core.invoke('remote_connection_info',{identity:window.__DSH_REMOTE_IDENTITY__})`)
  assert.ok(info.url.startsWith(`http://${address}:${lanPort}/`), `login link must name the LAN origin: ${info.url}`)

  // ── the phone page ────────────────────────────────────────────────────────
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await context.addInitScript(globals => {
    for (const path of globals) {
      const parts = path.split('.')
      const owner = parts.slice(0, -1).reduce((value, key) => value?.[key], globalThis)
      try { delete owner?.[parts.at(-1)] } catch {}
    }
  }, deleteGlobals)
  const page = await context.newPage()
  const console_ = [], pageErrors = [], failed = [], sockets = []
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') console_.push(`${message.type()}: ${message.text()}`.slice(0, 300)) })
  page.on('pageerror', error => pageErrors.push(String(error).slice(0, 400)))
  page.on('requestfailed', request => failed.push(`${request.method()} ${request.url().slice(0, 120)} → ${request.failure()?.errorText}`))
  page.on('websocket', socket => {
    const entry = { url: socket.url().replace(/token=[^&]+/, 'token=…'), frames: 0, sent: 0, closed: false }
    sockets.push(entry)
    socket.on('framereceived', () => entry.frames++)
    socket.on('framesent', () => entry.sent++)
    socket.on('close', () => { entry.closed = true })
  })
  await page.goto(info.url)
  await page.locator('.dshTb').waitFor({ timeout: 60000 })
  await sleep(2000)
  for (let i = 0; i < 15; i++) { await page.evaluate(DISMISS); await sleep(150) }

  const mux = () => sockets.filter(socket => socket.url.indexOf('/api/') !== -1)
  const muxFrames = () => mux().reduce((total, socket) => total + socket.frames, 0)

  // Record the row count as it changes: a list that never arrives and a list that
  // arrives late are different reports.
  const arrivals = []
  for (let i = 0; i < 20; i++) {
    arrivals.push(await page.evaluate(`document.querySelectorAll('[role=treeitem][class*=projectRow]').length`))
    if (arrivals.at(-1) > 0) break
    await sleep(500)
  }
  report.phone = { arrival: arrivals, before: await page.evaluate(READ_PAGE) }
  await page.screenshot({ path: join(evidence, `phone-arrival${suffix}.png`) })

  let drawer
  if (legacy) {
    // The stall diagnosis is the finding, and it arrives on the page's own poll
    // clock — read it instead of clicking through the banner it renders (a
    // `position: fixed` notice over the bar is exactly what a notice is). The
    // sidebar is never opened here: with no frames on the channel there is
    // nothing in it to see.
    const noteKind = () => page.evaluate(`document.getElementById('dsh-connection-note')?.getAttribute('data-dsh-connection-note')||null`)
    for (let i = 0; i < 45 && (await noteKind()) === null; i++) await sleep(1000)
    drawer = await page.evaluate(READ_PAGE)
    report.phone.note = drawer
    await page.screenshot({ path: join(evidence, `phone-stall-note${suffix}.png`) })
  } else {
    // The drawer is where the sidebar lives on a phone page.
    await page.locator('.dshTb__mark').click()
    for (let i = 0; i < 16; i++) {
      const left = await page.evaluate(`(()=>{const c=document.querySelector("[class*='_sidebarCol']");return c===null?null:Math.round(c.getBoundingClientRect().x)})()`)
      if (left !== null && left >= 0) break
      await sleep(250)
    }
    drawer = await page.evaluate(READ_PAGE)
    report.phone.drawerSidebarText = await page.evaluate(`(document.querySelector("[class*='_sidebarCol']")?.innerText||'').slice(0,800)`)
    await page.screenshot({ path: join(evidence, `phone-drawer${suffix}.png`) })
  }
  report.phone.drawer = drawer

  report.phone.console = console_
  report.phone.pageErrors = pageErrors
  report.phone.failedRequests = failed
  report.phone.webSockets = sockets
  report.phone.final = await page.evaluate(READ_PAGE)
  report.phone.finalMuxFrames = muxFrames()

  // ── the diagnostics the page wrote to the desktop log ─────────────────────
  const diagAfter = await readFile(diagPath, 'utf8').catch(() => '')
  report.diagLines = diagAfter.slice(diagBefore.length).split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return { unparsed: line.slice(0, 200) } }
  })

  // ── the claims this run exists to make ────────────────────────────────────
  assert.equal(drawer.browserDocument, true, 'an ordinary browser must be the browser document class')
  assert.ok(drawer.engineMissing !== null, 'the page must publish what its engine was missing')
  for (const api of deleteGlobals) {
    assert.ok(drawer.engineMissing.includes(api), `${api} must be reported as missing by the page`)
  }
  assert.ok(drawer.engineMissing.includes('AbortSignal.any'), 'the transport gap must be named')
  assert.ok(Array.isArray(drawer.engineAbsent), 'the page fingerprints what is still absent')
  // The fingerprint separates the two lists: everything this build shims is closed
  // (`missing`), and anything left is named in `absent` whether or not a shim
  // exists for it — which is how the NEXT phone report will be answered.
  for (const api of ['Iterator', 'Promise.try', 'Math.sumPrecise', 'Uint8Array.fromBase64']) {
    assert.ok(!drawer.engineAbsent.includes(api), `${api} is shimmed, so it must NOT still be absent`)
  }
  if (legacy) {
    for (const api of LEGACY_UNCLOSED) {
      assert.ok(drawer.engineAbsent.includes(api), `the build before the fix cannot close ${api}: ${JSON.stringify(drawer.engineAbsent)}`)
    }
  } else {
    assert.deepEqual(drawer.engineAbsent, [], `every API this page watches is present once the shims have run: ${JSON.stringify(drawer.engineAbsent)}`)
  }
  if (legacy) {
    // The engine gap surfaces as uncaught page errors — which is exactly why the
    // phone showed nothing: nobody reads a phone's console.
    assert.ok(pageErrors.length > 0, 'an engine gap nothing shims still throws somewhere')
  } else {
    assert.deepEqual(pageErrors, [], `the page must not throw: ${JSON.stringify(pageErrors)}`)
  }

  const engine = report.diagLines.find(line => line.kind === 'engine')
  assert.ok(engine, 'the page reports its engine gaps to the desktop log')
  assert.deepEqual(engine.missing.sort(), [...drawer.engineMissing].sort())

  if (legacy) {
    // The report, reproduced: a page that is up, HTTP-healthy, and never receives
    // a frame — so no Workspace row and no Session row anywhere.
    assert.equal(drawer.workspaceRows, 0, `legacy engine must show no workspaces: ${JSON.stringify(drawer)}`)
    assert.equal(drawer.sessionRows, 0)
    assert.equal(muxFrames(), 0, 'legacy engine must receive no frames on the realtime channel')
    assert.equal(drawer.noteKind, 'stalled', `the page must name its own stall: ${JSON.stringify(drawer)}`)
    assert.match(drawer.noteText, /实时通道/)
    assert.match(drawer.noteText, new RegExp(`缺少 ${deleteGlobals.length} 个较新的 API`), 'the note counts the engine gaps it closed')
    const stall = report.diagLines.find(line => line.kind === 'stall')
    assert.ok(stall, 'the stall must reach the desktop log')
    assert.equal(stall.frames, 0)
    assert.ok(stall.missing.includes('AbortSignal.any'))
    console.log('PASS (before the fix) the phone page shows no Workspaces and names its own stall')
  } else {
    assert.ok(drawer.workspaceRows > 0, `the drawer must list the workspace folders: ${JSON.stringify(drawer)}`)
    assert.ok(drawer.sessionRows > 0, 'the drawer must list the sessions of the open workspace')
    assert.equal(drawer.drawerVisibility, 'visible')
    assert.ok(muxFrames() > 0, 'the realtime channel must deliver frames')
    assert.equal(drawer.noteKind ?? null, null, 'a healthy page shows no connection note')
    assert.equal(report.diagLines.find(line => line.kind === 'stall'), undefined, 'a healthy page reports no stall')
    assert.equal(drawer.workspaceRows, report.desktopWindow.workspaceRows, `every Workspace the desktop window lists must reach the phone: ${drawer.workspaceRows} of ${report.desktopWindow.workspaceRows}`)
    console.log('PASS the same engine, with the shims: the Workspace list arrives')
  }

  report.summary = {
    legacy,
    workspaceRows: drawer.workspaceRows,
    sessionRows: drawer.sessionRows,
    muxFrames: muxFrames(),
    note: drawer.noteKind ?? report.phone.final.noteKind ?? null,
    diagKinds: report.diagLines.map(line => line.kind),
    pageErrors: pageErrors.length,
  }
  console.log('SUMMARY ' + JSON.stringify(report.summary))
} catch (error) {
  report.error = String(error?.stack || error)
  console.error(report.error)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  appClient?.close()
  app?.kill()
  try { await writeFile(join(evidence, `phone-workspace-list-probe${suffix}.json`), JSON.stringify(report, null, 2)) } catch {}
}
