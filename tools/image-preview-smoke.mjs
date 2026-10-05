/** Exercise image gestures against the installed DSH in a disposable profile. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/image-preview-smoke-'))
const home = join(root, 'home'), workspace = join(root, 'workspace'), probe = join(root, 'probe')
await Promise.all([home, workspace, probe].map(path => mkdir(path)))
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><defs><pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="#e4ecf5" stroke="#6a839f"/></pattern></defs><rect width="1600" height="1200" fill="url(#grid)"/><circle cx="800" cy="600" r="240" fill="#4176e6"/><path d="M0 0L1600 1200M1600 0L0 1200" stroke="#15223a" stroke-width="6"/></svg>'
await writeFile(join(workspace, 'large.svg'), svg)
await writeFile(join(workspace, 'second.svg'), svg.replaceAll('#4176e6', '#26804a'))
await writeFile(join(workspace, 'notes.md'), '# Document\n\n' + 'Ordinary text scrolling must remain available.\n\n'.repeat(120))
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/image-preview-smoke', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar-right'] } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}\n')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/image-preview-smoke',factory:()=>({inject:['sessions','workspaces','uiWorkspace','sidebarRight','slots'],apply(ctx){window.__IMAGE_SMOKE__=ctx}})})`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: image-preview-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
await writeFile(join(root, 'patch.yml'), patch)

let child, browser, output = ''
const report = { root, checks: [] }, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
try {
  child = spawn(process.execPath, [dshBin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--port', '0'], { cwd: workspace, windowsHide: true, env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_CHANGES_DIR: join(root, 'changes') }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  let url
  for (let i = 0; i < 400; i++) { url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]; if (url) break; if (child.exitCode !== null) throw Error(output); await sleep(100) }
  assert.ok(url, 'isolated DSH starts')
  browser = await chromium.launch({ headless: true, channel: 'msedge', ignoreDefaultArgs: ['--hide-scrollbars'] })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.__IMAGE_SMOKE__), undefined, { timeout: 40000 })
  const sessionId = await page.evaluate(async workspace => {
    const ctx = window.__IMAGE_SMOKE__, work = await ctx.workspaces.create({ path: workspace })
    const id = await ctx.sessions.create({ workspaceId: work.workspaceId }); await ctx.uiWorkspace.openSession(id); return id
  }, workspace)
  for (let i = 0; i < 4; i++) { await page.evaluate(() => { for (const button of document.querySelectorAll('button')) if (['继续', '稍后配置'].includes(button.textContent.trim())) button.click() }); await sleep(150) }
  const open = name => page.evaluate(({ sessionId, name }) => window.__IMAGE_SMOKE__.sidebarRight.openResource('dsh-resource://file/session/' + sessionId + '/' + encodeURIComponent(name)), { sessionId, name })
  await open('large.svg')
  const port = page.locator('[data-document-zoom-scrollport]:has([data-image-preview]):visible')
  const frame = page.locator('[data-document-zoom-frame]:has([data-image-preview]):visible')
  const image = port.locator('img')
  await image.waitFor()
  await page.evaluate(sessionId => {
    const ctx = window.__IMAGE_SMOKE__
    document.documentElement.removeAttribute('data-dsh-browser')
    const handle = ctx.slots.entriesOfSlot('rightbar.session')[0].store
    ctx.slots.resolveStore(handle, { key: sessionId, ctx: ctx.sessions.scope(sessionId) }).actions.setMode(sessionId, 'push')
    ctx.slots.entriesOfSlot('root')[0].store.create().actions.setRightbar(640)
  }, sessionId)
  const zoom = () => frame.evaluate(node => Number(node.style.getPropertyValue('--document-zoom')))
  const offset = () => port.evaluate(node => ({ x: node.scrollLeft, y: node.scrollTop }))
  const center = async () => { const r = await port.boundingBox(); return { x: r.x + r.width * .45, y: r.y + r.height * .4 } }
  const point = await center()
  const wheel = async (delta, ctrl = false) => {
    await page.mouse.move(point.x, point.y)
    if (ctrl) await page.keyboard.down('Control')
    await page.mouse.wheel(0, delta)
    if (ctrl) await page.keyboard.up('Control')
    await page.waitForTimeout(180)
  }
  await page.waitForTimeout(200)
  assert.equal(await port.evaluate(node => getComputedStyle(node).cursor), 'grab')
  const initial = await zoom()
  await wheel(-100)
  const enlarged = await zoom()
  assert.ok(enlarged > initial)
  assert.equal(await frame.getAttribute('data-document-zoom-mode'), 'fixed')
  assert.equal(await frame.getByRole('button', { name: '选择缩放比例', exact: true }).innerText(), Math.round(enlarged * 100) + '%')
  await wheel(100)
  assert.ok(Math.abs(await zoom() - initial) < .0001)
  await wheel(-100, true)
  assert.ok(Math.abs(await zoom() - enlarged) < .0001, 'Ctrl+wheel is handled once')
  pass('ordinary wheel zooms in/out and shares the native toolbar; Ctrl+wheel is not doubled')

  const chooseZoom = async label => {
    const r = await port.boundingBox()
    await page.mouse.move(r.x + r.width / 2, r.y + r.height - 25)
    await frame.getByRole('button', { name: '选择缩放比例', exact: true }).click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  }
  await chooseZoom('150%')
  await port.evaluate(node => { node.scrollLeft = 450; node.scrollTop = 350 })
  const anchor = async () => image.evaluate((node, point) => { const r = node.getBoundingClientRect(); return { x: (point.x - r.x) / r.width, y: (point.y - r.y) / r.height } }, point)
  const beforeAnchor = await anchor()
  await wheel(-20)
  const afterAnchor = await anchor()
  assert.ok(Math.abs(beforeAnchor.x - afterAnchor.x) < .002 && Math.abs(beforeAnchor.y - afterAnchor.y) < .002, 'image point remains under cursor')
  pass('zoom remains anchored at the mouse position')

  const beforeDrag = await offset()
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  assert.equal(await port.evaluate(node => getComputedStyle(node).cursor), 'grabbing')
  await page.mouse.move(point.x + 90, point.y + 70, { steps: 5 })
  await page.mouse.up()
  const afterDrag = await offset()
  assert.ok(Math.abs(afterDrag.x - (beforeDrag.x - 90)) < 2 && Math.abs(afterDrag.y - (beforeDrag.y - 70)) < 2)
  assert.equal(await port.getAttribute('data-dsh-image-dragging'), null)
  await page.mouse.move(point.x + 120, point.y + 100)
  assert.deepEqual(await offset(), afterDrag)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(point.x + 160, point.y + 130)
  await page.mouse.up({ button: 'right' })
  assert.deepEqual(await offset(), afterDrag)
  await page.keyboard.press('Escape')
  pass('left drag pans both axes; release and right mouse button do not pan')

  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(200, point.y, { steps: 5 })
  await page.mouse.up()
  assert.equal(await port.getAttribute('data-dsh-image-dragging'), null)
  const released = await offset()
  await page.mouse.move(point.x, point.y)
  assert.deepEqual(await offset(), released)
  await page.mouse.down()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  assert.equal(await port.getAttribute('data-dsh-image-dragging'), null)
  await page.mouse.up()
  pass('pointer capture handles release outside the viewer and window blur cancels dragging')

  // Native scrollbar dragging must not be intercepted by image panning.
  // Give headless Edge a classic scrollbar instead of its zero-width overlay.
  const classicScrollbars = await page.addStyleTag({ content: '[data-document-zoom-scrollport] { scrollbar-width: auto !important; } [data-document-zoom-scrollport]::-webkit-scrollbar { display: block !important; width: 12px !important; height: 12px !important; }' })
  await port.evaluate(node => { node.scrollLeft = 0; node.scrollTop = 0 })
  const scrollbar = await port.evaluate(node => { const r = node.getBoundingClientRect(), style = getComputedStyle(node), bar = getComputedStyle(node, '::-webkit-scrollbar'); return { x: r.right - 5, y: r.top + 35, width: node.offsetWidth - node.clientWidth, client: [node.clientWidth, node.clientHeight], scroll: [node.scrollWidth, node.scrollHeight], overflow: style.overflow, bar: [bar.display, bar.width, bar.height] } })
  assert.ok(scrollbar.width > 0, JSON.stringify(scrollbar))
  await page.mouse.move(scrollbar.x, scrollbar.y)
  await page.mouse.down()
  assert.equal(await port.getAttribute('data-dsh-image-dragging'), null)
  await page.mouse.move(scrollbar.x, scrollbar.y + 100, { steps: 5 })
  await page.mouse.up()
  assert.ok((await offset()).y > 0)
  await classicScrollbars.evaluate(node => node.remove())
  pass('native scrollbar thumbs retain their own drag behavior')

  for (let i = 0; i < 10; i++) await wheel(-100)
  assert.equal(await zoom(), 4)
  for (let i = 0; i < 15; i++) await wheel(100)
  assert.equal(await zoom(), .25)
  await chooseZoom('适应宽度')
  assert.equal(await frame.getAttribute('data-document-zoom-mode'), 'fit-width')
  await wheel(-100)
  const retainedZoom = await zoom()
  await open('second.svg')
  await image.waitFor()
  await page.waitForTimeout(200)
  assert.equal(await frame.getAttribute('data-document-zoom-mode'), 'fit-width')
  await open('large.svg')
  await image.waitFor()
  await page.waitForTimeout(200)
  assert.ok(Math.abs(await zoom() - retainedZoom) < .0001)
  pass('native 25–400% limits, fit-width reset and per-tab zoom retention remain intact')

  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.evaluate(() => document.documentElement.setAttribute('data-dsh-ui', 'vanilla'))
  await page.waitForTimeout(50)
  assert.equal(await port.getAttribute('data-dsh-image-dragging'), null)
  await page.mouse.up()
  const vanillaZoom = await zoom()
  await wheel(-100)
  assert.equal(await zoom(), vanillaZoom)
  await page.evaluate(() => document.documentElement.setAttribute('data-dsh-ui', 'desktop'))
  await wheel(-100)
  assert.ok(await zoom() > vanillaZoom)
  pass('vanilla mode cancels dragging and restores ordinary wheel behavior')

  await page.screenshot({ path: join(root, 'image-zoom.png') })
  await open('notes.md')
  const markdown = page.locator('[data-document-markdown]:visible')
  await markdown.waitFor()
  const before = await markdown.evaluate(node => {
    for (let parent = node; parent; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
        parent.setAttribute('data-image-smoke-text-scroll', '')
        break
      }
    }
    return { width: node.getBoundingClientRect().width, font: getComputedStyle(node).fontSize }
  })
  const textPort = page.locator('[data-image-smoke-text-scroll]')
  await textPort.hover()
  await page.mouse.wheel(0, 240)
  await page.waitForTimeout(200)
  assert.deepEqual(await markdown.evaluate(node => ({ width: node.getBoundingClientRect().width, font: getComputedStyle(node).fontSize })), before)
  assert.ok(await textPort.evaluate(node => node.scrollTop) > 0)
  pass('non-image document previews keep normal scrolling')
  assert.deepEqual(errors, [])
  report.ok = true
} catch (error) { report.error = error.stack; throw error }
finally {
  await writeFile(join(root, 'host.log'), output)
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  if (child && child.exitCode === null) { child.kill(); await sleep(500) }
  console.log(JSON.stringify(report, null, 2))
}
