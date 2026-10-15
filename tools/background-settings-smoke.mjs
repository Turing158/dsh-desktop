/** Upload a background, exercise all region controls and verify restart persistence.
 * Usage: node tools/background-settings-smoke.mjs
 * DSH_DESKTOP_DSH_BIN and PLAYWRIGHT_PATH can select another installed runtime.
 * No user profile or running desktop process is touched.
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
const root = await mkdtemp(resolve('src-tauri/target/background-settings-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home); await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), `desktop-appearance:
  animation: off
  ui: vanilla
  fontSizeOverride: 10
desktop-terminal-dock:
  layout: { height: 312, collapsed: false }
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
try {
  const firstUrl = await start()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  await page.addLocatorHandler(page.getByRole('button', {name:'稍后配置',exact:true}), async button => { await button.click() })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await ready(page, firstUrl)
  await page.evaluate(() => window.__SETTINGS_SMOKE__.configForms.get('desktop-appearance').set('ui', 'desktop'))
  await page.evaluate(() => { for(const b of document.querySelectorAll('button')) if(['稍后配置','继续'].includes(b.textContent)) b.click() })
  await page.locator('button[aria-haspopup="dialog"]').first().evaluate(e=>e.click())
  await page.getByRole('button', {name:'外观',exact:true}).click()
  await page.locator('.dshAppearance__background').waitFor()
  const png = await page.evaluate(() => { const c=document.createElement('canvas');c.width=1200;c.height=800;const x=c.getContext('2d');const g=x.createLinearGradient(0,0,1200,800);g.addColorStop(0,'#006c88');g.addColorStop(.5,'#cc8844');g.addColorStop(1,'#553366');x.fillStyle=g;x.fillRect(0,0,1200,800);const pixels=x.getImageData(0,0,1200,800);let seed=42;for(let i=0;i<pixels.data.length;i++){if(i%4===3)continue;seed=(Math.imul(seed,1664525)+1013904223)|0;pixels.data[i]=Math.max(0,Math.min(255,pixels.data[i]+(seed>>>27)-16))}x.putImageData(pixels,0,0);return c.toDataURL() })
  assert.ok(png.length > 1048576,'fixture must exceed Chromium custom-property limit')
  await page.locator('.dshAppearance input[type=file]').setInputFiles({name:'background.png',mimeType:'image/png',buffer:Buffer.from(png.split(',')[1],'base64')})
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-dsh-background-chat'))
  for(const name of ['标题栏','左边导航栏','侧边栏区域']) await page.getByRole('checkbox',{name:'在'+name+'显示',exact:true}).check()
  const total = page.getByRole('slider',{name:'图片总透明度',exact:true})
  await total.fill('25'); await total.dispatchEvent('pointerup')
  const blur = page.getByRole('slider',{name:'图片模糊程度',exact:true})
  assert.equal(await total.evaluate(el => el.closest('label').nextElementSibling.querySelector('input')?.getAttribute('aria-label')), '图片模糊程度')
  assert.equal(await blur.inputValue(), '0', 'existing settings default to a sharp background')
  await blur.fill('65')
  assert.equal(await page.evaluate(() => document.body.style.getPropertyValue('--dsh-background-blur')), '26px')
  assert.equal((await values(page))['desktop-appearance'].backgroundBlur, undefined, 'drag previews before saving')
  await blur.dispatchEvent('pointerup')
  const left = page.getByRole('slider',{name:'左边导航栏底色透明度',exact:true})
  await left.fill('60'); await left.dispatchEvent('pointerup')
  await page.waitForFunction(() => window.__SETTINGS_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value.backgroundLeftSurfaceTransparency === 60)
  const expected=(await values(page))['desktop-appearance']
  assert.equal(expected.backgroundImage,png)
  assert.equal(expected.backgroundTransparency,25)
  assert.equal(expected.backgroundBlur,65)
  assert.equal(await page.locator('[data-conversation-region=chat]').evaluate(e=>getComputedStyle(e.parentElement).backgroundColor),'rgba(0, 0, 0, 0)')
  assert.equal(await page.locator('[data-slot=sidebar] > [class*=_root]').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)')
  for(const selector of ['.dshTb','[class*=_sidebarCol]','[class*=_centerCol]']) assert.match(await page.locator(selector).evaluate(e=>getComputedStyle(e).backgroundImage),/blob:/)
  for(const selector of ['.dshTb','[class*=_sidebarCol]','[class*=_centerCol]']) {
    assert.deepEqual(await page.locator(selector).evaluate(e => ({filter:getComputedStyle(e).filter, blur:getComputedStyle(e,'::before').backdropFilter})), {filter:'none',blur:'blur(26px)'})
  }
  assert.ok(Math.abs(await page.evaluate(()=>Number(document.body.style.getPropertyValue('--dsh-background-left-opacity')))-.4)<.001)
  await page.screenshot({path:join(root,'settings.png'),fullPage:true})
  console.log('PASS: upload, region switches, live transparency and unobstructed backgrounds')
  await page.reload(); await ready(page,page.url())
  assert.deepEqual((await values(page))['desktop-appearance'],expected)
  await page.waitForFunction(()=>document.documentElement.hasAttribute('data-dsh-background-left'))
  await page.locator('[data-sidebar-right-expand]').click()
  await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').waitFor()
  const right = page.locator('[data-sidebar-right-panel][data-sidebar-right-open] [data-dockkit-host]').first()
  assert.match(await right.evaluate(e=>getComputedStyle(e).backgroundImage), /blob:/)
  assert.equal(await right.evaluate(e=>getComputedStyle(e,'::before').backdropFilter), 'blur(26px)')
  assert.equal(await right.locator('[data-dockkit-strip-chrome]').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)')
  await page.screenshot({path:join(root,'background.png'),fullPage:true})
  // Verify actual pixels with a large image, rather than only CSS declarations.
  const set = (field,value) => page.evaluate(([field,value])=>window.__SETTINGS_SMOKE__.configForms.get('desktop-appearance').set(field,value),[field,value])
  async function pixel() {
    const buffer=await page.screenshot({clip:{x:100,y:200,width:1,height:1}})
    return page.evaluate(async data=>{const img=new Image();img.src=data;await img.decode();const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.drawImage(img,0,0);return [...x.getImageData(0,0,1,1).data].slice(0,3)},'data:image/png;base64,'+buffer.toString('base64'))
  }
  await set('backgroundRightSurfaceTransparency',100);await set('backgroundTransparency',0)
  await set('backgroundBlur',0)
  async function detail() {
    const buffer = await page.screenshot({clip:{x:100,y:200,width:32,height:32}})
    return page.evaluate(async data => {
      const image = new Image();image.src=data;await image.decode()
      const canvas=document.createElement('canvas');canvas.width=canvas.height=32
      const context=canvas.getContext('2d');context.drawImage(image,0,0)
      const pixels=context.getImageData(0,0,32,32).data
      let difference=0
      for(let y=0;y<32;y++)for(let x=0;x<31;x++)for(let channel=0;channel<3;channel++) {
        const i=(y*32+x)*4+channel;difference+=Math.abs(pixels[i]-pixels[i+4])
      }
      return difference/(32*31*3)
    }, 'data:image/png;base64,'+buffer.toString('base64'))
  }
  const sharpDetail=await detail()
  await set('backgroundBlur',100)
  const blurredDetail=await detail()
  assert.ok(sharpDetail>1 && blurredDetail<sharpDetail*.35, JSON.stringify({sharpDetail,blurredDetail}))
  await page.screenshot({path:join(root,'blurred-background.png'),fullPage:true})
  await set('backgroundBlur',0)
  assert.equal(await detail(),sharpDetail,'zero restores the original image pixels')
  console.log('PASS: blur slider order, live preview, saved setting and actual image detail reduction without filtering content')
  const visible=await pixel()
  assert.notDeepEqual(visible,[255,255,255])
  await set('backgroundRightSurfaceTransparency',0)
  assert.deepEqual(await pixel(),[255,255,255])
  await set('backgroundRightSurfaceTransparency',100);await set('backgroundTransparency',100)
  assert.deepEqual(await pixel(),[255,255,255])
  await page.evaluate(()=>window.__SETTINGS_SMOKE__.configForms.get('ui-theme').set('preference','dark'))
  await page.waitForFunction(()=>document.body.hasAttribute('data-ds-dark-theme'))
  assert.deepEqual(await pixel(),[0,0,0])
  await set('backgroundTransparency',0)
  assert.deepEqual(await pixel(),visible)
  await page.screenshot({path:join(root,'dark-background.png'),fullPage:true})
  await page.locator('[data-sidebar-right-panel][data-sidebar-right-open] [data-sidebar-right-toggle]').first().click()
  await set('backgroundChatSurfaceTransparency',100)
  assert.deepEqual(await pixel(),visible)
  await page.screenshot({path:join(root,'dark-conversation.png'),fullPage:true})
  await page.evaluate(()=>window.__SETTINGS_SMOKE__.configForms.get('ui-theme').set('preference','light'))
  await set('backgroundChatSurfaceTransparency',0)
  assert.deepEqual(await pixel(),[255,255,255])
  await set('backgroundTransparency',25);await set('backgroundChatSurfaceTransparency',70);await set('backgroundRightSurfaceTransparency',70)
  await set('backgroundBlur',65)
  expected.backgroundChatSurfaceTransparency=70;expected.backgroundRightSurfaceTransparency=70
  console.log('PASS: large-image pixels, independent surface alpha, light/dark canvas and theme switching')
  stop();const secondUrl=await start(); await ready(page,secondUrl)
  assert.deepEqual((await values(page))['desktop-appearance'],expected)
  console.log('PASS: background settings and embedded image survive host restart on a new origin')
  await page.evaluate(()=>window.__SETTINGS_SMOKE__.configForms.get('desktop-appearance').set('backgroundImage',''))
  await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-dsh-background-chat'))
  assert.equal(await page.locator('[class*=_sidebarCol]').evaluate(e=>getComputedStyle(e).backgroundImage),'none')
  assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-dsh-background-blur')),false)
  assert.deepEqual(pageErrors,[])
  console.log('PASS: removal restores normal surfaces; no browser errors')
  report.checks={upload:true,regions:true,transparency:true,blur:true,restart:true,remove:true,noPageErrors:true}
} catch (error) {
  report.error = error.stack
  throw error
} finally {
  await writeFile(join(root, 'last-host.log'), output)
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  stop()
  console.log('Evidence: ' + join(root, 'report.json'))
}
