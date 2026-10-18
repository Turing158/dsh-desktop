import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { t } from './i18n/api.mjs'

// Run the bundle's actual state readers against both supported Controller APIs.
const source = readFileSync(new URL('./title-bar/client.js', import.meta.url), 'utf8')
const settingsStart = source.indexOf('    function openSettings(')
const settingsSource = source.slice(settingsStart, source.indexOf('    /**', settingsStart))
const settingsOpener = document => vm.runInNewContext(settingsSource + '\nopenSettings', { document })

test('settings opens the current shell store without an account-menu click', () => {
  let calls = 0
  const state = { actions: { open() { assert.equal(this, state.actions); calls++ } } }
  let entry = { store: { create: () => state } }
  const ctx = { slots: { entriesOfSlot: name => { assert.equal(name, 'sidebar.settings'); return [entry] } } }
  const open = settingsOpener({ querySelector() { throw Error('native settings store must take precedence') } })
  assert.equal(open(ctx), true)
  entry = { store: { create: () => ({ actions: { open: () => { calls += 10 } } }) } }
  assert.equal(open(ctx), true)
  assert.equal(calls, 11, 'an HMR replacement is resolved on the next click')
})

test('settings retains the legacy trigger and handles a missing shell', () => {
  let calls = 0
  const ctx = { slots: { entriesOfSlot: () => [] } }
  const open = settingsOpener({ querySelector(selector) {
    assert.equal(selector, 'button[aria-haspopup="dialog"]')
    return { click: () => calls++ }
  } })
  assert.equal(open(ctx), true)
  assert.equal(calls, 1)
  assert.equal(settingsOpener({ querySelector: () => null })(ctx), false)
})

const readers = source.slice(source.indexOf('    function currentWorkspace('), source.indexOf('    function hasSelection('))
const { currentSession, currentWorkspace } = vm.runInNewContext(readers + '\n({currentSession, currentWorkspace})')
const context = (list) => ({
  sessions: { list: { getSnapshot: () => list } },
  workspaces: { list: { getSnapshot: () => ({ items: [
    { workspaceId: 'recent', sessionIds: ['other'] },
    { workspaceId: 'selected', sessionIds: ['active'] },
  ] }) } },
})

test('DSH 0.2 mainView retention enables the selected session and its own workspace', () => {
  const list = { byId: {
    other: { retainedBy: { background: 1 }, title: '后台会话' },
    active: { retainedBy: { mainView: 1 }, displayTitle: '当前会话' },
  } }
  const ctx = context(list)
  assert.equal(currentSession(ctx).id, 'active')
  assert.equal(currentSession(ctx).title, '当前会话')
  assert.equal(currentWorkspace(ctx).workspaceId, 'selected')
  list.byId.active.retainedBy.mainView = 0
  list.byId.other.retainedBy.mainView = 1
  assert.equal(currentSession(ctx).id, 'other', 'switching selection never reuses the previous session')
  assert.equal(currentWorkspace(ctx).workspaceId, 'recent')
})

test('DSH 0.1 current selection remains supported', () => {
  const ctx = context({ current: 'active', byId: { active: { title: '旧版会话' } } })
  assert.equal(currentSession(ctx).id, 'active')
  assert.equal(currentSession(ctx).title, '旧版会话')
  assert.equal(currentWorkspace(ctx).workspaceId, 'selected')
})

test('background retention and missing summaries cannot enable session actions', () => {
  assert.equal(currentSession(context({ byId: { active: { retainedBy: { background: 1 } } } })), undefined)
  assert.equal(currentSession(context({ current: 'gone', byId: {} })), undefined)
  assert.equal(currentSession(context({ byId: {} })), undefined)
  assert.equal(currentSession({}), undefined)
})

const headerTargetSource = source.slice(source.indexOf('    function headerRenameTarget('), source.indexOf('    // Keep the upstream header'))
const headerRenameTarget = vm.runInNewContext(headerTargetSource + '\nheaderRenameTarget')

test('header rename reads the displayed session title and allows root forks', () => {
  const list = { byId: { active: { title: 'Stored', displayTitle: 'Displayed', origin: 'fork', parentId: 'parent' } } }
  const ctx = context(list)
  ctx.sessions.binding = () => ({ session: { getSnapshot: () => ({ subagent: null }) } })
  assert.equal(headerRenameTarget(ctx, 'active').title, 'Displayed')
  list.byId.active.displayTitle = 'Renamed'
  assert.equal(headerRenameTarget(ctx, 'active').title, 'Renamed')
  assert.equal(headerRenameTarget(ctx, 'missing'), undefined)
})

test('header rename refuses subagent views across summary, address and session contracts', () => {
  for (const block of [
    (ctx, list) => { list.byId.active.origin = 'subagent' },
    (ctx, list) => { list.currentAddress = { parentId: 'parent', sessionId: 'child' } },
    ctx => { ctx.sessions.subagentAddress = () => ({ parentId: 'parent', sessionId: 'active' }) },
    ctx => { ctx.sessions.binding = () => ({ session: { getSnapshot: () => ({ subagent: { address: {} } }) } }) },
  ]) {
    const list = { byId: { active: { displayTitle: 'Child' } } }, ctx = context(list)
    ctx.sessions.binding = () => ({ session: { getSnapshot: () => ({ subagent: null }) } })
    block(ctx, list)
    assert.equal(headerRenameTarget(ctx, 'active'), undefined)
  }
})

test('copying a deep link omits the internal prefix and follows the selected session', async () => {
  const list = { current: undefined, byId: {} }, ctx = context(list), copied = []
  const copySource = source.slice(source.indexOf('      function copyDeepLink()'), source.indexOf('      /** Start a new session'))
  const copy = vm.runInNewContext(copySource + '\ncopyDeepLink', {
    ctx, currentSession, t, document: { dispatchEvent() {} }, CustomEvent: class {}, REPORT_EVENT: 'report',
    invokeHost: async (command, args) => { assert.equal(command, 'clipboard_write_text'); copied.push(args.text) },
    reportFailure: (_ctx, _action, error) => { throw error },
  })
  for (const [id, link] of [
    ['session-b4899765-8e01-4e03-9221-0f4520dccc78', 'deepseekharness://session/b4899765-8e01-4e03-9221-0f4520dccc78'],
    ['session-user-session-123', 'deepseekharness://session/user-session-123'],
  ]) {
    list.current = id; list.byId[id] = { title: 'Selected session' }
    copy(); await new Promise(setImmediate)
    assert.equal(copied.at(-1), link)
    assert.equal(currentSession(ctx).id, id, 'copying leaves the internal id intact')
  }
  list.current = undefined
  copy()
  assert.equal(copied.length, 2, 'no link is copied without a selected session')
})

const contentSource = source.slice(source.indexOf('    async function sessionContent('), source.indexOf('    function hasSelection('))
const sessionContent = vm.runInNewContext(contentSource + '\n sessionContent', { t })
const messageEntry = (type, content, surfaceOp = 'append') => ({ type: 'event', event: {
  type, surfaceOp, data: type === 'user/message' ? { content } : { message: { content } },
} })

test('copy includes older conversation text, preserves Markdown and omits context rewrites', async () => {
  let loaded = false
  const entries = [
    messageEntry('user/message', [{ type: 'text', text: 'older question' }, { type: 'file', attachment: { name: 'report.txt' } }]),
    messageEntry('assistant/message', [{ type: 'reasoning', text: 'internal reasoning' }, { type: 'text', text: '**Answer**\n```js\n1 + 1\n```' }]),
    messageEntry('assistant/message', [{ type: 'text', text: 'compacted context' }], 'replace'),
  ]
  const result = await sessionContent({
    session: { async loadThrough(seq) { assert.equal(seq, 0); loaded = true }, getSnapshot: () => ({ pendingSubmissions: [] }) },
    eventSource: { getSnapshot() { assert.ok(loaded); return { entries, hasMore: false } } },
  })
  assert.equal(result, '## 用户\n\nolder question\n[文件：report.txt]\n\n## 助手\n\n**Answer**\n```js\n1 + 1\n```')
})

test('copy rejects incomplete history instead of claiming a complete transcript', async () => {
  await assert.rejects(sessionContent({
    session: { async loadThrough() {} },
    eventSource: { getSnapshot: () => ({ entries: [], hasMore: true }) },
  }), /完整会话历史/)
})

test('streaming text is joined once and queued prompts are not copied as sent messages', async () => {
  const entries = ['hello', ' world'].map(text => ({ event: {
    type: 'assistant/live-chunk', data: { attemptId: 'a', chunk: { type: 'text-delta', text } },
  } }))
  const result = await sessionContent({
    session: { async loadThrough() {}, getSnapshot: () => ({ pendingSubmissions: [
      { placement: 'queued', text: 'not sent' }, { placement: 'transcript', text: 'visible submission' },
    ] }) },
    eventSource: { getSnapshot: () => ({ entries, hasMore: false }) },
  })
  assert.equal(result, '## 助手\n\nhello world\n\n## 用户\n\nvisible submission')
})

const actionsSource = source.slice(source.indexOf('    async function copySessionContent('), source.indexOf('    function bindSessionExport('))
function sessionActionsFixture({ failHistory = false, failCopy = false } = {}) {
  const window = {}, copies = [], saves = [], failures = [], retained = [], released = []
  const ctx = context({ current: 'active', byId: { active: { title: 'current conversation' } } })
  let ready = false, dispose
  const binding = {
    session: {
      async loadThrough() { assert.ok(ready); if (failHistory) throw Error('history unavailable') },
      getSnapshot: () => ({ pendingSubmissions: [] }),
    },
    eventSource: { getSnapshot: () => ({ entries: [messageEntry('user/message', 'background transcript')], hasMore: false }) },
  }
  ctx.sessions.retain = (id, options) => {
    retained.push({ id, source: options.source })
    return { ready: Promise.resolve().then(() => { ready = true }), binding, release: () => released.push(id) }
  }
  ctx.sessions.binding = () => { throw Error('must use the retained target, not the current session') }
  ctx.get = name => { assert.equal(name, 'sessionLogDownload'); return { download: async id => saves.push(id) } }
  ctx.effect = effect => { dispose = effect() }
  vm.runInNewContext(contentSource + actionsSource + '\nbindSessionActions(ctx)', { t,
    ctx, window, document: { dispatchEvent() {} }, CustomEvent: class {}, REPORT_EVENT: 'report',
    invokeHost: async (command, args) => { assert.equal(command, 'clipboard_write_text'); if (failCopy) throw Error('clipboard unavailable'); copies.push(args.text) },
    reportFailure: (_ctx, action, error) => failures.push({ action, message: error.message }),
  })
  return { ctx, window, copies, saves, failures, retained, released, dispose: () => dispose() }
}

test('sidebar content actions use a background session without selecting it and release its history', async () => {
  const f = sessionActionsFixture()
  await f.window.__DSH_SESSION_ACTIONS__.copyContent('background')
  await f.window.__DSH_SESSION_ACTIONS__.saveContent('background')
  assert.deepEqual(f.copies, ['## 用户\n\nbackground transcript'])
  assert.deepEqual(f.saves, ['background'])
  assert.deepEqual(f.retained, [{ id: 'background', source: 'desktopSessionCopy' }])
  assert.deepEqual(f.released, ['background'])
  assert.equal(currentSession(f.ctx).id, 'active')
  assert.deepEqual(f.failures, [])
  f.dispose()
  assert.equal(f.window.__DSH_SESSION_ACTIONS__, undefined)
})

test('failed history or clipboard writes release the background session and report the failure', async () => {
  for (const options of [{ failHistory: true }, { failCopy: true }]) {
    const f = sessionActionsFixture(options)
    await f.window.__DSH_SESSION_ACTIONS__.copyContent('background')
    assert.deepEqual(f.copies, [])
    assert.deepEqual(f.released, ['background'])
    assert.equal(f.failures[0].action, '复制会话内容')
    assert.equal(currentSession(f.ctx).id, 'active')
  }
})
