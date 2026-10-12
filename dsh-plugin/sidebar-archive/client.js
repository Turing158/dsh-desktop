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

  // dsh-plugin/sidebar-archive/navigation.mjs
  var PANEL = "desktop-archive";
  function createArchiveNavigation(view, workspaces, layout) {
    let selected = null, dead = false;
    let snapshot = { only: view.getSnapshot().archivedFilter === "only", active: layout.panelInfo.getSnapshot().activePanelId === PANEL, sessionId: null };
    const listeners = /* @__PURE__ */ new Set();
    const publish = () => {
      const next = { only: view.getSnapshot().archivedFilter === "only", active: layout.panelInfo.getSnapshot().activePanelId === PANEL, sessionId: selected };
      if (Object.keys(next).every((key) => next[key] === snapshot[key])) return;
      snapshot = next;
      listeners.forEach((fn) => fn());
    };
    const exit = () => {
      selected = null;
      view.actions.setArchivedFilter("default");
      if (layout.panelInfo.getSnapshot().activePanelId === PANEL) layout.selectPanel(null);
      publish();
    };
    const offView = view.subscribe(() => {
      if (dead) return;
      const only = view.getSnapshot().archivedFilter === "only";
      if (only !== snapshot.only) {
        publish();
        if (only) layout.selectPanel(PANEL);
        else {
          selected = null;
          if (snapshot.active) layout.selectPanel(null);
        }
      }
      publish();
    });
    const offPanel = layout.panelInfo.subscribe(() => {
      if (dead) return;
      const wasActive = snapshot.active;
      publish();
      if (wasActive && !snapshot.active) {
        selected = null;
        view.actions.setArchivedFilter("default");
        publish();
      }
    });
    const offWorkspaces = workspaces.subscribe(() => {
      if (selected && !workspaces.getSnapshot().archivedSessionIds.includes(selected)) {
        selected = null;
        publish();
      }
    });
    return {
      getSnapshot: () => snapshot,
      subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      isArchived: (id) => workspaces.getSnapshot().archivedSessionIds.includes(id),
      enter() {
        view.actions.setArchivedFilter("only");
        layout.selectPanel(PANEL);
        publish();
      },
      exit,
      toggle() {
        if (snapshot.only) exit();
        else this.enter();
      },
      open(id) {
        if (dead || !this.isArchived(id)) return false;
        selected = id;
        view.actions.setArchivedFilter("only");
        layout.selectPanel(PANEL);
        publish();
        return true;
      },
      dispose() {
        dead = true;
        offView();
        offPanel();
        offWorkspaces();
        listeners.clear();
      }
    };
  }

  // dsh-plugin/sidebar-archive/sidebar.mjs
  var REGION = '[data-slot="sidebar.workspaces"]';
  var ROW = '[role="treeitem"]:is([data-row-key^="session:"], [class*="_searchResultRow"])';
  var ARCHIVE_FILTER_ITEMS = /* @__PURE__ */ new Set(["archived-filter-separator", "filter-by", "hide-archived", "show-archived", "only-archived"]);
  function rowSessionId(row) {
    const key = row.getAttribute("data-row-key");
    if (key?.startsWith("session:")) return key.slice(8);
    const fiberKey = Object.keys(row).find((key2) => key2.startsWith("__reactFiber$"));
    for (let fiber = fiberKey && row[fiberKey], depth = 0; fiber && depth < 16; fiber = fiber.return, depth++) {
      const id = fiber.memoizedProps?.result?.id;
      if (typeof id === "string") return id;
    }
    return null;
  }
  function mountArchiveSessionMenu(React, slots, workspaces) {
    const slot = "sidebar.workspaces.session.menu.item";
    return slots.inject(slot, () => {
      let remove, registering = false;
      const subscribe = (listener) => workspaces.subscribe(listener);
      const attach = () => {
        if (remove || registering) return;
        const native = slots.entriesOfSlot(slot).find((entry) => entry.options.id === "fork");
        if (!native) return;
        function ForkSessionItem(props) {
          const getArchived = React.useCallback(() => workspaces.getSnapshot().archivedSessionIds.includes(props.sessionId), [props.sessionId]);
          const archived = React.useSyncExternalStore(subscribe, getArchived, getArchived);
          return archived ? null : React.createElement(native.component, props);
        }
        registering = true;
        try {
          remove = slots.register({
            name: slot,
            ...native.options,
            priority: -10,
            inject: native.inject,
            locale: native.locale,
            store: native.store
          }, ForkSessionItem);
        } finally {
          registering = false;
        }
      };
      const unsubscribe = slots.subscribe(slot, attach);
      attach();
      return () => {
        unsubscribe();
        remove?.();
      };
    });
  }
  function mountArchiveSidebar(React, createRoot, Toggle, navigation, onOpen = () => {
  }) {
    let mount = null, root = null, actions = null, dead = false, queued = false;
    const labels = /* @__PURE__ */ new Map(), rows = /* @__PURE__ */ new Map(), filterRows = /* @__PURE__ */ new Map();
    const clearButton = () => {
      root?.unmount();
      mount?.remove();
      actions?.classList.remove("dshArchive__headerActions");
      root = mount = actions = null;
    };
    const update = () => {
      queued = false;
      if (dead) return;
      for (const element of filterRows.keys()) if (!element.isConnected) filterRows.delete(element);
      for (const element of document.querySelectorAll('[role="menu"][class*="_viewOptionsMenu"] [class*="_viewport"] > *')) {
        const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
        if (!ARCHIVE_FILTER_ITEMS.has(element[fiberKey]?.key)) continue;
        const button = element.querySelector("button");
        if (!filterRows.has(element)) filterRows.set(element, { button, disabled: button?.disabled });
        element.setAttribute("data-dsh-archive-filter-hidden", "");
        if (button) button.disabled = true;
      }
      const region = document.querySelector(REGION);
      const next = region?.querySelector('[class*="_sectionHeader"] [class*="_headerActions"]');
      if (!mount?.isConnected || actions !== next) {
        clearButton();
        if (next) {
          actions = next;
          actions.classList.add("dshArchive__headerActions");
          mount = document.createElement("span");
          mount.className = "dshArchive__toggleMount";
          actions.append(mount);
          root = createRoot(mount);
          root.render(React.createElement(Toggle));
        }
      }
      const state = navigation.getSnapshot();
      const label = region?.querySelector('[class*="_sectionLabel"]');
      for (const element of labels.keys()) if (!element.isConnected) labels.delete(element);
      if (label) {
        if (label.textContent !== t("\u5F52\u6863\u533A")) labels.set(label, label.textContent);
        const text = state.only ? t("\u5F52\u6863\u533A") : labels.get(label);
        if (text && label.textContent !== text) label.textContent = text;
      }
      for (const row of rows.keys()) if (!row.isConnected) rows.delete(row);
      for (const row of region?.querySelectorAll(ROW) || []) {
        const id = rowSessionId(row);
        if (!navigation.isArchived(id)) continue;
        if (!rows.has(row)) rows.set(row, { description: row.getAttribute("aria-description"), tabIndex: row.getAttribute("tabindex") });
        row.setAttribute("aria-description", t("\u5DF2\u5F52\u6863\uFF0C\u4EC5\u53EF\u67E5\u770B\u5386\u53F2\u5185\u5BB9"));
        row.tabIndex = 0;
        row.toggleAttribute("data-dsh-archive-selected", state.active && state.sessionId === id);
        row.setAttribute("aria-selected", String(state.active && state.sessionId === id));
      }
    };
    const schedule = () => {
      if (!queued && !dead) {
        queued = true;
        queueMicrotask(update);
      }
    };
    const activate = (event) => {
      if (event.type === "keydown" && (event.key !== "Enter" && event.key !== " " || event.isComposing)) return;
      const row = event.target.closest?.(ROW);
      if (!row?.closest(REGION) || event.target.closest('button, input, [role="menuitem"], [contenteditable="true"]')) return;
      const id = rowSessionId(row);
      if (!navigation.isArchived(id)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type !== "dblclick" && navigation.open(id)) onOpen();
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "data-row-key"] });
    for (const type of ["click", "keydown", "dblclick"]) document.addEventListener(type, activate, true);
    const off = navigation.subscribe(schedule);
    update();
    return () => {
      dead = true;
      observer.disconnect();
      off();
      clearButton();
      for (const [element, previous] of filterRows) {
        element.removeAttribute("data-dsh-archive-filter-hidden");
        if (previous.button) previous.button.disabled = previous.disabled;
      }
      for (const type of ["click", "keydown", "dblclick"]) document.removeEventListener(type, activate, true);
      for (const [label, text] of labels) if (label.isConnected && label.textContent === t("\u5F52\u6863\u533A")) label.textContent = text;
      for (const [row, previous] of rows) {
        row.removeAttribute("data-dsh-archive-selected");
        for (const [name, value] of [["aria-description", previous.description], ["tabindex", previous.tabIndex]]) {
          if (value === null) row.removeAttribute(name);
          else row.setAttribute(name, value);
        }
      }
    };
  }

  // dsh-plugin/sidebar-archive/history-slots.mjs
  var HISTORY_SLOT = "desktop.archive.view";
  var alias = (key) => "desktop.archive." + key;
  function mountHistorySlots(React, slots) {
    function mirror(source, target, filter = () => true) {
      const mounted = /* @__PURE__ */ new Map();
      const sync = () => {
        const entries = slots.entriesOfSlot(source).filter(filter);
        for (const [entry, remove] of mounted) if (!entries.includes(entry)) {
          remove();
          mounted.delete(entry);
        }
        for (const entry of entries) {
          let NativeHistory = function(props) {
            const renderSlot = React.useCallback((key, owner, options) => props.renderSlot(alias(key), owner, options), [props.renderSlot]);
            const renderSlotChain = React.useCallback((key, owner, options) => props.renderSlotChain(alias(key), owner, options), [props.renderSlotChain]);
            return React.createElement(entry.component, { ...props, renderSlot, renderSlotChain });
          };
          if (mounted.has(entry)) continue;
          const children = Object.entries(entry.children || {});
          const remove = slots.register({
            name: target,
            ...entry.options,
            select: entry.select,
            inject: entry.inject,
            store: entry.store,
            locale: entry.locale,
            ...children.length ? { children: Object.fromEntries(children.map(([key, spec]) => [alias(key), spec])) } : {}
          }, NativeHistory);
          const nested = children.map(([key]) => mirror(key, alias(key)));
          mounted.set(entry, () => {
            nested.reverse().forEach((off) => off());
            remove();
          });
        }
      };
      const unsubscribe = slots.subscribe(source, sync);
      sync();
      return () => {
        unsubscribe();
        for (const remove of mounted.values()) remove();
        mounted.clear();
      };
    }
    return mirror("conversation.view", HISTORY_SLOT, (entry) => ["chat", "trajectory"].includes(entry.options.id));
  }

  // dsh-plugin/sidebar-archive/style.css
  var style_default = ".dshArchive__toggleMount { display:inline-flex; flex:none; }\n[data-dsh-archive-filter-hidden] { display:none !important; }\n.dshArchive__headerActions:not([class*='_headerActionsHidden']) { max-width:92px; }\n.dshArchive__toggle { display:inline-flex; align-items:center; justify-content:center; flex:none; width:28px; height:28px; padding:0; border:0; border-radius:var(--dsw-radius-sm,8px); background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; }\n.dshArchive__toggle:hover, .dshArchive__toggle[aria-pressed='true'] { background:var(--dsw-alias-interactive-bg-hover); }\n.dshArchive__toggle[aria-pressed='true'] { color:var(--dsw-alias-state-business-primary); }\n.dshArchive__toggle:focus-visible { outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:-2px; }\n[data-slot='sidebar.workspaces'] [data-dsh-archive-selected] { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }\n/* Archive browsing has its own section; keep the normal row text hierarchy. */\n[data-slot='sidebar.workspaces'] [role='treeitem'][class*='_archived'] :is([class*='_title'], [class*='_searchResultTitle']) { color:var(--dsw-alias-label-primary); }\n[data-slot='sidebar.workspaces'] [role='treeitem'][class*='_archived'] [class*='_searchResultWorkspace'] { color:var(--dsw-alias-label-tertiary); }\n[data-slot='sidebar.workspaces'] [role='treeitem'][class*='_archived'] [class*='_searchResultSnippet'] { color:var(--dsw-alias-label-secondary); }\n.dshArchive { box-sizing:border-box; position:relative; display:flex; flex:1; flex-direction:column; height:100%; min-width:0; min-height:0; overflow:hidden; container-type:inline-size; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); --dsh-composer-height:0px; --dsh-composer-side-clearance:16px; --dsh-chat-content-width:var(--dsh-chat-user-width,clamp(680px,64cqw,920px)); }\n/* Match the conversation header's title row and view tabs. */\n.dshArchive__header { box-sizing:border-box; display:flex; flex:none; flex-direction:column; min-height:76px; padding:10px 28px 0 20px; border-bottom:.5px solid var(--dsw-alias-border-l3); }\n.dshArchive__header:not(:has(.dshArchive__tabs)) { min-height:0; padding-bottom:10px; }\n.dshArchive__titleRow { display:flex; align-items:center; gap:10px; min-width:0; min-height:30px; padding-inline-start:max(0px,calc(var(--dsh-frame-leading-clearance,0px) - 20px)); }\n.dshArchive__header h2 { flex:1; min-width:0; margin:0; padding:4px 8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; font-weight:500; line-height:20px; }\n.dshArchive__readonly { flex:none; color:var(--dsw-alias-label-tertiary); font-size:12px; }\n.dshArchive__tabs { display:flex; flex:none; gap:36px; margin-top:10px; padding-left:8px; }\n.dshArchive__tabs button { position:relative; border:0; background:transparent; color:var(--dsw-alias-label-tertiary); font:inherit; font-size:13px; font-weight:500; line-height:16px; padding:0 0 9px; cursor:pointer; }\n.dshArchive__tabs button::after { content:''; position:absolute; inset:auto 0 -1px; height:2px; border-radius:2px; background:transparent; }\n.dshArchive__tabs button[aria-pressed='true'] { color:var(--dsw-alias-state-business-primary); }\n.dshArchive__tabs button[aria-pressed='true']::after { background:currentColor; }\n.dshArchive__tabs button:focus-visible { outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:3px; }\n.dshArchive__content { position:relative; display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; margin-right:2px; overflow:auto; scrollbar-gutter:stable; }\n.dshArchive__empty { box-sizing:border-box; display:flex; flex:1; flex-direction:column; align-items:center; justify-content:center; gap:14px; min-height:220px; padding:24px; color:var(--dsw-alias-label-tertiary); font-size:14px; line-height:22px; text-align:center; }\n.dshArchive__empty > svg { flex:none; }\n.dshArchive__placeholderCopy { max-width:28em; }\n.dshArchive__placeholderTitle { margin:0; color:var(--dsw-alias-label-primary); font-weight:500; }\n.dshArchive__placeholderHint { margin:6px 0 0; font-size:13px; line-height:20px; }\n.dshArchive__notice { flex:none; padding:12px 20px; border-top:.5px solid var(--dsw-alias-border-l3); color:var(--dsw-alias-label-tertiary); font-size:12px; text-align:center; }\n";

  // dsh-plugin/sidebar-archive/client-entry.mjs
  window.__ModuleLoader__.load({ id: "@dsh-desktop/sidebar-archive", factory(require2) {
    const React = require2("react"), h = React.createElement;
    const { createRoot } = require2("react-dom/client");
    const { Button, Tooltip, IconArchiveOutlineRegular: Archive } = require2("@deepseek-ai/dsh-client-ui-primitives");
    function install(ctx) {
      const view = ctx.slots.entriesOfSlot("sidebar.workspaces").find((entry) => entry.store)?.store.create();
      if (!view?.actions.setArchivedFilter) return;
      if (view.getSnapshot().archivedFilter === "show") view.actions.setArchivedFilter("default");
      const navigation = createArchiveNavigation(view, ctx.workspaces.list, ctx.layout);
      const useNavigation = () => React.useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
      function Toggle() {
        useLocale(React);
        const { only } = useNavigation(), label = only ? t("\u8FD4\u56DE\u5DE5\u4F5C\u533A") : t("\u67E5\u770B\u5F52\u6863\u533A");
        return h(
          Tooltip,
          { label, side: "bottom", portal: true, delayMs: 500 },
          h("button", {
            type: "button",
            className: "dshArchive__toggle",
            "aria-label": label,
            "aria-pressed": only,
            onClick: () => navigation.toggle()
          }, h(Archive, { size: 16 }))
        );
      }
      function HistoryPlaceholder({ loading = false, onRetry }) {
        useLocale(React);
        return h(
          "div",
          {
            className: "dshArchive__empty",
            role: loading ? "status" : "alert",
            "data-dsh-history-placeholder": loading ? "loading" : "error"
          },
          h(Archive, { size: 32, "aria-hidden": true }),
          h(
            "div",
            { className: "dshArchive__placeholderCopy" },
            h("p", { className: "dshArchive__placeholderTitle" }, t(loading ? "\u6B63\u5728\u52A0\u8F7D\u5386\u53F2\u5185\u5BB9\u2026" : "\u5386\u53F2\u5185\u5BB9\u6682\u65F6\u65E0\u6CD5\u52A0\u8F7D")),
            !loading && h("p", { className: "dshArchive__placeholderHint" }, t("\u8BF7\u7A0D\u540E\u91CD\u8BD5\uFF0C\u6216\u9009\u62E9\u5176\u4ED6\u4F1A\u8BDD\u3002"))
          ),
          !loading && h(Button, { variant: "ghost", onClick: onRetry }, t("\u91CD\u8BD5"))
        );
      }
      function HistoryContent({ reference, SessionProvider, renderSlot, selectedView }) {
        const session = reference.binding.session;
        const subscribe = React.useCallback((listener) => session.subscribe(listener), [session]);
        const getState = React.useCallback(() => session.getSnapshot().openState, [session]);
        const openState = React.useSyncExternalStore(subscribe, getState, getState);
        const [retry, setRetry] = React.useState({ busy: false, failed: false });
        const reload = async () => {
          if (retry.busy) return;
          setRetry({ busy: true, failed: false });
          try {
            await session.open();
            setRetry({ busy: false, failed: false });
          } catch {
            setRetry({ busy: false, failed: true });
          }
        };
        if (retry.busy || openState === "loading" && !retry.failed) return h(HistoryPlaceholder, { loading: true });
        if (openState === "error" || retry.failed) return h(HistoryPlaceholder, { onRetry: reload });
        return h(SessionProvider, { session: reference }, renderSlot(HISTORY_SLOT, {
          inspectCall: void 0,
          viewRequest: null,
          openView: () => {
          },
          completeViewRequest: () => {
          }
        }, { only: selectedView }));
      }
      function History({ sessionId, SessionProvider, renderSlot, selectedView }) {
        const [reference, setReference] = React.useState(null), [error, setError] = React.useState(null), [retry, setRetry] = React.useState(0);
        React.useEffect(() => {
          let live = true, held;
          setReference(null);
          setError(null);
          try {
            held = ctx.sessions.retain(sessionId, { source: "desktopArchive" });
            held.ready.then(() => {
              if (live) setReference(held);
            }, () => {
              if (live) setError(true);
            });
          } catch {
            setError(true);
          }
          return () => {
            live = false;
            held?.release();
          };
        }, [sessionId, retry]);
        if (error) return h(HistoryPlaceholder, { onRetry: () => setRetry((value) => value + 1) });
        if (!reference) return h(HistoryPlaceholder, { loading: true });
        return h(HistoryContent, { reference, SessionProvider, renderSlot, selectedView });
      }
      function ArchivePanel({ SessionProvider, renderSlot, useSessions }) {
        useLocale(React);
        const { sessionId } = useNavigation(), title = useSessions((state) => sessionId && state.byId[sessionId]?.displayTitle);
        const [selectedView, setSelectedView] = React.useState("chat");
        const views = ctx.slots.entriesOfSlot(HISTORY_SLOT).map((entry) => ({
          id: entry.options.id,
          label: typeof entry.options.label === "function" ? entry.options.label() : entry.options.label || entry.options.id
        }));
        const activeView = views.some((view2) => view2.id === selectedView) ? selectedView : views[0]?.id;
        return h(
          "section",
          { className: "dshArchive", "data-dsh-archive-panel": "", "data-archive-session": sessionId || void 0 },
          h(
            "header",
            { className: "dshArchive__header" },
            h(
              "div",
              { className: "dshArchive__titleRow" },
              h("h2", { title: title || t("\u5F52\u6863\u533A") }, title || t("\u5F52\u6863\u533A")),
              sessionId && h("span", { className: "dshArchive__readonly" }, t("\u5DF2\u5F52\u6863 \xB7 \u53EA\u8BFB"))
            ),
            sessionId && views.length > 1 && h(
              "nav",
              { className: "dshArchive__tabs", "aria-label": t("\u5386\u53F2\u5185\u5BB9\u89C6\u56FE") },
              views.map((view2) => h("button", {
                key: view2.id,
                type: "button",
                "aria-pressed": view2.id === activeView,
                onClick: () => setSelectedView(view2.id)
              }, view2.label))
            )
          ),
          h(
            "div",
            { className: "dshArchive__content", "data-conversation-scroll": "", "data-conversation-region": "" },
            sessionId ? h(History, { key: sessionId, sessionId, SessionProvider, renderSlot, selectedView: activeView }) : h("div", { className: "dshArchive__empty" }, h(Archive, { size: 32 }), t("\u9009\u62E9\u5F52\u6863\u4F1A\u8BDD\u67E5\u770B\u5386\u53F2\u5185\u5BB9"))
          ),
          sessionId && h("footer", { className: "dshArchive__notice" }, t("\u5F52\u6863\u4F1A\u8BDD\u4EC5\u4F9B\u67E5\u770B\uFF0C\u65E0\u6CD5\u7EE7\u7EED\u5BF9\u8BDD\u3002"))
        );
      }
      const offMain = ctx.slots.register({
        name: "main",
        key: PANEL,
        children: { [HISTORY_SLOT]: { kind: "list", scope: "session" } }
      }, ArchivePanel);
      const offHistory = mountHistorySlots(React, ctx.slots);
      const offMenu = mountArchiveSessionMenu(React, ctx.slots, ctx.workspaces.list);
      const style = document.createElement("style");
      style.textContent = style_default;
      document.head.append(style);
      const offSidebar = mountArchiveSidebar(React, createRoot, Toggle, navigation, () => {
        if (document.documentElement.hasAttribute("data-dsh-browser") && document.querySelector('[class*="_frame"]:not([data-sidebar-collapsed])')) ctx.layout.toggleSidebar();
      });
      if (navigation.getSnapshot().only) navigation.enter();
      if (window.__DSH_UI_BOOT__?.smoke) window.__DSH_ARCHIVE_SMOKE__ = { navigation, view };
      return () => {
        navigation.exit();
        offSidebar();
        offMenu();
        navigation.dispose();
        offHistory();
        offMain();
        style.remove();
      };
    }
    return { inject: ["slots", "sessions", "workspaces", "layout"], apply(ctx) {
      return ctx.slots.inject("sidebar.workspaces", () => ctx.slots.inject("conversation.view", () => ctx.slots.inject("main", () => install(ctx))));
    } };
  } });
})();
