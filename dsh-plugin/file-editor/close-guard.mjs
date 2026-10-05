import { t } from '../i18n/api.mjs'
/** Bridge DSH's synchronous removal boundary to its asynchronous application modal.
 * Keep the original commit: replacements must open their requested resource,
 * and a delayed answer must never act on a different tab or session.
 * DSH 0.2 exposes this boundary on the controller; do not patch its package files.
 */
export function createCloseGuard(side, docs) {
  const original = side.removeAfterCleanup
  if (typeof original !== 'function') throw Error(t('当前 DSH 版本不支持文件关闭确认'))
  const descriptor = Object.getOwnPropertyDescriptor(side, 'removeAfterCleanup')
  const listeners = new Set()
  let state = { request: null, busy: false, error: '' }, release = () => {}
  const publish = patch => { state = { ...state, ...patch }; for (const fn of listeners) fn() }
  const clear = () => { release(); release = () => {}; publish({ request: null, busy: false, error: '' }) }
  const prune = (tab, doc) => {
    if (!side.openTabs.getSnapshot().some(value => value.contentId === tab.contentId)
      && docs.documents.get(tab.contentId) === doc) docs.documents.delete(tab.contentId)
  }
  function intercept(sessionId, tab, commit) {
    const doc = tab.kind === 'text' && docs.documents.get(tab.contentId)
    const shared = side.openTabs.getSnapshot().filter(value => value.contentId === tab.contentId).length > 1
    if (!doc || shared || (!doc.dirty() && !doc.getSnapshot().saving)) {
      const result = original.call(side, sessionId, tab, commit)
      if (doc) prune(tab, doc)
      return result
    }
    return ask(sessionId, tab, doc, commit, 'close')
  }
  function ask(sessionId, tab, doc, commit, kind) {
    // Repeated close/reload commands retain the first intent and a single dialog.
    if (state.request) return
    const occurrence = side.tabDomain.occurrence(sessionId, tab)
    const navigation = occurrence.navigation.getSnapshot(), mounted = side.mounted.getSnapshot()
    const request = { doc, sessionId, tab, commit, kind, valid: () =>
      !occurrence.signal.aborted && occurrence.navigation.getSnapshot() === navigation
      && side.mounted.getSnapshot() === mounted
      && side.tabsIn(sessionId).some(value => value.id === tab.id && value.contentId === tab.contentId) }
    const check = () => { if (state.request === request && !request.valid()) clear() }
    const off = [occurrence.navigation.subscribe(check), side.openTabs.subscribe(check), side.mounted.subscribe(check)]
    occurrence.signal.addEventListener('abort', check)
    release = () => { off.forEach(fn => fn()); occurrence.signal.removeEventListener('abort', check) }
    publish({ request, busy: false, error: '' })
  }
  async function finish(request) {
    if (state.request !== request) return
    if (!request.valid()) { clear(); return }
    try {
      if (request.kind === 'reload') {
        publish({ busy: true, error: '' })
        await request.doc.load(true)
        if (state.request !== request) return
        if (!request.valid()) { clear(); return }
        if (request.doc.getSnapshot().error) throw Error(request.doc.getSnapshot().error)
        request.commit()
      } else {
        original.call(side, request.sessionId, request.tab, request.commit)
        prune(request.tab, request.doc)
      }
      if (state.request === request) clear()
    } catch (error) {
      if (state.request === request) publish({ busy: false, error: error.message || t('操作失败，请重试') })
    }
  }
  side.removeAfterCleanup = intercept
  return {
    getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    cancel: clear,
    reload(sessionId, tab, doc, commit = () => {}) {
      if (state.request || doc.getSnapshot().loading) return
      if (doc.dirty() || doc.getSnapshot().saving) return ask(sessionId, tab, doc, commit, 'reload')
      return doc.load(true).then(() => { if (!doc.getSnapshot().error && !tab.signal?.aborted) commit() })
    },
    discard() {
      const request = state.request
      if (request && !state.busy && !request.doc.getSnapshot().saving) return finish(request)
    },
    async save() {
      const request = state.request
      if (!request || state.busy || request.doc.getSnapshot().saving) return
      if (!request.valid()) { clear(); return }
      publish({ busy: true, error: '' })
      try {
        const saved = !request.doc.dirty() || await request.doc.save()
        if (state.request !== request) return
        if (saved && !request.doc.dirty() && !request.doc.getSnapshot().saving) await finish(request)
        else publish({ busy: false, error: request.doc.getSnapshot().error || t('文件仍有未保存的修改，请再次保存后继续。') })
      } catch (error) {
        if (state.request === request) publish({ busy: false, error: error.message || t('保存失败，请重试') })
      }
    },
    dispose() {
      clear(); listeners.clear()
      if (side.removeAfterCleanup !== intercept) return
      if (descriptor) Object.defineProperty(side, 'removeAfterCleanup', descriptor)
      else delete side.removeAfterCleanup
    },
  }
}
