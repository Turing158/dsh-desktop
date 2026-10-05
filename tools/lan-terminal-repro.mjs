/** Reproduction: does the UI terminal work when DSH is LAN-bound FROM LAUNCH?
 *
 * The existing `remote-terminal-integration.mjs` opens the terminal FIRST and
 * then enables LAN, so the terminal attaches at the loopback origin and merely
 * survives the restart. This harness is the other order — the one a user is in
 * when they enable remote control and then try to use the terminal:
 *
 *   cold start with `remote-control.json` already LAN enabled
 *     -> page loads AT the LAN origin
 *     -> open the terminal from the right column's guide, through real clicks
 *
 * Everything about the desktop page is reported before any assertion, so a
 * failure names which layer broke (page identity, plugin registration, guide
 * entry, dock, or the native transport).
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, writeFile, readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { networkInterfaces } from 'node:os'
import { connect } from './terminal-cdp.mjs'

const root = await mkdtemp(resolve('src-tauri/target/lan-terminal-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const cdpPort = 9361
const exe = join(root, 'deepseek-harness-desktop.exe')
await copyFile(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'), exe)
for (const [source, destination] of Object.entries(JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).bundle.resources)) {
  const target = join(root, destination)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(resolve('src-tauri', source), target)
}
const address = Object.values(networkInterfaces()).flat()
  .find(i => i?.family === 'IPv4' && !i.internal && /^192\.168\./.test(i.address))?.address
assert.ok(address, 'a LAN adapter is required')
const lanPort = 13091
await writeFile(join(root, 'remote-control.json'), JSON.stringify({ version: 1, enabled: true, bindAddress: address, port: lanPort, trustedHosts: [] }))
await writeFile(join(root, 'command.json'), '{}')

const child = spawn(exe, [], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: {
    ...process.env,
    DSH_HOME: join(root, 'dsh-home'),
    DSH_DESKTOP_SMOKE_DIR: root,
    DSH_DESKTOP_DEBUG: join(root, 'host.log'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdpPort,
  },
})

let c
async function until(expression, timeout = 90000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      c ||= await connect(cdpPort)
      const value = await c.evaluate(expression)
      if (value) return value
    } catch (error) { last = error.message; c?.close(); c = null }
    await sleep(200)
  }
  throw Error('Timed out: ' + expression.slice(0, 120) + (last ? ' — ' + last : ''))
}

const report = { address, lanPort }
/** Everything the desktop page can be asked about itself, in one read. */
const PAGE_STATE = `(()=>({
  href: location.href.split('?')[0],
  origin: location.origin,
  boot: window.__DSH_UI_BOOT__ ? { appOrigin: window.__DSH_UI_BOOT__.appOrigin, smoke: window.__DSH_UI_BOOT__.smoke } : null,
  tauri: Boolean(window.__TAURI__),
  invoke: typeof window.__TAURI__?.core?.invoke,
  channel: typeof window.__TAURI__?.core?.Channel,
  terminalGlobal: Boolean(window.DSHTerminal),
  terminalIdentity: window.__DSH_TERMINAL_IDENTITY__ ?? null,
  smokeContext: Boolean(window.__DSH_SMOKE_CONTEXT__),
  remoteIdentity: Boolean(window.__DSH_REMOTE_IDENTITY__),
  html: { ui: document.documentElement.getAttribute('data-dsh-ui'), browser: document.documentElement.hasAttribute('data-dsh-browser') },
  titleBar: { bar: Boolean(document.querySelector('.dshTb')), quick: document.querySelectorAll('.dshTb__quickItem').length, controls: document.querySelectorAll('.dshTb__controls').length },
  terminals: document.querySelectorAll('[data-dsh-terminal]').length,
  docks: document.querySelectorAll('[data-dsh-terminal-dock]').length,
  toggles: document.querySelectorAll('[data-dsh-terminal-dock-toggle]').length,
}))()`
try {
  // Wait for the DSH page itself, then read everything it can say about itself
  // BEFORE asserting — a failure has to name its layer, not just "timed out".
  await until(`Boolean(document.querySelector('#root') && window.__DSH_UI_BOOT__)`, 120000)
  report.page = await c.evaluate(PAGE_STATE)
  console.log('page:', JSON.stringify(report.page))

  // The shell injects this on every load of its own document. Its ABSENCE after
  // the app has mounted is the layer that breaks the terminal at a LAN origin.
  report.identityAt = await until(`Boolean(window.__DSH_TERMINAL_IDENTITY__)`, 15000)
    .then(() => 'injected')
    .catch(() => 'MISSING')
  console.log('terminal identity:', report.identityAt)

  await until(`Boolean(window.__DSH_SMOKE_CONTEXT__?.sessions.list.getSnapshot().phase==='ready')`)
  // Clear the first-run prompts that would eat clicks.
  for (let i = 0; i < 12; i++) {
    await c.evaluate(`(()=>{for(const b of document.querySelectorAll('button')){if(b.textContent==='稍后配置'||b.textContent==='继续')b.click()}})()`)
    await sleep(200)
  }
  await until(`!document.querySelector('[data-dsh-ui-status]')`, 30000).catch(() => {})

  report.pageClasses = await c.evaluate(`({
    ui: document.documentElement.getAttribute('data-dsh-ui'),
    browser: document.documentElement.hasAttribute('data-dsh-browser'),
    titleBar: Boolean(document.querySelector('.dshTb')),
    quick: document.querySelectorAll('.dshTb__quickItem').length,
    controls: document.querySelectorAll('.dshTb__controls').length,
  })`)
  console.log('mode:', JSON.stringify(report.pageClasses))

  // The right column's tab registry is what the guide renders from. Read the
  // REAL accessors (`entries()` / `guide()`): whether this page claims the type.
  report.registry = await c.evaluate(`(()=>{
    const D = window.__DSH_TERMINAL_SMOKE__
    const tabs = D.ctx.sidebarRightTabs
    const entries = tabs.entries().map(t => ({ id: t.id, kind: t.kind, guide: (t.guide ?? []).length }))
    return {
      terminalGlobal: Boolean(window.DSHTerminal),
      smoke: Boolean(D) && Boolean(D.registry) && Boolean(D.dock),
      kinds: entries.map(t => t.kind),
      types: entries,
      guideEntries: tabs.guide().map(g => ({ kind: g.kind, order: g.order })),
      claimsTerminal: entries.some(t => t.kind === 'desktop-terminal'),
      hasTerminalGetter: typeof tabs.get('desktop-terminal') !== 'undefined',
    }
  })()`)
  console.log('registry:', JSON.stringify(report.registry))

  // Every client plugin that binds a settings namespace reads through a scope the
  // Host only fills on a loopback page. Report which ones can actually persist
  // here, so the LAN limitation is measured rather than assumed.
  report.scopes = await c.evaluate(`(()=>{
    const ctx = window.__DSH_SMOKE_CONTEXT__
    const names = ['desktop-terminal-dock', 'desktop-appearance', 'ui-theme', 'ui-chat', 'ui-onboarding', 'permission']
    return names.map(ns => {
      try {
        const scope = ctx.settingsScope.bind({ namespace: ns })
        const snap = scope.getSnapshot()
        return { ns, status: snap.status, mode: snap.mode, value: snap.value === undefined ? null : snap.value }
      } catch (error) { return { ns, error: String(error) } }
    })
  })()`)
  console.log('scopes:', JSON.stringify(report.scopes))

  // Open a real session so the right column (and its guide) exists.
  await c.evaluate(`(async()=>{const ctx=window.__DSH_SMOKE_CONTEXT__;const w=await ctx.workspaces.create({path:${JSON.stringify(root)}});await ctx.uiWorkspace.openWorkspace(w.workspaceId)})()`)
  await until(`Boolean(window.__DSH_SMOKE_CONTEXT__.sessions.list.getSnapshot().current)`)
  await c.evaluate(`(()=>{ window.D = window.__DSH_TERMINAL_SMOKE__ })()`)
  await sleep(400)
  // Bring the right column on screen the way a user does: the mark's toggle.
  for (let i = 0; i < 8; i++) {
    if (await c.evaluate(`document.querySelectorAll('[data-sidebar-right-guide]').length > 0`)) break
    await c.evaluate(`(()=>{
      const marks = [...document.querySelectorAll('.dshTb__mark, [data-sidebar-right-toggle], button[aria-label*="侧边栏"]')]
      const last = [...document.querySelectorAll('button')].filter(b => /侧边栏|面板|展开/.test(b.getAttribute('aria-label') || b.title || ''))
      ;(marks[marks.length - 1] ?? last[0])?.click()
    })()`)
    await sleep(500)
  }

  // Is the terminal type registered at all on this page, and where is the guide?
  report.guide = await c.evaluate(`(()=>({
    entries: [...document.querySelectorAll('[data-sidebar-right-guide-entry]')].map(el => el.getAttribute('data-sidebar-right-guide-entry')),
    terminalEntry: document.querySelectorAll('[data-sidebar-right-guide-entry="desktop-terminal"]').length,
    guide: document.querySelectorAll('[data-sidebar-right-guide]').length,
    panel: Boolean(document.querySelector('[data-sidebar-right-panel]')),
    toggle: document.querySelectorAll('[data-dsh-terminal-dock-toggle]').length,
  }))()`)
  console.log('guide:', JSON.stringify(report.guide))

  if (report.guide.terminalEntry) {
    await c.evaluate(`document.querySelector('[data-sidebar-right-guide-entry="desktop-terminal"]').click()`)
    await sleep(2000)
    report.afterClick = await c.evaluate(`(()=>({
      terminalPanel: document.querySelectorAll('.dshTerminal').length,
      dock: document.querySelectorAll('[data-dsh-terminal-dock]').length,
      dockRows: Boolean(document.querySelector('.dshTerminalDock .xterm-rows')),
      placeholder: document.body.innerText.includes('请在桌面应用中打开终端'),
      message: document.querySelector('.dshTerminal__message')?.textContent ?? null,
      status: document.querySelector('[data-dsh-terminal-status]')?.textContent ?? null,
      body: (document.querySelector('[data-sidebar-right-panel]')?.innerText || '').replace(/\\s+/g,' ').slice(0, 200),
    }))()`)
    console.log('after click:', JSON.stringify(report.afterClick))
  }

  // Drive the plugin's own entry point, independent of which surface is on screen.
  // `invoke` is wrapped for the duration so the RAW native refusal is captured:
  // the surface maps errors to one friendly sentence, which hides the cause.
  report.openSidebar = await c.evaluate(`(async()=>{
    const core = window.__TAURI__.core, original = core.invoke
    const rejects = [], console_ = []
    const originalError = console.error, originalWarn = console.warn
    console.error = (...args) => { if (console_.length < 20) console_.push({ level: 'error', text: args.map(a => (a && a.stack) ? a.stack : String(a)).join(' ').slice(0, 300) }); originalError.apply(console, args) }
    console.warn = (...args) => { if (console_.length < 20) console_.push({ level: 'warn', text: args.map(a => (a && a.stack) ? a.stack : String(a)).join(' ').slice(0, 300) }); originalWarn.apply(console, args) }
    core.invoke = function (name, args) {
      const call = original.call(core, name, args)
      if (call && typeof call.then === 'function') call.then(undefined, error => { if (rejects.length < 24) rejects.push({ name, error: String(error) }) })
      return call
    }
    try {
      const key = D.registry.openSidebar('auto')
      window.__REPRO_KEY__ = key
      await new Promise(r=>setTimeout(r,3500))
      const surface = document.querySelector('.dshTerminal')
      const statusEl = document.querySelector('[data-dsh-terminal-status]')
      return {
        key,
        status: statusEl?.textContent?.trim() ?? null,
        tone: statusEl?.getAttribute('data-dsh-terminal-tone') ?? null,
        tip: statusEl?.getAttribute('title') ?? null,
        rejects,
        consoleMessages: console_,
        surfaceText: (surface?.innerText || '').replace(/\\s+/g,' ').slice(0, 240),
        rowsHtml: document.querySelector('.xterm-rows')?.textContent?.slice(0, 160) ?? null,
      }
    } finally { core.invoke = original; console.error = originalError; console.warn = originalWarn }
  })()`)
  console.log('openSidebar:', JSON.stringify(report.openSidebar, null, 1))

  // A real copy, produced by the gesture that actually pads a selection: an
  // ALT+DRAG picks xterm's rectangular (block) mode, and every row of a block is
  // padded to its right edge. The copy event must drop that padding.
  {
    // The developer's clipboard is borrowed for this check and put back at the end.
    const clipboardSaved = await c.evaluate(`window.__TAURI__.core.invoke('clipboard_read_text')`)
    await c.evaluate(`(()=>{ const live = D.registry.viewFor(window.__REPRO_KEY__); live.type('echo COPY-PADDING-PROBE\\r') })()`)
    for (let i = 0; i < 60; i++) {
      await sleep(200)
      const seen = await c.evaluate(`(document.querySelector('.xterm-rows')?.textContent || '').includes('COPY-PADDING-PROBE')`)
      if (seen) break
    }
    await sleep(500)
    const geom = await c.evaluate(`(()=>{
      const live = D.registry.viewFor(window.__REPRO_KEY__)
      const buffer = live.buffer()
      const row = buffer.find(entry => entry.text.includes('COPY-PADDING-PROBE'))
      if (!row) return { error: 'marker not on screen', tail: buffer.slice(-3).map(entry => entry.text) }
      const screen = document.querySelector('.dshTerminal .xterm-screen')
      const box = screen.getBoundingClientRect()
      // A block is padded on every row shorter than its right edge, so the drag
      // spans TWO rows: the row below the marker is a shell prompt, far shorter
      // than the 40 columns the block reaches.
      const rows = [row.index, row.index + 1].filter(index => buffer.some(entry => entry.index === index))
      return { rows, column: 0, endColumn: 40, row: row.index, text: row.text, lengths: rows.map(index => buffer.find(entry => entry.index === index).text.length), box: { x: box.x, y: box.y, width: box.width, height: box.height }, mode: live.selectionMode() }
    })()`)
    report.dragGeometry = geom
    if (!geom.error) {
      const cellWidth = geom.box.width / 80
      const cellHeight = geom.box.height / 24
      const x = column => Math.round(geom.box.x + column * cellWidth + cellWidth / 2)
      const y = row => Math.round(geom.box.y + row * cellHeight + cellHeight / 2)
      const last = geom.rows[geom.rows.length - 1]
      const clipboardBefore = clipboardSaved
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x(geom.column), y: y(geom.row), button: 'left', clickCount: 1, modifiers: 1, buttons: 1 })
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x(geom.endColumn - 1), y: y(last), button: 'left', modifiers: 1, buttons: 1 })
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x(geom.endColumn - 1), y: y(last), button: 'left', clickCount: 1, modifiers: 1 })
      await sleep(400)
      const selection = await c.evaluate(`(()=>{
        const live = D.registry.viewFor(window.__REPRO_KEY__)
        return { mode: live.selectionMode(), raw: live.rawSelection(), copyText: live.copyText() }
      })()`)
      // Watch the real event end to end: which targets see it, what each writes,
      // and what the final DataTransfer holds.
      await c.evaluate(`(()=>{
        window.__COPY_TRACE__ = []
        const screen = document.querySelector('.dshTerminal__screen')
        const xterm = document.querySelector('.dshTerminal .xterm')
        const watch = (node, name) => {
          if (!node) return
          for (const phase of [true, false]) node.addEventListener('copy', event => {
            const data = event.clipboardData
            window.__COPY_TRACE__.push({ node: name, phase: phase ? 'capture' : 'bubble', target: event.target?.className || event.target?.tagName, hasData: Boolean(data), before: data ? data.getData('text/plain').length : null })
            if (data && name === 'screen' && phase) data.setData('text/plain', 'TRIMMED-BY-HARNESS')
            if (data) setTimeout(() => window.__COPY_TRACE__.push({ node: name + '/' + (phase ? 'capture' : 'bubble') + ' after', length: data.getData('text/plain').length, head: data.getData('text/plain').slice(0, 24) }), 0)
          }, phase)
        }
        watch(screen, 'screen'); watch(xterm, 'xterm')
      })()`)
      // The OS copy chord, exactly as xterm answers it.
      const copyRan = await c.evaluate(`(()=>{ try { return document.execCommand('copy') } catch (error) { return 'threw: ' + String(error) } })()`)
      await sleep(400)
      const clipboardAfter = await c.evaluate(`window.__TAURI__.core.invoke('clipboard_read_text')`)
      // Leave the developer's clipboard as it was found.
      await c.evaluate(`window.__TAURI__.core.invoke('clipboard_write_text', { text: ${JSON.stringify(clipboardSaved ?? '')} })`)
      const pad = line => { const at = line.charCodeAt(line.length - 1); return at === 32 || at === 9 }
      report.copy = {
        selectionMode: selection.mode,
        raw: { length: selection.raw.length, padded: selection.raw.split('\n').filter(pad).length, value: selection.raw.slice(0, 90) },
        copyText: { length: selection.copyText.length, padded: selection.copyText.split('\n').filter(pad).length, value: selection.copyText.slice(0, 90) },
        copyRan,
        copied: { length: String(clipboardAfter ?? '').length, padded: String(clipboardAfter ?? '').split('\n').filter(pad).length, value: String(clipboardAfter ?? '').slice(0, 90) },
        clipboardChanged: clipboardAfter !== clipboardBefore,
      }
      console.log('copy:', JSON.stringify(report.copy, null, 1))
      // The gesture really did produce a padded block selection ...
      assert.equal(report.copy.selectionMode, 3, 'the alt+drag must produce xterm block selection')
      assert.ok(report.copy.raw.padded > 0, 'the raw block selection must carry padding')
      // ... and the clipboard really did lose exactly that padding.
      assert.ok(report.copy.clipboardChanged, 'the copy chord must write the clipboard')
      assert.equal(report.copy.copied.padded, 0, 'the clipboard must not carry the padding')
      assert.equal(report.copy.copied.value, report.copy.raw.value.replace(/[ \t]+$/, ''), 'the clipboard must be the raw selection with its padding removed')
    }
  }

  // The view object behind the mounted surface holds the message the UI maps to
  // one sentence. React keeps it in the component's hooks, so read it directly.
  report.viewState = await c.evaluate(`(()=>{
    const surface = document.querySelector('.dshTerminal')
    if (!surface) return { error: 'no surface mounted' }
    const key = Object.keys(surface).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
    let fiber = key ? surface[key] : null
    for (let up = 0; up < 8 && fiber; up++) {
      const hooks = fiber.memoizedState
      let hook = hooks, index = 0
      while (hook && index < 12) {
        const value = hook.memoizedState
        if (value && typeof value === 'object' && ('key' in value) && ('message' in value || 'readyForInput' in value)) {
          return { found: true, key: value.key, message: value.message ?? null, readyForInput: value.readyForInput ?? null,
            info: value.info ? { state: value.info.state, error: value.info.error ?? null, cwd: value.info.cwd, profileId: value.info.profileId } : null,
            profiles: value.profiles }
        }
        hook = hook.next; index++
      }
      fiber = fiber.return
    }
    return { found: false, surfaceText: surface.innerText.replace(/\\s+/g,' ').slice(0, 200) }
  })()`)
  console.log('viewState:', JSON.stringify(report.viewState, null, 1))
  // Walk the exact sequence the view's `connect()` walks, stopping at the first
  // refusal and naming the RAW error (the surface only shows a mapped sentence).
  report.sequence = await c.evaluate(`(async()=>{
    const steps = [], timestamp = () => new Date().toISOString()
    const identity = window.__DSH_TERMINAL_IDENTITY__
    const call = (name, args={}) => window.__TAURI__.core.invoke(name, { identity, ...args })
    let info = null
    try {
      const profiles = await call('terminal_profiles'); steps.push({ step: 'terminal_profiles', ok: true, profiles: profiles.length })
      info = await call('terminal_open', { resourceKey: 'dsh-resource://desktop-terminal/seq', profileId: null, cwd: ${JSON.stringify(root)} })
      steps.push({ step: 'terminal_open', ok: true, state: info.state, terminalId: info.terminalId })
      const channel = new window.__TAURI__.core.Channel()
      const packets = []
      channel.onmessage = packet => { if (packets.length < 40) packets.push({ seq: packet.seq, type: packet.type, kind: packet.record?.kind ?? null }) }
      const attachment = await call('terminal_attach', { terminalId: info.terminalId, runId: info.runId, viewId: crypto.randomUUID(), channel })
      steps.push({ step: 'terminal_attach', ok: true, attachment })
      await new Promise(r => setTimeout(r, 1500))
      steps.push({ step: 'packets', count: packets.length, packets })
      // ACK everything the server sent, then ask for control — the same order the
      // view uses — and report the server's own answer.
      const last = packets.reduce((max, p) => Math.max(max, p.seq || 0), 0)
      try { await call('terminal_ack', { terminalId: info.terminalId, runId: info.runId, attachmentId: attachment, seq: last }); steps.push({ step: 'terminal_ack', ok: true, seq: last }) }
      catch (error) { steps.push({ step: 'terminal_ack', ok: false, seq: last, error: String(error) }) }
      try { const epoch = await call('terminal_control', { terminalId: info.terminalId, runId: info.runId, attachmentId: attachment }); steps.push({ step: 'terminal_control', ok: true, epoch })
        await call('terminal_write', { terminalId: info.terminalId, runId: info.runId, attachmentId: attachment, epoch, data: 'echo seq-probe\\r' }).then(() => steps.push({ step: 'terminal_write', ok: true }), error => steps.push({ step: 'terminal_write', ok: false, error: String(error) }))
        await new Promise(r => setTimeout(r, 1500))
        steps.push({ step: 'packets-after-write', count: packets.length })
      } catch (error) { steps.push({ step: 'terminal_control', ok: false, error: String(error) }) }
      await call('terminal_detach', { terminalId: info.terminalId, runId: info.runId, attachmentId: attachment }).catch(() => {})
      await call('terminal_close', { terminalId: info.terminalId, runId: info.runId }).catch(() => {})
    } catch (error) {
      steps.push({ step: 'THREW', error: String(error), info })
      if (info) await call('terminal_close', { terminalId: info.terminalId, runId: info.runId }).catch(() => {})
    }
    return steps
  })()`)
  console.log('sequence:', JSON.stringify(report.sequence, null, 1))

  // The transport itself, called exactly as the page's own client calls it.
  report.transport = await c.evaluate(`(async()=>{
    const identity = window.__DSH_TERMINAL_IDENTITY__
    const call = (name, args={}) => window.__TAURI__.core.invoke(name, { identity, ...args })
    try {
      const profiles = await call('terminal_profiles')
      const opened = await call('terminal_open', { resourceKey: 'dsh-resource://desktop-terminal/repro', profileId: 'cmd', cwd: ${JSON.stringify(root)} })
      await new Promise(r => setTimeout(r, 700))
      const list = await call('terminal_list')
      await call('terminal_close', { terminalId: opened.terminalId, runId: opened.runId })
      return { ok: true, profiles: profiles.length, state: list.find(v => v.terminalId === opened.terminalId)?.state }
    } catch (error) { return { ok: false, error: String(error) } }
  })()`)
  console.log('transport:', JSON.stringify(report.transport))

  assert.equal(report.pageClasses.browser, false, 'the desktop page must not be detected as a browser page')
  assert.equal(report.pageClasses.titleBar, true, 'the desktop title bar must exist')
  // The type and its guide entry must be claimed by this page ...
  assert.equal(report.registry.claimsTerminal, true, 'the page must register the desktop-terminal tab type')
  assert.ok(report.registry.guideEntries.some(entry => entry.kind === 'desktop-terminal'), 'the guide must offer the terminal entry')
  // ... and the terminal opened through the plugin must actually work: running,
  // with no failure sentence in its tooltip, no refused native call, and a real
  // shell prompt painted on its screen.
  assert.ok(report.openSidebar.status && report.openSidebar.status.includes('运行中'), 'the terminal must reach 运行中 — got ' + JSON.stringify(report.openSidebar))
  assert.ok(!/桌面连接中断|启动失败|暂不可用/.test(report.openSidebar.tip || ''), 'a working terminal must carry no failure tooltip — got ' + JSON.stringify(report.openSidebar.tip))
  assert.equal(report.openSidebar.rejects.length, 0, 'no native call may be refused: ' + JSON.stringify(report.openSidebar.rejects))
  assert.ok((report.openSidebar.rowsHtml || '').trim().length > 0, 'the shell must have painted a prompt: ' + JSON.stringify(report.openSidebar.rowsHtml))
  assert.deepEqual(report.openSidebar.consoleMessages, [], 'the page must log no error while opening a terminal')
  assert.ok(report.transport.ok, 'the native terminal transport must answer: ' + JSON.stringify(report.transport))
  console.log('\nRESULT: the desktop terminal runs with LAN bound from launch')
} finally {
  c?.close()
  if (child.exitCode === null) {
    const exited = new Promise(r => child.once('exit', r))
    await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: Date.now(), action: 'quit' }))
    await Promise.race([exited, sleep(12000).then(() => child.kill())])
  }
  await writeFile(join(root, 'lan-terminal-repro.json'), JSON.stringify({ date: new Date().toISOString(), report }, null, 2))
  console.log('Evidence: ' + root)
}
