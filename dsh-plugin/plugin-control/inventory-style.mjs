// Original DSH inventory spacing, controls and card surfaces, scoped separately
// from the desktop builtin cards. The only added affordance is the global switch.
export default `
.dshInventory{container-name:dsh-plugins dsh-inventory}
.dshInventory__catalog{display:flex;flex-direction:column;gap:12px}
.dshInventory .dshInventory__status{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dshInventory__search{display:flex;align-items:center;position:relative;width:100%;color:var(--dsw-alias-label-tertiary)}
.dshInventory__search>svg{position:absolute;left:12px;pointer-events:none}
.dshInventory__search input{box-sizing:border-box;width:100%;height:36px;padding:0 34px 0 36px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dshInventory__search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshInventory__search input:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%,transparent)}
.dshInventory__group{display:flex;flex-direction:column;gap:10px}
.dshInventory__group+.dshInventory__group{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px}
.dshInventory__groupTitleRow{display:flex;align-items:center;gap:8px;min-height:36px}
.dshInventory__groupToggle{display:flex;align-items:center;gap:8px;flex:none;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshInventory__groupToggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshInventory__groupToggle>.dshInventory__chevron{transform:rotate(-90deg)}
.dshInventory__groupToggle[aria-expanded=true]>.dshInventory__chevron{transform:none}
.dshInventory__groupTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.dshInventory .dshInventory__groupSub{display:flex;flex-wrap:wrap;row-gap:4px;margin:-6px 0 0 20px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshInventory__groupSub>*+*:before{content:'·';padding:0 6px;color:var(--dsw-alias-label-tertiary)}
.dshInventory__failedCount{color:var(--dsw-alias-state-error-primary)}
.dshInventory__headerEnd{margin-left:auto;min-width:0}
.dshInventory__switcher{display:inline-flex;align-items:center;gap:12px;flex:none;max-width:100%;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}
.dshInventory__switcher:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshInventory__switcherLabel{max-width:240px;overflow:hidden;text-overflow:ellipsis}
.dshInventory__groupBody{display:flex;flex-direction:column;gap:10px}
.dshInventory__cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:10px}
.dshInventory__column{display:flex;flex-direction:column;gap:10px;min-width:0;margin:0;padding:0;list-style:none}
.dshInventory__column:empty{display:none}
.dshInventory .dshInventory__column>.dshInventory__card{align-self:stretch}
.dshInventory__card{display:flex;flex-direction:column;min-width:0;overflow:hidden;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.dshInventory__card[data-open=true]{border-color:var(--dsw-alias-border-l3)}
.dshInventory__card[data-failed=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.dshInventory__cardHead{position:relative;display:flex;flex:1}
.dshInventory__cardContent{box-sizing:border-box;display:flex;flex:auto;flex-direction:column;align-items:stretch;gap:2px;width:100%;min-width:0;min-height:52px;padding:12px 14px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshInventory__cardContent:hover,.dshInventory__card[data-open=true] .dshInventory__cardContent{background:var(--dsw-alias-interactive-bg-hover)}
.dshInventory .dshInventory__cardContent:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dshInventory__cardMainRow{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dshInventory__card[data-switch=true] .dshInventory__cardMainRow{padding-right:42px}
.dshInventory__cardTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px}
.dshInventory__cardTrailing{display:inline-flex;align-items:center;gap:8px;flex:none;color:var(--dsw-alias-label-tertiary)}
.dshInventory__phaseDot{display:inline-flex;flex:none}
.dshInventory__chevron{flex:none;color:var(--dsw-alias-label-tertiary)}
.dshInventory__card[data-open=true] .dshInventory__chevron{transform:rotate(180deg)}
.dshInventory__cardDescription{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-wrap:pretty}
.dshInventory__card[data-open=true] .dshInventory__cardDescription{display:block}
.dshInventory__cardMeta{display:flex;margin-top:auto;padding-top:6px}
.dshInventory__cardIdentity,.dshInventory__entryValue{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px}
.dshInventory__cardIdentity{box-sizing:border-box;display:block;max-width:100%;padding:1px 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshInventory__cardSwitch{position:absolute;top:12px;right:14px;display:flex;align-items:center;min-height:20px}
.dshInventory__cardSwitch button:before{content:'';position:absolute;inset:-10px -5px}
.dshInventory__cardDetails{padding:10px 14px 12px;border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform)}
.dshInventory__entryValue{display:block;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.dshInventory__details{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px 10px;margin:8px 0 0}
.dshInventory__details div{display:contents}
.dshInventory__details dt{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dshInventory__details dd{min-width:0;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.dshInventory .dshInventory__detailNote{margin-top:10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshInventory .dshInventory__brokenNote{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-lg);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;white-space:pre-line}
.dshInventory .dshInventory__hint{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshInventory__jumpLink{padding:0;border:0;background:none;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;cursor:pointer}
.dshInventory__enabledIn{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
@media(prefers-reduced-motion:no-preference){.dshInventory__chevron{transition:transform .14s var(--ds-ease-in-out)}}
@container dsh-inventory (width<=520px){.dshInventory__cards{grid-template-columns:minmax(0,1fr)}}
`
