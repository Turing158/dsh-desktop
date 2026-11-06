import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freezeRuntimeTree,freezeRuntimeClosure,inspectRuntimeTree } from './runtime-snapshot.mjs'

test('freeze preserves nested native/optional artifacts and refuses incomplete dependency closure',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-freeze-')), source=join(root,'source'), target=join(root,'frozen')
  await mkdir(join(source,'node_modules/child'),{recursive:true})
  await writeFile(join(source,'package.json'),JSON.stringify({name:'fixture',dependencies:{child:'1'},optionalDependencies:{absent:'1'}}))
  await writeFile(join(source,'node_modules/child/package.json'),'{"name":"child","version":"1"}')
  await writeFile(join(source,'node_modules/child/native.node'),Buffer.from([0,1,255]))
  const manifest=await freezeRuntimeTree(source,target)
  assert.equal(manifest.files.length,3)
  assert.equal(manifest.missingOptional.length,1)
  assert.deepEqual(await readFile(join(target,'node_modules/child/native.node')),Buffer.from([0,1,255]))
  await assert.rejects(freezeRuntimeTree(source,target),/destination-exists/)
  await assert.rejects(inspectRuntimeTree(source,{maxFiles:1}),/size-budget/)
  await writeFile(join(source,'package.json'),'{"name":"fixture","dependencies":{"missing":"1"}}')
  await assert.rejects(inspectRuntimeTree(source),/dependency-missing/)
})
test('freeze rejects external package resolution and junctions before publishing a tree',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-freeze-')), source=join(root,'source')
  await mkdir(source); await mkdir(join(root,'node_modules/external'),{recursive:true})
  await writeFile(join(source,'package.json'),'{"name":"fixture","dependencies":{"external":"1"}}')
  await writeFile(join(root,'node_modules/external/package.json'),'{"name":"external","version":"1"}')
  await assert.rejects(inspectRuntimeTree(source),/dependency-external/)
  await writeFile(join(source,'package.json'),'{"name":"fixture"}')
  await symlink(join(root,'node_modules'),join(source,'linked'),'junction')
  await assert.rejects(inspectRuntimeTree(source),/linked-path/)
})
test('closure preserves an external peer at its original installation level',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-closure-')),source=join(root,'node_modules/@fixture/app')
  await mkdir(source,{recursive:true}); await mkdir(join(root,'node_modules/peer'),{recursive:true})
  await writeFile(join(source,'package.json'),'{"name":"@fixture/app","peerDependencies":{"peer":"1"}}')
  await writeFile(join(root,'node_modules/peer/package.json'),'{"name":"peer","version":"1"}')
  const frozen=join(root,'frozen'),manifest=await freezeRuntimeClosure(source,frozen)
  assert.equal(manifest.externalPackages,1)
  assert.equal(manifest.packagePath,'node_modules/@fixture/app')
  assert.ok(manifest.edges.some(edge=>edge.to==='node_modules/peer/package.json'))
  assert.equal((await inspectRuntimeTree(frozen)).externalDependencies.length,0)
})
test('closure omits an optional peer that only resolves outside the installation',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-closure-')),install=join(base,'install')
  const source=join(install,'node_modules/@fixture/app')
  await mkdir(source,{recursive:true}); await mkdir(join(base,'node_modules/optional-peer'),{recursive:true})
  await writeFile(join(source,'package.json'),JSON.stringify({name:'@fixture/app',
    peerDependencies:{'optional-peer':'1'},peerDependenciesMeta:{'optional-peer':{optional:true}}}))
  await writeFile(join(base,'node_modules/optional-peer/package.json'),'{"name":"optional-peer","version":"1"}')
  // A required peer is still refused when only an outer copy exists.
  await writeFile(join(source,'package.json'),'{"name":"@fixture/app","peerDependencies":{"optional-peer":"1"}}')
  await assert.rejects(freezeRuntimeClosure(source,join(base,'refused')),/outside-installation/)
  await writeFile(join(source,'package.json'),JSON.stringify({name:'@fixture/app',
    peerDependencies:{'optional-peer':'1'},peerDependenciesMeta:{'optional-peer':{optional:true}}}))
  const frozen=join(base,'frozen'),manifest=await freezeRuntimeClosure(source,frozen)
  assert.equal(manifest.externalPackages,0)
  assert.deepEqual(manifest.missingOptional.map(edge=>edge.name),['optional-peer'])
  assert.equal(manifest.edges.length,0)
  assert.equal((await inspectRuntimeTree(frozen)).externalDependencies.length,0)
})
test('an identical dependency closure reuses its snapshot without copying another tree',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-reuse-')),source=join(root,'install/node_modules/@fixture/app')
  await mkdir(source,{recursive:true});await mkdir(join(source,'lib'))
  await writeFile(join(source,'package.json'),'{"name":"@fixture/app","version":"1.0.0"}')
  await writeFile(join(source,'lib/bin.js'),'original runtime')
  const original=await freezeRuntimeClosure(source,join(root,'original'))
  const candidate={id:'verified-original',fingerprint:original.fingerprint,entry:original.packagePath+'/lib/bin.js',
    fileCount:original.files.length,totalBytes:original.totalBytes}
  const destination=join(root,'duplicate')
  const reused=await freezeRuntimeClosure(source,destination,{reuseCandidates:[candidate]})
  assert.equal(reused.reusedId,candidate.id);assert.equal(reused.fingerprint,original.fingerprint)
  assert.equal(await access(destination).then(()=>true,()=>false),false)
  await writeFile(join(source,'lib/bin.js'),'changed runtime')
  const changed=await freezeRuntimeClosure(source,join(root,'changed'),{reuseCandidates:[candidate]})
  assert.equal(changed.reusedId,undefined);assert.notEqual(changed.fingerprint,original.fingerprint)
  assert.equal(await readFile(join(root,'changed',candidate.entry),'utf8'),'changed runtime')
})

test('a matching file digest cannot reuse a snapshot with different layout or size bindings',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-reuse-')),source=join(root,'install/node_modules/@fixture/app')
  await mkdir(source,{recursive:true});await writeFile(join(source,'package.json'),'{"name":"@fixture/app","version":"1"}')
  const original=await freezeRuntimeClosure(source,join(root,'original'))
  const wrong={id:'wrong-layout',fingerprint:original.fingerprint,entry:'wrong/lib/bin.js',fileCount:original.files.length,totalBytes:original.totalBytes}
  const result=await freezeRuntimeClosure(source,join(root,'new'),{reuseCandidates:[wrong]})
  assert.equal(result.reusedId,undefined);assert.equal(await readFile(join(root,'new',original.packagePath,'package.json'),'utf8'),'{"name":"@fixture/app","version":"1"}')
})

test('bounded traversal and streaming copies preserve all files across batches',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-stream-copy-')),source=join(root,'source')
  await mkdir(source)
  await writeFile(join(source,'package.json'),'{"name":"fixture"}')
  const data=Buffer.alloc(2*1024*1024+17,37)
  await writeFile(join(source,'large.bin'),data)
  for(let index=0;index<80;index++) await writeFile(join(source,'file-'+index),String(index))
  const frozen=join(root,'frozen'),manifest=await freezeRuntimeTree(source,frozen)
  assert.equal(manifest.files.length,82)
  assert.equal(manifest.files.find(file=>file.path==='large.bin').sha256,createHash('sha256').update(data).digest('hex'))
  assert.deepEqual(await readFile(join(frozen,'large.bin')),data)
  for(let index=0;index<80;index++) assert.equal(await readFile(join(frozen,'file-'+index),'utf8'),String(index))
})
