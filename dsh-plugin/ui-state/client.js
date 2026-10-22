window.__ModuleLoader__.load({
  id: '@dsh-desktop/ui-state',
  factory: () => {
    function preserveDraftAttachments(ctx) {
      const { sessions, conversation } = ctx
      // Older DSH keeps input scopes resident. Watch drafts without changing
      // that lifecycle; only reference-counted services need attachment holds.
      const referenceCounted = typeof sessions.retain === 'function'
      const watched = new Map()
      let disposed = false, syncing = false, queued = false

      function forget(id, entry) {
        watched.delete(id)
        entry.offInput()
        entry.offSession()
        entry.reference?.release()
      }
      function reconcile(id, entry, allowRelease = false) {
        if (disposed || watched.get(id) !== entry) return
        if (!referenceCounted) return
        for (const attachmentId of entry.input.state.getSnapshot().attachmentIds) entry.ids.add(attachmentId)
        // Optimistic sends empty the composer before admission. The attachment
        // registry owns those bytes until success, or restores them on failure.
        entry.ids = new Set(conversation.resolveDraftAttachments([...entry.ids]).map(asset => asset.id))
        if (entry.ids.size) {
          if (!entry.reference && !entry.retaining) {
            entry.retaining = true
            try {
              entry.reference = sessions.retain(id, { source: 'desktopDraftAttachments' })
              entry.reference.ready?.catch(() => {})
            } finally { entry.retaining = false }
          }
        } else if (allowRelease && entry.reference) {
          const reference = entry.reference
          entry.reference = null
          reference.release()
        }
      }
      function settle() {
        if (disposed || queued) return
        queued = true
        // Removal/retirement may publish before releasing the attachment. Never
        // dispose an input synchronously from inside its own state notification.
        queueMicrotask(() => {
          queued = false
          if (disposed) return
          for (const [id, entry] of watched) reconcile(id, entry, true)
        })
      }
      function sync() {
        if (disposed || syncing) return
        syncing = true
        try {
          const list = sessions.list.getSnapshot()
          for (const [id, entry] of watched) {
            if (sessions.scope(id) !== entry.scope || (list.phase === 'ready' && !list.byId[id])) forget(id, entry)
          }
          for (const id of list.ids) {
            const scope = sessions.scope(id)
            if (!scope || watched.has(id)) continue
            const input = conversation.input.for(scope), session = sessions.binding(id).session
            const entry = { scope, input, ids: new Set(), reference: null, retaining: false, offInput: () => {}, offSession: () => {} }
            watched.set(id, entry)
            entry.offInput = input.state.subscribe(() => { reconcile(id, entry); settle();window.__DSH_UI_STATE__?.draftsChanged() })
            entry.offSession = session.subscribe(() => { settle();window.__DSH_UI_STATE__?.draftsChanged() })
            reconcile(id, entry)
          }
        } finally { syncing = false }
        settle()
      }
      const offList = sessions.list.subscribe(sync)
      const offCheckpointList=sessions.list.subscribe(()=>window.__DSH_UI_STATE__?.draftsChanged())
      sync()
      return () => {
        disposed = true
        offList()
        offCheckpointList()
        for (const [id, entry] of watched) forget(id, entry)
      }
    }
    return {
      inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'conversation', 'layout'],
      apply(ctx) {
        if (window.top !== window) return
        ctx.effect(() => preserveDraftAttachments(ctx), 'desktop draft attachment retention')
        if (!window.__DSH_UI_STATE__ || !window.__DSH_CREATE_UI_ADAPTER__) return
        if (window.__DSH_UI_BOOT__?.smoke) window.__DSH_SMOKE_CONTEXT__ = ctx
        ctx.effect(() => {
          const adapter = window.__DSH_CREATE_UI_ADAPTER__(ctx)
          const unregister = window.__DSH_UI_STATE__.registerAdapter(adapter)
          return () => { unregister(); adapter.dispose() }
        }, 'desktop UI snapshot adapter')
      },
    }
  },
})
