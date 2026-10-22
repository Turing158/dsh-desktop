// Real native IPC with isolated debug picker selections. Never touches a user
// profile, sends model requests or installs packages globally.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp,mkdir,writeFile,readFile,readdir } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { createServer } from 'node:net'
import { offlineModelPatch,handleOnboarding,dismissInitialWelcome,openDshMaintenance } from './dsh-ui-helpers.mjs'
const require = createRequire(import.meta.url)
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = await mkdtemp(resolve('src-tauri/target/native-backup-')),home = join(root,'home'),output = join(root,'exports')
await mkdir(home);await mkdir(output)
await writeFile(join(home,'cordis.patch.yml'),offlineModelPatch)
await writeFile(join(home,'desktop-settings.json'),JSON.stringify({version:1,namespaces:{'desktop-appearance':{ui:'vanilla',apiKey:'must-not-export'},other:{token:'must-not-export'}}}))
await writeFile(join(root,'dialog-selection.json'),JSON.stringify({folder:output,file:null}))
const server = createServer();await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
const port = server.address().port;await new Promise(resolve => server.close(resolve))
const bin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const child = spawn(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'),[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,
  DSH_HOME:home,DSH_UI_SMOKE_KEY:'mock-key',DSH_DESKTOP_SMOKE_DIR:root,DSH_DESKTOP_DSH:bin,DSH_DESKTOP_NODE:process.execPath,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}})
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms)),report = {root,checks:[]}
const pass = name => {report.checks.push(name);console.log('PASS: '+name)}
let browser,page
try {
  for(let i=0;i<400;i++) {
    if(child.exitCode!==null)throw Error('Desktop exited before ready')
    try {browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);break}catch{}
    await sleep(100)
  }
  assert.ok(browser)
  for(let i=0;i<400;i++) {
    page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:') && !p.url().includes(':1430'))
    if(page)break;await sleep(100)
  }
  assert.ok(page);page.setDefaultTimeout(20000)
  await handleOnboarding(page);await dismissInitialWelcome(page)
  await page.waitForFunction(()=>window.__DSH_REMOTE_IDENTITY__)
  let diagnostic
  for(let i=0;i<100;i++) {
    diagnostic=await page.evaluate(()=>window.__TAURI__.core.invoke('desktop_diagnostics',{identity:window.__DSH_REMOTE_IDENTITY__}))
    if(diagnostic.inventory.components.find(c=>c.id==='desktop-preferences').path)break
    await sleep(100)
  }
  await writeFile(join(root,'diagnostics.json'),JSON.stringify(diagnostic,null,2))
  assert.ok(diagnostic.inventory.components.find(c=>c.id==='desktop-preferences').path)
  await page.keyboard.press('Escape');await openDshMaintenance(page,'backup')
  await page.getByRole('button',{name:'导出部分备份',exact:true}).click()
  await page.getByText(/^备份已保存：/).waitFor()
  const [name] = await readdir(output);assert.ok(name.endsWith('.dshbackup'))
  const path=join(output,name),plain=await readFile(path)
  assert.equal(plain.subarray(0,8).toString(),'DSHBKP01');assert.equal(plain[8],0)
  await writeFile(join(root,'dialog-selection.json'),JSON.stringify({folder:output,file:path}))
  await page.getByRole('button',{name:'校验备份文件',exact:true}).click()
  await page.getByText('备份校验通过',{exact:true}).waitFor()
  const inspect=await page.evaluate(()=>window.__TAURI__.core.invoke('desktop_backup_inspect',{identity:window.__DSH_REMOTE_IDENTITY__}))
  assert.equal(inspect.manifest.scope,'partial');assert.equal(inspect.manifest.credentialPolicy,'exclude-credentials');assert.equal(inspect.canRestore,true)
  assert.ok(inspect.restoreHandle);assert.ok(inspect.supportedComponents.includes('desktop-preferences'))
  assert.ok(inspect.manifest.excluded.includes('sessions'));assert.ok(inspect.manifest.components.some(c=>c.id==='desktop-preferences'))
  assert.equal(JSON.stringify(inspect).includes('must-not-export'),false)
  pass('native settings export publishes a verified partial archive with explicit exclusions and no credential body')
  await page.getByLabel('使用密码加密或打开加密备份').check()
  await page.getByLabel('备份密码',{exact:true}).fill('密码测试-123')
  await page.getByRole('button',{name:'导出部分备份',exact:true}).click()
  await page.getByText(/^备份已保存：/).waitFor()
  const encryptedName=(await readdir(output)).find(item=>item!==name),encryptedPath=join(output,encryptedName)
  assert.equal((await readFile(encryptedPath))[8],1)
  await writeFile(join(root,'dialog-selection.json'),JSON.stringify({folder:output,file:encryptedPath}))
  await page.getByLabel('备份密码',{exact:true}).fill('wrong')
  await page.getByRole('button',{name:'校验备份文件',exact:true}).click()
  await page.getByText('密码不正确或备份已损坏，未修改当前数据。',{exact:true}).waitFor()
  await page.getByLabel('备份密码',{exact:true}).fill('密码测试-123')
  await page.getByRole('button',{name:'校验备份文件',exact:true}).click()
  await page.getByText('备份校验通过',{exact:true}).waitFor()
  assert.equal(await page.getByLabel('备份密码',{exact:true}).inputValue(),'')
  pass('Argon2id/AES-GCM export, wrong password rejection and correct password preview use real native commands')
  const denied=await page.evaluate(async()=>{
    const invoke=window.__TAURI__.core.invoke,identity=window.__DSH_REMOTE_IDENTITY__
    const reject=async args=>{try {await invoke('desktop_backup_export',args);return false}catch{return true}}
    return [await reject({identity:{...identity,backendInstance:9999},components:['desktop-preferences']}),await reject({identity,components:['sessions']})]
  })
  assert.deepEqual(denied,[true,true])
  await writeFile(join(root,'dialog-selection.json'),JSON.stringify({folder:null,file:null}))
  const cancelled=await page.evaluate(()=>window.__TAURI__.core.invoke('desktop_backup_inspect',{identity:window.__DSH_REMOTE_IDENTITY__}))
  assert.equal(cancelled,null)
  const saved=JSON.parse(await readFile(join(home,'desktop-settings.json'),'utf8'))
  assert.equal(saved.namespaces.other.token,'must-not-export')
  const records=await readdir(join(root,'maintenance/operations'))
  const journals=await Promise.all(records.filter(n=>n.endsWith('.json')).map(async n=>JSON.parse(await readFile(join(root,'maintenance/operations',n),'utf8'))))
  assert.equal(journals.filter(j=>j.kind==='backup' && j.stage==='complete').length,2)
  assert.equal(JSON.stringify(journals).includes('密码测试'),false)
  pass('stale identities and unsupported scope are rejected; cancelled preview preserves source configuration and successful journals')
  await page.screenshot({path:join(root,'backup.png')})
} catch(error) {
  report.error=error.message
  await page?.screenshot({path:join(root,'failure.png')}).catch(()=>{})
  if(page)await writeFile(join(root,'failure.txt'),await page.locator('body').innerText().catch(()=>''))
  throw error
} finally {
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  await writeFile(join(root,'command.json'),JSON.stringify({sequence:1,action:'quit'}))
  for(let i=0;i<50 && child.exitCode===null;i++)await sleep(100)
  if(child.exitCode===null) {try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}}
  await browser?.close().catch(()=>{});console.log('Artifacts: '+root)
}
