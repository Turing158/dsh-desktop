/** Real archive navigation and readonly history in an isolated DSH profile. No model calls. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkWorkspaceMotion } from './workspace-motion-checks.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/sidebar-archive-'))
const home = join(root, 'home'), probe = join(root, 'probe'), workA = join(root, 'workspace-a'), workB = join(root, 'workspace-b')
await Promise.all([home, probe, workA, workB].map(path => mkdir(path)))
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: off\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/archive-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@dsh-desktop/sidebar-archive'] } } }))
await writeFile(join(probe, 'index.js'), `
export const inject = ['webServer', 'sessions', 'agents', 'connection']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/archive-smoke/seed', handler: async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const { id, title, turns } = JSON.parse(Buffer.concat(chunks).toString())
      const live = ctx.sessions.get(id)
      const held = live ? null : await ctx.agents.resume({ resumeSessionId: id })
      try {
        const session = live || held.agent.session
        for (let turn = 1; turn <= turns; turn++) {
          session.append('turn/start', { turn })
          session.append('user/message', { id: 'user-' + turn, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: title + ' question ' + turn }] }, { surfaceOp: 'append' })
          session.append('step/start', { turn, step: 1 })
          session.append('assistant/message', { turn, step: 1, message: { id: 'answer-' + turn, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: title + ' answer ' + turn + '\\n\\nHistorical content is readable.' }] }, stream: [] }, { surfaceOp: 'append' })
          session.append('step/end', { turn, step: 1 })
          session.append('turn/end', { turn, reason: { kind: 'completed' } })
        }
        await ctx.sessions.flush(session)
      } finally { await held?.dispose() }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true }))
    } catch (error) { res.statusCode = 500; res.end(error.stack) }
  } }, 'archive fixture'))
}
`)
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({ id: '@dsh-desktop/archive-smoke', factory: () => ({
  inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'layout', 'configForms'], apply(ctx) { window.__ARCHIVE_TEST__ = ctx }
}) })`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: archive-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
await writeFile(join(root, 'patch.yml'), patch)
let child, browser, page, output = ''
const errors = [], requests = [], report = { root, checks: [] }
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  child = spawn(process.execPath, [dshBin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--port', '0'], {
    cwd: workA, windowsHide: true, env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  let url
  for (let i = 0; i < 300; i++) { url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]; if (url) break; if (child.exitCode !== null) throw Error(output.slice(-4000)); await sleep(100) }
  assert.ok(url, output.slice(-4000))
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', req => { if (/\/api\//.test(req.url())) requests.push({ url: req.url(), body: req.postData() }) })
  await page.addInitScript(() => { window.__DSH_UI_BOOT__ = { smoke: true }; window.__DSH_DESKTOP_BOOT_HOST__ = true })
  await page.goto(url)
  await page.waitForFunction(() => {
    if (document.body.textContent.includes('Failed to load plugins')) throw Error(document.body.textContent)
    return window.__ARCHIVE_TEST__ && window.__DSH_ARCHIVE_SMOKE__
  })
  await page.waitForFunction(() => {
    for (const button of document.querySelectorAll('button')) {
      if (button.textContent.trim() === '稍后配置') return true
      if (['继续', '我知道了'].includes(button.textContent.trim()) && !button.disabled) button.click()
    }
    return false
  })
  await page.getByRole('button', { name: '稍后配置', exact: true }).click()
  await page.evaluate(() => document.documentElement.removeAttribute('data-dsh-browser'))
  const ids = await page.evaluate(async paths => {
    const ctx = window.__ARCHIVE_TEST__, ids = []
    for (const [path, title, turns] of [[paths[0], 'Archived Alpha', 60], [paths[1], 'Archived Beta', 2], [paths[0], 'Active Gamma', 1]]) {
      const workspace = await ctx.workspaces.create({ path })
      const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
      const response = await fetch('/archive-smoke/seed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, title, turns }) })
      if (!response.ok) throw Error(await response.text())
      const held = ctx.sessions.retain(id, { source: 'fixture' }); await held.ready
      await held.binding.session.rename(title); held.release()
      ids.push(id)
    }
    await ctx.uiWorkspace.archiveSession(ids[0]); await ctx.uiWorkspace.archiveSession(ids[1])
    ctx.uiWorkspace.openSession(ids[2])
    ctx.slots.entriesOfSlot('root')[0].store.create().actions.setSidebar(280)
    return ids
  }, [workA, workB])
  const region = page.locator('[data-slot="sidebar.workspaces"]')
  const row = id => region.locator('[data-row-key="session:' + id + '"]')
  await row(ids[2]).waitFor()
  assert.equal(await row(ids[0]).count(), 0)
  await row(ids[2]).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^分叉会话/ }).waitFor()
  await page.keyboard.press('Escape')
  const toggle = page.locator('.dshArchive__toggle')
  assert.equal(await toggle.evaluate(node => node.closest('[class*="_headerActions"]').lastElementChild.contains(node)), true)
  for (const remote of [false, true]) {
    await page.evaluate(remote => document.documentElement.toggleAttribute('data-dsh-browser', remote), remote)
    for (const animation of ['off', 'on']) {
      await page.evaluate(animation => window.__ARCHIVE_TEST__.configForms.get('desktop-appearance').set('animation', animation), animation)
      for (const cancel of ['button', 'Escape', 'button']) {
        report.searchCancel = { remote, animation, cancel }
        await region.locator('[class*="_searchSlot"] button[class*="_searchButton"]').click()
        const search = region.locator('input[class*="_searchInput"]')
        await search.fill('Gamma')
        if (cancel === 'button') await region.locator('button[class*="_clearButton"]').click()
        else await search.press('Escape')
        await page.waitForFunction(() => {
          const region = document.querySelector('[data-slot="sidebar.workspaces"]')
          return !region.getAnimations({ subtree: true }).some(animation => animation.playState === 'running')
        })
        const visible = await toggle.evaluate(button => {
          const box = button.getBoundingClientRect(), actions = button.closest('[class*="_headerActions"]').getBoundingClientRect()
          return box.left >= actions.left && box.right <= actions.right + 1
            && button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        })
        assert.equal(visible, true, `archive remains visible and clickable after ${cancel}, remote=${remote}, animation=${animation}`)
        assert.equal(await toggle.count(), 1)
      }
    }
    await page.screenshot({ path: join(root, 'search-cancel-' + (remote ? 'remote' : 'desktop') + '.png') })
  }
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-dsh-browser')
    return window.__ARCHIVE_TEST__.configForms.get('desktop-appearance').set('animation', 'off')
  })
  pass('repeated search cancellation keeps the archive button visible and clickable on desktop and remote pages')
  const checkViewOptions = async mode => {
    await region.getByRole('button', { name: '视图选项', exact: true }).click()
    const menu = page.locator('[role="menu"][class*="_viewOptionsMenu"]')
    await menu.waitFor()
    await page.waitForFunction(() => document.querySelectorAll('[data-dsh-archive-filter-hidden]').length === 5)
    assert.equal(await menu.getByRole('menuitem').count(), 5)
    assert.equal(await menu.getByText('筛选会话', { exact: true }).isVisible(), false)
    for (const name of ['隐藏已归档', '全部对话（显示已归档）', '仅显示已归档']) {
      assert.equal(await menu.getByRole('menuitem', { name, exact: true }).count(), 0)
    }
    assert.equal(await menu.getByRole('separator').count(), 1)
    await page.keyboard.press('End')
    assert.equal(await menu.locator('button:enabled').last().evaluate(node => node === document.activeElement), true)
    await page.screenshot({ path: join(root, 'view-options-' + mode + '.png') })
    await page.keyboard.press('Escape')
  }
  await checkViewOptions('workspace')
  await toggle.click()
  await page.locator('.dshArchive__empty').waitFor()
  for (const group of await region.locator('[role="treeitem"][aria-expanded="false"]').all()) await group.click()
  await row(ids[0]).waitFor(); await row(ids[1]).waitFor()
  assert.equal(await row(ids[2]).count(), 0)
  assert.equal(await region.locator('[class*="_sectionLabel"]').textContent(), '归档区')
  pass('rightmost archive button switches to native workspace groups with archived sessions only')
  await checkViewOptions('archive')
  pass('view options retain grouping and ordering, omitting the archive filter section and keyboard stops')
  await row(ids[0]).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^取消归档/ }).waitFor()
  assert.equal(await page.getByRole('menuitem', { name: /^分叉会话/ }).count(), 0)
  assert.equal(await page.getByRole('menuitem', { name: /^重命名/ }).count(), 1)
  await page.screenshot({ path: join(root, 'archive-context-menu.png') })
  await page.keyboard.press('Escape')
  pass('archived session context menus omit Fork while normal session menus retain it')
  await row(ids[0]).click()
  await page.locator('.dshArchive__content').getByText('Archived Alpha answer 60', { exact: false }).waitFor()
  assert.equal(await page.locator('.dshArchive textarea, .dshArchive [contenteditable="true"], .dshArchive [data-slot="composer"]').count(), 0)
  assert.equal(await page.locator('.dshArchive__content').getByText('Archived Alpha question 60', { exact: true }).count(), 1)
  assert.equal(await page.evaluate(id => window.__ARCHIVE_TEST__.workspaces.list.getSnapshot().archivedSessionIds.includes(id), ids[0]), true)
  await page.screenshot({ path: join(root, 'archive-light.png') })
  report.layout = await page.locator('.dshArchive').evaluate(node => {
    const parents = []
    for (let e = node; e; e = e.parentElement) {
      const s = getComputedStyle(e), r = e.getBoundingClientRect()
      parents.push({ tag: e.tagName, class: e.className, attrs: [...e.attributes].map(a => [a.name, a.value]), rect: r.toJSON(), display: s.display, position: s.position, background: s.background, grid: s.gridTemplateColumns })
    }
    return parents
  })
  pass('archived history opens without unarchiving and has no composer')
  await page.locator('.dshArchive__tabs button').last().click()
  await page.screenshot({ path: join(root, 'archive-trajectory.png') })
  await page.locator('.dshArchive__tabs button').first().click()
  await row(ids[1]).focus(); await page.keyboard.press('Enter')
  await page.locator('.dshArchive__content').getByText('Archived Beta answer 2', { exact: false }).waitFor()
  assert.equal(await page.locator('.dshArchive__content').getByText('Archived Alpha answer 60', { exact: false }).count(), 0)
  pass('keyboard opening and switching sessions replaces the readonly content')
  await toggle.click()
  await row(ids[2]).waitFor()
  await page.locator('.dshArchive').waitFor({ state: 'detached' })
  assert.equal(await region.locator('[class*="_sectionLabel"]').textContent(), '工作区')
  pass('returning restores normal workspace and conversation')
  report.motion = await checkWorkspaceMotion(page, root, ids[2])
  pass('workspace disclosure, overflow, list switching, rapid reversal and live animation preferences')
  assert.deepEqual(errors, [])
} catch (error) {
  report.error = error.stack
  if (page) { report.body = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {}) }
  throw error
} finally {
  report.errors = errors; report.requests = requests
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(join(root, 'host.log'), output)
  await browser?.close()
  if (child?.exitCode === null) {
    try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGTERM') } catch {}
  }
  console.log('Evidence: ' + join(root, 'report.json'))
}
