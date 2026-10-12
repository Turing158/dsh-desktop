import { t, useLocale } from '../i18n/api.mjs'
import { ID, contribution } from './protocol.mjs'
import { ROOTS, createNavigation } from './navigation.mjs'
import css from './style.css'

window.__ModuleLoader__.load({ id: ID, factory(require) {
  const React = require('react'), h = React.createElement
  const { Modal, Button, IconChevronLeftOutlineRegular: Back, IconChevronRightOutlineRegular: Forward,
    IconChevronUpOutlineRegular: Up, IconRefreshOutlineRegular: Refresh,
    IconFolderCloseRegular: Folder } = require('@deepseek-ai/dsh-client-ui-primitives')
  function Drive() {
    return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
      h('path', { d: 'M5 4h14l3 11v5H2v-5L5 4ZM2 15h20M16 18h1m2 0h1' }))
  }
  async function install(ctx) {
    // A loopback-only host may serve the OS picker; only browse supports listing.
    const capability = await ctx.remote.desktopDirectoryPicker.capability()
    if (!capability.ok || capability.value !== 'browse') return
    const style = document.createElement('style'); style.textContent = css; document.head.append(style)
    function NewFolder({ path, onCreated, onClose }) {
      useLocale(React)
      const [name, setName] = React.useState(''), [saving, setSaving] = React.useState(false), [error, setError] = React.useState(null)
      const alive = React.useRef(true)
      React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
      const create = async event => {
        event.preventDefault()
        if (saving || !name.trim()) return
        setSaving(true); setError(null)
        try {
          const target = await ctx.uiWorkspace.createDirectory(path, name)
          if (alive.current) onCreated(target)
        } catch (error) {
          if (alive.current) { setError(error?.rpcError?.message || error.message); setSaving(false) }
        }
      }
      return h(Modal, { open: true, title: t('新建文件夹'), closeLabel: t('取消'), onClose: () => { if (!saving) onClose() }, className: 'dshDirectory__create' },
        h('form', { onSubmit: create, className: 'dshDirectory__createForm' },
          h('p', { className: 'dshDirectory__createPath', title: path }, path),
          h('input', { className: 'dshDirectory__input', 'data-modal-autofocus': '', 'aria-label': t('文件夹名称'),
            value: name, onChange: event => setName(event.target.value), disabled: saving, placeholder: t('文件夹名称') }),
          error && h('div', { role: 'alert', className: 'dshDirectory__error' }, error),
          h('div', { className: 'dshDirectory__actions' },
            h(Button, { type: 'button', variant: 'outline', disabled: saving, onClick: onClose }, t('取消')),
            h(Button, { type: 'submit', variant: 'primary', disabled: saving || !name.trim() }, saving ? t('正在创建…') : t('创建')))))
    }
    function Browser({ busy, onPicked, onCancel }) {
      useLocale(React)
      const navigation = React.useMemo(() => createNavigation({
        listDirectory: (path, signal) => ctx.uiWorkspace.listDirectory(path, signal),
        listRoots: async signal => {
          const result = await ctx.remote.desktopDirectoryPicker.roots(signal)
          if (!result.ok) throw Error(result.error.message)
          return result.value
        },
      }), [])
      const state = React.useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
      const [draft, setDraft] = React.useState(''), [hidden, setHidden] = React.useState(false), [creating, setCreating] = React.useState(false)
      const list = React.useRef(null), crumbs = React.useRef(null), suggestions = React.useId()
      React.useEffect(() => { void navigation.visit(); return () => navigation.dispose() }, [navigation])
      const directory = state.location?.kind === 'directory', path = directory ? state.location.path : ''
      React.useEffect(() => {
        setDraft(path)
        if (list.current) {
          list.current.scrollTop = 0
          // Entering a folder removes its focused row; keep keys inside the modal.
          if (document.activeElement === document.body) list.current.focus({ preventScroll: true })
        }
        if (crumbs.current) crumbs.current.scrollLeft = crumbs.current.scrollWidth
      }, [state.location])
      React.useEffect(() => {
        const trail = crumbs.current
        const observer = new ResizeObserver(() => { trail.scrollLeft = trail.scrollWidth })
        observer.observe(trail)
        return () => observer.disconnect()
      }, [])
      const inert = busy || creating, blocked = inert || state.loading
      const entries = (state.location?.entries || []).filter(entry => hidden || !entry.hidden)
      const go = event => { event.preventDefault(); if (!blocked && draft.trim()) void navigation.visit(draft.trim()) }
      const keydown = event => {
        if (creating) return
        let action
        if (event.altKey && !event.ctrlKey && !event.metaKey) action = { ArrowLeft: navigation.back, ArrowRight: navigation.forward, ArrowUp: navigation.parent }[event.key]
        else if (event.key === 'F5') action = navigation.refresh
        if (action) { event.preventDefault(); event.stopPropagation(); if (!blocked) void action() }
      }
      const tool = (label, Icon, action, disabled) => h(Button, { type: 'button', variant: 'ghost', className: 'dshDirectory__tool',
        title: t(label), 'aria-label': t(label), disabled: blocked || disabled, onClick: action }, h(Icon, { size: 18 }))
      const crumb = (label, target, current = false) => h('button', { type: 'button', className: 'dshDirectory__crumb', disabled: blocked,
        title: target === ROOTS ? t('此电脑') : target, 'aria-current': current ? 'location' : undefined,
        onClick: () => navigation.visit(target) }, label)
      return h(React.Fragment, null,
        h(Modal, { open: true, headless: true, title: t('选择工作区目录'), onClose: () => { if (!inert) onCancel() },
          className: 'dshDirectory', onKeyDownCapture: keydown },
          h('header', { className: 'dshDirectory__header' },
            h('h2', null, t('选择工作区目录')),
            h('div', { className: 'dshDirectory__toolbar', role: 'group', 'aria-label': t('文件夹导航') },
              tool('后退', Back, navigation.back, state.index <= 0),
              tool('前进', Forward, navigation.forward, state.index >= state.history.length - 1),
              tool('上一级', Up, navigation.parent, !directory),
              tool('刷新', Refresh, navigation.refresh, false),
              h(Button, { type: 'button', variant: 'ghost', disabled: blocked, onClick: () => navigation.visit(ROOTS), icon: h(Drive) }, t('此电脑')),
              h(Button, { type: 'button', variant: 'ghost', className: 'dshDirectory__home', disabled: blocked,
                title: t('主目录'), 'aria-label': t('主目录'), icon: h(Folder, { size: 18 }), onClick: () => navigation.visit() },
              h('span', { className: 'dshDirectory__homeText' }, t('主目录'))),
              h('form', { onSubmit: go, className: 'dshDirectory__path' },
                h('input', { className: 'dshDirectory__input', value: draft, onChange: event => setDraft(event.target.value),
                  'aria-label': t('文件夹路径'), placeholder: t('输入完整路径'), disabled: inert, list: suggestions, spellCheck: false,
                  onKeyDown: event => { if (event.key === 'Escape' && draft !== path) { event.preventDefault(); event.stopPropagation(); setDraft(path) } } }),
                h('datalist', { id: suggestions }, entries.map(entry => h('option', { key: entry.path, value: entry.path }))),
                h(Button, { type: 'submit', variant: 'outline', disabled: blocked || !draft.trim() }, t('转到')))),
            h('nav', { ref: crumbs, className: 'dshDirectory__crumbs', 'aria-label': t('当前位置') },
              crumb(t('此电脑'), ROOTS, state.location?.kind === 'roots'),
              ...(state.location?.crumbs || []).map((entry, index, crumbs) => h(React.Fragment, { key: entry.path },
                h('span', { 'aria-hidden': true }, '›'), crumb(entry.name, entry.path, index === crumbs.length - 1))))),
          h('div', { ref: list, tabIndex: -1, role: 'region', 'aria-label': t('文件夹导航'), className: 'dshDirectory__list', 'aria-busy': state.loading, 'data-location': state.location?.path },
            state.error && h('div', { className: 'dshDirectory__error', role: 'alert' }, state.error),
            h('div', { className: 'dshDirectory__status', role: 'status' }, state.loading ? t('加载中…')
              : state.location && !entries.length ? (directory ? t('没有可显示的文件夹') : t('没有可用的盘符')) : null),
            entries.map(entry => h('button', { key: entry.path, type: 'button', className: 'dshDirectory__row',
              disabled: blocked, title: entry.path, onClick: () => navigation.visit(entry.path) },
              h(directory ? Folder : Drive, { size: 18 }), h('span', null, entry.name), h(Forward, { size: 14 }))),
            state.location?.truncated && h('p', { className: 'dshDirectory__status' }, t('文件夹过多，仅显示开头部分。'))),
          h('footer', { className: 'dshDirectory__footer' },
            h(Button, { type: 'button', variant: 'outline', disabled: blocked || !directory, onClick: () => setCreating(true) }, t('新建文件夹')),
            h('label', { className: 'dshDirectory__hidden' }, h('input', { type: 'checkbox', checked: hidden, disabled: inert, onChange: event => setHidden(event.target.checked) }), t('显示隐藏文件')),
            h('div', { className: 'dshDirectory__actions' },
              h(Button, { type: 'button', variant: 'outline', disabled: inert, onClick: onCancel }, t('取消')),
              h(Button, { type: 'button', variant: 'primary', disabled: blocked || !directory || draft !== path, onClick: () => onPicked(path) }, t('打开'))))),
        creating && h(NewFolder, { path, onClose: () => setCreating(false), onCreated: target => { setCreating(false); void navigation.visit(target) } }))
    }
    function Flow(props) { return props.open ? h(Browser, props) : null }
    const off = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'].map(name =>
      ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -10 }, Flow)))
    return () => { off.reverse().forEach(dispose => dispose()); style.remove() }
  }
  return { inject: ['slots', 'uiWorkspace', 'remote'], async apply(ctx) {
    if (window.__TAURI__?.core?.invoke) return
    const offRemote = await ctx.remote.$mount(contribution)
    const fiber = ctx.inject(['remote.desktopDirectoryPicker'], install)
    return async () => { await fiber.dispose(); await offRemote() }
  } }
} })
