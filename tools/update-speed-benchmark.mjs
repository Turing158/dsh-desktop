// Compare an earlier snapshot helper with the shipped helper on identical data.
// Usage: node tools/update-speed-benchmark.mjs <baseline-snapshot.mjs>
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {performance} from 'node:perf_hooks'
import {freezeRuntimeClosure} from '../dsh-plugin/runtime-store/snapshot.mjs'
const baseline=await import(pathToFileURL(resolve(process.argv[2])).href)
const root=await mkdtemp(resolve('src-tauri/target/update-speed-'))
const source=join(root,'install/node_modules/@fixture/app')
await mkdir(source,{recursive:true})
await writeFile(join(source,'package.json'),'{"name":"@fixture/app","version":"1.0.0"}')
const small=Buffer.alloc(4096,37),large=Buffer.alloc(8*1024*1024,71)
for(let dir=0;dir<64;dir++) {
  const destination=join(source,'files',String(dir));await mkdir(destination,{recursive:true})
  await Promise.all(Array.from({length:64},(_,file)=>writeFile(join(destination,String(file)),small)))
}
for(let file=0;file<8;file++) await writeFile(join(source,'large-'+file),large)
const measurements=[]
let fingerprint
for(const [name,freeze] of [['before',baseline.freezeRuntimeClosure],['after',freezeRuntimeClosure],['after',freezeRuntimeClosure],['before',baseline.freezeRuntimeClosure]]) {
  const start=performance.now(),inventory=await freeze(source,join(root,'frozen-'+measurements.length))
  fingerprint??=inventory.fingerprint;assert.equal(inventory.fingerprint,fingerprint)
  measurements.push({name,elapsedMs:Math.round(performance.now()-start),files:inventory.files.length,bytes:inventory.totalBytes})
}
const report={root,measurements}
await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
console.log(JSON.stringify(report,null,2))
