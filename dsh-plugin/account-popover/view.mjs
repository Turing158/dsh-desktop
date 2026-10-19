import { balanceRows, formatBalance, platformHref } from './model.mjs'
import { createLogoutIcon } from './icons.mjs'
import { createPopoverMotion } from './motion.mjs'

/** Keep the native launcher mounted: it still owns login, expiry and grant notices. */
export function createAccountLauncher(React, ReactDOM, ui, Original) {
  const h = React.createElement
  const LogoutIcon = createLogoutIcon(React)
  function AccountLauncher(props) {
    if (typeof props.useAccount !== 'function' || typeof props.contactUs !== 'function'
      || typeof props.signOut !== 'function' || typeof props.hasRunningAccountTasks !== 'function') return h(Original, props)
    return h(EnhancedLauncher, props)
  }
  function EnhancedLauncher(props) {
    const { t } = props
    const account = props.useAccount(value => value)
    const signedIn = account.view?.status === 'credential-stored'
    const native = React.useRef(null), panel = React.useRef(null), releasePage = React.useRef(null)
    const alive = React.useRef(true), currentSignedIn = React.useRef(signedIn), pending = React.useRef(false)
    currentSignedIn.current = signedIn
    const [open, setOpen] = React.useState(false), [position, setPosition] = React.useState(null)
    const [present, setPresent] = React.useState(false)
    const motion = React.useRef(null)
    const [checking, setChecking] = React.useState(false), [impact, setImpact] = React.useState(undefined)
    const [busy, setBusy] = React.useState(false), [failed, setFailed] = React.useState(false)
    const [actionFailed, setActionFailed] = React.useState(false)
    const id = React.useId()
    const getTrigger = () => native.current?.querySelector('button[aria-haspopup]')
    const close = (restore = false) => {
      setOpen(false)
      if (restore) getTrigger()?.focus({ preventScroll: true })
    }
    React.useLayoutEffect(() => {
      motion.current = createPopoverMotion(document, () => setPresent(false))
      return () => { motion.current.dispose(); motion.current = null }
    }, [])
    React.useEffect(() => {
      alive.current = true
      return () => { alive.current = false; releasePage.current?.(); releasePage.current = null }
    }, [])
    React.useEffect(() => {
      if (signedIn) return
      pending.current = false
      setOpen(false); setPresent(false); setImpact(undefined); setActionFailed(false); setChecking(false); setBusy(false)
      releasePage.current?.(); releasePage.current = null
    }, [signedIn])
    React.useEffect(() => { if (props.settingsOpen) setOpen(false) }, [props.settingsOpen])
    // The native button remains the actual hit target, avatar and notice anchor.
    // Restore every attribute on unmount or when its signed-in state changes.
    React.useLayoutEffect(() => {
      if (!signedIn) return
      const button = getTrigger()
      if (!button) return
      const attributes = { 'aria-haspopup': 'dialog', 'aria-expanded': String(open), 'aria-controls': id,
        'aria-label': t('nav'), 'data-dsh-account-trigger': '' }
      const before = Object.keys(attributes).map(key => [key, button.getAttribute(key)])
      Object.entries(attributes).forEach(([key, value]) => button.setAttribute(key, value))
      return () => before.forEach(([key, value]) => value === null ? button.removeAttribute(key) : button.setAttribute(key, value))
    })
    React.useLayoutEffect(() => {
      if (!open || !signedIn) return
      const anchor = getTrigger(), surface = panel.current
      if (!anchor || !surface) return
      function place() {
        const r = anchor.getBoundingClientRect(), p = surface.getBoundingClientRect()
        const viewport = window.visualViewport
        const leftEdge = (viewport?.offsetLeft || 0) + 8, topEdge = (viewport?.offsetTop || 0) + 8
        const rightEdge = leftEdge + (viewport?.width || window.innerWidth) - 16
        const bottomEdge = topEdge + (viewport?.height || window.innerHeight) - 16
        if (!anchor.isConnected || r.bottom < topEdge || r.top > bottomEdge) { setOpen(false); return }
        const above = r.top - p.height - 10
        const top = above >= topEdge ? above : Math.max(topEdge, Math.min(r.bottom + 10, bottomEdge - p.height))
        const next = { left: Math.max(leftEdge, Math.min(r.left, rightEdge - p.width)), top,
          maxHeight: Math.max(80, bottomEdge - topEdge) }
        setPosition(previous => previous?.left === next.left && previous?.top === next.top
          && previous?.maxHeight === next.maxHeight ? previous : next)
      }
      place()
      surface.focus({ preventScroll: true })
      const observer = new ResizeObserver(place)
      observer.observe(anchor); observer.observe(surface)
      window.addEventListener('resize', place)
      document.addEventListener('scroll', place, true)
      window.visualViewport?.addEventListener('resize', place)
      window.visualViewport?.addEventListener('scroll', place)
      return () => {
        observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true)
        window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place)
      }
    }, [open, signedIn])
    React.useLayoutEffect(() => {
      if (open && signedIn && position) {
        setPresent(true)
        motion.current.update(true, panel.current)
      } else if (!open || !signedIn) {
        motion.current.update(false, panel.current)
      }
    }, [open, signedIn, present, Boolean(position)])
    React.useEffect(() => {
      if (!open) return
      const outside = event => {
        if (!panel.current?.contains(event.target) && !getTrigger()?.contains(event.target)) close()
      }
      const escape = event => {
        if (event.key !== 'Escape') return
        event.preventDefault(); event.stopPropagation(); close(true)
      }
      document.addEventListener('pointerdown', outside, true)
      document.addEventListener('focusin', outside)
      document.addEventListener('keydown', escape, true)
      return () => {
        document.removeEventListener('pointerdown', outside, true)
        document.removeEventListener('focusin', outside)
        document.removeEventListener('keydown', escape, true)
      }
    }, [open])
    function activate(event) {
      if (!signedIn || !getTrigger()?.contains(event.target)) return
      if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      if (event.repeat) return
      const next = event.type === 'keydown' || !open
      setOpen(next); setActionFailed(false)
      if (next) {
        if (!present) setPosition(null)
        Promise.resolve().then(() => props.refreshAccount?.()).catch(() => {
          if (alive.current && currentSignedIn.current) setActionFailed(true)
        })
      }
    }
    async function feedback() {
      try { await props.contactUs(); if (alive.current) close(true) }
      catch { if (alive.current) setActionFailed(true) }
    }
    async function requestSignOut() {
      if (pending.current) return
      const request = {}
      pending.current = request; setChecking(true); setFailed(false)
      let running
      try { running = await props.hasRunningAccountTasks() } catch { running = 'unknown' }
      if (pending.current !== request) return
      pending.current = false
      if (!alive.current || !currentSignedIn.current) return
      setChecking(false); close(true); setImpact(running)
    }
    function dismissSignOut() {
      if (pending.current) return
      setImpact(undefined); setFailed(false); getTrigger()?.focus({ preventScroll: true })
    }
    async function confirmSignOut() {
      if (pending.current) return
      const request = {}
      pending.current = request; setBusy(true); setFailed(false)
      try { await props.signOut(); if (alive.current && pending.current === request) setImpact(undefined) }
      catch { if (alive.current && currentSignedIn.current && pending.current === request) setFailed(true) }
      finally { if (pending.current === request) { pending.current = false; if (alive.current) setBusy(false) } }
    }
    function platformAction(page, label, className) {
      const href = platformHref(account.view, page)
      const enabled = typeof props.openPlatformPage === 'function' || Boolean(href)
      const onClick = event => {
        if (!enabled) { event.preventDefault(); return }
        if (props.openPlatformPage) {
          event.preventDefault()
          try {
            releasePage.current?.()
            releasePage.current = props.openPlatformPage(page, () => { releasePage.current = null; getTrigger()?.focus({ preventScroll: true }) })
          } catch { setActionFailed(true); return }
        }
        close(true)
      }
      return h('a', { href, target: '_blank', rel: 'noopener noreferrer', className: 'dshAccount__action ' + className,
        'aria-disabled': !enabled || undefined, tabIndex: enabled ? 0 : -1, onClick, 'data-dsh-account-action': page },
      label, page === 'usage' && h(ui.IconRightUpOutlineRegular, { size: 12 }))
    }
    function wallet(bonus) {
      const rows = balanceRows(account.details, bonus)
      const values = rows?.map(row => formatBalance(row.balance, row.currency))
      const available = values?.length && values.every(Boolean)
      return h('div', { className: 'dshAccount__balance' + (bonus ? ' dshAccount__bonus' : '') },
        h('div', { className: 'dshAccount__label' }, t(bonus ? 'bonusBalance' : 'balance')),
        h('div', { className: 'dshAccount__valueRow' },
          h('div', { className: 'dshAccount__amounts', 'aria-live': 'polite' }, available
            ? values.map((value, i) => h('span', { key: rows[i].currency, className: 'dshAccount__amount', title: value.text,
              'aria-label': value.text, 'data-long': value.number.length > 11 },
            h('span', { className: 'dshAccount__currency' }, value.prefix + value.symbol), value.number))
            : h('span', { className: 'dshAccount__unavailable' }, t(account.details?.balance === undefined && !account.failed ? 'loading' : 'balanceUnavailable'))),
          platformAction(bonus ? 'usage' : 'top-up', t(bonus ? 'usage' : 'topUp'), bonus ? 'dshAccount__usage' : 'dshAccount__topup')))
    }
    const profile = account.details?.profile?.status === 'ready' ? account.details.profile.value : undefined
    const name = profile?.name || profile?.contact || t('signedIn')
    const contact = profile?.contact || t(account.details?.profile === undefined && !account.failed ? 'loading' : 'profileUnavailable')
    const iconButton = (label, className, onClick, icon, disabled = false) => {
      const button = h('button', { type: 'button', className: 'dshAccount__icon ' + className,
        'aria-label': label, title: ui.Tooltip ? undefined : label, onClick, disabled }, icon)
      return ui.Tooltip ? h(ui.Tooltip, { label, portal: true, side: 'top', delayMs: 400 }, button) : button
    }
    return h('div', { className: 'dshAccountLauncher', 'data-collapsed': !props.wide, onClickCapture: activate, onKeyDownCapture: activate },
      h('div', { ref: native, className: 'dshAccountLauncher__native' }, h(Original, props)),
      signedIn && !props.hasDesktopSettingsLauncher && iconButton(t('settings'), 'dshAccount__settings', () => { close(); props.openSettings() }, h(ui.IconSettingsOutlineMedium, { size: 16 })),
      (open || present) && signedIn && ReactDOM.createPortal(h('section', { ref: panel, id, className: 'dshAccount', role: 'dialog',
        'data-state': open ? 'open' : 'closing', inert: open ? undefined : '', 'aria-hidden': open ? undefined : true,
        'aria-label': t('nav'), tabIndex: -1, style: position || { visibility: 'hidden' }, 'data-dsh-account-popover': '' },
      h('div', { className: 'dshAccount__profile' },
        h('span', { className: 'dshAccount__avatar' }, account.avatar?.status === 'ready'
          ? h('img', { src: account.avatar.url, alt: '', referrerPolicy: 'no-referrer', onError: () => props.avatarFailed?.(account.avatar) })
          : h(ui.IconUserOutlineMedium, { size: 20 })),
        h('span', { className: 'dshAccount__name', title: name }, name),
        iconButton(t('signOut'), 'dshAccount__logout', requestSignOut, h(LogoutIcon, { size: 14 }), checking),
        h('div', { className: 'dshAccount__contact' }, h('span', { className: 'dshAccount__phone', title: contact }, contact),
          iconButton(t('contactUs'), 'dshAccount__feedback', feedback, h(ui.IconPaperPlaneOutlineMedium, { size: 13 })))),
      h('div', { className: 'dshAccount__finance' }, wallet(false), wallet(true)),
      actionFailed && h('p', { className: 'dshAccount__error', role: 'alert' }, t('failed'))), document.body),
      signedIn && impact !== undefined && h(ui.Modal, { open: true, title: t('signOut'), closeLabel: t('close'),
        onClose: dismissSignOut, description: t(impact === 'unknown' ? 'signOutUnknownDescription' : impact ? 'signOutRunningDescription' : 'signOutDescription'),
        footer: h(React.Fragment, null,
          h(ui.Button, { variant: 'outline', onClick: dismissSignOut, disabled: busy }, t('cancel')),
          h(ui.Button, { variant: 'primary', onClick: confirmSignOut, disabled: busy }, t('signOut'))) },
      failed && h('p', { role: 'alert', className: 'dshAccount__confirmError' }, t('failed'))))
  }
  return AccountLauncher
}
