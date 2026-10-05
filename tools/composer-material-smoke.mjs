/** Verify composer material controls, coupled effects, and restart persistence.
 * Run: node tools/composer-material-smoke.mjs (isolated DSH profile + headless Edge).
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/composer-material-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home); await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), `desktop-appearance:
  animation: on
  ui: desktop
desktop-terminal-dock:
  layout: { height: 312, collapsed: true }
  profileId: cmd
  position: right
`)
await writeFile(join(probe, 'package.json'), JSON.stringify({
  name: '@dsh-desktop/settings-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' },
  dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings'] } },
}))
await writeFile(join(probe, 'index.js'), 'export function apply() {}\n')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({
  id: '@dsh-desktop/settings-smoke',
  factory: () => ({ inject: ['configForms', 'slots'], apply(ctx) { window.__SETTINGS_SMOKE__ = ctx } }),
})\n`)
const originalPatch = await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8')
const patch = originalPatch.replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: desktop-settings-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)

let child, browser, output = ''
const report = { version: JSON.parse(await readFile(resolve(dshBin, '../../package.json'), 'utf8')).version, root, checks: {} }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function start() {
  output = ''
  child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin },
  })
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  for (let i = 0; i < 300; i++) {
    const url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) return url
    if (child.exitCode !== null) throw Error('DSH exited: ' + output.slice(-4000))
    await sleep(100)
  }
  throw Error('DSH did not become ready: ' + output.slice(-4000))
}
function stop() {
  if (!child || child.exitCode !== null) return
  const pid = child.pid
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch (error) {
    // The process can exit between the exitCode check and taskkill.
    try { process.kill(pid, 0) } catch (probe) { if (probe.code === 'ESRCH') { child = null; return } }
    throw error
  }
  child = null
}
async function ready(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => {
    if (document.body.textContent.includes('Failed to load plugins')) throw Error(document.body.textContent)
    const forms = window.__SETTINGS_SMOKE__?.configForms
    return forms && ['desktop-appearance', 'desktop-terminal-dock'].every(ns => forms.get(ns).getSnapshot().status === 'ready')
  }, undefined, { timeout: 30000 })
}
async function values(page) {
  return page.evaluate(() => {
    const forms = window.__SETTINGS_SMOKE__.configForms
    return Object.fromEntries(['desktop-appearance', 'desktop-terminal-dock'].map(ns => [ns, forms.get(ns).getSnapshot().value]))
  })
}

let page
const controls = [
  ['transparent', '透明', '输入框透明度', 'composerTransparency', 85],
  ['frosted', '纯磨砂', '纯磨砂效果程度', 'composerFrostedIntensity', 65],
  ['glass', '毛玻璃', '毛玻璃效果程度', 'composerGlassIntensity', 35],
]
async function appearance() {
  await page.locator('button[aria-haspopup="dialog"]').first().evaluate(n => n.click())
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.locator('.dshAppearance').waitFor()
}
async function section() { return (await values(page))['desktop-appearance'] }
async function choose(id, label) {
  await page.getByRole('group', {name:'输入框材质',exact:true}).getByRole('button',{name:label,exact:true}).click()
  await page.waitForFunction(id => window.__SETTINGS_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value.composerMaterial === id, id)
}
async function adjust(name, field, value) {
  const slider = page.getByRole('slider',{name,exact:true})
  await slider.fill(String(value))
  await slider.dispatchEvent('pointerup')
  await page.waitForFunction(([field,value]) => window.__SETTINGS_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value[field] === value, [field,value])
}
async function surface() {
  return page.locator('[data-dsh-desktop="composer"]').first().evaluate(n => {
    const s=getComputedStyle(n), b=n.getBoundingClientRect(), editor=n.querySelector('[contenteditable]')
    return { color:s.backgroundColor, alpha:Number(s.backgroundColor.match(/\/\s*([\d.]+)\)/)?.[1] ?? 1),
      blur:Number(s.backdropFilter.match(/blur\(([\d.]+)px\)/)?.[1] ?? 0), filter:s.backdropFilter, shadow:s.boxShadow,
      opacity:s.opacity, editorOpacity:editor && getComputedStyle(editor).opacity, width:b.width, height:b.height }
  })
}
function pass(name) { report.checks[name]=true; console.log('PASS: '+name) }
try {
  const url=await start()
  browser=await chromium.launch({channel:'msedge',headless:true})
  page=await browser.newPage({viewport:{width:1280,height:840}})
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await ready(page,url)
  await page.getByRole('button',{name:'继续',exact:true}).waitFor()
  for (const name of ['继续','我知道了','稍后配置']) {
    const button=page.getByRole('button',{name,exact:true})
    if(await button.count()) { await button.click(); await page.waitForTimeout(350) }
  }
  await page.waitForTimeout(350)
  if(await page.locator('[data-shortcut-modal="settings"]').count()) await page.keyboard.press('Escape')
  await page.waitForTimeout(260)
  await appearance()
  assert.equal(await page.locator('.dshAppearance__materialSlider').count(),0,'opaque has no material slider')
  for(const dark of [false,true]) {
    await page.evaluate(dark => window.__SETTINGS_SMOKE__.configForms.get('ui-theme').set('preference',dark?'dark':'light'),dark)
    await page.waitForTimeout(120)
    for(const [id,label,name,field,value] of controls) {
      await choose(id,label)
      assert.equal(await page.locator('.dshAppearance__materialSlider').count(),1,'only the selected material has a slider')
      const samples=[]
      for(const level of [0,25,50,75,100]) {
        await adjust(name,field,level)
        samples.push(await surface())
      }
      for(let i=1;i<samples.length;i++) {
        assert.ok(id==='transparent' ? samples[i].alpha<samples[i-1].alpha : samples[i].alpha>samples[i-1].alpha,
          'transparency must change across the entire slider range: '+JSON.stringify(samples))
        if(id==='transparent') assert.equal(samples[i].filter,'none')
        else assert.ok(samples[i].blur>samples[i-1].blur,'effect strength changes actual backdrop blur')
        assert.equal(samples[i].width,samples[0].width)
        assert.equal(samples[i].height,samples[0].height)
        assert.equal(samples[i].opacity,'1')
        assert.equal(samples[i].editorOpacity,'1','material transparency must not dim text')
      }
      if(id!=='transparent') {
        assert.equal(samples[0].alpha,0)
        assert.equal(samples[2].blur,18)
        assert.ok(Math.abs(samples[2].alpha-(dark?.58:.72))<.001,'default strength preserves the existing tint')
      }
      if(id==='frosted') for(const sample of samples) assert.equal(sample.shadow,'none')
      await adjust(name,field,value)
      await page.screenshot({path:join(root,(dark?'dark-':'light-')+id+'-settings.png')})
      pass((dark?'dark':'light')+'/'+id+': slider controls real transparency and effect without dimming text')
    }
  }
  // Actual pointer input commits on release; keyboard input commits on key-up.
  const glassSlider=page.getByRole('slider',{name:'毛玻璃效果程度',exact:true})
  const box=await glassSlider.boundingBox()
  await page.mouse.move(box.x+box.width*.6,box.y+box.height/2)
  await page.mouse.down()
  await page.mouse.move(box.x+box.width*.8,box.y+box.height/2,{steps:5})
  const preview=Number(await glassSlider.inputValue())
  assert.ok(preview>65 && preview<90)
  assert.equal((await section()).composerGlassIntensity,35,'pointer drag remains a preview until released')
  await page.mouse.up()
  await page.waitForFunction(value => window.__SETTINGS_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value.composerGlassIntensity === value,preview)
  await glassSlider.press('ArrowLeft')
  await page.waitForFunction(value => window.__SETTINGS_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value.composerGlassIntensity === value,preview-1)
  await adjust('毛玻璃效果程度','composerGlassIntensity',35)
  pass('pointer dragging and keyboard arrows preview and save correctly')
  for(const [id,label,name,field,value] of controls) {
    await choose(id,label)
    assert.equal(await page.getByRole('slider',{name,exact:true}).inputValue(),String(value))
  }
  const expected=await section()
  await choose('opaque','不透明')
  assert.equal(await page.locator('.dshAppearance__materialSlider').count(),0)
  await choose('glass','毛玻璃')
  pass('material values are independent and opaque hides the slider')
  await page.setViewportSize({width:375,height:812})
  await glassSlider.scrollIntoViewIfNeeded()
  const mobileBox=await glassSlider.boundingBox()
  assert.ok(mobileBox.x>=0 && mobileBox.x+mobileBox.width<=375)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await page.screenshot({path:join(root,'mobile-settings.png')})
  pass('375px settings show the full slider with no horizontal overflow')
  await page.setViewportSize({width:1280,height:840})
  await page.keyboard.press('Escape')
  await page.waitForTimeout(260)
  // A profile without credentials can defer onboarding until settings closes.
  const later=page.getByRole('button',{name:'稍后配置',exact:true})
  if(await later.isVisible()) { await later.click(); await page.waitForTimeout(300) }
  const editor=page.locator('[data-dsh-desktop="composer"] [contenteditable="true"]').first()
  await editor.evaluate(n=>n.blur())
  await page.waitForTimeout(250)
  await editor.focus()
  await page.waitForTimeout(70)
  const entering=await editor.evaluate(n=>+getComputedStyle(n.closest('[data-dsh-desktop="composer"]'),'::before').opacity)
  assert.ok(entering>0 && entering<1,'focus retains its entrance animation')
  await page.waitForTimeout(180)
  await editor.evaluate(n=>n.blur())
  await page.waitForTimeout(70)
  const leaving=await editor.evaluate(n=>+getComputedStyle(n.closest('[data-dsh-desktop="composer"]'),'::before').opacity)
  assert.ok(leaving>0 && leaving<1,'focus retains its exit animation')
  pass('the previous focus fade remains intact')
  await ready(page,page.url())
  assert.deepEqual(await section(),expected)
  stop()
  const restarted=await start()
  await ready(page,restarted)
  assert.deepEqual(await section(),expected)
  await page.waitForFunction(() => {
    const style=document.body.style
    return document.documentElement.getAttribute('data-dsh-composer-material')==='glass' &&
      style.getPropertyValue('--dsh-composer-transparent-tint')==='15%' &&
      style.getPropertyValue('--dsh-composer-frosted-strength')==='0.65' &&
      style.getPropertyValue('--dsh-composer-glass-strength')==='0.35'
  })
  assert.deepEqual(errors,[])
  pass('all three values survive page reload and backend restart without browser errors')
} catch(error) {
  report.error=error.stack
  if(page) await page.screenshot({path:join(root,'failure.png')}).catch(()=>{})
  throw error
} finally {
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  await browser?.close()
  stop()
  console.log('Report: '+join(root,'report.json'))
}
