// Native request/Runtime/provider binding using a previously frozen version.
// No re-freeze, npm installation, update or selection change.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { offlineModelPatch } from './dsh-ui-helpers.mjs'

const root=resolve(process.env.DSH_RUNTIME_PROFILE_RESUME || 'src-tauri/target/runtime-profile-qnm6lB')
const report=JSON.parse(await readFile(join(root,'report.json'),'utf8'))
const evidenceRoot=report.evidenceRoot
const evidence=JSON.parse(await readFile(join(evidenceRoot,'report.json'),'utf8'))
const home=join(root,'custom home'),overlay=join(root,'overlay.yml')
const save=()=>writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
const name='native preflight binds actual Runtime and provider anchor and leaves selection unchanged'
if (report.checks.includes(name)) {console.log('REUSE: '+name);process.exit(0)}
let child,original
const server=createServer()
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const port=server.address().port
await new Promise(resolve=>server.close(resolve))
try {
  original=await readFile(join(home,'cordis.patch.yml'),'utf8')
  if (!original.includes(offlineModelPatch)) await writeFile(join(home,'cordis.patch.yml'),original+offlineModelPatch)
  const selection=await readFile(join(evidenceRoot,'runtime/selection.json'),'utf8')
  await writeFile(join(evidenceRoot,'state.json'),'{}')
  await writeFile(join(evidenceRoot,'command.json'),'{}')
  child=spawn(resolve('src-tauri/target/debug/deepseek-harness-desktop.exe'),[],{cwd:root,windowsHide:true,stdio:'ignore',
    env:{...process.env,DSH_HOME:home,DSH_DESKTOP_SMOKE_DIR:evidenceRoot,DSH_DESKTOP_DSH:evidence.realBin,
      DSH_DESKTOP_NODE:evidence.runtime.node_exe,DSH_UI_SMOKE_KEY:'mock-key',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}})
  async function wait(fn,label,timeout=90000) {
    const end=Date.now()+timeout
    while(Date.now()<end) {
      if(child.exitCode!==null)throw Error('desktop exited: '+label)
      try{const value=await fn();if(value)return value}catch{}
      await new Promise(resolve=>setTimeout(resolve,150))
    }
    throw Error('timeout: '+label)
  }
  await wait(async()=>{const s=JSON.parse(await readFile(join(evidenceRoot,'state.json'),'utf8'));return s.backend==='running' && s.loaded},'native source startup')
  const resultPath=join(evidenceRoot,'runtime-profile-verified.json')
  await writeFile(resultPath,'{}')
  await writeFile(join(evidenceRoot,'command.json'),JSON.stringify({sequence:Date.now(),action:'runtime-profile-verify',target:evidence.runtime,overlays:[overlay]}))
  const result=await wait(async()=>{const r=JSON.parse(await readFile(resultPath,'utf8'));return (r.verification || r.error) && r},'native profile verification',180000)
  assert.ok(!result.error,result.error)
  assert.equal(result.verification.schema,1);assert.equal(result.verification.bundleCount,3);assert.equal(result.verification.dataMigration,'unverified')
  assert.equal(await readFile(join(evidenceRoot,'runtime/selection.json'),'utf8'),selection)
  const state=JSON.parse(await readFile(join(evidenceRoot,'state.json'),'utf8'))
  assert.equal(state.backend,'running');assert.equal(state.runtime.source,'configured')
  report.nativeVerification=result.verification
  if (report.nativeError) (report.previousFailures ||= []).push(report.nativeError)
  delete report.nativeError
  report.checks.push(name);await save();console.log('PASS: '+name)
} catch(error) {report.nativeError=error.stack;await save();throw error}
finally {
  if(child?.pid && child.exitCode===null) {
    await writeFile(join(evidenceRoot,'command.json'),JSON.stringify({sequence:Date.now(),action:'quit'}))
    const end=Date.now()+10000
    while(child.exitCode===null && Date.now()<end)await new Promise(resolve=>setTimeout(resolve,100))
    if(child.exitCode===null)try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}
  }
  if (original!==undefined) await writeFile(join(home,'cordis.patch.yml'),original)
  console.log('Artifacts: '+root)
}
