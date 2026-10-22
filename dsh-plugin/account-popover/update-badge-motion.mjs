/** Crossfade status content and resize the pill without moving its layout anchor. */
export function createBadgeMotion(doc) {
  const win = doc.defaultView, root = doc.documentElement
  const media = win.matchMedia?.('(prefers-reduced-motion: reduce)')
  const active = () => root.getAttribute('data-dsh-ui') !== 'vanilla'
    && root.getAttribute('data-dsh-desktop-animation') !== 'off'
    && (root.getAttribute('data-dsh-desktop-animation') === 'on' || !media?.matches)
  let previous = null, animations = [], ghost = null, disposed = false
  function cancel() {
    for (const animation of animations) { animation.onfinish = null; animation.cancel() }
    animations = []
    ghost?.replaceChildren(); ghost = null
  }
  const preferenceChanged = () => { if (!active()) cancel() }
  const observer = new win.MutationObserver(preferenceChanged)
  observer.observe(root, { attributes: true, attributeFilter: ['data-dsh-ui', 'data-dsh-desktop-animation'] })
  media?.addEventListener?.('change', preferenceChanged)
  return {
    update(key, pill, content, outgoing) {
      if (disposed || previous?.key === key && previous.pill === pill) return
      const continuing = previous?.pill === pill && animations.length > 0
      const currentWidth = continuing ? win.getComputedStyle(pill).width : previous?.width
      const current = continuing ? win.getComputedStyle(content) : null
      const from = { opacity: current?.opacity || 0, transform: current?.transform || 'translateY(3px)' }
      const outgoingFrom = current ? { opacity: current.opacity, transform: current.transform } : { opacity: 1, transform: 'none' }
      cancel()
      if (!pill || !content) { previous = null; return }
      const width = win.getComputedStyle(pill).width
      const snapshot = { key, pill, width, content: content.cloneNode(true) }
      if (active() && typeof content.animate === 'function') {
        const options = { duration: 180, easing: 'cubic-bezier(.2, .8, .2, 1)' }
        if (previous?.pill === pill && outgoing) {
          ghost = outgoing
          ghost.replaceChildren(previous.content)
          animations.push(ghost.animate([
            outgoingFrom, { opacity: 0, transform: 'translateY(-3px)' },
          ], { ...options, fill: 'forwards' }))
          if (currentWidth !== width) animations.push(pill.animate([{ width: currentWidth }, { width }], options))
        }
        const entering = content.animate([from, { opacity: 1, transform: 'none' }], options)
        animations.push(entering)
        entering.onfinish = cancel
      }
      previous = snapshot
    },
    dispose() {
      disposed = true; cancel(); previous = null
      observer.disconnect(); media?.removeEventListener?.('change', preferenceChanged)
    },
  }
}
