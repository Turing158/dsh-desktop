import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SnapshotStore } from './sidebar-changes/host/snapshot-store.mjs'
import { ChangesApi, resolveScope } from './sidebar-changes/host/api.mjs'
import { installRecorder, scan } from './sidebar-changes/host/session-recorder.mjs'
import { absent, hash } from './sidebar-changes/host/paths.mjs'
import { migrateFileIds } from './sidebar-changes/client-state.mjs'
import { LIMITS } from './sidebar-changes/shared/change-model.mjs'
const endpoint = text => ({ exists: true, text, hash: hash(text), mode: null, reason: null })
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-session-'))), root = path.join(directory, 'project')
  await mkdir(root); const snapshots = path.join(directory, 'snapshots'), store = new SnapshotStore(snapshots)
  t.after(async () => { await store.flush(); await rm(directory, { recursive: true, force: true }) })
  return { directory, root, snapshots, store, scope: { sessionId: 'session', root } }
}
async function record(store, scope, before, after, extra = {}) {
  const execution = extra.execution || crypto.randomUUID()
  await store.finish(scope, execution, [{ path: 'a', origin: 'structured', author: scope.sessionId, execution, sequence: 0,
    before: before === null ? absent() : endpoint(before), after: after === null ? absent() : endpoint(after), ...extra }])
}
test('empty creation, observed shell and later edit form one cumulative file across restarts', async t => {
  const { store, scope, snapshots } = await fixture(t)
  await record(store, scope, null, '')
  await record(store, scope, '', 'shell\r\n', { origin: 'observed', after: { ...endpoint('shell\r\n'), mode: '100644' } })
  const restarted = new SnapshotStore(snapshots)
  await record(restarted, scope, 'shell\n', 'final\n')
  const data = await restarted.list(scope), entry = data.entries[0]
  assert.equal(data.entries.length, 1); assert.equal(entry.status, 'added'); assert.equal(entry.reason, null)
  assert.equal(entry.attribution, 'observed'); assert.deepEqual(entry.stats, { added: 1, removed: 0 })
  assert.equal(entry.before.exists, false); assert.equal(entry.after.text, 'final\n'); assert.equal(entry.operations.length, 3)
  await record(restarted, scope, 'final\n', null, { origin: 'observed' })
  const restored = await restarted.list(scope)
  assert.equal(restored.entries.length, 0); assert.equal(restored.restoredEntries[0].operations.length, 4)
})
test('nested scan evidence is retained once while overlapping writes stay segmented', async t => {
  const { store, scope } = await fixture(t)
  await record(store, scope, 'A', 'B', { execution: 'child1', clockId: 'clock', startedAt: 2, endedAt: 3, ancestors: ['outer'] })
  await record(store, scope, 'B', 'C', { execution: 'child2', clockId: 'clock', startedAt: 4, endedAt: 5, ancestors: ['outer'] })
  await record(store, scope, 'A', 'C', { execution: 'outer', origin: 'observed', clockId: 'clock', startedAt: 1, endedAt: 6 })
  let entry = (await store.list(scope)).entries[0]
  assert.equal(entry.segments.length, 1); assert.equal(entry.operations.length, 3)
  assert.equal(entry.operations.filter(op => op.evidenceOnly).length, 1); assert.equal(entry.attribution, 'confirmed')
  await record(store, scope, 'C', 'D', { clockId: 'clock', startedAt: 7, endedAt: 12 })
  await record(store, scope, 'D', 'E', { clockId: 'clock', startedAt: 9, endedAt: 14 })
  entry = (await store.list(scope)).entries[0]
  assert.equal(entry.reason, 'concurrent'); assert.equal(entry.stats.added, null); assert.equal(entry.segments.length, 2)
})
test('all operation pages and every segment line remain accessible and revision scoped', async t => {
  const { store, scope } = await fixture(t), api = new ChangesApi(store)
  const long = Array.from({ length: 1001 }, (_, i) => `line ${i}\n`).join('')
  await record(store, scope, null, long)
  for (let i = 1; i <= 24; i++) await record(store, scope, i === 1 ? long : `value ${i - 1}\n`, `value ${i}\n`)
  await record(store, scope, 'external\n', 'last\n')
  const list = await api.listChanges(scope, 'session'), entry = list.entries[0]
  const first = await api.listFileOperations(scope, entry.fileId, list.revision, 'operations', 0)
  const next = await api.listFileOperations(scope, entry.fileId, list.revision, 'operations', first.nextOffset)
  assert.equal(first.records.length, 20); assert.equal(next.records.length, 6); assert.equal(next.nextOffset, null)
  assert.equal(first.records[0].index, 26)
  assert.equal(next.records.at(-1).index, 1)
  assert.notEqual(first.records[0].id, next.records.at(-1).id)
  const longRecord = [...first.records, ...next.records].find(record => record.stats.added === 1001)
  assert.ok(longRecord)
  let offset = 0, rows = []
  do {
    const page = await api.getOperationDiff(scope, entry.fileId, list.revision, longRecord.id, offset)
    rows.push(...page.rows); offset = page.nextOffset
  } while (offset !== null)
  assert.equal(rows.length, 1001); assert.equal(rows.at(-1).text, 'line 1000')
  const segments = await api.listFileOperations(scope, entry.fileId, list.revision, 'segments', 0)
  assert.equal(segments.records.length, 2)
  assert.ok((await api.getOperationDiff(scope, entry.fileId, list.revision, segments.records[1].id, 0)).rows.some(row => row.text === 'last'))
  await assert.rejects(api.getOperationDiff({ ...scope, sessionId: 'other' }, entry.fileId, list.revision, first.records[0].id, 0), /stale/)
  await assert.rejects(api.listFileOperations(scope, entry.fileId, list.revision, 'bogus', 0), /invalid-request/)
})
test('session roots and saved snapshots survive cwd changes and an offline old directory', async t => {
  const { store, scope, directory } = await fixture(t), api = new ChangesApi(store)
  await record(store, scope, 'old', 'first')
  const nextRoot = path.join(directory, 'next'); await mkdir(nextRoot)
  await record(store, { ...scope, root: nextRoot }, 'new', 'second')
  await rm(scope.root, { recursive: true })
  const list = await api.listChanges({ ...scope, root: nextRoot }, 'session')
  assert.equal(list.entries.length, 2); assert.equal(list.roots.length, 2)
  const old = list.entries.find(entry => entry.root === scope.root)
  assert.ok((await api.getFileDiff({ ...scope, root: nextRoot }, 'session', old.fileId, list.revision, 0)).rows.some(row => row.text === 'first'))
  const ctx = { sessions: { get: () => ({ header: { cwd: scope.root } }) } }
  assert.equal((await resolveScope(ctx, scope.sessionId)).root, scope.root)
})
test('v1 records migrate without mutating originals or repeating operation imports', async t => {
  const { store, scope, snapshots } = await fixture(t)
  await store.ready
  const before = await store.snapshot(absent()), middle = await store.snapshot(endpoint('one')), after = await store.snapshot(endpoint('two'))
  const original = JSON.stringify({ schemaVersion: 1, sessionId: scope.sessionId, root: scope.root, startedAt: 1, revision: 2, pending: {}, gaps: ['scan'], operations: [
    { id: 'old1', path: 'a', origin: 'structured', before, after: middle }, { id: 'old2', path: 'a', origin: 'observed', before: middle, after }] })
  const file = path.join(snapshots, 'sessions', store.key(scope) + '.json'); await writeFile(file, original)
  const one = await store.list(scope), two = await store.list(scope)
  assert.equal(one.entries.length, 1); assert.equal(one.revision, two.revision); assert.ok(one.gaps.includes('legacy-scan'))
  await record(store, scope, 'two', 'three', { id: 'stable' }); await record(store, scope, 'two', 'three', { id: 'stable' })
  assert.equal((await store.list(scope)).entries[0].operations.length, 3)
  assert.equal(await readFile(file, 'utf8'), original)
  assert.equal((await new SnapshotStore(snapshots).list(scope)).entries[0].after.text, 'three')
})
test('concurrent store writers retain both records and journal order detects overlap across clocks', async t => {
  const { store, scope, snapshots } = await fixture(t), other = new SnapshotStore(snapshots)
  await Promise.all([store.begin(scope, 'a', 'a'), other.begin(scope, 'b', 'b')])
  await Promise.all([
    record(store, scope, 'A', 'B', { execution: 'a', clockId: 'one', startedAt: 1, endedAt: 2 }),
    record(other, scope, 'B', 'C', { execution: 'b', clockId: 'two', startedAt: 3, endedAt: 4 }),
  ])
  const entry = (await store.list(scope)).entries[0]
  assert.equal(entry.operations.length, 2); assert.equal(entry.reason, 'concurrent')
})
test('system exclusions are normal, generated paths are covered, and budgets are explicit', async t => {
  const { root } = await fixture(t)
  await mkdir(path.join(root, '.git')); await writeFile(path.join(root, '.git', 'internal'), 'metadata')
  await mkdir(path.join(root, 'target')); await writeFile(path.join(root, 'target', 'file'), 'tracked build edit')
  const full = await scan(root)
  assert.equal(full.incomplete, false); assert.deepEqual(full.gaps, []); assert.ok(full.files.has('target/file'))
  const limited = await scan(root, [], { bytes: 0 })
  assert.equal(limited.files.get('target/file').reason, 'scan-content'); assert.ok(limited.gaps.length)
  assert.equal((await scan(root, [], { files: 0 })).incomplete, true)
})
test('unknown tool physical writes and rejected execution remain readable observed changes', async t => {
  const { root, store, scope } = await fixture(t), handlers = new Map()
  installRecorder({ on: (name, fn) => handlers.set(name, fn), effect() {} }, store)
  const exec = { name: 'third_party_script', token: Symbol(), callId: 'x', agent: { id: 'transient-agent', session: { id: scope.sessionId, header: { cwd: root } } } }
  await assert.rejects(handlers.get('tools/execute')(exec, async () => { await writeFile(path.join(root, 'a'), 'saved'); throw Error('failed') }))
  const entry = (await store.list(scope)).entries[0]
  assert.equal(entry.reason, null); assert.equal(entry.attribution, 'observed'); assert.equal(entry.after.text, 'saved')
  assert.equal(entry.operations[0].finalStatus, 'error')
})
test('managed background jobs are observed after the foreground tool returns', async t => {
  const { root, store, scope } = await fixture(t), handlers = new Map(), listeners = new Set(), list = []
  const jobs = { list: () => list, get: id => list.find(job => job.id === id), events: { subscribe(filter, listener) { listeners.add(listener); return () => listeners.delete(listener) } } }
  let cleanup
  installRecorder({ on: (name, fn) => handlers.set(name, fn), get: name => name === 'jobs' ? jobs : null, effect(fn) { cleanup = fn() } }, store, { jobPollMs: 25 })
  t.after(cleanup)
  const exec = { name: 'shell', token: Symbol(), callId: 'job', agent: { id: scope.sessionId, session: { header: { cwd: root } } } }
  await handlers.get('tools/execute')(exec, async () => { list.push({ id: 'bash-1', owner: scope.sessionId, status: 'running' }); return { value: null } })
  assert.ok((await store.list(scope)).pendingCount > 0)
  await writeFile(path.join(root, 'later'), 'background')
  list[0].status = 'completed'; for (const listener of listeners) listener({ type: 'settled', job: list[0] })
  let data
  for (let i = 0; i < 100; i++) { await new Promise(resolve => setTimeout(resolve, 20)); data = await store.list(scope); if (!data.pendingCount) break }
  assert.equal(data.pendingCount, 0); assert.equal(data.entries[0].after.text, 'background')
  assert.equal(data.entries[0].operations[0].channel, 'background-job'); assert.equal(data.entries[0].attribution, 'observed')
})
test('legacy expanded file IDs migrate only when the alias is unambiguous', () => {
  assert.deepEqual(migrateFileIds(['old', 'observed', 'gone'], [{ fileId: 'new', aliases: ['old', 'observed'] }]), ['new'])
  assert.deepEqual(migrateFileIds(['old'], [{ fileId: 'one', aliases: ['old'] }, { fileId: 'two', aliases: ['old'] }]), [])
})
test('live journals are not interrupted and a failed quota commit stops reporting collection in progress', async t => {
  const { scope, snapshots } = await fixture(t), limited = new SnapshotStore(snapshots, { ...LIMITS, disk: 2000 })
  await limited.begin(scope, 'live', 'call')
  const live = await limited.list(scope)
  assert.equal(live.pendingCount, 1); assert.ok(!live.gaps.includes('interrupted'))
  await assert.rejects(record(limited, scope, null, 'a'.repeat(3000), { execution: 'live' }), /quota/)
  const failed = await limited.list(scope)
  assert.equal(failed.pendingCount, 0); assert.ok(failed.gaps.includes('quota'))
})
