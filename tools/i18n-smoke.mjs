/** Real DSH locale switching, draft preservation and persistence in an isolated home.
 * Usage: node tools/i18n-smoke.mjs
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
const root = await mkdtemp(resolve('src-tauri/target/i18n-smoke-'))
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
  factory: () => ({ inject: ['configForms', 'slots', 'locale'], apply(ctx) { window.__SETTINGS_SMOKE__ = ctx } }),
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
try {
  const url = await start()
  browser = await chromium.launch({channel:'msedge',headless:true})
  const page = await browser.newPage({locale:'zh-CN',viewport:{width:1280,height:840}})
  const errors=[]; page.on('pageerror', e=>errors.push(e.message))
  await ready(page,url)
  await page.waitForFunction(()=>window.__DSH_I18N__?.locale === 'zh')
  await page.getByRole('button',{name:'继续',exact:true}).click()
  await page.getByRole('button',{name:'稍后配置',exact:true}).click()
  await page.evaluate(()=>document.dispatchEvent(new CustomEvent('dsh-desktop:set-ui-mode',{detail:{mode:'desktop'}})))
  await page.keyboard.press('Control+Alt+,')
  await page.getByRole('button',{name:'外观',exact:true}).click()
  await page.screenshot({path:root+'/initial.png'})
  assert.match(await page.locator('[data-shortcut-modal=settings]').innerText(), /背景图片/)
  await page.evaluate(()=>window.__SETTINGS_SMOKE__.locale.setLocale('en'))
  await page.waitForFunction(()=>window.__DSH_I18N__.locale === 'en')
  await page.screenshot({path:root+'/english.png'})
  assert.doesNotMatch(await page.locator('[data-shortcut-modal=settings]').innerText(), /[\u3400-\u9fff]/)
  console.log('PASS: live appearance translation including background regions')
  assert.equal(await page.evaluate(()=>window.__DSH_I18N__.t('外观')),'Appearance')
  await page.evaluate(() => {
    const saved={version:1,enabled:false,bindAddress:'192.168.1.10',port:13080,trustedHosts:[]}
    window.__DSH_REMOTE_IDENTITY__='test'
    window.__TAURI__={core:{invoke:async command=>{
      if(command==='remote_status') return {saved,active:saved,state:'disabled',instance:'test'}
      if(command==='remote_lan_addresses') return [{address:'192.168.1.10',name:'Ethernet'}]
      if(command==='desktop_locale_changed') return
      throw Error('Unexpected command: '+command)
    }}}
  })
  await page.getByRole('button',{name:'Remote control',exact:true}).click()
  await page.locator('#dsh-remote-port').fill('14080')
  await page.evaluate(()=>window.__SETTINGS_SMOKE__.locale.setLocale('zh'))
  await page.getByRole('button',{name:'应用并重启 DSH',exact:true}).waitFor()
  assert.equal(await page.locator('#dsh-remote-port').inputValue(),'14080')
  await page.evaluate(()=>window.__SETTINGS_SMOKE__.locale.setLocale('en'))
  await page.getByRole('button',{name:'Apply and restart DSH',exact:true}).waitFor()
  assert.equal(await page.locator('#dsh-remote-port').inputValue(),'14080')
  assert.doesNotMatch(await page.locator('.dshRemote').innerText(), /[\u3400-\u9fff]/)
  console.log('PASS: remote control switches both ways without losing unsaved port')
  await page.getByRole('button',{name:'Plugins',exact:true}).click()
  await page.getByRole('tab',{name:'Built-in plugins',exact:true}).click()
  await page.getByText('Desktop notifications',{exact:true}).waitFor()
  assert.doesNotMatch(await page.locator('.dshPlugins.dshInventory').innerText(), /[\u3400-\u9fff]/)
  console.log('PASS: built-in plugin names and descriptions translate')
  await page.reload()
  await ready(page,page.url())
  await page.waitForFunction(()=>window.__DSH_I18N__.locale==='en')
  await page.evaluate(()=>window.__SETTINGS_SMOKE__.locale.setLocale('zh'))
  await page.waitForFunction(()=>window.__DSH_I18N__.locale==='zh')
  await page.reload(); await ready(page,page.url())
  await page.waitForFunction(()=>window.__DSH_I18N__.locale==='zh')
  console.log('PASS: language persists across reload in both directions')
  assert.deepEqual(errors,[])
  console.log('ROOT',root)
} finally { await browser?.close(); stop(); await writeFile(join(root,'host.log'),output) }
