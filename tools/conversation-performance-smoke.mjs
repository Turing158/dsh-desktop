/** Long-transcript regression in isolated Edge; no DSH profile or model calls.
 * Run: npm run test:conversation-perf. Timing is reported; assertions use work
 * counts and UI behavior so CPU load does not make this test flaky.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
await mkdir(resolve('src-tauri/target'), { recursive:true })
const root = await mkdtemp(resolve('src-tauri/target/conversation-perf-'))
const source = (await readFile(process.env.OVERLAY_SOURCE || 'dsh-plugin/ui-overlay/dom.js', 'utf8')).replace(/\r\n/g, '\n')
const anchor = '\n  begin()\n'
assert.equal(source.split(anchor).length, 2, 'instrument the actual overlay startup')
const instrumented = source.replace(anchor, '\n  window.__perfOverlay = { pass, stop: () => clearInterval(timer) }\n  begin()\n')
const css = await readFile('dsh-plugin/ui-overlay/theme.css', 'utf8')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const report = { browser: browser.version(), checks: [], samples: [] }, errors = []
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
let page
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent(`<!doctype html><html data-dsh-ui="desktop" data-dsh-desktop-animation="off"><body>
    <div id="root"><main><section data-conversation-region="chat"><div id="history" data-chat-flow></div><p id="stream">start</p></section>
    <div data-conversation-region="composer"><div data-composer-card><button id="permission">完全权限</button><div contenteditable="true"></div></div></div>
    <div id="preview"><div data-textpreview-path data-path-label title="/workspace/example.txt"><span>/workspace/example.txt</span></div>
    <div id="code" data-code-block-content></div></div><div id="ui"></div>
    <div id="progress" role="status">running</div><span id="rename" role="button">Title</span>
    </main></div></body></html>`)
  await page.addStyleTag({ content: css + '\nmain{height:850px;overflow:auto}#preview{display:none}#ui{position:relative}.perfFullscreen{position:fixed;inset:0}' })
  await page.evaluate(() => {
    window.__perfNativeFrame = requestAnimationFrame.bind(window)
    window.__perfSettle = () => new Promise(resolve => __perfNativeFrame(() => __perfNativeFrame(resolve)))
    window.__perfReset = () => { window.__perfWork = { styleReads:0, contentStyleReads:0, stableStyleReads:0, documentQueries:0, scheduledFrames:0 } }
    __perfReset()
    const style = window.getComputedStyle.bind(window)
    window.getComputedStyle = (node, ...args) => {
      __perfWork.styleReads++
      if (node.classList.contains('perfToken')) __perfWork.contentStyleReads++
      if (node.id === 'progress' || node.id === 'rename') __perfWork.stableStyleReads++
      return style(node, ...args)
    }
    const query = Document.prototype.querySelectorAll
    Document.prototype.querySelectorAll = function (...args) { __perfWork.documentQueries++; return query.apply(this, args) }
    window.requestAnimationFrame = callback => { __perfWork.scheduledFrames++; return __perfNativeFrame(callback) }
    window.__perfRows = count => {
      const row = '<article><p>A completed response</p><pre><code>' + '<span class="perfToken">const value = 1; </span>'.repeat(240) + '</code></pre><button>Copy</button></article>'
      document.getElementById('history').innerHTML = row.repeat(count)
    }
    __perfRows(20)
  })
  await page.addScriptTag({ content: instrumented })
  await page.evaluate(async () => { __perfOverlay.stop(); await __perfSettle() })
  // Load the actual peripheral integrations too. Their mounts are inert here;
  // discovery and reconciliation run exactly as in the shipped client bundles.
  const peripheral = await build({ stdin: { resolveDir: resolve('.'), contents: `
    import { mountArchiveSidebar } from './dsh-plugin/sidebar-archive/sidebar.mjs'
    import { mountMarketplaceHeader } from './dsh-plugin/plugin-control/marketplace-view.mjs'
    import { createDockFallbackToggle } from './dsh-plugin/sidebar-terminal/dock.mjs'
    const cleanups = [], React = { createElement() {}, useState: () => [null, () => {}], useLayoutEffect: fn => cleanups.push(fn()) }
    const createRoot = () => ({ render() {}, unmount() {} })
    cleanups.push(mountArchiveSidebar(React, createRoot, () => {}, {
      getSnapshot: () => ({ only: false }), isArchived: () => false, subscribe: () => () => {},
    }))
    cleanups.push(mountMarketplaceHeader(React, createRoot, () => {}))
    createDockFallbackToggle(React, {}, () => {})()
    window.__perfPeripheralStop = () => cleanups.forEach(fn => fn())
  ` }, bundle: true, format: 'iife', write: false, logLevel: 'silent' })
  await page.addScriptTag({ content: peripheral.outputFiles[0].text })
  async function measurePass(messages) {
    const sample = await page.evaluate(async messages => {
      __perfRows(messages)
      await __perfSettle()
      __perfReset()
      const started = performance.now()
      __perfOverlay.pass()
      return { messages, elapsedMs:performance.now()-started, ...__perfWork }
    }, messages)
    report.samples.push(sample)
    assert.equal(sample.contentStyleReads, 0, 'never read each historical token style')
    assert.ok(sample.documentQueries <= 1, 'periodic pass only locates the composer, never transcript descendants')
    return sample
  }
  const small = await measurePass(20), large = await measurePass(800)
  assert.ok(large.styleReads <= small.styleReads + 2, 'style work stays bounded when transcript grows 40x')
  pass('periodic work does not grow with 20 vs 800 loaded responses')

  const streaming = await page.evaluate(async () => {
    await __perfSettle()
    __perfReset()
    const stream = document.getElementById('stream'), code = document.getElementById('code')
    for (let i=0; i<40; i++) {
      const text = document.createElement('span')
      text.textContent = 'stream chunk ' + i
      stream.replaceChildren(text)
      code.replaceChildren(document.createTextNode('preview chunk ' + i))
      await __perfSettle()
      text.firstChild.data += ' more'
      await __perfSettle()
    }
    document.getElementById('stream').dispatchEvent(new Event('scroll', { bubbles:true }))
    await __perfSettle()
    return __perfWork
  })
  assert.equal(streaming.scheduledFrames, 0, 'plain output must not schedule settings, menus or path scans')
  assert.equal(streaming.documentQueries, 0, 'plain output must not search the document')
  pass('text, structural output and scrolling skip unrelated overlay work')

  const chromeStreaming = await page.evaluate(async () => {
    await __perfSettle(); __perfReset()
    const title = document.getElementById('rename'), progress = document.getElementById('progress')
    for (let i = 0; i < 40; i++) {
      progress.textContent = 'step ' + i
      // React layout effects can remove/reapply the same final attributes.
      title.removeAttribute('role'); title.setAttribute('role', 'button')
      await __perfSettle()
    }
    return __perfWork
  })
  assert.equal(chromeStreaming.stableStyleReads, 0, 'status text and unchanged final title attributes never force layout')
  pass('live step counters and title rebinding do not remeasure stable surfaces')

  await page.evaluate(async () => {
    document.getElementById('ui').innerHTML = '<section data-slot="sidebar.workspaces"><div class="_sectionHeader"><span class="_sectionLabel">Workspace</span><div class="_headerActions"></div></div></section><div data-shortcut-modal="settings"><div role="tablist"><button role="tab" id="fixture-tab-desktop-builtins">Plugins</button></div></div>'
    await __perfSettle()
  })
  assert.equal(await page.locator('.dshArchive__toggleMount').count(), 1)
  assert.equal(await page.locator('.dshPlugins__marketplaceHeader').count(), 1)
  await page.evaluate(async () => { document.getElementById('ui').replaceChildren(); await __perfSettle() })
  assert.equal(await page.locator('.dshArchive__toggleMount, .dshPlugins__marketplaceHeader').count(), 0)
  pass('archive and settings integrations still discover new regions and retire removed mounts')

  await page.evaluate(async () => {
    const host = document.createElement('div')
    host.id = 'inline-host'
    host.innerHTML = '<div id="inline-dialog" role="dialog" class="perfFullscreen"><button>完全权限</button></div>'
    document.getElementById('stream').append(host)
    await __perfSettle()
  })
  assert.equal(await page.locator('#inline-dialog').getAttribute('data-dsh-chrome'), 'layer')
  assert.equal(await page.locator('#inline-dialog button').getAttribute('data-dsh-danger'), 'selector')
  assert.equal(await page.locator('#inline-dialog').evaluate(node => getComputedStyle(node).top), '44px')
  pass('a nested dialog inside the transcript still clears the title bar and decorates controls')
  await page.evaluate(async () => { document.getElementById('inline-host').remove(); await __perfSettle() })

  await page.evaluate(async () => {
    const mask = document.createElement('div')
    mask.id = 'status-mask'
    document.getElementById('stream').append(mask)
    await __perfSettle()
    mask.className = 'perfFullscreen'
    mask.setAttribute('role', 'status')
    await __perfSettle()
  })
  assert.equal(await page.locator('#status-mask').getAttribute('data-dsh-chrome'), 'layer')
  await page.evaluate(async () => { document.getElementById('status-mask').remove(); await __perfSettle() })
  pass('an existing content node gaining a status-mask role is discovered immediately')

  await page.evaluate(async () => {
    const host = document.createElement('div')
    host.id = 'menu-host'
    host.innerHTML = '<div role="menu" style="position:fixed;left:300px;top:150px;width:120px;height:80px"><div><div id="nested-menu" role="menu" style="position:absolute;width:100px;height:60px"><button role="menuitem">完全权限</button></div></div></div>'
    document.getElementById('stream').append(host)
    await __perfSettle()
  })
  assert.equal(await page.locator('#nested-menu').getAttribute('data-dsh-desktop'), 'nested-menu')
  assert.equal(await page.locator('#nested-menu button').getAttribute('data-dsh-danger'), 'item')
  assert.equal(await page.locator('#nested-menu').getAttribute('data-dsh-chrome'), null)
  pass('inline and nested menus remain discoverable without being treated as full-screen layers')
  await page.evaluate(async () => { document.getElementById('menu-host').remove(); await __perfSettle() })

  await page.evaluate(async () => {
    document.getElementById('ui').innerHTML = '<div><div><div id="roleless" style="position:fixed;inset:0"></div></div></div>'
    await __perfSettle()
    __perfOverlay.pass()
  })
  assert.equal(await page.locator('#roleless').getAttribute('data-dsh-chrome'), 'layer')
  await page.evaluate(async () => {
    document.documentElement.setAttribute('data-dsh-ui', 'vanilla')
    document.dispatchEvent(new Event('dsh-desktop:ui-mode'))
    await __perfSettle()
  })
  assert.equal(await page.locator('#permission').getAttribute('data-dsh-danger'), null)
  assert.equal(await page.locator('#roleless').getAttribute('data-dsh-chrome'), 'layer')
  await page.evaluate(async () => {
    document.documentElement.setAttribute('data-dsh-ui', 'desktop')
    document.dispatchEvent(new Event('dsh-desktop:ui-mode'))
    document.getElementById('roleless').style.position = 'absolute'
    __perfOverlay.pass()
    await __perfSettle()
  })
  assert.equal(await page.locator('#roleless').getAttribute('data-dsh-chrome'), null)
  assert.equal(await page.locator('#permission').getAttribute('data-dsh-danger'), 'chip')
  pass('role-less UI layers, vanilla cleanup and full-screen retirement still work')

  // A TODO panel can be hosted in the chat; filtering must retain its collapse animation.
  await page.evaluate(async () => {
    document.documentElement.setAttribute('data-dsh-desktop-animation', 'on')
    const panel = document.createElement('div')
    panel.id = 'todo'; panel.setAttribute('data-testid', 'todo-panel')
    panel.innerHTML = '<div><ul><li>task</li></ul></div>'
    document.getElementById('stream').append(panel)
    await __perfSettle()
  })
  assert.equal(await page.locator('#todo ul').getAttribute('data-dsh-chrome'), 'collapse-body')
  await page.locator('#todo ul').evaluate(node => node.remove())
  await page.waitForFunction(() => Boolean(document.querySelector('#todo [data-dsh-ghost="collapse"]')))
  await page.waitForFunction(() => !document.querySelector('#todo [data-dsh-ghost]'))
  pass('TODO collapse motion inside the transcript still runs and cleans up')
  assert.deepEqual(errors, [])
  pass('no browser errors')
} catch (error) {
  report.error = error.stack
  await page?.screenshot({ path:join(root, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log('Report: ' + join(root, 'report.json'))
}
