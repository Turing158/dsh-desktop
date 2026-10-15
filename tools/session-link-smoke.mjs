/** Real DSH admission, persisted-session reads and browser navigation; no network model. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

export const inject = ['agents', 'llm', 'sessions', 'sessionPersistence', 'sessionQuery', 'sessionReferenceResolver']
export function apply(ctx) {
  const root = process.env.DSH_SESSION_LINK_SMOKE
  if (!root) throw Error('An isolated smoke directory is required')
  const timer = setTimeout(async () => {
    const result = {}
    try {
      const { runtimeImport } = await import('../dsh-plugin/runtime-import.mjs')
      const { LlmAdapter, createUserMessage } = await runtimeImport('@deepseek-ai/dsh-llm')
      const requests = []
      class Scripted extends LlmAdapter {
        async *stream(options) {
          requests.push(structuredClone(options.messages))
          const text = 'SOURCE_ANSWER: 蓝色方案，端口 4317。'
            + (JSON.stringify(options.messages).includes('## Referenced sessions') ? '\n\n原会话：deepseekharness://session/link-source' : '')
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      ctx.llm.registerAdapter(['session-link-smoke'], new Scripted())
      const create = id => ctx.agents.create({ sessionId: id, meta: { cwd: root }, agentOptions: { provider: 'session-link-smoke', model: 'scripted' } })
      const send = async (handle, text) => {
        handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
        await handle.agent.whenIdle()
        await ctx.sessions.flush(handle.agent.session)
      }
      const source = await create('session-link-source')
      await send(source, 'SOURCE_QUESTION: 选择什么方案和端口？')
      await source.dispose()
      assert.equal(ctx.sessions.get('session-link-source'), undefined)
      const target = await create('session-link-target')
      const link = 'deepseekharness://session/link-source'
      await send(target, `读取并总结 ${link}，也可打开 [原会话](${link})。`)
      const modelInput = JSON.stringify(requests.find(messages => JSON.stringify(messages).includes('## Referenced sessions')))
      await writeFile(join(root, 'requests.json'), JSON.stringify(requests, null, 2))
      assert.ok(modelInput, 'a real model request must contain the referenced snapshot')
      assert.match(modelInput, /SOURCE_QUESTION/)
      assert.match(modelInput, /SOURCE_ANSWER/)
      assert.match(modelInput, /untrusted, read-only/)
      const log = await ctx.sessionQuery.readSession(target.agent.id)
      const references = log.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'session-reference')
      assert.equal(references.length, 1)
      assert.equal(references[0].data.source.references.length, 1)
      assert.ok(log.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.data.content[0].text.includes(link)))
      Object.assign(result, { source: 'session-link-source', target: target.agent.id, link,
        checks: ['real model request includes the persisted source conversation', 'duplicate links produce one durable snapshot', 'the original URL remains in the message'] })
    } catch (error) { result.error = error.stack }
    await writeFile(join(root, 'probe-result.json'), JSON.stringify(result, null, 2))
  }, 100)
  ctx.effect(() => () => clearTimeout(timer))
}

async function main() {
  const bin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
  const root = await mkdtemp(resolve('src-tauri/target/session-link-smoke-'))
  const home = join(root, 'home'), probe = join(root, 'probe')
  await Promise.all([mkdir(home), mkdir(probe)])
  await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/session-link-smoke', type: 'module', main: 'index.js',
    exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
  await writeFile(join(probe, 'index.js'), `export * from ${JSON.stringify(import.meta.url)}`)
  await writeFile(join(probe, 'client.js'), "window.__ModuleLoader__.load({id:'@dsh-desktop/session-link-smoke',factory:()=>({inject:['sessions','uiWorkspace'],apply(ctx){window.__SESSION_LINK_SMOKE__=ctx}})})")
  const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
    + '\n- insert:\n    - id: session-link-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
  await writeFile(join(root, 'patch.yml'), patch)
  const child = spawn(process.execPath, [bin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--port', '0'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: bin, DSH_SESSION_LINK_SMOKE: root },
  })
  let output = '', browser, page, report = { root, browserErrors: [] }
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  try {
    let result, url
    for (let i = 0; i < 600; i++) {
      url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
      try { result = JSON.parse(await readFile(join(root, 'probe-result.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (result?.error) throw Error(result.error)
      if (result && url) break
      if (child.exitCode !== null) throw Error(output)
      await sleep(100)
    }
    assert.ok(result && url, 'DSH startup/probe timed out: ' + output.slice(-5000))
    Object.assign(report, result)
    const require = createRequire(import.meta.url)
    const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
    page.on('pageerror', error => report.browserErrors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()) })
    page.on('response', response => { if (response.status() >= 400) report.browserErrors.push(response.status() + ' ' + response.url()) })
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__SESSION_LINK_SMOKE__?.sessions.list.getSnapshot().phase === 'ready')
    for (const name of ['继续', '我知道了', '稍后配置']) {
      await page.addLocatorHandler(page.getByRole('button', { name, exact: true }), button => button.click())
    }
    await page.evaluate(id => window.__SESSION_LINK_SMOKE__.uiWorkspace.openSession(id), result.target)
    const message = page.locator('[data-dsh-session-message="user"]')
    const links = message.locator('a[data-dsh-session-link]')
    const link = links.first()
    await link.waitFor()
    assert.equal(await links.count(), 2)
    assert.equal(await link.getAttribute('href'), result.link)
    assert.equal(await link.textContent(), result.link)
    assert.equal(await page.locator('[data-dsh-session-links]').count(), 0)
    assert.equal(await page.getByText(/^引用会话 ·|^Referenced session ·/).count(), 0)
    assert.equal(await page.locator('[data-dsh-session-message="assistant-step"] a[data-dsh-session-link]').count(), 1)
    await page.screenshot({ path: join(root, 'links.png') })
    await link.focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => {
      const state = window.__SESSION_LINK_SMOKE__.sessions.list.getSnapshot()
      return state.current === id || state.byId[id]?.retainedBy?.mainView > 0
    }, result.source)
    await page.locator('p').filter({ hasText: 'SOURCE_ANSWER: 蓝色方案，端口 4317。' }).waitFor()
    await page.screenshot({ path: join(root, 'opened.png') })
    report.checks.push('the original URLs are inline links, with no extra button or reference summary',
      'Enter on the original message link opens the source session and displays its contents')
    await page.evaluate(id => window.__SESSION_LINK_SMOKE__.uiWorkspace.openSession(id), result.target)
    await link.waitFor()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await link.waitFor()
    assert.equal(await links.count(), 2, 'reopening and reloading do not duplicate links')
    await links.nth(1).click()
    await page.waitForFunction(id => window.__SESSION_LINK_SMOKE__.sessions.list.getSnapshot().byId[id]?.retainedBy?.mainView > 0, result.source)
    assert.ok(!report.browserErrors.some(error => /slot entry crashed|NotFoundError|removeChild|TypeError/.test(error)), report.browserErrors.join('\n'))
    report.checks.push('clicking a second inline URL works after reopening and reloading')
    const { build } = await import('esbuild')
    const inlineBundle = await build({ entryPoints: [resolve('dsh-plugin/session-links/inline.mjs')], bundle: true,
      format: 'iife', globalName: 'SessionLinksSmoke', write: false })
    await page.addScriptTag({ content: inlineBundle.outputFiles[0].text })
    const lifecycle = await page.evaluate(async link => {
      const root = document.createElement('div'), text = document.createTextNode('before ' + link)
      const suffix = document.createElement('strong'), button = document.createElement('button')
      suffix.textContent = ' suffix'; button.textContent = 'button ' + link
      root.append(text, suffix, button); document.body.append(root)
      const opened = [], checks = []
      const dispose = window.SessionLinksSmoke.mountInlineSessionLinks(root, [{ label: link, sessionId: 'session-link-source' }], url => opened.push(url))
      const tick = () => new Promise(resolve => setTimeout(resolve, 0))
      try {
        checks.push(root.querySelectorAll('a').length === 1 && text.parentNode === root)
        root.querySelector('a').click()
        text.data = 'updated ' + link + '，deepseekharness://session/session-link-source'
        await tick()
        checks.push(root.querySelectorAll('a').length === 2 && root.textContent === text.data + link + '，deepseekharness://session/session-link-source suffixbutton ' + link)
        // A native update can equal the prefix we kept in the original node.
        text.data = 'updated '
        await tick()
        checks.push(root.querySelectorAll('a').length === 0 && root.textContent === 'updated  suffixbutton ' + link)
        text.remove()
        root.insertBefore(document.createTextNode(link), suffix)
        await tick()
        checks.push(root.querySelectorAll('a').length === 1 && button.querySelector('a') === null)
        dispose()
        checks.push(root.querySelectorAll('a').length === 0 && root.textContent === link + ' suffixbutton ' + link)
        return { checks, opened }
      } finally { dispose(); root.remove() }
    }, result.link)
    assert.ok(lifecycle.checks.every(Boolean), JSON.stringify(lifecycle))
    assert.deepEqual(lifecycle.opened, [result.link])
    report.checks.push('native text updates, node replacement and disposal preserve text without stale links')
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    report.error = error.stack
    if (page) {
      report.page = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 8000),
        probe: Boolean(window.__SESSION_LINK_SMOKE__),
        list: window.__SESSION_LINK_SMOKE__?.sessions.list.getSnapshot(),
      })).catch(failure => ({ error: failure.message }))
      await page.screenshot({ path: join(root, 'failure.png'), timeout: 5000 }).catch(() => {})
    }
    throw error
  }
  finally {
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
    await writeFile(join(root, 'host.log'), output)
    await browser?.close()
    if (child.exitCode === null) {
      if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} }
      else child.kill()
    }
    console.log('Evidence: ' + root)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
