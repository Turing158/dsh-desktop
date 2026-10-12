import { t } from '../i18n/api.mjs'
import { parseFile } from './protocol.mjs'

/** Documents outlive React seats; two occurrences of one address share a draft. */
export function createDocuments(remote) {
  const documents = new Map()
  function get(address) {
    if (documents.has(address)) return documents.get(address)
    const file = parseFile(address)
    if (!file) throw Error(t('无法识别文件地址'))
    let state = { text: '', base: '', version: null, loading: false, saving: false, error: '', conflict: false, eol: '\n', bom: false }
    const listeners = new Set()
    const patch = value => { state = { ...state, ...value }; for (const fn of listeners) fn() }
    const value = result => { if (!result.ok) throw result.error; return result.value }
    let pendingRead, pendingSave, generation = 0
    const doc = {
      file, address,
      getSnapshot: () => state,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      dirty: () => state.version !== null && state.text !== state.base,
      edit(text) { generation++; patch({ text, error: state.conflict ? state.error : '' }) },
      async load(force = false) {
        if (pendingRead) return pendingRead
        if (state.saving || (!force && state.version !== null)) return
        const requestGeneration = generation
        patch({ loading: true, error: '' })
        pendingRead = (async () => {
          try {
            const loaded = value(await remote.read(file.sessionId, file.path, new AbortController().signal))
            if (requestGeneration === generation) patch({ ...loaded, base: loaded.text, error: '', conflict: false })
          } catch (error) { if (requestGeneration === generation) patch({ error: error.message || t('读取失败，请重试') }) }
          finally { pendingRead = null; patch({ loading: false }) }
        })()
        return pendingRead
      },
      async save() {
        if (pendingSave) return pendingSave
        if (!doc.dirty() || state.loading || state.conflict) return false
        const text = state.text, version = state.version
        patch({ saving: true, error: '' })
        pendingSave = (async () => {
          try {
            const saved = value(await remote.save(file.sessionId, file.path, version, text, new AbortController().signal))
            // A keystroke typed during the request remains unsaved after it completes.
            patch({ base: saved.text, version: saved.version, eol: saved.eol, bom: saved.bom })
            return true
          } catch (error) {
            patch({ error: error.message || t('保存失败，请重试'), conflict: String(error.code).includes('FS_STALE_VERSION') })
            return false
          } finally { pendingSave = null; patch({ saving: false }) }
        })()
        return pendingSave
      },
      restore(saved) { generation++; patch({ ...saved, loading: false, saving: false }) },
    }
    documents.set(address, doc)
    return doc
  }
  return {
    get, documents,
    unsettled: () => [...documents.values()].some(doc => doc.dirty() || doc.getSnapshot().saving),
    capture() {
      if ([...documents.values()].some(doc => doc.getSnapshot().saving || doc.getSnapshot().loading)) throw Error(t('文件正在读写，请完成后再重启'))
      const drafts = [...documents.values()].filter(doc => doc.dirty()).map(doc => ({ address: doc.address, state: doc.getSnapshot() }))
      return drafts.length ? { drafts } : null
    },
    restore(saved) { for (const draft of saved.drafts) get(draft.address).restore(draft.state) },
  }
}
