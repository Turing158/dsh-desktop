/** Complete desktop plugin stack + native DSH chat, isolated profile, scripted
 * model only. Produces browser work counters and a CPU profile, never uses keys.
 * DSH_DESKTOP_DSH_BIN / PLAYWRIGHT_PATH select installed test dependencies.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

export const inject = ['agents', 'llm', 'sessions']
export async function apply(ctx) {
  const root = process.env.DSH_LONG_TASK_SMOKE
  if (!root) throw Error('An isolated smoke directory is required')
  const { runtimeImport } = await import('../dsh-plugin/runtime-import.mjs')
  const { LlmAdapter, createUserMessage } = await runtimeImport('@deepseek-ai/dsh-llm')
  const fsTools = await runtimeImport('@deepseek-ai/dsh-tool-fs')
  let remaining = 0, delay = 0, sequence = 0, busy = false
  class Scripted extends LlmAdapter {
    async *stream() {
      const text = `Step ${sequence++}: inspect the implementation and verify the result.\n\n`
        + '```typescript\n' + 'const result = input.map(value => value + 1)\n'.repeat(12) + '```\n'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (let offset = 0; offset < text.length; offset += 80) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay))
        yield { type: 'text-delta', index: 0, text: text.slice(offset, offset + 80) }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      const tool = remaining-- > 0
      if (tool) {
        const block = { type: 'tool-call', id: crypto.randomUUID(), name: 'read', arguments: JSON.stringify({ file_path: join(root, 'workspace', 'sample.txt') }) }
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 1, id: block.id, name: block.name, argumentsDelta: block.arguments }
        yield { type: 'block-end', index: 1, block }
      }
      yield { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['long-task-smoke'], new Scripted())
  const handle = await ctx.agents.create({ sessionId: 'session-long-task-performance', meta: { cwd: join(root, 'workspace') },
    agentOptions: { provider: 'long-task-smoke', model: 'scripted' },
    setup: async agentCtx => { await agentCtx.plugin(fsTools, {}).await() } })
  await writeFile(join(root, 'ready.json'), JSON.stringify({ sessionId: handle.agent.id }))
  const timer = setInterval(async () => {
    if (busy) return
    let request
    try { request = JSON.parse(await readFile(join(root, 'request.json'), 'utf8')) } catch { return }
    busy = true
    await unlink(join(root, 'request.json'))
    try {
      remaining = request.steps; delay = request.delay || 0
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the isolated long-task performance fixture.' }] }))
      await handle.agent.whenIdle()
      await ctx.sessions.flush(handle.agent.session)
      await writeFile(join(root, 'result.json'), JSON.stringify({ sequence }))
    } catch (error) { await writeFile(join(root, 'result.json'), JSON.stringify({ error: error.stack })) }
    finally { busy = false }
  }, 50)
  ctx.effect(() => () => clearInterval(timer))
}

async function main() {
  const root = await mkdtemp(resolve('src-tauri/target/long-task-perf-'))
  const bin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
  const home = join(root, 'home'), probe = join(root, 'probe')
  await Promise.all([mkdir(home), mkdir(probe), mkdir(join(root, 'workspace'))])
  await writeFile(join(root, 'workspace', 'sample.txt'), 'isolated read fixture\n'.repeat(50))
  await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/long-task-smoke', type: 'module', main: 'index.js',
    exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
  await writeFile(join(probe, 'index.js'), `export * from ${JSON.stringify(import.meta.url)}`)
  await writeFile(join(probe, 'client.js'), "window.__ModuleLoader__.load({id:'@dsh-desktop/long-task-smoke',factory:()=>({inject:['sessions','uiWorkspace'],apply(ctx){window.__LONG_TASK_SMOKE__=ctx}})})")
  const patchFile = process.env.PERF_PATCH || 'dsh-plugin/desktop-notify.patch.yml'
  const patch = (process.env.PERF_NATIVE ? '' : (await readFile(patchFile, 'utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href))
    + '\n- insert:\n    - id: long-task-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
  await writeFile(join(root, 'patch.yml'), patch)
  const child = spawn(process.execPath, [bin, 'web', '--patch', join(root, 'patch.yml'), '--no-open', '--port', '0'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: bin, DSH_LONG_TASK_SMOKE: root,
      DSH_DESKTOP_CHANGES_DIR: join(root, 'changes') },
  })
  let output = '', browser, page
  const report = { root, checks: [], samples: [], errors: [], resourceErrors: [] }
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function waitFile(file) {
    for (let i = 0; i < 1800; i++) {
      try {
        const value = JSON.parse(await readFile(join(root, file), 'utf8'))
        if (value.error) throw Error(value.error)
        return value
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
      if (child.exitCode !== null) throw Error(output.slice(-4000))
      await sleep(100)
    }
    throw Error('Timed out: ' + file + '\n' + output.slice(-4000))
  }
  async function run(steps, delay = 0, settle = true) {
    await unlink(join(root, 'result.json')).catch(() => {})
    await writeFile(join(root, 'request.json'), JSON.stringify({ steps, delay }))
    const result = await waitFile('result.json')
    if (page && settle) {
      await page.getByText(`Step ${result.sequence - 1}: inspect`, { exact: false }).last().waitFor({ timeout: 120000 })
      await page.waitForFunction(() => !__LONG_TASK_SMOKE__.sessions.binding('session-long-task-performance').session.getSnapshot().running)
    }
    return result
  }
  try {
    const ready = await waitFile('ready.json')
    for (let i = 0; i < 300 && !output.includes('dsh web: http'); i++) await sleep(100)
    const url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    assert.ok(url, output.slice(-4000))
    const require = createRequire(import.meta.url)
    const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
    page.on('pageerror', error => report.errors.push(error.message))
    page.on('console', message => {
      if (message.type() !== 'error') return
      ;(message.text().startsWith('Failed to load resource:') ? report.resourceErrors : report.errors).push(message.text())
    })
    await page.addInitScript(diagnose => {
      const observers = [], NativeObserver = MutationObserver
      window.MutationObserver = class extends NativeObserver {
        constructor(callback) {
          const sample = { source: new Error().stack, calls: 0, ms: 0, maxMs: 0 }
          observers.push(sample)
          super((records, observer) => {
            const start = performance.now()
            try { callback(records, observer) } finally {
              const ms = performance.now() - start
              sample.calls++; sample.ms += ms; sample.maxMs = Math.max(ms, sample.maxMs)
            }
          })
        }
      }
      const queries = {}, nativeQuery = Document.prototype.querySelectorAll
      Document.prototype.querySelectorAll = function(selector) {
        queries[selector] = (queries[selector] || 0) + 1
        return nativeQuery.call(this, selector)
      }
      let frames = [], longTasks = [], lastFrame = 0
      function frame(now) { if (lastFrame) frames.push(now - lastFrame); lastFrame = now; requestAnimationFrame(frame) }
      requestAnimationFrame(frame)
      new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration))).observe({ entryTypes: ['longtask'] })
      window.__perf = { observers, queries, layers: {}, reset() {
        frames = []; longTasks = []; lastFrame = 0
        this.layers = {}
        for (const sample of observers) sample.calls = sample.ms = sample.maxMs = 0
        for (const key of Object.keys(queries)) delete queries[key]
      }, snapshot() {
        const sorted = [...frames].sort((a, b) => a - b)
        return { observers: observers.filter(s => s.calls), queries: { ...queries }, layers: this.layers,
          frames: { count: sorted.length, p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) }, longTasks,
          nodes: document.getElementsByTagName('*').length, heap: performance.memory?.usedJSHeapSize }
      } }
      if (diagnose) {
        const nativeStyle = window.getComputedStyle
        window.getComputedStyle = function(node, ...args) {
          const label = node.tagName + '.' + node.getAttribute('class') + ':' + node.getAttribute('role') + ':' + Boolean(node.closest('[data-chat-flow]'))
          __perf.layers[label] = (__perf.layers[label] || 0) + 1
          return nativeStyle.call(this, node, ...args)
        }
      }
    }, Boolean(process.env.PERF_DIAG))
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    for (const name of ['继续', '我知道了', '稍后配置']) await page.addLocatorHandler(page.getByRole('button', { name, exact: true }), button => button.click())
    await page.waitForFunction(() => window.__LONG_TASK_SMOKE__?.sessions.list.getSnapshot().phase === 'ready')
    if (process.env.PERF_CSS_ABLATE) {
      const removed = await page.evaluate(needles => {
        const style = [...document.querySelectorAll('style')].find(node => node.textContent.slice(0, 400).includes('appearance overlay'))
        if (!style) throw Error('appearance stylesheet was not injected')
        let count = 0
        function prune(container) {
          for (let i = container.cssRules.length - 1; i >= 0; i--) {
            const rule = container.cssRules[i]
            if (rule.selectorText && needles.some(needle => rule.selectorText.includes(needle))) {
              container.deleteRule(i)
              count++
            } else if (rule.cssRules?.length) prune(rule)
          }
        }
        prune(style.sheet)
        return count
      }, process.env.PERF_CSS_ABLATE.split('|'))
      console.log(JSON.stringify({ cssRulesRemoved: removed, selectors: process.env.PERF_CSS_ABLATE }))
      assert.ok(removed > 0, 'CSS ablation must remove at least one matching rule')
    }
    if (process.env.PERF_EXTRA_CSS) await page.addStyleTag({ content: process.env.PERF_EXTRA_CSS })
    await page.evaluate(id => __LONG_TASK_SMOKE__.uiWorkspace.openSession(id), ready.sessionId)
    await run(20)
    await page.locator('[data-chat-flow-key]').first().waitFor()
    for (const name of ['继续', '我知道了', '稍后配置']) await page.removeLocatorHandler(page.getByRole('button', { name, exact: true }))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Profiler.enable')
    for (const size of [20, Number(process.env.PERF_STEPS || 300)]) {
      if (size > 20) await run(size - 20)
      await sleep(500)
      if (size > 20) await writeFile(join(root, 'seeded.html'), await page.content())
      await page.evaluate(() => __perf.reset())
      if (process.env.PERF_TRACE && size > 20) await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' })
      await cdp.send('Profiler.start')
      await run(16, 16, false)
      const { profile } = await cdp.send('Profiler.stop')
      await writeFile(join(root, `cpu-${size}.json`), JSON.stringify(profile))
      if (process.env.PERF_TRACE && size > 20) {
        const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve))
        await cdp.send('Tracing.end')
        const { stream } = await complete
        let trace = ''
        for (;;) { const chunk = await cdp.send('IO.read', { handle: stream }); trace += chunk.data; if (chunk.eof) break }
        await cdp.send('IO.close', { handle: stream })
        await writeFile(join(root, 'trace.json'), trace)
      }
      const sample = { size, ...await page.evaluate(() => __perf.snapshot()) }
      report.samples.push(sample)
      console.log(JSON.stringify({ size, nodes: sample.nodes, heap: sample.heap, queries: sample.queries,
        frames: sample.frames, longTasks: sample.longTasks.length, observerMs: Math.round(sample.observers.reduce((sum, s) => sum + s.ms, 0)) }))
    }
    assert.ok(report.samples[1].nodes > report.samples[0].nodes, 'native long transcript actually grew')
    const input = page.locator('[contenteditable="true"]').last()
    await input.fill('Draft survives the long task')
    assert.equal(await input.innerText(), 'Draft survives the long task')
    await page.screenshot({ path: join(root, 'long-task.png') })
    assert.deepEqual(report.errors, [])
    report.checks.push('native streamed tools and text at 20 and 300 steps', 'composer remains editable', 'no browser errors')
  } catch (error) {
    report.error = error.stack
    await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
    // Logs stay in the isolated test directory; launch tokens are not printed.
    await writeFile(join(root, 'host.log'), output)
    await browser?.close()
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
    console.log('Report: ' + join(root, 'report.json'))
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
