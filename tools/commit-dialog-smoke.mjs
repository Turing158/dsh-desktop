/** Real isolated DSH host, Remote protocol and production dialog. No user repository or model calls. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { git } from '../dsh-plugin/sidebar-changes/host/git-provider.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/commit-dialog-smoke-'))
const home = join(root, 'home'), probe = join(root, 'probe'), workspace = join(root, 'workspace'), remote = join(root, 'remote.git')
await Promise.all([home, probe, workspace, remote].map(dir => mkdir(dir)))
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: on\n')
await git(workspace, ['init', '-b', 'main'])
for (const [key, value] of [['user.email', 'smoke@example.invalid'], ['user.name', 'Smoke'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) await git(workspace, ['config', key, value])
await writeFile(join(workspace, 'code.txt'), 'before\n'); await writeFile(join(workspace, 'large-before.txt'), 'old\n'.repeat(12000))
await git(workspace, ['add', '.']); await git(workspace, ['commit', '-m', 'initial'])
await writeFile(join(workspace, 'code.txt'), 'staged\n'); await git(workspace, ['add', '.']); await writeFile(join(workspace, 'code.txt'), 'working\nsecond\n')
const longBranch = 'feature/very-long-branch-name-for-narrow-window-中文-1234567890'
await git(workspace, ['branch', longBranch]); await git(remote, ['init', '--bare', '-b', 'main']); await git(workspace, ['remote', 'add', 'origin', remote])
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/commit-smoke', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar-right', '@dsh-desktop/sidebar-changes'] } } }))
await writeFile(join(probe, 'index.js'), `import { runtimeImport } from ${JSON.stringify(pathToFileURL(resolve('dsh-plugin/runtime-import.mjs')).href)}
import { existsSync } from 'node:fs'
export const inject = ['llm', 'agentDefaultModel']
export async function apply(ctx) {
  const { LlmAdapter } = await runtimeImport('@deepseek-ai/dsh-llm')
  class Adapter extends LlmAdapter { async *stream(options) {
    if (options.tools?.length) throw Error('No tools permitted')
    if (existsSync(${JSON.stringify(join(root, 'generation-fail'))})) throw Error('Controlled generation failure')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    const text = 'feat: 更新候选内容\\n\\n保留中文多行提交说明'
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  ctx.llm.registerAdapter(['commit-smoke'], new Adapter())
}\n`)
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/commit-smoke',factory:()=>({inject:['sessions','workspaces','uiWorkspace','sidebarRight','remote','remote.desktopChanges'],apply(ctx){window.__COMMIT_SMOKE__=ctx}})})`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- id: agent-default-model\n  config:\n    provider: commit-smoke\n    model: fixture\n- insert:\n    - id: commit-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
await writeFile(join(root, 'patch.yml'), patch)
let child, browser, output = ''
const report = { root, checks: [], measurements: [] }, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const readGit = async args => (await git(workspace, args)).toString().trim()
try {
  child = spawn(process.execPath, [dshBin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--port', '0'], { cwd: workspace, windowsHide: true,
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_CHANGES_DIR: join(root, 'snapshots') }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  let url
  for (let i = 0; i < 400; i++) { url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]; if (url) break; if (child.exitCode !== null) throw Error(output); await sleep(100) }
  if (!url) throw Error(output)
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }), errors = []
  page.setDefaultTimeout(45000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url); await page.waitForFunction(() => Boolean(window.__COMMIT_SMOKE__))
  const sessionId = await page.evaluate(async workspace => {
    const ctx = window.__COMMIT_SMOKE__, work = await ctx.workspaces.create({ path: workspace })
    const id = await ctx.sessions.create({ workspaceId: work.workspaceId }); await ctx.uiWorkspace.openSession(id); return id
  }, workspace)
  for (let i = 0; i < 5; i++) { await page.evaluate(() => { for (const button of document.querySelectorAll('button')) if (['继续', '稍后配置'].includes(button.textContent.trim())) button.click() }); await sleep(150) }
  let releaseContext, releaseBranches
  const contextGate = new Promise(resolve => { releaseContext = resolve }), branchGate = new Promise(resolve => { releaseBranches = resolve })
  const delayedContext = async route => { await contextGate; await route.continue() }
  const delayedBranches = async route => { await branchGate; await route.continue() }
  const contextRoute = '**/api/desktopChanges/getGitContext*', branchRoute = '**/api/desktopChanges/listGitBranches*'
  await page.route(contextRoute, delayedContext); await page.route(branchRoute, delayedBranches)
  await page.evaluate(() => window.__COMMIT_SMOKE__.sidebarRight.openTab('desktop-changes'))
  await page.locator('.dshChanges__gitPrimary').waitFor()
  const dialog = page.getByRole('dialog', { name: '提交与推送' }), input = dialog.getByRole('textbox', { name: '提交信息', exact: true })
  const button = name => dialog.getByRole('button', { name, exact: true })
  const ready = () => page.waitForFunction(() => document.querySelector('.dshChanges__gitBranch')?.disabled === false
    && document.querySelector('.dshChanges__gitTop')?.getAttribute('aria-busy') === 'false')
  const open = async () => { await page.locator('.dshChanges__gitPrimary').click(); await dialog.waitFor(); await ready() }
  await page.locator('.dshChanges__gitPrimary').click(); await dialog.waitFor({ timeout: 1500 })
  const branchButton = dialog.locator('.dshChanges__gitBranch'), branchMenu = page.locator('.dshChanges__gitBranchMenu')
  assert.equal(await branchButton.innerText(), '加载中…')
  assert.equal(await branchButton.getAttribute('aria-busy'), 'true')
  await branchButton.click(); await branchMenu.getByRole('status').waitFor({ timeout: 1500 })
  assert.equal(await branchMenu.getByRole('status').innerText(), '加载中…')
  const spinner = branchMenu.locator('svg[data-state="ongoing"] > [class*="_spinnerMotion_"]')
  const animation = await spinner.evaluate(node => {
    const style = getComputedStyle(node)
    return { name: style.animationName, duration: style.animationDuration, running: node.getAnimations().some(animation => animation.playState === 'running') }
  })
  assert.equal(animation.name, 'dsh-desktop-loading-spin')
  assert.notEqual(animation.duration, '0s')
  assert.equal(animation.running, true, 'pending menu uses the project animated loading indicator')
  const transform = await spinner.evaluate(node => getComputedStyle(node).transform)
  await page.waitForFunction(previous => {
    const node = document.querySelector('.dshChanges__gitBranchMenu svg[data-state="ongoing"] > [class*="_spinnerMotion_"]')
    return node && getComputedStyle(node).transform !== previous
  }, transform, { timeout: 1500 })
  await page.screenshot({ path: join(root, 'branches-loading.png') })
  await page.keyboard.press('Escape'); await branchMenu.waitFor({ state: 'detached', timeout: 1500 })
  assert.equal(await dialog.isVisible(), true)
  releaseBranches()
  await page.waitForFunction(() => document.querySelector('.dshChanges__gitBranchName')?.textContent === 'main')
  assert.equal(await dialog.locator('.dshChanges__gitStatsLoading').innerText(), '加载中…', 'branch name does not wait for the commit snapshot')
  assert.equal(await branchMenu.count(), 0, 'a late response must not reopen a closed menu')
  await branchButton.click(); await branchMenu.getByRole('menuitem', { name: longBranch, exact: true }).waitFor()
  assert.equal(await branchMenu.getByRole('status').count(), 0, 'loaded branches never display the commit snapshot loading state')
  assert.equal(await branchMenu.getByRole('menuitem', { name: longBranch, exact: true }).isEnabled(), true)
  assert.equal(await branchButton.locator('svg[data-state="ongoing"]').count(), 0, 'background branch refresh retains the branch icon')
  await page.screenshot({ path: join(root, 'branches-ready-context-pending.png') })
  await page.keyboard.press('Escape'); await input.fill('feat: 等待校验时输入')
  releaseContext(); await ready()
  assert.equal(await input.inputValue(), 'feat: 等待校验时输入', 'completing a background snapshot does not overwrite typing')
  await page.unroute(contextRoute, delayedContext); await page.unroute(branchRoute, delayedBranches)
  report.checks.push('initial branch loading remains animated; loaded branches and draft editing work while the commit snapshot is delayed; no redundant menu spinner or draft overwrite')

  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
  const changeView = async name => {
    await page.getByRole('button', { name: '更改范围', exact: true }).click()
    await page.getByRole('menuitem', { name, exact: true }).click()
    await page.locator('.dshChanges__gitPrimary').waitFor()
  }
  await changeView('暂存区')
  await page.locator('.dshChanges[data-source="staged"] .dshChanges__summary').waitFor()
  let releasePreview
  const previewGate = new Promise(resolve => { releasePreview = resolve })
  const delayPreview = async route => { await previewGate; await route.continue() }
  await page.route(contextRoute, delayPreview)
  await page.locator('.dshChanges__gitPrimary').click(); await dialog.waitFor({ timeout: 1500 })
  assert.equal(await dialog.locator('.dshChanges__gitStats').innerText(), '+1\n-1', 'staged list totals appear before the commit request completes')
  assert.equal(await dialog.locator('.dshChanges__gitStatsLoading').count(), 0)
  assert.equal(await button('提交').isDisabled(), true, 'displayed list totals never authorize a write')
  await dialog.getByRole('checkbox').check()
  await dialog.locator('.dshChanges__gitStatsLoading').waitFor({ timeout: 1500 })
  assert.equal(await dialog.locator('.dshChanges__gitStats').count(), 0, 'staged totals must not be reused for the working tree')
  await dialog.getByRole('checkbox').uncheck()
  assert.equal(await dialog.locator('.dshChanges__gitStats').innerText(), '+1\n-1')
  await page.screenshot({ path: join(root, 'staged-stats-reused.png') })
  releasePreview(); await ready(); await page.unroute(contextRoute, delayPreview)
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
  await changeView('未提交')
  await page.locator('.dshChanges[data-source="working"] .dshChanges__summary').waitFor()
  let releaseWorking
  const workingGate = new Promise(resolve => { releaseWorking = resolve })
  const delayWorking = async route => { await workingGate; await route.continue() }
  await page.route(contextRoute, delayWorking)
  await page.getByRole('button', { name: '更多 Git 操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '提交', exact: true }).click(); await dialog.waitFor({ timeout: 1500 })
  assert.equal(await dialog.locator('.dshChanges__gitStats').innerText(), '+2\n-1', 'working list totals appear without a second foreground load')
  releaseWorking(); await ready(); await page.unroute(contextRoute, delayWorking)
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
  await changeView('当前会话'); await open()
  let releaseRefresh
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve })
  const delayRefresh = async route => { await refreshGate; await route.continue() }
  await page.route(contextRoute, delayRefresh)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(() => document.querySelector('.dshChanges__gitStats')?.getAttribute('aria-busy') === 'true')
  assert.equal(await dialog.locator('.dshChanges__gitStats').innerText(), '+2\n-1', 'background refresh retains the previous validated preview')
  await input.fill('feat: 后台刷新时输入')
  releaseRefresh(); await ready(); await page.unroute(contextRoute, delayRefresh)
  assert.equal(await input.inputValue(), 'feat: 后台刷新时输入')
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
  let releaseReopen
  const reopenGate = new Promise(resolve => { releaseReopen = resolve })
  const delayReopen = async route => { await reopenGate; await route.continue() }
  await page.route(contextRoute, delayReopen)
  await page.locator('.dshChanges__gitPrimary').click(); await dialog.waitFor({ timeout: 1500 })
  assert.equal(await dialog.locator('.dshChanges__gitStats').innerText(), '+2\n-1', 'reopening reuses the previous preview while it is checked')
  assert.equal(await input.inputValue(), 'feat: 后台刷新时输入')
  releaseReopen(); await ready(); await page.unroute(contextRoute, delayReopen)
  report.checks.push('working and staged totals reuse the loaded changes list; ranges stay separate; refresh retains preview and typing; writes remain blocked until validation')
  let branchFailures = 0
  const failBranchesOnce = route => ++branchFailures === 1 ? route.abort('failed') : route.continue()
  await page.route(branchRoute, failBranchesOnce)
  await branchButton.click(); await branchMenu.getByRole('alert').waitFor()
  await branchMenu.getByRole('menuitem', { name: '重试', exact: true }).click()
  await branchMenu.getByRole('menuitem', { name: 'main', exact: true }).waitFor()
  await page.keyboard.press('Escape'); await page.unroute(branchRoute, failBranchesOnce)
  report.checks.push('branch request failure stays inside the open menu and retry restores the list')
  assert.equal(await dialog.getByRole('checkbox').isChecked(), true)
  assert.equal(await input.getAttribute('placeholder'), '提交信息（可留空）')
  assert.equal(await dialog.locator('.dshChanges__gitStats').innerText(), '+2\n-1')
  const index = await readGit(['show', ':code.txt'])
  await dialog.getByRole('checkbox').uncheck(); await ready()
  assert.equal(await dialog.locator('.dshChanges__gitStats').innerText(), '+1\n-1')
  assert.equal(await readGit(['show', ':code.txt']), index)
  await input.fill('feat: 手动草稿\n\n中文第二行'); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
  assert.equal(await page.locator('.dshChanges__gitPrimary').evaluate(node => node === document.activeElement), true)
  await open(); assert.equal(await input.inputValue(), 'feat: 手动草稿\n\n中文第二行')
  await dialog.locator('.dshChanges__gitBranch').click(); await page.getByRole('menuitem', { name: longBranch, exact: true }).click(); await ready()
  assert.equal(await readGit(['branch', '--show-current']), longBranch); assert.equal(await input.inputValue(), '')
  await dialog.locator('.dshChanges__gitBranch').focus(); await page.keyboard.press('ArrowDown'); await page.getByRole('menuitem', { name: 'main', exact: true }).waitFor()
  await page.keyboard.press('Home'); await page.keyboard.press('End'); await page.keyboard.press('Escape')
  assert.equal(await dialog.isVisible(), true)
  report.checks.push('real candidate stats, checkbox reads only, retained multilingual drafts, real branch switching, menu keys and focus restoration')
  await unlink(join(workspace, 'large-before.txt')); await writeFile(join(workspace, 'large-after.txt'), 'new\n'.repeat(12000))
  await page.evaluate(() => window.dispatchEvent(new Event('dsh-desktop:git-changed')))
  await page.waitForFunction(() => document.querySelector('.dshChanges__gitStats')?.textContent === '+12002-12001')
  for (const dark of [false, true]) for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 850 })
    await page.evaluate(dark => { document.documentElement.setAttribute('data-dsh-ui', 'desktop'); document.body.toggleAttribute('data-ds-dark-theme', dark) }, dark)
    await input.focus()
    const measurement = await dialog.evaluate(node => {
      const input = node.querySelector('textarea'), style = getComputedStyle(input), row = node.querySelector('.dshChanges__gitTop')
      const boxes = [...row.children].map(child => child.getBoundingClientRect())
      return { width: node.clientWidth, scrollWidth: node.scrollWidth, heights: [...node.querySelectorAll('.dshChanges__gitSubmit')].map(button => button.getBoundingClientRect().height),
        input: { border: style.borderTopWidth, outline: style.outlineStyle, shadow: style.boxShadow }, checkbox: getComputedStyle(node.querySelector('input[type=checkbox]')).width,
        overlap: boxes.some((box, i) => i && box.left < boxes[i - 1].right - 1) }
    })
    assert.ok(measurement.scrollWidth <= measurement.width + 1, JSON.stringify(measurement)); assert.equal(measurement.overlap, false)
    assert.deepEqual(measurement.heights, [28, 28, 28]); assert.equal(measurement.checkbox, '18px')
    assert.deepEqual(measurement.input, { border: '0px', outline: 'none', shadow: 'none' })
    report.measurements.push({ dark, viewportWidth: width, ...measurement })
    await dialog.screenshot({ path: join(root, `dialog-${dark ? 'dark' : 'light'}-${width}.png`) })
  }
  report.checks.push('light/dark at 320, 375, 1280px; 28px buttons, themed 18px checkbox, no input focus border, no overflow')
  await unlink(join(workspace, 'large-after.txt')); await git(workspace, ['restore', '--worktree', '--', 'large-before.txt'])
  await page.evaluate(() => window.dispatchEvent(new Event('dsh-desktop:git-changed')))
  await page.waitForFunction(() => document.querySelector('.dshChanges__gitStats')?.textContent === '+2-1')
  await page.setViewportSize({ width: 1280, height: 850 })
  await input.fill('')
  await input.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })))
  assert.equal(await readGit(['rev-list', '--count', 'HEAD']), '1')
  await writeFile(join(root, 'generation-fail'), '')
  await button('提交').click(); await dialog.getByRole('alert').waitFor()
  assert.equal(await readGit(['rev-list', '--count', 'HEAD']), '1'); assert.equal(await readGit(['show', ':code.txt']), index)
  await unlink(join(root, 'generation-fail')); await ready()
  await input.press('Control+Enter'); await button('完成').waitFor()
  assert.equal(await readGit(['log', '-1', '--format=%B']), 'feat: 更新候选内容\n\n保留中文多行提交说明')
  assert.equal(await readGit(['show', 'HEAD:code.txt']), 'working\nsecond')
  await button('完成').click(); await open()
  assert.equal(await input.inputValue(), '', 'a completed commit clears its saved draft before the next commit')
  const head = await readGit(['rev-parse', 'HEAD'])
  await button('推送').click(); await button('完成').waitFor()
  assert.equal(await readGit(['rev-parse', 'HEAD']), head)
  assert.equal((await git(remote, ['rev-parse', `refs/heads/${longBranch}`])).toString().trim(), head)
  await button('完成').click()
  report.checks.push('IME suppression, controlled model failure without writes, real configured LLM adapter generation, commit shortcut and pure push without another commit')
  await writeFile(join(workspace, 'code.txt'), 'push with commit\n')
  await git(remote, ['config', 'core.hooksPath', join(remote, 'hooks')])
  await writeFile(join(remote, 'hooks/pre-receive'), '#!/bin/sh\necho "controlled push refusal" >&2\nexit 1\n', { mode: 0o755 })
  await open(); await input.fill('fix: 保存后重试推送')
  await input.press('Control+Shift+Enter'); await button('重试推送').waitFor()
  const savedHead = await readGit(['rev-parse', 'HEAD'])
  assert.equal(await readGit(['rev-list', '--count', 'HEAD']), '3')
  assert.ok((await dialog.getByRole('alert').innerText()).includes('提交已保存 · 推送失败'))
  await writeFile(join(workspace, 'later.txt'), 'do not stage\n'); await unlink(join(remote, 'hooks/pre-receive'))
  await button('重试推送').click(); await button('完成').waitFor()
  assert.equal(await readGit(['rev-parse', 'HEAD']), savedHead); assert.equal(await readGit(['ls-files', '--', 'later.txt']), '')
  await button('完成').click()
  report.checks.push('commit-and-push shortcut retains refused commit and retries only push without staging later edits')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.error = error.stack; console.error(error); process.exitCode = 1
  const page = browser?.contexts()[0]?.pages()[0]
  if (page) { await page.screenshot({ path: join(root, 'failure.png') }); report.failureUI = await page.locator('body').innerText() }
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); await writeFile(join(root, 'host.log'), output)
  await browser?.close()
  if (child && child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} }
  console.log('Evidence: ' + root)
}
