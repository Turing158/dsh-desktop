/** Animate the live surface so interrupted opens/closes continue from the current frame. */
export function createPopoverMotion(doc, onHidden) {
  const win = doc.defaultView
  const root = doc.documentElement
  const media = win.matchMedia?.('(prefers-reduced-motion: reduce)')
  let panel = null, animation = null, open = false, disposed = false
  const active = () => root.getAttribute('data-dsh-ui') !== 'vanilla' &&
    root.getAttribute('data-dsh-desktop-animation') !== 'off' &&
    (root.getAttribute('data-dsh-desktop-animation') === 'on' || !media?.matches)
  function cancel() {
    if (!animation) return
    animation.onfinish = null
    animation.cancel()
    animation = null
  }
  function settle() {
    if (animation) {
      animation.onfinish = null
      // Keep the invisible closing frame until React removes the surface.
      animation.finish()
    }
    if (open) cancel()
    else onHidden()
  }
  const preferenceChanged = () => { if (!active()) settle() }
  const observer = new win.MutationObserver(preferenceChanged)
  observer.observe(root, { attributes: true, attributeFilter: ['data-dsh-ui', 'data-dsh-desktop-animation'] })
  media?.addEventListener?.('change', preferenceChanged)
  return {
    update(nextOpen, nextPanel) {
      if (disposed || nextOpen === open && nextPanel === panel) return
      const continuing = panel === nextPanel && animation
      const current = nextPanel && win.getComputedStyle(nextPanel)
      const from = continuing || !nextOpen
        ? { opacity: current?.opacity || '1', transform: current?.transform || 'none' }
        : { opacity: 0, transform: 'translateY(6px)' }
      cancel()
      open = nextOpen; panel = nextPanel
      if (!panel || !active() || typeof panel.animate !== 'function') { settle(); return }
      const to = open ? { opacity: 1, transform: 'none' } : { opacity: 0, transform: 'translateY(6px)' }
      animation = panel.animate([from, to], {
        duration: open ? 180 : 160,
        easing: open ? 'cubic-bezier(.2, .8, .2, 1)' : 'ease-in', fill: 'both',
      })
      animation.onfinish = settle
    },
    dispose() {
      disposed = true
      cancel(); panel = null
      observer.disconnect()
      media?.removeEventListener?.('change', preferenceChanged)
    },
  }
}
