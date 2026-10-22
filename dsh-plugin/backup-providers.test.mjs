import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { desktopPreferences, pluginIntent, profileIntent, captureDesktopComponents, readStableDocument, mergeComponent } from './desktop-maintenance/providers.mjs'

test('restore merges only schema fields and known switches while preserving local unrelated content', () => {
  const current={version:1,namespaces:{other:{token:'local-secret'},'desktop-appearance':{ui:'desktop',privateField:'keep'}}}
  const imported={version:1,namespaces:{other:{token:'foreign-secret'},'desktop-appearance':{ui:'vanilla',privateField:'foreign-secret'}}}
  const next=mergeComponent('desktop-preferences',imported,current,[])
  assert.equal(next.namespaces['desktop-appearance'].ui,'vanilla')
  assert.equal(next.namespaces['desktop-appearance'].privateField,'keep')
  assert.equal(next.namespaces.other.token,'local-secret')
  assert.equal(JSON.stringify(next).includes('foreign-secret'),false)
  assert.equal(current.namespaces['desktop-appearance'].ui,'desktop')
  assert.deepEqual(mergeComponent('plugin-intent',{version:1,enabled:{known:false,unknown:false}},
    {version:1,enabled:{unknown:true}},[{id:'known'}]).enabled,{known:false,unknown:true})
  assert.throws(()=>mergeComponent('profile-plugins',{version:1,entries:[]},null,[]),/backup-profile-unavailable/)
  assert.throws(()=>mergeComponent('desktop-preferences',{version:1,namespaces:{}},current,[]),/backup-provider-empty/)
})

test('profile restore revalidates unique targets, versions and management protections before merging', () => {
  const version='0.2.1-rc.2', record=(patchId,moduleName=patchId)=>({patchId,moduleName,enabled:false,runtimeVersion:version})
  const context={runtimeVersion:version,protectedModules:['core'],entries:[
    {id:'ordinary',name:'ordinary'}, {id:'nested-group',group:true,config:[{id:'nested',name:'nested'}]},
    {id:'duplicate',name:'duplicate'}, {id:'duplicate',name:'duplicate'},
    {id:'managed',name:'core'}, {id:'desktop-test',name:'desktop-module'}]}
  const current={version:1,localField:'keep',entries:[{...record('ordinary'),enabled:true,privateField:'local'},record('absent')]}
  const imported={version:1,secret:'foreign',entries:[{...record('ordinary'),privateField:'foreign'},record('nested')]}
  const next=mergeComponent('profile-plugins',imported,current,[],context)
  assert.equal(next.localField,'keep');assert.equal(next.secret,undefined)
  assert.equal(next.entries.find(row=>row.patchId==='ordinary').privateField,'local')
  assert.equal(next.entries.find(row=>row.patchId==='ordinary').enabled,false)
  assert.ok(next.entries.some(row=>row.patchId==='absent'));assert.equal(current.entries[0].enabled,true)
  for (const row of [record('gone'),record('ordinary','changed'),record('duplicate'),record('managed','core'),
    record('desktop-test','desktop-module'),record('nested-group','group')]) {
    assert.throws(()=>mergeComponent('profile-plugins',{version:1,entries:[record('nested'),row]},current,[],context),/backup-profile-target/)
  }
  assert.throws(()=>mergeComponent('profile-plugins',{version:1,entries:[{...record('ordinary'),runtimeVersion:'old'}]},current,[],context),/backup-profile-version/)
  assert.throws(()=>mergeComponent('profile-plugins',{version:1,entries:[]},current,[],context),/backup-provider-empty/)
  assert.throws(()=>mergeComponent('profile-plugins',{version:1,entries:[record('ordinary'),record('ordinary')]},current,[],context),/backup-profile-schema/)
})

test('structured preferences and intent exports strip undeclared content and preserve supported values', () => {
  const document = {version:1,namespaces:{'desktop-appearance':{ui:'vanilla',colorScheme:'teal',apiKey:'secret'},
    'desktop-terminal-dock':{profileId:'cmd',layout:{height:350,collapsed:false,password:'secret'}},
    other:{token:'secret'}}}
  const exported = desktopPreferences(document)
  assert.equal(exported.namespaces['desktop-appearance'].ui, 'vanilla')
  assert.deepEqual(exported.namespaces['desktop-terminal-dock'].layout, {height:350,collapsed:false})
  assert.equal(JSON.stringify(exported).includes('secret'), false)
  assert.equal(Object.hasOwn(document.namespaces, 'other'), true)
  assert.deepEqual(pluginIntent({version:1,enabled:{known:false,'desktop-maintenance':false}}, [{id:'known'}]), {version:1,enabled:{known:false}})
  assert.throws(() => desktopPreferences({version:2,namespaces:{}}))
  assert.throws(() => desktopPreferences({version:1,namespaces:{'desktop-appearance':{ui:'bad'}}}))
  assert.throws(() => pluginIntent({version:1,enabled:{known:'false'}}, [{id:'known'}]))
  assert.deepEqual(profileIntent({version:1,entries:[{patchId:'id',moduleName:'module',enabled:false,runtimeVersion:'1.2.3',config:{token:'secret'}}]}).entries[0],
    {patchId:'id',moduleName:'module',enabled:false,runtimeVersion:'1.2.3'})
})
test('provider snapshots never write source files and fail before reading oversized data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-backup-provider-'))
  try {
    const file = join(root,'desktop-settings.json'), source = JSON.stringify({version:1,namespaces:{'desktop-appearance':{ui:'vanilla'}}})
    await writeFile(file, source)
    const result = await captureDesktopComponents({desktopPreferences:file,pluginIntent:join(root,'missing.json')}, [])
    assert.equal(result.scope, 'partial'); assert.equal(result.components[0].id, 'desktop-preferences')
    assert.equal(result.components[0].sha256.length,64)
    assert.equal(result.excluded.length,2)
    assert.equal(await readFile(file,'utf8'),source)
    await assert.rejects(readStableDocument(file, desktopPreferences, 1), /backup-provider-file/)
    await writeFile(file, 'invalid')
    await assert.rejects(captureDesktopComponents({desktopPreferences:file}, []), /backup-provider-invalid/)
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    await rm(root,{recursive:true,force:true})
  }
})
