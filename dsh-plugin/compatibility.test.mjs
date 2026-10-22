import test from 'node:test'
import assert from 'node:assert/strict'
import { pluginObservations, terminalObservation, createPluginReporter, createClientReporter, fileEditorObservation, watchChanges, changesObservation, createSessionReporter } from './compatibility/selectors.mjs'
import { contribution } from './sidebar-changes/shared/change-model.mjs'
import { openSessionLink } from './session-links/links.mjs'

const tick = () => new Promise(resolve=>setImmediate(resolve))
function changesFixture() {
  const listeners=new Set(), pending=[], events=new EventTarget()
  let current='session-a'
  const ctx={sessions:{list:{getSnapshot:()=>({current,byId:{}}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}}},
    remote:{desktopChanges:Object.fromEntries(contribution.descriptors.map(row=>[row.method,()=>{}]))}}
  ctx.remote.desktopChanges.getCapabilities=(id,signal)=>new Promise(resolve=>pending.push({id,signal,resolve}))
  const capabilities=(status='available')=>({workspaceRoot:'D:/private-workspace',endpointId:'private-endpoint',gitContextVersion:1,supportedSources:['session','working','staged'],supportedViews:['session','working','staged','history'],recordingCoverage:'private coverage',gitAvailability:{status,reason:'private error'}})
  return {ctx,pending,events,capabilities,select:id=>{current=id;listeners.forEach(fn=>fn())},listeners}
}
test('workspace switching, disposal and failed queries cannot retain an earlier successful Git report', async () => {
  const f=changesFixture(), reports=[], reporter=createClientReporter(value=>reports.push(value))
  const off=watchChanges(f.ctx,reporter,f.events)
  assert.equal(reports.at(-1).availability,'checking')
  f.select('session-b')
  assert.equal(f.pending[0].signal.aborted,true)
  f.pending[1].resolve({ok:true,value:f.capabilities('none')}); await tick()
  assert.ok(reports.at(-1).reasonCodes.includes('changes-workspace-not-git'))
  f.pending[0].resolve({ok:true,value:f.capabilities()}); await tick()
  assert.ok(reports.at(-1).reasonCodes.includes('changes-workspace-not-git'))
  f.events.dispatchEvent(new Event('dsh-desktop:git-changed'))
  f.pending[2].resolve({ok:false,error:{message:'private error'}}); await tick()
  assert.equal(reports.at(-1).availability,'unknown')
  assert.deepEqual(reports.at(-1).reasonCodes,['changes-query-failed'])
  const count=f.pending.length;f.select(null);await tick()
  assert.equal(f.pending.length,count)
  assert.deepEqual(reports.at(-1).reasonCodes,['changes-no-current-session'])
  f.select('session-c');off(); await tick()
  assert.equal(f.listeners.size,0)
  f.pending.at(-1).resolve({ok:true,value:f.capabilities()});await tick()
  assert.equal(reports.at(-1).availability,'unknown')
  assert.deepEqual(reports.at(-1).reasonCodes,['feature-provider-unreported'])
  assert.equal(JSON.stringify(reports).includes('private'),false)
})
test('Git environment limits and changed execution contracts stay separate from plugin intent',()=>{
  const f=changesFixture()
  for (const [status,code] of [['available','changes-recording-coverage-limited'],['none','changes-workspace-not-git'],['missing','changes-git-missing'],['error','changes-git-unavailable']]) {
    const row=changesObservation(f.ctx,f.capabilities(status));assert.equal(row.availability,'limited');assert.ok(row.reasonCodes.includes(code))
  }
  assert.equal(changesObservation(f.ctx,{...f.capabilities(),supportedSources:[]}).availability,'unknown')
  delete f.ctx.remote.desktopChanges.runGitAction
  assert.equal(changesObservation(f.ctx,f.capabilities()).availability,'unavailable')
})
test('asynchronous refresh waits for the latest report and suppresses superseded or disposed selectors',async()=>{
  const reports=[],resolvers=[],reporter=createClientReporter(value=>reports.push(value))
  const off=reporter.watch('session-changes-git',()=>new Promise(resolve=>resolvers.push(resolve)))
  await tick();let finished=false
  const refresh=reporter.refresh().then(()=>{finished=true});await tick()
  assert.equal(finished,false)
  resolvers[1]({featureId:'session-changes-git',availability:'limited'});await refresh
  resolvers[0]({featureId:'session-changes-git',availability:'available'});await tick()
  assert.equal(reports.at(-1).availability,'limited')
  const other=reporter.watch('session-changes-git',async()=>{throw Error('private error')});await tick()
  off();assert.equal(reports.at(-1).availability,'unknown')
  other();assert.equal(JSON.stringify(reports).includes('private'),false)
})
test('session links and exports track their actual controllers independently and recheck before use',async()=>{
  const reports=[],reporter=createClientReporter(value=>reports.push(value))
  const session=createSessionReporter(reporter,()=>true),fn=()=>{}
  let opens=0
  const links={sessions:{list:{getSnapshot:()=>({byId:{'session-a':{}}})}},uiWorkspace:{openSession:()=>{opens++}},slots:Object.fromEntries(['entries','inject','register','subscribe'].map(key=>[key,fn]))}
  const old=session.sessionLinks(links)
  assert.ok(reports.at(-1).evidence.includes('session-link-navigation-selector'))
  assert.ok(reports.at(-1).reasonCodes.includes('session-export-contract-unavailable'))
  const controller={run:fn,publish:fn,fetcher:fn,save:fn,store:{getSnapshot:fn}}
  const exportOff=session.sessionExport({effect:fn},controller)
  assert.ok(reports.at(-1).evidence.includes('session-export-controller-selector'))
  delete controller.save;await reporter.refresh()
  assert.ok(!reports.at(-1).evidence.includes('session-export-controller-selector'))
  await openSessionLink(links,'deepseekharness://session/a');assert.equal(opens,1)
  await assert.rejects(openSessionLink(links,'deepseekharness://session/deleted'),/missing/);assert.equal(opens,1)
  const current=session.sessionLinks(links);old()
  assert.ok(reports.at(-1).evidence.includes('session-link-navigation-selector'))
  delete links.uiWorkspace.openSession;await reporter.refresh()
  await assert.rejects(openSessionLink(links,'deepseekharness://session/a'),/contract-unavailable/)
  assert.equal(reports.at(-1).availability,'unavailable')
  current();exportOff();session.dispose()
})

test('file editing requires its writer and native close contract before enabling installation', () => {
  const method = () => {}, store = () => ({getSnapshot:method,subscribe:method})
  const ctx = {remote:{desktopFileEditor:{read:method,save:method}},
    slots:Object.fromEntries(['inject','register','subscribe','entriesOfSlot','resolveStore'].map(key=>[key,method])),
    sidebarRight:{removeAfterCleanup:method,tabsIn:method,tabDomain:{occurrence:method},mounted:store(),openTabs:store()},
    sessions:{scope:method,list:store()}}
  assert.equal(fileEditorObservation(ctx).availability,'limited')
  const writer = ctx.remote.desktopFileEditor.save
  delete ctx.remote.desktopFileEditor.save
  assert.equal(fileEditorObservation(ctx).availability,'unavailable')
  ctx.remote.desktopFileEditor.save=writer
  delete ctx.sidebarRight.removeAfterCleanup
  assert.equal(fileEditorObservation(ctx).availability,'unavailable')
})

test('client refresh reevaluates selectors, clears disposed evidence and waits for native reporting', async () => {
  const lines=[], pending=[]
  const reporter=createClientReporter(value=>{lines.push(value); return new Promise(resolve=>pending.push(resolve))})
  let available=true
  const observation=()=>({featureId:'file-editor',availability:available ? 'limited':'unavailable'})
  const old=reporter.watch('file-editor',observation)
  available=false
  let finished=false
  const refreshing=reporter.refresh().then(()=>{finished=true})
  await Promise.resolve(); assert.equal(finished,false)
  assert.equal(lines.at(-1).availability,'unavailable')
  pending.splice(0).forEach(resolve=>resolve()); await refreshing
  const current=reporter.watch('file-editor',()=>({...observation(),availability:'limited'}))
  old(); assert.equal(lines.at(-1).availability,'limited')
  current(); assert.equal(lines.at(-1).availability,'unknown')
  const count=lines.length
  reporter.report({featureId:'runtime-rollback',availability:'available'})
  assert.equal(lines.length,count)
  reporter.watch('ui-recovery',()=>{throw Error('secret input')})
  assert.equal(lines.at(-1).availability,'unknown')
  assert.equal(JSON.stringify(lines).includes('secret'),false)
  reporter.clear(); pending.splice(0).forEach(resolve=>resolve())
})

test('appearance intent, pending restart and failed loading remain separate from compatibility', () => {
  const report = row=>pluginObservations({rows:[{id:'desktop-ui', ...row}],managementAvailable:true})[1]
  assert.equal(report({enabled:false}).pluginState,'user-disabled')
  assert.equal(report({enabled:false}).availability,'available')
  assert.equal(report({enabled:false,restart:true}).pluginState,'pending-restart')
  assert.equal(report({enabled:true,phase:'failed'}).pluginState,'load-failed')
  assert.equal(report({enabled:true,phase:'failed'}).availability,'limited')
})
test('registered terminal selection controls implementation and retains process recovery limits', () => {
  assert.equal(terminalObservation(false).implementation,'desktop')
  assert.equal(terminalObservation({id:'native-terminal'}).implementation,'hybrid')
  assert.ok(terminalObservation(true).reasonCodes.includes('terminal-processes-not-restored'))
})
test('disabled enhancements and pending restarts do not claim native feature compatibility', () => {
  const reports=pluginObservations({rows:[{id:'desktop-sidebar-terminal',enabled:false},{id:'desktop-sidebar-changes',enabled:false,restart:true},{id:'desktop-notify',enabled:true,phase:'failed'}]})
  assert.equal(reports.find(row=>row.featureId==='terminal-dock').pluginState,'user-disabled')
  assert.equal(reports.find(row=>row.featureId==='terminal-dock').availability,'unknown')
  assert.equal(reports.find(row=>row.featureId==='session-changes-git').pluginState,'pending-restart')
  assert.equal(reports.find(row=>row.featureId==='window-notifications').pluginState,'load-failed')
})
test('repeated settings polling emits only changes and bounded freshness updates', () => {
  let now = 0
  const lines = [], report = createPluginReporter(line=>lines.push(line),()=>now)
  const status = {rows:[{id:'desktop-ui',enabled:true}],managementAvailable:true}
  for(let i=0;i<100;i++)report(status)
  assert.equal(lines.length,2)
  now = 60_001; report(status)
  assert.equal(lines.length,4)
  status.rows[0].enabled=false; report(status)
  assert.equal(lines.length,5)
  assert.ok(!lines.join('').includes('undefined'))
})
