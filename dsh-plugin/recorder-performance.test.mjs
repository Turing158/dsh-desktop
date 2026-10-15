import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { installRecorder, scan } from './sidebar-changes/host/session-recorder.mjs'
import { SnapshotStore } from './sidebar-changes/host/snapshot-store.mjs'
import { createScanPool } from './sidebar-changes/host/scan-pool.mjs'

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-recorder-perf-')))
  const root = path.join(directory, 'workspace')
  await mkdir(root)
  const store = new SnapshotStore(path.join(directory, 'snapshots'))
  const handlers = new Map()
  installRecorder({ on: (name, fn) => handlers.set(name, fn), effect() {}, get() {} }, store)
  const agent = { id: 'perf', session: { id: 'perf', header: { cwd: root } } }
  const scope = { sessionId: 'perf', root }
  async function run(name, execute) {
    const exec = { name, agent, arguments: {}, callId: crypto.randomUUID(), token: Symbol() }
    const result = await handlers.get('tools/execute')(exec, execute)
    handlers.get('tools/result')(exec, result)
    await store.flush()
    return result
  }
  t.after(async () => { await store.flush(); await rm(directory, { recursive: true, force: true }) })
  return { root, store, scope, run }
}

test('hundreds of built-in reads/searches perform no snapshot or journal work', async t => {
  const { run, store } = await fixture(t)
  const before = store.revision
  for (let i = 0; i < 400; i++) {
    const result = { isError: false, value: i }
    assert.equal(await run(['read', 'read_image', 'glob', 'grep'][i % 4], async () => result), result)
  }
  assert.equal(store.revision, before)
  assert.equal(store.live.size, 0)
  const failure = new Error('native read failed')
  await assert.rejects(run('read', async () => { throw failure }), error => error === failure)
})

test('unknown tools still capture writes; unchanged final status does not rewrite history', async t => {
  const { run, store, root, scope } = await fixture(t)
  let notifications = 0
  store.subscribe(() => notifications++)
  await run('third_party_tool', async () => {
    await writeFile(path.join(root, 'a.txt'), 'created\n')
    return { isError: false, value: null }
  })
  const data = await store.list(scope)
  assert.equal(data.entries[0].after.text, 'created\n')
  assert.equal(data.entries[0].operations[0].finalStatus, 'success')
  assert.equal(notifications, 2, 'only begin and finish publish; redundant final does not')
  const token = data.entries[0].operations[0].execution
  await store.final(scope, token, 'error')
  assert.equal((await store.list(scope)).entries[0].operations[0].finalStatus, 'error')
  assert.equal(notifications, 3, 'a changed outcome must still persist')
})

test('scan reuses unchanged content, invalidates same-size edits and recovers exhausted budgets', async t => {
  const { root } = await fixture(t)
  await writeFile(path.join(root, 'a'), 'before')
  await writeFile(path.join(root, 'b'), 'stable')
  const first = await scan(root)
  const second = await scan(root, undefined, { previous: first })
  assert.equal(second.files.get('a'), first.files.get('a'))
  assert.equal(second.files.get('b'), first.files.get('b'))
  await writeFile(path.join(root, 'a'), 'edited')
  await utimes(path.join(root, 'a'), new Date(), new Date(Date.now() + 2000))
  const third = await scan(root, undefined, { previous: second })
  assert.equal(third.files.get('a').text, 'edited')
  assert.notEqual(third.files.get('a'), second.files.get('a'))
  assert.equal(third.files.get('b'), second.files.get('b'))
  const limited = await scan(root, undefined, { bytes: 0, previous: third })
  assert.equal(limited.files.get('b').reason, 'scan-content')
  const restored = await scan(root, undefined, { previous: limited })
  assert.equal(restored.files.get('b').text, 'stable')
})

test('19 overlapping tools share unchanged snapshots and release the cache after the last user', async t => {
  const { root } = await fixture(t)
  await writeFile(path.join(root, 'a'), 'shared baseline')
  let active = 0, maximum = 0, scans = 0, lastPrevious
  const retain = createScanPool(async (root, previous) => {
    scans++
    maximum = Math.max(maximum, ++active)
    lastPrevious = previous
    try { return await scan(root, undefined, { previous }) } finally { active-- }
  })
  const users = Array.from({ length: 19 }, () => retain(root))
  const snapshots = await Promise.all(users.map(user => user.snapshot()))
  assert.equal(maximum, 1, 'parallel agents must not launch parallel full-tree scans')
  assert.equal(scans, 1, 'requests queued before a scan begins share that boundary')
  for (const snapshot of snapshots) assert.equal(snapshot.files.get('a'), snapshots[0].files.get('a'))
  users.slice(0, -1).forEach(user => user.release())
  await writeFile(path.join(root, 'a'), 'changed baseline')
  const next = await users.at(-1).snapshot()
  assert.equal(next.files.get('a').text, 'changed baseline')
  assert.equal(snapshots[0].files.get('a').text, 'shared baseline', 'earlier tool baselines stay immutable')
  users.at(-1).release()
  const fresh = retain(root)
  await fresh.snapshot()
  assert.equal(lastPrevious, undefined, 'no idle workspace content cache remains')
  fresh.release()
})

test('a snapshot requested during a scan waits for a fresh boundary; failures do not poison the queue', async () => {
  let scans = 0, unblock, entered
  const started = new Promise(resolve => { entered = resolve })
  const retain = createScanPool(async () => {
    const version = ++scans
    if (version === 1) { entered(); await new Promise(resolve => { unblock = resolve }) }
    if (version === 3) throw Error('scan failed')
    return { version }
  })
  const user = retain(path.resolve('test-root'))
  const first = user.snapshot()
  await started
  const second = user.snapshot()
  unblock()
  assert.equal((await first).version, 1)
  assert.equal((await second).version, 2)
  await assert.rejects(user.snapshot(), /scan failed/)
  assert.equal((await user.snapshot()).version, 4)
  user.release()
})
