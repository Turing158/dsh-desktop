/** Exercise the shipped slots and RPC with a real isolated DSH + Edge. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const desktop = process.argv.includes('--desktop')
const root = await mkdtemp(resolve('src-tauri/target/directory-picker-smoke-'))
const home = join(root, 'home'), workspace = join(root, 'workspace'), probe = join(root, 'probe')
await Promise.all([home, workspace, probe, join(workspace, '子目录 A'), join(workspace, '子目录 B'), join(workspace, '.hidden')].map(path => mkdir(path, { recursive: true })))
const attachmentText = '远程附件内容\nUnicode and bytes preserved.'
const attachmentImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGz8AAAAASUVORK5CYII=', 'base64')
await writeFile(join(workspace, '中文 附件.txt'), attachmentText)
await writeFile(join(workspace, '图片.png'), attachmentImage)
await writeFile(join(workspace, 'will-disappear.txt'), 'gone')
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/directory-smoke', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@dsh-desktop/directory-picker'] } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}\n')
const probeDependencies = ['slots', 'uiWorkspace', 'remote', 'locale', 'sessions', 'workspaces', 'conversation', ...(desktop ? [] : ['remote.desktopDirectoryPicker'])]
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/directory-smoke',factory:()=>({inject:${JSON.stringify(probeDependencies)},apply(ctx){window.__DIRECTORY_SMOKE__=ctx}})})`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  // Compose the same pair used for remote access, with a loopback-only test server.
  + '\n- id: directory-picker\n  disabled: true\n- insert:\n    - id: directory-smoke-host\n      name: "@deepseek-ai/dsh-host-directory-picker-browse"\n    - id: directory-smoke-ui\n      name: "@deepseek-ai/dsh-client-ui-directory-picker-browse"\n'
  + '\n- insert:\n    - id: directory-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
await writeFile(join(root, 'patch.yml'), patch)
let child, browser, page, output = ''
const report = { root, desktop, checks: [] }, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  child = spawn(process.execPath, [dshBin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--port', '0'], { cwd: workspace, windowsHide: true,
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_CHANGES_DIR: join(root, 'changes') }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  let url
  for (let i = 0; i < 400; i++) { url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]; if (url) break; if (child.exitCode !== null) throw Error(output); await sleep(100) }
  if (!url) throw Error(output)
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  if (desktop) await page.addInitScript(() => {
    // Exercise real React/slots/adoption on a browse host; only the OS boundary
    // is stubbed so this check can run headlessly without a visible chooser.
    window.__nativeDirectoryPicks = []
    window.__TAURI__ = { core: { invoke: async command => {
      if (command === 'pick_workspace_directory') return new Promise((resolve, reject) => {
        window.__nativeDirectoryPicks.push({ resolve, reject })
      })
      if (command === 'window_is_maximized') return false
      return null
    } } }
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.__DIRECTORY_SMOKE__), undefined, { timeout: 40000 })
  await page.getByRole('button', { name: '继续', exact: true }).waitFor()
  await page.waitForFunction(() => {
    for (const button of document.querySelectorAll('button')) {
      if (button.textContent.trim() === '稍后配置') return true
      if (['继续', '我知道了'].includes(button.textContent.trim())) button.click()
    }
    return false
  })
  await page.getByRole('button', { name: '稍后配置', exact: true }).click()
  if (desktop) {
    const add = async () => {
      await page.getByRole('button', { name: '选择工作区', exact: true }).click()
      await page.getByRole('menuitem', { name: '添加工作区…', exact: true }).click()
    }
    await add()
    await page.waitForFunction(() => window.__nativeDirectoryPicks.length === 1)
    assert.equal(await page.getByRole('dialog').count(), 0, 'no old or new browser picker in the desktop')
    await page.evaluate(() => window.__nativeDirectoryPicks[0].resolve(null))
    await add()
    await page.waitForFunction(() => window.__nativeDirectoryPicks.length === 2)
    await page.evaluate(path => window.__nativeDirectoryPicks[1].resolve(path), join(workspace, '子目录 A'))
    await page.getByRole('button', { name: '选择工作区', exact: true }).filter({ hasText: '子目录 A' }).waitFor()
    await page.getByRole('button', { name: '选择工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: /子目录 A/ }).waitFor()
    await page.keyboard.press('Escape')
    report.checks.push('desktop Add workspace uses the native bridge on a browse host, cancels quietly and adopts a Unicode folder')
    await page.keyboard.press('Control+Alt+o')
    await page.waitForFunction(() => window.__nativeDirectoryPicks.length === 3)
    assert.equal(await page.getByRole('dialog').count(), 0)
    await page.evaluate(() => window.__nativeDirectoryPicks[2].resolve(null))
    report.checks.push('sidebar keyboard action also uses the native bridge without a browser dialog')
  } else {
  const dialog = () => page.getByRole('dialog', { name: '选择工作区目录', exact: true })
  const button = name => dialog().getByRole('button', { name, exact: true })
  const location = () => dialog().locator('.dshDirectory__list')
  const at = async path => { await page.waitForFunction(path => document.querySelector('.dshDirectory__list')?.dataset.location === path
    && document.querySelector('.dshDirectory__list')?.getAttribute('aria-busy') === 'false', path) }
  const go = async path => { await dialog().getByRole('combobox', { name: '文件夹路径' }).fill(path); await button('转到').click(); await at(path) }
  await page.getByRole('button', { name: '选择工作区', exact: true }).click()
  await page.getByRole('menuitem', { name: '添加工作区…', exact: true }).click()
  await dialog().waitFor(); await location().filter({ has: page.locator('button') }).waitFor()
  const initial = await location().getAttribute('data-location')
  assert.ok(initial && initial !== 'desktop:roots')
  assert.equal(await button('后退').isDisabled(), true)
  assert.equal(await button('前进').isDisabled(), true)
  await dialog().getByRole('group', { name: '文件夹导航' }).getByRole('button', { name: '此电脑', exact: true }).click()
  await at('desktop:roots')
  assert.equal(await button('打开').isDisabled(), true)
  assert.equal(await button('上一级').isDisabled(), true)
  const roots = await page.evaluate(async () => (await window.__DIRECTORY_SMOKE__.remote.desktopDirectoryPicker.roots(new AbortController().signal)).value)
  assert.ok(roots.some(entry => entry.path === parse(workspace).root), JSON.stringify(roots))
  await button(parse(workspace).root).click(); await at(parse(workspace).root)
  await button('上一级').click(); await at('desktop:roots')
  await button('后退').click(); await at(parse(workspace).root)
  await button('前进').click(); await at('desktop:roots')
  await page.screenshot({ path: join(root, 'drives.png'), animations: 'disabled' })
  report.checks.push('real host drive list, drive roots, parent to drives, back and forward')
  await go(workspace)
  assert.equal(await button('前进').isDisabled(), true)
  assert.equal(await button('.hidden').count(), 0)
  await dialog().getByRole('checkbox', { name: '显示隐藏文件' }).check()
  await button('.hidden').waitFor()
  await button('子目录 A').click(); await at(join(workspace, '子目录 A'))
  await page.keyboard.press('Alt+ArrowUp'); await at(workspace)
  await button('后退').click(); await at(join(workspace, '子目录 A'))
  await button('前进').click(); await at(workspace)
  await mkdir(join(workspace, '刷新后出现'))
  await button('刷新').click(); await button('刷新后出现').waitFor()
  await button('后退').click(); await at(join(workspace, '子目录 A'))
  await button('前进').click(); await at(workspace)
  await dialog().getByRole('combobox', { name: '文件夹路径' }).fill(join(workspace, 'missing'))
  await button('转到').click(); await dialog().getByRole('alert').waitFor()
  assert.equal(await location().getAttribute('data-location'), workspace)
  assert.equal(await button('打开').isDisabled(), true)
  await button('刷新').click(); await at(workspace)
  await dialog().getByRole('alert').waitFor({ state: 'hidden' })
  report.checks.push('absolute paths, hidden folders, keyboard parent, refresh without history and failed navigation recovery')
  await button('新建文件夹').click()
  const create = page.getByRole('dialog', { name: '新建文件夹', exact: true })
  await create.getByRole('textbox', { name: '文件夹名称' }).fill('新文件夹')
  await create.getByRole('button', { name: '创建', exact: true }).click()
  await at(join(workspace, '新文件夹')); assert.ok((await stat(join(workspace, '新文件夹'))).isDirectory())
  await button('上一级').click(); await at(workspace)
  await page.screenshot({ path: join(root, 'folders-light.png'), animations: 'disabled' })
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await page.screenshot({ path: join(root, 'folders-dark.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 375, height: 750 })
  await page.screenshot({ path: join(root, 'folders-mobile.png'), animations: 'disabled' })
  const bounds = await dialog().evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: node.clientWidth, scroll: node.scrollWidth }))
  assert.ok(bounds.left >= 0 && bounds.right <= 375 && bounds.scroll <= bounds.width + 1, JSON.stringify(bounds))
  for (let i = 0; i < 20; i++) { await page.keyboard.press('Tab'); assert.ok(await dialog().evaluate(node => node.contains(document.activeElement))) }
  await button('打开').click(); await dialog().waitFor({ state: 'hidden' })
  report.checks.push('new folder, light/dark/mobile layout, focus trap and workspace adoption')
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.keyboard.press('Control+Alt+o'); await at(initial)
  assert.equal(await button('后退').isDisabled(), true)
  await button('取消').click(); await dialog().waitFor({ state: 'hidden' })
  // The hero uses the same public flow contract and must resolve to this extension too.
  const occupants = await page.evaluate(() => ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']
    .map(name => window.__DIRECTORY_SMOKE__.slots.entriesOfSlot(name).map(entry => entry.options.priority)))
  assert.ok(occupants.every(values => values.includes(-10)), JSON.stringify(occupants))
  const unauthorized = await fetch(new URL('/api/desktopDirectoryPicker/roots', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: {} }) })
  assert.ok([401, 403].includes(unauthorized.status))
  report.checks.push('reopening resets navigation; both owner slots registered; unauthenticated drive requests rejected')
  }
  // Drive the actual composer File command, preserving its intake and upload path.
  const sessionId = await page.evaluate(async path => {
    const ctx = window.__DIRECTORY_SMOKE__, workspace = await ctx.workspaces.create({ path })
    const session = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
    ctx.uiWorkspace.openSession(session)
    return session
  }, workspace)
  const openAttachments = async () => {
    await page.getByRole('button', { name: '添加文件或调用指令', exact: true }).click()
    await page.getByRole('option').filter({ hasText: /^文件/ }).click()
  }
  const attachmentState = () => page.evaluate(id => {
    const ctx = window.__DIRECTORY_SMOKE__, state = ctx.conversation.input.for(ctx.sessions.scope(id)).state.getSnapshot()
    return Promise.all(ctx.conversation.resolveDraftAttachments(state.attachmentIds).map(async asset => ({
      name: asset.file.name, type: asset.file.type, bytes: Array.from(new Uint8Array(await asset.file.arrayBuffer())), kind: asset.kind,
    })))
  }, sessionId)
  if (desktop) {
    const chooserEvent = page.waitForEvent('filechooser')
    await openAttachments()
    const chooser = await chooserEvent
    assert.equal(await page.locator('[data-dsh-attachment-picker]').count(), 0, 'desktop installs no attachment override')
    assert.equal(await page.getByRole('dialog', { name: '选择附件' }).count(), 0)
    await chooser.setFiles(join(workspace, '中文 附件.txt'))
    await page.waitForFunction(id => {
      const ctx = window.__DIRECTORY_SMOKE__
      return ctx.conversation.input.for(ctx.sessions.scope(id)).state.getSnapshot().attachmentIds.length === 1
    }, sessionId)
    assert.equal((await attachmentState())[0].name, '中文 附件.txt')
    report.checks.push('desktop File command still uses its original native input and attachment intake')
  } else {
    let nativeChoosers = 0
    page.on('filechooser', () => nativeChoosers++)
    const dialog = page.getByRole('dialog', { name: '选择附件', exact: true })
    const button = name => dialog.getByRole('button', { name, exact: true })
    const at = async path => {
      await page.waitForFunction(path => {
        const list = document.querySelector('.dshDirectory__list')
        return list?.getAttribute('aria-busy') === 'false' && (list.dataset.location === path || list.querySelector('[role="alert"]'))
      }, path)
      assert.deepEqual(await dialog.getByRole('alert').allTextContents(), [], 'attachment browsing must not show an RPC error')
      assert.equal(await dialog.locator('.dshDirectory__list').getAttribute('data-location'), path)
    }
    const go = async path => {
      await dialog.getByRole('combobox', { name: '文件夹路径' }).fill(path); await button('转到').click()
      await at(path)
    }
    const failOnce = async (method, message) => page.route('**/api/desktopDirectoryPicker/' + method, route => route.fulfill({ json: {
      type: 'server-response', rpcId: route.request().postDataJSON().rpcId,
      result: { ok: false, error: { code: 'desktop-directory-picker/' + method, message, details: {} } },
    } }), { times: 1 })
    const reason = "EACCES: permission denied, scandir '" + join(workspace, '无权访问的文件夹') + "'"
    await failOnce('files', reason)
    await openAttachments(); await dialog.waitFor()
    await dialog.getByRole('heading', { name: '访问权限不足', exact: true }).waitFor()
    assert.equal(await dialog.locator('.dshDirectory__reason .dshDirectory__error').textContent(), reason)
    assert.equal(await dialog.locator('.dshDirectory__row').count(), 0)
    assert.equal(await dialog.getByText('没有可显示的文件', { exact: true }).count(), 0)
    assert.equal(await button('添加附件').isDisabled(), true)
    assert.equal(await button('从此设备选择').isEnabled(), true)
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab')
      assert.ok(await dialog.evaluate(node => node.contains(document.activeElement)), 'error navigation keeps focus inside the dialog')
    }
    for (const [width, dark, name] of [[1400, false, 'light'], [1400, true, 'dark'], [375, false, 'mobile']]) {
      await page.setViewportSize({ width, height: width === 375 ? 750 : 900 })
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
      const bounds = await dialog.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
        width: node.clientWidth, scroll: node.scrollWidth, listWidth: node.querySelector('.dshDirectory__list').clientWidth,
        listScroll: node.querySelector('.dshDirectory__list').scrollWidth }))
      assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.scroll <= bounds.width + 1 && bounds.listScroll <= bounds.listWidth + 1, JSON.stringify(bounds))
      await dialog.screenshot({ path: join(root, 'attachments-error-' + name + '.png'), animations: 'disabled' })
      if (width === 375) {
        await button('重试').scrollIntoViewIfNeeded()
        await dialog.screenshot({ path: join(root, 'attachments-error-mobile-details.png'), animations: 'disabled' })
      }
    }
    await button('重试').click(); await at(homedir())
    await button('取消').click(); await dialog.waitFor({ state: 'hidden' })
    await page.setViewportSize({ width: 1400, height: 900 })
    report.checks.push('initial permission failures show an accessible placeholder, short explanation and full cause in light/dark/mobile; retry recovers')
    await openAttachments(); await dialog.waitFor(); await at(homedir())
    assert.equal(nativeChoosers, 0, 'remote command opens the web dialog')
    await button('刷新').click(); await at(homedir())
    await go(workspace)
    await button('主目录').click(); await at(homedir())
    await button('后退').click(); await at(workspace)
    report.checks.push('attachment picker initially loads the host home without errors; refresh, Home and back preserve navigation')
    await page.route('**/api/desktopDirectoryPicker/files', route => route.fulfill({ status: 503, body: 'temporary failure' }), { times: 1 })
    const nextFolder = join(workspace, '子目录 A')
    await button('子目录 A').click()
    await dialog.getByRole('heading', { name: '无法加载此位置', exact: true }).waitFor()
    assert.match(await dialog.locator('.dshDirectory__reason').textContent(), /HTTP 503/)
    assert.equal(await dialog.locator('.dshDirectory__row').count(), 0, 'failed navigation hides the previous directory entries')
    await button('重试').click(); await at(nextFolder)
    await button('后退').click(); await at(workspace)
    await dialog.getByRole('combobox', { name: '文件夹路径' }).fill(join(workspace, 'missing'))
    await button('转到').click()
    await dialog.getByRole('heading', { name: '文件夹不存在或已被移动', exact: true }).waitFor()
    assert.match(await dialog.locator('.dshDirectory__reason').textContent(), /ENOENT/)
    await button('主目录').click(); await at(homedir()); await go(workspace)
    report.checks.push('connection and missing-directory failures show distinct summaries; retry targets the failed folder and navigation remains usable')
    assert.equal(await button('添加附件').isDisabled(), true)
    await button('中文 附件.txt').click()
    await button('图片.png').click()
    await dialog.getByText('已选择 2 个文件', { exact: true }).waitFor()
    await page.setViewportSize({ width: 375, height: 750 })
    const bounds = await dialog.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: node.clientWidth, scroll: node.scrollWidth }))
    assert.ok(bounds.left >= 0 && bounds.right <= 375 && bounds.scroll <= bounds.width + 1, JSON.stringify(bounds))
    await page.screenshot({ path: join(root, 'attachments-mobile.png'), animations: 'disabled' })
    await failOnce('readFile', 'EPERM: operation not permitted, open attachment')
    await button('添加附件').click()
    await dialog.getByRole('heading', { name: '访问权限不足', exact: true }).waitFor()
    assert.equal((await attachmentState()).length, 0)
    assert.equal(await button('重新选择').isEnabled(), true)
    assert.equal(await dialog.getByRole('checkbox', { name: '显示隐藏文件' }).isDisabled(), true)
    await button('重试').click(); await dialog.waitFor({ state: 'hidden' })
    const attachments = await attachmentState()
    assert.deepEqual(attachments.map(file => file.name), ['中文 附件.txt', '图片.png'])
    assert.deepEqual(attachments[0].bytes, [...Buffer.from(attachmentText)])
    assert.deepEqual(attachments[1].bytes, [...attachmentImage])
    assert.equal(attachments[1].type, 'image/png'); assert.equal(attachments[1].kind, 'image')
    await page.waitForFunction(id => {
      const ctx = window.__DIRECTORY_SMOKE__, input = ctx.conversation.input.for(ctx.sessions.scope(id))
      return ctx.conversation.resolveDraftAttachments(input.state.getSnapshot().attachmentIds)
        .filter(a => a.kind === 'file').every(a => ctx.conversation.fileUploads.getSnapshot()[a.id]?.status === 'ready')
    }, sessionId)
    report.checks.push('remote File command, mobile layout, multi-selection, Unicode/binary bytes, image classification and real file upload')
    await page.setViewportSize({ width: 1400, height: 900 })
    await openAttachments(); await dialog.waitFor(); await go(workspace)
    await button('中文 附件.txt').click()
    await button('will-disappear.txt').click(); await unlink(join(workspace, 'will-disappear.txt'))
    await button('添加附件').click(); await dialog.getByRole('alert').waitFor()
    await dialog.getByRole('heading', { name: '附件不存在或已被移动', exact: true }).waitFor()
    assert.match(await dialog.locator('.dshDirectory__reason').textContent(), /ENOENT/)
    assert.equal((await attachmentState()).length, 2, 'failed reads do not partially add a batch')
    await button('重新选择').click()
    await dialog.getByRole('alert').waitFor({ state: 'hidden' })
    assert.equal(await button('中文 附件.txt').getAttribute('aria-pressed'), 'true', 'choosing again preserves the selection for correction')
    await button('取消').click(); await dialog.waitFor({ state: 'hidden' })
    await openAttachments(); await dialog.waitFor()
    const chooserEvent = page.waitForEvent('filechooser')
    await button('从此设备选择').click()
    await (await chooserEvent).setFiles(join(workspace, '中文 附件.txt'))
    await dialog.waitFor({ state: 'hidden' })
    await page.waitForFunction(id => {
      const ctx = window.__DIRECTORY_SMOKE__
      return ctx.conversation.input.for(ctx.sessions.scope(id)).state.getSnapshot().attachmentIds.length === 3
    }, sessionId)
    assert.equal(nativeChoosers, 1)
    report.checks.push('missing file errors stay in the dialog; cancel and local-device picker remain usable')
    await page.evaluate(() => {
      const original = window.fetch
      window.__pendingAttachmentRead = null
      window.fetch = async (input, init) => {
        const response = await original(input, init)
        if (new URL(input instanceof Request ? input.url : input, location.href).pathname !== '/api/desktopDirectoryPicker/readFile') return response
        // Hold a completed host response so cancellation must discard late bytes.
        return new Promise(resolve => { window.__pendingAttachmentRead = { signal: init.signal, finish: () => resolve(response) } })
      }
    })
    for (const action of ['cancel', 'switch session']) {
      await openAttachments(); await dialog.waitFor(); await go(workspace); await button('中文 附件.txt').click()
      await page.evaluate(() => { window.__pendingAttachmentRead = null })
      await button('添加附件').click()
      await page.waitForFunction(() => window.__pendingAttachmentRead !== null)
      const before = await attachmentState()
      if (action === 'cancel') await button('取消').click()
      else await page.evaluate(async path => {
        const ctx = window.__DIRECTORY_SMOKE__, workspace = await ctx.workspaces.create({ path })
        const next = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
        ctx.uiWorkspace.openSession(next)
        window.__nextAttachmentSession = next
      }, workspace)
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(await page.evaluate(() => window.__pendingAttachmentRead.signal.aborted), true)
      await page.evaluate(async () => {
        window.__pendingAttachmentRead.finish()
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      assert.deepEqual(await attachmentState(), before)
    }
    assert.equal(await page.evaluate(() => {
      const ctx = window.__DIRECTORY_SMOKE__
      return ctx.conversation.input.for(ctx.sessions.scope(window.__nextAttachmentSession)).state.getSnapshot().attachmentIds.length
    }), 0)
    report.checks.push('cancel and session navigation abort in-flight reads and discard late results without changing either draft')
    for (const method of ['files', 'readFile']) {
      const response = await fetch(new URL('/api/desktopDirectoryPicker/' + method, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: { path: workspace } }) })
      assert.ok([401, 403].includes(response.status))
    }
    report.checks.push('attachment listing and file reads require authenticated RPC')
  }
  assert.deepEqual(errors, [])
  report.ok = true
} catch (error) {
  report.error = error.stack
  if (page) { await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {}); await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText().catch(() => '')) }
  throw error
} finally {
  await writeFile(join(root, 'host.log'), output)
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  if (child && child.exitCode === null) { child.kill(); await sleep(500) }
  console.log(JSON.stringify(report, null, 2))
}
