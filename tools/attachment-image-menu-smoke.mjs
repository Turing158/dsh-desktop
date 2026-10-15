/** Real attachment menus in an isolated DSH profile; no model calls.
 * Uses a headless browser clipboard and a fake file-picker handle for byte checks. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/attachment-menu-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await Promise.all([mkdir(home), mkdir(probe)])
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: off\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/attachment-menu-smoke', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/attachment-menu-smoke',factory:()=>({inject:['sessions','workspaces','uiWorkspace','conversation'],apply(ctx){window.__IMAGE_MENU_SMOKE__=ctx}})})`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: attachment-menu-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
await writeFile(join(root, 'patch.yml'), patch)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, browser, page, output = ''
const report = { root, checks: [] }
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
try {
  child = spawn(process.execPath, [dshBin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--port', '0'], { cwd: root, windowsHide: true, env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  let url
  for (let i = 0; i < 400; i++) { url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]; if (url) break; if (child.exitCode !== null) throw Error(output); await sleep(100) }
  assert.ok(url, 'DSH starts')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 }, permissions: ['clipboard-read', 'clipboard-write'] })
  page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(() => window.__IMAGE_MENU_SMOKE__?.sessions.list.getSnapshot().phase === 'ready')
  await page.getByRole('button', { name: '继续', exact: true }).waitFor()
  for (const name of ['继续', '我知道了', '稍后配置']) {
    const button = page.getByRole('button', { name, exact: true })
    if (await button.count()) { await button.click(); await page.waitForTimeout(200) }
  }
  if (await page.locator('[data-shortcut-modal="settings"]').count()) await page.keyboard.press('Escape')
  await page.addLocatorHandler(page.getByRole('button', { name: '稍后配置', exact: true }), button => button.click())
  const originals = await page.evaluate(async path => {
    const ctx = window.__IMAGE_MENU_SMOKE__, workspace = await ctx.workspaces.create({ path })
    const session = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
    ctx.uiWorkspace.openSession(session)
    const input = ctx.conversation.input.for(ctx.sessions.scope(session))
    const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 240
    const paint = canvas.getContext('2d'); paint.fillStyle = '#4176e6'; paint.fillRect(0, 0, 360, 240); paint.clearRect(0, 0, 20, 20)
    const files = []
    for (const [type, name] of [['image/png', '透明图片.png'], ['image/jpeg', 'photo.jpg']]) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, type))
      files.push(new File([blob], name, { type }))
    }
    const assets = ctx.conversation.createDrafts(session, files)
    input.addAttachments(assets.map(asset => asset.id))
    document.documentElement.removeAttribute('data-dsh-browser')
    window.__imageSaveResults = []
    window.__pickerCalls = []
    window.showSaveFilePicker = async options => {
      window.__pickerCalls.push({ options, active: navigator.userActivation.isActive })
      if (window.__cancelImageSave) throw new DOMException('Cancelled', 'AbortError')
      return { createWritable: async () => ({
        write: async blob => window.__imageSaveResults.push({ type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) }),
        close: async () => { window.__imageSaveClosed = true },
        abort: async () => { window.__imageSaveAborted = true },
      }) }
    }
    return Promise.all(files.map(async file => ({ name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) })))
  }, root)
  const thumbnail = name => page.locator('#root button:has(> img)').filter({ has: page.locator('img[alt="' + name + '"]') })
  const menu = page.locator('[data-dsh-image-menu]')
  const open = async locator => {
    await locator.click({ button: 'right' })
    await menu.waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('[data-dsh-image-menu] button')].length === 2 && [...document.querySelectorAll('[data-dsh-image-menu] button')].every(button => !button.disabled))
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['复制图片', '保存图片'])
    assert.equal(await menu.locator('[aria-keyshortcuts], .dshTextMenu__shortcut').count(), 0)
  }
  for (const original of originals) {
    await page.locator('[data-dsh-desktop="toast"]').evaluateAll(nodes => nodes.forEach(node => node.remove()))
    await open(thumbnail(original.name))
    await menu.getByRole('menuitem', { name: '复制图片', exact: true }).click()
    await page.locator('[data-dsh-desktop="toast"]').filter({ hasText: '已复制图片' }).waitFor()
    const copied = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read(), blob = await item.getType('image/png')
      const image = await createImageBitmap(blob), canvas = document.createElement('canvas')
      canvas.width = image.width; canvas.height = image.height
      const paint = canvas.getContext('2d'); paint.drawImage(image, 0, 0); image.close()
      return { width: canvas.width, height: canvas.height, pixel: Array.from(paint.getImageData(100, 100, 1, 1).data), alpha: paint.getImageData(0, 0, 1, 1).data[3] }
    })
    assert.equal(copied.width, 360); assert.equal(copied.height, 240)
    assert.ok(Math.abs(copied.pixel[2] - 230) < 5)
    if (original.name.endsWith('.png')) assert.equal(copied.alpha, 0)
    await open(thumbnail(original.name))
    await menu.getByRole('menuitem', { name: '保存图片', exact: true }).click()
    await page.waitForFunction(count => window.__imageSaveResults.length === count, originals.indexOf(original) + 1)
    const saved = await page.evaluate(() => ({ result: window.__imageSaveResults.at(-1), picker: window.__pickerCalls.at(-1), closed: window.__imageSaveClosed }))
    assert.deepEqual(saved.result.bytes, original.bytes)
    assert.equal(saved.picker.options.suggestedName, original.name)
    assert.ok(saved.picker.active); assert.ok(saved.closed)
  }
  pass('PNG/JPEG copy original dimensions and transparency; save keeps exact original bytes and filenames')

  await page.evaluate(() => { window.__cancelImageSave = true })
  await open(thumbnail(originals[0].name))
  await menu.getByRole('menuitem', { name: '保存图片', exact: true }).click()
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => window.__imageSaveResults.length), 2)
  assert.equal(await page.locator('[data-dsh-desktop="toast"]').filter({ hasText: '图片操作失败' }).count(), 0)
  await page.evaluate(() => { window.showSaveFilePicker = undefined })
  await open(thumbnail(originals[1].name))
  const downloading = page.waitForEvent('download')
  await menu.getByRole('menuitem', { name: '保存图片', exact: true }).click()
  const download = await downloading
  assert.equal(download.suggestedFilename(), originals[1].name)
  assert.deepEqual(Array.from(await readFile(await download.path())), originals[1].bytes)
  pass('save cancellation is quiet; browser download fallback preserves the JPEG')

  await thumbnail(originals[0].name).click()
  const viewer = page.locator('[role="dialog"][aria-modal="true"]:has(> img):not([data-dsh-ghost])')
  await viewer.waitFor()
  await open(viewer.locator(':scope > img'))
  await page.screenshot({ path: join(root, 'viewer-menu.png') })
  const bounds = await menu.boundingBox()
  assert.ok(bounds.y >= 44 && bounds.y + bounds.height <= 840)
  await page.keyboard.press('ArrowDown')
  assert.equal(await menu.locator(':focus').textContent(), '复制图片')
  await page.keyboard.press('Escape')
  assert.equal(await menu.count(), 0); assert.equal(await viewer.count(), 1)
  await open(viewer.locator(':scope > img'))
  await menu.getByRole('menuitem', { name: '复制图片', exact: true }).click()
  assert.equal(await viewer.count(), 1)
  await open(viewer.locator(':scope > img'))
  await viewer.locator(':scope > button').click()
  assert.equal(await menu.count(), 0)
  pass('viewer menu is positioned below the title bar; Escape and copy leave the viewer open; unmount dismisses the menu')

  await open(thumbnail(originals[0].name))
  await page.setViewportSize({ width: 900, height: 600 })
  assert.equal(await menu.count(), 0)
  await page.locator('.dshTb__markLogo').click({ button: 'right' })
  assert.equal(await menu.count(), 0)
  await page.evaluate(() => document.documentElement.setAttribute('data-dsh-ui', 'vanilla'))
  await thumbnail(originals[0].name).click({ button: 'right' })
  assert.equal(await menu.count(), 0)
  assert.deepEqual(errors, [])
  pass('resize dismisses the menu, unrelated images are excluded, and vanilla keeps its native menu')
  report.ok = true
} catch (error) {
  report.error = error.stack
  if (page) await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(root, 'host.log'), output)
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  if (child && child.exitCode === null) child.kill()
  console.log('Report: ' + join(root, 'report.json'))
}
