import test from 'node:test'
import assert from 'node:assert/strict'
import {flushUpdateSessions} from './desktop-maintenance/index.js'
function fixture() {
  const calls=[],agents=[{status:'idle'}],ctx={agents:{list:()=>agents},sessions:{list:()=>['one','two'],flush:async id=>{calls.push(id);return true}},sessionPersistence:{flush:async()=>{calls.push('storage')}}}
  return {ctx,calls,agents}
}
test('upgrade drains semantic session listeners before the persistence queue',async()=>{
  const {ctx,calls}=fixture();await flushUpdateSessions(ctx);assert.deepEqual(calls,['one','two','storage'])
})
test('running or unknown agents prevent shutdown before flushing',async()=>{
  for(const status of ['running','unknown']) {
    const {ctx,calls,agents}=fixture();agents[0].status=status
    await assert.rejects(flushUpdateSessions(ctx),/busy/);assert.deepEqual(calls,[])
  }
})
test('a task starting during the asynchronous flush blocks shutdown',async()=>{
  const {ctx,agents}=fixture();ctx.sessionPersistence.flush=async()=>{agents[0].status='running'}
  await assert.rejects(flushUpdateSessions(ctx),/busy/)
})
test('missing listeners and failed durable writes cannot acknowledge shutdown',async()=>{
  const {ctx}=fixture();ctx.sessions.flush=async()=>false
  await assert.rejects(flushUpdateSessions(ctx),/unavailable/)
  ctx.sessions.flush=async()=>true;ctx.sessionPersistence.flush=async()=>{throw Error('disk full')}
  await assert.rejects(flushUpdateSessions(ctx),/disk full/)
})
