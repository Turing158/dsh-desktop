// Uses the already verified frozen tree; never repeats the dependency copy.
// All profiles, plugins and startup writes live in this script's disposable root.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyRuntimeProfile } from '../dsh-plugin/runtime-store/profile.mjs'

let frozenRoot = process.env.DSH_RUNTIME_PROFILE_FROZEN
if (!frozenRoot) {
  const candidates = (await readdir(resolve('src-tauri/target'), {withFileTypes:true})).filter(item=>item.isDirectory() && item.name.startsWith('native-runtime-store-'))
  for (const item of candidates.reverse()) {
    const path = resolve('src-tauri/target',item.name)
    try {
      const report=JSON.parse(await readFile(join(path,'report.json'),'utf8'))
      if (report.checks?.length===4 && !report.error) {frozenRoot=path;break}
    } catch {}
  }
}
assert.ok(frozenRoot,'Run npm run test:runtime-store once or set DSH_RUNTIME_PROFILE_FROZEN to its completed report directory')
const evidenceRoot = resolve(frozenRoot)
const evidence = JSON.parse(await readFile(join(evidenceRoot, 'report.json'), 'utf8'))
assert.equal(evidence.checks.length, 4, 'requires the completed native freeze evidence')
const sourceEntry = evidence.realBin, targetEntry = evidence.runtime.dsh_bin
const root = process.env.DSH_RUNTIME_PROFILE_RESUME ? resolve(process.env.DSH_RUNTIME_PROFILE_RESUME) : await mkdtemp(resolve('src-tauri/target/runtime-profile-'))
const home = join(root, 'custom home'), profileDirectory = join(home, 'profiles/web'), overlay = join(root, 'overlay.yml')
const report = process.env.DSH_RUNTIME_PROFILE_RESUME ? JSON.parse(await readFile(join(root, 'report.json'), 'utf8')) : {schema:1,root,evidenceRoot,checks:[]}
const save = () => writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
const pass = async name => { report.checks.push(name); await save(); console.log('PASS: ' + name) }
const has = name => report.checks.includes(name)
let child

async function hashes(dir) {
  const files = []
  async function walk(path) {
    for (const item of await readdir(path, {withFileTypes:true})) {
      const file = join(path, item.name)
      if (item.isDirectory()) await walk(file)
      else files.push([file,createHash('sha256').update(await readFile(file)).digest('hex')])
    }
  }
  await walk(dir)
  return files.sort(([a],[b]) => a.localeCompare(b))
}

try {
  await mkdir(profileDirectory, {recursive:true})
  await mkdir(join(profileDirectory, 'node_modules/desktop-profile-fixture'), {recursive:true})
  await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({private:true,dependencies:{'desktop-profile-fixture':'1.0.0'},
    dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','desktop-profile-fixture']}}}))
  await writeFile(join(profileDirectory, 'node_modules/desktop-profile-fixture/package.json'), JSON.stringify({name:'desktop-profile-fixture',version:'1.0.0',type:'module',main:'index.js',
    dsh:{bundle:{patch:'cordis.patch.yml'}}}))
  await writeFile(join(profileDirectory, 'node_modules/desktop-profile-fixture/cordis.patch.yml'), '- insert:\n    - id: custom-bundle\n      name: ./index.js\n')
  const probe = `import {writeFileSync} from 'node:fs'\nexport const inject=['profileContext']\nexport function apply(ctx){writeFileSync(${JSON.stringify(join(root,'plugin-'+ 'SUFFIX' +'.json'))},JSON.stringify({anchor:ctx.profileContext.installAnchor,home:ctx.profileContext.home,dir:ctx.profileContext.dir}))}\n`
  for (const [file,suffix] of [[join(profileDirectory,'node_modules/desktop-profile-fixture/index.js'),'bundle'],[join(profileDirectory,'relative.mjs'),'profile'],[join(home,'relative.mjs'),'home'],[join(root,'relative.mjs'),'overlay']]) {
    await writeFile(file,probe.replace('SUFFIX',suffix))
  }
  await writeFile(join(profileDirectory,'cordis.patch.yml'), '- insert:\n    - id: profile-relative\n      name: ./relative.mjs\n')
  await writeFile(join(home,'cordis.patch.yml'), '- insert:\n    - id: home-relative\n      name: ./relative.mjs\n')
  await writeFile(overlay, '- insert:\n    - id: overlay-relative\n      name: ./relative.mjs\n')
  const request={home,profileDirectory,overlays:[overlay]}
  const readonly='custom bundle and profile/home/overlay relative modules retain resolution without profile writes'
  if (!has(readonly)) {
    const before=await hashes(home),result=await verifyRuntimeProfile(sourceEntry,targetEntry,request)
    assert.equal(result.schema,1);assert.equal(result.bundleCount,3);assert.ok(result.moduleCount>4);assert.equal(result.retainedPackages,1)
    assert.equal(result.dataMigration,'unverified');assert.match(result.fingerprint,/^[a-f0-9]{64}$/)
    assert.deepEqual(await hashes(home),before)
    report.verification=result;await pass(readonly)
  }
  const linked='external linked profile packages are rejected before modification'
  if (!has(linked)) {
    await mkdir(join(root,'external'),{recursive:true})
    const link=join(profileDirectory,'node_modules/linked-fixture')
    await symlink(join(root,'external'),link,'junction')
    try { await assert.rejects(verifyRuntimeProfile(sourceEntry,targetEntry,request),/linked-path/) }
    finally { await unlink(link) }
    await pass(linked)
  }
  const stale='explicit references into the old installation are rejected rather than silently redirected'
  if (!has(stale)) {
    const old = await readFile(overlay,'utf8')
    await writeFile(overlay, '- insert:\n    - id: stale-installation\n      name: '+pathToFileURL(sourceEntry).href+'\n')
    try { await assert.rejects(verifyRuntimeProfile(sourceEntry,targetEntry,request),/old-install-reference|module-external/) }
    finally { await writeFile(overlay,old) }
    await pass(stale)
  }
  const offline='frozen backend loads custom and relative plugins offline with the frozen install anchor'
  const binding='retained plugin content changes invalidate the binding even when file sizes stay unchanged'
  if (!has(binding)) {
    const file=join(profileDirectory,'node_modules/desktop-profile-fixture/index.js'),original=await readFile(file,'utf8')
    const before=await verifyRuntimeProfile(sourceEntry,targetEntry,request)
    await writeFile(file,original.replace('bundle','Bundle'))
    try {
      const after=await verifyRuntimeProfile(sourceEntry,targetEntry,request)
      assert.notEqual(before.fingerprint,after.fingerprint)
    } finally {await writeFile(file,original)}
    await pass(binding)
  }
  if (!has(offline)) {
    const guard=join(root,'offline.cjs')
    await writeFile(guard,`const net=require('node:net');const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const first=args[0],o=Array.isArray(first)?first[0]:first;const host=typeof o==='object'?o.host:(typeof args[1]==='string'?args[1]:'localhost');if(host&&!['127.0.0.1','localhost','::1'].includes(host))throw Error('offline-network-denied');return connect.apply(this,args)}\n`)
    child=spawn(process.execPath,['--require',guard,targetEntry,'web','--patch',overlay,'--no-open','--port','0'],
      {cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',NODE_PATH:'',NARB_NATIVE_CACHE_DIR:join(root,'native-cache')}})
    let output=''
    child.stdout.on('data',data=>{output=(output+data).slice(-16000)})
    child.stderr.on('data',data=>{output=(output+data).slice(-16000)})
    const deadline=Date.now()+60000
    while (!output.includes('dsh web: http') && Date.now()<deadline && child.exitCode===null) await new Promise(resolve=>setTimeout(resolve,100))
    await writeFile(join(root,'startup.txt'),output)
    assert.match(output,/dsh web: http/)
    for (const suffix of ['bundle','profile','home','overlay']) {
      const actual=JSON.parse(await readFile(join(root,'plugin-'+suffix+'.json'),'utf8'))
      assert.equal(resolve(actual.anchor),resolve(dirname(dirname(targetEntry)),'package.json'))
      assert.equal(actual.home,home);assert.equal(actual.dir,profileDirectory)
    }
    report.offlinePlugins=['bundle','profile','home','overlay'];await pass(offline)
  }
  if (report.error) (report.previousFailures ||= []).push(report.error)
  delete report.error;await save()
} catch (error) {report.error=error.stack;await save();throw error}
finally {
  if (child?.pid && child.exitCode===null) try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})} catch {}
  console.log('Artifacts: '+root)
}
