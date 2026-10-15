/** Real DSH navigation regression, with an isolated profile and no model calls.
 * DSH_DESKTOP_DSH_BIN can select another installed runtime.
 * --without-retention confirms the regression against the same runtime.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = resolve(process.env.DSH_DESKTOP_DSH_BIN || 'pack/portable/runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/draft-attachments-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home)
await mkdir(probe)
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/draft-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({ id: '@dsh-desktop/draft-smoke',
  factory: () => ({ inject: ['sessions', 'workspaces', 'uiWorkspace', 'conversation'],
    apply(ctx) { window.__DRAFT_SMOKE__ = ctx } }) })`)
let patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
if (process.argv.includes('--without-retention')) patch = patch.replace(/    - id: desktop-ui-state\r?\n      name: [^\r\n]+\r?\n      config: \{\}\r?\n/, '')
patch += '\n- insert:\n    - id: desktop-draft-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin },
})
let output = '', browser, page
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { checks: [] }, errors = []
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }

try {
  let url
  for (let i = 0; i < 300; i++) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error(output.slice(-2000))
    await sleep(100)
  }
  assert.ok(url, 'DSH started')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(() => window.__DRAFT_SMOKE__?.sessions.list.getSnapshot().phase === 'ready')
  await page.getByRole('button', { name: '继续', exact: true }).waitFor()
  for (const name of ['继续', '我知道了', '稍后配置']) {
    const button = page.getByRole('button', { name, exact: true })
    if (await button.count()) { await button.click(); await page.waitForTimeout(350) }
  }
  if (await page.locator('[data-shortcut-modal="settings"]').count()) await page.keyboard.press('Escape')
  await page.addLocatorHandler(page.getByRole('button', { name: '稍后配置', exact: true }), button => button.click())
  const ids = await page.evaluate(async path => {
    const ctx = window.__DRAFT_SMOKE__, workspace = await ctx.workspaces.create({ path }), ids = []
    for (let i = 0; i < 2; i++) ids.push(await ctx.sessions.create({ workspaceId: workspace.workspaceId }))
    ctx.uiWorkspace.openSession(ids[0])
    return ids
  }, root)
  await page.locator('[contenteditable="true"]').first().waitFor()
  const expected = await page.evaluate(async ids => {
    const ctx = window.__DRAFT_SMOKE__
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zg9sAAAAASUVORK5CYII='
    const files = [new File(['未发送附件内容'], 'keep.txt', { type: 'text/plain' }),
      new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'pixel.png', { type: 'image/png' })]
    const input = ctx.conversation.input.for(ctx.sessions.scope(ids[0]))
    input.setDraft('会话 A 的草稿')
    const assets = ctx.conversation.createDrafts(ids[0], files)
    input.addAttachments(assets.map(a => a.id))
    const uploading = ctx.conversation.fileUploads.getSnapshot()[assets[0].id]?.status
    // Switch synchronously, before either the file upload or image decode settles.
    ctx.uiWorkspace.openSession(ids[1])
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const second = ctx.conversation.input.for(ctx.sessions.scope(ids[1]))
    second.setDraft('会话 B 的草稿')
    const [other] = ctx.conversation.createDrafts(ids[1], [new File(['第二个附件'], 'other.txt', { type: 'text/plain' })])
    second.addAttachments([other.id])
    ctx.uiWorkspace.openSession(ids[0])
    return { ids: assets.map(a => a.id), previewUrl: assets[1].previewUrl, otherId: other.id, uploading }
  }, ids)
  assert.equal(expected.uploading, 'uploading')
  const inspect = () => page.evaluate(async ids => {
    const ctx = window.__DRAFT_SMOKE__, result = []
    for (const id of ids) {
      const scope = ctx.sessions.scope(id)
      if (!scope) { result.push(null); continue }
      const state = ctx.conversation.input.for(scope).state.getSnapshot()
      const assets = ctx.conversation.resolveDraftAttachments(state.attachmentIds)
      result.push({ draft: state.draft, ids: state.attachmentIds, files: await Promise.all(assets.map(async asset => ({
        name: asset.file.name, text: asset.kind === 'file' ? await asset.file.text() : null,
        previewUrl: asset.previewUrl || null, previewReadable: asset.kind === 'image' ? (await fetch(asset.previewUrl)).ok : null,
      }))) })
    }
    return result
  }, ids)
  let state = await inspect()
  assert.deepEqual(state[0].ids, expected.ids, 'session A retains both attachment IDs after navigation')
  assert.equal(state[0].files.length, 2, 'session A attachment bytes remain registered')
  assert.deepEqual(state[1].ids, [expected.otherId])
  await page.waitForFunction(expected => {
    const conversation = window.__DRAFT_SMOKE__.conversation
    const ids = [...expected.ids, expected.otherId]
    if (conversation.resolveDraftAttachments(ids).length !== ids.length) throw Error('Draft attachment disappeared after session navigation')
    return [expected.ids[0], expected.otherId].every(id => conversation.fileUploads.getSnapshot()[id]?.status === 'ready')
  }, expected)
  await page.evaluate(async ids => {
    const ctx = window.__DRAFT_SMOKE__
    for (let i = 0; i < 4; i++) {
      ctx.uiWorkspace.openSession(ids[1])
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      ctx.uiWorkspace.openSession(ids[0])
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
  }, ids)
  state = await inspect()
  assert.equal(state[0].draft, '会话 A 的草稿')
  assert.equal(state[1].draft, '会话 B 的草稿')
  assert.equal(state[0].files[0].text, '未发送附件内容')
  assert.equal(state[1].files[0].text, '第二个附件')
  assert.equal(state[0].files[1].previewUrl, expected.previewUrl)
  assert.equal(state[0].files[1].previewReadable, true)
  await page.getByText('keep.txt', { exact: true }).first().waitFor()
  await page.screenshot({ path: join(root, 'retained.png') })
  pass('uploads, file bytes, image previews and isolated drafts survive repeated A/B navigation')
  await page.evaluate(id => window.__DRAFT_SMOKE__.uiWorkspace.openSession(id), ids[1])
  await page.evaluate(({ id, assets }) => {
    const ctx = window.__DRAFT_SMOKE__, input = ctx.conversation.input.for(ctx.sessions.scope(id))
    for (const assetId of assets) {
      if (input.removeAttachment(assetId)) ctx.conversation.releaseDraftAttachment(assetId)
    }
  }, { id: ids[0], assets: expected.ids })
  await page.waitForFunction(id => !window.__DRAFT_SMOKE__.sessions.scope(id), ids[0])
  await page.evaluate(id => window.__DRAFT_SMOKE__.uiWorkspace.openSession(id), ids[0])
  assert.deepEqual((await inspect())[0].ids, [])
  pass('removing the last attachment releases the inactive scope without resurrecting attachments')
  assert.deepEqual(errors, [])
  assert.equal(await page.locator('[data-slot-error]').count(), 0)
} catch (error) {
  report.error = error.stack
  if (page) await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  console.log('Report: ' + root)
}
