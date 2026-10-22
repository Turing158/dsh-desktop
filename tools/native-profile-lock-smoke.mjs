// Actual upstream profile lock protocol in a disposable directory. No backend,
// package install or user Profile is accessed by this check.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
const resume=process.env.DSH_PROFILE_LOCK_RESUME ? resolve(process.env.DSH_PROFILE_LOCK_RESUME) : null
if(resume)assert.ok(resume.startsWith(resolve('src-tauri/target')+'\\profile-lock-'))
const root=resume || await mkdtemp(resolve('src-tauri/target/profile-lock-'))
const bin=process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const request=join(root,'request.json'),lock=join(root,'package.json.lock'),report={root,checks:[]},children=[]
if(resume) {
  const previous=JSON.parse(await readFile(join(root,'report.json'),'utf8'));assert.equal(previous.root,root)
  assert.equal(previous.checks.length,3);report.checks.push(...previous.checks);report.reused=true
}
await writeFile(request,JSON.stringify({mode:'profile-lock',profileDirectory:root}))
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function pass(name) {report.checks.push(name);await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log('PASS: '+name)}
function start() {
  const child=spawn(process.execPath,[resolve('dsh-plugin/desktop-maintenance/providers.mjs'),request],{
    windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,DSH_DESKTOP_DSH_BIN:bin}})
  const item={child,output:'',error:''};children.push(item)
  child.stdout.on('data',data=>{item.output+=data});child.stderr.on('data',data=>{item.error+=data})
  return item
}
async function acquired(item) {
  const deadline=Date.now()+15000
  while(!item.output.includes('profile-locked\n')) {
    assert.equal(item.child.exitCode,null,item.error)
    if(Date.now()>deadline)throw Error('lock helper did not acquire')
    await sleep(25)
  }
  assert.equal(await readFile(lock,'utf8'),item.child.pid+'\n')
}
async function exited(item) {
  if(item.child.exitCode===null && item.child.signalCode===null)await new Promise(resolve=>item.child.once('exit',resolve))
}
try {
  if(!resume) {
  const first=start();await acquired(first)
  const second=start();await sleep(500)
  assert.equal(second.output,'');assert.equal(await readFile(lock,'utf8'),first.child.pid+'\n')
  await pass('live upstream holder excludes a competing Profile operation')
  first.child.stdin.end('release\n');await exited(first);await acquired(second)
  await pass('explicit release transfers ownership to the waiting operation')
  second.child.kill();await exited(second)
  assert.equal(await readFile(lock,'utf8'),second.child.pid+'\n')
  const next=start();await acquired(next);next.child.stdin.end('release\n');await exited(next)
  await assert.rejects(readFile(lock),{code:'ENOENT'})
  await pass('forced helper exit leaves an exited PID; upstream safely takes over and removes its owned lock')
  }
} catch(error) {report.error=error.message;throw error}
finally {
  for(const item of children)if(item.child.exitCode===null && item.child.signalCode===null){item.child.kill();await exited(item)}
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log('Artifacts: '+root)
}
