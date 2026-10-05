import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { t } from './i18n/api.mjs'

const source = readFileSync(new URL('./title-bar/client.js', import.meta.url), 'utf8')
const binding = source.slice(source.indexOf('    function bindSessionExport('), source.indexOf('    function apply(ctx)'))
class CustomEvent extends Event {
  constructor(type, { detail }) { super(type); this.detail = detail }
}
function fixture({ mode = 'desktop', native = true, pick = async () => 'export-1' } = {}) {
  const window = new EventTarget(), document = new EventTarget()
  const picks = [], fetches = []
  if (native) window.__TAURI__ = { core: { invoke: async (command, args) => {
    picks.push({ command, args }); return pick()
  } } }
  document.documentElement = { getAttribute: () => mode }
  const timers = new Set(), entries = {}, reports = [], saves = []
  let dispose = () => {}, injections = 0
  document.addEventListener('report', event => reports.push(event.detail.message))
  const original = () => {}
  const controller = {
    run: original, fetcher: async (...args) => { fetches.push(args); return { ok: true } },
    publish: (id, entry) => { entries[id] = entry },
    store: { getSnapshot: () => ({ bySession: entries }) },
    save: (route, filename) => saves.push({ route, filename }),
  }
  const ctx = { inject(names, install) {
    injections++
    install({ sessionLogDownload: controller, effect: effect => { dispose = effect() } })
  } }
  vm.runInNewContext(binding + '\nbindSessionExport(ctx)', {
    t, ctx, window, document, CustomEvent, URLSearchParams, Error, REPORT_EVENT: 'report',
    setTimeout: callback => { timers.add(callback); return callback },
    clearTimeout: callback => timers.delete(callback),
  })
  const result = (status, extra = {}) => window.dispatchEvent(new CustomEvent('dsh-desktop:session-export', {
    detail: { sessionId: 's1', requestId: new URLSearchParams(saves.at(-1)?.route.split('?')[1]).get('desktopExportId'), status, ...extra },
  }))
  return { controller, entries, reports, saves, picks, fetches, result, timers, original, get injections() { return injections },
    dispose: () => dispose(), setMode: value => { mode = value } }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('desktop waits for disk completion, suppresses the modal and reports the saved path', async () => {
  const f = fixture(), done = f.controller.run('s1', new AbortController().signal)
  await tick()
  assert.equal(f.entries.s1.status, 'downloading')
  assert.equal(f.entries.s1.open, false)
  assert.deepEqual(f.picks.map(pick => pick.command), ['prepare_session_export'])
  assert.equal(f.picks[0].args.sessionId, 's1')
  assert.match(f.saves[0].route, /includeDescendants=true/)
  assert.match(f.saves[0].route, /desktopExportId=export-1/)
  f.result('success', { requestId: 'stale', path: 'wrong.zip' })
  assert.equal(f.entries.s1.status, 'downloading')
  f.result('started')
  assert.equal(f.timers.size, 0, 'a running download must not time out while streaming')
  assert.equal(f.reports.length, 0)
  f.result('success', { path: 'D:/Chosen folder/日志/session.zip' })
  await done
  assert.equal(f.entries.s1.status, 'success')
  assert.equal(f.entries.s1.open, false)
  assert.match(f.reports[0], /D:\/Chosen folder\/日志\/session.zip/)
})

test('native picker can stay open without a download or startup timeout', async () => {
  let choose
  const f = fixture({ pick: () => new Promise(resolve => { choose = resolve }) })
  const done = f.controller.run('s1', new AbortController().signal)
  await tick()
  assert.equal(f.fetches.length, 0)
  assert.equal(f.saves.length, 0)
  assert.equal(f.timers.size, 0)
  choose('chosen-request'); await tick()
  assert.equal(f.saves.length, 1)
  f.result('success', { path: 'chosen.zip' }); await done
})

test('cancelling the native picker is quiet and allows another export', async () => {
  for (const mode of ['desktop', 'vanilla']) {
    let cancelled = true
    const f = fixture({ mode, pick: async () => cancelled ? null : 'retry-request' })
    await f.controller.run('s1', new AbortController().signal)
    assert.equal(f.entries.s1.status, 'idle')
    assert.equal(f.entries.s1.open, false)
    assert.equal(f.fetches.length, 0)
    assert.equal(f.saves.length, 0)
    assert.equal(f.reports.length, 0)
    cancelled = false
    const done = f.controller.run('s1', new AbortController().signal)
    await tick(); f.result('success', { path: 'retry.zip' }); await done
    assert.equal(f.entries.s1.status, 'success')
  }
})

test('picker failure is reported and aborting during selection never starts a download', async () => {
  const failed = fixture({ pick: async () => { throw Error('folder unavailable') } })
  await failed.controller.run('s1', new AbortController().signal)
  assert.equal(failed.entries.s1.status, 'error')
  assert.equal(failed.reports[0], 'folder unavailable')
  assert.equal(failed.saves.length, 0)
  for (const dispose of [false, true]) {
    let choose
    const f = fixture({ pick: () => new Promise(resolve => { choose = resolve }) })
    const abort = new AbortController(), done = f.controller.run('s1', abort.signal)
    await tick(); dispose ? f.dispose() : abort.abort()
    choose('unused-request'); await done
    assert.equal(f.fetches.length, 0)
    assert.equal(f.saves.length, 0)
    assert.equal(f.reports.length, 0)
  }
})

test('vanilla keeps its dialog and honours dismissal while the file is downloading', async () => {
  for (const dismiss of [false, true]) {
    const f = fixture({ mode: 'vanilla' })
    const done = f.controller.run('s1', new AbortController().signal)
    await tick()
    assert.equal(f.entries.s1.open, true)
    if (dismiss) f.entries.s1.open = false
    f.result('success', { path: 'saved.zip' }); await done
    assert.equal(f.entries.s1.open, !dismiss)
    assert.equal(f.entries.s1.status, 'success')
    assert.equal(f.reports.length, 0)
  }
})

test('HTTP and native download failures cannot be reported as success', async () => {
  const f = fixture()
  f.controller.fetcher = async () => ({ ok: false, status: 404 })
  await f.controller.run('s1', new AbortController().signal)
  assert.equal(f.saves.length, 0)
  assert.equal(f.entries.s1.status, 'error')
  assert.match(f.reports[0], /404/)
  f.controller.fetcher = async () => ({ ok: true })
  const done = f.controller.run('s1', new AbortController().signal)
  await tick(); f.result('error', { error: 'disk full' }); await done
  assert.equal(f.entries.s1.status, 'error')
  assert.equal(f.reports.at(-1), 'disk full')
})

test('missing native start is actionable and a late completion is ignored', async () => {
  const f = fixture(), done = f.controller.run('s1', new AbortController().signal)
  await tick(); [...f.timers][0](); await done
  f.result('success', { path: 'late.zip' })
  assert.equal(f.entries.s1.status, 'error')
  assert.match(f.reports[0], /未能启动/)
})

test('abort and plugin disposal remove listeners and do not display errors', async () => {
  for (const dispose of [false, true]) {
    const f = fixture(), abort = new AbortController()
    const done = f.controller.run('s1', abort.signal)
    await tick(); dispose ? f.dispose() : abort.abort(); await done
    f.result('success', { path: 'late.zip' })
    assert.equal(f.timers.size, 0)
    assert.equal(f.reports.length, 0)
    if (dispose) assert.equal(f.controller.run, f.original)
  }
})

test('ordinary browsers keep the upstream download controller', () => {
  const f = fixture({ native: false })
  assert.equal(f.injections, 0)
  assert.equal(f.controller.run, f.original)
})
