import test from 'node:test'
import assert from 'node:assert/strict'
import { createDraftCheckpoints } from './ui-state/checkpoints.mjs'
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function fixture(options={}) {
  let time=0,id=0
  const timers=new Map(),captures=[],saves=[],status=[]
  const checkpoint=createDraftCheckpoints({now:()=>time,schedule:(fn,delay)=>{timers.set(++id,{fn,at:time+delay});return id},cancel:id=>timers.delete(id),
    capture:async signal=>{captures.push(signal);return {drafts:['draft']}},save:async payload=>{saves.push(payload);return {savedAt:time}},onStatus:value=>status.push(value),...options})
  const advance=async target=>{
    for(let loops=0;loops<100;loops++) {
      const next=[...timers].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0]
      if(!next)break
      timers.delete(next[0]);time=next[1].at;next[1].fn();await tick()
    }
    time=target;await tick()
  }
  return {checkpoint,advance,captures,saves,status,timers,now:()=>time}
}
test('input bursts debounce, periodic bounds capture continuous input, and writes are rate limited',async()=>{
  const f=fixture();f.checkpoint.changed();await f.advance(1000);f.checkpoint.changed()
  await f.advance(3499);assert.equal(f.saves.length,0)
  await f.advance(3500);assert.equal(f.saves.length,1)
  f.checkpoint.changed();await f.advance(33_499);assert.equal(f.saves.length,1)
  await f.advance(33_500);assert.equal(f.saves.length,2)
  const continuous=fixture()
  for(let time=0;time<60_000;time+=1000){await continuous.advance(time);continuous.checkpoint.changed()}
  await continuous.advance(60_000);assert.equal(continuous.saves.length,1)
  f.checkpoint.dispose();continuous.checkpoint.dispose()
})
test('busy inputs retry silently and disposal cancels pending or captured work',async()=>{
  let blocked=true,release
  const f=fixture({blocked:()=>blocked,capture:signal=>new Promise(resolve=>{release=()=>resolve({drafts:[]})})})
  f.checkpoint.changed();await f.advance(5000);assert.equal(release,undefined)
  blocked=false;await f.advance(7500);assert.equal(typeof release,'function')
  f.checkpoint.dispose();release();await tick();assert.equal(f.saves.length,0);assert.equal(f.timers.size,0)
})
test('changes during capture discard stale contents and failed writes retain pending work with sanitized errors',async()=>{
  let resolve
  const f=fixture({capture:()=>new Promise(done=>{resolve=done})})
  f.checkpoint.changed();await f.advance(2500);f.checkpoint.changed();resolve({drafts:['old']});await tick()
  assert.equal(f.saves.length,0)
  await f.advance(32_500);resolve({drafts:['current']});await tick();assert.deepEqual(f.saves,[{drafts:['current']}]);f.checkpoint.dispose()
  let attempts=0
  const fail=fixture({save:async()=>{if(attempts++===0)throw Error('private secret');return {savedAt:32_500}}})
  fail.checkpoint.changed();await fail.advance(2500);assert.equal(fail.status[0].error,'recovery-save-failed')
  await fail.advance(32_500);assert.equal(attempts,2);assert.equal(fail.status.at(-1).error,null);fail.checkpoint.dispose()
})

test('non-cooperative captures expire or suspend without blocking later checkpoints or saving late results',async()=>{
  const pending=[]
  const f=fixture({capture:signal=>new Promise(resolve=>pending.push({signal,resolve}))})
  f.checkpoint.changed();await f.advance(2500)
  await f.advance(22_500);assert.equal(pending[0].signal.aborted,true)
  assert.equal(f.status.at(-1).error,'snapshot-capture-timeout')
  await f.advance(32_500);assert.equal(pending.length,2)
  pending[0].resolve({drafts:['expired']});await tick();assert.equal(f.saves.length,0)
  f.checkpoint.suspend();await tick();assert.equal(pending[1].signal.aborted,true)
  await f.advance(62_500);assert.equal(pending.length,3)
  pending[1].resolve({drafts:['suspended']});pending[2].resolve({drafts:['current']});await tick()
  assert.deepEqual(f.saves,[{drafts:['current']}]);assert.equal(f.status.at(-1).error,null)
  f.checkpoint.dispose();assert.equal(f.timers.size,0)
})

test('write latency counts toward the next interval so native throttling does not discard a scheduled checkpoint',async()=>{
  let complete
  const f=fixture({save:payload=>new Promise(resolve=>{complete=()=>resolve({savedAt:f.now()})})})
  f.checkpoint.changed();await f.advance(2500);f.checkpoint.changed()
  await f.advance(3000);complete();await tick()
  await f.advance(32_999);assert.equal(f.captures.length,1)
  await f.advance(33_000);assert.equal(f.captures.length,2)
  complete();await tick();f.checkpoint.dispose()
})
