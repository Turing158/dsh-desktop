import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises'
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
