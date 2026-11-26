// Complete desktop overlay, disposable profile, offline model/MCP, real Edge.
// CPU comes from OS process counters. No inspector is attached to a live backend.
import assert from 'node:assert/strict'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { handleOnboarding, dismissInitialWelcome, openDshSettings, offlineModelPatch } from './dsh-ui-helpers.mjs'
import { runtimeImport } from '../dsh-plugin/runtime-import.mjs'

export const inject = ['webServer', 'tools', 'llm', 'agents', 'sessions', 'mcpManager']
export function observeStartup(ctx) {
  ctx.effect(() => {
    const timer = setTimeout(() => {
      const pending = [...ctx.loader.entries()].filter(entry => entry.fiber?.state !== 2 && !entry.disabled)
        .map(entry => ({ id: entry.options.id, state: entry.fiber?.state, error: entry.fiber?.error?.message }))
      process.stderr.write('[idle-startup] ' + JSON.stringify(pending) + '\n')
    }, 3000)
    return () => clearTimeout(timer)
  })
}
export async function apply(ctx) {
  const root = process.env.DSH_IDLE_SMOKE_ROOT
  assert.ok(root, 'isolated smoke root required')
  const { LlmAdapter, createUserMessage } = await runtimeImport('@deepseek-ai/dsh-llm')
  let steps = 0, modelTools = [], taskErrors = []
  ctx.on('agent/error', event => { taskErrors.push(event.error?.stack || String(event.error)) })
  class FixtureModel extends LlmAdapter {
    async *stream(options) {
      // The runtime also calls this adapter for automatic session titles.
      // Keep those one-shot requests from consuming a scripted agent step.
      if (!options.tools?.length) {
        const block = { type: 'text', text: 'Idle MCP verification' }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: block.text }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      modelTools = (options.tools || []).map(tool => tool.name)
      if (steps < 2) {
        const name = steps++ === 0 ? 'mcp__idle_direct__idle_ping' : 'mcp__idle_managed__idle_ping'
        assert.ok(modelTools.includes(name), 'deferred MCP schema absent from model request: ' + name)
        const block = { type: 'tool-call', id: 'idle-call-' + steps, name, arguments: '{}' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['idle-smoke'], new FixtureModel())
  let handle
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__idle-smoke', handler: async (req, res) => {
    try {
      if (req.method === 'POST') {
        if (new URL(req.url, 'http://localhost').searchParams.has('restart')) {
          await ctx.mcpManager.restart('idle_managed')
        } else {
        handle ??= await ctx.agents.create({ sessionId: 'session-idle-smoke', meta: { cwd: root },
          agentOptions: { provider: 'idle-smoke', model: 'scripted' } })
        steps = 0
        handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run offline MCP verification.' }] }))
        await handle.agent.whenIdle()
        await ctx.sessions.flush(handle.agent.session)
        }
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ memory: process.memoryUsage(), steps, modelTools, taskErrors,
        tools: ctx.tools.definitions(handle?.agent).map(tool => tool.name), servers: ctx.mcpManager.list(),
        toolsPrototype: Object.getPrototypeOf(ctx.tools).constructor.name,
        probeGraph: ctx.get('clientModules').graph().entries.filter(row => row.id.includes('idle-smoke'))
          .map(row => ({ ...row, baseline: ctx.get('clientModules').artifactBaseline(row.id) })) }))
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })) }
  } }), 'idle-smoke: offline control')
}

const exists = async file => { try { await stat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const sleep = ms => new Promise(done => setTimeout(done, ms))
const runFile = promisify(execFile)
async function cpu(pid, durationMs, tree = false) {
  assert.ok(Number.isInteger(pid) && pid > 0 && Number.isFinite(durationMs) && durationMs > 0)
  // Sum deltas only for surviving processes. Browser utility processes may
  // retire while idle; record that measurement limit instead of subtracting
  // their old CPU from unrelated survivors or failing the whole test.
  const script = `
    $taskCpuCount=[Environment]::ProcessorCount; $taskIds=@(${pid})
    ${tree ? '$taskProcesses=Get-CimInstance Win32_Process; do { $taskChildren=@($taskProcesses | Where-Object { $_.ParentProcessId -in $taskIds -and $_.ProcessId -notin $taskIds } | ForEach-Object ProcessId); $taskIds+=$taskChildren } while ($taskChildren.Count -gt 0)' : ''}
    $taskBefore=@{}; Get-Process -Id $taskIds -ErrorAction SilentlyContinue | ForEach-Object { $taskBefore[$_.Id]=[double]$_.CPU }
    $taskClock=[Diagnostics.Stopwatch]::StartNew(); Start-Sleep -Milliseconds ${durationMs}
    $taskAfter=@(Get-Process -Id $taskIds -ErrorAction SilentlyContinue)
    if ($taskAfter.Id -notcontains ${pid}) { throw 'measured process exited' }
    $taskDelta=0.0; foreach ($taskProcess in $taskAfter) { $taskDelta += [Math]::Max(0, [double]$taskProcess.CPU-$taskBefore[$taskProcess.Id]) }
    [PSCustomObject]@{cpuPercent=$taskDelta/$taskClock.Elapsed.TotalSeconds/$taskCpuCount*100;workingSetBytes=($taskAfter | Measure-Object WorkingSet64 -Sum).Sum;processCount=$taskAfter.Count;exitedProcessCount=$taskBefore.Count-$taskAfter.Count} | ConvertTo-Json -Compress`
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: durationMs + 30000 })
  return JSON.parse(stdout)
}

async function main() {
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
  const bin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
  const root = await mkdtemp(resolve('src-tauri/target/diagnostics-'))
  const home = join(root, 'home'), probe = join(root, 'probe'), update = join(root, 'update-control')
  await Promise.all([home, probe, update].map(directory => mkdir(directory)))
  await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
  await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/idle-smoke', type: 'module', main: 'index.js',
    exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
  await writeFile(join(probe, 'index.js'), `export * from ${JSON.stringify(import.meta.url)}`)
  await writeFile(join(probe, 'observer.mjs'), `export { observeStartup as apply } from ${JSON.stringify(import.meta.url)};export const inject=['loader'];`)
  const probeClient = revision => `window.__ModuleLoader__.load({id:'@dsh-desktop/idle-smoke',factory:()=>({inject:['sessions','remote','modules'],apply(ctx){window.__IDLE_SMOKE__=ctx;window.__IDLE_SMOKE_REVISION__=${revision}}})})`
  await writeFile(join(probe, 'client.js'), probeClient(1))
  const config = name => ({ serverName: name, transport: 'stdio', command: process.execPath,
    args: [resolve('tools/idle-mcp-fixture.mjs'), join(root, name + '.started'), join(root, name + '.called')], startupTimeoutMs: 10000 })
  const direct = config('idle_direct'), managed = config('idle_managed')
  const overlay = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
    .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  const patch = overlay + offlineModelPatch
    + '\n- id: mcp-manager\n  config: ' + JSON.stringify({ servers: { idle_managed: { ...managed, enabled: true } } })
    + '\n- insert:\n    - id: idle-direct\n      name: "@deepseek-ai/dsh-mcp-client"\n      config: ' + JSON.stringify(direct)
    + '\n    - id: idle-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
    + '\n    - id: idle-observer\n      name: ' + pathToFileURL(join(probe, 'observer.mjs')).href + '\n'
  await writeFile(join(root, 'patch.yml'), patch)
  const report = { root, runtime: bin, immutableRuntimeRoot: process.env.DSH_DESKTOP_IMMUTABLE_RUNTIME_ROOT || null,
    checks: [], samples: [], browserErrors: [] }
  let child, browserChild, browser, page, output = ''
  const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
  try {
    child = spawn(process.execPath, ['--import', pathToFileURL(resolve('dsh-plugin/plugin-control/prepare-boot.mjs')).href,
      bin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        DSH_HOME: home, DSH_DESKTOP_DSH_BIN: bin, DSH_IDLE_SMOKE_ROOT: root,
        DSH_DESKTOP_PLUGINS_FILE: join(root, 'desktop-plugins.json'), DSH_DESKTOP_UPDATE_CONTROL: update,
        DSH_DESKTOP_CHANGES_DIR: join(root, 'changes'), NARB_NATIVE_CACHE_DIR: join(root, 'native-cache'),
        DSH_TELEMETRY_DISABLED: '1', DSH_UI_SMOKE_KEY: 'offline-fixture', NODE_OPTIONS: '',
      } })
    child.stdout.on('data', data => { output = (output + data).slice(-48000) })
    child.stderr.on('data', data => {
      output = (output + data).slice(-48000)
      if (String(data).includes('[idle-startup]')) console.log(String(data).trim())
    })
    let url
    for (let i = 0; i < 900; i++) {
      url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
      if (url) break
      if (child.exitCode !== null) throw Error(output)
      await sleep(100)
    }
    assert.ok(url, 'backend startup timed out: ' + output)
    // Playwright's ordinary launch forces focus/visibility in its own session.
    // Start a disposable Edge ourselves and attach with noDefaults so switching
    // tabs really hides the page; no properties or events are faked.
    const edgeProfile = join(root, 'edge-profile')
    const edgeExe = process.env.DSH_IDLE_SMOKE_EDGE || join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe')
    browserChild = spawn(edgeExe, ['--remote-debugging-port=0', '--user-data-dir=' + edgeProfile,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking'],
    { windowsHide: true, stdio: 'ignore' })
    let edgePort
    for (let i = 0; i < 200; i++) {
      try { edgePort = (await readFile(join(edgeProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break }
      catch { if (browserChild.exitCode !== null) throw Error('isolated Edge exited'); await sleep(100) }
    }
    assert.ok(edgePort, 'isolated Edge startup timed out')
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + edgePort, { noDefaults: true })
    const browserContext = browser.contexts()[0]
    page = await browserContext.newPage()
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.browserErrors.push(message.text()) })
    page.on('pageerror', error => report.browserErrors.push(error.message))
    for (const initial of browserContext.pages()) if (initial !== page) await initial.close()
    await page.setViewportSize({ width: 1280, height: 840 })
    const browserCdp = await browser.newBrowserCDPSession()
    const browserPid = (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo.find(info => info.type === 'browser').id
    const measure = async (scenario, durationMs) => {
      const [backend, browser] = await Promise.all([cpu(child.pid, durationMs), cpu(browserPid, durationMs, true)])
      const sample = { scenario, durationMs, backend, browser, cpuPercent: backend.cpuPercent + browser.cpuPercent }
      report.samples.push(sample)
      return sample
    }
    let requests = 0, editorRequests = 0
    const sockets = []
    page.on('request', request => {
      if (request.url().includes('/api/desktopPlugins/status')) requests++
      if (request.url().includes('/__dsh-desktop/file-editor/editor.mjs')) editorRequests++
    })
    page.on('websocket', socket => { if (socket.url().includes('remote.mux')) sockets.push(socket) })
    await handleOnboarding(page)
    await page.goto(url)
    await page.waitForFunction(() => window.__IDLE_SMOKE__?.sessions.list.getSnapshot().phase === 'ready', undefined, { timeout: 60000 })
    await dismissInitialWelcome(page)
    const state = () => page.evaluate(async () => {
      const response = await fetch('/__idle-smoke'); return { status: response.status, body: await response.json() }
    })
    await sleep(3000)
    assert.equal(await exists(join(root, 'idle_direct.started')), false)
    assert.equal(await exists(join(root, 'idle_managed.started')), false)
    pass('configured direct and managed MCP servers do not start for an idle session')
    assert.equal(editorRequests, 0)
    pass('editor engine is not requested during ordinary startup')
    const anonymousAsset = await fetch(new URL('/__dsh-desktop/file-editor/editor.mjs?v=untrusted', url))
    assert.ok([401, 403].includes(anonymousAsset.status))
    pass('lazy editor asset rejects unauthenticated requests')
    requests = 0; await sleep(4500); assert.equal(requests, 0)
    pass('closed plugin settings send zero periodic status requests')
    await openDshSettings(page)
    await page.locator('[data-shortcut-modal="settings"]').waitFor({ state: 'visible' })
    const section = page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: /^(插件|Plugins)$/i })
    if (await section.count()) await section.click()
    else {
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: /^(插件|Plugins)$/i }).first().click()
    }
    await page.getByRole('tab', { name: /^(内置插件|Built-in plugins)$/i }).click()
    await page.waitForFunction(() => document.querySelector('[data-plugin-id]'))
    requests = 0; await sleep(4500); assert.ok(requests >= 2)
    pass('mounted plugin settings refresh their live state')
    if (await page.locator('[data-shortcut-modal="settings"]').count()) {
      await page.keyboard.press('Escape'); await page.locator('[data-shortcut-modal="settings"]').waitFor({ state: 'hidden' })
    } else await page.getByRole('button', { name: /^(新建会话|New session)$/i }).first().click()
    await sleep(500); requests = 0; await sleep(4500); assert.equal(requests, 0)
    pass('closing plugin settings releases its polling timer')
    const before = await state(); assert.equal(before.status, 200)
    const visibleDuration = Number(process.env.DSH_IDLE_SMOKE_VISIBLE_MS || 30000)
    await measure('visible-idle', visibleDuration)
    assert.ok(report.samples.at(-1).cpuPercent < 1, 'visible idle CPU exceeds 1%')
    pass('visible idle backend and browser CPU averages below 1% combined')
    const background = await browserContext.newPage()
    await background.goto('about:blank'); await background.bringToFront()
    await page.waitForFunction(() => document.hidden, undefined, { polling: 250, timeout: 10000 })
    report.backgroundHidden = await page.evaluate(() => document.hidden)
    assert.equal(report.backgroundHidden, true, 'browser page must actually enter the background')
    await sleep(3000)
    const backgroundDuration = Number(process.env.DSH_IDLE_SMOKE_BACKGROUND_MS || 600000)
    console.log('Measuring background idle for ' + backgroundDuration + ' ms')
    await measure('background-idle', backgroundDuration)
    await background.close()
    await page.bringToFront(); await page.waitForFunction(() => !document.hidden, undefined, { polling: 250, timeout: 10000 })
    await page.waitForFunction(() => window.__IDLE_SMOKE__?.sessions.list.getSnapshot().phase === 'ready')
    const after = await state(); assert.equal(after.status, 200)
    assert.ok(sockets.some(socket => !socket.isClosed()), 'no live WebSocket after background restore')
    assert.equal(requests, 0)
    assert.ok(report.samples.at(-1).cpuPercent < 1, 'background idle CPU exceeds 1%')
    assert.ok(after.body.memory.rss <= before.body.memory.rss + 64 * 1024 * 1024, 'idle RSS grew more than 64 MiB')
    pass('background idle preserves the connection and keeps CPU/memory stable')
    const result = await page.evaluate(async () => {
      const response = await fetch('/__idle-smoke', { method: 'POST' }); return { status: response.status, body: await response.json() }
    })
    report.firstTask = result
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(await exists(join(root, 'idle_direct.started')), true)
    assert.equal(await exists(join(root, 'idle_managed.started')), true)
    assert.equal(await exists(join(root, 'idle_direct.called')), true)
    assert.equal(await exists(join(root, 'idle_managed.called')), true)
    assert.ok(result.body.tools.includes('mcp__idle_direct__idle_ping'))
    assert.ok(result.body.tools.includes('mcp__idle_managed__idle_ping'))
    pass('first task includes both MCP schemas in the model request and executes both tools')
    const started = await readFile(join(root, 'idle_managed.started'), 'utf8')
    const restarted = await page.evaluate(async () => {
      const response = await fetch('/__idle-smoke?restart=1', { method: 'POST' }); return { status: response.status, body: await response.json() }
    })
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body))
    assert.notEqual(await readFile(join(root, 'idle_managed.started'), 'utf8'), started)
    pass('explicit MCP restart starts a fresh server immediately')
    await writeFile(join(probe, 'client.js'), probeClient(2))
    await page.waitForFunction(() => window.__IDLE_SMOKE_REVISION__ === 2, undefined, { timeout: 45000 })
    report.hmr = { before: result.body.probeGraph[0].rev, after: (await state()).body.probeGraph[0].rev,
      client: await page.evaluate(() => ({ revision: window.__IDLE_SMOKE_REVISION__, entries: window.__IDLE_SMOKE__.modules.entries.state.getSnapshot() })) }
    assert.notEqual(report.hmr.before, report.hmr.after)
    pass('mutable client bundles still reload through the original authenticated HMR transport')
    report.ok = true
  } catch (error) {
    report.error = error.stack; report.output = output.replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]')
    if (page) {
      await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText().catch(() => ''))
      await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
    }
    throw error
  }
  finally {
    await browser?.close()
    if (browserChild?.pid && browserChild.exitCode === null) try { execFileSync('taskkill', ['/PID', String(browserChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
    if (child?.pid && child.exitCode === null) try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
