import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

test('runtime preparation uses only shipped resources and preserves external peers', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-runtime-resource-'))
  try {
    const config=JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'))
    for (const [source,destination] of Object.entries(config.bundle.resources)) {
      if (!destination.startsWith('dsh-plugin/runtime-store/')) continue
      const target=join(root,destination);await mkdir(dirname(target),{recursive:true})
      await copyFile(new URL('../src-tauri/'+source,import.meta.url),target)
    }
    const {prepareRuntime}=await import(pathToFileURL(join(root,'dsh-plugin/runtime-store/prepare.mjs')))
    const source=join(root,'source/node_modules/@deepseek-ai/dsh')
    await mkdir(join(source,'lib'),{recursive:true});await mkdir(join(root,'source/node_modules/peer'),{recursive:true})
    await writeFile(join(source,'package.json'),'{"name":"@deepseek-ai/dsh","version":"0.2.1-rc.2","peerDependencies":{"peer":"1"}}')
    await writeFile(join(source,'lib/bin.js'),'process.stdout.write("0.2.1-rc.2")')
    await writeFile(join(root,'source/node_modules/peer/package.json'),'{"name":"peer","version":"1.0.0"}')
    await mkdir(join(root,'stage'))
    const prepared=await prepareRuntime(source,join(root,'stage/tree'))
    const inventory=JSON.parse(await readFile(join(root,'stage/inventory.json'),'utf8'))
    assert.equal(prepared.version,'0.2.1-rc.2');assert.equal(prepared.entry,'node_modules/@deepseek-ai/dsh/lib/bin.js')
    assert.ok(inventory.files.some(file=>file.path==='node_modules/peer/package.json'))
    assert.equal(prepared.fingerprint,createHash('sha256').update(JSON.stringify(inventory.files)).digest('hex'))
    assert.equal(prepared.fileCount,3)
    assert.equal(await readFile(join(source,'lib/bin.js'),'utf8'),'process.stdout.write("0.2.1-rc.2")')
  } finally { await rm(root,{recursive:true,force:true}) }
})
