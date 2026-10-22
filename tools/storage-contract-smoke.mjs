// Verify the installed persistence contract with real services in separate
// processes. Never mount a user profile or send model requests.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve,join } from 'node:path'
import { mkdtemp,writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
const entry=process.env.DSH_DESKTOP_DSH_BIN||join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const require=createRequire(entry)
const load=name=>import(pathToFileURL(require.resolve(name)).href)
const {Context}=await load('@deepseek-ai/cordis')
const backend=await load('@deepseek-ai/dsh-session-persistence-jsonl')
const {SESSION_FORMAT_VERSION}=await load('@deepseek-ai/dsh-session')
const mode=process.argv[2]
if(mode==='contender') {
  const ctx=new Context()
  let mounted
  try {
    mounted=ctx.plugin(backend,{root:process.argv[3]});await mounted.await()
    if(process.argv[4]==='other-session') {
      const handle=await ctx.sessionPersistence.create({version:SESSION_FORMAT_VERSION,id:'independent-session',createdAt:Date.now(),isSeeded:false})
      await handle.flush();await handle.close()
      process.stdout.write('other-session-created')
    } else {
      try {const handle=await ctx.sessionPersistence.open('locked-session','write');await handle.close();process.stdout.write('unexpected-write-access')}
      catch(error) {process.stdout.write(error.constructor.name)}
    }
  } finally {await mounted?.dispose()}
} else {
  const root=await mkdtemp(resolve('src-tauri/target/storage-contract-')),store=join(root,'sessions'),ctx=new Context()
  const report={schema:1,root,sessionSchema:SESSION_FORMAT_VERSION,checks:[],limitations:[]}
  let mounted
  async function contender(action) {
    const child=spawn(process.execPath,[resolve('tools/storage-contract-smoke.mjs'),'contender',store,action],{windowsHide:true,stdio:['ignore','pipe','pipe']})
    let stdout='',stderr=''
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk)
    const timer=setTimeout(()=>child.kill(),10000)
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
    clearTimeout(timer);assert.equal(code,0,stderr)
    return stdout
  }
  try {
    mounted=ctx.plugin(backend,{root:store});await mounted.await()
    const writer=await ctx.sessionPersistence.create({version:SESSION_FORMAT_VERSION,id:'locked-session',createdAt:Date.now(),isSeeded:false})
    await ctx.sessionPersistence.flush()
    assert.equal((await ctx.sessionPersistence.list()).length,1)
    assert.match(await contender('same-session'),/SessionAlreadyOwnedError/)
    report.checks.push('service flush materializes empty sessions; another process cannot write the owned session')
    assert.equal(await contender('other-session'),'other-session-created')
    report.limitations.push('a per-session write lease does not exclude a different process creating another session in the same root')
    await writer.close()
    assert.equal(await contender('same-session'),'unexpected-write-access')
    report.checks.push('kernel write lease releases after owner close; the next process can acquire it')
    assert.equal((await ctx.sessionPersistence.list()).length,2)
    report.limitations.push('flush covers active handles in this service instance; no global data-root snapshot barrier')
    report.limitations.push('session schema 4 plus separate attachment/config stores must be checkpointed before candidate migration')
    console.log('PASS: actual cross-process session ownership and flush; root-wide exclusivity is unavailable')
  } catch(error) {report.error=error.message;throw error}
  finally {await mounted?.dispose();await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log('Artifacts: '+root)}
}
