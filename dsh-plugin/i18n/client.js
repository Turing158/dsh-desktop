window.__ModuleLoader__.load({
  id: '@dsh-desktop/i18n',
  factory: () => ({ inject: ['locale'], apply(ctx) {
    ctx.effect(() => window.__DSH_I18N__?.connect(ctx.locale))
  } }),
})
