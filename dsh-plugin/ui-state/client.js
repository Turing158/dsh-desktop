window.__ModuleLoader__.load({
  id: '@dsh-desktop/ui-state',
  factory: () => ({
    inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'conversation', 'layout'],
    apply(ctx) {
      if (window.top !== window || !window.__DSH_UI_STATE__ || !window.__DSH_CREATE_UI_ADAPTER__) return
      if (window.__DSH_UI_BOOT__?.smoke) window.__DSH_SMOKE_CONTEXT__ = ctx
      ctx.effect(() => {
        const adapter = window.__DSH_CREATE_UI_ADAPTER__(ctx)
        const unregister = window.__DSH_UI_STATE__.registerAdapter(adapter)
        return () => { unregister(); adapter.dispose() }
      }, 'desktop UI snapshot adapter')
    },
  }),
})
