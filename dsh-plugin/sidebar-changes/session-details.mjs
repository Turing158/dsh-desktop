import { t, useLocale } from '../i18n/api.mjs'
/** All recorded operations and segment rows are reachable through versioned pages. */
export function createSessionDetails(React, { Button, Tag }, { call, message, Placeholder, DiffRows, stats }) {
  const h = React.createElement
  function RecordDiff({ ctx, sessionId, fileId, revision, record, signal }) {
    const [data, setData] = React.useState(null), [error, setError] = React.useState(null), [pending, setPending] = React.useState(false)
    const active = React.useRef(), inFlight = React.useRef(false)
    async function load(offset = 0) {
      const current = active.current
      if (!current || current.aborted || inFlight.current) return
      inFlight.current = true; setPending(true); setError(null)
      try {
        const value = await call(ctx, 'getOperationDiff', sessionId, fileId, revision, record.id, offset, current)
        if (!current.aborted) setData(old => ({ ...value, rows: offset ? [...old.rows, ...value.rows] : value.rows }))
      } catch (error) { if (!current.aborted) setError(message(error)) }
      finally { if (!current.aborted) { inFlight.current = false; setPending(false) } }
    }
    React.useEffect(() => {
      const own = new AbortController(); active.current = AbortSignal.any([own.signal, signal]); inFlight.current = false; load()
      return () => own.abort()
    }, [])
    return h('div', { className: 'dshChanges__recordDiff' },
      error && h(Placeholder, { error: true, retry: () => load(data?.nextOffset || 0), busy: pending }, error),
      !data && !error && h('div', { role: 'status' }, t('正在加载差异…')),
      data?.reason && h(Placeholder, null, message({ message: data.reason })),
      data && h(DiffRows, { rows: data.rows }),
      data && (data.beforeNewline === false || data.afterNewline === false) && h(Tag, { tone: 'quiet' }, t('文件末尾无换行')),
      data && !data.rows.length && !data.reason && h('div', null, t('无文本行变化')),
      data?.nextOffset != null && h(Button, { size: 'sm', className: 'dshChanges__recordMore', disabled: pending,
        onClick: () => load(data.nextOffset) }, pending ? t('正在加载…') : t('加载更多片段行')))
  }
  function Records({ ctx, sessionId, fileId, revision, recordKind, signal }) {
      useLocale(React)
    const [data, setData] = React.useState(null), [error, setError] = React.useState(null), [pending, setPending] = React.useState(false)
    const [opened, setOpened] = React.useState([]), active = React.useRef(), inFlight = React.useRef(false)
    async function load(offset = 0) {
      const current = active.current
      if (!current || current.aborted || inFlight.current) return
      inFlight.current = true; setPending(true); setError(null)
      try {
        const value = await call(ctx, 'listFileOperations', sessionId, fileId, revision, recordKind, offset, current)
        if (!current.aborted) setData(old => ({ ...value, records: offset ? [...old.records, ...value.records] : value.records }))
      } catch (error) { if (!current.aborted) setError(message(error)) }
      finally { if (!current.aborted) { inFlight.current = false; setPending(false) } }
    }
    React.useEffect(() => {
      const own = new AbortController(); active.current = AbortSignal.any([own.signal, signal]); inFlight.current = false; load()
      return () => own.abort()
    }, [])
    return h('div', { className: 'dshChanges__records', 'data-record-kind': recordKind },
      error && h(Placeholder, { error: true, retry: () => load(data?.nextOffset || 0), busy: pending }, error),
      !data && !error && h('div', { role: 'status' }, t('正在加载记录…')),
      data?.records.map(record => {
        const open = recordKind === 'segments' || (!record.noTextChange && opened.includes(record.id))
        const label = `${recordKind === 'segments' ? t('连续片段') : t('操作')} ${record.index}`
        return h('div', { key: record.id, className: 'dshChanges__record' },
          h('div', { className: 'dshChanges__metadata' },
            recordKind === 'segments' || record.noTextChange ? h('span', { className: 'dshChanges__recordLabel' }, label) : h(Button, { size: 'sm', className: 'dshChanges__recordToggle', 'aria-expanded': open,
              onClick: () => setOpened(old => open ? old.filter(id => id !== record.id) : [...old, record.id]) }, label),
            stats(record.stats),
            record.status === 'added' && h(Tag, { tone: 'success' }, t('新增')),
            record.status === 'deleted' && h(Tag, { tone: 'danger' }, t('删除')),
            record.noTextChange && h(Tag, { tone: 'quiet' }, t('无文本行变化')),
            record.evidenceOnly && h(Tag, { tone: 'quiet' }, t('重叠采集')),
            record.finalStatus === 'error' && h(Tag, { tone: 'warning' }, t('调用失败，保留已写入内容'))),
          open && h(RecordDiff, { ctx, sessionId, fileId, revision, record, signal }))
      }),
      data?.nextOffset != null && h(Button, { size: 'sm', className: 'dshChanges__recordMore', disabled: pending,
        onClick: () => load(data.nextOffset) }, pending ? t('正在加载…') : t("加载更多记录（{0}/{1}）", [data.records.length, data.total])))
  }
  return function SessionDetails({ ctx, sessionId, entry, revision, signal }) {
      useLocale(React)
    const [history, setHistory] = React.useState(false)
    const props = { ctx, sessionId, fileId: entry.fileId, revision, signal }
    return h(React.Fragment, null,
      entry.continuity === 'broken' && h(Records, { ...props, key: 'segments-' + revision, recordKind: 'segments' }),
      h(Button, { size: 'sm', className: 'dshChanges__historyButton', 'aria-expanded': history, onClick: () => setHistory(value => !value) },
        history ? t('收起操作历史') : t("查看操作历史（{0}）", [entry.operationCount])),
      history && h(Records, { ...props, key: 'operations-' + revision, recordKind: 'operations' }))
  }
}
