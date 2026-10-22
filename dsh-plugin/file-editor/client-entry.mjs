import { t, useLocale } from '../i18n/api.mjs'
import { contribution, ID, PLAIN_ID, CODE_ID, HTML_ID, parseFile } from './protocol.mjs'
import { createDocuments } from './documents.mjs'
import { mountEditor } from './editor.mjs'
import { createStateProvider } from './state-provider.mjs'
import { createCloseGuard } from './close-guard.mjs'
import { bindReloadGuard } from './reload-guard.mjs'
import { fileEditorObservation } from '../compatibility/selectors.mjs'
import css from './style.css'

window.__ModuleLoader__.load({ id: ID, factory(require) {
  const React = require('react'), h = React.createElement
  const { FileTypeIcon, Modal, Button } = require('@deepseek-ai/dsh-client-ui-primitives')
  function install(ctx) {
    const capability = fileEditorObservation(ctx)
    window.__DSH_CAPABILITIES__?.report(capability)
    if (capability.availability === 'unavailable') return () => {}
    const offCapability = window.__DSH_CAPABILITIES__?.watch('file-editor', () => fileEditorObservation(ctx))
    const docs = createDocuments(ctx.remote.desktopFileEditor)
    const closeGuard = createCloseGuard(ctx.sidebarRight, docs)
    const style = document.createElement('style'); style.textContent = css; document.head.append(style)
    const useDoc = address => {
      const doc = docs.get(address)
      return [doc, React.useSyncExternalStore(doc.subscribe, doc.getSnapshot, doc.getSnapshot)]
    }
    function useFileTab(props, nativePreview = false) {
      const { tab } = props.useTabInfo(), [doc, state] = useDoc(props.resourceAddress)
      const section = React.useRef(null)
      // A tab can display a file belonging to another session's workspace.
      const sessionId = React.useMemo(() => ctx.sidebarRight.openTabs.getSnapshot()
        .find(value => value.tabId === tab.id)?.sessionId ?? ctx.sidebarRight.mounted.getSnapshot(), [tab.actions])
      React.useLayoutEffect(() => {
        const preview = section.current?.closest('[data-textpreview-url]')
        if (!preview) return
        const occurrence = ctx.sidebarRight.tabDomain.occurrence(sessionId, tab)
        return bindReloadGuard(occurrence, tab.actions, preview,
          commit => nativePreview && !doc.dirty() && !doc.getSnapshot().saving
            ? commit() : closeGuard.reload(sessionId, tab, doc, commit))
      }, [doc, tab.actions, sessionId, nativePreview])
      const viewer = React.useMemo(() => {
        const handle = ctx.slots.entriesOfSlot('sidebar.right.pane.tab')
          .find(entry => entry.options.key === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview')?.store
        const scope = ctx.sessions.scope(sessionId)
        return handle && scope ? ctx.slots.resolveStore(handle, { key: sessionId, ctx: scope }) : null
      }, [sessionId])
      return { tab, doc, state, section, sessionId, viewer }
    }
    function Editor(props) {
      useLocale(React)
      const { tab, doc, state, section, sessionId, viewer } = useFileTab(props)
      const host = React.useRef(null), editor = React.useRef(null)
      const [cursor, setCursor] = React.useState({ line: 1, column: 1 })
      const content = props.content
      React.useEffect(() => { void doc.load() }, [doc])
      // Native reloads can remount the renderer; a dirty draft always wins.
      React.useEffect(() => {
        void (async () => {
          if (!doc.dirty() && !doc.getSnapshot().saving) await doc.load(true)
          const current = doc.getSnapshot()
          if (content.kind === 'renderer') {
            if (current.version) content.loaded(current.version)
            else content.failed()
          }
        })()
      }, [doc, content.kind === 'renderer' ? content.revision : content.text])
      const ready = state.version !== null
      React.useLayoutEffect(() => {
        if (!ready || !host.current) return
        editor.current = mountEditor(host.current, doc, { mode: props.mode, wrap: props.wrap, onCursor: setCursor,
          scrollportRef: props.scrollportRef, line: tab.navigation.params?.line })
        return () => { editor.current?.destroy(); editor.current = null }
      }, [doc, ready, props.mode])
      React.useEffect(() => { editor.current?.wrap(props.wrap) }, [props.wrap])
      React.useEffect(() => { if (tab.visible) editor.current?.measure() }, [tab.visible])
      const reload = () => closeGuard.reload(sessionId, tab, doc)
      const canPreview = /\.html?$/i.test(doc.file.path) && viewer?.actions.selected
        && ctx.slots.entriesOfSlot('sidebar.right.tab.document').some(entry => entry.options.key === HTML_ID)
      return h('section', { ref: section, className: 'dshFileEditor', 'data-dsh-file-editor': props.resourceAddress, 'data-editor-mode': props.mode, 'aria-label': t('文件编辑'), 'aria-busy': state.loading || state.saving },
        canPreview && h('div', { className: 'dshFileEditor__toolbar' },
          h('button', { type: 'button', className: 'dshFileEditor__button', disabled: !ready || state.loading,
            onClick: () => viewer.actions.selected(tab.id, HTML_ID) }, t('预览 HTML'))),
        state.error && h('div', { className: 'dshFileEditor__error', role: 'alert' }, state.error,
          h('button', { type: 'button', className: 'dshFileEditor__button', onClick: reload, disabled: state.loading || state.saving }, ready ? t('重新读取') : t('重试'))),
        ready ? h('div', { ref: host, className: 'dshFileEditor__host' }) : h('div', { className: 'dshFileEditor__empty' }, state.loading ? t('正在读取完整文件…') : t('文件内容未载入。')),
        ready && h('div', { className: 'dshFileEditor__footer' }, h('span', null, t("第 {0} 行，第 {1} 列", [cursor.line, cursor.column])),
          h('span', null, state.bom ? 'UTF-8 BOM' : 'UTF-8'), h('span', null, state.eol === '\r\n' ? 'CRLF' : state.eol === '\r' ? 'CR' : 'LF')))
    }
    function HtmlPreview({ Native, ...props }) {
      useLocale(React)
      const { tab, doc, state, section, sessionId } = useFileTab(props, true)
      // Keep the host's HTML renderer, resource readers and sandbox policy.
      // Once edited, retain the shared text after saving, including when the
      // native viewer's automatic refresh is off. Reconcile later disk reads.
      React.useEffect(() => {
        const current = doc.getSnapshot()
        if (current.version !== null && !doc.dirty() && !current.saving) void doc.load(true)
      }, [doc, props.content.kind === 'bytes' ? props.content.data : props.content.revision])
      const draft = doc.dirty() ? state.text : null
      const text = state.version !== null && (!state.error || draft !== null) ? state.text : null
      const content = React.useMemo(() => text === null ? props.content
        : { kind: 'bytes', data: new TextEncoder().encode(text) }, [text, props.content])
      return h('section', { ref: section, className: 'dshFileEditor dshFileEditor--preview', 'data-dsh-file-editor': props.resourceAddress,
        'data-editor-mode': 'html', 'aria-label': t('HTML 预览'), 'aria-busy': state.loading || state.saving },
        state.error && h('div', { className: 'dshFileEditor__error', role: 'alert' }, state.error,
          h('button', { type: 'button', className: 'dshFileEditor__button', disabled: state.loading || state.saving,
            onClick: () => closeGuard.reload(sessionId, tab, doc) }, t('重新读取'))),
        h('div', { className: 'dshFileEditor__preview' }, h(Native, { ...props, content })))
    }
    function Title(props) {
      const { tab } = props.useTabInfo(), file = parseFile(tab.contentId)
      if (!file) return tab.title
      return h(FileTitle, { address: tab.contentId, path: file.path })
    }
    function FileTitle({ address, path }) {
      useLocale(React)
      const [doc] = useDoc(address)
      return h(React.Fragment, null, h(FileTypeIcon, { path, size: 16 }), path.split(/[\\/]/).at(-1),
        doc.dirty() && h('span', { className: 'dshFileEditor__dirty', 'aria-label': t('未保存'), title: t('未保存') }, '●'))
    }
    function CloseDialog() {
      useLocale(React)
      const state = React.useSyncExternalStore(closeGuard.subscribe, closeGuard.getSnapshot, closeGuard.getSnapshot)
      return state.request ? h(UnsavedDialog, { state }) : null
    }
    function UnsavedDialog({ state }) {
      useLocale(React)
      const { doc, kind } = state.request
      const reloading = kind === 'reload'
      const file = React.useSyncExternalStore(doc.subscribe, doc.getSnapshot, doc.getSnapshot)
      const busy = state.busy || file.saving, error = state.error || file.error
      const descriptionId = React.useId()
      return h(Modal, { open: true, title: t('保存更改？'), closeLabel: reloading ? t('取消重新读取') : t('取消关闭'), onClose: closeGuard.cancel,
        className: 'dshFileEditor__closeDialog', contentClassName: 'dshFileEditor__closeContent',
        footer: h('div', { className: 'dshFileEditor__closeActions' },
          h(Button, { variant: 'outline', 'data-modal-autofocus': '', onClick: closeGuard.cancel }, t('取消')),
          h(Button, { variant: 'outline', disabled: busy, onClick: closeGuard.discard }, t('不保存')),
          h(Button, { variant: 'primary', disabled: busy || file.loading || file.conflict, onClick: closeGuard.save }, busy ? (file.loading ? t('正在读取…') : t('正在保存…')) : reloading ? t('保存后重新读取') : t('保存并关闭'))),
      }, h('div', { className: 'dshFileEditor__closeBody', 'aria-busy': busy, ref: node => {
        node?.closest('[role="dialog"]')?.setAttribute('aria-describedby', descriptionId)
      } },
        h('p', { id: descriptionId }, '“', h('span', { className: 'dshFileEditor__closeName', title: doc.file.path }, doc.file.path.split(/[\\/]/).at(-1)), t('”有未保存的更改。')),
        h('p', { className: 'dshFileEditor__closeHint' }, (reloading ? t('重新读取前是否保存？') : t('关闭前是否保存？')) + t('选择“不保存”将丢失这些更改。')),
        error && h('p', { className: 'dshFileEditor__closeError', role: 'alert' }, error)))
    }
    const off = [() => closeGuard.dispose()]
    off.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'desktop-file-editor-close' }, CloseDialog)))
    // Slot shadowing is a public contract. The native plain-text fallback also
    // covers extensionless/unknown text files and already-open text tabs. Keep
    // the native viewer choices; editing is available in both text modes.
    for (const [key, mode] of [[PLAIN_ID, 'plain'], [CODE_ID, 'code']]) off.push(ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
      name: 'sidebar.right.tab.document', key, priority: -10,
    }, props => h(Editor, { ...props, mode }))))
    off.push(ctx.slots.inject('sidebar.right.tab.document', () => {
      let remove, registering = false
      // The owner declares the slot before it registers its HTML body.
      const attach = () => {
        if (remove || registering) return
        const native = ctx.slots.entriesOfSlot('sidebar.right.tab.document').find(entry => entry.options.key === HTML_ID)
        if (!native) return
        registering = true
        try {
          remove = ctx.slots.register({ name: 'sidebar.right.tab.document', key: HTML_ID, priority: -10,
            inject: native.inject, locale: native.locale, store: native.store,
          }, props => h(HtmlPreview, { ...props, Native: native.component }))
        } finally { registering = false }
      }
      const unsubscribe = ctx.slots.subscribe('sidebar.right.tab.document', attach)
      attach()
      return () => { unsubscribe(); remove?.() }
    }))
    off.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title', key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', priority: -10,
    }, Title)))
    const beforeUnload = event => { if (docs.unsettled()) { event.preventDefault(); event.returnValue = '' } }
    const keydown = event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return
      const root = event.target.closest?.('[data-dsh-file-editor]')
      if (!root) return
      event.preventDefault(); event.stopImmediatePropagation()
      void docs.get(root.getAttribute('data-dsh-file-editor')).save()
    }
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('keydown', keydown, true)
    const provider = createStateProvider(ctx, docs), capture = provider.capture
    provider.capture = () => {
      if (closeGuard.getSnapshot().request) throw Error(t('请先处理未保存文件的保存确认提示，再重启。'))
      return capture()
    }
    off.push(window.__DSH_UI_STATE__?.registerProvider('desktop-file-editor', provider))
    return () => { offCapability?.(); off.reverse().forEach(fn => fn?.()); style.remove();
      window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', keydown, true) }
  }
  return { inject: ['slots', 'sidebarRight', 'sessions', 'remote'], async apply(ctx) {
    const offRemote = await ctx.remote.$mount(contribution)
    const fiber = ctx.inject(['remote.desktopFileEditor'], install)
    return async () => { await fiber.dispose(); await offRemote() }
  } }
} })
