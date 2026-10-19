/** Keep the real terminal mounted until its closing slide has finished. */
export function createDockMotion(doc, onHidden) {
  const win = doc.defaultView || window
  const html = doc.documentElement
  const media = win.matchMedia?.('(prefers-reduced-motion: reduce)')
  let panel = null, height = 0, visibleHeight = 0, open = false, disposed = false
  let animations = [], slide = null, from = 0, to = 0
  let rightObserver = null
  const active = () => html.getAttribute('data-dsh-ui') !== 'vanilla' &&
    html.getAttribute('data-dsh-desktop-animation') !== 'off' &&
    (html.getAttribute('data-dsh-desktop-animation') === 'on' || !media?.matches)
  const cancel = () => {
    rightObserver?.disconnect(); rightObserver = null
    animations.forEach(animation => { animation.onfinish = null; animation.cancel() })
    animations = []; slide = null
  }
  const paint = value => {
    visibleHeight = value
    html.style.setProperty('--dsh-terminal-dock-height', value + 'px')
    html.toggleAttribute('data-dsh-terminal-dock-visible', open || value > 0)
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
      // Read the animation clock, not layout, when reversing an unfinished slide.
      if (slide) visibleHeight = from + (to - from) * (slide.effect.getComputedTiming().progress ?? 0)
      open = nextOpen
      height = nextHeight
      panel = nextPanel
      cancel()
      // Resizing must follow the pointer without a trailing animation.
      if (!changed || immediate || !panel?.animate || !active()) { settle(); return }
      from = visibleHeight; to = open ? height : 0
      const duration = 220 * Math.min(1, Math.abs(to - from) / Math.max(1, height))
      if (duration === 0) { settle(); return }
      // Publish the destination once. Native property animations interpolate only
      // the three affected boxes instead of invalidating inherited root variables
      // and waking DOM/theme observers on every frame.
      paint(to)
      if (!open) html.toggleAttribute('data-dsh-terminal-dock-visible', true)
      const timing = { duration, easing: 'ease-out', fill: 'both' }
      const animate = (node, frames) => {
        if (!node?.animate) return null
        const animation = node.animate(frames, timing)
        animations.push(animation)
        return animation
      }
      slide = animate(panel, [{ transform: `translateY(${height - from}px)` }, { transform: `translateY(${height - to}px)` }])
      animate(doc.querySelector('[class*="_centerCol"]'), [
        { paddingBottom: `min(${from}px, 100%)` }, { paddingBottom: `min(${to}px, 100%)` },
      ])
      const right = doc.querySelector('[data-sidebar-right-panel]')
      let rightMotion = null
      const syncRight = () => {
        rightMotion?.cancel()
        if (right?.getAttribute('data-sidebar-right-panel') !== 'push') return
        rightMotion = animate(right, [{ bottom: from + 'px' }, { bottom: to + 'px' }])
        if (slide.currentTime !== null) rightMotion.currentTime = slide.currentTime
      }
      syncRight()
      if (right && typeof win.MutationObserver === 'function') {
        rightObserver = new win.MutationObserver(syncRight)
        rightObserver.observe(right, { attributes: true, attributeFilter: ['data-sidebar-right-panel'] })
      }
      slide.onfinish = settle
    },
    dispose() {
      disposed = true
      cancel()
      observer?.disconnect()
      media?.removeEventListener?.('change', preferenceChanged)
      open = false
      paint(0)
    },
  }
}
