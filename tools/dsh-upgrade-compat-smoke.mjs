// Real DSH contracts and bridge providers in disposable homes and browser origins.
// Optional DSH_DESKTOP_DSH_BIN / DSH_COMPAT_TARGET_BIN exercise an actual upgrade.
// Uses no model requests, user profiles, global installs or terminal commands.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { offlineModelPatch, handleOnboarding, dismissInitialWelcome } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const initialBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const targetBin = process.env.DSH_COMPAT_TARGET_BIN || initialBin
const versionOf = async bin => JSON.parse(await readFile(join(dirname(dirname(bin)), 'package.json'), 'utf8')).version
const root = await mkdtemp(resolve('src-tauri/target/upgrade-compat-'))
const home = join(root, 'home'), probe = join(root, 'probe'), cold = join(root, 'cold')
const workspaces = [join(root, 'one'), join(root, 'two')]
await Promise.all([home, probe, cold, ...workspaces].map(path => mkdir(path)))
await writeFile(join(workspaces[0], 'sample.txt'), 'reference content\n')
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/upgrade-compat-smoke', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/upgrade-compat-smoke',factory:()=>({inject:['slots','sessions','workspaces','uiWorkspace','conversation','layout','remote','remote.desktopPlugins'],apply(ctx){window.__UPGRADE_CTX__=ctx}})})`)
await writeFile(join(cold, 'package.json'), '{"name":"upgrade-cold-probe","type":"module"}')
const coldModule = pathToFileURL(join(cold, 'index.js')).href
await writeFile(join(cold, 'index.js'), 'export function apply() {}')
const patchPath = join(root, 'patch.yml'), bootPath = join(root, 'boot.json')
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, name) => 'name: ' + pathToFileURL(resolve('dsh-plugin', name)).href)
await writeFile(patchPath, patch + offlineModelPatch + `\n- insert:\n    - id: upgrade-compat-smoke\n      name: ${pathToFileURL(join(probe, 'index.js')).href}\n    - id: upgrade-cold-probe\n      name: ${coldModule}\n`)
const report = { root, initialVersion: await versionOf(initialBin), targetVersion: await versionOf(targetBin), checks: [], pageErrors: [] }
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, browser, page, output = '', generation = 0, operation = 0, runtimeVersion = report.initialVersion
async function start(bin) {
  const env = { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: bin, DSH_DESKTOP_PLUGINS_FILE: join(root, 'plugins.json'), DSH_DESKTOP_CHANGES_DIR: join(root, 'changes'), DSH_UI_SMOKE_KEY: 'offline-fixture' }
  await writeFile(bootPath, '[]')
  execFileSync(process.execPath, [resolve('dsh-plugin/plugin-control/prepare-boot.mjs'), patchPath, bootPath], { env, windowsHide: true })
  generation++; output = ''; runtimeVersion = await versionOf(bin)
  child = spawn(process.execPath, [bin, 'web', '--patch', patchPath, '--patch', bootPath, '--no-open', '--port', '0'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  for (let i = 0; i < 400; i++) {
    const url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) return url
    if (child.exitCode !== null) throw Error(output)
    await sleep(100)
  }
  throw Error('DSH startup timed out')
}
async function stop() {
  if (child?.exitCode === null) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }
    catch (error) { try { process.kill(child.pid, 0); throw error } catch (missing) { if (missing.code !== 'ESRCH') throw missing } }
  }
  await writeFile(join(root, `host-${generation}.log`), output); child = null
}
async function ready(url) {
  await page.goto(url)
  await page.waitForFunction(() => window.__UPGRADE_CTX__?.sessions.list.getSnapshot().phase === 'ready' && window.__DSH_UPSTREAM_DOCK_SMOKE__, null, { timeout: 45000 })
  await page.evaluate(() => window.__DSH_UI_STATE__.registerRestartAdapter(() => window.__DSH_CREATE_UI_ADAPTER__(window.__UPGRADE_CTX__)))
}
async function select(id) {
  await page.evaluate(id => window.__UPGRADE_CTX__.uiWorkspace.openSession(id), id)
  await page.waitForFunction(id => !!window.__UPGRADE_CTX__.sessions.scope(id) && !!window.__UPGRADE_CTX__.conversation.input.for(window.__UPGRADE_CTX__.sessions.scope(id))?.editor.getRootElement(), id)
  await sleep(100)
}
const capture = () => page.evaluate(async version => {
  try { return await window.__DSH_UI_STATE__.prepareRemoteApply(version) }
  finally { window.__DSH_UI_STATE__.finishRemoteApply() }
}, runtimeVersion)
async function restore(payload) {
  const identity = { operationId: ++operation, windowGeneration: 1, documentGeneration: generation, backendInstance: generation }
  await page.evaluate(({ payload, identity, version }) => {
    window.__RESTORE_RESULT__ = null
    window.__RESTORE_WIRE__ = { identity, snapshot: { snapshotId: 1, payload, restoreFrontendVersion: version } }
    window.__DSH_UI_STATE__.configure({ identity, phase: 'restoring', frontendVersion: version })
  }, { payload, identity, version: runtimeVersion })
  await page.waitForFunction(() => window.__RESTORE_RESULT__, null, { timeout: 45000 })
  assert.equal((await page.evaluate(() => window.__RESTORE_RESULT__)).error, null)
  await page.evaluate(({ identity, version }) => window.__DSH_UI_STATE__.configure({ identity, phase: 'active', frontendVersion: version }), { identity, version: runtimeVersion })
}
async function savedSwitch(enabled) {
  // Saved by the older runtime; the current runtime must revalidate the entry.
  await writeFile(join(home, 'profiles/web/desktop-plugin-switches.json'), JSON.stringify({ version: 1, entries: [{ patchId: 'upgrade-cold-probe', moduleName: coldModule, enabled, runtimeVersion: report.initialVersion === report.targetVersion ? '0.2.0-rc.2' : report.initialVersion }] }))
}
async function verifySwitch(enabled) {
  const status = await page.evaluate(async () => {
    const result = await window.__UPGRADE_CTX__.remote.desktopPlugins.status()
    if (!result.ok) throw Error(result.error.message)
    return result.value
  })
  const row = status.plugins.find(row => row.patchId === 'upgrade-cold-probe')
  assert.equal(row.running, enabled); assert.equal(row.enabled, enabled); assert.equal(row.restart, false)
}
try {
  const url = await start(initialBin)
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } }); page.setDefaultTimeout(20000)
  const setup = `window.__DSH_UI_BOOT__={smoke:true,windowGeneration:1,restoring:false};window.__TAURI__={app:{getVersion:async()=> '0.1.2'},core:{Channel:class{onmessage(){}},invoke:async(command,args)=>{if(command==='request_ui_restore')return window.__RESTORE_WIRE__;if(command==='finish_ui_restore'){window.__RESTORE_RESULT__=args;return null}if(command==='terminal_list')return [];return command==='window_is_maximized'?false:null}}};\n`
  await page.addInitScript({ content: setup + await readFile('dsh-plugin/ui-state/bridge.js', 'utf8') + '\n' + await readFile('dsh-plugin/ui-state/adapter.js', 'utf8') })
  page.on('pageerror', error => report.pageErrors.push(error.message))
  await handleOnboarding(page); await ready(url); await dismissInitialWelcome(page)
  const ids = await page.evaluate(async paths => {
    const ctx = window.__UPGRADE_CTX__, ids = []
    for (const [index, path] of paths.entries()) {
      const workspace = await ctx.workspaces.create({ path })
      for (let i = 0; i < (index ? 1 : 4); i++) ids.push(await ctx.sessions.create({ workspaceId: workspace.workspaceId }))
    }
    return ids
  }, workspaces)
  await select(ids[0])
  const semantic = await page.evaluate(id => {
    const ctx = window.__UPGRADE_CTX__, input = ctx.conversation.input.for(ctx.sessions.scope(id))
    input.setDraft('before ')
    if (!('draftSnapshot' in input)) return false
    if (!input.insertReference({ source: 'file', ref: 'sample.txt', label: 'sample.txt', appearance: 'file', clipboardText: '@sample.txt' }, { start: 7, end: 7, draftRev: input.state.getSnapshot().draftRev })) throw Error('reference insertion failed')
    return true
  }, ids[0])
  await page.locator('[contenteditable=true]').first().click(); await page.keyboard.press('End'); await page.keyboard.type(' after')
  await page.evaluate(id => {
    const ctx = window.__UPGRADE_CTX__, input = ctx.conversation.input.for(ctx.sessions.scope(id))
    input.addAttachments(ctx.conversation.createDrafts(id, [new File(['reference attachment'], 'keep.txt', { type: 'text/plain' }), new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' })]).map(a => a.id))
  }, ids[0])
  await page.waitForFunction(id => {
    const c = window.__UPGRADE_CTX__, input = c.conversation.input.for(c.sessions.scope(id))
    return c.conversation.resolveDraftAttachments(input.state.getSnapshot().attachmentIds).every(a => a.kind === 'image' || c.conversation.fileUploads.getSnapshot()[a.id]?.status === 'ready')
  }, ids[0])
  const active = await capture(); await restore(active); await restore(active)
  assert.equal(active.drafts.find(d => d.sessionId === ids[0]).selection.focused, true)
  pass(semantic ? 'focused reference draft, caret and attachments restore twice' : 'legacy text draft, caret and attachments restore twice')
  await select(ids[1])
  if (semantic) {
    await page.locator('[contenteditable=true]').first().fill('/goal'); await page.keyboard.press('Space')
    await page.waitForFunction(id => window.__UPGRADE_CTX__.conversation.input.for(window.__UPGRADE_CTX__.sessions.scope(id)).state.getSnapshot().phase === 'claimed', ids[1])
    await page.keyboard.press('End')
    const command = await capture(); await restore(command)
    assert.equal(command.drafts.find(d => d.sessionId === ids[1]).semantic.command.token, '/goal ')
    pass('focused command chip and caret restore without submission')
  }
  await select(ids[0])
  await page.evaluate(() => { const { dock } = window.__DSH_UPSTREAM_DOCK_SMOKE__; dock.open(); dock.add(); dock.activate(dock.getSnapshot().tabs[0].contentId); dock.resize(300); dock.collapse(true) })
  await select(ids[4])
  await page.evaluate(() => { const { dock } = window.__DSH_UPSTREAM_DOCK_SMOKE__; dock.open(); dock.collapse(true) })
  await select(ids[2]); await page.evaluate(() => document.activeElement?.blur())
  const payload = await capture()
  assert.ok(payload.dialogs.some(dialog => dialog.id === 'desktop-terminal' && dialog.data.backend === 'dsh'))
  if (semantic) {
    assert.equal(payload.drafts.find(d => d.sessionId === ids[0]).semantic.references.length, 1)
    assert.ok(payload.drafts.find(d => d.sessionId === ids[1]).semantic.command)
  }
  await writeFile(join(root, 'snapshot.json'), JSON.stringify(payload, null, 2))
  await savedSwitch(false); const oldOrigin = new URL(page.url()).origin
  await stop(); await ready(await start(targetBin)); assert.notEqual(new URL(page.url()).origin, oldOrigin)
  await restore(payload); await restore(payload); await verifySwitch(false)
  const restored = await capture()
  assert.deepEqual(restored.dialogs.find(d => d.id === 'desktop-terminal'), payload.dialogs.find(d => d.id === 'desktop-terminal'))
  assert.deepEqual(restored.assets.map(a => [a.name, a.mediaType, a.data]), payload.assets.map(a => [a.name, a.mediaType, a.data]))
  for (const draft of payload.drafts) {
    const after = restored.drafts.find(d => d.sessionId === draft.sessionId)
    assert.equal(after?.text || '', draft.text); assert.deepEqual(after?.semantic, draft.semantic)
  }
  pass('new-origin restart preserves dormant drafts, files, project terminal tabs and saved disabled switch')
  await select(ids[3])
  await page.evaluate(id => window.__UPGRADE_CTX__.uiWorkspace.archiveSession(id), ids[3])
  await page.waitForFunction(() => !Object.values(window.__UPGRADE_CTX__.sessions.list.getSnapshot().byId).some(row => row.retainedBy?.mainView))
  await page.evaluate(() => document.activeElement?.blur())
  const empty = await capture(); assert.equal(empty.page.sessionId, null)
  await savedSwitch(true); await stop(); await ready(await start(targetBin)); await restore(empty); await verifySwitch(true)
  assert.equal((await capture()).page.sessionId, null)
  pass('archived-current empty page and saved enabled switch survive another restart')
} catch (error) {
  report.error = error.stack
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  process.exitCode = 1; console.error(error)
} finally {
  await browser?.close(); await stop()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Evidence: ' + root)
}
