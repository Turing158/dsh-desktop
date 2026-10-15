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
  function FileIcon() {
    return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
      h('path', { d: 'M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 13h8M8 17h8' }))
  }
  function ErrorPlaceholder({ error, reading, busy, onRetry, onChoose }) {
    const denied = /\b(EACCES|EPERM)\b|permission denied|access (?:is )?denied|operation not permitted|权限不足|拒绝访问/i.test(error)
    const missing = /\bENOENT\b|no such file or directory/i.test(error)
    const title = denied ? '访问权限不足' : missing ? (reading ? '附件不存在或已被移动' : '文件夹不存在或已被移动')
      : reading ? '无法读取附件' : '无法加载此位置'
    return h('div', { className: 'dshDirectory__placeholder' },
      h('div', { className: 'dshDirectory__placeholderCopy', role: 'alert' },
        h('div', { className: 'dshDirectory__placeholderIcon', 'aria-hidden': true }, h(Folder, { size: 32 })),
        h('h3', { className: 'dshDirectory__placeholderTitle' }, t(title)),
        h('p', { className: 'dshDirectory__placeholderHint' }, t(denied ? '请确认访问权限，或选择其他位置。'
          : reading ? '请重新选择文件，或稍后重试。' : '请选择其他位置，或稍后重试。')),
        h('div', { className: 'dshDirectory__reason' },
          h('p', { className: 'dshDirectory__reasonLabel' }, t('错误原因')),
          h('p', { className: 'dshDirectory__error' }, error))),
      h('div', { className: 'dshDirectory__placeholderActions' },
        h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: onRetry }, t('重试')),
        onChoose && h(Button, { type: 'button', variant: 'ghost', disabled: busy, onClick: onChoose }, t('重新选择'))))
  }
  function registerFlow(ctx, Flow) {
    const off = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'].map(name =>
      ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -10 }, Flow)))
    return () => { off.reverse().forEach(dispose => dispose()) }
  }
  // The host switches to browse when remote access is enabled. The desktop
  // WebView must still use its own OS chooser regardless of that host capability.
  function NativeFlow(props) {
    const owner = React.useRef(props), request = React.useRef(null), alive = React.useRef(true)
    owner.current = props
    React.useEffect(() => {
      alive.current = true
      return () => { alive.current = false }
    }, [])
    React.useEffect(() => {
      if (!props.open) { request.current = null; return }
      if (props.busy || request.current) return
      const current = {}; request.current = current
      const active = () => alive.current && owner.current.open && request.current === current
      // One chooser per open, including effect replay and adoption re-renders.
      Promise.resolve().then(() => window.__TAURI__.core.invoke('pick_workspace_directory')).then(path => {
        if (!active()) return
        if (path === null) owner.current.onCancel()
        else owner.current.onPicked(path)
      }, error => {
        if (active()) owner.current.onError(error?.message || String(error))
      })
    }, [props.open, props.busy])
    return null
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
    const remoteValue = async promise => {
      const result = await promise
      if (!result.ok) throw Error(result.error.message)
      return result.value
    }
    function Browser({ busy, onPicked, onCancel, files = false, onLocal }) {
      useLocale(React)
      const navigation = React.useMemo(() => createNavigation({
        listDirectory: (path, signal) => files
          ? remoteValue(ctx.remote.desktopDirectoryPicker.files(path, signal)) : ctx.uiWorkspace.listDirectory(path, signal),
        listRoots: async signal => {
          const result = await ctx.remote.desktopDirectoryPicker.roots(signal)
          if (!result.ok) throw Error(result.error.message)
          return result.value
        },
      }), [])
      const state = React.useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
      const [draft, setDraft] = React.useState(''), [hidden, setHidden] = React.useState(false), [creating, setCreating] = React.useState(false)
      const [selected, setSelected] = React.useState([]), [picking, setPicking] = React.useState(false), [pickError, setPickError] = React.useState(null)
      const alive = React.useRef(true)
      React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
      const list = React.useRef(null), crumbs = React.useRef(null), suggestions = React.useId()
      React.useEffect(() => { void navigation.visit(); return () => navigation.dispose() }, [navigation])
      React.useEffect(() => {
        if (state.loading) { setSelected([]); setPickError(null) }
      }, [state.loading])
      const directory = state.location?.kind === 'directory', path = directory ? state.location.path : ''
      React.useEffect(() => {
        setDraft(path)
        setSelected([]); setPickError(null)
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
      const inert = busy || creating, blocked = inert || picking || state.loading
      const error = state.loading ? null : state.error || pickError
      React.useEffect(() => {
        if (error && document.activeElement === document.body) list.current?.focus({ preventScroll: true })
      }, [error])
      const entries = (state.location?.entries || []).filter(entry => hidden || !entry.hidden)
      const title = files ? t('选择附件') : t('选择工作区目录')
      const pick = async () => {
        if (blocked || state.error || (files && !selected.length)) return
        setPicking(true); setPickError(null)
        try { await onPicked(files ? selected : path) }
        catch (error) { if (alive.current) setPickError(error?.message || String(error)) }
        finally { if (alive.current) setPicking(false) }
      }
      const toggle = target => setSelected(current => current.includes(target) ? current.filter(path => path !== target) : [...current, target])
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
        h(Modal, { open: true, headless: true, title, onClose: () => { if (!inert) onCancel() },
          className: 'dshDirectory', onKeyDownCapture: keydown },
          h('header', { className: 'dshDirectory__header' },
            h('h2', null, title),
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
                  'aria-label': t('文件夹路径'), placeholder: t('输入完整路径'), disabled: inert || picking, list: suggestions, spellCheck: false,
                  onKeyDown: event => { if (event.key === 'Escape' && draft !== path) { event.preventDefault(); event.stopPropagation(); setDraft(path) } } }),
                h('datalist', { id: suggestions }, entries.filter(entry => !files || entry.directory || !directory).map(entry => h('option', { key: entry.path, value: entry.path }))),
                h(Button, { type: 'submit', variant: 'outline', disabled: blocked || !draft.trim() }, t('转到')))),
            h('nav', { ref: crumbs, className: 'dshDirectory__crumbs', 'aria-label': t('当前位置') },
              crumb(t('此电脑'), ROOTS, state.location?.kind === 'roots'),
              ...(state.location?.crumbs || []).map((entry, index, crumbs) => h(React.Fragment, { key: entry.path },
                h('span', { 'aria-hidden': true }, '›'), crumb(entry.name, entry.path, index === crumbs.length - 1))))),
          h('div', { ref: list, tabIndex: -1, role: 'region', 'aria-label': t('文件夹导航'), className: 'dshDirectory__list', 'aria-busy': state.loading, 'data-location': state.location?.path },
            error ? h(ErrorPlaceholder, { error, reading: !state.error && !!pickError, busy: blocked,
              onRetry: state.error ? navigation.retry : pick,
              onChoose: !state.error && pickError ? () => setPickError(null) : undefined }) : h(React.Fragment, null,
            h('div', { className: 'dshDirectory__status', role: 'status' }, state.loading ? t('加载中…')
              : state.location && !entries.length ? (directory ? t(files ? '没有可显示的文件' : '没有可显示的文件夹') : t('没有可用的盘符')) : null),
            entries.map(entry => h('button', { key: entry.path, type: 'button', className: 'dshDirectory__row',
              disabled: blocked, title: entry.path, 'aria-pressed': files && directory && !entry.directory ? selected.includes(entry.path) : undefined,
              onClick: () => files && directory && !entry.directory ? toggle(entry.path) : navigation.visit(entry.path) },
              h(!directory ? Drive : files && !entry.directory ? FileIcon : Folder, { size: 18 }), h('span', null, entry.name),
              files && directory && !entry.directory ? h('span', { className: 'dshDirectory__check', 'aria-hidden': true }, selected.includes(entry.path) ? '✓' : '') : h(Forward, { size: 14 }))),
            state.location?.truncated && h('p', { className: 'dshDirectory__status' }, t(files ? '文件过多，仅显示开头部分。' : '文件夹过多，仅显示开头部分。')))),
          h('footer', { className: 'dshDirectory__footer' },
            files ? h(Button, { type: 'button', variant: 'outline', disabled: blocked, onClick: onLocal }, t('从此设备选择'))
              : h(Button, { type: 'button', variant: 'outline', disabled: blocked || !!error || !directory, onClick: () => setCreating(true) }, t('新建文件夹')),
            h('label', { className: 'dshDirectory__hidden' }, h('input', { type: 'checkbox', checked: hidden, disabled: inert || picking || !!error,
              onChange: event => { setHidden(event.target.checked); setSelected([]) } }), t('显示隐藏文件')),
            files && h('span', { className: 'dshDirectory__status', role: 'status' }, t('已选择 {count} 个文件', { count: selected.length })),
            h('div', { className: 'dshDirectory__actions' },
              h(Button, { type: 'button', variant: 'outline', disabled: inert, onClick: onCancel }, t('取消')),
              h(Button, { type: 'button', variant: 'primary', disabled: blocked || !!error || !directory || draft !== path || (files && !selected.length), onClick: pick },
                picking && files ? t('读取中…') : t(files ? '添加附件' : '打开'))))),
        creating && h(NewFolder, { path, onClose: () => setCreating(false), onCreated: target => { setCreating(false); void navigation.visit(target) } }))
    }
    function Flow(props) { return props.open ? h(Browser, props) : null }
    function AttachmentFlow({ sessionId }) {
      const anchor = React.useRef(null), input = React.useRef(null), request = React.useRef(null), local = React.useRef(false)
      const [open, setOpen] = React.useState(false)
      const cancel = () => { request.current?.abort(); request.current = null; setOpen(false) }
      React.useEffect(() => {
        // Intercept only this composer's native input. Its change handler retains
        // the upstream session guards, image limits, draft creation and uploads.
        const element = anchor.current?.closest('[data-composer-card]')?.querySelector('input[type="file"]')
        input.current = element
        const show = event => {
          if (local.current || element.disabled) return
          event.preventDefault(); event.stopPropagation(); setOpen(true)
        }
        element?.addEventListener('click', show)
        return () => { element?.removeEventListener('click', show); request.current?.abort(); request.current = null; input.current = null }
      }, [])
      const pick = async paths => {
        const controller = new AbortController(); request.current = controller
        const element = input.current, transfer = new DataTransfer()
        for (const path of paths) {
          const file = await remoteValue(ctx.remote.desktopDirectoryPicker.readFile(path, controller.signal))
          controller.signal.throwIfAborted()
          const binary = atob(file.data), bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
          transfer.items.add(new File([bytes], file.name, { type: file.type, lastModified: file.lastModified }))
        }
        controller.signal.throwIfAborted()
        if (!element?.isConnected || element !== input.current || element.disabled) return
        element.files = transfer.files
        element.dispatchEvent(new Event('change', { bubbles: true }))
        cancel()
      }
      return h(React.Fragment, null, h('span', { ref: anchor, hidden: true, 'data-dsh-attachment-picker': sessionId }),
        open && h(Browser, { files: true, onPicked: pick, onCancel: cancel, onLocal: () => {
          cancel(); local.current = true
          try { input.current?.click() } finally { local.current = false }
        } }))
    }
    const off = registerFlow(ctx, Flow)
    const offAttachments = ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({ name: 'conversation.input.overlay', id: ID },
      props => h(AttachmentFlow, { key: props.sessionId, sessionId: props.sessionId })))
    return () => { offAttachments(); off(); style.remove() }
  }
  return { inject: ['slots', 'uiWorkspace', 'remote'], async apply(ctx) {
    if (window.__TAURI__?.core?.invoke) return registerFlow(ctx, NativeFlow)
    const offRemote = await ctx.remote.$mount(contribution)
    const fiber = ctx.inject(['remote.desktopDirectoryPicker'], install)
    return async () => { await fiber.dispose(); await offRemote() }
  } }
} })
