/** Keep a single measured surface through loading, content arrival and closing.
 * Only its height/opacity change; the message is never scaled or reflowed by animation. */
export function createHistoryDisclosure(React) {
  return function HistoryDisclosure({ open, id, animate = true, children }) {
    const outer = React.useRef(null), inner = React.useRef(null)
    const [mounted, setMounted] = React.useState(open)
    React.useLayoutEffect(() => {
      if (open && !mounted) { setMounted(true); return }
      if (!open && !mounted) { outer.current.style.height = '0px'; outer.current.style.opacity = '0'; return }
      const node = outer.current, body = inner.current
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
      let motion = null, target = -1, disposed = false
      const enabled = () => {
        const root = document.documentElement, setting = root.getAttribute('data-dsh-desktop-animation')
        return animate && root.getAttribute('data-dsh-ui') !== 'vanilla' && setting !== 'off' && (setting === 'on' || !reduced.matches)
      }
      const finish = () => { if (!disposed && !open) setMounted(false) }
      const update = () => {
        const next = open && body ? body.getBoundingClientRect().height : 0
        if (next === target && (enabled() || !motion)) return
        const height = node.getBoundingClientRect().height, opacity = getComputedStyle(node).opacity
        motion?.cancel(); motion = null; target = next
        node.style.height = next + 'px'; node.style.opacity = open ? '1' : '0'
        if (!enabled() || Math.abs(height - next) < 0.5) { finish(); return }
        motion = node.animate([{ height: height + 'px', opacity }, { height: next + 'px', opacity: open ? 1 : 0 }],
          { duration: open ? 220 : 160, easing: 'cubic-bezier(.2, .75, .25, 1)' })
        motion.onfinish = () => { motion = null; finish() }
      }
      const size = new ResizeObserver(update)
      if (body) size.observe(body)
      const preferences = new MutationObserver(update)
      preferences.observe(document.documentElement, { attributes: true, attributeFilter: ['data-dsh-ui', 'data-dsh-desktop-animation'] })
      reduced.addEventListener('change', update)
      update()
      return () => {
        disposed = true
        const height = node.getBoundingClientRect().height, opacity = getComputedStyle(node).opacity
        motion?.cancel(); node.style.height = height + 'px'; node.style.opacity = opacity
        size.disconnect(); preferences.disconnect(); reduced.removeEventListener('change', update)
      }
    }, [open, mounted, animate])
    return React.createElement('div', { ref: outer, id, className: 'dshHistory__expanded', 'aria-hidden': !open,
      inert: open ? undefined : '', style: { height: 0, opacity: 0 } },
    mounted && React.createElement('div', { ref: inner, className: 'dshHistory__reveal' }, children))
  }
}
