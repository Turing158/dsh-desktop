(() => {
  // dsh-plugin/i18n/api.mjs
  function t(source, values) {
    const runtime = globalThis.window?.__DSH_I18N__;
    if (runtime) return runtime.t(source, values);
    return typeof source === "string" ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source;
  }
  function useLocale(React) {
    globalThis.window?.__DSH_I18N__?.use(React);
  }

  // dsh-plugin/plugin-control/protocol.mjs
  var codec = (name) => ({
    mode: "strict",
    typeSymbol: "@dsh-desktop/plugin-control#" + name,
    create: () => ({ parse(value) {
      if (name === "enabled" ? typeof value !== "boolean" : typeof value !== "string" || !value || value.length > (name === "entryId" ? 1024 : 80)) throw Error("Invalid plugin switch");
      return value;
    } })
  });
  var contribution = { package: "@dsh-desktop/plugin-control", descriptors: [
    ["status", []],
    ["setEnabled", ["id", "enabled"]],
    ["setPluginEnabled", ["entryId", "enabled"]],
    ["installMarketplace", []]
  ].map(([method, args]) => ({
    id: "desktopPlugins/" + method,
    service: "desktopPlugins",
    namespace: "desktopPlugins",
    method,
    invocation: { kind: "direct" },
    parameters: args.map((name) => ({ name, wire: name, source: "json", codec: codec(name) })),
    result: { mode: "src-json" }
  })) };

  // dsh-plugin/plugin-control/style.mjs
  var style_default = `
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
`;

  // dsh-plugin/plugin-control/inventory-style.mjs
  var inventory_style_default = `
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
.dshInventory__groupSub>*+*:before{content:'\xB7';padding:0 6px;color:var(--dsw-alias-label-tertiary)}
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
`;

  // dsh-plugin/plugin-control/inventory-view.mjs
  function presetInventoryRow(row, preset, index, plugins) {
    const candidates = plugins.filter((plugin) => plugin.moduleName === row.moduleName);
    const exact = candidates.filter((plugin) => row.entryId && plugin.entryId === row.entryId);
    const matches = exact.length ? exact : candidates;
    const target = matches.length === 1 ? matches[0] : null;
    return {
      ...row,
      ...target || {},
      source: "preset",
      id: `preset:${preset.id}:${index}`,
      presetName: preset.name,
      switchId: target?.id,
      presetEnabled: row.enabled,
      enabled: target?.enabled ?? row.enabled === true,
      conditional: !target && row.enabled === "conditional",
      readOnlyReason: target ? target.readOnlyReason : "unaddressable",
      phase: target?.phase ?? (row.enabled === false ? "disabled" : row.fiberPhase || "inactive")
    };
  }
  function renderPluginColumns(h, cards) {
    const split = Math.ceil(cards.length / 2);
    return h(
      "div",
      { className: "dshInventory__cards" },
      [cards.slice(0, split), cards.slice(split)].map((column, index) => h("ul", { key: index, className: "dshInventory__column" }, column))
    );
  }
  function createInventoryView({ React, ui, useStatus, RestartCard, ClientSync, displayRow, change, refresh, feedback, isBusy, readOnlyText, phases, presetName }) {
    const h = React.createElement;
    const { Switch, Menu, Tag, StateDot, IconSearchOutlineRegular: Search, IconChevronDownOutlineRegular: Chevron } = ui;
    const cls = (name) => "dshInventory__" + name;
    const subtitle = (id) => id?.replace(/^include:/, "");
    const hasIdentity = (row) => row.entryId && subtitle(row.entryId) !== row.label;
    function Card({ row, open, toggle, providers, onPreset }) {
      useLocale(React);
      const detailId = "plugin-details-" + encodeURIComponent(row.id), descriptionId = React.useId();
      const description = row.meta?.description ? row.hint : void 0;
      const failed = Boolean(row.error) || row.fiberPhase === "failed";
      const kind = failed ? "danger" : row.restart || row.application === "overridden" || row.conditional ? "warning" : providers?.length ? "info" : "neutral";
      const stateText = row.error ? t("\u5207\u6362\u5931\u8D25") : failed ? t("\u542F\u52A8\u5931\u8D25") : row.restart ? t("\u7B49\u5F85\u91CD\u542F") : row.application === "overridden" ? t("\u914D\u7F6E\u672A\u751F\u6548") : row.conditional ? t("\u6761\u4EF6\u542F\u7528") : providers?.length ? t("\u9884\u8BBE\u4E2D\u542F\u7528") : row.enabled ? t("\u5DF2\u542F\u7528") : t("\u5DF2\u505C\u7528");
      const dot = (row.running ?? row.enabled) && { pending: "idle", loading: "ongoing", unloading: "ongoing" }[row.fiberPhase];
      const facts = row.source === "preset" ? [
        [t("\u6765\u81EA"), row.presetName],
        [t("\u5168\u5C40\u5F00\u5173"), row.enabled ? t("\u5DF2\u542F\u7528") : t("\u5DF2\u505C\u7528")],
        [t("\u9884\u8BBE\u914D\u7F6E"), row.presetEnabled === "conditional" ? t("\u6761\u4EF6\u542F\u7528") : row.presetEnabled ? t("\u5DF2\u542F\u7528") : t("\u5DF2\u505C\u7528")],
        [t("\u751F\u6548\u65B9\u5F0F"), row.readOnlyReason ? readOnlyText(row.readOnlyReason) : row.hot ? t("\u7ACB\u5373\u751F\u6548") : t("\u91CD\u542F DSH \u540E\u751F\u6548")],
        ...row.fiberPhase ? [[t("\u8FD0\u884C\u72B6\u6001"), phases[row.fiberPhase]]] : [],
        ...row.condition ? [[t("\u7981\u7528\u6761\u4EF6"), h("code", null, row.condition)]] : []
      ] : [
        [t("\u914D\u7F6E\u72B6\u6001"), providers?.length ? t("\u5168\u5C40\u5DF2\u505C\u7528\uFF0C\u7531 Agent \u9884\u8BBE\u6309\u4F1A\u8BDD\u63D0\u4F9B") : row.enabled ? t("\u5DF2\u542F\u7528") : t("\u5DF2\u505C\u7528")],
        ...providers?.length ? [[t("\u542F\u7528\u4E8E"), h(
          "span",
          { className: cls("enabledIn") },
          h("span", null, providers.map(presetName).join(" \xB7 ")),
          h("button", { type: "button", className: cls("jumpLink"), onClick: () => onPreset(providers[0].id) }, t("\u53BB\u9884\u8BBE\u5206\u7EC4\u67E5\u770B"))
        )]] : [[t("\u8FD0\u884C\u72B6\u6001"), phases[row.phase] || row.phase]],
        [t("\u751F\u6548\u65B9\u5F0F"), row.readOnlyReason ? readOnlyText(row.readOnlyReason) : row.hot ? t("\u7ACB\u5373\u751F\u6548") : t("\u91CD\u542F DSH \u540E\u751F\u6548")],
        ...row.version ? [[t("\u7248\u672C"), row.version]] : []
      ];
      return h(
        "li",
        {
          className: cls("card"),
          "data-plugin-id": row.id,
          "data-plugin-entry": row.entryId || void 0,
          "data-plugin-module": row.moduleName,
          "data-open": open ? "true" : void 0,
          "data-failed": failed ? "true" : void 0,
          "data-switch": "true"
        },
        h(
          "div",
          { className: cls("cardHead") },
          h(
            "button",
            {
              type: "button",
              className: cls("cardContent"),
              "aria-expanded": open,
              "aria-controls": detailId,
              "aria-label": `${row.label}${hasIdentity(row) ? ", " + row.entryId : ""}, ${stateText}`,
              "aria-describedby": description ? descriptionId : void 0,
              onClick: toggle
            },
            h(
              "span",
              { className: cls("cardMainRow") },
              h("strong", { className: cls("cardTitle"), title: row.moduleName }, row.label),
              h(
                "span",
                { className: cls("cardTrailing") },
                dot && h("span", { className: cls("phaseDot"), role: "img", "aria-label": phases[row.fiberPhase], title: phases[row.fiberPhase] }, h(StateDot, { state: dot })),
                stateText !== t("\u5DF2\u542F\u7528") && h(Tag, { tone: kind }, stateText),
                h(Chevron, { className: cls("chevron"), size: 12, "aria-hidden": true })
              )
            ),
            description && h("span", { className: cls("cardDescription"), id: descriptionId }, description),
            hasIdentity(row) && h("span", { className: cls("cardMeta") }, h("code", { className: cls("cardIdentity"), title: row.entryId }, subtitle(row.entryId)))
          ),
          h("div", { className: cls("cardSwitch") }, h(Switch, {
            checked: row.enabled,
            label: row.label,
            disabled: isBusy() || Boolean(row.readOnlyReason),
            onChange: (enabled) => change(row.switchId || row.id, enabled, "profile")
          }))
        ),
        row.meta?.error && h("p", { className: cls("brokenNote"), role: "status" }, row.meta.error),
        open && h(
          "div",
          { className: cls("cardDetails"), id: detailId },
          row.entryId && h("code", { className: cls("entryValue"), "data-loader-entry": true }, row.entryId),
          h("dl", { className: cls("details") }, [[t("\u5B8C\u6574\u540D\u79F0"), row.moduleName], ...facts].map(([label, value]) => h("div", { key: label }, h("dt", null, label), h("dd", null, value)))),
          row.hotReason && !row.readOnlyReason && h("p", { className: cls("detailNote") }, row.hotReason),
          row.restart && h("p", { className: cls("detailNote") }, t("\u5DF2\u4FDD\u5B58\uFF0C\u91CD\u542F\u540E\u751F\u6548\u3002\u6539\u56DE\u5F53\u524D\u8FD0\u884C\u72B6\u6001\u53EF\u53D6\u6D88\u3002")),
          row.application === "overridden" && h("p", { className: cls("brokenNote") }, t("\u5DF2\u4FDD\u5B58\u8BBE\u7F6E\u4E0E\u5B9E\u9645\u72B6\u6001\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u68C0\u67E5\u7236\u7EC4\u3001\u914D\u7F6E\u8986\u76D6\u6216\u542F\u52A8\u8BCA\u65AD\u3002"))
        ),
        row.error && h(
          "p",
          { className: cls("brokenNote"), role: "alert" },
          row.error,
          " ",
          h("button", { type: "button", disabled: isBusy() || Boolean(row.readOnlyReason), onClick: () => change(row.switchId || row.id, row.enabled, "profile") }, t("\u91CD\u8BD5\u5207\u6362"))
        )
      );
    }
    return function Inventory() {
      useLocale(React);
      const state = useStatus(), sectionId = React.useId();
      const [query, setQuery] = React.useState(""), [chosenPreset, setChosenPreset] = React.useState(null), [expanded, setExpanded] = React.useState(null);
      const [switcherOpen, setSwitcherOpen] = React.useState(false), [presetOpen, setPresetOpen] = React.useState(true), [globalOpen, setGlobalOpen] = React.useState(false);
      const presets = state?.agentPresets || [], selected = presets.find((p) => p.id === chosenPreset) || presets.find((p) => p.isDefault) || presets[0];
      const search = query.trim().toLocaleLowerCase(), searching = Boolean(search);
      const matches = (row) => !search || [row.label, row.hint, row.moduleName, row.entryId].some((text) => text?.toLocaleLowerCase().includes(search));
      const presetRows = (p) => p.rows.map((row, index) => displayRow(presetInventoryRow(row, { ...p, name: presetName(p) }, index, state?.plugins || [])));
      const selectedRows = selected ? presetRows(selected).filter(matches) : [];
      const otherMatches = searching ? presets.filter((p) => p !== selected).map((p) => ({ preset: p, count: presetRows(p).filter(matches).length })).filter((p) => p.count) : [];
      const globalRows = (state?.plugins || []).map(displayRow).filter(matches);
      const failedRows = globalRows.filter((row) => row.fiberPhase === "failed" || row.error);
      const sortedRows = [...failedRows, ...globalRows.filter((row) => !failedRows.includes(row))];
      const enabledIn = (moduleName) => presets.filter((p) => p.rows.some((row) => row.moduleName === moduleName && row.enabled === true));
      const toggleRow = (id) => setExpanded((current) => current === id ? null : id);
      const showPreset = (id) => {
        setChosenPreset(id);
        setPresetOpen(true);
      };
      const presetLabel = (p) => presetName(p) + (p.broken ? t("\uFF08\u52A0\u8F7D\u5931\u8D25\uFF09") : p.isDefault ? t("\uFF08\u9ED8\u8BA4\uFF09") : "");
      const error = feedback();
      const cards = (rows) => renderPluginColumns(h, rows.map((row) => h(Card, {
        key: row.id,
        row,
        open: expanded === row.id,
        toggle: () => toggleRow(row.id),
        providers: row.source === "profile" && !row.running && !row.restart ? enabledIn(row.moduleName) : [],
        onPreset: showPreset
      })));
      const groupToggle = (title, id, open, onToggle) => h(
        "button",
        { type: "button", className: cls("groupToggle"), "aria-expanded": open, "aria-controls": id, onClick: onToggle },
        h(Chevron, { className: cls("chevron"), size: 12, "aria-hidden": true }),
        h("span", { className: cls("groupTitle") }, title)
      );
      const presetEffectiveOpen = searching || presetOpen, globalEffectiveOpen = searching || globalOpen;
      return h(
        "div",
        { className: "dshPlugins dshInventory", "data-dsh-plugin-inventory": true, "aria-busy": !state },
        h(
          "div",
          { className: "dshPlugins__summary" },
          h("p", { className: "dshPlugins__intro" }, t("\u5F00\u5173\u4F1A\u81EA\u52A8\u4FDD\u5B58\u3002\u652F\u6301\u70ED\u5207\u6362\u7684\u63D2\u4EF6\u7ACB\u5373\u751F\u6548\uFF0C\u5176\u4F59\u63D2\u4EF6\u5728\u91CD\u542F DSH \u540E\u751F\u6548\u3002")),
          h(RestartCard, { state })
        ),
        h(ClientSync),
        error && h("p", { role: "alert", className: cls("brokenNote") }, error, " ", h("button", { type: "button", onClick: refresh }, t("\u91CD\u8BD5"))),
        (state?.notices || []).map((notice, index) => h("p", { key: index, className: cls("brokenNote") }, notice)),
        !state ? h("p", { role: "status" }, t("\u6B63\u5728\u8BFB\u53D6\u63D2\u4EF6\u2026")) : h(
          "div",
          { className: cls("catalog") },
          h(
            "label",
            { className: cls("search") },
            h(Search, { "aria-hidden": true }),
            h("input", { type: "search", "aria-label": t("\u641C\u7D22\u63D2\u4EF6"), placeholder: t("\u641C\u7D22\u63D2\u4EF6"), value: query, onChange: (event) => setQuery(event.target.value) })
          ),
          !state.managementAvailable && h("p", { className: cls("status") }, t("\u5F53\u524D\u5BBF\u4E3B\u4E0D\u63D0\u4F9B\u63D2\u4EF6\u7BA1\u7406\uFF0C\u5217\u8868\u4EC5\u4F9B\u67E5\u770B\u3002")),
          searching && !globalRows.length && !selectedRows.length && !otherMatches.length && h("p", { className: cls("status") }, t("\u6CA1\u6709\u5339\u914D\u7684\u63D2\u4EF6")),
          selected && h(
            "section",
            { className: cls("group"), "data-plugin-scope": "preset", "data-preset-id": selected.id },
            h(
              "div",
              { className: cls("groupTitleRow") },
              groupToggle(t("\u4F1A\u8BDD\u63D2\u4EF6"), sectionId + "-preset", presetEffectiveOpen, () => setPresetOpen(!presetEffectiveOpen)),
              h("div", { className: cls("headerEnd") }, h(Menu, {
                open: switcherOpen,
                onClose: () => setSwitcherOpen(false),
                items: presets.map((p) => ({ id: p.id, label: presetLabel(p) })),
                selectedId: selected.id,
                onSelect: (id) => {
                  setSwitcherOpen(false);
                  setChosenPreset(id);
                },
                align: "end",
                portal: true,
                anchor: h(
                  "button",
                  {
                    type: "button",
                    className: cls("switcher"),
                    "aria-haspopup": "menu",
                    "aria-expanded": switcherOpen,
                    "aria-label": t("\u9009\u62E9\u8981\u67E5\u770B\u7684 Agent \u9884\u8BBE"),
                    onClick: () => setSwitcherOpen((open) => !open)
                  },
                  h("span", { className: cls("switcherLabel") }, presetLabel(selected)),
                  h(Chevron, { className: cls("chevron"), "aria-hidden": true })
                )
              }))
            ),
            h("p", { className: cls("groupSub") }, h("span", null, t("\u7531 Agent \u9884\u8BBE\u6309\u4F1A\u8BDD\u7EC4\u6210\uFF0C\u5F00\u5173\u4E0E\u5168\u5C40\u63D2\u4EF6\u540C\u6B65")), h("span", { "data-preset-plugin-count": selectedRows.length }, selectedRows.length + t(" \u4E2A"))),
            presetEffectiveOpen && h(
              "div",
              { id: sectionId + "-preset", className: cls("groupBody") },
              selected.broken && h("p", { className: cls("brokenNote"), role: "alert" }, selected.broken),
              selectedRows.length > 0 && cards(selectedRows),
              otherMatches.length > 0 && h(
                "p",
                { className: cls("hint") },
                t("\u5176\u4ED6\u9884\u8BBE\u4E2D\u8FD8\u6709 {0} \u4E2A\u5339\u914D\uFF1A", [otherMatches.reduce((n, p) => n + p.count, 0)]),
                otherMatches.map(({ preset }) => h("button", { key: preset.id, type: "button", className: cls("jumpLink"), onClick: () => showPreset(preset.id) }, presetName(preset)))
              )
            )
          ),
          state.plugins?.length > 0 && h(
            "section",
            { className: cls("group"), "data-plugin-scope": "global" },
            h("div", { className: cls("groupTitleRow") }, groupToggle(t("\u5168\u5C40\u63D2\u4EF6"), sectionId + "-global", globalEffectiveOpen, () => setGlobalOpen(!globalEffectiveOpen))),
            h(
              "p",
              { className: cls("groupSub") },
              h("span", null, t("\u7CFB\u7EDF\u4E0E\u6240\u6709\u4F1A\u8BDD\u5171\u7528")),
              h("span", { "data-plugin-count": globalRows.length }, globalRows.length + t(" \u4E2A")),
              failedRows.length > 0 && h("span", { className: cls("failedCount") }, failedRows.length + t(" \u4E2A\u5931\u8D25"))
            ),
            globalEffectiveOpen && h("div", { id: sectionId + "-global", className: cls("groupBody") }, cards(sortedRows))
          ),
          !presets.length && !state.plugins?.length && h("p", { className: cls("status") }, t("\u6682\u65E0\u63D2\u4EF6\u3002"))
        )
      );
    };
  }

  // dsh-plugin/plugin-control/marketplace-view.mjs
  function mountMarketplaceHeader(React, createRoot, Prompt) {
    let container = null, root = null;
    const clear = () => {
      root?.unmount();
      container?.remove();
      root = null;
      container = null;
    };
    const update = () => {
      const tab = document.querySelector('[data-shortcut-modal="settings"] [role="tab"][id$="-tab-desktop-builtins"]');
      const tabs = tab?.closest('[role="tablist"]');
      if (container?.isConnected && container.nextSibling === tabs) return;
      clear();
      if (!tabs) return;
      container = document.createElement("div");
      container.className = "dshPlugins dshPlugins__marketplaceHeader";
      tabs.before(container);
      root = createRoot(container);
      root.render(React.createElement(Prompt));
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    update();
    return () => {
      observer.disconnect();
      clear();
    };
  }
  function createMarketplacePrompt(React, { useStatus, install, refresh, isBusy }) {
    const h = React.createElement;
    return function MarketplacePrompt() {
      useLocale(React);
      const market = useStatus()?.marketplace;
      if (!market || market.installed && !market.error) return null;
      const checking = market.installed === null;
      return h(
        "section",
        { className: "dshPlugins__marketplace", "aria-label": t("\u63D2\u4EF6\u5E02\u573A") },
        h(
          "div",
          { className: "dshPlugins__marketplaceText" },
          h("strong", null, t("\u63D2\u4EF6\u5E02\u573A")),
          h("p", null, t("\u5B89\u88C5 dshmarket\uFF0C\u6D4F\u89C8\u3001\u641C\u7D22\u548C\u5B89\u88C5\u793E\u533A\u63D2\u4EF6\u3002")),
          market.installing && h("p", { role: "status" }, t("\u6B63\u5728\u5B89\u88C5 dshmarket\u2026")),
          market.error && h("p", { className: "dshPlugins__error", role: "alert" }, market.error),
          !market.available && h("p", null, t("\u5F53\u524D\u5BBF\u4E3B\u4E0D\u63D0\u4F9B\u63D2\u4EF6\u5B89\u88C5\u670D\u52A1\u3002"))
        ),
        !market.installed && h(
          "button",
          {
            type: "button",
            className: "dshPlugins__restartButton",
            disabled: isBusy() || market.installing || !market.available,
            onClick: checking ? refresh : install
          },
          market.installing ? t("\u6B63\u5728\u5B89\u88C5\u2026") : checking ? t("\u91CD\u65B0\u68C0\u67E5") : market.error ? t("\u91CD\u8BD5\u5B89\u88C5") : t("\u5B89\u88C5\u63D2\u4EF6\u5E02\u573A")
        )
      );
    };
  }

  // dsh-plugin/plugin-control/client-entry.mjs
  window.__ModuleLoader__.load({ id: "@dsh-desktop/plugin-control", factory(require2) {
    const React = require2("react"), h = React.createElement;
    const { createRoot } = require2("react-dom/client");
    const ui = require2("@deepseek-ai/dsh-client-ui-primitives");
    const { Switch, Tag, StateDot, IconChevronDownOutlineRegular: Chevron } = ui;
    const phases = { get active() {
      return t("\u8FD0\u884C\u4E2D");
    }, get disabled() {
      return t("\u5DF2\u5173\u95ED");
    }, get inactive() {
      return t("\u672A\u8FD0\u884C");
    }, get pending() {
      return t("\u7B49\u5F85\u4F9D\u8D56");
    }, get loading() {
      return t("\u52A0\u8F7D\u4E2D");
    }, get failed() {
      return t("\u52A0\u8F7D\u5931\u8D25");
    }, get unloading() {
      return t("\u5378\u8F7D\u4E2D");
    } };
    const desktop = () => window.top === window && Boolean(window.__TAURI__?.core?.invoke);
    const errorText = (error) => error?.message || (typeof error === "string" ? error : t("\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"));
    const readOnlyText = (reason) => ({
      "management-required": t("\u57FA\u7840\u670D\u52A1\uFF0C\u4E0D\u652F\u6301\u5728\u6B64\u4FEE\u6539"),
      "unaddressable": t("\u65E0\u6CD5\u552F\u4E00\u5B9A\u4F4D\u914D\u7F6E\uFF0C\u6682\u4E0D\u652F\u6301\u4FEE\u6539"),
      "management-unavailable": t("\u5F53\u524D\u5BBF\u4E3B\u4E0D\u63D0\u4F9B\u63D2\u4EF6\u7BA1\u7406"),
      "desktop-managed": t("\u7531\u684C\u9762\u63D2\u4EF6\u8BBE\u7F6E\u7EDF\u4E00\u7BA1\u7406"),
      "preset": t("\u7531 Agent \u9884\u8BBE\u7BA1\u7406")
    })[reason] || reason;
    const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, { ...args, identity: window.__DSH_REMOTE_IDENTITY__ });
    function Reveal({ open, children, id, className = "" }) {
      const element = React.useRef(null), lastContent = React.useRef(null);
      const [retained, setRetained] = React.useState(open);
      if (open) lastContent.current = children;
      if (open && !retained) setRetained(true);
      React.useLayoutEffect(() => {
        element.current.inert = !open;
        if (open) return;
        let current = true;
        const transitions = element.current.getAnimations({ subtree: true });
        const clear = () => {
          if (current) {
            lastContent.current = null;
            setRetained(false);
          }
        };
        if (transitions.length) Promise.allSettled(transitions.map((animation) => animation.finished)).then(clear);
        else clear();
        return () => {
          current = false;
        };
      }, [open]);
      return h(
        "div",
        {
          ref: element,
          id,
          className: "dshPlugins__reveal " + className,
          "data-open": open ? "true" : void 0,
          "aria-hidden": !open
        },
        h(
          "div",
          { className: "dshPlugins__revealClip" },
          h("div", { className: "dshPlugins__revealContent" }, (open || retained) && lastContent.current)
        )
      );
    }
    function renameSettingsHeadings() {
      const changed = /* @__PURE__ */ new Map();
      const update = () => {
        for (const node of changed.keys()) if (!node.isConnected) changed.delete(node);
        for (const element of document.querySelectorAll('[data-shortcut-modal="settings"] :is(button, h2)')) {
          if (element.getAttribute("role") === "tab") continue;
          if (element.textContent.trim() !== t("\u5185\u7F6E\u63D2\u4EF6")) continue;
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node; node = walker.nextNode(); ) if (node.textContent.trim() === t("\u5185\u7F6E\u63D2\u4EF6")) {
            changed.set(node, node.textContent);
            node.textContent = node.textContent.replace(t("\u5185\u7F6E\u63D2\u4EF6"), t("\u63D2\u4EF6"));
          }
        }
      };
      const observer = new MutationObserver(update);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      update();
      return () => {
        observer.disconnect();
        for (const [node, text] of changed) if (node.textContent.trim() === t("\u63D2\u4EF6")) node.textContent = text;
      };
    }
    function install(ctx) {
      if (window.__DSH_UI_BOOT__?.smoke) window.__DSH_PLUGIN_SMOKE_CONTEXT__ = ctx;
      let snapshot = null, error = "", busy = false, disposed = false, polling = false, revision = 0;
      let restarting = false, restartError = "";
      const listeners = /* @__PURE__ */ new Set();
      const publish = () => listeners.forEach((fn) => fn());
      const offRestart = desktop() ? window.__DSH_UI_STATE__?.registerRestartAdapter(() => window.__DSH_CREATE_UI_ADAPTER__?.(ctx)) : null;
      async function call(method, ...args) {
        const result = await ctx.remote.desktopPlugins[method](...args);
        if (!result.ok) throw Error(result.error.message);
        return result.value;
      }
      async function refresh() {
        if (busy || restarting || polling || disposed) return;
        polling = true;
        const current = revision;
        try {
          const next = await call("status");
          if (!disposed && current === revision) {
            snapshot = next;
            error = "";
            publish();
          }
        } catch (e) {
          if (!disposed && current === revision) {
            error = errorText(e);
            publish();
          }
        } finally {
          polling = false;
        }
      }
      async function change(id, enabled, source) {
        if (busy || restarting || snapshot?.marketplace?.installing) return;
        revision++;
        busy = true;
        error = "";
        restartError = "";
        publish();
        try {
          snapshot = await call(source === "profile" ? "setPluginEnabled" : "setEnabled", id, enabled);
        } catch (e) {
          error = errorText(e);
        } finally {
          busy = false;
          if (!disposed) publish();
        }
      }
      async function installMarketplace() {
        if (busy || restarting || snapshot?.marketplace?.installing) return;
        revision++;
        busy = true;
        error = "";
        publish();
        if (snapshot?.marketplace) {
          snapshot = { ...snapshot, marketplace: { ...snapshot.marketplace, installing: true, error: "" } };
          publish();
        }
        try {
          snapshot = await call("installMarketplace");
        } catch (e) {
          error = errorText(e);
        } finally {
          busy = false;
          if (!disposed) {
            publish();
            refresh();
          }
        }
      }
      async function restart() {
        if (busy || restarting || snapshot?.marketplace?.installing || !desktop() || !snapshot?.restartRequired) return;
        revision++;
        restarting = true;
        restartError = "";
        publish();
        const bridge = window.__DSH_UI_STATE__;
        try {
          const status = await invoke("remote_status");
          if (!bridge?.prepareRemoteApply) throw Error(t("\u9875\u9762\u4FDD\u5B58\u670D\u52A1\u5C1A\u672A\u51C6\u5907\u597D\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"));
          const payload = await bridge.prepareRemoteApply(status.frontendVersion, t("\u6B63\u5728\u4FDD\u5B58\u754C\u9762\u5E76\u91CD\u542F DSH\u2026"));
          await invoke("plugins_restart", { payload });
        } catch (e) {
          bridge?.finishRemoteApply();
          restarting = false;
          restartError = errorText(e);
          if (!disposed) publish();
        }
      }
      function useStatus() {
        const [, rerender] = React.useState(0);
        React.useEffect(() => {
          const fn = () => rerender((n) => n + 1);
          listeners.add(fn);
          fn();
          return () => listeners.delete(fn);
        }, []);
        return snapshot;
      }
      function RestartCard({ state }) {
        useLocale(React);
        const open = Boolean(state?.restartRequired);
        return h(Reveal, { open, className: "dshPlugins__restartReveal" }, open && h(
          "section",
          { className: "dshPlugins__restart", "aria-label": t("\u5F85\u91CD\u542F\u7684\u63D2\u4EF6\u53D8\u66F4") },
          h(
            "div",
            { className: "dshPlugins__restartText", role: "status" },
            h("strong", null, restarting ? t("\u6B63\u5728\u91CD\u542F DSH\u2026") : t("\u91CD\u542F DSH \u4EE5\u5E94\u7528\u66F4\u6539")),
            h("p", null, [
              ...[...state.rows, ...(state.plugins || []).map(displayRow)].filter((row) => row.restart).map((row) => t(row.label)),
              ...state.marketplace?.restartRequired ? [t("dshmarket \u63D2\u4EF6\u5E02\u573A")] : []
            ].join("\u3001")),
            h("p", null, t("\u91CD\u542F\u4F1A\u4E2D\u65AD DSH \u4EFB\u52A1\u53CA\u5176\u5185\u7F6E\u7EC8\u7AEF\uFF1B\u8349\u7A3F\u548C\u9644\u4EF6\u4F1A\u4FDD\u7559\u3002")),
            !desktop() && h("p", null, t("\u8BF7\u5728\u7535\u8111\u684C\u9762\u5E94\u7528\u4E2D\u91CD\u542F\u3002")),
            restartError && h("p", { className: "dshPlugins__error", role: "alert" }, restartError)
          ),
          h("button", {
            type: "button",
            className: "dshPlugins__restartButton",
            onClick: restart,
            disabled: busy || restarting || state?.marketplace?.installing || !desktop()
          }, restarting ? t("\u6B63\u5728\u91CD\u542F\u2026") : t("\u91CD\u542F DSH"))
        ));
      }
      function PluginCard({ row, open, toggle }) {
        useLocale(React);
        const detailId = "dsh-plugin-details-" + row.id;
        const failed = Boolean(row.error) || row.phase === "failed";
        const stateText = row.error ? t("\u5207\u6362\u5931\u8D25") : failed ? t("\u542F\u52A8\u5931\u8D25") : row.restart ? t("\u7B49\u5F85\u91CD\u542F") : row.application === "overridden" ? t("\u914D\u7F6E\u672A\u751F\u6548") : row.conditional ? t("\u6761\u4EF6\u542F\u7528") : row.enabled ? t("\u5DF2\u542F\u7528") : t("\u5DF2\u505C\u7528");
        const tone = failed ? "danger" : row.restart || row.application === "overridden" || row.conditional ? "warning" : "neutral";
        const dot = (row.running ?? row.enabled) && { pending: "idle", loading: "ongoing", unloading: "ongoing" }[row.phase];
        return h(
          "li",
          {
            className: "dshInventory__card",
            "data-plugin-id": row.id,
            "data-open": open ? "true" : void 0,
            "data-switch": "true",
            "data-failed": failed ? "true" : void 0
          },
          h(
            "div",
            { className: "dshInventory__cardHead" },
            h(
              "button",
              {
                type: "button",
                className: "dshInventory__cardContent",
                onClick: toggle,
                "aria-expanded": open,
                "aria-controls": detailId,
                "aria-label": row.label + t("\u8BE6\u60C5")
              },
              h(
                "span",
                { className: "dshInventory__cardMainRow" },
                h("strong", { className: "dshInventory__cardTitle", title: row.label }, row.label),
                h(
                  "span",
                  { className: "dshInventory__cardTrailing" },
                  dot && h("span", { className: "dshInventory__phaseDot", role: "img", "aria-label": phases[row.phase], title: phases[row.phase] }, h(StateDot, { state: dot })),
                  stateText !== t("\u5DF2\u542F\u7528") && h(Tag, { tone }, stateText),
                  h(Chevron, { size: 12, className: "dshInventory__chevron", "aria-hidden": true })
                )
              ),
              h("span", { className: "dshInventory__cardDescription" }, row.hint)
            ),
            h(
              "div",
              { className: "dshInventory__cardSwitch" },
              row.source !== "preset" && h(Switch, {
                checked: row.enabled,
                onChange: (enabled) => change(row.id, enabled, row.source),
                label: row.label,
                disabled: busy || restarting || snapshot?.marketplace?.installing || Boolean(row.readOnlyReason)
              })
            )
          ),
          h(Reveal, { open, id: detailId }, h(
            "div",
            { className: "dshInventory__cardDetails" },
            h(
              "dl",
              { className: "dshInventory__details" },
              h("div", null, h("dt", null, t("\u8FD0\u884C\u72B6\u6001")), h("dd", null, phases[row.phase] || row.phase)),
              h("div", null, h("dt", null, t("\u751F\u6548\u65B9\u5F0F")), h("dd", null, row.readOnlyReason ? readOnlyText(row.readOnlyReason) : row.hot ? t("\u7ACB\u5373\u751F\u6548") : t("\u91CD\u542F DSH \u540E\u751F\u6548"))),
              row.moduleName && h("div", null, h("dt", null, t("\u6A21\u5757")), h("dd", null, row.moduleName)),
              row.entryId && h("div", null, h("dt", null, t("\u6761\u76EE")), h("dd", null, row.entryId)),
              row.version && h("div", null, h("dt", null, t("\u7248\u672C")), h("dd", null, row.version)),
              row.condition && h("div", null, h("dt", null, t("\u542F\u7528\u6761\u4EF6")), h("dd", null, row.condition))
            ),
            row.hotReason && !row.readOnlyReason && h("p", { className: "dshInventory__detailNote" }, row.hotReason),
            row.application === "overridden" && h("p", { className: "dshInventory__brokenNote" }, t("\u5DF2\u4FDD\u5B58\u8BBE\u7F6E\u4E0E\u5B9E\u9645\u72B6\u6001\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u68C0\u67E5\u7236\u7EC4\u3001\u914D\u7F6E\u8986\u76D6\u6216\u542F\u52A8\u8BCA\u65AD\u3002")),
            row.meta?.error && h("p", { className: "dshInventory__brokenNote" }, row.meta.error),
            row.restart && h("p", { className: "dshInventory__detailNote" }, t("\u5DF2\u4FDD\u5B58\uFF0C\u91CD\u542F\u540E\u751F\u6548\u3002\u6539\u56DE\u5F53\u524D\u8FD0\u884C\u72B6\u6001\u53EF\u53D6\u6D88\u3002"))
          )),
          row.error && h(
            "p",
            { role: "alert", className: "dshInventory__brokenNote" },
            row.error,
            " ",
            h("button", { type: "button", disabled: busy || restarting || snapshot?.marketplace?.installing || Boolean(row.readOnlyReason), onClick: () => change(row.id, row.enabled, row.source) }, t("\u91CD\u8BD5\u5207\u6362"))
          )
        );
      }
      function displayRow(row) {
        const resolveText = (text) => typeof text === "string" ? text : text ? ctx.locale.resolveText(text) : "";
        const title = resolveText(row.meta?.title);
        const shortName = (text) => text?.replace(/^@[^/]+\//, "").replace(/^dsh-(?:client-|host-)?/, "");
        return {
          ...row,
          source: row.source || "profile",
          label: (title && title !== row.moduleName && title !== row.packageName ? title : "") || (row.moduleName?.startsWith("file:") ? row.patchId || row.entryId || row.id : shortName(row.moduleName)) || row.id,
          hint: resolveText(row.meta?.description) || (row.readOnlyReason ? readOnlyText(row.readOnlyReason) : row.moduleName)
        };
      }
      function ClientSync() {
        useLocale(React);
        const store = ctx.modules.entries.state;
        const state = React.useSyncExternalStore((fn) => store.subscribe(fn), () => store.getSnapshot());
        return state.syncing ? h("p", { role: "status" }, t("\u6B63\u5728\u540C\u6B65\u9875\u9762\u63D2\u4EF6\u2026")) : state.failures.length ? h(
          "p",
          { className: "dshPlugins__error", role: "alert" },
          t("\u9875\u9762\u63D2\u4EF6\u540C\u6B65\u5931\u8D25\uFF0C\u540E\u7AEF\u72B6\u6001\u5DF2\u5355\u72EC\u663E\u793A\u3002 "),
          h("button", { type: "button", onClick: () => ctx.modules.entries.retry().catch((e) => {
            error = errorText(e);
            publish();
          }) }, t("\u91CD\u8BD5\u9875\u9762\u540C\u6B65"))
        ) : null;
      }
      const Inventory = createInventoryView({
        React,
        ui,
        useStatus,
        RestartCard,
        ClientSync,
        displayRow,
        change,
        refresh,
        feedback: () => error,
        isBusy: () => busy || restarting || snapshot?.marketplace?.installing,
        readOnlyText,
        phases,
        presetName: (p) => {
          const key = { standard: "presetStandardName", ptc: "presetPtcName", minimal: "presetMinimalName", cordis: "presetCordisName" }[p.id];
          return p.name ?? (key ? ctx.locale.bind("settings.agentPreset")(key) : p.id);
        }
      });
      const MarketplacePrompt = createMarketplacePrompt(React, { useStatus, install: installMarketplace, refresh, isBusy: () => busy || restarting });
      function Settings() {
        useLocale(React);
        const state = useStatus(), [expanded, setExpanded] = React.useState(null);
        return h(
          "div",
          { className: "dshPlugins dshInventory" },
          h(
            "div",
            { className: "dshPlugins__summary" },
            h("p", { className: "dshPlugins__intro" }, t("\u5F00\u5173\u4F1A\u81EA\u52A8\u4FDD\u5B58\u3002\u652F\u6301\u70ED\u5207\u6362\u7684\u63D2\u4EF6\u7ACB\u5373\u751F\u6548\uFF0C\u5176\u4F59\u63D2\u4EF6\u5728\u91CD\u542F DSH \u540E\u751F\u6548\u3002")),
            h(RestartCard, { state })
          ),
          error && h("p", { role: "alert", className: "dshPlugins__error" }, error, " ", h("button", { type: "button", onClick: refresh, disabled: busy || restarting }, t("\u91CD\u8BD5"))),
          !state ? h("p", { role: "status" }, t("\u6B63\u5728\u8BFB\u53D6\u63D2\u4EF6\u2026")) : renderPluginColumns(h, state.rows.map((row) => h(PluginCard, {
            key: row.id,
            row: { ...row, label: t(row.label), hint: t(row.hint) },
            open: expanded === row.id,
            toggle: () => setExpanded((current) => current === row.id ? null : row.id)
          }))),
          h("p", { className: "dshPlugins__footnote" }, t("\u6807\u9898\u680F\u3001\u754C\u9762\u72B6\u6001\u6062\u590D\u548C\u57FA\u7840\u670D\u52A1\u59CB\u7EC8\u542F\u7528\u3002\u8FDC\u7A0B\u8BBF\u95EE\u8BF7\u5728\u300C\u8FDC\u7A0B\u63A7\u5236\u300D\u8BBE\u7F6E\u4E2D\u5F00\u542F\u6216\u5173\u95ED\u3002"))
        );
      }
      const style = document.createElement("style");
      style.textContent = style_default + inventory_style_default;
      document.head.appendChild(style);
      const offSettings = ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({ name: "settings.plugins.tab", id: "desktop-builtins", order: 5, label: () => t("\u5185\u7F6E\u63D2\u4EF6") }, Settings));
      const offInventory = ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({ name: "settings.plugins.tab", id: "all", order: 10, label: () => t("\u63D2\u4EF6\u5217\u8868") }, Inventory));
      const offHeadings = renameSettingsHeadings();
      const offMarketplace = mountMarketplaceHeader(React, createRoot, MarketplacePrompt);
      refresh();
      const timer = setInterval(refresh, 2e3);
      return () => {
        disposed = true;
        clearInterval(timer);
        offMarketplace();
        offHeadings();
        offSettings();
        offInventory();
        offRestart?.();
        style.remove();
        listeners.clear();
      };
    }
    return { inject: ["slots", "remote", "sessions", "workspaces", "uiWorkspace", "conversation", "layout", "locale", "modules"], async apply(ctx) {
      const off = await ctx.remote.$mount(contribution);
      const fiber = ctx.inject(["remote.desktopPlugins"], install);
      return async () => {
        await fiber.dispose();
        await off();
      };
    } };
  } });
})();
