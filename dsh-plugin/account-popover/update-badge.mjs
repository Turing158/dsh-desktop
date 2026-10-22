import { createBadgeMotion } from './update-badge-motion.mjs'

/** The title bar owns checks and installation; this is a compact second entry. */
export function createUpdateBadge(React, ui) {
  const h = React.createElement
  return function UpdateBadge({ wide }) {
    window.__DSH_I18N__?.use(React)
    const t = (text, values) => window.__DSH_I18N__?.t(text, values)
      ?? text.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match)
    const read = () => window.__DSH_DSH_UPDATE__?.getSnapshot() ?? null
    const [update, setUpdate] = React.useState(read)
    const pill = React.useRef(null), content = React.useRef(null), outgoing = React.useRef(null), motion = React.useRef(null)
    React.useLayoutEffect(() => {
      motion.current = createBadgeMotion(document)
      return () => { motion.current.dispose(); motion.current = null }
    }, [])
    React.useEffect(() => {
      const sync = () => setUpdate(read())
      document.addEventListener('dsh-desktop:dsh-update', sync)
      sync()
      return () => document.removeEventListener('dsh-desktop:dsh-update', sync)
    }, [])
    const available = Boolean(update?.versions?.stableUpdateAvailable)
    const waiting = update?.busy === 'waiting'
    const installing = Boolean(update?.busy && !['waiting', 'check'].includes(update.busy))
    const busy = waiting || installing
    const failed = Boolean(update?.error)
    const state = waiting ? 'waiting' : installing ? 'installing' : failed ? 'error' : 'available'
    const text = waiting ? t('等待中') : installing ? t('更新中') : failed ? t('重试') : t('新版本')
    const contentKey = JSON.stringify([available, state, Boolean(wide), wide ? text : ''])
    React.useLayoutEffect(() => { motion.current.update(contentKey, pill.current, content.current, outgoing.current) }, [contentKey])
    if (!available) return null
    const label = waiting ? t('等待会话结束后更新…') : installing ? t('正在更新 dsh…')
      : failed ? t('更新失败，点击查看并重试') : t('更新到 dsh 稳定版 {version}', { version: update.versions.latest })
    const button = h('button', {
      type: 'button', className: 'dshUpdateBadge', 'data-state': state,
      'data-compact': !wide, 'aria-label': label, 'aria-busy': busy,
      disabled: installing || update.busy === 'check', title: ui.Tooltip ? undefined : label,
      onClick: () => {
        const service = window.__DSH_DSH_UPDATE__
        if (waiting || failed) service?.show()
        else void service?.installStable()
      },
    }, h('span', { ref: pill, className: 'dshUpdateBadge__pill' },
      h('span', { ref: content, className: 'dshUpdateBadge__content' },
        busy ? h('span', { className: 'dshUpdateBadge__spinner', 'aria-hidden': true })
          : h('svg', { width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
            h('path', { d: failed ? 'M8 3v6m0 3v.1' : 'M8 12V3m-4 4 4-4 4 4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })),
        wide && h('span', null, text)),
      h('span', { ref: outgoing, className: 'dshUpdateBadge__ghost', 'aria-hidden': true })))
    return h('span', { className: 'dshUpdateBadge__anchor' },
      ui.Tooltip ? h(ui.Tooltip, { label, portal: true, side: 'top', delayMs: 250 }, button) : button,
      h('span', { className: 'dshUpdateBadge__status', role: 'status', 'aria-live': 'polite' }, label))
  }
}
