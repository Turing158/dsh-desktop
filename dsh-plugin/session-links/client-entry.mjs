import { linksForNode, openSessionLink, parseSessionLink } from './links.mjs'
import { mountInlineSessionLinks } from './inline.mjs'
import { t, useLocale } from '../i18n/api.mjs'

window.__ModuleLoader__.load({ id: '@dsh-desktop/session-links', factory(require) {
  const React = require('react'), h = React.createElement
  return { inject: ['slots', 'sessions', 'uiWorkspace'], apply(ctx) {
    const slot = 'conversation.chat.node'
    if (typeof ctx.slots.entries !== 'function') return
    ctx.slots.inject(slot, () => {
      const mounted = new Map(), wrappers = new Set()
      let syncing = false
      function sync() {
        if (syncing) return
        syncing = true
        try {
          // Inspect the full registration ledger. entriesOfSlot only returns
          // winners, which hide the original as soon as our wrapper mounts.
          const keys = new Set()
          const entries = ctx.slots.entries(slot).filter(entry => {
            const key = entry.options.key
            // Viewport wrapping belongs outside links; do not build a cycle
            // when both integrations reconcile the same native renderer slot.
            if (entry.component.__dshTranscriptViewport || wrappers.has(entry.component) || keys.has(key) || !['user', 'steering', 'assistant-step'].includes(key)) return false
            keys.add(key)
            return true
          })
          for (const [entry, remove] of mounted) if (!entries.includes(entry)) { remove(); mounted.delete(entry) }
          for (const entry of entries) {
            if (mounted.has(entry)) continue
            function LinkedMessage(props) {
              useLocale(React)
              const root = React.useRef(null)
              const links = React.useMemo(() => linksForNode(props.node), [props.node])
              const [error, setError] = React.useState('')
              const node = React.useMemo(() => {
                const labels = props.node.data?.referenceLabels
                if (!labels?.some(label => parseSessionLink(label))) return props.node
                return { ...props.node, data: { ...props.node.data,
                  referenceLabels: labels.filter(label => !parseSessionLink(label)),
                } }
              }, [props.node])
              React.useLayoutEffect(() => {
                if (!links.length || !root.current) return
                return mountInlineSessionLinks(root.current, links, link => {
                  setError('')
                  void openSessionLink(ctx, link).catch(() => setError(t('链接指向的会话不存在（可能已删除或归档）。')))
                })
              }, [links])
              return h('div', { ref: root, 'data-dsh-session-message': props.node.kind, style: { display: 'contents' } },
                h(entry.component, { ...props, node }), error ? h('span', { role: 'alert' }, error) : null)
            }
            wrappers.add(LinkedMessage)
            mounted.set(entry, ctx.slots.register({ ...entry.options, name: slot,
              priority: (entry.options.priority || 0) - 1, inject: entry.inject, store: entry.store, locale: entry.locale,
            }, LinkedMessage))
          }
        } finally { syncing = false }
      }
      const off = ctx.slots.subscribe(slot, sync)
      sync()
      return () => { off(); for (const remove of mounted.values()) remove(); mounted.clear(); wrappers.clear() }
    })
  } }
} })
