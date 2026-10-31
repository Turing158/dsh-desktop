import { t, useLocale } from '../i18n/api.mjs'
import {
  cancellableJobs, orderCancellable, liveSummary, formatDuration, triggerLabel, badgeText, summaryText,
} from './model.mjs'
import { seatGeometry, panelGeometry } from './geometry.mjs'
import css from './style.css'

/**
 * The conversation header's right-aligned utility list.
 *
 * WHY THIS SLOT AND THIS GEOMETRY. The control belongs at the right end of the
 * session header, level with the 对话/轨迹 strip and right-aligned with the
 * header's corner control — the empty band the user boxed. Two framework facts
 * shape the implementation:
 *
 *   1. `conversation.session.header.corner` is a `single` seat, and the shipped
 *      right sidebar already occupies it with its own 打开侧边栏 button. A
 *      second registration would REPLACE that button, so the corner is not a
 *      candidate.
 *   2. The tabs strip is rendered by the conversation header itself (not a
 *      slot), and a `<button>` inside `role="tablist"` would be an invalid tab.
 *
 * So the control registers in the additive utilities list — which owns the
 * session id, the React tree, and its lifetime — and renders its button into a
 * seat appended to the same `<header>` element, absolutely positioned on the
 * tabs row. The in-flow anchor stays in the utilities list as the mount point
 * (and as a fallback when no header can be located).
 *
 * @module @dsh-desktop/session-jobs/client
 */

export const HEADER_SLOT = 'conversation.session.header.utilities'
export const CONTROL_ID = 'desktop-session-jobs'
export const MODE_ATTRIBUTE = 'data-dsh-ui'
const PANEL_ID = 'dsh-session-jobs-panel'
const FAILED_HINT_MS = 4e3

/** 原版 mode leaves the shipped header untouched. */
export function isVanilla(doc = globalThis.document) {
  return doc?.documentElement?.getAttribute(MODE_ATTRIBUTE) === 'vanilla'
}

/** Subscribe to 原版/desktop switches without remounting the control. */
function useVanilla(React, doc) {
  const subscribe = React.useCallback(listener => {
    doc.addEventListener('dsh-desktop:ui-mode', listener)
    const observer = new MutationObserver(listener)
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: [MODE_ATTRIBUTE] })
    return () => { doc.removeEventListener('dsh-desktop:ui-mode', listener); observer.disconnect() }
  }, [doc])
  return React.useSyncExternalStore(subscribe, () => isVanilla(doc), () => false)
}

/**
 * The control's four glyphs. Hand-drawn rather than imported: they must keep
 * the same 1.3px stroke weight as the neighbouring header icons, and the stop
 * mark is a filled square rather than an outline circle so a row's single
 * destructive affordance cannot be mistaken for a disclosure.
 * @param React - the injected React.
 * @returns one component per glyph.
 */
export function createGlyphs(React) {
  const h = React.createElement
  const svg = (size, box, props, ...children) => h('svg', {
    width: size, height: size, viewBox: `0 0 ${box} ${box}`, fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false', ...props,
  }, ...children)
  return {
    trigger: () => svg(16, 16, {},
      h('rect', { x: 1.7, y: 2.2, width: 12.6, height: 11.6, rx: 2.6 }),
      h('path', { d: 'M4.6 5.8 6.9 8.1 4.6 10.4' }),
      h('path', { d: 'M8.7 10.5h3' })),
    stop: () => h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true', focusable: 'false' },
      h('rect', { x: 3.7, y: 3.7, width: 6.6, height: 6.6, rx: 1.8, fill: 'currentColor' })),
    busy: () => svg(14, 14, { className: 'dshSessionJobs__busy' },
      h('circle', { cx: 7, cy: 7, r: 4.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeDasharray: '7 22' })),
    close: () => svg(12, 12, {}, h('path', { d: 'M2.6 2.6 9.4 9.4M9.4 2.6 2.6 9.4' })),
  }
}

/**
 * Build the panel and the control around the caller's React instance.
 * @param React - the injected React.
 * @param ReactDOM - the injected ReactDOM, for the two portals.
 * @param ctx - the client root context, for the jobs service.
 * @returns the slot component.
 */
export function createControl(React, ReactDOM, ctx) {
  const h = React.createElement
  const Icon = createGlyphs(React)

  function JobsPanel({ triggerRef, rows, counts, now, pending, onStop, onClose }) {
    const panel = React.useRef(null)
    const [box, setBox] = React.useState(null)
    const place = React.useCallback(() => {
      const node = panel.current, target = triggerRef.current
      if (!node || !target) return
      const next = panelGeometry(target.getBoundingClientRect(), { width: node.offsetWidth, height: node.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight })
      setBox(previous => previous && previous.left === next.left && previous.top === next.top && previous.width === next.width ? previous : next)
    }, [triggerRef])
    React.useLayoutEffect(() => {
      place()
      const observer = new ResizeObserver(place)
      if (panel.current) observer.observe(panel.current)
      window.addEventListener('resize', place)
      document.addEventListener('scroll', place, true)
      return () => { observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true) }
    }, [place])
    // The panel is the focus owner while it is open; the trigger keeps the
    // accessible name for the disclosure relationship.
    React.useEffect(() => { panel.current?.focus({ preventScroll: true }) }, [])
    const closing = event => { event.preventDefault(); event.stopPropagation(); onClose(true) }
    return h('div', {
      id: PANEL_ID, ref: panel, role: 'dialog', 'aria-label': t('后台任务'), tabIndex: -1,
      className: 'dshSessionJobs__panel', 'data-dsh-session-jobs': '',
      style: box ? { left: box.left, top: box.top, width: box.width } : { left: 0, top: 0, visibility: 'hidden' },
      onKeyDown: event => {
        if (event.key !== 'Escape') return
        event.preventDefault(); event.stopPropagation(); onClose(true)
      },
    },
      h('div', { className: 'dshSessionJobs__head' },
        h('span', { className: 'dshSessionJobs__title' }, t('后台任务')),
        h('span', { className: 'dshSessionJobs__summary' }, summaryText(counts, t)),
        h('button', { type: 'button', className: 'dshSessionJobs__close', 'aria-label': t('关闭面板'), title: t('关闭面板'), onClick: closing },
          h(Icon.close))),
      h('div', { className: 'dshSessionJobs__list', role: 'list' }, rows.map(job => {
        const state = pending[job.id]
        const stopping = job.status === 'stopping' || state === 'stopping'
        const failed = state === 'failed'
        return h('div', { key: job.id, role: 'listitem', className: 'dshSessionJobs__row', 'data-status': job.status },
          h('span', { className: 'dshSessionJobs__dot', 'data-status': job.status, 'aria-hidden': 'true' }),
          h('span', { className: 'dshSessionJobs__body' },
            h('span', { className: 'dshSessionJobs__label', title: job.label || String(job.id) }, job.label || String(job.id)),
            failed && h('span', { className: 'dshSessionJobs__error', role: 'alert' }, t('停止失败，请重试'))),
          h('button', {
            type: 'button', className: 'dshSessionJobs__stop',
            'aria-label': t(stopping ? '正在停止…' : '停止') + ' ' + (job.label || job.id), title: t(stopping ? '正在停止…' : '停止'),
            'aria-busy': stopping,
            disabled: job.status !== 'running' || stopping,
            'data-state': stopping ? 'stopping' : 'idle',
            onClick: () => onStop(job),
          },
            h('span', { className: 'dshSessionJobs__duration', 'aria-hidden': 'true' }, formatDuration(now - job.startedAt, t)),
            h('span', { className: 'dshSessionJobs__stopIcon', 'aria-hidden': 'true' }, stopping ? h(Icon.busy) : h(Icon.stop))))
      })))
  }

  return function SessionJobsControl({ sessionId }) {
    useLocale(React)
    const doc = globalThis.document
    const vanilla = useVanilla(React, doc)
    const anchor = React.useRef(null)
    const trigger = React.useRef(null)
    const [seat, setSeat] = React.useState(null)
    const [open, setOpen] = React.useState(false)
    const [now, setNow] = React.useState(() => Date.now())
    const [pending, setPending] = React.useState({})
    const timers = React.useRef(new Set())

    const jobs = ctx.jobs
    const subscribe = React.useCallback(listener => jobs.state.subscribe(listener), [jobs])
    const getSnapshot = React.useCallback(() => jobs.state.getSnapshot(), [jobs])
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    const rows = orderCancellable(cancellableJobs(sessionId ? snapshot.rows?.[sessionId] : undefined))
    const counts = liveSummary(rows)
    const hasJobs = counts.total > 0

    // Keep this session's roster open for as long as the header is on screen;
    // the service reference-counts the stream, so the shipped job list shares it.
    React.useEffect(() => (sessionId ? jobs.watchRows(sessionId) : undefined), [jobs, sessionId])

    // A hidden control must not reopen its old popup when live work returns.
    React.useEffect(() => { if (vanilla || !hasJobs) setOpen(false) }, [vanilla, hasJobs])

    // Live durations: one second while the panel is open on live work.
    React.useEffect(() => {
      if (!open || rows.length === 0) return
      setNow(Date.now())
      const timer = setInterval(() => setNow(Date.now()), 1000)
      return () => clearInterval(timer)
    }, [open, rows.length])

    React.useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); timers.current.clear() }, [])

    // A row that left the roster (settled after a successful stop) must not
    // leave its request state behind: the ids are per-registration, so pruning
    // against the live rows is exact.
    React.useEffect(() => {
      setPending(current => {
        const live = new Set(rows.map(row => row.id))
        const kept = Object.entries(current).filter(([id]) => live.has(id))
        return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept)
      })
    }, [rows])

    // The seat: an absolutely positioned span inside the session header, on the
    // tabs row. Re-placed on header resizes and on tab-strip changes.
    React.useLayoutEffect(() => {
      if (vanilla || !hasJobs) return undefined
      const host = anchor.current?.closest('header')
      if (!host) return undefined
      const spot = doc.createElement('span')
      spot.className = 'dshSessionJobs__seat'
      const hadInline = host.style.position
      if (!hadInline) host.style.position = 'relative'
      host.append(spot)
      setSeat(spot)
      const place = () => {
        const geometry = seatGeometry(host.getBoundingClientRect(),
          host.querySelector('[data-conversation-header-corner]')?.getBoundingClientRect(),
          host.querySelector('[data-conversation-tabs]')?.getBoundingClientRect())
        spot.style.right = geometry.right + 'px'
        spot.style.top = geometry.top + 'px'
      }
      place()
      const observer = new ResizeObserver(place)
      observer.observe(host)
      const tabs = host.querySelector('[data-conversation-tabs]')
      if (tabs) observer.observe(tabs)
      window.addEventListener('resize', place)
      const mutation = new MutationObserver(place)
      mutation.observe(host, { childList: true, subtree: true })
      return () => {
        mutation.disconnect()
        observer.disconnect()
        window.removeEventListener('resize', place)
        host.style.position = hadInline
        spot.remove()
        setSeat(null)
      }
    }, [doc, vanilla, hasJobs])

    // Outside click and Escape close the panel; the trigger toggles it.
    React.useEffect(() => {
      if (!open) return undefined
      const outside = event => {
        const panel = doc.getElementById(PANEL_ID)
        if (panel?.contains(event.target) || trigger.current?.contains(event.target) || seat?.contains(event.target)) return
        setOpen(false)
      }
      const escape = event => {
        if (event.key !== 'Escape') return
        setOpen(false)
        trigger.current?.focus({ preventScroll: true })
      }
      doc.addEventListener('pointerdown', outside, true)
      doc.addEventListener('keydown', escape, true)
      return () => { doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', escape, true) }
    }, [doc, open, seat])

    const close = React.useCallback(restore => {
      setOpen(false)
      if (restore) trigger.current?.focus({ preventScroll: true })
    }, [])

    const stop = React.useCallback(job => {
      if (!sessionId) return
      setPending(current => (current[job.id] === 'stopping' ? current : { ...current, [job.id]: 'stopping' }))
      const fail = () => {
        setPending(current => ({ ...current, [job.id]: 'failed' }))
        const timer = setTimeout(() => {
          timers.current.delete(timer)
          setPending(current => {
            if (current[job.id] !== 'failed') return current
            const next = { ...current }
            delete next[job.id]
            return next
          })
        }, FAILED_HINT_MS)
        timers.current.add(timer)
      }
      Promise.resolve().then(() => jobs.kill(sessionId, job.id)).then(result => {
        if (!result?.ok) fail()
      }, fail)
    }, [jobs, sessionId])

    if (vanilla || !hasJobs) return null

    const label = triggerLabel(counts.total, t)
    const button = h('button', {
      ref: trigger, type: 'button', className: 'dshSessionJobs__trigger', 'data-dsh-session-jobs-trigger': '',
      'aria-label': label, title: label, 'aria-haspopup': 'dialog', 'aria-expanded': open,
      'aria-controls': open ? PANEL_ID : undefined, 'data-running': counts.total > 0 ? 'true' : 'false',
      // Taking focus here would drop the composer's selection and a pending paste.
      onMouseDown: event => { event.preventDefault() },
      onClick: () => setOpen(value => !value),
    },
      h(Icon.trigger),
      counts.total > 0 && h('span', { className: 'dshSessionJobs__badge', 'aria-hidden': 'true' }, badgeText(counts.total)))

    return h(React.Fragment, null,
      h('span', { ref: anchor, className: 'dshSessionJobs__anchor', hidden: Boolean(seat) }),
      seat ? ReactDOM.createPortal(button, seat) : button,
      open && seat && ReactDOM.createPortal(h(JobsPanel, {
        triggerRef: trigger, rows, counts, now, pending, onStop: stop, onClose: close,
      }), doc.body))
  }
}

window.__ModuleLoader__.load({ id: '@dsh-desktop/session-jobs', factory(require) {
  const React = require('react'), ReactDOM = require('react-dom')
  return {
    inject: ['slots', 'jobs'],
    apply(ctx) {
      if (!ctx.jobs || !ctx.slots) return undefined
      const style = document.createElement('style')
      style.dataset.dshSessionJobsStyle = ''
      style.textContent = css
      document.head.append(style)
      const Control = createControl(React, ReactDOM, ctx)
      const off = ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
        name: HEADER_SLOT, id: CONTROL_ID, order: 2,
      }, Control))
      if (window.__DSH_UI_BOOT__?.smoke) window.__DSH_SESSION_JOBS_SMOKE__ = { seatGeometry, panelGeometry, CONTROL_ID }
      return () => { off?.(); style.remove() }
    },
  }
} })
