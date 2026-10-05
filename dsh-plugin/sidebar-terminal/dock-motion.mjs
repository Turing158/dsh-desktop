/** Keep the real terminal mounted until its closing slide has finished. */
export function createDockMotion(doc, onHidden) {
  const win = doc.defaultView || window
  const html = doc.documentElement
  const media = win.matchMedia?.('(prefers-reduced-motion: reduce)')
  let panel = null, height = 0, visibleHeight = 0, open = false, frame = null, disposed = false
  const active = () => html.getAttribute('data-dsh-ui') !== 'vanilla' &&
    html.getAttribute('data-dsh-desktop-animation') !== 'off' &&
    (html.getAttribute('data-dsh-desktop-animation') === 'on' || !media?.matches)
  const cancel = () => { if (frame !== null) win.cancelAnimationFrame(frame); frame = null }
  const paint = value => {
    visibleHeight = value
    html.style.setProperty('--dsh-terminal-dock-height', value + 'px')
    html.toggleAttribute('data-dsh-terminal-dock-visible', open || value > 0)
    if (panel) panel.style.transform = value === height ? '' : `translateY(${height - value}px)`
  }
  const settle = () => {
    cancel()
    paint(open ? height : 0)
    if (!open) onHidden()
  }
  const preferenceChanged = () => { if (!active()) settle() }
  const observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(preferenceChanged) : null
  observer?.observe(html, { attributes: true, attributeFilter: ['data-dsh-ui', 'data-dsh-desktop-animation'] })
  media?.addEventListener?.('change', preferenceChanged)
  return {
    update(nextOpen, nextHeight, nextPanel, immediate = false) {
      if (disposed) return
      const changed = nextOpen !== open
      open = nextOpen
      height = nextHeight
      panel = nextPanel
      cancel()
      // Resizing must follow the pointer without a trailing animation.
      if (!changed || immediate || !panel || !active() || !win.requestAnimationFrame) { settle(); return }
      const from = visibleHeight, to = open ? height : 0
      const duration = 220 * Math.min(1, Math.abs(to - from) / Math.max(1, height))
      if (duration === 0) { settle(); return }
      let start
      paint(from)
      const step = now => {
        if (disposed) return
        start ??= now
        const progress = Math.min(1, (now - start) / duration)
        paint(from + (to - from) * (1 - Math.pow(1 - progress, 3)))
        if (progress < 1) frame = win.requestAnimationFrame(step)
        else settle()
      }
      frame = win.requestAnimationFrame(step)
    },
    dispose() {
      disposed = true
      cancel()
      observer?.disconnect()
      media?.removeEventListener?.('change', preferenceChanged)
      open = false
      paint(0)
      if (panel) panel.style.transform = ''
    },
  }
}
