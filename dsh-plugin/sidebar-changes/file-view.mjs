import { t, useLocale } from '../i18n/api.mjs'
import { LABELS, BASES } from './shared/change-model.mjs'
import { parseChangeAddress, absoluteFilePath, fileAddress } from './file-resource.mjs'

export function createFileView(React, primitives, { call, message, Placeholder, Details, stats }) {
  const h = React.createElement, { Button, FileTypeIcon, PathLabel, Tag } = primitives
  return function FileView({ ctx, tab, sessionId: ownerSessionId, states }) {
    useLocale(React)
    const file = React.useMemo(() => parseChangeAddress(tab.contentId), [tab.contentId])
    const stateKey = ownerSessionId + '\0' + tab.contentId, viewport = React.useRef(null)
    const [data, setData] = React.useState(null), [error, setError] = React.useState(null), [loading, setLoading] = React.useState(true)
    const [refresh, setRefresh] = React.useState(0)
    const reload = React.useCallback(() => setRefresh(value => value + 1), [])
    React.useEffect(() => tab.actions.bindCommands({ refresh: reload }), [tab.actions, reload])
    React.useEffect(() => {
      document.addEventListener('dsh-desktop:changes-restore', reload)
      return () => document.removeEventListener('dsh-desktop:changes-restore', reload)
    }, [reload])
    React.useEffect(() => {
      if (!file || !tab.visible) return
      const own = new AbortController(), signal = AbortSignal.any([own.signal, tab.signal])
      setLoading(true); setError(null); setData(null)
      call(ctx, 'listChanges', file.sessionId, file.source, signal).then(value => {
        if (signal.aborted) return
        if (value.sessionId !== file.sessionId || value.source !== file.source) throw Error(t('无法识别此文件的更改链接。'))
        const entries = [...value.entries, ...(value.restoredEntries || [])]
        const aliases = entries.filter(entry => entry.aliases?.includes(file.fileId))
        const entry = entries.find(entry => entry.fileId === file.fileId)
          || (aliases.length === 1 ? aliases[0] : undefined)
        setData({ ...value, entry })
      }).catch(error => { if (!signal.aborted) setError(message(error)) })
        .finally(() => { if (!signal.aborted) setLoading(false) })
      return () => own.abort()
    }, [file, refresh, tab.visible, tab.signal])
    const restoreScroll = () => { if (viewport.current) viewport.current.scrollTop = states.get(stateKey)?.listScroll || 0 }
    if (!file) return h(Placeholder, { error: true }, t('无法识别此文件的更改链接。'))
    const entry = data?.entry, path = entry && absoluteFilePath(entry, data.workspaceRoot)
    return h('section', { className: 'dshChanges dshChangeFile', 'data-dsh-changes': true, 'data-dsh-change-file': file.fileId, 'data-source': file.source, 'aria-label': t('查看更改') },
      h('header', { className: 'dshChanges__toolbar dshChangeFile__toolbar' },
        h('div', { className: 'dshChangeFile__path', title: entry?.path || file.path },
          h(FileTypeIcon, { path: entry?.path || file.path, size: 16 }), h(PathLabel, { path: entry?.path || file.path })),
        h('div', { className: 'dshChanges__toolbarActions' },
          h(Button, { size: 'sm', disabled: !path || entry.status === 'deleted', onClick: () => tab.actions.openResource(fileAddress(file.sessionId, path)) }, t('打开文件')),
          h(Button, { size: 'sm', disabled: loading, onClick: reload }, t('刷新')))),
      h('div', { className: 'dshChanges__metadata dshChangeFile__summary' }, h(Tag, null, LABELS[file.source]),
        h('span', null, BASES[file.source].join(' → ')), entry && stats(entry.stats)),
      h('div', { ref: viewport, className: 'dshChangeFile__content', onScroll: event => {
        if (tab.visible && !loading) states.set(stateKey, { source: file.source, listScroll: event.currentTarget.scrollTop })
      } },
        error ? h(Placeholder, { error: true, retry: reload, busy: loading }, error)
          : loading ? h(Placeholder, null, t('正在加载差异…'))
            : entry ? h(Details, { key: entry.fileId + data.revision + refresh, ctx, sessionId: file.sessionId, source: file.source, entry,
              revision: data.revision, signal: tab.signal, onReady: restoreScroll, reload, retryBusy: loading })
              : h(Placeholder, { retry: reload }, t('该文件已不在此更改范围中。'))))
  }
}
