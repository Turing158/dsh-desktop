/** Real isolated DSH page, authenticated Remote calls, themes and narrow layout. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SnapshotStore } from '../dsh-plugin/sidebar-changes/host/snapshot-store.mjs'
import { hash } from '../dsh-plugin/sidebar-changes/host/paths.mjs'
import { git } from '../dsh-plugin/sidebar-changes/host/git-provider.mjs'
import { checkCommitHistory } from './commit-history-smoke.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/changes-smoke-'))
const home = join(root, 'home'), probe = join(root, 'probe'), workspace = join(root, 'workspace'), snapshots = join(root, 'changes')
await Promise.all([home, probe, workspace].map(dir => mkdir(dir)))
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/changes-smoke', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar-right', '@dsh-desktop/sidebar-changes'] } } }))
await writeFile(join(probe, 'index.js'), `import { existsSync, unlinkSync } from 'node:fs'
import { ChangesApi } from ${JSON.stringify(pathToFileURL(resolve('dsh-plugin/sidebar-changes/host/api.mjs')).href)}
export function apply() {
  const original = ChangesApi.prototype.getFileDiff
  const originalHistory = ChangesApi.prototype.listCommits
  ChangesApi.prototype.getFileDiff = function (...args) {
    const flag = ${JSON.stringify(join(root, 'fail-next-diff'))}
    if (existsSync(flag)) { unlinkSync(flag); throw Error('smoke-transient-error') }
    return original.apply(this, args)
  }
  ChangesApi.prototype.listCommits = function (...args) {
    const flag = ${JSON.stringify(join(root, 'expire-history'))}
    if (existsSync(flag)) { unlinkSync(flag); for (const snapshot of this.history.snapshots.values()) snapshot.time = 0 }
    return originalHistory.apply(this, args)
  }
  return () => { ChangesApi.prototype.getFileDiff = original; ChangesApi.prototype.listCommits = originalHistory }
}\n`)
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/changes-smoke',factory:()=>({inject:['sessions','workspaces','uiWorkspace','sidebarRight','remote','remote.desktopChanges','slots','conversation','layout'],apply(ctx){window.__CHANGES_SMOKE__=ctx}})})`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: changes-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
await writeFile(join(root, 'patch.yml'), patch)
let child, browser, output = ''
const report = { root, checks: [], measurements: [] }, sleep = ms => new Promise(r => setTimeout(r, ms))
try {
  child = spawn(process.execPath, [dshBin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--port', '0'], { cwd: workspace, windowsHide: true, env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_CHANGES_DIR: snapshots }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  let url
  for (let i = 0; i < 400; i++) { url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]; if (url) break; if (child.exitCode !== null) throw Error(output); await sleep(100) }
  if (!url) throw Error(output)
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }), errors = []
  await page.addInitScript(() => {
    window.__CHANGES_PROVIDERS__ = new Map()
    window.__DSH_UI_STATE__ = { registerProvider(id, value) { window.__CHANGES_PROVIDERS__.set(id, value); return () => window.__CHANGES_PROVIDERS__.delete(id) } }
  })
  page.on('pageerror', e => { errors.push(e.message); console.error(e.message) }); page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404 (Not Found)')) { errors.push(m.text()); console.error(m.text()) } })
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.__CHANGES_SMOKE__), undefined, { timeout: 40000 })
  const sessionId = await page.evaluate(async workspace => {
    const ctx = window.__CHANGES_SMOKE__, work = await ctx.workspaces.create({ path: workspace })
    const id = await ctx.sessions.create({ workspaceId: work.workspaceId }); await ctx.uiWorkspace.openSession(id); return id
  }, workspace)
  for (let i = 0; i < 3; i++) { await page.evaluate(() => { for (const b of document.querySelectorAll('button')) if (['继续', '稍后配置'].includes(b.textContent.trim())) b.click() }); await sleep(100) }
  const store = new SnapshotStore(snapshots)
  const names = ['README.md', 'src/components/editor/very/deep/中文 路径/Editor.tsx', 'root-file-with-an-extremely-long-name-and-1234567890.extension']
  const prefix = Array.from({ length: 1010 }, (_, i) => `unchanged line ${i + 1}\n`).join('')
  for (const name of names) {
    const before = name === names[0] ? '# DSH Desktop\n\nA desktop workspace.\n' : name === names[1] ? 'export function Editor() {\n  return <div>Editor</div>\n}\n' : prefix + 'before\n'
    const after = name === names[0] ? '# DSH Desktop\n\nA focused coding workspace.\n\nReview changes in the sidebar.\n' : name === names[1] ? 'export function Editor() {\n  const title = "Current workspace"\n  return <main aria-label={title}>Review file changes in the current session and compare them with the staging area.</main>\n}\n' : prefix + 'after\nnew line\n'
    await store.finish({ sessionId, root: workspace }, name, [{ path: name, author: sessionId, callId: 'fixture', sequence: 0, origin: 'structured', finalStatus: 'success', execution: name,
      before: { exists: true, text: before, hash: hash(before), reason: null, mode: null }, after: { exists: true, text: after, hash: hash(after), reason: null, mode: null } }])
  }
  const capability = await page.evaluate(async id => { const r = await window.__CHANGES_SMOKE__.remote.desktopChanges.getCapabilities(id, new AbortController().signal); return r.ok ? r : { ok: false, code: r.error.code, message: r.error.message, details: r.error.details } }, sessionId)
  assert.equal(capability.ok, true, JSON.stringify(capability)); assert.equal(capability.value.gitAvailability.status, 'none')
  await page.evaluate(() => window.__CHANGES_SMOKE__.sidebarRight.openTab('desktop-changes'))
  await page.locator('.dshChanges__file').first().waitFor({ timeout: 20000 })
  const initialSetup = page.getByRole('button', { name: '稍后配置', exact: true })
  try { await initialSetup.waitFor({ state: 'visible', timeout: 5000 }); await initialSetup.click() }
  catch (error) { if (error.name !== 'TimeoutError') throw error }
  assert.equal(await page.locator('.dshChanges__file').count(), 3)
  const sourceButton = () => page.locator('.dshChanges:visible').getByRole('button', { name: '更改范围', exact: true })
  const chooseSource = async label => { await sourceButton().click(); await page.getByRole('menuitem', { name: label, exact: true }).click() }
  assert.equal(await page.getByRole('button', { name: /刷新/ }).count(), 0)
  assert.equal(await page.getByText('记录范围', { exact: true }).count(), 0)
  assert.equal(await page.getByText('本会话产生的修改', { exact: true }).count(), 0)
  await sourceButton().click()
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['当前会话', '未提交', '暂存区', '提交记录'])
  assert.equal(await page.getByRole('menuitem', { name: '未提交', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('menuitem', { name: '暂存区', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('menuitem', { name: '提交记录', exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape')
  assert.equal(await sourceButton().evaluate(node => node === document.activeElement), true)
  await page.locator('.dshChanges__tag').filter({ hasText: '非 Git 仓库' }).focus()
  await page.getByText('当前会话目录不在 Git 仓库中', { exact: true }).waitFor()
  await sourceButton().focus()
  report.checks.push('real authenticated Remote and no-Git panel')
  const unauthorized = await fetch(new URL('/api/desktopChanges/getCapabilities', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: { sessionId } }) })
  assert.ok([401, 403].includes(unauthorized.status), 'unauthorized connection must be rejected: ' + unauthorized.status)
  report.checks.push('unauthorized HTTP query rejected')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(root, 'initial.png') })
  console.log('Dialogs: ' + await page.locator('[role=dialog]').allTextContents())
  const skip = page.getByRole('button', { name: '稍后配置', exact: true })
  if (await skip.count()) await skip.click()
  await page.locator('.dshChanges__file').first().click(); await page.locator('.dshChanges__line').first().waitFor()
  assert.ok((await page.locator('.dshChanges__detail').innerText()).includes('focused'))
  await page.getByRole('button', { name: /^src\/components/ }).click()
  assert.equal(await page.locator('.dshChanges__file[aria-expanded=true]').count(), 2)
  await page.locator('.dshChanges__detail').nth(1).getByRole('table').waitFor()
  await page.screenshot({ path: join(root, 'expanded-light.png') })
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await page.screenshot({ path: join(root, 'expanded-dark.png') })
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  await page.addScriptTag({ content: await readFile('dsh-plugin/ui-state/adapter.js', 'utf8') })
  const snapshot = await page.evaluate(async () => {
    const adapter = window.__DSH_CREATE_UI_ADAPTER__(window.__CHANGES_SMOKE__)
    window.__CHANGES_ADAPTER__ = adapter
    return adapter.capture({ signal: new AbortController().signal, frontendVersion: '0.2.0-rc.2', providers: window.__CHANGES_PROVIDERS__ })
  })
  await page.getByRole('button', { name: '全部折叠', exact: true }).click()
  await page.reload()
  await page.waitForFunction(() => Boolean(window.__CHANGES_SMOKE__))
  await page.getByRole('button', { name: '稍后配置', exact: true }).waitFor()
  await page.getByRole('button', { name: '稍后配置', exact: true }).click()
  await page.addScriptTag({ content: await readFile('dsh-plugin/ui-state/adapter.js', 'utf8') })
  await page.evaluate(() => { window.__CHANGES_ADAPTER__ = window.__DSH_CREATE_UI_ADAPTER__(window.__CHANGES_SMOKE__) })
  await page.evaluate(snapshot => window.__CHANGES_ADAPTER__.restore({ payload: snapshot }, { signal: new AbortController().signal, frontendVersion: '0.2.0-rc.2', providers: window.__CHANGES_PROVIDERS__ }), snapshot)
  await page.locator('.dshChanges__line').first().waitFor()
  assert.equal(await page.locator('.dshChanges__file[aria-expanded=true]').count(), 2)
  await page.getByRole('button', { name: '全部折叠', exact: true }).click()
  report.checks.push('real UI adapter restores multiple expanded files after document recreation')
  await page.getByRole('button', { name: /^root-file/ }).click()
  const context = page.getByRole('button', { name: /^展开 \d+ 行上下文$/ })
  await context.waitFor()
  await context.dblclick()
  await page.waitForFunction(() => document.querySelector('.dshChanges__context')?.textContent === '展开 607 行上下文')
  await context.click()
  await page.waitForFunction(() => document.querySelector('.dshChanges__context')?.textContent === '展开 207 行上下文')
  await context.click()
  await page.waitForFunction(() => !document.querySelector('.dshChanges__context'))
  assert.equal(await page.locator('.dshChanges__line').count(), 1013)
  assert.equal(await page.locator('.dshChanges__line code').filter({ hasText: /^unchanged line 1$/ }).count(), 1)
  await page.getByRole('button', { name: '全部折叠', exact: true }).click()
  report.checks.push('inline diff, independent expansion and paged context without duplicate rows')
  await writeFile(join(root, 'fail-next-diff'), '')
  await page.getByRole('button', { name: /^README.md，/ }).click()
  await page.locator('.dshChanges__detail [role=alert]').waitFor()
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.locator('.dshChanges__detail').getByRole('table').waitFor()
  assert.equal(await page.locator('.dshChanges__detail [role=alert]').count(), 0)
  await page.getByRole('button', { name: '全部折叠', exact: true }).click()
  report.checks.push('transient detail failure retries successfully with an unchanged revision')
  for (const dark of [false, true]) for (const zoom of [1, 1.25, 1.5]) for (const width of [240, 320, 480, 720]) {
    await page.evaluate(({dark,zoom,width}) => {
      document.body.toggleAttribute('data-ds-dark-theme', dark)
      const panel = document.querySelector('.dshChanges'); panel.style.width = width + 'px'; panel.style.zoom = String(zoom)
      panel.style.position = 'fixed'; panel.style.inset = '50px auto auto 10px'; panel.style.height = '650px'; panel.style.background = 'var(--dsw-alias-bg-base)'; panel.style.zIndex = '9999'
    }, { dark, zoom, width })
    await sleep(60)
    const measurements = await page.locator('.dshChanges').evaluate(panel => ({ width: panel.clientWidth, scrollWidth: panel.scrollWidth, rows: [...panel.querySelectorAll('.dshChanges__row')].map(row => {
      const p = row.querySelector('.dshChanges__path'), n = row.querySelector('.dshChanges__stats')
      return { path: p.textContent, pathWidth: p.getBoundingClientRect().width, statsWidth: n.getBoundingClientRect().width, gap: n.getBoundingClientRect().left - p.getBoundingClientRect().right, left: p.getBoundingClientRect().left - row.getBoundingClientRect().left }
    }) }))
    assert.ok(measurements.scrollWidth <= measurements.width + 1)
    assert.ok(measurements.rows.every(row => row.left < 2 && row.gap >= 0 && row.gap <= 13))
    report.measurements.push({ dark, zoom, width, ...measurements })
    if (zoom === 1 && [240, 720].includes(width)) await page.screenshot({ path: join(root, `${dark ? 'dark' : 'light'}-${width}.png`) })
  }
  report.checks.push('24 width/theme/zoom combinations without panel overflow; left-aligned adjacent counts')
  await page.evaluate(() => {
    const panel = document.querySelector('.dshChanges')
    panel.style.width = '480px'; panel.style.zoom = '1'; panel.style.height = '650px'
    document.body.removeAttribute('data-ds-dark-theme')
  })
  await page.getByRole('button', { name: /^src\/components/ }).click()
  await page.locator('.dshChanges__detail').getByRole('table').waitFor()
  await page.locator('.dshChanges').screenshot({ path: join(root, 'sidebar-light.png') })
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await page.locator('.dshChanges').screenshot({ path: join(root, 'sidebar-dark.png') })
  assert.equal(await page.locator('.dshChanges').evaluate(panel => panel.scrollWidth <= panel.clientWidth), true)
  assert.equal(await page.locator('.dshChanges__code').evaluate(code => code.scrollWidth > code.clientWidth), true)
  await page.getByRole('button', { name: '全部折叠', exact: true }).click()
  report.checks.push('narrow expanded code scrolls locally without widening the sidebar')
  await page.evaluate(() => { document.documentElement.setAttribute('data-dsh-ui', 'vanilla') })
  assert.equal(await page.locator('.dshChanges__file').count(), 3)
  report.checks.push('open content survives vanilla mode')
  await page.evaluate(() => { document.querySelector('.dshChanges').removeAttribute('style') })
  await git(workspace, ['init']); await git(workspace, ['config', 'user.email', 'test@example.invalid']); await git(workspace, ['config', 'user.name', 'Test'])
  await writeFile(join(workspace, 'partial.txt'), 'A\n'); await git(workspace, ['add', '.']); await git(workspace, ['commit', '-m', 'base'])
  await writeFile(join(workspace, 'partial.txt'), 'B\n'); await git(workspace, ['add', '.']); await writeFile(join(workspace, 'partial.txt'), 'C\n')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.locator('.dshChanges__tag').filter({ hasText: '非 Git 仓库' }).waitFor({ state: 'detached' })
  await sourceButton().focus()
  await page.keyboard.press('ArrowDown')
  await page.getByRole('menuitem', { name: '当前会话', exact: true }).waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem')
  report.keyboardTrace = [await page.evaluate(() => document.activeElement?.textContent)]
  await page.keyboard.press('ArrowDown')
  report.keyboardTrace.push(await page.evaluate(() => document.activeElement?.textContent))
  await page.keyboard.press('Enter')
  report.keyboardTrace.push(await page.locator('.dshChanges:visible').getAttribute('data-source'))
  await page.waitForFunction(() => document.querySelector('.dshChanges')?.dataset.source === 'working')
  await page.getByRole('button', { name: /^partial.txt，/ }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.dshChanges__line[data-kind="+"] code')].some(node => node.textContent === 'C'))
  await chooseSource('暂存区')
  await page.getByRole('button', { name: /^partial.txt，/ }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.dshChanges__line[data-kind="+"] code')].some(node => node.textContent === 'B'))
  await writeFile(join(workspace, 'partial.txt'), 'D\n'); await git(workspace, ['add', '.'])
  await page.waitForFunction(() => [...document.querySelectorAll('.dshChanges__line[data-kind="+"] code')].some(node => node.textContent === 'D'), undefined, { timeout: 15000 })
  report.checks.push('automatic Git rediscovery, keyboard source switching, distinct partial-staging contents and visible Git polling')
  await checkCommitHistory({ page, workspace, root, sessionId, report, chooseSource })
  const second = await page.evaluate(async () => { const ctx = window.__CHANGES_SMOKE__, list = ctx.workspaces.list.getSnapshot(); const id = await ctx.sessions.create({ workspaceId: list.items[0].workspaceId }); await ctx.uiWorkspace.openSession(id); return id })
  await page.evaluate(() => window.__CHANGES_SMOKE__.sidebarRight.openTab('desktop-changes'))
  await page.locator('.dshChanges:visible').getByText('尚无已记录的文件更改').waitFor()
  assert.equal(await page.locator('.dshChanges:visible .dshChanges__file').count(), 0)
  await page.screenshot({ path: join(root, 'empty-session.png') })
  await page.evaluate(id => window.__CHANGES_SMOKE__.uiWorkspace.openSession(id), sessionId)
  await page.locator('.dshChanges:visible .dshChanges__detail').waitFor()
  assert.equal(await page.locator('.dshChanges:visible').getAttribute('data-source'), 'staged')
  report.checks.push('independent session has no inherited changes; original tab selection survives switching')
  if (errors.length) throw Error(errors.join('\n'))
  console.log(JSON.stringify({ root, checks: report.checks, measuredCombinations: report.measurements.length }, null, 2))
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0]
  if (failedPage) {
    report.failureUI = await failedPage.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 1000), menu: document.querySelector('.dshChanges__sourceMenu')?.outerHTML.slice(0, 2000) }))
    await failedPage.screenshot({ path: join(root, 'failure.png') })
  }
  report.error = error.stack; console.error(error); console.error(JSON.stringify(report.keyboardTrace)); process.exitCode = 1
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); await writeFile(join(root, 'host.log'), output)
  await browser?.close()
  if (child && child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} }
  console.log('Evidence: ' + root)
}

