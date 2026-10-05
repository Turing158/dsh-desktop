import { t, useLocale } from '../i18n/api.mjs'
const restarting = new WeakMap()

/** A restart replaces the host process only after its previous close succeeds. */
export function restartTerminalTarget(target, shellPath) {
  if (restarting.has(target.model)) return restarting.get(target.model)
  const pending = (async () => {
    if (!target.exists()) return
    const path = shellPath ?? target.model.state.getSnapshot().info?.shell?.path ?? target.shellPath
    await target.model.close()
    if (target.exists()) target.replace(path)
  })().finally(() => restarting.delete(target.model))
  restarting.set(target.model, pending)
  return pending
}

export function sidebarTerminalTarget(ctx, sessionId, tab) {
  if (tab.kind !== 'terminal') return null
  const occurrence = ctx.sidebarRight.tabDomain.occurrence(sessionId, tab)
  const navigation = occurrence.navigation.getSnapshot()
  const params = navigation.params
  return {
    sessionId,
    shellPath: params?.shellPath,
    model: ctx.webTerminals.view(sessionId, tab.id, navigation.address, params?.terminalId, params?.shellPath),
    exists: () => !occurrence.signal.aborted && occurrence.navigation.getSnapshot() === navigation,
    replace: shellPath => occurrence.tabActions.openTab('terminal', { replaceTab: true, params: { shellPath } }),
  }
}

/** Shared rows, nested inside the owning menu so its outside-click handling works. */
export function createTerminalTabMenuRows(React, primitives, service) {
  const h = React.createElement
  const { MenuItemButton, MenuSurface } = primitives
  return function TerminalTabMenuRows({ target, dismiss, separatorBefore = false }) {
      useLocale(React)
    const [shells, setShells] = React.useState(null)
    const [open, setOpen] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const root = React.useRef(null), trigger = React.useRef(null), submenu = React.useRef(null)
    const focusRequested = React.useRef(false)
    const current = React.useRef(target)
    current.current = target
    React.useEffect(() => {
      const request = new AbortController()
      setShells(null)
      service.launchShells(target.sessionId, request.signal).then(result => {
        if (!request.signal.aborted) setShells(result.shells)
      }).catch(() => { if (!request.signal.aborted) setShells([]) })
      return () => request.abort()
    }, [target.sessionId])
    // MenuItemButton owns the app's row styling but does not forward ARIA props.
    React.useLayoutEffect(() => {
      const button = trigger.current?.querySelector('button')
      button?.setAttribute('aria-haspopup', 'menu')
      button?.setAttribute('aria-expanded', String(open))
    }, [open])
    React.useLayoutEffect(() => {
      if (!open) return
      const place = () => {
        const anchor = trigger.current?.getBoundingClientRect(), node = submenu.current
        if (!anchor || !node) return
        const width = node.offsetWidth, height = node.offsetHeight
        const x = anchor.right + width + 4 <= window.innerWidth - 8 ? anchor.right + 4 : anchor.left - width - 4
        node.style.left = Math.max(8, Math.min(x, window.innerWidth - width - 8)) + 'px'
        node.style.top = Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8)) + 'px'
      }
      place()
      if (focusRequested.current) {
        const button = submenu.current?.querySelector('button:not(:disabled)')
        if (button) { focusRequested.current = false; button.focus() }
      }
      window.addEventListener('resize', place)
      window.addEventListener('scroll', place, true)
      const menu = root.current?.closest('[role="menu"]')
      const leaveRow = event => { if (!trigger.current?.contains(event.target)) setOpen(false) }
      menu?.addEventListener('mouseover', leaveRow)
      menu?.addEventListener('focusin', leaveRow)
      return () => {
        window.removeEventListener('resize', place)
        window.removeEventListener('scroll', place, true)
        menu?.removeEventListener('mouseover', leaveRow)
        menu?.removeEventListener('focusin', leaveRow)
      }
    }, [open, shells])
    async function run(shellPath) {
      if (busy) return
      setBusy(true); setError(''); setOpen(false)
      try { await restartTerminalTarget(current.current, shellPath); dismiss() }
      catch (error) { setError(t('重启失败：') + (error?.message || String(error))) }
      finally { setBusy(false) }
    }
    const focusShell = () => {
      focusRequested.current = true
      const button = submenu.current?.querySelector('button:not(:disabled)')
      if (button) { focusRequested.current = false; button.focus() }
    }
    const shellKey = event => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.querySelector('button')?.focus()
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        const buttons = [...submenu.current.querySelectorAll('button:not(:disabled)')]
        const index = buttons.indexOf(document.activeElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }
    const selected = target.model.state.getSnapshot().info?.shell?.path ?? target.shellPath
    return h('div', { ref: root, className: 'dshTerminalTabMenu', 'data-dsh-terminal-tab-menu': true },
      h(MenuItemButton, { separatorBefore, disabled: busy, onSelect: () => run() }, busy ? t('正在重启…') : t('重启')),
      h('div', {
        ref: trigger, onMouseEnter: () => { if (!busy) setOpen(true) },
        onKeyDown: event => {
          if (event.target === trigger.current?.querySelector('button') && event.key === 'ArrowRight') {
            event.preventDefault(); event.stopPropagation(); setOpen(true); focusShell()
          } else if (event.target === trigger.current?.querySelector('button') && event.key === 'ArrowLeft' && open) {
            event.preventDefault(); event.stopPropagation(); focusRequested.current = false; setOpen(false)
          }
        },
      },
      h(MenuItemButton, { disabled: busy, onSelect: () => { setOpen(true); focusShell() } }, t('切换...')),
      open && h(MenuSurface, {
        ref: submenu, role: 'menu', 'aria-label': t('终端类型'), className: 'dshTerminalTabMenu__submenu', onKeyDown: shellKey,
      }, shells?.length ? shells.map(shell => h(MenuItemButton, { key: shell.path, onSelect: () => run(shell.path) },
        h('span', { className: 'dshTerminalTabMenu__switch' }, shell.name, selected === shell.path && h('span', { 'aria-label': t('当前终端类型') }, '✓'))))
        : h(MenuItemButton, { disabled: true, onSelect() {} }, shells === null ? t('正在加载…') : t('没有可用的终端类型')))),
      error && h('div', { role: 'alert', className: 'dshTerminalTabMenu__error' }, error))
  }
}

export function installSidebarTerminalMenu(React, ctx, Rows) {
  function SidebarMenu({ tab, dismiss, terminalTarget }) {
      useLocale(React)
    if (tab.kind !== 'terminal') return null
    return React.createElement(Rows, { target: terminalTarget(tab), dismiss, separatorBefore: true })
  }
  return ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register({
    name: 'sidebar.right.tab.menu.item', id: 'desktop-terminal-actions',
    inject: sessionId => ({ terminalTarget: tab => sidebarTerminalTarget(ctx, sessionId, tab) }),
  }, SidebarMenu))
}
