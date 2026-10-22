import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveInventory } from './desktop-maintenance/inventory.mjs'
import { createReportStore, isCurrent, sourceLabels } from './desktop-maintenance/model.mjs'
import { readFileSync } from 'node:fs'

test('managed runtime source has a translated label without implying rollback readiness', () => {
  const messages=JSON.parse(readFileSync(new URL('./i18n/en.json',import.meta.url),'utf8'))
  assert.equal(sourceLabels.managed,'受管安装')
  assert.equal(messages[sourceLabels.managed],'Managed installation')
})

test('read-only runtime Profile preflight loads using only shipped resources', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-profile-resource-'))
  try {
    const config=JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'))
    assert.equal(config.bundle.resources['../dsh-plugin/runtime-store/profile.mjs'],'dsh-plugin/runtime-store/profile.mjs')
    for (const [source,destination] of Object.entries(config.bundle.resources)) {
      if (!destination.startsWith('dsh-plugin/runtime-store/')) continue
      const target=join(root,destination)
      await mkdir(dirname(target),{recursive:true})
      await copyFile(new URL('../src-tauri/'+source,import.meta.url),target)
    }
    assert.equal(typeof (await import(pathToFileURL(join(root,'dsh-plugin/runtime-store/profile.mjs')))).verifyRuntimeProfile,'function')
  } finally {await rm(root,{recursive:true,force:true})}
})

test('inventory uses the selected runtime resolver without creating data or starting a profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-inventory-'))
  try {
    const pkg = join(root, 'runtime'), helper = join(pkg, 'node_modules/@deepseek-ai/dsh-home-paths')
    await mkdir(join(pkg, 'lib'), { recursive: true }); await mkdir(helper, { recursive: true })
    await writeFile(join(pkg,'package.json'), '{"name":"@deepseek-ai/dsh","version":"1.2.3","type":"module"}')
    await writeFile(join(pkg,'lib/bin.js'), 'throw Error("profile must not start")')
    await writeFile(join(helper,'package.json'), '{"name":"@deepseek-ai/dsh-home-paths","type":"module","exports":"./index.js"}')
    await writeFile(join(helper,'index.js'), `export const resolveDshHome = () => ${JSON.stringify(join(root,'custom data'))}`)
    const inventory = await resolveInventory(join(pkg,'lib/bin.js'))
    assert.equal(inventory.dataRoot, join(root,'custom data'))
    assert.equal(inventory.runtimeVersion, '1.2.3')
    assert.equal(inventory.consistency, 'unverified')
    assert.deepEqual(await readdir(root), ['runtime'])
    await assert.rejects(resolveInventory(resolve(root,'missing/lib/bin.js')))
  } finally { await rm(root, { recursive:true, force:true }) }
})

test('navigation shares an in-flight request and ignores an old backend response', async () => {
  let identity = {backendInstance:1}, resolveRequest, calls = 0
  const store = createReportStore(() => { calls++; return new Promise(resolve => { resolveRequest = resolve }) }, () => identity, () => 100)
  const first = store.refresh(), repeated = store.check()
  assert.equal(first, repeated)
  await Promise.resolve(); assert.equal(calls, 1)
  identity = {backendInstance:2}
  resolveRequest({schema:1, observedAt:100, runtime:{backendInstance:1}})
  await first
  assert.equal(store.getSnapshot().report, null)
  assert.equal(store.getSnapshot().busy, false)
  store.dispose()
})

test('unsupported, future, expired and previous-backend reports never display as current', () => {
  const report = {schema:1, observedAt:100, runtime:{backendInstance:1}}
  assert.ok(isCurrent(report, {backendInstance:1}, 150))
  assert.equal(isCurrent(report, {backendInstance:2}, 150), false)
  assert.equal(isCurrent(report, {backendInstance:1}, 300101), false)
  assert.equal(isCurrent(report, {backendInstance:1}, 99), false)
  assert.equal(isCurrent({...report,schema:2}, {backendInstance:1}, 150), false)
})
