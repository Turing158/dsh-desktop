// Real DSH maintenance dialogs and local error page in disposable homes. Native IPC is
// mocked here; Rust tests validate the actual report/export implementation.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { handleOnboarding, dismissInitialWelcome, openDshSettings, openDshMaintenance, offlineModelPatch } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const resumeBackup=process.env.DSH_DIAGNOSTICS_RESUME
const root = resumeBackup ? resolve(resumeBackup) : await mkdtemp(resolve('src-tauri/target/diagnostics-'))
if (resumeBackup && !root.startsWith(resolve('src-tauri/target/diagnostics-'))) throw Error('diagnostics resume directory must be an isolated diagnostics fixture')
const home = join(root,'home'), probe = join(root,'probe')
await mkdir(home,{recursive:true}); await mkdir(probe,{recursive:true})
await writeFile(join(probe,'package.json'), '{"name":"@dsh-desktop/diagnostics-smoke","type":"module","main":"index.js","exports":{".":"./index.js","./client":"./client.js"},"dsh":{"client":{"platform":"web"}}}')
await writeFile(join(probe,'index.js'), 'export function apply() {}')
await writeFile(join(probe,'client.js'), "window.__ModuleLoader__.load({id:'@dsh-desktop/diagnostics-smoke',factory:()=>({inject:['theme','locale','layout'],apply(ctx){window.diagnosticsContext=ctx}})})")
await writeFile(join(home,'settings.yaml'), 'desktop-appearance:\n  ui: vanilla\n  animation: off\n')
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml','utf8')).replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
const patchPath = join(root,'patch.yml')
await writeFile(patchPath, patch + offlineModelPatch + '\n- insert:\n    - id: desktop-diagnostics-smoke\n      name: ' + pathToFileURL(join(probe,'index.js')).href + '\n')
const bin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const child = spawn(process.execPath,[bin,'web','--patch',patchPath,'--no-open','--port','0'], { cwd:root, windowsHide:true, stdio:['ignore','pipe','pipe'], env:{...process.env, DSH_HOME:home, DSH_DESKTOP_DSH_BIN:bin, DSH_DESKTOP_CHANGES_DIR:join(root,'changes'), DSH_UI_SMOKE_KEY:'mock-key'} })
let output = '', browser, localServer, activePage
child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
const report = resumeBackup ? JSON.parse(await readFile(join(root,'report.json'),'utf8')) : { root, checks:[], errors:[] }
const pass = name => {if(!report.checks.includes(name))report.checks.push(name); console.log('PASS: ' + name)}
try {
  let url
  for(let i=0;i<400;i++) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if(url) break
    if(child.exitCode!==null) throw Error(output.slice(-3000))
    await new Promise(resolve => setTimeout(resolve,100))
  }
  assert.ok(url,'isolated DSH starts')
  const menuCheck = process.env.DSH_DIAGNOSTICS_MENU_CHECK === '1'
  browser = await chromium.launch({channel:'msedge',headless:true, args:menuCheck ? ['--remote-debugging-port=9222'] : []})
  const page = await browser.newPage({viewport:{width:1280,height:900},locale:'zh-CN'})
  activePage = page
  page.on('pageerror',error=>report.errors.push(error.message))
  await handleOnboarding(page)
  await page.addInitScript(() => {
    window.diagnosticCalls = []
    window.recoveryRequests = []
    window.__DSH_REMOTE_IDENTITY__ = {backendInstance:1, documentGeneration:1, windowGeneration:1, documentNonce:[]}
    window.__TAURI__ = {app:{getVersion:async()=> '0.1.4'},core:{invoke:async (command,args) => {
      window.diagnosticCalls.push(command)
      if(command==='desktop_diagnostics_export') return null
      if(command==='desktop_recovery_list') return {entries:window.recoveryFixture || [],unreadable:0}
      if(command==='desktop_recovery_restore') {window.recoveryRequests.push(args);return null}
      if(command==='desktop_backup_export') return 'C:\\isolated\\settings.dshbackup'
      if(command==='desktop_backup_inspect') return {manifest:{createdAt:Date.now(),dshVersion:'0.2.1-rc.2',scope:'partial',components:[{id:'desktop-preferences'}],excluded:['sessions','credentials']},supportedComponents:['desktop-preferences'],unsupportedComponents:[],reasonCode:'backup-restore-preview',canRestore:true,restoreHandle:'mock-restore-handle'}
      if(command.startsWith('desktop_diagnostics')) return {schema:1,observedAt:Date.now(),checkedAt:null,phase:{kind:'running'},runtime:{backendInstance:1,desktopVersion:'0.1.4',architecture:'x86_64',dshVersion:'0.2.1-rc.2',dshEntry:'C:\\isolated\\dsh\\lib\\bin.js',dshSource:'configured',backendLoaded:true},checks:[],incompleteOperations:[],unreadableJournals:0,inventory:{components:[]},capabilities:[{featureId:'runtime-rollback',availability:'unavailable',implementation:'desktop',pluginState:'unknown',reasonCodes:['runtime-explicitly-pinned'],evidence:[]}]}
      if(command==='check_dsh_update') return {current:'0.2.1-rc.2',latest:'0.2.1-rc.2',preview:'0.2.1-rc.2',stableUpdateAvailable:false}
      if(command==='check_desktop_update') return {current:'0.1.4',release:null}
      if(command==='remote_status') return {frontendVersion:'0.2.1-rc.2'}
      return false
    }}}
  })
  await page.goto(url)
  await page.waitForFunction(()=>window.diagnosticsContext)
  if (!resumeBackup) await dismissInitialWelcome(page)
  await page.keyboard.press('Escape')
  await openDshSettings(page)
  const settingsNav = page.locator('[data-shortcut-modal="settings"] nav')
  assert.equal(await settingsNav.getByRole('button',{name:/^(诊断|备份与恢复|兼容性|Diagnostics|Backup and restore|Compatibility)$/}).count(),0)
  await page.keyboard.press('Escape')
  await page.locator('[data-shortcut-modal="settings"]').waitFor({state:'hidden'})
  pass('settings navigation no longer contains diagnostics, compatibility or backup and restore')
  if (!resumeBackup) {
  await openDshMaintenance(page,'diagnostics')
  await page.getByText('实际 dsh 版本',{exact:true}).waitFor()
  assert.ok(await page.getByText('0.2.1-rc.2',{exact:true}).count())
  assert.equal(await page.getByRole('dialog').count(),1)
  assert.equal(await page.locator('[data-shortcut-modal="settings"]').count(),0)
  pass('More opens an independent diagnostics dialog in vanilla appearance')
  await page.getByRole('button',{name:'关闭弹窗',exact:true}).click()
  await page.locator('.dshMaintenance__dialog').waitFor({state:'hidden'})
  await openDshMaintenance(page,'diagnostics')
  await page.keyboard.press('Escape')
  await page.locator('.dshMaintenance__dialog').waitFor({state:'hidden'})
  await openDshMaintenance(page,'diagnostics')
  await page.mouse.click(1100,800)
  await page.locator('.dshMaintenance__dialog').waitFor({state:'hidden'})
  await openDshMaintenance(page,'diagnostics')
  pass('maintenance dialogs close with their button, Escape and backdrop and reopen from More')
  if(menuCheck) {
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.__DSH_APPEARANCE__?.setUiMode?.('desktop'))
    await page.locator('.dshTb__item').filter({hasText:'更多'}).click()
    await page.getByRole('menuitem',{name:'切换新样式',exact:false}).click()
    const code = await new Promise((resolveResult,reject) => {
      const check = spawn(process.execPath,[resolve('tools/check-menus.mjs')],{windowsHide:true,stdio:'inherit',env:{...process.env,CDP_PORT:'9222'}})
      check.on('error',reject); check.on('exit',resolveResult)
    })
    assert.equal(code,0,'existing menu regression passes against the isolated browser')
    pass('existing menu regression passes against the isolated desktop page')
    await openDshMaintenance(page,'diagnostics')
  }
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>window.diagnosticsContext.theme.setTheme(theme),theme)
    await page.screenshot({path:join(root,'diagnostics-'+theme+'.png')})
  }
  await page.getByRole('button',{name:'重新检测',exact:true}).click()
  await page.waitForFunction(()=>window.diagnosticCalls.includes('desktop_diagnostics_check'))
  await page.getByRole('button',{name:'导出诊断报告',exact:true}).click()
  await page.waitForFunction(()=>window.diagnosticCalls.includes('desktop_diagnostics_export'))
  pass('check and cancelled native export use the maintenance API')
  assert.equal(await page.getByRole('button',{name:'兼容性',exact:true}).count(),0)
  const featureStatus=page.locator('[data-dsh-feature-status]')
  assert.equal(await featureStatus.getAttribute('open'),null)
  await featureStatus.locator(':scope > summary').focus()
  await page.keyboard.press('Enter')
  await page.getByText('当前入口由 DSH_DESKTOP_DSH 固定。',{exact:true}).waitFor()
  pass('feature status is collapsed inside diagnostics and expands with the keyboard; standalone compatibility navigation is removed')
  await page.evaluate(()=>{
    const original=window.__TAURI__.core.invoke
    window.__TAURI__.core.invoke=async (command,args)=>{
      const value=await original(command,args)
      if(command.startsWith('desktop_diagnostics') && value?.capabilities) {
        value.capabilities.push({featureId:'ui-recovery',availability:'limited',implementation:'hybrid',pluginState:'enabled',scope:'current-interface',reasonCodes:['recovery-background-checkpoint-limits'],evidence:['ui-snapshot-service-selector'],verification:[{version:'0.2.1-rc.2',architecture:'x86_64',platform:'windows',date:'2026-10-21',nativeHostMocked:false,evidence:'tools/native-recovery-smoke.mjs',checks:['cold-draft-attachment-recovery']},{version:'0.2.1-rc.2',architecture:'x86_64',platform:'windows',date:'2026-10-21',nativeHostMocked:false,evidence:'tools/native-draft-checkpoint-smoke.mjs',checks:['background-draft-attachment-checkpoint']}]})
        value.capabilities.push({featureId:'session-changes-git',availability:'limited',implementation:'desktop',pluginState:'enabled',scope:'current-workspace',reasonCodes:['changes-workspace-not-git','changes-recording-coverage-limited'],evidence:['workspace-git-selector'],verification:[{version:'0.2.1-rc.2',architecture:'x86_64',platform:'windows',date:'2026-10-21',nativeHostMocked:false,evidence:'tools/native-diagnostics-smoke.mjs',checks:['workspace-git-selection']}]})
      }
      return value
    }
  })
  await page.getByRole('button',{name:'重新检测',exact:true}).click()
  await page.getByText('草稿与界面恢复',{exact:true}).waitFor()
  const recoveryCard=page.locator('[data-dsh-feature-id="ui-recovery"]')
  await recoveryCard.getByText('查看详情',{exact:true}).click()
  await recoveryCard.getByText('当前界面',{exact:true}).waitFor()
  await recoveryCard.getByText('跨重启草稿与附件恢复',{exact:true}).waitFor()
  await recoveryCard.getByText('后台草稿与附件检查点',{exact:true}).waitFor()
  await recoveryCard.getByText('后台保存稳定的语义草稿和附件；不包含文件编辑缓冲与终端，最后一个检查点后的输入可能无法恢复。',{exact:true}).waitFor()
  pass('compatibility distinguishes current interface contracts from exact-version isolated verification')
  const changesCard=page.locator('[data-dsh-feature-id="session-changes-git"]')
  await changesCard.getByText('查看详情',{exact:true}).click()
  await changesCard.getByText('当前工作区',{exact:true}).waitFor()
  await changesCard.getByText('当前工作区不在 Git 仓库中；会话更改记录仍可使用。',{exact:true}).waitFor()
  await changesCard.getByText('Git 与非仓库工作区切换',{exact:true}).waitFor()
  await page.screenshot({path:join(root,'compatibility.png')})
  await page.evaluate(()=>window.diagnosticsContext.locale.setLocale('en'))
  await page.getByText('Actual dsh version',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Compatibility',exact:true}).count(),0)
  await featureStatus.locator(':scope > summary').getByText('Feature status',{exact:true}).waitFor()
  pass('compatibility limitations and English diagnostics dialog render')
  const englishRecovery=page.locator('[data-dsh-feature-id="ui-recovery"]')
  await englishRecovery.getByText('Draft and attachment recovery after restart',{exact:true}).waitFor()
  await englishRecovery.getByText('Background draft and attachment checkpoints',{exact:true}).waitFor()
  pass('English verification records render their tested scope and native host evidence')
  const englishChanges=page.locator('[data-dsh-feature-id="session-changes-git"]')
  await englishChanges.getByText('Current workspace',{exact:true}).waitFor()
  await englishChanges.getByText('Switching between Git and non-repository workspaces',{exact:true}).waitFor()
  pass('Chinese and English workspace scope, environmental limits and verification render')
  await featureStatus.locator(':scope > summary').click()
  await page.screenshot({path:join(root,'diagnostics-en.png')})
  } else {
    await page.evaluate(()=>window.diagnosticsContext.locale.setLocale('en'))
  }
  const beforeBackup=await page.evaluate(()=>window.diagnosticCalls.filter(command=>command.startsWith('desktop_diagnostics')).length)
  await openDshMaintenance(page,'backup')
  assert.equal(await page.getByRole('dialog').count(),1)
  assert.equal(await page.getByRole('heading',{name:'Diagnostics',exact:true}).count(),0)
  assert.equal(await page.locator('[data-shortcut-modal="settings"]').count(),0)
  pass('More switches directly between independent maintenance dialogs without opening settings')
  if (!report.checks.includes('partial backup scope, export and verified preview remain explicit in English')) {
  await page.getByRole('heading',{name:'Configuration backup and restore',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Check again',exact:true}).count(),0)
  assert.equal(await page.getByText('Complete backup still requires verified storage mapping and consistency. Current component status is shown below.',{exact:true}).count(),0)
  assert.equal(await page.evaluate(()=>window.diagnosticCalls.filter(command=>command.startsWith('desktop_diagnostics')).length),beforeBackup)
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>window.diagnosticsContext.theme.setTheme(theme),theme)
    await page.screenshot({path:join(root,'backup-en-'+theme+'.png')})
  }
  pass('backup actions load directly without diagnostics controls, report dependency or unfinished component placeholders')
  await page.getByRole('button',{name:'Export partial backup',exact:true}).click()
  await page.getByText('Backup saved: C:\\isolated\\settings.dshbackup',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Verify backup file',exact:true}).click()
  await page.getByText('Backup verified',{exact:true}).waitFor()
  const restoreButton=page.getByRole('button',{name:'Restore selected configuration',exact:true})
  await restoreButton.waitFor()
  assert.equal(await restoreButton.isEnabled(),false)
  await page.getByLabel('I have reviewed the scope. Restoration will replace selected preferences or switches and restart DSH.',{exact:true}).check()
  assert.equal(await restoreButton.isEnabled(),true)
  pass('partial backup scope, export and verified preview remain explicit in English')
  }
  if (!report.checks.includes('English cold terminal recovery explains the retained package and requires the explicit skip action')) {
  await page.evaluate(()=>{window.recoveryFixture=[{recoveryId:'terminal-fixture',createdAt:Date.now(),runtimeVersion:'0.2.1-rc.2',draftCount:1,providerCount:1,hasTerminalState:true,draftsOnly:false,canRestore:true}]})
  await openDshMaintenance(page,'backup')
  await page.getByRole('button',{name:'Refresh recovery records',exact:true}).click()
  const terminalRecovery=page.locator('[data-dsh-recovery-id="terminal-fixture"]')
  await terminalRecovery.getByText('The original terminal processes cannot be recovered after the app exits. You can skip terminal state and recover other contents. No new shells or commands are started, and the original package is retained.',{exact:true}).waitFor()
  assert.equal(await terminalRecovery.getByText('State providers: 1',{exact:true}).isVisible(),false)
  await terminalRecovery.getByText('Recovery record details',{exact:true}).evaluate(element=>element.click())
  await terminalRecovery.getByText('State providers: 1',{exact:true}).waitFor()
  await terminalRecovery.getByRole('button',{name:'Skip terminal state and recover other contents',exact:true}).evaluate(element=>element.click())
  assert.equal(await page.evaluate(()=>window.recoveryRequests.at(-1)?.skipTerminalState),true)
  pass('English cold terminal recovery explains the retained package and requires the explicit skip action')
  }
  await openDshMaintenance(page,'backup')
  await page.screenshot({path:join(root,'backup-en.png')})
  await page.evaluate(()=>window.diagnosticsContext.locale.setLocale('zh'))
  await page.getByRole('heading',{name:'配置备份与恢复',exact:true}).waitFor()
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>window.diagnosticsContext.theme.setTheme(theme),theme)
    await page.screenshot({path:join(root,'backup-zh-'+theme+'.png')})
  }
  await page.getByText('保存与恢复说明',{exact:true}).evaluate(element=>element.click())
  await page.getByText('日常检查点保存稳定的草稿和附件，每次写入至少间隔 30 秒；文件编辑与终端仅按维护恢复策略处理。',{exact:true}).waitFor()
  await page.getByText('保存与恢复说明',{exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:join(root,'backup-zh-details.png')})
  await page.getByText('保存与恢复说明',{exact:true}).evaluate(element=>element.click())
  await page.setViewportSize({width:768,height:900})
  await openDshMaintenance(page,'backup')
  await page.screenshot({path:join(root,'backup-zh-narrow.png')})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false)
  await page.setViewportSize({width:480,height:640})
  await openDshMaintenance(page,'backup')
  const bounds=await page.locator('.dshMaintenance__dialog').boundingBox()
  assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=480 && bounds.y+bounds.height<=640)
  await page.getByText('保存与恢复说明',{exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:join(root,'backup-zh-small.png')})
  assert.ok(await page.locator('.dshMaintenance__content>:last-child').evaluate(element=>element.scrollHeight>element.clientHeight && element.scrollTop>0))
  assert.equal(await page.getByRole('button',{name:'关闭弹窗',exact:true}).isVisible(),true)
  pass('backup and recovery dialogs render in both languages and themes and scroll within small windows')
  await page.setViewportSize({width:1280,height:900})
  await openDshMaintenance(page,'backup')
  await page.locator('.dshTb__item').filter({hasText:'更多'}).click()
  await page.getByRole('menuitem',{name:/^设置(\s|$)/}).click()
  await page.locator('[data-shortcut-modal="settings"]').waitFor()
  assert.equal(await page.locator('.dshMaintenance__dialog').count(),0)
  pass('opening Settings from More closes the maintenance dialog')
  await openDshMaintenance(page,'diagnostics')
  assert.equal(await page.getByRole('dialog').count(),1)
  assert.equal(await page.locator('[data-shortcut-modal="settings"]').count(),0)
  pass('opening diagnostics from More while Settings is open closes Settings')
  const mobile = await browser.newPage({viewport:{width:375,height:812}})
  await handleOnboarding(mobile); await mobile.goto(url); await mobile.waitForFunction(()=>window.diagnosticsContext)
  await mobile.keyboard.press('Escape'); await openDshSettings(mobile)
  assert.equal(await mobile.getByRole('button',{name:/^(诊断|备份与恢复|Diagnostics|Backup and restore)$/}).count(),0)
  assert.equal(await mobile.locator('.dshMaintenance__dialog').count(),0)
  assert.equal(await mobile.getByRole('button',{name:/导出诊断报告|Export diagnostics/}).count(),0)
  pass('ordinary browser exposes no desktop maintenance settings or diagnostic export')

  localServer = createServer(async (request,response) => {
    const files = {'/':'index.html','/main.js':'main.js','/style.css':'style.css'}
    const file = files[request.url]
    if(!file) {response.writeHead(404); response.end(); return}
    response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html')
    response.end(await readFile(join('src-tauri/ui',file)))
  })
  await new Promise(resolve=>localServer.listen(0,'127.0.0.1',resolve))
  const local = await browser.newPage()
  await local.addInitScript(() => {
    window.__TAURI__={core:{invoke:async command=>{
      if(command==='probe_state')return {phase:{kind:'failed',message:'missing dsh',details:[]}}
      if(command==='desktop_diagnostics_export')return null
      return {runtime:{desktopVersion:'0.1.4'},checks:[],incompleteOperations:[],unreadableJournals:0}
    }}}
  })
  await local.goto('http://127.0.0.1:'+localServer.address().port)
  await local.getByRole('button',{name:'查看诊断',exact:true}).click()
  await local.getByRole('heading',{name:'故障诊断',exact:true}).waitFor()
  await local.getByRole('button',{name:'导出诊断报告',exact:true}).click()
  await local.getByText('已取消导出',{exact:true}).waitFor()
  assert.equal(await local.getByRole('button',{name:'导出诊断报告',exact:true}).isDisabled(),false)
  pass('local failure diagnostics works without DSH and cancellation releases controls')
  await local.screenshot({path:join(root,'local-diagnostics.png')})
  assert.deepEqual(report.errors,[])
} finally {
  if(activePage) { await activePage.screenshot({path:join(root,'last-page.png')}).catch(()=>{}); await writeFile(join(root,'last-page.txt'),await activePage.locator('body').innerText().catch(()=>'')) }
  await browser?.close()
  if(localServer)await new Promise(resolve=>localServer.close(resolve))
  if(child.exitCode===null)try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  await writeFile(join(root,'host.log'),output)
  console.log('Artifacts: '+root)
}
