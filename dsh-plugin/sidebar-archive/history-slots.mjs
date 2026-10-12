export const HISTORY_SLOT = 'desktop.archive.view'
const alias = key => 'desktop.archive.' + key

/** Reuse native history renderers under independently owned slot declarations.
 * Each native entry keeps its scoped stores, injected data, locale and children.
 * Slots have exactly one declarer, so child render calls use the private aliases.
 */
export function mountHistorySlots(React, slots) {
  function mirror(source, target, filter = () => true) {
    const mounted = new Map()
    const sync = () => {
      const entries = slots.entriesOfSlot(source).filter(filter)
      for (const [entry, remove] of mounted) if (!entries.includes(entry)) { remove(); mounted.delete(entry) }
      for (const entry of entries) {
        if (mounted.has(entry)) continue
        const children = Object.entries(entry.children || {})
        function NativeHistory(props) {
          const renderSlot = React.useCallback((key, owner, options) => props.renderSlot(alias(key), owner, options), [props.renderSlot])
          const renderSlotChain = React.useCallback((key, owner, options) => props.renderSlotChain(alias(key), owner, options), [props.renderSlotChain])
          return React.createElement(entry.component, { ...props, renderSlot, renderSlotChain })
        }
        const remove = slots.register({ name: target, ...entry.options, select: entry.select,
          inject: entry.inject, store: entry.store, locale: entry.locale,
          ...(children.length ? { children: Object.fromEntries(children.map(([key, spec]) => [alias(key), spec])) } : {}),
        }, NativeHistory)
        const nested = children.map(([key]) => mirror(key, alias(key)))
        mounted.set(entry, () => { nested.reverse().forEach(off => off()); remove() })
      }
    }
    const unsubscribe = slots.subscribe(source, sync)
    sync()
    return () => { unsubscribe(); for (const remove of mounted.values()) remove(); mounted.clear() }
  }
  return mirror('conversation.view', HISTORY_SLOT, entry => ['chat', 'trajectory'].includes(entry.options.id))
}
