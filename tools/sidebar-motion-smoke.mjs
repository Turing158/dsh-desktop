/** Real DSH frontend in Edge, with an isolated profile and a minimal desktop bridge. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { checkDockSidebarLayout } from './terminal-dock-layout-check.mjs'

const root = await mkdtemp(resolve('src-tauri/target/sidebar-motion-'))
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const patchPath = join(root, 'desktop.patch.yml')
const probe = join(root, 'probe')
await mkdir(probe)
await writeFile(join(probe, 'package.json'), JSON.stringify({
  name: '@dsh-desktop/motion-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } },
}))
await writeFile(join(probe, 'index.js'), 'export function apply() {}\n')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/motion-smoke',factory:()=>({inject:['sessions','workspaces','uiWorkspace','sidebarRight','configForms'],apply(ctx){window.__DSH_SMOKE_CONTEXT__=ctx}})})`)
await writeFile(patchPath, (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: desktop-motion-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n')
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, DSH_HOME: join(root, 'dsh-home'), DSH_DESKTOP_DSH_BIN: dshBin,
} })
let c, browser, output = ''
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const report = { root, checks: [], samples: [] }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
async function until(expression) {
  const end = Date.now() + 40000
  let last
  while (Date.now() < end) {
    if (child.exitCode !== null) throw Error('Isolated desktop exited: ' + child.exitCode)
    try { const value = await c.evaluate(expression); if (value) return value } catch (e) { last = e }
    await sleep(150)
  }
  throw Error('Timed out: ' + expression + ' ' + (last?.message || ''))
}
async function preference(animation, reduced = false, mode = 'desktop') {
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] })
  await c.evaluate(`document.dispatchEvent(new CustomEvent('dsh-desktop:set-ui-mode',{detail:{mode:${JSON.stringify(mode)}}}))`)
  await c.evaluate(`T.configForms.get('desktop-appearance').set('animation', ${JSON.stringify(animation)})`)
  await sleep(350)
}
async function sample(seat, geometry = true) {
  if (process.env.SIDEBAR_PROFILE) { await c.send('Profiler.enable'); await c.send('Profiler.start') }
  await c.send('Performance.enable')
  const metricsBefore = (await c.send('Performance.getMetrics')).metrics
  const values = await c.evaluate(`(async () => {
    const seat = ${JSON.stringify(seat)}, samples = [], frames = [];
    let lastFrame = performance.now(), styleWrites = 0;
    const mutations = new MutationObserver(records => styleWrites += records.length);
    mutations.observe(document.documentElement, {attributes:true, attributeFilter:['style']});
    const take = () => {
      if (!${geometry}) return 0;
      const frame = document.querySelector('[class*="_frame"]');
      const panel = document.querySelector('[data-sidebar-right-panel]');
      const dock = document.querySelector('[data-dsh-terminal-dock]');
      const host = panel?.querySelector('[data-dockkit-host="dock"], [data-dockkit-empty]');
      return seat === 'mobile-left' ? new DOMMatrix(getComputedStyle(document.querySelector('[class*="_sidebarCol"]')).transform).m41 :
        seat === 'mobile-right' ? Math.round(Number(getComputedStyle(panel).opacity) * 100) :
        seat === 'left' ? document.querySelector('[class*="_sidebarCol"]').getBoundingClientRect().width :
        seat === 'right' ? (host ? Number(new DOMMatrix(getComputedStyle(host).transform).m41.toFixed(2)) : -1) :
        Number.parseFloat(getComputedStyle(document.querySelector('[class*="_centerCol"]')).paddingBottom) || 0;
    };
    samples.push(take());
    if (seat.endsWith('left')) document.querySelector('.dshTb__mark').click();
    else if (seat.endsWith('right')) T.sidebarRight.toggleExpanded();
    else { const d = window.__DSH_UPSTREAM_DOCK_SMOKE__.dock; d.getSnapshot().collapsed ? d.open() : d.collapse(true); }
    const started = performance.now();
    while (performance.now() - started < 420) {
      await new Promise(requestAnimationFrame);
      const now = performance.now(); frames.push(now-lastFrame); lastFrame = now;
      samples.push(take());
    }
    mutations.disconnect();
    window.__sidebarPerformance = {frames, styleWrites};
    return samples;
  })()`)
  const metricsAfter = (await c.send('Performance.getMetrics')).metrics
  const metrics = Object.fromEntries(metricsAfter.filter(m => ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration'].includes(m.name))
    .map(m => [m.name, m.value - metricsBefore.find(before => before.name === m.name).value]))
  report.samples.push({ seat, geometry, values, ...await c.evaluate('window.__sidebarPerformance'), metrics })
  if (process.env.SIDEBAR_PROFILE) {
    const { profile } = await c.send('Profiler.stop')
    await writeFile(join(root, `profile-${report.samples.length}-${seat}.json`), JSON.stringify(profile))
    if (report.samples.length <= 6) {
      const totals = new Map()
      profile.samples.forEach((id, i) => totals.set(id, (totals.get(id) || 0) + profile.timeDeltas[i]))
      const scripts = new Set(profile.nodes.filter(n => totals.get(n.id) > 10000 && n.callFrame.url.includes('/plugins/')).map(n => n.callFrame.scriptId))
      for (const scriptId of scripts) {
        const { scriptSource } = await c.send('Debugger.getScriptSource', { scriptId })
        await writeFile(join(root, `script-${scriptId}.js`), scriptSource)
      }
    }
  }
  return new Set(values.map(v => Math.round(v))).size
}
try {
  for (let i = 0; i < 300 && !/dsh web: (http:\/\/[^\s\u001b]+)/.test(output); i++) {
    if (child.exitCode !== null) throw Error(output.slice(-4000))
    await sleep(100)
  }
  const url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
  assert.ok(url, output.slice(-4000))
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  report.pageErrors = []
  page.on('pageerror', error => report.pageErrors.push(error.message))
  await page.addInitScript(() => {
    window.__DSH_UI_BOOT__ = { smoke: true }
    window.__TAURI__ = { core: { Channel: class {}, invoke: async () => null }, event: { listen: async () => () => {} } }
  })
  const session = await page.context().newCDPSession(page)
  if (process.env.SIDEBAR_PROFILE) await session.send('Debugger.enable')
  c = { evaluate: expression => page.evaluate(expression), send: (method, params) => session.send(method, params), close() {} }
  await page.goto(url)
  await until("window.__DSH_SMOKE_CONTEXT__?.sessions.list.getSnapshot().phase === 'ready'")
  await c.evaluate("window.__DSH_SMOKE_CONTEXT__.inject(['sidebarRight', 'configForms'], ctx => { window.T = ctx })")
  await until("Boolean(T?.configForms.get('desktop-appearance'))")
  for (let i = 0; i < 6; i++) {
    await c.evaluate(`(()=>{
      for(const b of document.querySelectorAll('button')) if(['稍后配置','继续'].includes(b.textContent)) b.click();
      for(const dialog of document.querySelectorAll('[role="dialog"], [role="presentation"]')) {
        if(dialog.textContent.includes('开始使用')) dialog.querySelector('button[aria-label="关闭"], button[title="关闭"]')?.click();
      }
    })()`)
    await sleep(150)
  }
  await c.evaluate(`(async()=>{const ctx=window.__DSH_SMOKE_CONTEXT__, w=await ctx.workspaces.create({path:${JSON.stringify(root)}});const id=await ctx.sessions.create({workspaceId:w.workspaceId});ctx.uiWorkspace.openSession(id)})()`)
  await until('Boolean(T.sidebarRight.mounted.getSnapshot()) && Boolean(window.__DSH_UPSTREAM_DOCK_SMOKE__)')
  await c.evaluate("T.sidebarRight.openTab('guide')")
  await preference('on', true)
  // Current DSH opens onboarding after the first session mounts. Dismiss it
  // before measuring the workspace, rather than profiling underneath its mask.
  if (await page.getByText('开始使用', { exact: true }).isVisible()) await page.keyboard.press('Escape')
  for (const seat of ['left', 'right', 'bottom']) {
    for (let i = 0; i < 2; i++) assert.ok(await sample(seat) > 3, seat + ' must animate both directions, even with OS reduced motion')
  }
  pass('left, right and bottom animate both ways with animation on, including OS reduced motion')
  for (const seat of ['left', 'right', 'bottom']) {
    for (let i = 0; i < 2; i++) {
      // Measure scheduling without geometry reads that would themselves force
      // extra layouts between the browser's animation and ResizeObserver phases.
      await sample(seat, false)
      assert.ok(report.samples.at(-1).styleWrites <= 2, seat + ' must not rewrite inherited root styles every frame')
    }
  }
  pass('sidebar motion avoids per-frame root writes; frame timing is recorded without forced measurement layouts')
  await c.evaluate("window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.open()")
  await sleep(350)
  await until("Boolean(document.querySelector('[data-dsh-terminal-dock] .xterm'))")
  report.retainedTerminal = await c.evaluate(`(async()=>{
    const store=window.__DSH_UPSTREAM_DOCK_SMOKE__.dock;
    const panel=document.querySelector('[data-dsh-terminal-dock]'), screen=panel.querySelector('.xterm');
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    store.collapse(true); await sleep(350);
    const closed={rects:panel.getClientRects().length,display:getComputedStyle(panel).display,inert:panel.inert,aria:panel.getAttribute('aria-hidden'),animations:panel.getAnimations().length};
    const hidden=closed.rects===0 && closed.inert && closed.aria==='true';
    const unfocused=!panel.contains(document.activeElement);
    store.open(); await sleep(350);
    return {hidden,unfocused,reused:document.querySelector('[data-dsh-terminal-dock] .xterm')===screen,closed};
  })()`)
  assert.ok(report.retainedTerminal.hidden && report.retainedTerminal.unfocused && report.retainedTerminal.reused, JSON.stringify(report.retainedTerminal))
  pass('collapsed native terminal is hidden and inert, and reopening reuses its emulator')
  report.tabMotion = await c.evaluate(`(async()=>{
    const dock=window.__DSH_UPSTREAM_DOCK_SMOKE__.dock, checks=[];
    const selector='[data-sidebar-right-panel], [data-sidebar-right-panel] [data-dockkit-host], [data-sidebar-right-panel] [data-dockkit-empty], [data-sidebar-right-panel] [data-dockkit-content], [data-dsh-terminal-dock], #dsh-terminal-dock-viewport';
    async function check(action, change) {
      const animations=new Set(), heights=new Set(), widths=new Set();
      const beforeHeight=document.querySelector('[data-dsh-terminal-dock]').getBoundingClientRect().height;
      const beforeWidth=document.querySelector('[data-sidebar-right-panel]').getBoundingClientRect().width;
      change();
      const start=performance.now();
      while(performance.now()-start<300) {
        await new Promise(requestAnimationFrame);
        for(const node of document.querySelectorAll(selector)) for(const a of node.getAnimations()) {
          if(a.effect.getKeyframes().some(f=>f.transform||f.translate)) animations.add(a);
        }
        heights.add(document.querySelector('[data-dsh-terminal-dock]').getBoundingClientRect().height);
        widths.add(document.querySelector('[data-sidebar-right-panel]').getBoundingClientRect().width);
      }
      checks.push({action, animations:animations.size, stableHeight:[...heights].every(n=>n===beforeHeight),stableWidth:[...widths].every(n=>n===beforeWidth)});
    }
    await check('right add',()=>T.sidebarRight.openTab('files'));
    await check('right close',()=>T.sidebarRight.close(T.sidebarRight.openTabs.getSnapshot().find(t=>t.kind==='files').tabId));
    await check('right replace',()=>T.sidebarRight.openTab('files',{replaceTab:T.sidebarRight.openTabs.getSnapshot().find(t=>t.kind==='guide').tabId}));
    await check('right close last',()=>T.sidebarRight.close(T.sidebarRight.openTabs.getSnapshot().find(t=>t.kind==='files').tabId));
    await check('right add after empty',()=>T.sidebarRight.openTab('guide'));
    await check('bottom add',()=>dock.add());
    const first=dock.getSnapshot().tabs[0].contentId;
    await check('bottom switch',()=>dock.activate(first));
    await check('bottom close',()=>dock.close(first));
    return checks;
  })()`)
  for(const check of report.tabMotion) {
    assert.equal(check.animations,0,check.action+' must not animate sidebar content')
    assert.ok(check.stableHeight&&check.stableWidth,check.action+' must keep the sidebar geometry stable')
  }
  pass('right and bottom tab creation, replacement, switching and closing leave sidebar content and geometry still')
  for (const [animation, reduced] of [['off', false], ['system', true]]) {
    await preference(animation, reduced)
    for (const seat of ['left', 'right', 'bottom']) {
      for (let i = 0; i < 2; i++) assert.ok(await sample(seat) <= 2, `${seat}: ${animation}/${reduced} must switch immediately`)
    }
  }
  pass('off and system/reduced-motion disable motion in both directions for all three sidebars')
  await preference('system', false)
  for (const seat of ['left', 'right', 'bottom']) assert.ok(await sample(seat) > 3, seat + ': system/no-preference animates')
  await c.evaluate("window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.open()")
  await sleep(350)
  await checkDockSidebarLayout(c, root, pass)
  await preference('on')
  const rapid = await c.evaluate(`(async()=>{
    const d=window.__DSH_UPSTREAM_DOCK_SMOKE__.dock, sleep=ms=>new Promise(r=>setTimeout(r,ms));
    for(let i=0;i<12;i++){d.collapse(i%2===0);await sleep(35)}
    d.open();await sleep(350);
    const el=document.querySelector('[data-dsh-terminal-dock]');
    const result={count:document.querySelectorAll('[data-dsh-terminal-dock]').length,height:el.getBoundingClientRect().height,bottom:el.getBoundingClientRect().bottom,viewport:innerHeight,transform:getComputedStyle(el).transform};
    d.collapse(true);await sleep(60);document.documentElement.setAttribute('data-dsh-desktop-animation','off');await sleep(30);
    result.afterOff=[...document.querySelectorAll('[data-dsh-terminal-dock]')].filter(node=>node.getClientRects().length).length;
    result.reserved=document.documentElement.style.getPropertyValue('--dsh-terminal-dock-height');
    return result;
  })()`)
  report.rapid = rapid
  assert.equal(rapid.count, 1)
  assert.equal(rapid.bottom, rapid.viewport)
  assert.equal(rapid.transform, 'none')
  assert.equal(rapid.afterOff, 0)
  assert.equal(rapid.reserved, '0px')
  pass('rapid bottom reversals settle correctly and disabling animation during exit immediately releases the region')
  await preference('on', false, 'vanilla')
  assert.equal(await c.evaluate("Boolean(document.querySelector('[data-dsh-terminal-dock]'))"), false)
  assert.equal(await c.evaluate("getComputedStyle(document.body).getPropertyValue('--dsh-sidebar-motion-duration').trim()"), '')
  pass('vanilla withdraws the custom sidebar motion and bottom panel')
  await preference('on')
  await c.evaluate(`(()=>{
    if(document.querySelector('[class*="_frame"]').hasAttribute('data-sidebar-collapsed')) document.querySelector('.dshTb__mark').click();
    T.sidebarRight.openTab('guide');
    window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.open();
  })()`)
  await sleep(350)
  const shot = await c.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, 'sidebars.png'), Buffer.from(shot.data, 'base64'))
  await c.evaluate("window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.collapse(true); document.documentElement.setAttribute('data-dsh-browser','')")
  await page.setViewportSize({ width: 390, height: 844 })
  for (const [animation, reduced, mode, animated] of [
    ['on', true, 'desktop', true], ['off', false, 'desktop', false],
    ['system', true, 'desktop', false], ['system', false, 'desktop', true], ['on', false, 'vanilla', false],
  ]) {
    await preference(animation, reduced, mode)
    for (const seat of ['mobile-left', 'mobile-right']) {
      for (let i = 0; i < 2; i++) {
        const steps = await sample(seat)
        assert.ok(animated ? steps > 3 : steps <= 2, `${seat}: ${animation}/${reduced}/${mode}, steps=${steps}`)
      }
    }
  }
  pass('phone drawers and previews animate both ways, follow the same preference, and stop in vanilla')
  assert.deepEqual(report.pageErrors, [])
} catch (error) {
  report.error = error.stack
  if (c) report.page = await c.evaluate('document.body.innerText').catch(() => '')
  throw error
} finally {
  if (c) {
    try { await c.evaluate("(()=>{const d=window.__DSH_UPSTREAM_DOCK_SMOKE__?.dock;for(const t of d?.getSnapshot().tabs||[])d.close(t.contentId)})()") } catch {}
    c.close()
  }
  await browser?.close()
  if (child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} }
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Evidence: ' + join(root, 'report.json'))
}
