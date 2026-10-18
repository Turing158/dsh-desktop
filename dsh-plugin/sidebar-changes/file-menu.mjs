import { t, useLocale } from '../i18n/api.mjs'
import { absoluteFilePath, fileAddress, changeAddress } from './file-resource.mjs'

export function createFileMenu(React, primitives) {
  const h = React.createElement, { Menu, FileTypeIcon, IconFolderOpenOutlineRegular: Folder,
    IconCompareSplitOutlineRegular: Compare, IconChevronDownOutlineRegular: Down, IconChevronUpOutlineRegular: Up } = primitives
  const icon = Icon => Icon ? h(Icon, { size: 16 }) : undefined
  const fileIcon = h(FileTypeIcon, { kind: 'other', size: 16 })
  return function FileMenu({ ctx, tab, sessionId, source, entry, workspaceRoot, point, expanded, toggle, dismiss, onError }) {
    useLocale(React)
    const path = absoluteFilePath(entry, workspaceRoot)
    const [apps, setApps] = React.useState(null), [available, setAvailable] = React.useState(false), [failed, setFailed] = React.useState(false)
    React.useEffect(() => {
      const own = new AbortController(), signal = AbortSignal.any([own.signal, tab.signal])
      setApps(null); setAvailable(false); setFailed(false)
      void (async () => {
        try {
          const desktop = await ctx.remote.session.canOpenWorkspacePath()
          if (signal.aborted) return
          if (!desktop.ok || !desktop.value || !path) { setApps([]); return }
          setAvailable(true)
          if (entry.status === 'deleted') { setApps([]); return }
          const result = await ctx.remote.session.workspacePathApplications({ path }, signal)
          if (signal.aborted) return
          if (!result.ok) throw result.error
          setApps(result.value)
        } catch {
          if (!signal.aborted) { setApps([]); setFailed(true) }
        }
      })()
      return () => own.abort()
    }, [ctx, path, entry.status, tab.signal])
    // Menu's portal measures before it becomes visible; focus after placement.
    React.useEffect(() => {
      const frame = requestAnimationFrame(() => document.querySelector('.dshChanges__fileMenu button:not(:disabled)')?.focus({ preventScroll: true }))
      return () => cancelAnimationFrame(frame)
    }, [])
    const nativeOpen = async id => {
      try {
        const reveal = id === 'reveal'
        const target = reveal && entry.status === 'deleted'
          ? entry.directoryPath || path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) : path
        const result = await ctx.remote.session.openWorkspacePath(reveal ? { path: target, action: 'reveal' } : { path, application: id.slice(4) })
        if (!result.ok) throw result.error
      } catch (error) { onError(t('无法打开文件或文件夹，请检查路径和应用是否可用。'), error) }
    }
    const select = id => {
      dismiss()
      if (tab.signal.aborted) return
      if (id === 'file') tab.actions.openResource(fileAddress(sessionId, path))
      else if (id === 'diff') tab.actions.openResource(changeAddress(sessionId, source, entry))
      else if (id === 'toggle') toggle(entry.fileId)
      else void nativeOpen(id)
    }
    const applications = apps?.map(app => ({ id: 'app:' + app.id,
      label: app.default ? t('{0}（默认）', [app.name]) : app.name,
      icon: app.icon ? h('img', { src: app.icon, alt: '', width: 16, height: 16, className: 'dshChanges__appIcon' }) : fileIcon,
    })) || []
    return h(Menu, { open: true, anchor: null, portal: true, compact: true, autoFocus: true,
      listClassName: 'dshChanges__fileMenu', onClose: dismiss, onSelect: select,
      getAnchorRect: () => ({ left: point.x, right: point.x, top: point.y, bottom: point.y }),
      items: [
        { id: 'file', label: t('打开文件'), icon: fileIcon, disabled: !path || entry.status === 'deleted' },
        { id: 'diff', label: t('查看更改'), icon: icon(Compare) },
        { id: 'toggle', label: expanded ? t('收起更改') : t('展开更改'), icon: icon(expanded ? Up : Down) },
        { type: 'separator', id: 'native' },
        { id: 'open', label: t('打开'), icon: icon(Folder), disabled: !path || entry.status === 'deleted',
          submenu: applications.length ? applications : [{ id: 'unavailable', disabled: true,
            label: apps === null ? t('正在加载…') : failed ? t('应用列表读取失败') : t('没有可用的应用') }] },
        { id: 'reveal', label: t('在资源管理器中打开'), icon: icon(Folder), disabled: !path || !available },
      ] })
  }
}
