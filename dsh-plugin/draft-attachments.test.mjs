import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./ui-state/client.js', import.meta.url), 'utf8')
const settle = () => new Promise(setImmediate)

function store(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { value = next; for (const fn of [...listeners]) fn() },
    get listeners() { return listeners.size },
  }
}

function fixture({ legacy = false, start = true } = {}) {
  const assets = new Map(), scopes = new Map(), cleanups = [], releases = [], revoked = []
  const rows = { a: { id: 'a', retainedBy: {} }, b: { id: 'b', retainedBy: {} } }
  const list = store({ phase: 'ready', ids: Object.keys(rows), byId: rows })
  let selected, plugin, nextId = 0, draftChanges = 0
  const publish = () => list.set({ ...list.getSnapshot(), ids: Object.keys(rows), byId: { ...rows } })
  function releaseAsset(id) {
    const asset = assets.get(id)
    if (asset?.previewUrl) revoked.push(asset.previewUrl)
    assets.delete(id)
  }
  function retain(id, { source }) {
    let entry = scopes.get(id)
    if (!entry) {
      const state = store({ draft: '', attachmentIds: [] }), scope = { id }
      const session = store({ pendingSubmissions: [] })
      entry = { scope, session, input: { state }, references: 0 }
      scopes.set(id, entry)
    }
    const owned = entry
    owned.references++
    rows[id].retainedBy[source] = (rows[id].retainedBy[source] || 0) + 1
    publish()
    let released = false
    return { ready: Promise.resolve(), release() {
      if (released) return
      released = true
      releases.push({ id, source })
      if (rows[id]) rows[id].retainedBy[source]--
      if (--owned.references === 0 && !legacy) {
        scopes.delete(id)
        for (const attachmentId of owned.input.state.getSnapshot().attachmentIds) releaseAsset(attachmentId)
        owned.disposed = true
      }
      publish()
    } }
  }
  const ctx = {
    sessions: { list, scope: id => scopes.get(id)?.scope, binding: id => scopes.get(id), ...legacy ? {} : { retain } },
    conversation: {
      input: { for: scope => scopes.get(scope.id).input },
      resolveDraftAttachments: ids => ids.map(id => assets.get(id)).filter(Boolean),
    },
    effect(fn) { cleanups.push(fn()) },
  }
  const window = { __ModuleLoader__: { load(value) { plugin = value.factory() } }, __DSH_UI_STATE__: { draftsChanged() { draftChanges++ } } }
  window.top = window
  vm.runInNewContext(source, { window, queueMicrotask })
  const open = id => {
    const previous = selected
    selected = retain(id, { source: 'mainView' })
    previous?.release()
    return scopes.get(id)
  }
  const add = (id, kind = 'file') => {
    const asset = { id: 'asset-' + ++nextId, kind, file: new File(['附件内容 ' + nextId], kind === 'image' ? 'picture.png' : 'notes.txt'),
      ...kind === 'image' ? { previewUrl: 'blob:preview-' + nextId } : {} }
    assets.set(asset.id, asset)
    const state = scopes.get(id).input.state
    state.set({ ...state.getSnapshot(), attachmentIds: [...state.getSnapshot().attachmentIds, asset.id] })
    return asset
  }
  const remove = (id, attachmentId) => {
    const state = scopes.get(id).input.state
    state.set({ ...state.getSnapshot(), attachmentIds: state.getSnapshot().attachmentIds.filter(value => value !== attachmentId) })
    releaseAsset(attachmentId)
  }
  open('a')
  if (start) plugin.apply(ctx)
  return { ctx, rows, list, scopes, assets, releases, revoked, open, add, remove, releaseAsset, get draftChanges() { return draftChanges },
    start: () => plugin.apply(ctx), dispose: () => cleanups.reverse().forEach(fn => fn()),
    delete(id) { delete rows[id]; publish() } }
}

test('navigation preserves per-session files, images, bytes and previews without a native snapshot bridge', async () => {
  const f = fixture(), originalA = f.scopes.get('a')
  const fileA = f.add('a'), imageA = f.add('a', 'image')
  const originalB = f.open('b'), fileB = f.add('b')
  for (let i = 0; i < 3; i++) { f.open('a'); f.open('b') }
  await settle()
  assert.equal(f.scopes.get('a'), originalA)
  assert.equal(f.scopes.get('b'), originalB)
  assert.deepEqual(originalA.input.state.getSnapshot().attachmentIds, [fileA.id, imageA.id])
  assert.deepEqual(originalB.input.state.getSnapshot().attachmentIds, [fileB.id])
  assert.equal(await f.assets.get(fileA.id).file.text(), '附件内容 1')
  assert.equal(f.assets.get(imageA.id).previewUrl, imageA.previewUrl)
  assert.deepEqual(f.revoked, [])
  assert.equal(f.rows.a.retainedBy.desktopDraftAttachments, 1)
  assert.equal(f.rows.b.retainedBy.desktopDraftAttachments, 1)
  f.dispose()
})

test('empty sessions are released; pre-existing drafts are protected when the plugin mounts', async () => {
  const f = fixture({ start: false })
  const asset = f.add('a')
  f.start()
  const emptyB = f.open('b')
  f.open('a')
  assert.equal(emptyB.disposed, true)
  assert.equal(f.assets.get(asset.id), asset)
  f.dispose()
})

test('removing the last attachment releases an inactive scope and does not restore deleted files', async () => {
  const f = fixture(), original = f.scopes.get('a'), first = f.add('a'), last = f.add('a', 'image')
  f.open('b')
  f.remove('a', first.id)
  await settle()
  assert.equal(f.scopes.get('a'), original)
  f.remove('a', last.id)
  assert.equal(original.disposed, undefined, 'do not dispose during input notification')
  await settle()
  assert.equal(original.disposed, true)
  assert.deepEqual(f.open('a').input.state.getSnapshot().attachmentIds, [])
  assert.deepEqual(f.revoked, [last.previewUrl])
  f.dispose()
})

test('optimistic sends retain attachments until settlement and failed sends can restore them offscreen', async () => {
  const f = fixture(), original = f.scopes.get('a'), asset = f.add('a')
  const state = original.input.state
  state.set({ ...state.getSnapshot(), attachmentIds: [] })
  // Serialization can await before the session publishes a pending submission.
  f.open('b')
  await settle()
  assert.equal(f.scopes.get('a'), original)
  assert.equal(f.assets.get(asset.id), asset)
  state.set({ ...state.getSnapshot(), attachmentIds: [asset.id] })
  await settle()
  assert.equal(f.open('a'), original)
  assert.deepEqual(state.getSnapshot().attachmentIds, [asset.id])
  // A successful attachment-only send need not publish another input change.
  state.set({ ...state.getSnapshot(), attachmentIds: [] })
  f.open('b')
  original.session.set({ pendingSubmissions: [] })
  f.releaseAsset(asset.id)
  await settle()
  assert.equal(original.disposed, true)
  assert.equal(f.assets.size, 0)
  f.dispose()
})

test('deleting a session and disposing the plugin release references and subscriptions', async () => {
  const f = fixture(), a = f.scopes.get('a')
  f.add('a')
  const b = f.open('b')
  f.add('b', 'image')
  f.delete('a')
  assert.equal(a.disposed, true)
  assert.equal(a.input.state.listeners, 0)
  assert.equal(a.session.listeners, 0)
  f.dispose()
  await settle()
  assert.equal(b.input.state.listeners, 0)
  assert.equal(b.session.listeners, 0)
  assert.equal(f.list.listeners, 0)
  assert.deepEqual(f.releases.filter(value => value.source === 'desktopDraftAttachments').map(value => value.id), ['a', 'b'])
})

test('legacy sessions watch text and session changes while retaining their original lifecycle', () => {
  const f = fixture({ legacy: true }), asset = f.add('a')
  const a = f.scopes.get('a')
  const before=f.draftChanges
  a.input.state.set({ ...a.input.state.getSnapshot(),draft:'legacy unsent text' })
  assert.equal(f.draftChanges,before+1)
  a.session.set({pendingSubmissions:[]});assert.equal(f.draftChanges,before+2)
  f.open('b')
  assert.equal(f.open('a'), a)
  assert.equal(f.assets.get(asset.id), asset)
  assert.equal(f.rows.a.retainedBy.desktopDraftAttachments,undefined)
  f.dispose()
  assert.equal(f.list.listeners,0);assert.equal(a.input.state.listeners,0);assert.equal(a.session.listeners,0)
})
