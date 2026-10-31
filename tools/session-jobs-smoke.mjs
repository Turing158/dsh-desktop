/**
 * End-to-end check of the session-jobs control in a disposable profile.
 *
 * The control's whole job is to answer "is anything still running in this
 * conversation, and can I stop it?" — a question no unit test can settle,
 * because the answer depends on a live job registry, the roster stream, and a
 * header whose geometry the app owns. So this fixture mounts the real desktop
 * overlay, registers two jobs on the host (one long-lived, one that has already
 * settled) and then behaves like a user: look at the header, open the popup,
 * press the stop icon, and watch the row leave.
 *
 * Jobs belong to disposable sessions and run a real local HTTP server. No
 * model calls are made; IPC only seeds the host registry for the UI checks.
 *
 * ```powershell
 * node tools/session-jobs-smoke.mjs
 * ```
 * Exits non-zero and prints the failure stack; the throwaway profile is left in
 * `src-tauri/target/session-jobs-*` with `report.json` and `popup.png`.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { offlineModelPatch, handleOnboarding, dismissInitialWelcome } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/session-jobs-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home); await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: off\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({
  name: '@dsh-desktop/session-jobs-fixture', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } },
}))
await writeFile(join(probe, 'index.js'), `import { spawn } from 'node:child_process'
export const inject = ['jobs']
export const name = 'session-jobs-fixture'
export function apply(ctx) {
  // The registry refuses to start anything until a controller is attached to
  // the registering composition; upstream's \`tool-jobs\` does this in its own
  // apply, and the desktop overlay leaves that controller in the agent preset.
  // A top-level fixture plugin therefore attaches its own, which lands in the
  // global layer and serves the disposable sessions' registrations.
  ctx.jobs.attachController('session-jobs-fixture')
  function live(owner, label, failOnce) {
    const id = ctx.jobs.start({ owner, kind: 'pwsh', label, run(job) {
      job.updateProgress('compiling')
      const server = spawn(process.execPath, ['-e',
        "require('node:http').createServer((req,res)=>res.end('ok')).listen(0,'127.0.0.1',function(){console.log('LISTEN '+this.address().port)})"],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      server.stdout.on('data', data => {
        job.append(String(data))
        const port = String(data).match(/LISTEN (\\d+)/)?.[1]
        if (port) console.log('SMOKE_SERVER_READY ' + id + ' ' + port)
      })
      const done = new Promise(resolve => {
        server.on('error', error => resolve({ status: 'failed', detail: error.message }))
        server.on('exit', () => {
          console.log('SMOKE_SERVER_EXIT ' + id)
          setTimeout(() => resolve({ status: 'killed', detail: 'cancelled by the user' }), 300)
        })
      })
      return {
        cancel() {
          if (failOnce) { failOnce = false; throw Error('Fixture cancellation failure') }
          console.log('SMOKE_KILLED ' + id)
          server.kill()
        },
        done,
      }
    } })
    console.log('SMOKE_LIVE_JOB ' + id)
    return id
  }
  function settled(owner, label) {
    const id = ctx.jobs.start({ owner, kind: 'pwsh', label, run(job) {
      job.append('done\\n')
      return { cancel() {}, done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }) }
    } })
    console.log('SMOKE_SETTLED_JOB ' + id)
    return id
  }
  process.on('message', request => {
    try {
      const id = request.settled ? settled(request.owner, request.label) : live(request.owner, request.label, request.failOnce)
      process.send({ requestId: request.requestId, id })
    } catch (error) { process.send({ requestId: request.requestId, error: error.message }) }
  })
}`)
// The browser half only observes: it hands the page the client ctx so the probe
// can create a workspace, a session, and one user message to paint the header.
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({ id: '@dsh-desktop/session-jobs-fixture',
  factory: require => ({ inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace'], apply(ctx) {
    window.__FIXTURE_CLIENT__ = ctx
  } }) })`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + offlineModelPatch
  + '\n- insert:\n    - id: session-jobs-fixture\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)

const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_UI_SMOKE_KEY: 'mock-key' },
})
let output = '', browser, page
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { root, checks: [] }
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
let requestId = 0
const startJob = options => new Promise((resolve, reject) => {
  const id = ++requestId
  const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture IPC timeout')) }, 10000)
  function receive(message) {
    if (message.requestId !== id) return
    clearTimeout(timer); child.off('message', receive)
    if (message.error) reject(Error(message.error))
    else resolve(message.id)
  }
  child.on('message', receive)
  child.send({ ...options, requestId: id })
})
const waitForOutput = async pattern => {
  for (let i = 0; i < 100; i += 1) {
    const match = output.match(pattern)
    if (match) return match
    await sleep(100)
  }
  throw Error('Missing fixture output: ' + pattern)
}

try {
  let url
  for (let i = 0; i < 400; i += 1) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error(output.slice(-3000))
    await sleep(100)
  }
  assert.ok(url, 'the web server never announced its URL')
  report.url = new URL(url).origin

  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1005, height: 760 }, locale: 'zh-CN' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && /slot entry crashed|Maximum update depth|Cannot update a component/.test(message.text())) errors.push(message.text()) })
  await handleOnboarding(page)
  await page.goto(url)
  await page.waitForFunction(() => window.__FIXTURE_CLIENT__)
  await dismissInitialWelcome(page)

  // One message is what makes the header paint its utilities at all.
  const sessionId = await page.evaluate(async path => {
    const ctx = window.__FIXTURE_CLIENT__, workspace = await ctx.workspaces.create({ path })
    const sessionId = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
    window.__SESSION_ID__ = sessionId
    ctx.uiWorkspace.openSession(sessionId)
    ctx.sessions.binding(sessionId).session.beginSubmission({ mode: 'queue', text: '后台任务面板探针', attachments: [] })
    return sessionId
  }, root)
  const trigger = page.locator('[data-dsh-session-jobs-trigger]')
  const panel = page.locator('[data-dsh-session-jobs]')
  await page.locator('[data-conversation-tabs]').waitFor({ state: 'visible' })
  assert.equal(await trigger.count(), 0, 'an idle session must not show the background-task button')
  pass('the background-task button stays hidden before any jobs start')

  const liveId = await startJob({ owner: sessionId, label: 'node dev-server.mjs', failOnce: true })
  await startJob({ owner: sessionId, label: 'npm run build', settled: true })
  const [, port] = await waitForOutput(new RegExp('SMOKE_SERVER_READY ' + liveId + ' (\\d+)'))
  const serverUrl = 'http://127.0.0.1:' + port
  assert.equal(await (await fetch(serverUrl)).text(), 'ok')
  await page.waitForSelector('[data-dsh-session-jobs-trigger]', { timeout: 30000 })

  // The button is a session-header utility, so it only exists where the header
  // does — and it must not have displaced the shipped corner control.
  await trigger.waitFor({ state: 'visible' })
  const geometry = await page.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    const button = document.querySelector('[data-dsh-session-jobs-trigger]')
    const corner = document.querySelector('[data-conversation-header-corner]')
    return {
      button: rect(button),
      corner: rect(corner),
      cornerButtons: corner.querySelectorAll('button').length,
      tabs: rect(document.querySelector('[data-conversation-tabs]')),
      header: rect(document.querySelector('[data-conversation-tabs]').closest('header')),
      seatInsideHeader: button.closest('header') !== null,
    }
  })
  report.geometry = geometry
  assert.ok(geometry.seatInsideHeader, 'the trigger must live inside the session header')
  assert.equal(geometry.cornerButtons, 1, 'the shipped 打开侧边栏 corner control must survive')
  assert.ok(Math.abs(geometry.button.right - geometry.corner.right) <= 1, `the trigger must right-align with the corner control (${geometry.button.right} vs ${geometry.corner.right})`)
  assert.ok(geometry.button.top >= geometry.tabs.top - 8 && geometry.button.bottom <= geometry.tabs.bottom + 8, 'the trigger must sit on the view-tabs row')
  assert.ok(geometry.button.bottom <= geometry.header.bottom, 'the trigger must stay inside the header')
  pass('the control sits at the right end of the tabs row, right-aligned with the corner button')

  // The settled job is history; only the live one may be listed.
  await trigger.click()
  await panel.waitFor({ state: 'visible' })
  const listed = await panel.locator('[role="listitem"]').allTextContents()
  report.listed = listed
  assert.equal(listed.length, 1, `only live work may be listed, saw ${JSON.stringify(listed)}`)
  assert.match(listed[0], /node dev-server\.mjs/)
  assert.doesNotMatch(listed[0], /compiling|命令 ·/)
  assert.equal(await panel.locator('.dshSessionJobs__meta').count(), 0)
  assert.equal(await panel.locator('.dshSessionJobs__hint, .dshSessionJobs__emptyHint').count(), 0)
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
  assert.equal(await trigger.locator('.dshSessionJobs__badge').textContent(), '1')
  pass('the popup lists live commands without a secondary status line')

  const row = panel.getByRole('listitem'), stop = row.locator('.dshSessionJobs__stop')
  const duration = row.locator('.dshSessionJobs__duration'), icon = row.locator('.dshSessionJobs__stopIcon')
  const opacity = locator => locator.evaluate(node => getComputedStyle(node).opacity)
  const durationText = await duration.innerText()
  assert.ok(durationText)
  assert.match(durationText, /^(?:[1-9]\d*小时)?(?:[1-9]\d*分钟)?(?:[1-9]\d*秒)?$|^0秒$/)
  assert.equal((await row.boundingBox()).height, 32, 'single-line task rows should stay compact')
  assert.equal(await opacity(duration), '1')
  assert.equal(await opacity(icon), '0')
  const firstDuration = await duration.innerText()
  await page.waitForFunction(previous => document.querySelector('.dshSessionJobs__duration')?.textContent !== previous, firstDuration)
  const restingBox = await stop.boundingBox()
  await panel.screenshot({ path: join(root, 'duration.png') })
  await row.hover()
  assert.equal(await opacity(duration), '0')
  assert.equal(await opacity(icon), '1')
  const hoveredBox = await stop.boundingBox()
  assert.equal(hoveredBox.width, restingBox.width, 'hover must not change the action width')
  assert.equal(hoveredBox.x, restingBox.x, 'hover must not shift the action')
  await panel.screenshot({ path: join(root, 'hover.png') })
  await page.mouse.move(500, 500)
  await stop.focus()
  assert.equal(await opacity(icon), '1', 'keyboard focus also reveals the stop icon')
  await panel.focus()
  assert.equal(await opacity(duration), '1')
  assert.equal(await opacity(icon), '0')
  pass('elapsed time ticks in the trailing control and swaps to stop on hover or focus without shifting')

  const panelBox = await panel.boundingBox(), viewport = page.viewportSize()
  assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= viewport.width, 'the panel must stay on screen horizontally')
  assert.ok(panelBox.y >= 0 && panelBox.y + panelBox.height <= viewport.height, 'the panel must stay on screen vertically')
  pass('the popup is placed inside the viewport')

  await page.screenshot({ path: join(root, 'popup.png'), clip: { x: 0, y: 0, width: 1005, height: 520 } })

  // The stop icon ends the job; the row leaves through the roster, not by
  // optimistic removal, so this also proves the stream is live.
  await panel.locator('.dshSessionJobs__stop').click()
  await panel.getByRole('alert').waitFor({ state: 'visible' })
  assert.equal(await panel.getByRole('alert').innerText(), '停止失败，请重试')
  assert.equal(await panel.locator('.dshSessionJobs__stop').isEnabled(), true)
  assert.equal(await (await fetch(serverUrl)).text(), 'ok', 'a failed stop must leave the command running')
  pass('a rejected stop keeps the task visible and allows retry')
  await panel.locator('.dshSessionJobs__stop').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-dsh-session-jobs] [role="listitem"]').length === 0, undefined, { timeout: 20000 })
  await waitForOutput(new RegExp('SMOKE_KILLED ' + liveId))
  await waitForOutput(new RegExp('SMOKE_SERVER_EXIT ' + liveId))
  await assert.rejects(fetch(serverUrl), 'the server must no longer accept connections')
  await panel.waitFor({ state: 'detached' })
  await trigger.waitFor({ state: 'detached' })
  assert.equal(await page.locator('.dshSessionJobs__seat').count(), 0, 'the idle header must not retain an empty button seat')
  pass('the last stopped command closes the popup and removes the button')

  await page.screenshot({ path: join(root, 'stopped.png'), clip: { x: 0, y: 0, width: 1005, height: 520 } })

  await startJob({ owner: sessionId, label: 'session A server' })
  await trigger.waitFor({ state: 'visible' })
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  assert.equal(await panel.count(), 0, 'new work must not resurrect an old popup')
  await trigger.click()
  await panel.getByText('session A server', { exact: true }).waitFor()
  pass('new work restores the button with the popup closed')

  // Escape closes without changing the roster, and the trigger reopens it.
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  await trigger.click()
  await panel.waitFor({ state: 'visible' })
  await page.mouse.click(500, 700)
  await panel.waitFor({ state: 'detached' })
  pass('Escape and a click outside close the popup')

  // Switch with the popup open: each header must show only its owner's work.
  await trigger.click()
  await panel.getByText('session A server', { exact: true }).waitFor()
  const secondId = await page.evaluate(async path => {
    const ctx = window.__FIXTURE_CLIENT__, workspace = await ctx.workspaces.create({ path })
    const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
    ctx.uiWorkspace.openSession(id)
    ctx.sessions.binding(id).session.beginSubmission({ mode: 'queue', text: '第二个会话', attachments: [] })
    return id
  }, root)
  await startJob({ owner: secondId, label: 'session B server' })
  await panel.waitFor({ state: 'detached' })
  await trigger.click()
  await panel.getByText('session B server', { exact: true }).waitFor()
  assert.deepEqual(await panel.locator('.dshSessionJobs__label').allTextContents(), ['session B server'])
  await panel.locator('.dshSessionJobs__stop').click()
  await panel.waitFor({ state: 'detached' })
  await trigger.waitFor({ state: 'detached' })
  await page.evaluate(id => window.__FIXTURE_CLIENT__.uiWorkspace.openSession(id), sessionId)
  await panel.waitFor({ state: 'detached' })
  await trigger.click()
  await panel.getByText('session A server', { exact: true }).waitFor()
  assert.deepEqual(await panel.locator('.dshSessionJobs__label').allTextContents(), ['session A server'])
  pass('switching sessions closes the popup and keeps owned jobs isolated')

  // The desktop overlay can be used from a narrow remote viewport as well.
  await page.setViewportSize({ width: 240, height: 360 })
  await page.waitForFunction(() => {
    const box = document.querySelector('[data-dsh-session-jobs]')?.getBoundingClientRect()
    return box && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
  }, undefined, { timeout: 3000 })
  await page.screenshot({ path: join(root, 'narrow.png') })
  pass('the popup remains inside a narrow viewport')

  // Returning from vanilla must not resurrect an earlier open popup.
  const setMode = mode => page.evaluate(value => {
    document.documentElement.setAttribute('data-dsh-ui', value)
    document.dispatchEvent(new Event('dsh-desktop:ui-mode'))
  }, mode)
  await setMode('vanilla')
  await panel.waitFor({ state: 'detached' })
  assert.equal(await trigger.count(), 0)
  await setMode('desktop')
  await trigger.waitFor()
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  await page.setViewportSize({ width: 1005, height: 760 })
  await trigger.click()
  await panel.getByText('session A server', { exact: true }).waitFor()
  await panel.locator('.dshSessionJobs__stop').click()
  await panel.waitFor({ state: 'detached' })
  await trigger.waitFor({ state: 'detached' })
  pass('vanilla mode removes the control and returning keeps the popup closed')

  assert.deepEqual(errors, [], 'the page reported React errors: ' + errors.join(' | '))
  pass('no React errors or crashed slot entries')

  console.log(JSON.stringify({ checks: report.checks.length, root }, null, 2))
} catch (error) {
  report.failure = error.stack
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  console.error(error.stack)
  process.exitCode = 1
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(join(root, 'backend.log'), output.replace(/(token=)[^\s\u001b]+/g, '$1[redacted]'))
  await browser?.close()
  if (child.exitCode === null) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  }
}
