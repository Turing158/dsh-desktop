import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./ui-state/adapter.js', import.meta.url), 'utf8')
const bridgeSource = readFileSync(new URL('./ui-state/bridge.js', import.meta.url), 'utf8')
const frame = fn => queueMicrotask(fn)
const identity = op => ({ operationId: op, windowGeneration: 1, documentGeneration: 2, backendInstance: 3 })
const options = () => ({ signal: new AbortController().signal, frontendVersion: '0.1.5-rc.2', providers: new Map() })

function environment() {
  const listeners = new Map(), storage = new Map(), fields = [], dialogs = []
  const root = { inert: false }
  const body = { children: [], append(node) { this.children.push(node) } }
  const document = {
    body, activeElement: null,
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback) },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event) },
    getElementById() { return root },
    querySelector() { return null },
    querySelectorAll(selector) { return selector.startsWith('[role=dialog]') ? dialogs : selector.startsWith('input') ? fields : [] },
    createElement() { return { dataset: {}, style: {}, children: [], append(node) { this.children.push(node) }, remove() { this.removed = true }, setAttribute() {} } },
  }
  const localStorage = { get length() { return storage.size }, key: index => [...storage.keys()][index], getItem: key => storage.get(key) || null }
  const window = { addEventListener() {}, __DSH_UI_BOOT__: { windowGeneration: 1, restoring: false } }; window.top = window
  const globals = { window, document, localStorage, location: { hostname: '127.0.0.1', protocol: 'http:', pathname: '/', hash: '' }, history: { replaceState() {} }, Blob, File, Uint8Array, AbortController, setTimeout, clearTimeout, requestAnimationFrame: frame, btoa, atob, Event }
  const context = vm.createContext(globals)
  return { globals, context, window, document, root, body, fields, dialogs, storage }
}

function fixture({ text = '草稿一', second = 'draft two' } = {}) {
  const env = environment()
  const state = { ids: ['s1', 's2'], byId: { s1: { id: 's1' }, s2: { id: 's2' } }, current: 's1', phase: 'ready' }
  const layout = { layoutInfo: { sidebar: 333, narrowExpanded: false, rightbar: null, rightbarShown: false }, panelInfo: { activePanelId: null } }
  const attachments = new Map(), uploads = {}, inputs = new Map(), chatScroll = new Map(), sessions = new Map()
  let creations = 0
  const input = (id, text) => {
    const snapshot = { draft: text, attachmentIds: [], phase: 'plain', draftRev: 4 }
    const shell = { state: { getSnapshot: () => snapshot }, setDraft(value) { snapshot.draft = value }, caretSpan: () => ({ start: 0, end: 0 }),
      addAttachments(ids) { snapshot.attachmentIds = [...snapshot.attachmentIds, ...ids]; return true },
      removeAttachment(id) { snapshot.attachmentIds = snapshot.attachmentIds.filter(value => value !== id); return true },
      editor: { getRootElement: () => null, isComposing: () => false, getEditorState: () => ({ toJSON: () => ({ text: snapshot.draft }) }), parseEditorState: json => JSON.parse(json), setEditorState(value) { snapshot.draft = value.text } } }
    inputs.set(id, shell)
    sessions.set(id, { getSnapshot: () => ({ pendingSubmissions: [], newestMessage: 'arrived while minimal' }) })
  }
  input('s1', text); input('s2', second)
  const store = { getSnapshot: () => layout, actions: { setSidebar(value) { layout.layoutInfo.sidebar = value }, toggleSidebar() { layout.layoutInfo.narrowExpanded = !layout.layoutInfo.narrowExpanded }, setRightbar(value) { layout.layoutInfo.rightbar = value } } }
  const ctx = {
    slots: { entriesOfSlot: key => key === 'root' ? [{ store: { create: () => store } }] : [{ options: { id: 'chat' }, inject: id => ({ chatScroll: { read: () => chatScroll.get(id) || null, save: value => chatScroll.set(id, value) } }) }] },
    layout: { selectPanel(value) { layout.panelInfo.activePanelId = value } },
    sessions: { list: { getSnapshot: () => state }, scope: id => inputs.has(id) ? { id } : undefined, binding: id => sessions.has(id) ? { session: sessions.get(id) } : undefined, open(id) { state.current = id }, clear() { state.current = undefined } },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }] }) } },
    uiWorkspace: { openSession(id) { state.current = id } },
    conversation: { input: { for: scope => inputs.get(scope.id) }, resolveDraftAttachments: ids => ids.map(id => attachments.get(id)).filter(Boolean), fileUploads: { getSnapshot: () => uploads },
      createDrafts(sessionId, files) { return files.map(file => { const attachment = { id: 'a' + (++creations), kind: file.type.startsWith('image/') ? 'image' : 'file', file }; attachments.set(attachment.id, attachment); uploads[attachment.id] = { status: 'ready' }; return attachment }) } },
  }
  vm.runInContext(source, env.context)
  const adapter = env.window.__DSH_CREATE_UI_ADAPTER__(ctx)
  return { ...env, adapter, ctx, state, layout, inputs, attachments, uploads, sessions, get creations() { return creations } }
}

test('only remote apply with a terminal provider accepts live terminals and a terminal sidebar', async () => {
  const f = fixture(), calls = []
  f.window.__DSH_TERMINAL_IDENTITY__ = {}
  f.window.__TAURI__ = { core: { invoke: async name => { calls.push(name); return [{}] } } }
  await assert.rejects(f.adapter.capture(options()), /snapshot-terminal-active/)
  await assert.rejects(f.adapter.capture({ ...options(), remoteApply: true }), /snapshot-terminal-active/)
  const remote = { ...options(), remoteApply: true }
  remote.providers.set('desktop-terminal', { version: 1, ownsSidebar: () => true, owns: node => node.terminal === true, capture: () => ({ retained: true }) })
  f.layout.layoutInfo.rightbarShown = true
  f.fields.push({ terminal: true, type: 'textarea', value: 'terminal input', closest(selector) { return selector === '[role=dialog]' ? this : null }, getClientRects: () => [1] })
  const payload = await f.adapter.capture(remote)
  assert.equal(payload.dialogs[0].id, 'desktop-terminal')
  assert.equal(calls.length, 2)
  remote.providers.get('desktop-terminal').ownsSidebar = () => false
  await assert.rejects(f.adapter.capture(remote), /snapshot-panel-unsupported/)
  await assert.rejects(f.adapter.capture({ ...remote, remoteApply: false }), /snapshot-terminal-active/)
})

test('file editor owns its sidebar and editable fields during a safe snapshot', async () => {
  const f = fixture(), opts = options()
  f.layout.layoutInfo.rightbarShown = true
  f.fields.push({ fileEditor: true, type: 'textarea', value: 'code draft', closest(selector) { return selector === '[role=dialog]' ? this : null }, getClientRects: () => [1] })
  opts.providers.set('desktop-file-editor', { version: 1, ownsSidebar: () => true,
    owns: node => node.fileEditor === true, capture: () => ({ drafts: [{ text: 'code draft' }], sides: [] }) })
  const payload = await f.adapter.capture(opts)
  assert.equal(payload.dialogs[0].id, 'desktop-file-editor')
  opts.providers.get('desktop-file-editor').ownsSidebar = () => false
  await assert.rejects(f.adapter.capture(opts), /snapshot-panel-unsupported/)
})

test('multi-session controlled drafts and image/file contents survive, without replacing new messages', async () => {
  const original = fixture()
  const files = [new File(['pixels'], 'p.png', { type: 'image/png' }), new File(['文档'], 'note.txt', { type: 'text/plain' })]
  const attached = original.ctx.conversation.createDrafts('s1', files)
  original.inputs.get('s1').addAttachments(attached.map(a => a.id))
  const payload = await original.adapter.capture(options())
  assert.equal(payload.drafts.length, 2)
  assert.equal(payload.assets.length, 2)
  const fresh = fixture({ text: '', second: '' })
  const snapshot = { snapshotId: 10, payload }
  await fresh.adapter.restore(snapshot, options())
  assert.equal(fresh.inputs.get('s1').state.getSnapshot().draft, '草稿一')
  assert.equal(fresh.inputs.get('s2').state.getSnapshot().draft, 'draft two')
  assert.equal(fresh.state.current, 's1')
  assert.equal(await [...fresh.attachments.values()][1].file.text(), '文档')
  assert.equal(fresh.sessions.get('s1').getSnapshot().newestMessage, 'arrived while minimal')
  await fresh.adapter.restore(snapshot, options())
  assert.equal(fresh.creations, 2, 'retry reuses already recreated attachments')
  assert.equal(fresh.inputs.get('s1').state.getSnapshot().attachmentIds.length, 2)
  const reloaded = fresh.window.__DSH_CREATE_UI_ADAPTER__(fresh.ctx)
  await reloaded.restore(snapshot, options())
  assert.equal(fresh.creations, 2, 'adapter reload matches complete file bytes')
  assert.equal(fresh.inputs.get('s1').state.getSnapshot().attachmentIds.length, 2)
})

test('a removed target stops restore before writing drafts into any session', async () => {
  const payload = await fixture().adapter.capture(options())
  const fresh = fixture({ text: 'untouched' }); delete fresh.state.byId.s2
  await assert.rejects(fresh.adapter.restore({ snapshotId: 2, payload }, options()), /snapshot-session-missing/)
  assert.equal(fresh.inputs.get('s1').state.getSnapshot().draft, 'untouched')
})

test('empty unmounted Lexical states use the public text setter instead of importing an empty root', async () => {
  const original = fixture({ text: '', second: '' })
  original.inputs.get('s2').editor.getEditorState = () => ({ toJSON: () => ({ root: { children: [] } }) })
  const payload = await original.adapter.capture(options())
  assert.equal(payload.drafts.find(d => d.sessionId === 's2').editor, null)
  const fresh = fixture({ text: '', second: '' })
  fresh.inputs.get('s2').editor.setEditorState = () => { throw Error('Lexical forbids an empty root') }
  await fresh.adapter.restore({ snapshotId: 4, payload }, options())
})

test('duplicate attachment IDs from a partial retry are reconciled; unexpected files are retained', async () => {
  const f = fixture()
  const [asset] = f.ctx.conversation.createDrafts('s1', [new File(['content'], 'f.txt')])
  f.inputs.get('s1').addAttachments([asset.id])
  const payload = await f.adapter.capture(options())
  f.inputs.get('s1').addAttachments([asset.id])
  await f.adapter.restore({ snapshotId: 5, payload }, options())
  assert.deepEqual(f.inputs.get('s1').state.getSnapshot().attachmentIds, [asset.id])
  const [extra] = f.ctx.conversation.createDrafts('s1', [new File(['unexpected'], 'keep.txt')])
  f.inputs.get('s1').addAttachments([extra.id])
  await assert.rejects(f.adapter.restore({ snapshotId: 5, payload }, options()), /snapshot-attachment-conflict/)
  assert.ok(f.inputs.get('s1').state.getSnapshot().attachmentIds.includes(extra.id))
})

test('unknown forms, active panels, pending uploads, and claimed commands block capture', async () => {
  let f = fixture(); f.fields.push({ value: 'unsaved', closest: () => null })
  await assert.rejects(f.adapter.capture(options()), /snapshot-form-unsupported/)
  f = fixture(); f.layout.layoutInfo.rightbarShown = true
  await assert.rejects(f.adapter.capture(options()), /snapshot-panel-unsupported/)
  f = fixture(); f.inputs.get('s1').state.getSnapshot().phase = 'claimed'
  await assert.rejects(f.adapter.capture(options()), /snapshot-input-busy/)
  f = fixture(); const [attachment] = f.ctx.conversation.createDrafts('s1', [new File(['x'], 'f.txt')]); f.inputs.get('s1').addAttachments([attachment.id]); f.uploads[attachment.id].status = 'uploading'
  await assert.rejects(f.adapter.capture(options()), /snapshot-upload-pending/)
})

test('compatible service contracts capture and restore independently of version labels', async () => {
  for (const frontendVersion of ['0.1.5-rc.2', '0.1.5-rc.3', '0.2.0-rc.2', 'future', null]) {
    const original = fixture(), opt = { ...options(), frontendVersion, remoteApply: true }
    const [asset] = original.ctx.conversation.createDrafts('s1', [new File(['cross-version attachment'], 'keep.txt', { type: 'text/plain' })])
    original.inputs.get('s1').addAttachments([asset.id])
    const payload = await original.adapter.capture(opt)
    const fresh = fixture({ text: '', second: '' })
    await fresh.adapter.restore({ snapshotId: 12, payload }, opt)
    assert.equal(fresh.inputs.get('s1').state.getSnapshot().draft, '草稿一')
    assert.equal(fresh.inputs.get('s2').state.getSnapshot().draft, 'draft two')
    assert.equal(await [...fresh.attachments.values()][0].file.text(), 'cross-version attachment')
    assert.equal(payload.frontendVersion, frontendVersion || 'unknown')
  }
})

function modernFixture(args) {
  const f = fixture(args), retained = new Map(), releases = []
  delete f.state.current
  f.state.byId.s1.retainedBy = { mainView: 1 }
  f.state.byId.s2.retainedBy = {}
  delete f.ctx.sessions.open
  delete f.ctx.sessions.clear
  f.ctx.sessions.scope = id => f.state.byId[id]?.retainedBy.mainView || retained.has(id) ? { id } : undefined
  f.ctx.uiWorkspace.openSession = id => {
    for (const row of Object.values(f.state.byId)) row.retainedBy = { mainView: row.id === id ? 1 : 0 }
  }
  f.ctx.sessions.retain = (id, { source }) => {
    assert.equal(source, 'desktopUiSnapshot')
    retained.set(id, true)
    return { ready: Promise.resolve(), release() { releases.push(id); retained.delete(id) } }
  }
  return Object.assign(f, { retained, releases })
}

test('mainView navigation restores inactive drafts and retains their attachment scopes across retries', async () => {
  const original = modernFixture()
  original.storage.set('dsh.conversation.s2', JSON.stringify({ draft: 'inactive modern draft', view: 'chat' }))
  const opt = { ...options(), frontendVersion: '0.2.0-rc.2', remoteApply: true }
  const [asset] = original.ctx.conversation.createDrafts('s1', [new File(['modern attachment'], 'keep.txt')])
  original.inputs.get('s1').addAttachments([asset.id])
  const payload = await original.adapter.capture(opt)
  assert.equal(payload.page.sessionId, 's1')
  assert.equal(payload.page.workspaceId, 'w1')
  assert.equal(payload.drafts.find(d => d.sessionId === 's2').text, 'inactive modern draft')
  const fresh = modernFixture({ text: '', second: '' })
  await fresh.adapter.restore({ snapshotId: 9, payload }, opt)
  await fresh.adapter.restore({ snapshotId: 9, payload }, opt)
  assert.equal(fresh.state.byId.s1.retainedBy.mainView, 1)
  assert.equal(fresh.inputs.get('s2').state.getSnapshot().draft, 'inactive modern draft')
  assert.equal(fresh.retained.size, 1)
  assert.equal(fresh.creations, 1)
  fresh.adapter.dispose()
  assert.deepEqual(fresh.releases, ['s1'])
  assert.equal(fresh.retained.size, 0)
})

test('missing service contracts stop capture before invoking providers or changing drafts', async () => {
  for (const breakContract of [
    f => { delete f.ctx.conversation.createDrafts },
    f => { delete f.ctx.sessions.scope },
    f => { f.state.ids = undefined },
    f => { f.ctx.workspaces.list.getSnapshot = () => ({ phase: 'ready' }) },
  ]) {
    const f = fixture(); breakContract(f)
    const opt = options(); opt.providers.set('title-bar', { capture() { assert.fail('must not capture providers') } })
    await assert.rejects(f.adapter.capture(opt), /snapshot-adapter-unsupported/)
    assert.equal(f.inputs.get('s1').state.getSnapshot().draft, '草稿一')
  }
})

test('changed layout and chat contracts fail with capability errors; modern empty navigation is refused', async () => {
  let f = fixture()
  delete f.ctx.slots.entriesOfSlot('root')[0].store.create().actions.setSidebar
  await assert.rejects(f.adapter.capture(options()), /snapshot-layout-unsupported/)
  f = fixture()
  const entries = f.ctx.slots.entriesOfSlot
  f.ctx.slots.entriesOfSlot = key => key === 'root' ? entries(key) : [{ options: { id: 'chat' }, inject: () => ({ chatScroll: { read: () => null } }) }]
  await assert.rejects(f.adapter.capture(options()), /snapshot-scroll-unsupported/)
  f = modernFixture()
  f.state.byId.s1.retainedBy = {}
  await assert.rejects(f.adapter.capture(options()), /snapshot-navigation-unsupported/)
  f.state.byId.s1.retainedBy = { mainView: 1 }
  f.ctx.sessions.subagentAddress = () => ({ parentId: 'parent', sessionId: 's1' })
  await assert.rejects(f.adapter.capture(options()), /snapshot-panel-unsupported/)
})

test('changed versions, schema and cancellation are checked before changing UI data', async () => {
  const f = fixture()
  const payload = await f.adapter.capture(options())
  const fresh = fixture({ text: 'untouched' })
  await assert.rejects(fresh.adapter.restore({ snapshotId: 1, payload }, { ...options(), frontendVersion: 'future' }), /snapshot-adapter-version/)
  await assert.rejects(fresh.adapter.restore({ snapshotId: 1, payload: { ...payload, schemaVersion: 2 } }, options()), /snapshot-schema-unsupported/)
  assert.equal(fresh.inputs.get('s1').state.getSnapshot().draft, 'untouched')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.adapter.capture({ ...options(), signal: controller.signal }), /abort/i)
})

test('history anchors load older rows and following-bottom uses the newest scroll height', async () => {
  const payload = await fixture().adapter.capture(options())
  payload.scrolls = [{ sessionId: 's1', anchor: 'old-message', offset: 15, scrollTop: 800, following: false }]
  const fresh = fixture()
  let loaded = false, loads = 0
  const scroller = { scrollTop: 0, scrollHeight: 9000, getBoundingClientRect: () => ({ top: 100 }), dispatchEvent() {},
    querySelectorAll: () => loaded ? [row] : [], querySelector: () => loaded ? row : null }
  const row = { getAttribute: () => 'old-message', getBoundingClientRect: () => ({ top: 915 - scroller.scrollTop }) }
  fresh.document.querySelector = () => scroller
  fresh.sessions.get('s1').loadOlder = async () => { loaded = true; loads++ }
  await fresh.adapter.restore({ snapshotId: 9, payload }, options())
  assert.equal(loads, 1)
  assert.equal(scroller.scrollTop, 800)
  payload.scrolls[0].following = true
  await fresh.adapter.restore({ snapshotId: 9, payload }, options())
  assert.equal(scroller.scrollTop, 9000, 'new messages determine the bottom; saved transcript is never replayed')
})

test('registered business dialogs restore display state and confirm their fields', async () => {
  const f = fixture(), original = { rename: { kind: 'session' }, value: '未提交标题' }
  const captureOptions = options(); captureOptions.providers.set('title-bar', { version: 1, capture: () => original })
  const payload = await f.adapter.capture(captureOptions)
  // serde_json::Value sorts object keys across the native IPC round trip.
  payload.dialogs[0].data = { value: '未提交标题', rename: { kind: 'session' } }
  let held = null, restored = 0
  const restoreOptions = options(); restoreOptions.providers.set('title-bar', { version: 1, capture: () => ({ rename: held.rename, value: held.value }), restore(value) { held = value; restored++ } })
  await f.adapter.restore({ snapshotId: 1, payload }, restoreOptions)
  assert.equal(restored, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(held)), original)
})

function bridge() {
  const env = environment(), calls = []
  env.window.__TAURI__ = { core: { invoke: async (command, args) => { calls.push({ command, args }); return {} } } }
  vm.runInContext(bridgeSource, env.context)
  const api = env.window.__DSH_UI_STATE__
  api.configure({ identity: identity(1), phase: 'active', frontendVersion: '0.1.5-rc.2' })
  const blocked = () => { let prevented = false; env.document.dispatchEvent({ type: 'beforeinput', preventDefault() { prevented = true }, stopImmediatePropagation() {} }); return prevented }
  return { ...env, api, calls, blocked }
}

test('remote apply on an incompatible runtime reports the missing capability and unfreezes input', async () => {
  const f = bridge()
  f.api.registerAdapter({ capture: async () => { throw new Error('snapshot-adapter-unsupported') } })
  await assert.rejects(f.api.prepareRemoteApply('future'), /缺少.*接口/)
  assert.equal(f.blocked(), false)
  assert.equal(f.calls.length, 0)
})

test('plugin restart accepts saved controls but still refuses unowned editable fields', async () => {
  const f = fixture()
  f.dialogs.push({ closest: () => null, querySelectorAll: selector => selector === '.dshPlugins' ? [{ closest: () => null }] : [] })
  await assert.rejects(f.adapter.capture(options()), /snapshot-form-unsupported/)
  const opt = { ...options(), remoteApply: true }
  assert.equal((await f.adapter.capture(opt)).drafts[0].text, '草稿一')
  f.fields.push({ closest: () => null, type: 'text', value: 'unsaved setting', checkVisibility: () => true })
  await assert.rejects(f.adapter.capture(opt), /snapshot-form-unsupported/)
})

test('restart ignores fading confirmations but still blocks a live confirmation behind a ghost', async () => {
  for (const section of ['.dshRemote', '.dshPlugins']) {
    const f = fixture(), opt = { ...options(), remoteApply: true }
    const live = { closest: () => null }
    const ghost = { closest: selector => selector === '[data-dsh-ghost]' ? {} : null }
    const confirmations = [ghost]
    f.dialogs.push({ closest: () => null, querySelectorAll: selector => selector === section ? [live] : selector.includes('[role=alertdialog]') ? confirmations : [] })
    assert.equal((await f.adapter.capture(opt)).drafts[0].text, '草稿一')
    confirmations.push(live)
    await assert.rejects(f.adapter.capture(opt), /snapshot-form-unsupported/)
    confirmations.pop()
    await assert.rejects(f.adapter.capture(options()), /snapshot-form-unsupported/)
  }
})

test('animation copies of dialogs and fields do not block snapshots; hidden live drafts still do', async () => {
  const f = fixture()
  const ghost = { closest: selector => selector === '[data-dsh-ghost]' ? {} : null }
  f.dialogs.push(ghost)
  f.fields.push({ ...ghost, type: 'text', value: 'closed form copy', checkVisibility: () => true })
  assert.equal((await f.adapter.capture(options())).drafts[0].text, '草稿一')
  f.fields.push({ closest: () => null, type: 'text', value: 'hidden unsaved draft', checkVisibility: () => false })
  await assert.rejects(f.adapter.capture(options()), /snapshot-form-unsupported/)
  assert.equal(f.fields[1].value, 'hidden unsaved draft')
})

test('fading remote content cannot exempt an unrelated live dialog', async () => {
  const f = fixture(), opt = { ...options(), remoteApply: true }
  const ghost = { closest: selector => selector === '[data-dsh-ghost]' ? {} : null }
  f.dialogs.push({ closest: () => null, querySelectorAll: selector => selector === '.dshRemote' ? [ghost] : [] })
  await assert.rejects(f.adapter.capture(opt), /snapshot-form-unsupported/)
})

test('explicit restart lazily protects drafts without enabling automatic UI capture', async () => {
  const f = bridge(), payload = { drafts: ['unsent'] }
  let created = 0, disposed = 0
  const off = f.api.registerRestartAdapter(() => {
    created++
    return { capture: async options => { assert.equal(options.remoteApply, true); return payload }, dispose() { disposed++ } }
  })
  assert.equal(created, 0)
  await f.api.capture(identity(2))
  assert.equal(f.calls[0].args.error, 'snapshot-adapter-missing')
  assert.equal(created, 0)
  f.api.configure({ identity: identity(3), phase: 'active' })
  assert.equal(await f.api.prepareRemoteApply('0.2.0-rc.2', '正在重启 DSH…'), payload)
  assert.equal(created, 1)
  assert.equal(f.blocked(), true)
  f.api.finishRemoteApply()
  assert.equal(f.blocked(), false)
  off()
  assert.equal(disposed, 1)
  await assert.rejects(f.api.prepareRemoteApply('0.2.0-rc.2'), /尚未准备好/)
})

test('capture stays frozen until native confirmation, and cancelled capture cannot submit late', async () => {
  const f = bridge(); let resolve
  f.api.registerAdapter({ capture: () => new Promise(r => { resolve = r }) })
  const capturing = f.api.capture(identity(2))
  await new Promise(setImmediate)
  assert.equal(f.blocked(), true)
  f.api.configure({ identity: identity(3), phase: 'active' })
  resolve({ drafts: ['old'] }); await capturing
  assert.equal(f.blocked(), false)
  assert.equal(f.calls.length, 0)
})

test('a structured snapshot acknowledgement is required; eval alone is not success', async () => {
  const f = bridge(), payload = { schemaVersion: 1 }
  f.api.registerAdapter({ capture: async () => payload })
  await f.api.capture(identity(2))
  assert.equal(f.calls[0].command, 'submit_ui_snapshot')
  assert.equal(f.calls[0].args.payload, payload)
  assert.equal(f.blocked(), true)
  f.api.configure({ identity: identity(3), phase: 'active' })
  assert.equal(f.blocked(), false)
})

test('subframes do not install the native bridge or adapter', () => {
  const env = environment(); env.window.top = {}
  vm.runInContext(bridgeSource, env.context); vm.runInContext(source, env.context)
  assert.equal(env.window.__DSH_UI_STATE__, undefined)
  assert.equal(env.window.__DSH_CREATE_UI_ADAPTER__, undefined)
})

test('boot capture needs no DSH plugin and refuses an open transient boot form', async () => {
  const f = bridge(); f.globals.location.hostname = 'tauri.localhost'
  const payload = { page: { kind: 'boot' } }
  await f.api.capture(identity(2), payload)
  assert.equal(f.calls[0].args.payload, payload)
  f.api.configure({ identity: identity(3), phase: 'active' })
  f.document.querySelector = () => ({ role: 'dialog' })
  await f.api.capture(identity(4), payload)
  assert.equal(f.calls[1].args.error, 'snapshot-form-unsupported')
  assert.equal(f.blocked(), false)
})

// ── Deep links ───────────────────────────────────────────────────────────────

test('a deep link opens the named session through the workspace service', async () => {
  const f = fixture()
  await f.adapter.openDeepLink('s2')
  assert.equal(f.state.current, 's2')
})

test('a deep link naming an unknown session fails with a coded error', async () => {
  const f = fixture()
  delete f.state.byId.ghost
  await assert.rejects(f.adapter.openDeepLink('ghost'), /deep-link-session-missing/)
  assert.equal(f.state.current, 's1', 'a failed open must not change the selection')
})

test('a pushed link queues until the adapter registers, then flushes once and reports', async () => {
  const f = bridge()
  const opened = []
  await f.api.openDeepLink({ sessionId: 'session-abc' })
  await f.api.openDeepLink({ sessionId: 'session-abc' })
  await new Promise(setImmediate)
  assert.deepEqual(opened, [])
  f.api.registerAdapter({ openDeepLink: async id => { opened.push(id) } })
  await new Promise(setImmediate)
  assert.deepEqual(opened, ['session-abc'], 'the queue dedupes and flushes on registration')
  assert.equal(f.calls[0].command, 'report_deep_link')
  assert.equal(f.calls[0].args.sessionId, 'session-abc')
  assert.equal(f.calls[0].args.outcome, 'opened')
  assert.equal(f.calls.length, 1, 'the queue held one copy, not two')
})

test('a missing session reports missing and says so; a not-ready page stays silent', async () => {
  const f = bridge()
  f.api.registerAdapter({
    openDeepLink: async id => { if (id === 'ghost') { const e = new Error('deep-link-session-missing'); throw e } },
  })
  await f.api.openDeepLink({ sessionId: 'ghost' })
  await new Promise(setImmediate)
  assert.equal(f.calls[0].args.outcome, 'missing')
  const overlay = f.document.body.children.at(-1)
  assert.match(overlay.children[0].textContent, /不存在/)

  const slow = bridge()
  slow.api.registerAdapter({ openDeepLink: async () => { throw new Error('deep-link-page-not-ready') } })
  await slow.api.openDeepLink({ sessionId: 'session-abc' })
  await new Promise(setImmediate)
  assert.equal(slow.calls.length, 0, 'a reload could fix this: the Rust queue must keep the link')
})

test('a malformed push and an adapter without the API leave nothing reported', async () => {
  const f = bridge()
  await f.api.openDeepLink(undefined)
  await f.api.openDeepLink({ sessionId: 42 })
  await f.api.openDeepLink({ sessionId: '' })
  f.api.registerAdapter({ capture: async () => ({}) })
  await f.api.openDeepLink({ sessionId: 'session-abc' })
  await new Promise(setImmediate)
  assert.equal(f.calls.filter(call => call.command === 'report_deep_link').length, 0)
})

test('unregistering an adapter drops the deep-link queue with the rest of its state', async () => {
  const f = bridge()
  await f.api.openDeepLink({ sessionId: 'session-abc' })
  const unregister = f.api.registerAdapter({ openDeepLink: async () => {} })
  unregister()
  const opened = []
  f.api.registerAdapter({ openDeepLink: async id => { opened.push(id) } })
  await new Promise(setImmediate)
  assert.deepEqual(opened, [], 'a dead adapter must not leak its queue into the next one')
})
