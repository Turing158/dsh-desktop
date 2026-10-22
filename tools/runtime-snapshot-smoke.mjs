// Full-copy and offline-start evidence for the actual runtime. Isolated roots,
// no npm install, no model calls, no production selection or data mutation.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { freezeRuntimeClosure,inspectRuntimeTree } from './runtime-snapshot.mjs'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

const root = await mkdtemp(resolve('src-tauri/target/runtime-snapshot-'))
const source = process.env.DSH_RUNTIME_SOURCE || join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh')
const reuse = process.env.DSH_RUNTIME_SNAPSHOT_REUSE
const frozen = reuse ? join(resolve(reuse),'runtime') : join(root,'runtime'), home = join(root,'home'), probe = join(root,'probe'), cache=join(root,'native-cache')
const report = {schema:1,checks:[],root,source}
let child
try {
  console.log('Inspecting and freezing the installed dependency tree…')
  const snapshot = reuse ? JSON.parse(await readFile(join(resolve(reuse),'manifest.json'),'utf8')) : await freezeRuntimeClosure(source,frozen)
  if(reuse) {
    const tree=await inspectRuntimeTree(frozen)
    assert.equal(tree.files.length,snapshot.files.length)
    for(let offset=0;offset<snapshot.files.length;offset+=24)await Promise.all(snapshot.files.slice(offset,offset+24).map(async file=>{
      const digest=createHash('sha256')
      for await(const chunk of createReadStream(join(frozen,file.path)))digest.update(chunk)
      assert.equal(digest.digest('hex'),file.sha256,'reused file checksum')
    }))
  }
  await writeFile(join(root,'manifest.json'),JSON.stringify(snapshot,null,2))
  report.files = snapshot.files.length; report.bytes = snapshot.totalBytes; report.fingerprint = snapshot.fingerprint
  report.checks.push('all installed files copied and SHA-256 matched; dependency edges stay inside the frozen tree')
  console.log('Frozen '+snapshot.files.length+' files; verifying offline startup…')
  await mkdir(home); await mkdir(probe)
  const packageRoot=join(frozen,snapshot.packagePath)
  const entry = join(packageRoot,'lib/bin.js'), require = createRequire(entry)
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const resolution = await boot.createRuntimeResolution({installAnchor:join(packageRoot,'package.json'),home})
  assert.ok(resolution.entries.length)
  for(const row of resolution.entries) assert.ok(resolve(row.packageDir).startsWith(frozen+'\\') || resolve(row.packageDir).startsWith(frozen+'/'),'upstream install anchor stays frozen')
  report.resolvedPackages = resolution.entries.length
  await writeFile(join(probe,'package.json'),JSON.stringify({name:'@dsh-desktop/runtime-verification',type:'module',main:'index.js'}))
  await writeFile(join(probe,'index.js'),`import {writeFile} from 'node:fs/promises'
export const inject = ['sessionPersistence','attachments','profileContext']
export async function apply(ctx) {
  const persistence = ctx.sessionPersistence, attachments = ctx.attachments
  await persistence.flush()
  await writeFile(${JSON.stringify(join(root,'providers.json'))},JSON.stringify({
    sessionRoot:persistence.root,attachmentRoot:attachments.root,profileHome:ctx.profileContext.home,
    profileDirectory:ctx.profileContext.dir,installAnchor:ctx.profileContext.installAnchor,
    sessionFlush:true,rootLockAvailable:typeof persistence.snapshot==='function',
  },null,2))
}
`)
  const guard = join(root,'offline-guard.cjs')
  await writeFile(guard,`const {registerHooks,isBuiltin}=require('node:module')
const {fileURLToPath}=require('node:url'), fs=require('node:fs'), path=require('node:path'), net=require('node:net')
const roots=${JSON.stringify([frozen,home,probe,cache])}, resolved=new Set(), blocked=[]
registerHooks({resolve(specifier,context,next){
 const result=next(specifier,context)
 if(result.url.startsWith('file:')) {
  const file=fs.realpathSync(fileURLToPath(result.url))
  if(!roots.some(root=>{const rel=path.relative(root,file);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel))}))throw Error('runtime-resolution-escaped')
  resolved.add(file)
 }
 return result
}})
const connect=net.Socket.prototype.connect
net.Socket.prototype.connect=function(...args){
 const first=args[0], options=Array.isArray(first)?first[0]:first
 const host=typeof options==='object'?options.host:(typeof args[1]==='string'?args[1]:'localhost')
 if(host&&!['127.0.0.1','localhost','::1'].includes(host)){blocked.push('outbound-network');throw Error('offline-network-denied')}
 return connect.apply(this,args)
}
setInterval(()=>fs.writeFileSync(${JSON.stringify(join(root,'offline.json'))},JSON.stringify({resolvedFiles:resolved.size,blocked})),200).unref()
`)
  const patch = join(root,'patch.yml')
  await writeFile(patch,'- insert:\n    - id: desktop-runtime-verification\n      name: '+pathToFileURL(join(probe,'index.js')).href+'\n')
  child = spawn(process.execPath,['--require',guard,entry,'web','--patch',patch,'--no-open','--port','0'],{
    cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_HOME:home,NODE_PATH:'',DSH_TELEMETRY:'0',NARB_NATIVE_CACHE_DIR:cache},
  })
  let output=''
  child.stdout.on('data',chunk=>{output=(output+chunk).slice(-16000)})
  child.stderr.on('data',chunk=>{output=(output+chunk).slice(-16000)})
  for(let i=0;i<600 && !output.includes('dsh web: http');i++) {
    if(child.exitCode!==null) {await writeFile(join(root,'startup.txt'),output); throw Error('frozen startup failed: '+output.slice(-2500))}
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  assert.match(output,/dsh web: http/,'frozen runtime reaches readiness with outbound networking denied')
  const providers=JSON.parse(await readFile(join(root,'providers.json'),'utf8'))
  assert.equal(providers.sessionRoot,join(home,'sessions'))
  assert.equal(providers.attachmentRoot,join(home,'attachments/v1'))
  assert.equal(providers.installAnchor,join(packageRoot,'package.json'))
  const offline=JSON.parse(await readFile(join(root,'offline.json'),'utf8'))
  assert.ok(offline.resolvedFiles>100)
  assert.equal(offline.blocked.length,0,'startup does not require outbound networking')
  report.providers=providers; report.offline=offline
  report.checks.push('upstream runtime resolution and actual module loads remain inside frozen runtime and isolated profile')
  report.checks.push('isolated web backend starts with outbound networking denied; actual session/attachment roots and flush confirmed')
  report.limitations=['only the current installed version and architecture tested','custom linked/profile plugins refused or untested','no cross-component snapshot lock or migration coverage established','not an update/rollback transaction or power-loss durability test']
  console.log('PASS: frozen actual runtime starts offline in an isolated home')
} catch(error) {
  report.error=error.message
  throw error
} finally {
  if(child?.pid && child.exitCode===null)try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  console.log('Artifacts: '+root)
}
