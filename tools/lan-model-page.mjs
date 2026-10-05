/**
 * Real desktop window on a real LAN origin: 设置 → 模型 must load its provider
 * directory, while an ordinary browser on the SAME origin keeps DSH's
 * memory-mode settings policy.
 *
 * WHY THIS EXISTS. With remote control on, the backend binds a private IPv4 and
 * the desktop window is served from `http://<lan-ip>:<port>`. DSH grants the
 * Host-persistence settings namespace only to a page it considers the host's own
 * — `__DSH_TRANSPORT__.ownsHost === true`, or a loopback hostname
 * (`dsh-client-connection`). This app's window is a plain WebView2 document, so
 * the LAN origin made DSH treat it as a genuinely remote browser: the describe
 * mirror sat on `unavailable`, and the models page — the one settings surface
 * that refuses to render without a settings view — reported
 * `加载提供方目录失败: settings are unavailable in this browser`.
 * `ui-overlay/browser-compat.js` now declares host ownership for this app's own
 * WebView, using the same `window.__TAURI__` test that already tells the overlay
 * a phone page from the desktop window. This run measures both sides of that
 * decision against ONE backend.
 *
 * Owns only isolated processes: a copy of the debug exe beside a copy of the
 * repo's plugin resources (so the run exercises the working tree, not
 * `target/debug`'s stale copies), a disposable DSH_HOME, and a headless Edge
 * profile. No model calls; nothing here talks to a provider.
 *
 * Usage:
 *   node tools/lan-model-page.mjs
 *
 * Optional environment:
 *   LAN_SETTINGS_DIR       smoke root            (target/lan-settings-ownership)
 *   LAN_SETTINGS_PORT      LAN port of the host  (13092)
 *   LAN_SETTINGS_ADDRESS   bind address          (first private IPv4 found)
 *   DSH_SEED_HOME          populated DSH_HOME    (target/remote-control-live/dsh-home)
 *   CDP_PORT               app window CDP port   (9362)
 *   EDGE_CDP_PORT          browser CDP port      (9363)
 *   EDGE_PATH              msedge.exe            (the usual install path)
 *   LAN_SETTINGS_EVIDENCE  evidence directory    (plan/lan-settings-ownership-evidence)
 *   LAN_SETTINGS_WITHOUT_FIX  `1` measures the build BEFORE this fix, by removing
 *                          only the ownership declaration from the copied tree
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { networkInterfaces } from 'node:os'
import { connect } from './terminal-cdp.mjs'
import assert from 'node:assert/strict'

const root = resolve(process.env.LAN_SETTINGS_DIR || 'src-tauri/target/lan-settings-ownership')
const evidence = resolve(process.env.LAN_SETTINGS_EVIDENCE || 'plan/lan-settings-ownership-evidence')
const lanPort = Number(process.env.LAN_SETTINGS_PORT || 13092)
const cdpPort = Number(process.env.CDP_PORT || 9362)
const edgePort = Number(process.env.EDGE_CDP_PORT || 9363)
const seedHome = resolve(process.env.DSH_SEED_HOME || 'src-tauri/target/remote-control-live/dsh-home')
const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const withoutFix = process.env.LAN_SETTINGS_WITHOUT_FIX === '1'
const suffix = withoutFix ? '.before' : ''
const sleep = ms => new Promise(r => setTimeout(r, ms))
const checks = []

/** The private IPv4 this machine actually reaches the LAN on. */
function lanAddress() {
  const named = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list || []).map(entry => ({ name, ...entry })))
  const candidates = named.filter(entry => entry.family === 'IPv4' && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))
  const preferred = candidates.find(entry => /WLAN|Wi-Fi|以太网|Ethernet/i.test(entry.name)) || candidates[0]
  assert.ok(preferred, 'a private IPv4 LAN adapter is required')
  return preferred.address
}

/** Wait for a CDP target on `port` and return its client. */
async function connectWhenReady(port, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const client = await connect(port).catch(() => undefined)
    if (client) return client
    await sleep(250)
  }
  throw Error(`no CDP target on port ${port}`)
}

/** Evaluate until the expression answers truthy, then return that answer. */
async function until(client, expression, timeout = 60000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await client.evaluate(expression)
      if (last) return last
    } catch (error) {
      last = error.message
    }
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

/**
 * Open 设置 → 模型 and report what the page decided.
 *
 * Read as a whole page rather than one selector: the failure state renders ONLY
 * the error line and its 重试 button (no title, no intro), so the presence of the
 * intro text is what distinguishes "the directory loaded" from "the page failed".
 */
async function modelsPanel(client) {
  await client.evaluate(`(()=>{const trigger=[...document.querySelectorAll('button[aria-haspopup=dialog]')].find(b=>b.offsetParent!==null);trigger?.click()})()`)
  await until(client, `[...document.querySelectorAll('button')].some(b=>b.textContent==='模型')`)
  await client.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='模型').click()`)
  await until(client, `/(加载提供方目录失败|填入各提供方的 API 密钥即可使用其模型)/.test(document.body.innerText)`)
  return client.evaluate(`(()=>{const text=document.body.innerText;return {
    origin:location.origin,
    hostname:location.hostname,
    transport:window.__DSH_TRANSPORT__===undefined?null:window.__DSH_TRANSPORT__,
    browserDocument:document.documentElement.hasAttribute('data-dsh-browser'),
    loadFailed:text.includes('加载提供方目录失败'),
    errorLine:(text.match(/加载提供方目录失败[^\\n]*/)||[null])[0],
    intro:text.includes('填入各提供方的 API 密钥即可使用其模型'),
  }})()`)
}

async function screenshot(client, file) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(file, Buffer.from(shot.data, 'base64'))
}

let app, edge, appClient, edgeClient, config, dshVersion
try {
  await mkdir(root, { recursive: true })
  await mkdir(evidence, { recursive: true })
  const exe = join(root, 'deepseek-harness-desktop.exe')
  await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'), exe)
  // The plugin assets are read live by the host plugin, so the copy is what makes
  // this run measure the working tree rather than a previous build's snapshot.
  const resources = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources
  for (const [src, dest] of Object.entries(resources)) {
    const target = join(root, dest)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(resolve('src-tauri', src), target)
  }
  dshVersion = await readFile(resolve(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')
    .then(text => JSON.parse(text).version, () => null)

  // `LAN_SETTINGS_WITHOUT_FIX=1` reproduces the build before this fix: the same
  // copied tree with ONLY the host-ownership declaration removed. Measuring both
  // directions against one backend is what turns "the models page loads now" into
  // a causal claim about that declaration, rather than a correlation.
  if (withoutFix) {
    const file = join(root, 'dsh-plugin/ui-overlay/browser-compat.js')
    const source = await readFile(file, 'utf8')
    const stripped = source.replace('window.__DSH_TRANSPORT__ = carrier', 'void carrier /* before the fix */')
    assert.notEqual(stripped, source, 'the ownership declaration must be present to strip it')
    await writeFile(file, stripped)
    console.log('LAN_SETTINGS_WITHOUT_FIX: host-ownership declaration removed from the copy')
  }

  const address = process.env.LAN_SETTINGS_ADDRESS || lanAddress()
  config = { version: 1, enabled: true, bindAddress: address, port: lanPort, trustedHosts: [] }
  await writeFile(join(root, 'remote-control.json'), JSON.stringify(config, null, 2))
  console.log(`LAN ${address}:${lanPort}  DSH_HOME ${seedHome}`)

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
  appClient = await connectWhenReady(cdpPort, 90000)
  const identity = await until(appClient, `window.__DSH_REMOTE_IDENTITY__ && window.__TAURI__.core.invoke('remote_status',{identity:window.__DSH_REMOTE_IDENTITY__})`, 90000)
  assert.equal(identity.state, 'lan', JSON.stringify(identity))
  assert.equal(identity.active.bindAddress, address)
  for (let i = 0; i < 15; i++) { await appClient.evaluate(DISMISS); await sleep(150) }

  // ── the desktop window: served from the LAN address, and it must still be the
  // host's own window to DSH ─────────────────────────────────────────────────
  const desktop = await modelsPanel(appClient)
  await screenshot(appClient, join(evidence, `desktop-models${suffix}.png`))
  assert.equal(desktop.hostname, address, 'the desktop window must be on the LAN origin')
  assert.equal(desktop.browserDocument, false, 'the desktop window is not a browser page')
  if (withoutFix) {
    // The reported failure, reproduced on the real window: no declaration, so DSH
    // classifies this page as a remote browser and the models page cannot render.
    assert.equal(desktop.transport, null)
    assert.equal(desktop.loadFailed, true, 'the build before the fix must reproduce the report')
    assert.match(desktop.errorLine, /settings are unavailable in this browser/)
    checks.push({ surface: 'desktop window (before the fix)', ...desktop })
    console.log('PASS (before the fix) the desktop window on the LAN origin fails 设置 → 模型 exactly as reported')
  } else {
    assert.deepEqual(desktop.transport, { ownsHost: true }, 'the desktop window owns the host it is served from')
    assert.equal(desktop.loadFailed, false, `the provider directory must load: ${desktop.errorLine}`)
    assert.equal(desktop.intro, true, 'the models section must render its own body')
    checks.push({ surface: 'desktop window', ...desktop })
    console.log('PASS desktop window on the LAN origin loads 设置 → 模型')
  }

  const info = await appClient.evaluate(`window.__TAURI__.core.invoke('remote_connection_info',{identity:window.__DSH_REMOTE_IDENTITY__})`)
  assert.ok(info.url.startsWith(`http://${address}:${lanPort}/`), `login link must name the LAN origin: ${info.url}`)

  // ── an ordinary browser on the same origin: upstream's memory-mode policy is
  // left exactly as DSH ships it, which is what keeps a remote page from writing
  // the host's settings document ──────────────────────────────────────────────
  edge = spawn(edgePath, [
    '--headless=new', `--remote-debugging-port=${edgePort}`, `--user-data-dir=${join(root, 'edge-profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  edgeClient = await connectWhenReady(edgePort)
  await edgeClient.send('Page.enable')
  // Desktop-sized on purpose: this page exists to measure the settings decision,
  // which does not depend on the viewport. The phone layout is covered by
  // tools/remote-control-browser.mjs.
  await edgeClient.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await edgeClient.send('Page.navigate', { url: info.url })
  await until(edgeClient, `Boolean(document.querySelector('#root')?.childElementCount)`, 60000)
  for (let i = 0; i < 15; i++) { await edgeClient.evaluate(DISMISS); await sleep(150) }
  const browserPage = await modelsPanel(edgeClient)
  await screenshot(edgeClient, join(evidence, `browser-models${suffix}.png`))
  assert.equal(browserPage.hostname, address, 'the ordinary browser is on the same LAN origin')
  assert.equal(browserPage.transport, null, 'a page with no Tauri bridge must never claim host ownership')
  assert.equal(browserPage.browserDocument, true)
  assert.equal(browserPage.loadFailed, true, 'upstream memory mode is unchanged for a remote page')
  assert.match(browserPage.errorLine, /settings are unavailable in this browser/)
  checks.push({ surface: 'ordinary browser', ...browserPage })
  console.log('PASS ordinary browser on the same origin keeps memory-mode settings')

} finally {
  edgeClient?.close(); edge?.kill()
  appClient?.close()
  // The app owns a Windows job object, so killing it takes the `dsh web` tree with it.
  app?.kill()
  try {
    await writeFile(join(evidence, `lan-model-page${suffix}.json`), JSON.stringify({
      date: new Date().toISOString(), mode: withoutFix ? 'before-the-fix' : 'working-tree',
      dsh: dshVersion, config, dshHome: seedHome, checks,
    }, null, 2))
  } catch {}
}
