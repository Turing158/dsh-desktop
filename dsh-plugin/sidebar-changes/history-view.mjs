import { t, useLocale } from '../i18n/api.mjs'
import { layoutCommits } from './shared/commit-graph.mjs'
import { createHistoryDisclosure } from './history-disclosure.mjs'

export function createHistoryView(React, primitives, shared) {
  const h = React.createElement
  const HistoryDisclosure = createHistoryDisclosure(React)
  const { Button, Tag, Tooltip, IconChevronUpOutlineRegular: CollapseIcon } = primitives
  const { SourceMenu, Placeholder, StatusTag, call, message } = shared
  const date = (value, full = false) => {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN', full
      ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }
      : { month: '2-digit', day: '2-digit' })
  }
  const commitInfo = entry => [
    t("提交：{0}", [entry.id]),
    t("作者：{0}{1}", [entry.author, entry.authorEmail ? ` <${entry.authorEmail}>` : '']),
    t("提交者：{0}{1}", [entry.committer || '—', entry.committerEmail ? ` <${entry.committerEmail}>` : '']),
    t("提交时间：{0}", [date(entry.commitDate, true)]),
  ].join('\n')
  function Refs({ refs }) {
    return h('span', { className: 'dshHistory__refs', title: refs.map(ref => ref.name).join(' · ') },
      refs.map(ref => h(Tag, { key: ref.kind + ref.name, tone: ref.kind === 'head' ? 'solid' : ref.current ? 'info' : 'neutral' }, ref.name)))
  }
  function Graph({ row, columns, boundary }) {
    const width = Math.min(96, columns * 14 + 6), step = columns === 1 ? 14 : (width - 14) / (columns - 1), x = column => 7 + column * step
    const color = index => `var(--history-lane-${index})`
    const children = []
    const line = (key, column, y1, y2, lane) => h('line', { key, x1: x(column), x2: x(column), y1, y2, stroke: color(lane) })
    for (const edge of row.passing) {
      children.push(line('in-' + edge.from, edge.from, 0, 18, edge.color),
        h('path', { key: 'pass-' + edge.from, d: `M ${x(edge.from)} 18 C ${x(edge.from)} 26 ${x(edge.to)} 26 ${x(edge.to)} 34`, stroke: color(edge.color) }),
        line('out-' + edge.from, edge.to, 34, '100%', edge.color))
    }
    if (row.incoming) children.push(line('node-in', row.column, 0, 18, row.color))
    for (const edge of row.parents) children.push(
      h('path', { key: 'parent-' + edge.id, d: `M ${x(row.column)} 18 C ${x(row.column)} 26 ${x(edge.to)} 26 ${x(edge.to)} 34`, stroke: color(edge.color) }),
      line('parent-line-' + edge.id, edge.to, 34, '100%', edge.color))
    children.push(h('circle', { key: 'node', cx: x(row.column), cy: 18, r: boundary ? 4 : 3.5, fill: boundary ? 'var(--dsw-alias-bg-base)' : color(row.color), stroke: color(row.color) }))
    return h('svg', { className: 'dshHistory__graph', width, height: '100%', fill: 'none', strokeWidth: 1.5, 'aria-hidden': true }, children)
  }
  function Details({ ctx, sessionId, revision, entry, signal, onReady, reload, busy }) {
      useLocale(React)
    const [data, setData] = React.useState(null), [error, setError] = React.useState(null)
    const ready = React.useRef(onReady)
    ready.current = onReady
    React.useEffect(() => {
      const own = new AbortController(), active = AbortSignal.any([own.signal, signal])
      call(ctx, 'getCommitDetails', sessionId, revision, entry.id, active).then(value => { if (!active.aborted) setData(value) })
        .catch(error => { if (!active.aborted) setError(message(error)) })
      return () => own.abort()
    }, [sessionId, revision, entry.id])
    React.useLayoutEffect(() => { if (data || error) ready.current(entry.id) }, [data, error])
    return h('div', { className: 'dshHistory__detail', 'aria-busy': !data && !error },
      error ? h(Placeholder, { error: true, retry: reload, busy }, error)
        : !data ? h('div', { className: 'dshChanges__loading', role: 'status' }, t('正在加载提交…'))
          : h('pre', { className: 'dshHistory__message' }, data.message || t('（无提交消息）')))
  }
  return function HistoryView({ ctx, tab, sessionId, states, onSourceChange }) {
      useLocale(React)
    const stateKey = sessionId + '\0' + tab.contentId, saved = states.get(stateKey) || {}
    const [data, setData] = React.useState(null), [capabilities, setCapabilities] = React.useState(null), [error, setError] = React.useState(null)
    const [expanded, setExpanded] = React.useState(saved.commitIds || []), [loading, setLoading] = React.useState(true), [paging, setPaging] = React.useState(false)
    const [refresh, setRefresh] = React.useState(0), [attempt, setAttempt] = React.useState(0)
    const viewport = React.useRef(), sentinel = React.useRef(), request = React.useRef(), current = React.useRef(null), busy = React.useRef(false)
    const position = React.useRef(saved), opened = React.useRef(expanded), force = React.useRef(false), restoring = React.useRef(true), ready = React.useRef(new Set())
    opened.current = expanded
    const update = patch => { position.current = { ...position.current, ...patch, source: 'history' }; states.set(stateKey, position.current) }
    const assign = value => { current.current = value; setData(value) }
    const restoreScroll = id => {
      if (id) ready.current.add(id)
      const node = viewport.current
      if (!node || !restoring.current) return
      const anchor = [...node.querySelectorAll('[data-commit-id]')].find(row => row.dataset.commitId === position.current.anchorId)
      node.scrollTop = anchor ? anchor.offsetTop - (position.current.anchorOffset || 0) : position.current.listScroll || 0
      if (opened.current.every(id => ready.current.has(id) || !current.current?.entries.some(row => row.id === id))) restoring.current = false
    }
    const saveScroll = () => {
      const node = viewport.current
      if (!node || restoring.current || !tab.visible) return
      const anchor = [...node.querySelectorAll('[data-commit-id]')].find(row => row.offsetTop + row.offsetHeight > node.scrollTop)
      update({ listScroll: node.scrollTop, anchorId: anchor?.dataset.commitId, anchorOffset: anchor ? anchor.offsetTop - node.scrollTop : 0 })
    }
    React.useEffect(() => { update({ commitIds: expanded }) }, [expanded])
    React.useLayoutEffect(() => { if (data) restoreScroll() }, [data, expanded])
    React.useLayoutEffect(() => { if (!tab.visible) { restoring.current = true; ready.current.clear() } }, [tab.visible])
    React.useEffect(() => {
      const restore = () => {
        position.current = states.get(stateKey) || {}; restoring.current = true; ready.current.clear()
        setExpanded(position.current.commitIds || []); assign(null); setRefresh(n => n + 1)
      }
      document.addEventListener('dsh-desktop:changes-restore', restore)
      return () => document.removeEventListener('dsh-desktop:changes-restore', restore)
    }, [stateKey])
    React.useEffect(() => {
      if (!tab.visible) return
      const own = new AbortController(), signal = AbortSignal.any([own.signal, tab.signal]); request.current = signal
      setPaging(false)
      async function load() {
        if (busy.current || document.hidden || signal.aborted) return
        busy.current = true; setLoading(true); setError(null)
        try {
          const cap = await call(ctx, 'getCapabilities', sessionId, signal)
          if (signal.aborted) return
          setCapabilities(cap)
          if (cap.gitAvailability.status !== 'available') { onSourceChange('session'); return }
          let next = await call(ctx, 'listCommits', sessionId, '', 0, signal)
          if (signal.aborted) return
          const old = current.current
          // An unchanged Git revision may have a new host cache after expiry or restart.
          // Reload the saved pages before allowing details from that cache again.
          if (old?.revision === next.revision && old.snapshotId === next.snapshotId && !force.current) return
          const target = Math.max(50, old?.entries.length || position.current.loadedCount || 50)
          while (next.nextOffset !== null && next.entries.length < target) {
            const page = await call(ctx, 'listCommits', sessionId, next.revision, next.nextOffset, signal)
            next = { ...page, entries: [...next.entries, ...page.entries] }
          }
          if (signal.aborted || next.sessionId !== sessionId || next.workspaceRoot !== cap.workspaceRoot) return
          restoring.current = true; ready.current.clear()
          assign(next); update({ loadedCount: next.entries.length })
          setExpanded(ids => ids.filter(id => next.entries.some(row => row.id === id)))
          if (force.current) { force.current = false; setAttempt(n => n + 1) }
        } catch (error) { if (!signal.aborted) setError(message(error)) }
        finally { if (!signal.aborted) { busy.current = false; setLoading(false) } }
      }
      load()
      const focus = () => { if (!document.hidden) load() }
      window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus)
      window.addEventListener('dsh-desktop:git-changed', focus)
      const timer = setInterval(focus, 5000)
      return () => { own.abort(); busy.current = false; clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener('dsh-desktop:git-changed', focus); document.removeEventListener('visibilitychange', focus) }
    }, [sessionId, tab.visible, refresh])
    const reload = () => { force.current = true; setRefresh(n => n + 1) }
    async function more() {
      const old = current.current, signal = request.current
      if (busy.current || !old || old.nextOffset === null || !signal || signal.aborted) return
      busy.current = true; setPaging(true); setError(null)
      try {
        const next = await call(ctx, 'listCommits', sessionId, old.revision, old.nextOffset, signal)
        if (signal.aborted || current.current !== old) return
        const value = { ...next, entries: [...old.entries, ...next.entries] }; assign(value); update({ loadedCount: value.entries.length })
      } catch (error) { if (!signal.aborted) setError(message(error)) }
      finally { if (!signal.aborted) { busy.current = false; setPaging(false) } }
    }
    React.useEffect(() => {
      if (!tab.visible || !sentinel.current || data?.nextOffset === null || loading || paging || error) return
      const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) more() }, { root: viewport.current, rootMargin: '160px' })
      observer.observe(sentinel.current); return () => observer.disconnect()
    }, [data, tab.visible, loading, paging, error])
    const graph = React.useMemo(() => layoutCommits(data?.entries || []), [data])
    const columns = graph.reduce((max, row) => Math.max(max, row.columns), 1), graphWidth = Math.min(96, columns * 14 + 6), panelId = React.useId()
    return h('section', { className: 'dshChanges dshHistory', 'aria-label': t('更改'), 'data-dsh-changes': true, 'data-source': 'history' },
      h('header', { className: 'dshChanges__toolbar' },
        h('div', { className: 'dshChanges__scope' }, h(SourceMenu, { source: 'history', capabilities, onChange: onSourceChange, visible: tab.visible }),
          data?.shallow && h(StatusTag, { label: t('浅克隆只包含已获取的历史，边界之外的提交暂不可见') }, t('浅克隆'))),
        expanded.length > 0 && h('div', { className: 'dshChanges__toolbarActions' },
          h(Tooltip, { label: t('全部折叠'), portal: true, side: 'bottom' }, h(Button, { className: 'dshChanges__collapse dshHistory__collapse', size: 'sm', 'aria-label': t('全部折叠'), onClick: () => { restoring.current = false; setExpanded([]) } }, h(CollapseIcon, { size: 14 }))))),
      error && h(Placeholder, { error: true, retry: reload, busy: loading }, error),
      !data && loading && !error && h(Placeholder, null, t('正在加载提交记录…')),
      data && h('div', { className: 'dshChanges__list dshHistory__list', ref: viewport, onScroll: saveScroll,
        onWheel: () => { restoring.current = false }, onPointerDown: () => { restoring.current = false } },
        !data.entries.length && h(Placeholder, null, t('暂无提交记录')),
        data.entries.map((entry, index) => {
          const open = expanded.includes(entry.id), id = panelId + entry.id
          return h('article', { key: entry.id, className: 'dshHistory__commit', 'data-commit-id': entry.id, 'data-open': open, style: { '--history-graph-width': graphWidth + 'px' } },
            h(Graph, { row: graph[index], columns, boundary: entry.boundary }),
            h(Tooltip, { label: commitInfo(entry), portal: true, side: 'bottom', delayMs: 600, maxWidth: 420, disabled: !tab.visible },
              h(Button, { className: 'dshHistory__row', size: 'sm', 'aria-expanded': open, 'aria-controls': id, 'aria-label': t('提交：') + (entry.subject || entry.id),
                'aria-description': commitInfo(entry),
                onClick: () => { restoring.current = false; setExpanded(ids => ids.includes(entry.id) ? ids.filter(id => id !== entry.id) : [...ids, entry.id]) } },
                h('span', { className: 'dshHistory__titleLine' }, h('span', { className: 'dshHistory__subject' }, entry.subject || t('（无提交标题）')), h(Refs, { refs: entry.refs })),
                h('span', { className: 'dshHistory__byline' }, h('span', null, entry.author), h('time', { dateTime: entry.commitDate }, date(entry.commitDate)),
                  entry.parents.length > 1 && h('span', null, t('合并')), entry.boundary && h('span', null, t('历史边界'))))),
            h(HistoryDisclosure, { id, open: open && tab.visible, animate: !restoring.current }, h(Details, { key: entry.id + data.revision + data.snapshotId + attempt, ctx, sessionId, revision: data.revision, entry, signal: tab.signal, onReady: restoreScroll, reload, busy: loading })))
        }),
        data.nextOffset !== null && h('div', { ref: sentinel, className: 'dshHistory__more' }, h(Button, { size: 'sm', onClick: more, disabled: loading || paging || Boolean(error) }, paging ? t('正在加载…') : t('加载更多提交')))))
  }
}
