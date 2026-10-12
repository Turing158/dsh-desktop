import test from 'node:test'
import assert from 'node:assert/strict'
import { createDocuments } from './file-editor/documents.mjs'
import { createCloseGuard } from './file-editor/close-guard.mjs'
import { bindReloadGuard } from './file-editor/reload-guard.mjs'
import { decodeText, FileEditorApi } from './file-editor/host.mjs'
import { MAX_BYTES, parseFile, contribution } from './file-editor/protocol.mjs'
const address = 'dsh-resource://file/session/session-a/folder/%E4%B8%AD%E6%96%87%20%23%20file.ts'
const ok = value => ({ ok: true, value })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(overrides = {}) {
  const remote = { read: async () => ok({ text: 'initial\n', version: 'v1', eol: '\n', bom: false }),
    save: async (_id, _path, _version, text) => ok({ text, version: 'v2', eol: '\n', bom: false }), ...overrides }
  const docs = createDocuments(remote), doc = docs.get(address)
  return { docs, doc }
}

function observable(value) {
  const listeners = new Set()
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { value = next; for (const fn of listeners) fn() } }
}
async function closeFixture(remote) {
  const { docs, doc } = fixture(remote)
  await doc.load(); doc.edit('draft')
  const tab = { id: 'tab-a', kind: 'text', contentId: address }, abort = new AbortController()
  const navigation = observable({ address, revision: 1 })
  const side = { mounted: observable('session-a'), openTabs: observable([tab]),
    tabsIn: () => side.openTabs.getSnapshot(), tabDomain: { occurrence: () => ({ signal: abort.signal, navigation }) },
    removeAfterCleanup(_session, _tab, commit) { commit() } }
  const original = side.removeAfterCleanup, guard = createCloseGuard(side, docs)
  let commits = 0
  const close = (commit = () => { commits++; side.openTabs.set([]) }) => side.removeAfterCleanup('session-a', tab, commit)
  return { docs, doc, tab, side, abort, navigation, original, guard, close, commits: () => commits }
}

test('application close dialog cancels safely and only commits after a successful save', async () => {
  const f = await closeFixture()
  f.close(); assert.equal(f.commits(), 0)
  f.guard.cancel(); assert.equal(f.doc.getSnapshot().text, 'draft'); assert.equal(f.commits(), 0)
  f.close(); await f.guard.save()
  assert.equal(f.commits(), 1); assert.equal(f.doc.dirty(), false)
  assert.equal(f.docs.documents.has(address), false); assert.equal(f.guard.getSnapshot().request, null)
  f.guard.dispose(); assert.equal(f.side.removeAfterCleanup, f.original)
})

test('close save failures keep the draft and dialog available for retry', async () => {
  let calls = 0
  const f = await closeFixture({ save: async (_id, _path, _version, text) => ++calls === 1
    ? { ok: false, error: { message: 'disk full' } } : ok({ text, version: 'v2' }) })
  f.close(); await f.guard.save()
  assert.equal(f.commits(), 0); assert.equal(f.doc.dirty(), true)
  assert.equal(f.guard.getSnapshot().error, 'disk full')
  await f.guard.save(); assert.equal(f.commits(), 1)
  f.guard.dispose()
})

test('duplicate closes retain the original replacement commit; discard never saves', async () => {
  const f = await closeFixture({ save: async () => { throw Error('must not save on discard') } })
  let replacement = 0, duplicate = 0
  f.close(() => { replacement++; f.side.openTabs.set([]) })
  f.close(() => { duplicate++ })
  f.guard.discard()
  assert.equal(replacement, 1); assert.equal(duplicate, 0); assert.equal(f.docs.documents.has(address), false)
  f.guard.dispose()
})

test('a close cannot discard an in-flight save or discard edits made during that save', async () => {
  const waiting = deferred(), f = await closeFixture({ save: () => waiting.promise })
  f.close(); const saving = f.guard.save()
  f.guard.discard(); assert.equal(f.commits(), 0)
  f.doc.edit('newer draft')
  waiting.resolve(ok({ text: 'draft', version: 'v2' })); await saving
  assert.equal(f.commits(), 0); assert.equal(f.doc.getSnapshot().text, 'newer draft')
  assert.ok(f.guard.getSnapshot().request); assert.match(f.guard.getSnapshot().error, /未保存/)
  f.guard.dispose()
})

test('cancelling while saving does not close the file when the write later completes', async () => {
  const waiting = deferred(), f = await closeFixture({ save: () => waiting.promise })
  f.close(); const saving = f.guard.save(); f.guard.cancel()
  waiting.resolve(ok({ text: 'draft', version: 'v2' })); await saving
  assert.equal(f.commits(), 0); assert.equal(f.docs.documents.get(address), f.doc)
  assert.equal(f.guard.getSnapshot().request, null); assert.equal(f.doc.dirty(), false)
  f.guard.dispose()
})

test('session switches, replaced navigation and removed occurrences cancel stale close intents', async () => {
  for (const invalidate of [f => f.side.mounted.set('session-b'), f => f.navigation.set({ address, revision: 2 }), f => f.abort.abort()]) {
    const waiting = deferred(), f = await closeFixture({ save: () => waiting.promise })
    f.close(); const saving = f.guard.save(); invalidate(f)
    assert.equal(f.guard.getSnapshot().request, null)
    waiting.resolve(ok({ text: 'draft', version: 'v2' })); await saving
    assert.equal(f.commits(), 0); assert.equal(f.docs.documents.get(address), f.doc)
    f.guard.dispose()
  }
})

test('closing another occurrence preserves the shared draft without prompting', async () => {
  const f = await closeFixture(), other = { ...f.tab, id: 'tab-b' }
  f.side.openTabs.set([f.tab, other]); f.close(() => f.side.openTabs.set([other]))
  assert.equal(f.guard.getSnapshot().request, null)
  assert.equal(f.docs.documents.get(address), f.doc); assert.equal(f.doc.dirty(), true)
  f.side.removeAfterCleanup('session-a', other, () => {}); assert.ok(f.guard.getSnapshot().request)
  f.guard.dispose()
})

test('reload confirmation cancels without reading, and discard rereads without closing or saving', async () => {
  let reads = 0, resumed = 0
  const f = await closeFixture({ read: async () => ok({ text: ++reads === 1 ? 'initial' : 'disk update', version: 'v' + reads }),
    save: async () => { throw Error('discard must not save') } })
  const reload = () => f.guard.reload('session-a', f.tab, f.doc, () => { resumed++ })
  reload(); assert.equal(f.guard.getSnapshot().request.kind, 'reload'); assert.equal(reads, 1)
  f.guard.cancel(); assert.equal(f.doc.getSnapshot().text, 'draft'); assert.equal(reads, 1)
  reload(); reload(); await f.guard.discard()
  assert.equal(reads, 2); assert.equal(resumed, 1); assert.equal(f.commits(), 0)
  assert.equal(f.docs.documents.get(address), f.doc); assert.equal(f.doc.getSnapshot().text, 'disk update')
  assert.equal(f.doc.dirty(), false); assert.equal(f.guard.getSnapshot().request, null)
  f.guard.dispose()
})

test('save before reload writes first, preserves errors for retry, and then refreshes the same tab', async () => {
  const calls = []; let text = 'initial', fail = true
  const f = await closeFixture({ read: async () => { calls.push('read'); return ok({ text, version: 'v1' }) },
    save: async (_id, _path, _version, draft) => {
      calls.push('save'); if (fail) return { ok: false, error: { message: 'disk full' } }
      text = draft; return ok({ text, version: 'v2' })
    } })
  f.guard.reload('session-a', f.tab, f.doc, () => calls.push('refresh'))
  await f.guard.save()
  assert.deepEqual(calls, ['read', 'save']); assert.equal(f.guard.getSnapshot().error, 'disk full')
  assert.equal(f.doc.getSnapshot().text, 'draft'); assert.equal(f.doc.dirty(), true)
  fail = false; await f.guard.save()
  assert.deepEqual(calls, ['read', 'save', 'save', 'read', 'refresh'])
  assert.equal(f.commits(), 0); assert.equal(f.doc.getSnapshot().text, 'draft'); assert.equal(f.doc.dirty(), false)
  f.guard.dispose()
})

test('failed reload preserves the draft and dialog until a successful retry', async () => {
  let fail = false, resumed = 0
  const f = await closeFixture({ read: async () => fail ? { ok: false, error: { message: 'cannot read' } } : ok({ text: 'disk', version: 'v1' }) })
  fail = true; f.guard.reload('session-a', f.tab, f.doc, () => { resumed++ }); await f.guard.discard()
  assert.equal(f.doc.getSnapshot().text, 'draft'); assert.equal(f.guard.getSnapshot().error, 'cannot read')
  assert.equal(resumed, 0); fail = false; await f.guard.discard()
  assert.equal(resumed, 1); assert.equal(f.doc.getSnapshot().text, 'disk'); f.guard.dispose()
})

test('reload cannot discard edits made during saving, or resume a cancelled or stale request', async () => {
  for (const change of [f => f.doc.edit('newer draft'), f => f.guard.cancel(), f => f.navigation.set({ address, revision: 2 })]) {
    let reads = 0, resumed = 0; const waiting = deferred()
    const f = await closeFixture({ read: async () => { reads++; return ok({ text: 'disk', version: 'v1' }) }, save: () => waiting.promise })
    f.guard.reload('session-a', f.tab, f.doc, () => { resumed++ })
    const saving = f.guard.save(); change(f); waiting.resolve(ok({ text: 'draft', version: 'v2' })); await saving
    assert.equal(reads, 1); assert.equal(resumed, 0); assert.equal(f.commits(), 0)
    f.guard.dispose()
  }
})

test('refresh command guard retains upstream binding ownership through renderer changes', () => {
  let refreshed = 0, requested = 0, resume
  const occurrence = { commands: { refresh: () => { refreshed++ } } }
  const actions = { bindCommands(commands) { occurrence.commands = commands; return () => { if (occurrence.commands === commands) occurrence.commands = {} } } }
  const original = actions.bindCommands, initial = occurrence.commands
  const preview = { addEventListener() {}, removeEventListener() {} }
  const off = bindReloadGuard(occurrence, actions, preview, commit => { requested++; resume = commit })
  occurrence.commands.refresh(); assert.equal(requested, 1); assert.equal(refreshed, 0); resume(); assert.equal(refreshed, 1)
  const newer = { refresh: () => { refreshed += 10 } }, disposeNewer = actions.bindCommands(newer)
  occurrence.commands.refresh(); assert.equal(requested, 2); resume(); assert.equal(refreshed, 11)
  off(); assert.equal(actions.bindCommands, original); assert.equal(occurrence.commands, newer)
  disposeNewer(); assert.deepEqual(occurrence.commands, {})
  occurrence.commands = initial
  const offInitial = bindReloadGuard(occurrence, actions, preview, () => {})
  offInitial(); assert.equal(occurrence.commands, initial)
})
test('save completion leaves keystrokes typed during the request dirty; duplicate save is serialized', async () => {
  const waiting = deferred(); let calls = 0
  const { doc } = fixture({ save: async (_id, _path, version, text) => {
    calls++; assert.equal(version, 'v1'); assert.equal(text, 'first edit'); return waiting.promise
  } })
  await doc.load(); doc.edit('first edit')
  const first = doc.save(), duplicate = doc.save()
  doc.edit('second edit')
  waiting.resolve(ok({ version: 'v2', text: 'first edit', eol: '\n', bom: false }))
  assert.equal(await first, true); assert.equal(await duplicate, true)
  assert.equal(calls, 1); assert.equal(doc.getSnapshot().text, 'second edit')
  assert.equal(doc.getSnapshot().base, 'first edit'); assert.equal(doc.dirty(), true)
})

test('a read started by a viewer switch cannot overwrite a newer edit', async () => {
  const waiting = deferred(); let reads = 0
  const { doc } = fixture({ read: () => ++reads === 1 ? ok({ text: 'initial', version: 'v1' }) : waiting.promise })
  await doc.load()
  const loading = doc.load(true)
  doc.edit('<h1>new HTML draft</h1>')
  waiting.resolve(ok({ text: 'disk content', version: 'v2' }))
  await loading
  assert.equal(doc.getSnapshot().text, '<h1>new HTML draft</h1>')
  assert.equal(doc.getSnapshot().base, 'initial')
  assert.equal(doc.getSnapshot().version, 'v1')
  assert.equal(doc.getSnapshot().loading, false)
  assert.equal(doc.dirty(), true)
})
test('save failure retains the last successful version and draft; ordinary errors can be retried', async () => {
  let count = 0
  const { doc } = fixture({ save: async (_id, _path, _version, text) => ++count === 1
    ? { ok: false, error: { code: 'io', message: 'disk full' } } : ok({ version: 'v2', text }) })
  await doc.load(); doc.edit('draft')
  assert.equal(await doc.save(), false); assert.equal(doc.getSnapshot().version, 'v1')
  assert.equal(doc.getSnapshot().text, 'draft'); assert.equal(doc.getSnapshot().error, 'disk full')
  assert.equal(await doc.save(), true); assert.equal(doc.dirty(), false)
})
test('stale save cannot be retried as an unconditional overwrite; explicit reload clears the conflict', async () => {
  let calls = 0
  const { doc } = fixture({ save: async () => { calls++; return { ok: false, error: { code: 'desktop-file-editor/FS_STALE_VERSION', message: 'stale' } } } })
  await doc.load(); doc.edit('mine')
  assert.equal(await doc.save(), false); assert.equal(doc.getSnapshot().conflict, true)
  doc.edit('still mine'); await doc.save(); assert.equal(calls, 1)
  await doc.load(); assert.equal(doc.getSnapshot().text, 'still mine')
  await doc.load(true); assert.equal(doc.getSnapshot().text, 'initial\n'); assert.equal(doc.getSnapshot().conflict, false)
})
test('documents are isolated by resource identity and dirty drafts survive provider capture/restore', async () => {
  const { docs, doc } = fixture()
  await doc.load(); doc.edit('saved in snapshot')
  assert.equal(docs.get(address), doc)
  assert.notEqual(docs.get(address.replace('session-a', 'session-b')), doc)
  const snapshot = docs.capture(), other = fixture()
  other.docs.restore(snapshot)
  await other.doc.load()
  assert.equal(other.doc.getSnapshot().text, 'saved in snapshot')
  assert.equal(other.doc.getSnapshot().version, 'v1'); assert.equal(other.doc.dirty(), true)
})
test('capture refuses in-flight IO; repeated initial loads share one request', async () => {
  const waiting = deferred(); let calls = 0
  const { docs, doc } = fixture({ read: async () => { calls++; return waiting.promise } })
  const a = doc.load(), b = doc.load()
  assert.throws(() => docs.capture(), /读写/)
  waiting.resolve(ok({ text: '', version: 'empty', bom: false, eol: '\n' }))
  await Promise.all([a, b]); assert.equal(calls, 1); assert.equal(doc.dirty(), false)
  doc.edit('a'); assert.equal(doc.dirty(), true)
})
test('a late initial read cannot overwrite a draft restored during mounting', async () => {
  const waiting = deferred(), { docs, doc } = fixture({ read: () => waiting.promise })
  const pending = doc.load()
  docs.restore({ drafts: [{ address, state: { text: 'restored draft', base: 'base', version: 'previous' } }] })
  waiting.resolve(ok({ text: 'disk contents', version: 'new' }))
  await pending
  assert.equal(doc.getSnapshot().text, 'restored draft'); assert.equal(doc.getSnapshot().version, 'previous')
  assert.equal(doc.dirty(), true)
})
test('codec rejects malformed payloads before filesystem calls; file URIs decode per segment', () => {
  assert.deepEqual(parseFile(address), { sessionId: 'session-a', path: 'folder/中文 # file.ts' })
  assert.equal(parseFile('https://example.com/a.txt'), null)
  assert.equal(parseFile('dsh-resource://file/session/a/%xx'), null)
  for (const descriptor of contribution.descriptors) for (const parameter of descriptor.parameters) {
    assert.throws(() => parameter.codec.create().parse({}))
    if (parameter.name !== 'text') assert.throws(() => parameter.codec.create().parse('a\0b'))
  }
})
test('strict decoding preserves BOM, EOL and final newline metadata and rejects binary/invalid UTF-8', () => {
  assert.deepEqual(decodeText(Buffer.from('\uFEFF你好\r\nlast')), { text: '你好\nlast', bom: true, eol: '\r\n' })
  assert.deepEqual(decodeText(Buffer.from('')), { text: '', bom: false, eol: '\n' })
  assert.throws(() => decodeText(Buffer.from([0, 1, 2])), { code: 'editor/binary' })
  assert.throws(() => decodeText(Buffer.from([0xff, 0xfe])), { code: 'editor/encoding' })
})
function filesystemFixture(text = '\uFEFFfirst\r\n') {
  let bytes = Buffer.from(text), version = 'v1', writes = 0
  const fs = {
    resolve: async path => ({ targetKey: path, displayPath: path }), contains: (_root, target) => target.targetKey !== '../outside',
    lstat: async () => ({ type: 'file' }), stat: async () => ({ type: 'file', size: bytes.length, version }),
    readBytes: async () => bytes, processPath: target => target.displayPath,
    async writeText(_target, content, expected) {
      assert.deepEqual(expected, { kind: 'replaceIfVersion', version })
      bytes = Buffer.from(content); version = 'v2'; writes++; return { version }
    },
  }
  return { fs, api: new FileEditorApi(fs), scope: { root: '/workspace' }, bytes: () => bytes, writes: () => writes }
}
test('host save uses a version-guarded writer and retains source BOM/CRLF even with an empty result', async () => {
  const f = filesystemFixture(), source = await f.api.read(f.scope, 'file')
  assert.equal(source.text, 'first\n')
  await f.api.save(f.scope, 'file', source.version, 'new\nlast')
  assert.equal(f.bytes().toString(), '\uFEFFnew\r\nlast')
  await f.api.save(f.scope, 'file', 'v2', '')
  assert.equal(f.bytes().toString(), '\uFEFF')
})
test('host refuses stale, binary, oversized and out-of-scope writes without invoking the writer', async () => {
  const f = filesystemFixture()
  await assert.rejects(f.api.save(f.scope, 'file', 'old', 'new'), { code: 'FS_STALE_VERSION' })
  await assert.rejects(f.api.save(f.scope, 'file', 'v1', 'a\0b'), { code: 'editor/binary' })
  await assert.rejects(f.api.save(f.scope, 'file', 'v1', '中'.repeat(MAX_BYTES / 2)), { code: 'editor/large' })
  await assert.rejects(f.api.save(f.scope, '../outside', 'v1', 'new'), { code: 'editor/outside' })
  assert.equal(f.writes(), 0)
  const large = filesystemFixture('a'.repeat(MAX_BYTES + 1))
  await assert.rejects(large.api.read(large.scope, 'file'), { code: 'editor/large' })
})
