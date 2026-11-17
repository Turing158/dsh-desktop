/* Preserve child-slot authorization when a desktop adapter wraps a native entry.
 * Each clone owns private aliases; the native declaration remains the source. */
;(function () {
  'use strict'
  window.__DSH_SLOT_CHILDREN__ = function (React, slots, entry, prefix) {
    const alias = key => prefix + '.' + key
    const children = Object.entries(entry.children || {})
    function Delegate(props) {
      const renderSlot = React.useCallback((key, owner, options) => props.renderSlot(alias(key), owner, options), [props.renderSlot])
      const renderSlotChain = React.useCallback((key, owner, options) => props.renderSlotChain(alias(key), owner, options), [props.renderSlotChain])
      return React.createElement(entry.component, children.length ? { ...props, renderSlot, renderSlotChain } : props)
    }
    function mirror(source) {
      const mounted = new Map()
      const sync = () => {
        const entries = slots.entries(source)
        for (const [value, off] of mounted) if (!entries.includes(value)) { off(); mounted.delete(value) }
        for (const value of entries) {
          if (mounted.has(value)) continue
          const nested = window.__DSH_SLOT_CHILDREN__(React, slots, value, prefix)
          const off = slots.register({ ...value.options, name: alias(source), select: value.select,
            inject: value.inject, store: value.store, locale: value.locale, children: nested.children,
          }, nested.component)
          let unmount
          try { unmount = nested.mount() } catch (error) { off(); throw error }
          mounted.set(value, () => { unmount(); off() })
        }
      }
      const unsubscribe = slots.subscribe(source, sync)
      try { sync() } catch (error) { unsubscribe(); for (const off of mounted.values()) off(); throw error }
      return () => { unsubscribe(); for (const off of mounted.values()) off(); mounted.clear() }
    }
    return {
      component: children.length ? Delegate : entry.component,
      children: Object.fromEntries(children.map(([key, spec]) => [alias(key), spec])),
      mount() {
        const disposers = []
        try { for (const [key] of children) disposers.push(mirror(key)) }
        catch (error) { disposers.reverse().forEach(off => off()); throw error }
        return () => disposers.reverse().forEach(off => off())
      },
    }
  }
})()
