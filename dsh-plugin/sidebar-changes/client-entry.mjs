import { t, useLocale } from '../i18n/api.mjs'
import { contribution, LABELS, VIEWS, REASONS } from './shared/change-model.mjs'
import { createStateProvider, createViewStates, migrateFileIds } from './client-state.mjs'
import { createHistoryView } from './history-view.mjs'
import { createSessionDetails } from './session-details.mjs'

const ID = '@dsh-desktop/sidebar-changes', KIND = 'desktop-changes', PREFIX = 'dsh-resource://desktop-changes/'
const STATUS = { get added() { return t('新增') }, get deleted() { return t('删除') }, get renamed() { return t('重命名') }, get modified() { return t('修改') }, get restored() { return t('已恢复原状') }, get conflict() { return t('合并冲突') }, get submodule() { return t('子模块') }, get symlink() { return t('符号链接') } }
window.__ModuleLoader__.load({ id: ID, factory(require) {
  const React = require('react'), h = React.createElement
  const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
  const { Button, Menu, Tag, Tooltip, PathLabel, FileTypeIcon,
    IconChevronDownOutlineRegular: ChevronDown, IconChevronRightOutlineRegular: ChevronRight,
    IconChevronUpOutlineRegular: ChevronUp, IconCompareSplitOutlineRegular: ChangesIcon,
    IconWarningOutlineRegular: WarningIcon } = primitives
  function FilePath({ path }) { return h('span', { className: 'dshChanges__path' }, h(PathLabel, { path })) }
  const stats = value => h('span', { className: 'dshChanges__stats' }, h('span', { className: 'dshChanges__added' }, '+' + (value?.added ?? '—')), ' ', h('span', { className: 'dshChanges__removed' }, '-' + (value?.removed ?? '—')))
  const message = error => REASONS[error?.message] || error?.message || t('读取失败，请重试')
  function Placeholder({ children, error = false, retry, busy = false }) {
    return h('div', { className: 'dshChanges__placeholder', role: error ? 'alert' : 'status' },
      h('span', { className: 'dshChanges__placeholderIcon', 'aria-hidden': true }, h(error ? WarningIcon : ChangesIcon, { size: 24 })),
      h('span', null, children), retry && h(Button, { size: 'sm', variant: 'outline', onClick: retry, disabled: busy }, busy ? t('正在重试…') : t('重试')))
  }
  function StatusTag({ children, label, tone = 'neutral' }) {
    return h(Tooltip, { label: label || children, portal: true, side: 'bottom', maxWidth: 320 },
      h('span', { className: 'dshChanges__tag', tabIndex: 0 }, h(Tag, { tone }, children)))
  }
  function SourceMenu({ source, capabilities, onChange, visible }) {
    const [open, setOpen] = React.useState(false)
    const trigger = React.useRef(), menuClass = 'dshChanges__menu-' + React.useId()
    React.useEffect(() => { if (!visible) setOpen(false) }, [visible])
    React.useEffect(() => {
      if (!open || !visible) return
      // A portaled Menu first measures while hidden. Focus after placement if
      // the native autoFocus ran before the measured surface became visible.
      const frame = requestAnimationFrame(() => {
        if (document.activeElement === trigger.current) document.getElementsByClassName(menuClass)[0]?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
      })
      return () => cancelAnimationFrame(frame)
    }, [open, visible])
    return h(Menu, { open: open && visible, portal: true, compact: true, autoFocus: true, selectedId: source,
      className: 'dshChanges__source', listClassName: 'dshChanges__sourceMenu ' + menuClass,
      onClose: () => setOpen(false), onSelect: value => { setOpen(false); onChange(value) },
      items: VIEWS.map(value => ({ id: value, label: LABELS[value], disabled: value !== 'session' && capabilities?.gitAvailability.status !== 'available' || value === 'history' && !capabilities?.supportedViews?.includes('history') })),
      anchor: h(Button, { ref: trigger, size: 'sm', className: 'dshChanges__sourceButton', 'aria-label': t('更改范围'), 'aria-haspopup': 'menu', 'aria-expanded': open && visible,
        onClick: () => setOpen(value => !value), onKeyDown: event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true) } } },
        LABELS[source], h(ChevronDown, { size: 12 })) })
  }
  async function call(ctx, method, ...args) {
    const result = await ctx.remote.desktopChanges[method](...args)
    if (!result.ok) throw result.error
    return result.value
  }
  function DiffRows({ rows }) {
    return h('div', { className: 'dshChanges__code', role: 'table', 'aria-label': t('文件差异') }, rows.map((row, i) => h('div', { role: 'row', key: i, className: 'dshChanges__line', 'data-kind': row.kind },
      h('span', { role: 'cell', className: 'dshChanges__number' }, row.old), h('span', { role: 'cell', className: 'dshChanges__number' }, row.next),
      h('span', { role: 'cell', className: 'dshChanges__sign' }, row.kind), h('code', { role: 'cell' }, row.text || ' '))))
  }
  function Details({ ctx, sessionId, source, entry, revision, signal, onReady, reload, retryBusy }) {
      useLocale(React)
    const [data, setData] = React.useState(null), [error, setError] = React.useState(null), [expanded, setExpanded] = React.useState({}), [pending, setPending] = React.useState(false)
    const controller = React.useRef(), requests = React.useRef(new Set()), ready = React.useRef(onReady)
    ready.current = onReady
    React.useEffect(() => {
      const own = new AbortController(), active = AbortSignal.any([signal, own.signal]); controller.current = active
      requests.current = new Set(); setData(null); setError(null); setExpanded({}); setPending(false)
      call(ctx, 'getFileDiff', sessionId, source, entry.fileId, revision, 0, active).then(value => {
        if (!active.aborted) setData(value)
      }).catch(error => { if (!active.aborted) setError(message(error)) })
      return () => own.abort()
    }, [sessionId, source, entry.fileId, revision])
    React.useLayoutEffect(() => { if (data || error) ready.current(entry.fileId) }, [Boolean(data), error])
    async function more() {
      const active = controller.current
      if (pending || active.aborted) return
      setPending(true); setError(null)
      try {
        const value = await call(ctx, 'getFileDiff', sessionId, source, entry.fileId, revision, data.nextOffset, active)
        if (!active.aborted) setData(old => ({ ...value, operations: old.operations, rows: [...old.rows, ...value.rows] }))
      } catch (error) { if (!active.aborted) setError(message(error)) }
      finally { if (!active.aborted) setPending(false) }
    }
    async function context(gap) {
      const active = controller.current, current = expanded[gap.offset], inFlight = requests.current
      if (inFlight.has(gap.offset) || active.aborted) return
      inFlight.add(gap.offset); setError(null)
      setExpanded(old => ({ ...old, [gap.offset]: { ...old[gap.offset], pending: true } }))
      try {
        const value = await call(ctx, 'getFileContext', sessionId, source, entry.fileId, revision, current?.nextOffset ?? gap.offset, active)
        if (!active.aborted) setExpanded(old => ({ ...old, [gap.offset]: { ...value, rows: [...(old[gap.offset]?.rows || []), ...value.rows] } }))
      } catch (error) { if (!active.aborted) setError(message(error)) }
      finally { inFlight.delete(gap.offset); if (!active.aborted) setExpanded(old => ({ ...old, [gap.offset]: { ...old[gap.offset], pending: false } })) }
    }
    const rendered = [], group = []
    const flush = () => { if (group.length) { rendered.push(h(DiffRows, { key: 'lines-' + rendered.length, rows: group.splice(0) })) } }
    for (const row of data?.rows || []) {
      if (row.kind !== 'gap') { group.push(row); continue }
      flush()
      const opened = expanded[row.offset]
      if (opened?.rows) rendered.push(h(DiffRows, { key: 'context-' + row.offset, rows: opened.rows }))
      if (!opened || opened.nextOffset !== null) rendered.push(h(Button, { key: 'gap-' + row.offset, size: 'sm', className: 'dshChanges__context', disabled: opened?.pending, onClick: () => context(row) }, opened?.pending ? t('正在加载…') : t("展开 {0} 行上下文", [row.length - (opened?.rows?.length || 0)])))
    }
    flush()
    return h('div', { className: 'dshChanges__detail' },
      error && h(Placeholder, { error: true, retry: reload, busy: retryBusy }, error), !data && !error && h('div', { className: 'dshChanges__loading', role: 'status' }, t('正在加载差异…')),
      data && h(React.Fragment, null,
        data.previousPath && h('div', { className: 'dshChanges__metadata' }, h(StatusTag, { label: `${data.previousPath} → ${data.path}` }, t('重命名'))),
        data.reason && h(Placeholder, null, REASONS[data.reason] || data.reason), rendered,
        (data.beforeNewline === false || data.afterNewline === false) && h('div', { className: 'dshChanges__metadata' }, h(Tag, { tone: 'quiet' }, t('文件末尾无换行'))),
        data.totalRows === 0 && !data.reason && h(Placeholder, null, t('无文本行变化')),
        data.nextOffset !== null && h(Button, { size: 'sm', className: 'dshChanges__context', onClick: more, disabled: pending }, pending ? t('正在加载…') : t('加载更多差异')),
        source === 'session' && entry.operationCount > 0 && h(SessionDetails, { ctx, sessionId, entry, revision, signal })))
  }
  const SessionDetails = createSessionDetails(React, primitives, { call, message, Placeholder, DiffRows, stats })
  const HistoryView = createHistoryView(React, primitives, { SourceMenu, Placeholder, StatusTag, call, message })
  function Panel(props) {
      useLocale(React)
    const { states, sessionId, tab } = props, key = sessionId + '\0' + tab.contentId
    const [source, setSource] = React.useState(() => states.get(key)?.source || 'session')
    const viewStates = React.useMemo(() => createViewStates(states, source), [states, source])
    const onSourceChange = value => { states.set(key, { ...states.get(key), source: value }); setSource(value) }
    React.useEffect(() => {
      const restore = () => setSource(states.get(key)?.source || 'session')
      document.addEventListener('dsh-desktop:changes-restore', restore)
      return () => document.removeEventListener('dsh-desktop:changes-restore', restore)
    }, [key])
    return h(source === 'history' ? HistoryView : ChangesPanel, { ...props, key: source, source, states: viewStates, onSourceChange })
  }
  function ChangesPanel({ ctx, tab, sessionId, states, source, onSourceChange }) {
      useLocale(React)
    const stateKey = sessionId + '\0' + tab.contentId
    const saved = states.get(stateKey) || { source: 'session', fileId: null, listScroll: 0, detailScroll: 0 }
    const openedFiles = value => value.fileIds || (value.fileId ? [value.fileId] : [])
    const [expanded, setExpanded] = React.useState(() => openedFiles(saved))
    const [showRestored, setShowRestored] = React.useState(Boolean(saved.showRestored))
    const [capabilities, setCapabilities] = React.useState(null), [data, setData] = React.useState(null), [error, setError] = React.useState(null)
    const [refresh, setRefresh] = React.useState(0), [loading, setLoading] = React.useState(true)
    const [detailAttempt, setDetailAttempt] = React.useState(0), retryDetails = React.useRef(false)
    const list = React.useRef(), position = React.useRef(saved), root = React.useRef(null)
    const restoring = React.useRef(true), readyFiles = React.useRef(new Set())
    const fetching = React.useRef(false)
    const update = patch => { position.current = { ...position.current, ...patch }; states.set(stateKey, position.current) }
    React.useEffect(() => { update({ source, fileIds: expanded, fileId: expanded.at(-1) || null }) }, [source, expanded])
    const restoreScroll = fileId => {
      if (fileId) readyFiles.current.add(fileId)
      if (!restoring.current || !list.current) return
      list.current.scrollTop = position.current.listScroll || 0
      if (expanded.every(id => readyFiles.current.has(id))) restoring.current = false
    }
    React.useLayoutEffect(() => {
      if (!tab.visible) { restoring.current = true; readyFiles.current.clear() }
    }, [tab.visible])
    React.useEffect(() => {
      const restore = () => {
        const value = states.get(stateKey)
        if (!value) return
        position.current = value; restoring.current = true; readyFiles.current.clear()
        setData(null); setExpanded(openedFiles(value)); setRefresh(n => n + 1)
      }
      document.addEventListener('dsh-desktop:changes-restore', restore)
      return () => document.removeEventListener('dsh-desktop:changes-restore', restore)
    }, [stateKey])
    React.useEffect(() => {
      if (!tab.visible) return
      const own = new AbortController(), signal = AbortSignal.any([own.signal, tab.signal])
      fetching.current = true; setLoading(true); setError(null)
      call(ctx, 'getCapabilities', sessionId, signal).then(async cap => {
        if (signal.aborted) return
        if (source !== 'session' && root.current && root.current !== cap.workspaceRoot) { setData(null); setExpanded([]); update({ listScroll: 0, detailScroll: 0 }) }
        root.current = cap.workspaceRoot; setCapabilities(cap)
        if (source !== 'session' && cap.gitAvailability.status !== 'available') { onSourceChange('session'); return }
        const value = await call(ctx, 'listChanges', sessionId, source, signal)
        if (signal.aborted || value.sessionId !== sessionId || value.source !== source || value.workspaceRoot !== root.current) return
        setData(value)
        if (retryDetails.current) { retryDetails.current = false; setDetailAttempt(attempt => attempt + 1) }
        setExpanded(current => migrateFileIds(current, [...value.entries, ...(value.restoredEntries || [])]))
      }).catch(error => { if (!signal.aborted) setError(message(error)) }).finally(() => { if (!signal.aborted) { fetching.current = false; setLoading(false) } })
      return () => { own.abort(); fetching.current = false }
    }, [sessionId, source, refresh, tab.visible])
    React.useEffect(() => {
      if (!tab.visible) return
      const own = new AbortController(); let debounce
      const invalidate = () => { clearTimeout(debounce); debounce = setTimeout(() => setRefresh(n => n + 1), 250) }
      const focus = () => { if (!document.hidden && !fetching.current) invalidate() }
      window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus)
      const timer = setInterval(focus, source === 'session' ? 30000 : 5000)
      if (source === 'session') (async () => {
        try {
          const stream = ctx.remote.desktopChanges.subscribeChanges(sessionId, '', AbortSignal.any([own.signal, tab.signal]))
          let first = true
          for await (const value of stream) { if (own.signal.aborted) break; if (!first) invalidate(); first = false }
        } catch { /* Focus and low-frequency refresh remain available after transport interruption. */ }
      })()
      return () => { own.abort(); clearTimeout(debounce); clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
    }, [sessionId, source, tab.visible])
    React.useLayoutEffect(() => { if (data) restoreScroll() }, [Boolean(data), expanded])
    const changeSource = value => {
      if (value === source) return
      update({ source, fileIds: expanded, fileId: expanded.at(-1) || null })
      onSourceChange(value)
    }
    const reload = () => { retryDetails.current = true; setRefresh(n => n + 1) }
    const toggle = id => { restoring.current = false; setExpanded(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]) }
    const totals = data?.entries.reduce((total, entry) => ({
      added: total.added === null || entry.stats.added === null ? null : total.added + entry.stats.added,
      removed: total.removed === null || entry.stats.removed === null ? null : total.removed + entry.stats.removed,
    }), { added: 0, removed: 0 })
    const git = capabilities?.gitAvailability
    const noGit = git && git.status !== 'available'
    const panelId = React.useId()
    const entries = [...(data?.entries || []), ...(showRestored ? data?.restoredEntries || [] : [])]
    const summary = source === 'session' && data?.totals
      ? h(React.Fragment, null,
        data.totals.session.files > 0 && h('span', { title: t('已确认的会话净变化') }, stats(data.totals.session)),
        data.totals.observed.files > 0 && h('span', { title: t('包含执行期间观察到的变化') }, stats(data.totals.observed)),
        data.totals.unavailable > 0 && h('span', null, t("{0} 个待完整比较", [data.totals.unavailable]))) : stats(totals)
    return h('section', { className: 'dshChanges', 'aria-label': t('更改'), 'data-dsh-changes': true, 'data-source': source },
      h('header', { className: 'dshChanges__toolbar' },
        h('div', { className: 'dshChanges__scope' },
          h(SourceMenu, { source, capabilities, onChange: changeSource, visible: tab.visible }),
          noGit && h(StatusTag, { label: git.reason }, git.status === 'none' ? t('非 Git 仓库') : git.status === 'missing' ? t('Git 未安装') : t('Git 不可用'))),
        Boolean(data?.entries.length) && h('div', { className: 'dshChanges__summary', 'aria-label': t("{0} 个文件", [data.entries.length]) },
          h(Tag, { tone: 'neutral' }, data.entries.length), summary),
        expanded.length > 0 && h(Tooltip, { label: t('全部折叠'), portal: true, side: 'bottom' },
          h(Button, { size: 'sm', className: 'dshChanges__collapse', 'aria-label': t('全部折叠'), onClick: () => { restoring.current = false; setExpanded([]) } }, h(ChevronUp, { size: 14 })))),
      data?.coverageEvents?.length > 0 && h('details', { className: 'dshChanges__coverage' },
        h('summary', null, t('查看采集范围')),
        data.coverageEvents.map((event, index) => h('div', { key: index },
          `${REASONS[event.reason] || event.reason} · ${event.root} · ${(event.paths || [event.path || '.']).join('、')}`))),
      source === 'session' && data?.pendingCount > 0 && h('div', { className: 'dshChanges__metadata' },
        h(Tag, { tone: 'quiet' }, t('正在采集'))),
      error && h(Placeholder, { error: true, retry: reload, busy: loading }, error),
      loading && !data && !error && h(Placeholder, null, t('正在加载更改…')),
      data && h('div', { className: 'dshChanges__list', ref: list,
        onWheel: () => { restoring.current = false }, onPointerDown: () => { restoring.current = false },
        onScroll: event => { if (tab.visible && !restoring.current) update({ listScroll: event.currentTarget.scrollTop }) } },
        !data.entries.length && h(Placeholder, null, source === 'session' ? data.gaps.length ? t('暂未找到可展示的更改，采集范围存在缺口') : data.restoredEntries?.length ? t('已记录的文件均已恢复原状') : t('尚无已记录的文件更改') : source === 'staged' ? t('暂无暂存的更改') : t('没有未提交的更改')),
        data.restoredEntries?.length > 0 && h(Button, { size: 'sm', className: 'dshChanges__historyButton', 'aria-expanded': showRestored,
          onClick: () => { setShowRestored(value => !value); update({ showRestored: !showRestored }) } }, t("{0}已恢复原状（{1}）", [showRestored ? t('收起') : t('查看'), data.restoredEntries.length])),
        entries.map((entry, index) => {
          const open = expanded.includes(entry.fileId), detailId = panelId + '-' + entry.fileId
          return h('article', { key: entry.fileId, className: 'dshChanges__item', 'data-open': open },
            data.roots?.length > 1 && entry.root !== entries[index - 1]?.root && h('div', { className: 'dshChanges__metadata dshChanges__root' }, entry.root),
            h(Tooltip, { label: entry.path, portal: true, side: 'bottom', delayMs: 600, focusDelayMs: 400, maxWidth: 420 },
              h(Button, { size: 'sm', className: 'dshChanges__file', onClick: () => toggle(entry.fileId),
                'aria-expanded': open, 'aria-controls': detailId,
                'aria-label': t("{0}，{1}，新增 {2} 行，删除 {3} 行", [entry.path, STATUS[entry.status], entry.stats.added ?? t('未知'), entry.stats.removed ?? t('未知')]) },
                h('span', { className: 'dshChanges__chevron', 'aria-hidden': true }, h(open ? ChevronDown : ChevronRight, { size: 12 })),
                h(FileTypeIcon, { path: entry.path, size: 16, className: 'dshChanges__fileIcon' }),
                h('span', { className: 'dshChanges__row' }, h(FilePath, { path: entry.path }), stats(entry.stats)))),
            (entry.reason || !['added', 'modified'].includes(entry.status)) && h('div', { className: 'dshChanges__fileTags' },
              !['added', 'modified'].includes(entry.status) && h(Tag, { tone: entry.status === 'deleted' ? 'danger' : 'neutral' }, STATUS[entry.status]),
              entry.reason && h(StatusTag, { tone: 'warning', label: REASONS[entry.reason] || entry.reason }, entry.continuity === 'broken' ? t('分段比较') : t('内容受限'))),
            h('div', { id: detailId, 'aria-hidden': !open }, open && tab.visible && h(Details, { key: entry.fileId + source + detailAttempt, ctx, sessionId, source, entry, revision: data.revision, signal: tab.signal, onReady: restoreScroll, reload, retryBusy: loading })))
        })))
  }
  function installUI(ctx) {
    const states = new Map(), addresses = new WeakMap()
    function Body(props) {
      useLocale(React)
      const tab = props.useTabInfo().tab
      React.useLayoutEffect(() => {
        if (tab.contentId !== 'sidebar://' + KIND) return
        if (!addresses.has(tab.signal)) addresses.set(tab.signal, PREFIX + encodeURIComponent(tab.id) + '-' + crypto.randomUUID())
        tab.actions.openResource(addresses.get(tab.signal), { replaceTab: true, revealIfOpened: false })
      }, [tab.contentId, tab.signal])
      return tab.contentId.startsWith(PREFIX) ? h(Panel, { key: props.sessionId + tab.contentId, ctx, tab, sessionId: props.sessionId, states }) : h(Placeholder, null, t('正在打开更改…'))
    }
    const offBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID, inject: sessionId => ({ sessionId }) }, Body))
    let offType, mode
    const sync = () => {
      const next = document.documentElement.getAttribute('data-dsh-ui') !== 'vanilla'
      if (next === mode) return
      mode = next; offType?.()
      offType = ctx.sidebarRightTabs.register({ id: ID, kind: KIND, patterns: [PREFIX + '**'], canOpen: address => address.startsWith(PREFIX), title: () => t('更改'),
        ...(mode ? { guide: [{ order: 30, title: () => t('更改'), description: () => t('查看文件修改前后的差异'), icon: props => h(ChangesIcon, { size: props.size || 22 }) }] } : {}) })
    }
    sync(); document.addEventListener('dsh-desktop:ui-mode', sync)
    const observer = new MutationObserver(sync); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-dsh-ui'] })
    const provider = createStateProvider(ctx, states)
    const offState = window.__DSH_UI_STATE__?.registerProvider('desktop-changes', provider)
    return () => { observer.disconnect(); document.removeEventListener('dsh-desktop:ui-mode', sync); offType?.(); offBody(); offState?.(); states.clear() }
  }
  return { inject: ['slots', 'sidebarRightTabs', 'sessions', 'remote'], async apply(ctx) {
    const offRemote = await ctx.remote.$mount(contribution)
    const fiber = ctx.inject(['remote.desktopChanges'], installUI)
    return async () => { await fiber.dispose(); await offRemote() }
  } }
} })
