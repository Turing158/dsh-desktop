/** Publish the bottom panel's reserved space synchronously with its visibility. */
export function createDockLayout(doc, onHidden) {
  const html = doc.documentElement
  let disposed = false
  const paint = (open, height) => {
    html.style.setProperty('--dsh-terminal-dock-height', (open ? height : 0) + 'px')
    html.toggleAttribute('data-dsh-terminal-dock-visible', open)
  }
  return {
    update(open, height) {
      if (disposed) return
      paint(open, height)
      if (!open) onHidden()
    },
    dispose() {
      disposed = true
      paint(false, 0)
    },
  }
}
