/** Real Agent turns, tool execution, persistence/restart and cumulative UI. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { SnapshotStore } from '../dsh-plugin/sidebar-changes/host/snapshot-store.mjs'
import { absent, hash } from '../dsh-plugin/sidebar-changes/host/paths.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/session-changes-smoke-'))
const home = join(root, 'home'), workspace = join(root, 'workspace'), snapshots = join(root, 'changes'), probe = join(root, 'probe')
await Promise.all([home, workspace, probe].map(dir => mkdir(dir)))
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: off\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/session-changes-probe', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web', inject: ['@dsh-desktop/sidebar-changes'] } } }))
await writeFile(join(probe, 'index.js'), `export * from ${JSON.stringify(pathToFileURL(resolve('tools/session-changes-probe.mjs')).href)}\n`)
await writeFile(join(probe, 'client.js'), "window.__ModuleLoader__.load({id:'@dsh-desktop/session-changes-probe',factory:()=>({inject:['sessions','workspaces','uiWorkspace','sidebarRight','remote.desktopChanges'],apply(ctx){window.__SESSION_CHANGES__=ctx}})})")
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: session-changes-probe\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
await writeFile(join(root, 'patch.yml'), patch)
let child, browser, output = '', url
const report = { root, rounds: [], checks: [] }, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function start() {
  const offset = output.length
  child = spawn(process.execPath, [dshBin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--port', '0'], { cwd: workspace, windowsHide: true,
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_CHANGES_DIR: snapshots, DSH_SESSION_SMOKE_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  for (let i = 0; i < 400; i++) {
    url = output.slice(offset).match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) return
    if (child.exitCode !== null) throw Error(output.slice(offset))
    await sleep(100)
  }
  throw Error('Host start timeout: ' + output.slice(offset))
}
function stop() { if (child && child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} } }
async function command(request) {
  await writeFile(join(root, 'request.tmp'), JSON.stringify(request)); await rename(join(root, 'request.tmp'), join(root, 'request.json'))
  for (let i = 0; i < 600; i++) {
    try {
      const result = JSON.parse(await readFile(join(root, 'response.json'), 'utf8')); await unlink(join(root, 'response.json'))
      if (result.error) throw Error(result.error)
      return result
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    await sleep(100)
  }
  throw Error('Probe timed out: ' + output.slice(-8000))
}
try {
  await start()
  const { sessionId } = await command({ action: 'create', cwd: workspace }); report.sessionId = sessionId
  const run = async (round, name, args) => {
    const result = await command({ action: 'round', sessionId, round, tool: Array.isArray(name) ? name : { name, arguments: args } })
    report.rounds.push(result); assert.equal(result.agentId, sessionId); assert.equal(result.sessionId, sessionId); assert.equal(result.headerId, sessionId)
    assert.equal(result.turns, round); assert.deepEqual(result.errors, [])
    assert.ok(result.tools.length > 0 && result.tools.every(tool => !tool.message?.isError), JSON.stringify(result.tools))
  }
  await run(1, 'write', { file_path: join(workspace, 'a.txt'), content: '' })
  await run(2, 'write', { file_path: join(workspace, 'b.txt'), content: 'round two\n' })
  await command({ action: 'close', sessionId }); stop(); await start()
  assert.equal((await command({ action: 'resume', sessionId })).sessionId, sessionId)
  const shellPath = "'" + join(workspace, 'a.txt').replaceAll("'", "''") + "'"
  await run(3, 'pwsh', { command: `[System.IO.File]::WriteAllText(${shellPath}, "third round\u0060n")`, description: 'Write the isolated cumulative fixture', workdir: workspace })
  await run(4, [{ name: 'read', arguments: { file_path: join(workspace, 'a.txt') } }, { name: 'edit', arguments: { file_path: join(workspace, 'a.txt'), old_string: 'third', new_string: 'fourth' } }])
  await run(5, 'changes_smoke_background', {})
  let data
  for (let i = 0; i < 150; i++) {
    await sleep(100); data = await new SnapshotStore(snapshots).list({ sessionId, root: workspace })
    if (data.entries.some(entry => entry.path === 'background.txt') && !data.pendingCount) break
  }
  assert.equal(data.entries.length, 3, JSON.stringify(data.entries.map(entry => ({ path: entry.path, reason: entry.reason }))))
  assert.deepEqual(data.entries.find(entry => entry.path === 'a.txt').stats, { added: 1, removed: 0 })
  assert.equal(data.entries.find(entry => entry.path === 'a.txt').after.text, 'fourth round\n')
  assert.equal(data.entries.find(entry => entry.path === 'a.txt').attribution, 'observed')
  assert.equal(data.entries.find(entry => entry.path === 'background.txt').attribution, 'observed')
  report.checks.push('five real Agent turns, stable persistent identity across host restart, previous files retained, background process tail captured')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  await page.goto(url); await page.waitForFunction(() => Boolean(window.__SESSION_CHANGES__), undefined, { timeout: 40000 })
  await page.evaluate(workspace => window.__SESSION_CHANGES__.workspaces.create({ path: workspace }), workspace)
  await page.waitForFunction(id => window.__SESSION_CHANGES__.sessions.list.getSnapshot().ids.includes(id), sessionId)
  await page.evaluate(id => window.__SESSION_CHANGES__.uiWorkspace.openSession(id), sessionId)
  for (let i = 0; i < 8; i++) { await page.evaluate(() => { for (const button of document.querySelectorAll('button')) if (['继续', '稍后配置'].includes(button.textContent.trim())) button.click() }); await sleep(100) }
  await page.evaluate(() => window.__SESSION_CHANGES__.sidebarRight.openTab('desktop-changes'))
  await page.getByRole('button', { name: /^a.txt，/ }).click()
  await page.getByRole('button', { name: /查看操作历史/ }).click()
  await page.locator('[data-record-kind=operations]').waitFor()
  assert.equal(await page.locator('[data-record-kind=operations] .dshChanges__record').count(), 3)
  const realOperations = page.locator('[data-record-kind=operations]')
  assert.ok(await realOperations.getByText('新增', { exact: true }).count())
  const noTextOperation = realOperations.locator('.dshChanges__record').filter({ hasText: '无文本行变化' }).first()
  assert.ok(await noTextOperation.count())
  assert.equal(await noTextOperation.getByRole('button', { name: /^操作 \d+$/ }).count(), 0)
  assert.ok((await page.locator('.dshChanges__detail').innerText()).includes('fourth round'))
  await page.getByRole('button', { name: /^background.txt，/ }).click()
  await page.locator('.dshChanges__detail').filter({ hasText: 'background' }).waitFor()
  await page.locator('.dshChanges').screenshot({ path: join(root, 'cumulative.png') })
  report.checks.push('real cumulative UI shows one file per path, saved diff and all per-file operations')
  await page.getByRole('button', { name: '全部折叠', exact: true }).click()
  // Independent view fixtures exercise history pagination without conflating
  // fixture imports with the real tool/turn evidence above.
  const store = new SnapshotStore(snapshots), scope = { sessionId, root: workspace }
  const endpoint = text => text === null ? absent() : { exists: true, text, hash: hash(text), reason: null, mode: null }
  const record = (name, before, after) => store.finish(scope, crypto.randomUUID(), [{ path: name, author: sessionId, origin: 'structured', sequence: 0, before: endpoint(before), after: endpoint(after) }])
  const long = Array.from({ length: 1001 }, (_, index) => `history line ${index}\n`).join('')
  await record('history.txt', null, long)
  for (let i = 1; i <= 21; i++) await record('history.txt', i === 1 ? long : `version ${i - 1}\n`, `version ${i}\n`)
  await record('segments.txt', 'before one', 'after one'); await record('segments.txt', 'external two', 'after two')
  await record('restored.txt', 'original', 'temporary'); await record('restored.txt', 'temporary', 'original')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('button', { name: /^history.txt，/ }).click()
  await page.getByRole('button', { name: '查看操作历史（22）', exact: true }).click()
  const records = page.locator('[data-record-kind=operations]')
  await records.getByRole('button', { name: '加载更多记录（20/22）', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-record-kind=operations] .dshChanges__record').length === 22)
  const longRecord = records.locator('.dshChanges__record').filter({ hasText: '+1001' }).first()
  await longRecord.getByRole('button', { name: /^操作 \d+$/ }).click()
  const moreRows = records.getByRole('button', { name: '加载更多片段行', exact: true })
  await moreRows.click(); await page.waitForFunction(() => document.querySelectorAll('.dshChanges__recordDiff .dshChanges__line').length === 800)
  await moreRows.click(); await moreRows.waitFor({ state: 'detached' })
  assert.equal(await records.locator('.dshChanges__line').count(), 1001)
  await page.getByRole('button', { name: '全部折叠', exact: true }).click()
  await page.getByRole('button', { name: /^segments.txt，/ }).click()
  await page.locator('[data-record-kind=segments]').getByText('after two', { exact: true }).waitFor()
  assert.ok((await page.locator('[data-record-kind=segments]').innerText()).includes('before one'))
  await page.getByRole('button', { name: '查看已恢复原状（1）', exact: true }).click()
  await page.getByRole('button', { name: /^restored.txt，/ }).waitFor()
  for (const dark of [false, true]) {
    await page.evaluate(dark => {
      document.body.toggleAttribute('data-ds-dark-theme', dark)
      const panel = document.querySelector('.dshChanges'); panel.style.width = '320px'
    }, dark)
    assert.equal(await page.locator('.dshChanges').evaluate(panel => panel.scrollWidth <= panel.clientWidth), true)
    await page.locator('.dshChanges').screenshot({ path: join(root, `segments-${dark ? 'dark' : 'light'}.png`) })
  }
  report.checks.push('UI fixtures: 22 operations, 1001 paged rows, directly readable segments, restored-file disclosure, narrow light/dark layouts')
  const child = await command({ action: 'create', cwd: workspace, parentSessionId: sessionId })
  const childRound = await command({ action: 'round', sessionId: child.sessionId, round: 1, tool: { name: 'write', arguments: { file_path: join(workspace, 'child.txt'), content: 'owned child\n' } } })
  assert.ok(childRound.tools.length && childRound.tools.every(tool => !tool.message?.isError))
  const owned = (await store.list(scope)).entries.find(entry => entry.path === 'child.txt')
  assert.equal(owned.operations[0].author, child.sessionId)
  const independent = await command({ action: 'create', cwd: workspace })
  assert.equal((await store.list({ ...scope, sessionId: independent.sessionId })).entries.length, 0)
  await command({ action: 'close', sessionId: child.sessionId }); await command({ action: 'close', sessionId: independent.sessionId })
  report.checks.push('real parent/child ownership aggregates the child author; independent session in the same directory stays empty')
  await command({ action: 'close', sessionId })
  console.log(JSON.stringify({ root, sessionId, checks: report.checks }, null, 2))
} catch (error) { report.error = error.stack; console.error(error); process.exitCode = 1 }
finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); await writeFile(join(root, 'host.log'), output)
  await browser?.close(); stop(); console.log('Evidence: ' + root)
}
