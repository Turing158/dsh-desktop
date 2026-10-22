/** Real desktop update lifecycle with an isolated npm stand-in. No registry
 * requests, user-profile writes or global package changes. Build debug with
 * TAURI_CONFIG={"identifier":"com.deepseek.harness.desktop.update-smoke"}
 * so an already running production app cannot consume the test launch.
 * Run: node tools/dsh-update-smoke.mjs
 */
throw Error('Legacy global update lifecycle is retired. Use npm run test:runtime-candidate; real-data switching remains gated by the migration contract.')
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, unlink } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = await mkdtemp(resolve('src-tauri/target/dsh-update-'))
const home = join(root, 'home'), nodeDir = join(root, 'node'), prefix = join(root, 'npm')
const npmCli = join(nodeDir, 'node_modules/npm/bin/npm-cli.js')
const bin = join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const realBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const realPackage = dirname(dirname(realBin)), packageDir = dirname(dirname(bin))
const initialVersion = '0.2.0-rc.2', targetVersion = '0.2.1-rc.1'
const theme = process.env.DSH_UPDATE_SMOKE_THEME === 'light' ? 'light' : 'dark'
for (const dir of [home, dirname(npmCli), dirname(bin), join(root, 'workspace')]) await mkdir(dir, { recursive: true })
await copyFile(process.execPath, join(nodeDir, 'node.exe'))
await copyFile(join(realPackage, 'package.json'), join(packageDir, 'package.json'))
await symlink(join(realPackage, 'node_modules'), join(packageDir, 'node_modules'), 'junction')
await writeFile(join(root, 'version.txt'), initialVersion)
await writeFile(join(home, 'settings.yaml'), `ui-theme:\n  preference: ${theme}\ndesktop-appearance:\n  animation: off\n  ui: desktop\n`)
await writeFile(join(root, 'model.patch.yml'), `- id: llm-pi-ai
  config:
    providers:
      update-smoke:
        api: openai-completions
        baseURL: http://127.0.0.1:9/v1
        apiKeyEnv: DSH_UPDATE_SMOKE_KEY
        models:
          - id: test-model
            name: Update test model
`)
await writeFile(bin, `import { readFileSync, writeFileSync } from 'node:fs';
const root = ${JSON.stringify(root)};
if (process.argv.includes('--version')) console.log(readFileSync(root + '/version.txt', 'utf8'));
else { writeFileSync(root + '/backend.pid', String(process.pid)); process.argv.splice(3, 0, '--patch', root + '/model.patch.yml'); const cli = await import(${JSON.stringify(pathToFileURL(realBin).href)}); await cli.runCli(); }
`)
await writeFile(join(prefix, 'dsh.cmd'), `@"${join(nodeDir, 'node.exe')}" "${bin}" %*\r\n`)
await writeFile(npmCli, `const fs = require('node:fs');
const root = ${JSON.stringify(root)}, target = ${JSON.stringify(targetVersion)};
const args = process.argv.slice(2);
if (args[0] === 'root') console.log(${JSON.stringify(join(prefix, 'node_modules'))});
else if (args[0] === 'view') console.log(JSON.stringify(args[2] === 'versions' ? [target] : { latest: target }));
else if (args[0] === 'install') {
  let alive = true;
  try { process.kill(Number(fs.readFileSync(root + '/backend.pid', 'utf8')), 0); } catch { alive = false; }
  fs.writeFileSync(root + '/install-evidence.json', JSON.stringify({ oldBackendStopped: !alive, args }));
  if (alive) { console.error('The old backend was still running during installation'); process.exit(3); }
  console.log('Isolated update in progress');
  setTimeout(() => {
    if (fs.existsSync(root + '/fail-install')) { console.error('simulated npm failure'); process.exitCode = 1; }
    else { fs.writeFileSync(root + '/version.txt', target); console.log('Isolated update complete'); }
  }, 1800);
} else process.exit(2);
`)
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
// Native startup registers a Start Menu shortcut and URL handler even with an
// isolated identifier. Preserve their exact pre-test state as well as DSH_HOME.
const shortcut = join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/dsh desktop.lnk')
const previousShortcut = await readFile(shortcut).catch(error => { if (error.code === 'ENOENT') return null; throw error })
const scheme = 'HKCU\\Software\\Classes\\deepseekharness', schemeBackup = join(root, 'scheme-before.reg')
const hadScheme = spawnSync('reg.exe', ['export', scheme, schemeBackup, '/y'], { windowsHide: true, stdio: 'ignore' }).status === 0
const child = spawn(resolve(process.env.DSH_UPDATE_SMOKE_EXE || 'src-tauri/target/debug/deepseek-harness-desktop.exe'), [], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PATH: prefix + ';' + process.env.PATH,
    DSH_HOME: home, DSH_DESKTOP_SMOKE_DIR: root, DSH_DESKTOP_DEBUG: join(root, 'host.log'),
    DSH_UPDATE_SMOKE_KEY: 'test-placeholder',
    DSH_DESKTOP_NODE: join(nodeDir, 'node.exe'), DSH_DESKTOP_DSH: bin,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
})
let browser, page, output = '', unblockScripts = () => {}
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const report = { root, checks: [] }, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }
async function until(fn, timeout = 60000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { try { const value = await fn(); if (value) return value } catch {} await sleep(100) }
  throw Error('Timed out waiting for isolated desktop state')
}
async function state() { return JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) }
async function ready() {
  await until(() => page.evaluate(() => Boolean(window.__DSH_REMOTE_IDENTITY__ && window.__DSH_SMOKE_CONTEXT__?.sessions.list.getSnapshot().phase === 'ready')))
  // Dismiss the upstream first-run dialogs in this empty test profile.
  for (let i = 0; i < 15; i++) {
    await page.evaluate(() => {
      for (const name of ['继续', '稍后配置']) [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent === name)?.click()
    })
    await sleep(100)
  }
  await until(async () => (await state()).phase === 'active')
}
async function requestUpdate(target) {
  await page.evaluate(async target => {
    document.activeElement?.blur() // Match focus leaving the composer for the update button.
    const identity = window.__DSH_REMOTE_IDENTITY__
    const status = await window.__TAURI__.core.invoke('remote_status', { identity })
    const payload = await window.__DSH_UI_STATE__.prepareRemoteApply(status.frontendVersion)
    // Navigation destroys this realm. Observe completion through native state.
    const palette = window.__DSH_DESKTOP_BOOT__.capturePalette()
    window.__TAURI__.core.invoke('install_dsh_update', { identity, payload, palette, channel: 'preview', targetVersion: target })
      .catch(error => { window.__updateError = String(error); window.__DSH_UI_STATE__.finishRemoteApply() })
  }, target)
}
try {
  await Promise.race([until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`)
    return response.ok
  }), new Promise((_, reject) => child.once('exit', code => reject(Error(`Test host exited (${code}); build with an isolated TAURI_CONFIG identifier first`))))])
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  page = browser.contexts()[0].pages()[0]
  await ready()
  const sessionId = await page.evaluate(async path => {
    const ctx = window.__DSH_SMOKE_CONTEXT__
    const workspace = await ctx.workspaces.create({ path })
    const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
    ctx.uiWorkspace.openSession(id)
    return id
  }, join(root, 'workspace'))
  await until(() => page.evaluate(id => Boolean(window.__DSH_SMOKE_CONTEXT__.conversation.input.for(window.__DSH_SMOKE_CONTEXT__.sessions.scope(id))), sessionId))
  await page.evaluate(id => {
    const ctx = window.__DSH_SMOKE_CONTEXT__, input = ctx.conversation.input.for(ctx.sessions.scope(id))
    input.setDraft('更新后仍要保留的未发送草稿')
    const files = [new File(['更新前的附件内容'], 'keep.txt', { type: 'text/plain' })]
    input.addAttachments(ctx.conversation.createDrafts(id, files).map(a => a.id))
  }, sessionId)
  const inspectDraft = () => page.evaluate(async id => {
    const ctx = window.__DSH_SMOKE_CONTEXT__, input = ctx.conversation.input.for(ctx.sessions.scope(id))
    const draft = input.state.getSnapshot(), files = ctx.conversation.resolveDraftAttachments(draft.attachmentIds)
    return { text: draft.draft, files: await Promise.all(files.map(a => a.file.text())), ready: files.every(a => ctx.conversation.fileUploads.getSnapshot()[a.id]?.status === 'ready') }
  }, sessionId)
  await until(async () => (await inspectDraft()).ready)
  const savedDraft = await inspectDraft()
  await page.evaluate(() => {
    const prepare = window.__DSH_UI_STATE__.prepareRemoteApply
    window.__DSH_UI_STATE__.prepareRemoteApply = async (...args) => {
      const payload = await prepare(...args)
      window.__updatePayload = payload
      return payload
    }
  })
  const source = await page.evaluate(() => ({ origin: location.origin, instance: window.__DSH_REMOTE_IDENTITY__.backendInstance }))
  const palette = await page.evaluate(() => window.__DSH_DESKTOP_BOOT__.capturePalette())
  assert.equal(palette.dark, theme === 'dark')
  const scriptsReady = new Promise(resolve => { unblockScripts = resolve })
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (request.resourceType() === 'script' && url.hostname !== 'tauri.localhost' && url.origin !== source.origin) await scriptsReady
    await route.continue().catch(() => {})
  })
  const bootColors = () => page.evaluate(() => {
    const style = getComputedStyle(document.getElementById('dsh-desktop-titlebar-boot'))
    return { background: style.backgroundColor, foreground: style.color, border: style.borderBottomColor }
  })
  const expectedColors = { background: palette.background, foreground: palette.foreground, border: palette.border }
  // Exercise the actual update menu so its busy state cannot block capture.
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name: '检测更新...', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '检测更新', exact: true })
  await dialog.getByRole('tab', { name: /dsh 更新/ }).click()
  await until(() => dialog.getByRole('button', { name: '最新稳定版', exact: true }).isEnabled())
  await dialog.getByRole('button', { name: '最新稳定版', exact: true }).click()
  const accepted = await until(() => page.evaluate(() => document.querySelector('.dshTb__updateError')
    ? { error: document.querySelector('.dshTb__updateError').textContent, payload: window.__updatePayload }
    : location.hostname === 'tauri.localhost' && document.querySelector('#app')?.getAttribute('data-state') === 'installing'))
  assert.equal(accepted, true, JSON.stringify(accepted))
  await until(async () => JSON.stringify(await bootColors()) === JSON.stringify(expectedColors))
  assert.ok(await page.getByRole('heading', { name: '正在更新 dsh…', exact: true }).isVisible())
  assert.equal(await page.locator('details').evaluate(node => node.open), true)
  await page.screenshot({ path: join(root, 'installing.png') })
  pass(`${theme} update shows expanded progress and preserves the exact previous title-bar colors`)
  await until(() => page.evaluate(() => {
    const loading = document.getElementById('dsh-desktop-titlebar-boot-loading')
    return loading?.checkVisibility() && loading.querySelector('.dshBoot__loadingLabel')?.textContent === '正在更新 dsh…'
  }))
  assert.deepEqual(await bootColors(), expectedColors)
  assert.ok(await page.evaluate(() => document.querySelector('[aria-label="最小化"]')?.checkVisibility()))
  assert.ok(await page.evaluate(() => {
    const loading = document.getElementById('dsh-desktop-titlebar-boot-loading')
    const box = loading.getBoundingClientRect()
    return box.width === innerWidth && box.height === innerHeight - 44
  }))
  const rotation = () => page.evaluate(() => getComputedStyle(document.querySelector('#dsh-desktop-titlebar-boot-loading .dshBoot__spinner')).transform)
  const firstRotation = await rotation()
  await sleep(150)
  assert.notEqual(await rotation(), firstRotation, 'the update indicator is animated')
  await page.screenshot({ path: join(root, 'loading.png'), timeout: 5000 })
  pass('slow new DSH scripts leave a visible loading status and usable themed window controls')
  unblockScripts()
  await until(() => page.evaluate(old => window.__DSH_REMOTE_IDENTITY__?.backendInstance > old, source.instance))
  await ready()
  await until(async () => !(await state()).hasSnapshot)
  assert.notEqual(await page.evaluate(() => location.origin), source.origin)
  assert.equal(await readFile(join(root, 'version.txt'), 'utf8'), targetVersion)
  const evidence = JSON.parse(await readFile(join(root, 'install-evidence.json'), 'utf8'))
  assert.equal(evidence.oldBackendStopped, true)
  assert.equal(evidence.args.at(-1), '@deepseek-ai/dsh@latest')
  assert.ok(await page.locator('.dshTb').isVisible())
  assert.equal(await page.locator('#dsh-desktop-titlebar-boot-loading').count(), 0)
  assert.deepEqual(await inspectDraft(), savedDraft)
  await page.screenshot({ path: join(root, 'restored.png') })
  pass('old process exits before npm; new version restores the interface, draft and attachment bytes')

  await writeFile(join(root, 'fail-install'), '')
  await requestUpdate('0.2.2-rc.1')
  await until(() => page.evaluate(() => location.hostname === 'tauri.localhost' && document.body.textContent.includes('simulated npm failure')))
  assert.equal((await state()).hasSnapshot, true)
  assert.ok(await page.getByRole('button', { name: '重新检测', exact: true }).isVisible())
  assert.deepEqual(await bootColors(), expectedColors)
  await page.screenshot({ path: join(root, 'failed.png') })
  pass('npm failure displays a retry page and retains the interface snapshot')
  await unlink(join(root, 'fail-install'))
  await until(async () => {
    try { await page.getByRole('button', { name: '重新检测', exact: true }).click({ timeout: 500 }); return true } catch { return false }
  })
  await ready()
  await until(async () => !(await state()).hasSnapshot)
  assert.ok(await page.locator('.dshTb').isVisible())
  assert.deepEqual(await inspectDraft(), savedDraft)
  pass('retry starts the installed runtime and restores the saved interface')
} catch (error) {
  report.error = error.stack
  report.body = await page?.locator('body').innerText().catch(() => '')
  report.native = await state().catch(() => null)
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  throw error
} finally {
  unblockScripts()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(join(root, 'process.log'), output)
  await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: Date.now(), action: 'quit' }))
  await browser?.close()
  await until(() => child.exitCode !== null, 10000).catch(() => child.kill())
  if (previousShortcut) await writeFile(shortcut, previousShortcut)
  else await unlink(shortcut).catch(error => { if (error.code !== 'ENOENT') throw error })
  spawnSync('reg.exe', hadScheme ? ['import', schemeBackup] : ['delete', scheme, '/f'], { windowsHide: true, stdio: 'ignore' })
  console.log('Report: ' + root)
}
