// Match PluginInventorySettingsTab's tokens and spacing without its private CSS
// hashes. Switch itself is the upstream UI primitive.
export default `
.dshPlugins{--dsh-plugins-motion:220ms;--dsh-plugins-ease:cubic-bezier(.2,.8,.2,1);width:100%;max-width:760px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);container:dsh-plugins/inline-size}
.dshPlugins p{margin:0;font-size:13px;line-height:20px}
.dshPlugins__intro,.dshPlugins__footnote{color:var(--dsw-alias-label-tertiary)}
.dshPlugins__marketplaceHeader:empty{display:none}
.dshPlugins__marketplace{display:flex;align-items:center;gap:16px;padding:14px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.dshPlugins__marketplaceText{flex:1;min-width:0;overflow-wrap:anywhere}.dshPlugins__marketplaceText strong{font-size:14px;line-height:20px;font-weight:500}
.dshPlugins__marketplaceText p{margin-top:4px;color:var(--dsw-alias-label-secondary)}
.dshPlugins__cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:10px;list-style:none;margin:0;padding:0}
.dshPlugins__card{display:flex;flex-direction:column;min-width:0;overflow:hidden;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);transition:border-color 180ms ease,box-shadow 180ms ease}
.dshPlugins__card[data-open=true]{border-color:var(--dsw-alias-border-l3)}
.dshPlugins__card:focus-within{border-color:var(--dsw-alias-border-l3)}
@media(hover:hover){.dshPlugins__card:hover{border-color:var(--dsw-alias-border-l3);box-shadow:0 2px 8px rgb(0 0 0 / .08)}.dshPlugins__card:hover>.dshPlugins__head{background:var(--dsw-alias-interactive-bg-hover)}}
.dshPlugins__head{display:flex;align-items:flex-start;transition:background-color 180ms ease}
.dshPlugins__disclosure{box-sizing:border-box;display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;min-height:52px;padding:12px 0 12px 14px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshPlugins__card[data-open=true]>.dshPlugins__head{background:var(--dsw-alias-interactive-bg-hover)}
.dshPlugins__titleRow{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dshPlugins__titleRow strong{min-width:0;font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.dshPlugins__chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform 180ms ease}
.dshPlugins__card[data-open=true] .dshPlugins__chevron{transform:rotate(180deg)}
.dshPlugins__description{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-wrap:pretty;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dshPlugins__card[data-open=true] .dshPlugins__description{display:block}
.dshPlugins__switch{display:flex;align-items:center;justify-content:center;flex:none;width:56px;min-height:44px;padding-top:2px}
.dshPlugins .dshPlugins__switch [role=switch]{transition:background-color 180ms ease,opacity 180ms ease,box-shadow 180ms ease}
.dshPlugins .dshPlugins__switch [role=switch]>span{transition:transform 180ms var(--dsh-plugins-ease),background-color 180ms ease}
.dshPlugins__switch button:before{content:'';position:absolute;inset:-12px -4px}
.dshPlugins__phase{display:inline-flex;align-items:center;gap:6px;margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshPlugins__dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:background-color 180ms ease}
.dshPlugins__dot[data-phase=active]{background:var(--dsw-alias-state-success-primary,#2e8b57)}
.dshPlugins__dot[data-phase=failed]{background:var(--dsw-alias-state-error-primary)}
.dshPlugins__details{border-top:.5px solid var(--dsw-alias-border-l2);padding:12px 14px;font-size:12px;line-height:18px}
.dshPlugins__details dl{display:grid;gap:8px;margin:0}.dshPlugins__details dl>div{display:flex;justify-content:space-between;gap:12px}
.dshPlugins__details dt,.dshPlugins__details p{color:var(--dsw-alias-label-tertiary)}.dshPlugins__details dd{margin:0;text-align:right}
.dshPlugins__details p{margin-top:10px;font-size:12px;line-height:18px}
.dshPlugins__details dd{min-width:0;overflow-wrap:anywhere}
.dshPlugins__reveal{display:grid;grid-template-rows:0fr;visibility:hidden;transition:grid-template-rows var(--dsh-plugins-motion) var(--dsh-plugins-ease),visibility var(--dsh-plugins-motion)}
.dshPlugins__reveal[data-open=true]{grid-template-rows:1fr;visibility:visible}
.dshPlugins__revealClip{min-height:0;overflow:hidden}
.dshPlugins__revealContent{opacity:0;transform:translateY(-4px);transition:opacity var(--dsh-plugins-motion) ease,transform var(--dsh-plugins-motion) var(--dsh-plugins-ease)}
.dshPlugins__reveal[data-open=true]>.dshPlugins__revealClip>.dshPlugins__revealContent{opacity:1;transform:translateY(0)}
.dshPlugins__restartReveal>.dshPlugins__revealClip>.dshPlugins__revealContent{padding-top:14px}
.dshPlugins__restart{display:flex;align-items:center;gap:16px;padding:14px 16px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#9a6700) 32%,var(--dsw-alias-settings-card-stroke));border-radius:var(--dsw-radius-xl);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#9a6700) 8%,var(--dsw-alias-settings-card-fill))}
.dshPlugins__restartText{flex:1;min-width:0;overflow-wrap:anywhere}.dshPlugins__restartText strong{font-size:14px;line-height:20px;font-weight:500}
.dshPlugins__restartText p{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshPlugins button{cursor:pointer}.dshPlugins button:disabled{cursor:default;opacity:.5}
.dshPlugins__restartButton{flex:none;min-height:36px;padding:8px 14px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:13px;line-height:20px;transition:filter 180ms ease}
.dshPlugins__restartButton:hover:not(:disabled){filter:brightness(.92)}
.dshPlugins button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dshPlugins__disclosure:focus-visible{outline-offset:-2px}
.dshPlugins .dshPlugins__error{color:var(--dsw-alias-state-error-primary)}.dshPlugins__cardError{padding:0 14px 12px}
@container dsh-plugins (width<=520px){.dshPlugins__cards{grid-template-columns:minmax(0,1fr)}}
@container dsh-plugins (width<=400px){.dshPlugins__restart{align-items:stretch;flex-direction:column;gap:12px}.dshPlugins__restartButton{align-self:flex-start;min-height:44px}}
@container dsh-plugins (width<=400px){.dshPlugins__marketplace{align-items:stretch;flex-direction:column;gap:12px}}
@media(prefers-reduced-motion:reduce){html:not([data-dsh-desktop-animation=on]) .dshPlugins *,html:not([data-dsh-desktop-animation=on]) .dshPlugins *::before,html:not([data-dsh-desktop-animation=on]) .dshPlugins *::after{transition:none!important;animation:none!important}}
html[data-dsh-desktop-animation=off] .dshPlugins *,html[data-dsh-desktop-animation=off] .dshPlugins *::before,html[data-dsh-desktop-animation=off] .dshPlugins *::after{transition:none!important;animation:none!important}
`
