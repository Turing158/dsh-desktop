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

  // dsh-plugin/file-editor/protocol.mjs
  var MAX_BYTES = 2 * 1024 * 1024;
  var ID = "@dsh-desktop/file-editor";
  var PLAIN_ID = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/text";
  var CODE_ID = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/code";
  var HTML_ID = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/html";
  function parseFile(address) {
    const prefix = "dsh-resource://file/session/";
    if (typeof address !== "string" || !address.startsWith(prefix)) return null;
    try {
      const [sessionId, ...parts] = address.slice(prefix.length).split(/[?#]/, 1)[0].split("/");
      if (!sessionId || !parts.length) return null;
      return { sessionId: decodeURIComponent(sessionId), path: parts.map(decodeURIComponent).join("/") };
    } catch {
      return null;
    }
  }
  var codec = (name) => ({ mode: "strict", typeSymbol: ID + "#" + name, create: () => ({ parse(value) {
    const limit = name === "text" ? MAX_BYTES : name === "path" ? 32768 : 1024;
    if (typeof value !== "string" || value.length > limit || name !== "text" && (!value || value.includes("\0"))) throw Error("\u65E0\u6548\u7684\u6587\u4EF6\u7F16\u8F91\u53C2\u6570");
    return value;
  } }) });
  var contribution = { package: ID, descriptors: [
    ["read", ["path"]],
    ["save", ["path", "version", "text"]]
  ].map(([method, args]) => ({
    id: "desktopFileEditor/" + method,
    service: "desktopFileEditor",
    namespace: "desktopFileEditor",
    method,
    invocation: { kind: "direct" },
    parameters: [
      { name: "scope", wire: "sessionId", source: "lookup", lookup: "desktopFileEditorScope", codec: codec("sessionId") },
      ...args.map((name) => ({ name, wire: name, source: "json", codec: codec(name) }))
    ],
    cancellation: { parameter: "signal" },
    result: { mode: "src-json" }
  })) };

  // dsh-plugin/file-editor/documents.mjs
  function createDocuments(remote, { maxCachedDocuments = 16, maxCachedBytes = 8 * 1024 * 1024 } = {}) {
    const documents = /* @__PURE__ */ new Map();
    function prune() {
      const unused = [...documents.values()].filter((doc) => !doc.observed() && !doc.dirty() && !doc.getSnapshot().loading && !doc.getSnapshot().saving);
      const bytes = (doc) => {
        const state = doc.getSnapshot();
        return (state.text.length + (state.text === state.base ? 0 : state.base.length)) * 2;
      };
      let retained = unused.length, size = unused.reduce((sum, doc) => sum + bytes(doc), 0);
      for (const doc of unused) {
        if (retained <= maxCachedDocuments && size <= maxCachedBytes) break;
        documents.delete(doc.address);
        retained--;
        size -= bytes(doc);
      }
    }
    function get(address) {
      if (documents.has(address)) {
        const doc2 = documents.get(address);
        documents.delete(address);
        documents.set(address, doc2);
        return doc2;
      }
      const file = parseFile(address);
      if (!file) throw Error(t("\u65E0\u6CD5\u8BC6\u522B\u6587\u4EF6\u5730\u5740"));
      let state = { text: "", base: "", version: null, loading: false, saving: false, error: "", conflict: false, eol: "\n", bom: false };
      const listeners = /* @__PURE__ */ new Set();
      const patch = (value2) => {
        state = { ...state, ...value2 };
        for (const fn of listeners) fn();
      };
      const value = (result) => {
        if (!result.ok) throw result.error;
        return result.value;
      };
      let pendingRead, pendingSave, generation = 0;
      const doc = {
        file,
        address,
        getSnapshot: () => state,
        subscribe(fn) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
            prune();
          };
        },
        observed: () => listeners.size > 0,
        dirty: () => state.version !== null && state.text !== state.base,
        edit(text) {
          generation++;
          patch({ text, error: state.conflict ? state.error : "" });
        },
        async load(force = false) {
          if (pendingRead) return pendingRead;
          if (state.saving || !force && state.version !== null) return;
          const requestGeneration = generation;
          patch({ loading: true, error: "" });
          pendingRead = (async () => {
            try {
              const loaded = value(await remote.read(file.sessionId, file.path, new AbortController().signal));
              if (requestGeneration === generation) patch({ ...loaded, base: loaded.text, error: "", conflict: false });
            } catch (error) {
              if (requestGeneration === generation) patch({ error: error.message || t("\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5") });
            } finally {
              pendingRead = null;
              patch({ loading: false });
              prune();
            }
          })();
          return pendingRead;
        },
        async save() {
          if (pendingSave) return pendingSave;
          if (!doc.dirty() || state.loading || state.conflict) return false;
          const text = state.text, version = state.version;
          patch({ saving: true, error: "" });
          pendingSave = (async () => {
            try {
              const saved = value(await remote.save(file.sessionId, file.path, version, text, new AbortController().signal));
              patch({ base: saved.text, version: saved.version, eol: saved.eol, bom: saved.bom });
              return true;
            } catch (error) {
              patch({ error: error.message || t("\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5"), conflict: String(error.code).includes("FS_STALE_VERSION") });
              return false;
            } finally {
              pendingSave = null;
              patch({ saving: false });
              prune();
            }
          })();
          return pendingSave;
        },
        restore(saved) {
          generation++;
          patch({ ...saved, loading: false, saving: false });
        }
      };
      documents.set(address, doc);
      prune();
      return doc;
    }
    return {
      get,
      documents,
      prune,
      unsettled: () => [...documents.values()].some((doc) => doc.dirty() || doc.getSnapshot().saving),
      capture() {
        if ([...documents.values()].some((doc) => doc.getSnapshot().saving || doc.getSnapshot().loading)) throw Error(t("\u6587\u4EF6\u6B63\u5728\u8BFB\u5199\uFF0C\u8BF7\u5B8C\u6210\u540E\u518D\u91CD\u542F"));
        const drafts = [...documents.values()].filter((doc) => doc.dirty()).map((doc) => ({ address: doc.address, state: doc.getSnapshot() }));
        return drafts.length ? { drafts } : null;
      },
      async preflightRestore(saved, signal) {
        for (const draft of saved.drafts) {
          signal.throwIfAborted();
          const doc = get(draft.address), current = doc.getSnapshot();
          if (current.loading || current.saving) throw Error("snapshot-input-busy");
          if (doc.dirty() && (current.text !== draft.state.text || current.base !== draft.state.base)) throw Error("snapshot-file-conflict");
          const result = await remote.read(doc.file.sessionId, doc.file.path, signal);
          signal.throwIfAborted();
          if (!result.ok || result.value.version !== draft.state.version || result.value.text !== draft.state.base) throw Error("snapshot-file-conflict");
        }
      },
      restore(saved) {
        for (const draft of saved.drafts) get(draft.address).restore(draft.state);
      }
    };
  }

  // dsh-plugin/file-editor/lazy-editor.mjs
  function createLazyEditor(importModule) {
    let pending = null, attempt = 0;
    return () => pending ??= Promise.resolve().then(() => importModule(attempt++)).catch((error) => {
      pending = null;
      throw error;
    });
  }
  var revision = true ? "e482d65d7bee0971354020d434c07c6b1b61ba972858e2d7d155950e3d01ca05" : "development";
  var loadEditor = createLazyEditor((attempt) => import("/__dsh-desktop/file-editor/editor.mjs?v=" + revision + (attempt ? "&attempt=" + attempt : "")));

  // dsh-plugin/file-editor/state-provider.mjs
  function createStateProvider(ctx, docs) {
    function stores() {
      const handle = ctx.slots.entriesOfSlot("rightbar.session")[0]?.store;
      if (!handle?.create) return [];
      return ctx.sessions.list.getSnapshot().ids.flatMap((sessionId) => {
        const scope = ctx.sessions.scope(sessionId);
        return scope ? [{ sessionId, store: ctx.slots.resolveStore(handle, { key: sessionId, ctx: scope }) }] : [];
      });
    }
    return {
      version: 1,
      owns: (node) => Boolean(node?.closest?.("[data-dsh-file-editor]")),
      ownsSidebar() {
        const current = ctx.sidebarRight.mounted.getSnapshot();
        const tabs = ctx.sidebarRight.openTabs.getSnapshot().filter((tab) => tab.sessionId === current);
        return tabs.some((tab) => tab.kind === "text") && tabs.every((tab) => tab.kind === "guide" || tab.kind === "text");
      },
      capture() {
        const drafts = docs.capture()?.drafts || [];
        const sides = stores().flatMap(({ sessionId, store }) => {
          const layout = store.getSnapshot().bySession?.[sessionId]?.layout;
          if (!layout) return [];
          const tabs = Object.values(layout.tabs).filter((tab) => tab.kind === "text" && parseFile(tab.contentId));
          if (!tabs.length) return [];
          return [{
            sessionId,
            expanded: Boolean(layout.expanded),
            addresses: [...new Set(tabs.map((tab) => tab.contentId))],
            active: tabs.find((tab) => tab.id === layout.nodes[layout.activePaneId]?.activeTabId)?.contentId || null
          }];
        });
        return drafts.length || sides.length ? { drafts, sides } : null;
      },
      async preflightRestore(saved, { signal }) {
        for (const side of saved.sides || []) {
          if (!stores().some((value) => value.sessionId === side.sessionId)) throw Error("snapshot-session-missing");
          if (side.addresses.some((address) => !parseFile(address))) throw Error("snapshot-file-address-invalid");
        }
        await docs.preflightRestore(saved, signal);
      },
      restore(saved) {
        docs.restore(saved);
        for (const side of saved.sides || []) {
          const store = stores().find((value) => value.sessionId === side.sessionId)?.store;
          if (!store) throw Error("snapshot-session-missing");
          const tabs = () => Object.values(store.getSnapshot().bySession?.[side.sessionId]?.layout.tabs || {});
          for (const address of side.addresses) {
            const file = parseFile(address);
            if (!file) throw Error("snapshot-file-address-invalid");
            if (!tabs().some((tab) => tab.contentId === address)) store.actions.openContent(side.sessionId, {
              kind: "text",
              contentId: address,
              title: file.path.split(/[\\/]/).at(-1),
              revealIfOpened: false
            }, () => {
            });
          }
          const active = tabs().find((tab) => tab.contentId === side.active);
          if (active) store.actions.focusTab(side.sessionId, active.id);
          store.actions.setExpanded(side.sessionId, side.expanded);
        }
      }
    };
  }

  // dsh-plugin/file-editor/close-guard.mjs
  function createCloseGuard(side, docs) {
    const original = side.removeAfterCleanup;
    if (typeof original !== "function") throw Error(t("\u5F53\u524D DSH \u7248\u672C\u4E0D\u652F\u6301\u6587\u4EF6\u5173\u95ED\u786E\u8BA4"));
    const descriptor = Object.getOwnPropertyDescriptor(side, "removeAfterCleanup");
    const listeners = /* @__PURE__ */ new Set();
    let state = { request: null, busy: false, error: "" }, release = () => {
    };
    const publish = (patch) => {
      state = { ...state, ...patch };
      for (const fn of listeners) fn();
    };
    const clear = () => {
      release();
      release = () => {
      };
      publish({ request: null, busy: false, error: "" });
    };
    const prune = (tab, doc) => {
      if (!side.openTabs.getSnapshot().some((value) => value.contentId === tab.contentId) && docs.documents.get(tab.contentId) === doc) docs.documents.delete(tab.contentId);
    };
    function intercept(sessionId, tab, commit) {
      const doc = tab.kind === "text" && docs.documents.get(tab.contentId);
      const shared = side.openTabs.getSnapshot().filter((value) => value.contentId === tab.contentId).length > 1;
      if (!doc || shared || !doc.dirty() && !doc.getSnapshot().saving) {
        const result = original.call(side, sessionId, tab, commit);
        if (doc) prune(tab, doc);
        return result;
      }
      return ask(sessionId, tab, doc, commit, "close");
    }
    function ask(sessionId, tab, doc, commit, kind) {
      if (state.request) return;
      const occurrence = side.tabDomain.occurrence(sessionId, tab);
      const navigation = occurrence.navigation.getSnapshot(), mounted = side.mounted.getSnapshot();
      const request = { doc, sessionId, tab, commit, kind, valid: () => !occurrence.signal.aborted && occurrence.navigation.getSnapshot() === navigation && side.mounted.getSnapshot() === mounted && side.tabsIn(sessionId).some((value) => value.id === tab.id && value.contentId === tab.contentId) };
      const check = () => {
        if (state.request === request && !request.valid()) clear();
      };
      const off = [occurrence.navigation.subscribe(check), side.openTabs.subscribe(check), side.mounted.subscribe(check)];
      occurrence.signal.addEventListener("abort", check);
      release = () => {
        off.forEach((fn) => fn());
        occurrence.signal.removeEventListener("abort", check);
      };
      publish({ request, busy: false, error: "" });
    }
    async function finish(request) {
      if (state.request !== request) return;
      if (!request.valid()) {
        clear();
        return;
      }
      try {
        if (request.kind === "reload") {
          publish({ busy: true, error: "" });
          await request.doc.load(true);
          if (state.request !== request) return;
          if (!request.valid()) {
            clear();
            return;
          }
          if (request.doc.getSnapshot().error) throw Error(request.doc.getSnapshot().error);
          request.commit();
        } else {
          original.call(side, request.sessionId, request.tab, request.commit);
          prune(request.tab, request.doc);
        }
        if (state.request === request) clear();
      } catch (error) {
        if (state.request === request) publish({ busy: false, error: error.message || t("\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5") });
      }
    }
    side.removeAfterCleanup = intercept;
    return {
      getSnapshot: () => state,
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      cancel: clear,
      reload(sessionId, tab, doc, commit = () => {
      }) {
        if (state.request || doc.getSnapshot().loading) return;
        if (doc.dirty() || doc.getSnapshot().saving) return ask(sessionId, tab, doc, commit, "reload");
        return doc.load(true).then(() => {
          if (!doc.getSnapshot().error && !tab.signal?.aborted) commit();
        });
      },
      discard() {
        const request = state.request;
        if (request && !state.busy && !request.doc.getSnapshot().saving) return finish(request);
      },
      async save() {
        const request = state.request;
        if (!request || state.busy || request.doc.getSnapshot().saving) return;
        if (!request.valid()) {
          clear();
          return;
        }
        publish({ busy: true, error: "" });
        try {
          const saved = !request.doc.dirty() || await request.doc.save();
          if (state.request !== request) return;
          if (saved && !request.doc.dirty() && !request.doc.getSnapshot().saving) await finish(request);
          else publish({ busy: false, error: request.doc.getSnapshot().error || t("\u6587\u4EF6\u4ECD\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\uFF0C\u8BF7\u518D\u6B21\u4FDD\u5B58\u540E\u7EE7\u7EED\u3002") });
        } catch (error) {
          if (state.request === request) publish({ busy: false, error: error.message || t("\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5") });
        }
      },
      dispose() {
        clear();
        listeners.clear();
        if (side.removeAfterCleanup !== intercept) return;
        if (descriptor) Object.defineProperty(side, "removeAfterCleanup", descriptor);
        else delete side.removeAfterCleanup;
      }
    };
  }

  // dsh-plugin/file-editor/reload-guard.mjs
  function bindReloadGuard(occurrence, actions, preview, reload) {
    const original = actions.bindCommands;
    const descriptor = Object.getOwnPropertyDescriptor(actions, "bindCommands");
    const bindings = /* @__PURE__ */ new Set();
    const wrap = (commands) => typeof commands.refresh === "function" ? { ...commands, refresh: () => reload(commands.refresh) } : commands;
    const initial = occurrence.commands, initialWrapped = wrap(initial);
    occurrence.commands = initialWrapped;
    function bind(commands) {
      const wrapped = wrap(commands);
      const binding = { commands, wrapped, off: original.call(actions, wrapped) };
      bindings.add(binding);
      return () => {
        binding.off();
        bindings.delete(binding);
      };
    }
    actions.bindCommands = bind;
    let replaying = false;
    const click = (event) => {
      const button = event.target.closest?.('[data-textpreview-tool="reload"], [data-textpreview-reload-now]');
      if (replaying || !button || !preview.contains(button)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      reload(() => {
        if (!button.isConnected) return;
        replaying = true;
        try {
          button.click();
        } finally {
          replaying = false;
        }
      });
    };
    preview.addEventListener("click", click, true);
    return () => {
      preview.removeEventListener("click", click, true);
      if (actions.bindCommands === bind) {
        if (descriptor) Object.defineProperty(actions, "bindCommands", descriptor);
        else delete actions.bindCommands;
      }
      if (occurrence.commands === initialWrapped) occurrence.commands = initial;
      for (const binding of bindings) {
        if (occurrence.commands !== binding.wrapped) continue;
        binding.off();
        binding.off = original.call(actions, binding.commands);
      }
    };
  }

  // dsh-plugin/compatibility/selectors.mjs
  function fileEditorObservation(ctx) {
    const methods = [
      [ctx.remote?.desktopFileEditor, "read"],
      [ctx.remote?.desktopFileEditor, "save"],
      ...["inject", "register", "subscribe", "entriesOfSlot", "resolveStore"].map((key) => [ctx.slots, key]),
      ...["removeAfterCleanup", "tabsIn"].map((key) => [ctx.sidebarRight, key]),
      [ctx.sidebarRight?.tabDomain, "occurrence"],
      [ctx.sidebarRight?.mounted, "getSnapshot"],
      [ctx.sidebarRight?.openTabs, "getSnapshot"],
      [ctx.sidebarRight?.openTabs, "subscribe"],
      [ctx.sidebarRight?.mounted, "subscribe"],
      [ctx.sessions, "scope"],
      [ctx.sessions?.list, "getSnapshot"]
    ];
    const available = methods.every(([owner, key]) => typeof owner?.[key] === "function");
    return {
      featureId: "file-editor",
      availability: available ? "limited" : "unavailable",
      implementation: "hybrid",
      pluginState: "enabled",
      reasonCodes: available ? ["file-editor-text-resource-limits"] : ["file-editor-contract-unavailable"],
      evidence: ["file-editor-service-selector"]
    };
  }

  // dsh-plugin/file-editor/style.css
  var style_default = "[data-textpreview-body]:has(.dshFileEditor) { display:flex; flex-direction:column; overflow:hidden; }\n.dshFileEditor { --editor-keyword:#8b36ad; --editor-string:#267541; --editor-number:#946000; --editor-comment:#667381; --editor-function:#175bbb; display:flex; flex:1; flex-direction:column; min-width:0; min-height:0; height:100%; white-space:normal; color:var(--dsw-alias-label-primary); font-family:var(--dsw-font-family,system-ui); }\nbody[data-ds-dark-theme] .dshFileEditor { --editor-keyword:#d6a5f2; --editor-string:#a4d59a; --editor-number:#e5bc80; --editor-comment:#9aa6b3; --editor-function:#9cc6fa; }\n.dshFileEditor__button { cursor:pointer; border:1px solid var(--dsw-alias-border-l2); border-radius:5px; padding:4px 9px; min-height:28px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); font:inherit; }\n.dshFileEditor__button:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }\n.dshFileEditor__button:disabled { cursor:default; opacity:.5; }\n.dshFileEditor__button:focus-visible { outline:2px solid var(--dsw-alias-label-primary); outline-offset:2px; }\n.dshFileEditor__toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid var(--dsw-alias-border-l3); font-size:12px; flex:none; }\n.dshFileEditor__preview { flex:1; min-width:0; min-height:0; overflow:auto; }\n.dshFileEditor__preview > iframe { display:block; width:100%; height:100%; min-height:0; border:0; background:white; }\n.dshFileEditor__error { margin:0; padding:8px 10px; font-size:12px; white-space:normal; overflow-wrap:anywhere; border-bottom:1px solid var(--dsw-alias-border-l2); flex:none; }\n.dshFileEditor__error .dshFileEditor__button { margin-left:8px; }\n.dshFileEditor__empty { padding:24px; white-space:normal; font-size:13px; }\n.dshFileEditor__host { flex:1; min-height:0; min-width:0; overflow:hidden; }\n.dshFileEditor .cm-editor { height:100%; font-size:13px; background:transparent; color:var(--dsw-alias-label-primary); }\n.dshFileEditor .cm-editor.cm-focused { outline:1px solid var(--dsw-alias-border-l2); outline-offset:-1px; }\n.dshFileEditor .cm-scroller { overflow:auto; font-family:var(--dsw-font-mono,Consolas,monospace); line-height:1.6; }\n.dshFileEditor .cm-gutters { color:var(--dsw-alias-label-tertiary); background:var(--dsw-alias-bg-layer-2); border-right:1px solid var(--dsw-alias-border-l3); }\n.dshFileEditor .cm-activeLine, .dshFileEditor .cm-activeLineGutter { background:var(--dsw-alias-interactive-bg-hover); }\n.dshFileEditor .cm-cursor { border-left-color:var(--dsw-alias-label-primary); }\n.dshFileEditor .cm-selectionBackground, .dshFileEditor .cm-editor.cm-focused .cm-selectionBackground { background:color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent); }\n.dshFileEditor .cm-panels, .dshFileEditor .cm-tooltip { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l2); }\n.dshFileEditor .cm-search { white-space:normal; }\n.dshFileEditor .cm-search input { max-width:140px; color:inherit; background:var(--dsw-alias-bg-layer-1); }\n.dshFileEditor__footer { display:flex; flex-wrap:wrap; gap:10px; padding:4px 10px; border-top:1px solid var(--dsw-alias-border-l3); color:var(--dsw-alias-label-secondary); font-size:11px; flex:none; }\n.dshFileEditor__dirty { margin-left:6px; font-size:11px; }\n.dshFileEditor__closeDialog { max-height:100%; }\n.dshFileEditor__closeContent { min-height:0; overflow-y:auto; }\n.dshFileEditor__closeBody { display:flex; flex-direction:column; gap:8px; font-size:14px; line-height:22px; color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; }\n.dshFileEditor__closeBody p { margin:0; }\n.dshFileEditor__closeName { font-weight:500; }\n.dshFileEditor__closeHint { color:var(--dsw-alias-label-secondary); }\n.dshFileEditor__closeError { color:var(--dsw-alias-label-primary); }\n.dshFileEditor__closeActions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; width:100%; }\n";

  // dsh-plugin/file-editor/client-entry.mjs
  window.__ModuleLoader__.load({ id: ID, factory(require2) {
    const React = require2("react"), h = React.createElement;
    const { FileTypeIcon, Modal, Button } = require2("@deepseek-ai/dsh-client-ui-primitives");
    function install(ctx) {
      const capability = fileEditorObservation(ctx);
      window.__DSH_CAPABILITIES__?.report(capability);
      if (capability.availability === "unavailable") return () => {
      };
      const offCapability = window.__DSH_CAPABILITIES__?.watch("file-editor", () => fileEditorObservation(ctx));
      const docs = createDocuments(ctx.remote.desktopFileEditor);
      const closeGuard = createCloseGuard(ctx.sidebarRight, docs);
      const style = document.createElement("style");
      style.textContent = style_default;
      document.head.append(style);
      const useDoc = (address) => {
        const doc = docs.get(address);
        return [doc, React.useSyncExternalStore(doc.subscribe, doc.getSnapshot, doc.getSnapshot)];
      };
      function useFileTab(props, nativePreview = false) {
        const { tab } = props.useTabInfo(), [doc, state] = useDoc(props.resourceAddress);
        const section = React.useRef(null);
        const sessionId = React.useMemo(() => ctx.sidebarRight.openTabs.getSnapshot().find((value) => value.tabId === tab.id)?.sessionId ?? ctx.sidebarRight.mounted.getSnapshot(), [tab.actions]);
        React.useLayoutEffect(() => {
          const preview = section.current?.closest("[data-textpreview-url]");
          if (!preview) return;
          const occurrence = ctx.sidebarRight.tabDomain.occurrence(sessionId, tab);
          return bindReloadGuard(
            occurrence,
            tab.actions,
            preview,
            (commit) => nativePreview && !doc.dirty() && !doc.getSnapshot().saving ? commit() : closeGuard.reload(sessionId, tab, doc, commit)
          );
        }, [doc, tab.actions, sessionId, nativePreview]);
        const viewer = React.useMemo(() => {
          const handle = ctx.slots.entriesOfSlot("sidebar.right.pane.tab").find((entry) => entry.options.key === "@deepseek-ai/dsh-client-ui-sidebar-documentpreview")?.store;
          const scope = ctx.sessions.scope(sessionId);
          return handle && scope ? ctx.slots.resolveStore(handle, { key: sessionId, ctx: scope }) : null;
        }, [sessionId]);
        return { tab, doc, state, section, sessionId, viewer };
      }
      function Editor(props) {
        useLocale(React);
        const { tab, doc, state, section, sessionId, viewer } = useFileTab(props);
        const host = React.useRef(null), editor = React.useRef(null);
        const [cursor, setCursor] = React.useState({ line: 1, column: 1 });
        const [engineError, setEngineError] = React.useState(""), [engineAttempt, retryEngine] = React.useState(0);
        const wrapping = React.useRef(props.wrap);
        wrapping.current = props.wrap;
        const content = props.content;
        React.useEffect(() => {
          void doc.load();
        }, [doc]);
        React.useEffect(() => {
          void (async () => {
            if (!doc.dirty() && !doc.getSnapshot().saving) await doc.load(true);
            const current = doc.getSnapshot();
            if (content.kind === "renderer") {
              if (current.version) content.loaded(current.version);
              else content.failed();
            }
          })();
        }, [doc, content.kind === "renderer" ? content.revision : content.text]);
        const ready = state.version !== null;
        React.useLayoutEffect(() => {
          if (!ready || !host.current) return;
          let current = true;
          setEngineError("");
          void loadEditor().then(({ mountEditor }) => {
            if (!current || !host.current) return;
            editor.current = mountEditor(host.current, doc, {
              mode: props.mode,
              wrap: wrapping.current,
              onCursor: setCursor,
              scrollportRef: props.scrollportRef,
              line: tab.navigation.params?.line
            });
          }).catch(() => {
            if (current) setEngineError(t("\u7F16\u8F91\u5668\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5"));
          });
          return () => {
            current = false;
            editor.current?.destroy();
            editor.current = null;
          };
        }, [doc, ready, props.mode, engineAttempt]);
        React.useEffect(() => {
          editor.current?.wrap(props.wrap);
        }, [props.wrap]);
        React.useEffect(() => {
          if (tab.visible) editor.current?.measure();
        }, [tab.visible]);
        const reload = () => closeGuard.reload(sessionId, tab, doc);
        const canPreview = /\.html?$/i.test(doc.file.path) && viewer?.actions.selected && ctx.slots.entriesOfSlot("sidebar.right.tab.document").some((entry) => entry.options.key === HTML_ID);
        return h(
          "section",
          { ref: section, className: "dshFileEditor", "data-dsh-file-editor": props.resourceAddress, "data-editor-mode": props.mode, "aria-label": t("\u6587\u4EF6\u7F16\u8F91"), "aria-busy": state.loading || state.saving },
          canPreview && h(
            "div",
            { className: "dshFileEditor__toolbar" },
            h("button", {
              type: "button",
              className: "dshFileEditor__button",
              disabled: !ready || state.loading,
              onClick: () => viewer.actions.selected(tab.id, HTML_ID)
            }, t("\u9884\u89C8 HTML"))
          ),
          (state.error || engineError) && h(
            "div",
            { className: "dshFileEditor__error", role: "alert" },
            state.error || engineError,
            h("button", {
              type: "button",
              className: "dshFileEditor__button",
              onClick: engineError ? () => retryEngine((n) => n + 1) : reload,
              disabled: state.loading || state.saving
            }, engineError ? t("\u91CD\u8BD5") : ready ? t("\u91CD\u65B0\u8BFB\u53D6") : t("\u91CD\u8BD5"))
          ),
          ready ? h("div", { ref: host, className: "dshFileEditor__host" }) : h("div", { className: "dshFileEditor__empty" }, state.loading ? t("\u6B63\u5728\u8BFB\u53D6\u5B8C\u6574\u6587\u4EF6\u2026") : t("\u6587\u4EF6\u5185\u5BB9\u672A\u8F7D\u5165\u3002")),
          ready && h(
            "div",
            { className: "dshFileEditor__footer" },
            h("span", null, t("\u7B2C {0} \u884C\uFF0C\u7B2C {1} \u5217", [cursor.line, cursor.column])),
            h("span", null, state.bom ? "UTF-8 BOM" : "UTF-8"),
            h("span", null, state.eol === "\r\n" ? "CRLF" : state.eol === "\r" ? "CR" : "LF")
          )
        );
      }
      function HtmlPreview({ Native, ...props }) {
        useLocale(React);
        const { tab, doc, state, section, sessionId } = useFileTab(props, true);
        React.useEffect(() => {
          const current = doc.getSnapshot();
          if (current.version !== null && !doc.dirty() && !current.saving) void doc.load(true);
        }, [doc, props.content.kind === "bytes" ? props.content.data : props.content.revision]);
        const draft = doc.dirty() ? state.text : null;
        const text = state.version !== null && (!state.error || draft !== null) ? state.text : null;
        const content = React.useMemo(() => text === null ? props.content : { kind: "bytes", data: new TextEncoder().encode(text) }, [text, props.content]);
        return h(
          "section",
          {
            ref: section,
            className: "dshFileEditor dshFileEditor--preview",
            "data-dsh-file-editor": props.resourceAddress,
            "data-editor-mode": "html",
            "aria-label": t("HTML \u9884\u89C8"),
            "aria-busy": state.loading || state.saving
          },
          state.error && h(
            "div",
            { className: "dshFileEditor__error", role: "alert" },
            state.error,
            h("button", {
              type: "button",
              className: "dshFileEditor__button",
              disabled: state.loading || state.saving,
              onClick: () => closeGuard.reload(sessionId, tab, doc)
            }, t("\u91CD\u65B0\u8BFB\u53D6"))
          ),
          h("div", { className: "dshFileEditor__preview" }, h(Native, { ...props, content }))
        );
      }
      function Title(props) {
        const { tab } = props.useTabInfo(), file = parseFile(tab.contentId);
        if (!file) return tab.title;
        return h(FileTitle, { address: tab.contentId, path: file.path });
      }
      function FileTitle({ address, path }) {
        useLocale(React);
        const [doc] = useDoc(address);
        return h(
          React.Fragment,
          null,
          h(FileTypeIcon, { path, size: 16 }),
          path.split(/[\\/]/).at(-1),
          doc.dirty() && h("span", { className: "dshFileEditor__dirty", "aria-label": t("\u672A\u4FDD\u5B58"), title: t("\u672A\u4FDD\u5B58") }, "\u25CF")
        );
      }
      function CloseDialog() {
        useLocale(React);
        const state = React.useSyncExternalStore(closeGuard.subscribe, closeGuard.getSnapshot, closeGuard.getSnapshot);
        return state.request ? h(UnsavedDialog, { state }) : null;
      }
      function UnsavedDialog({ state }) {
        useLocale(React);
        const { doc, kind } = state.request;
        const reloading = kind === "reload";
        const file = React.useSyncExternalStore(doc.subscribe, doc.getSnapshot, doc.getSnapshot);
        const busy = state.busy || file.saving, error = state.error || file.error;
        const descriptionId = React.useId();
        return h(Modal, {
          open: true,
          title: t("\u4FDD\u5B58\u66F4\u6539\uFF1F"),
          closeLabel: reloading ? t("\u53D6\u6D88\u91CD\u65B0\u8BFB\u53D6") : t("\u53D6\u6D88\u5173\u95ED"),
          onClose: closeGuard.cancel,
          className: "dshFileEditor__closeDialog",
          contentClassName: "dshFileEditor__closeContent",
          footer: h(
            "div",
            { className: "dshFileEditor__closeActions" },
            h(Button, { variant: "outline", "data-modal-autofocus": "", onClick: closeGuard.cancel }, t("\u53D6\u6D88")),
            h(Button, { variant: "outline", disabled: busy, onClick: closeGuard.discard }, t("\u4E0D\u4FDD\u5B58")),
            h(Button, { variant: "primary", disabled: busy || file.loading || file.conflict, onClick: closeGuard.save }, busy ? file.loading ? t("\u6B63\u5728\u8BFB\u53D6\u2026") : t("\u6B63\u5728\u4FDD\u5B58\u2026") : reloading ? t("\u4FDD\u5B58\u540E\u91CD\u65B0\u8BFB\u53D6") : t("\u4FDD\u5B58\u5E76\u5173\u95ED"))
          )
        }, h(
          "div",
          { className: "dshFileEditor__closeBody", "aria-busy": busy, ref: (node) => {
            node?.closest('[role="dialog"]')?.setAttribute("aria-describedby", descriptionId);
          } },
          h("p", { id: descriptionId }, "\u201C", h("span", { className: "dshFileEditor__closeName", title: doc.file.path }, doc.file.path.split(/[\\/]/).at(-1)), t("\u201D\u6709\u672A\u4FDD\u5B58\u7684\u66F4\u6539\u3002")),
          h("p", { className: "dshFileEditor__closeHint" }, (reloading ? t("\u91CD\u65B0\u8BFB\u53D6\u524D\u662F\u5426\u4FDD\u5B58\uFF1F") : t("\u5173\u95ED\u524D\u662F\u5426\u4FDD\u5B58\uFF1F")) + t("\u9009\u62E9\u201C\u4E0D\u4FDD\u5B58\u201D\u5C06\u4E22\u5931\u8FD9\u4E9B\u66F4\u6539\u3002")),
          error && h("p", { className: "dshFileEditor__closeError", role: "alert" }, error)
        ));
      }
      const off = [() => closeGuard.dispose()];
      off.push(ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "desktop-file-editor-close" }, CloseDialog)));
      for (const [key, mode] of [[PLAIN_ID, "plain"], [CODE_ID, "code"]]) off.push(ctx.slots.inject("sidebar.right.tab.document", () => ctx.slots.register({
        name: "sidebar.right.tab.document",
        key,
        priority: -10
      }, (props) => h(Editor, { ...props, mode }))));
      off.push(ctx.slots.inject("sidebar.right.tab.document", () => {
        let remove, registering = false;
        const attach = () => {
          if (remove || registering) return;
          const native = ctx.slots.entriesOfSlot("sidebar.right.tab.document").find((entry) => entry.options.key === HTML_ID);
          if (!native) return;
          registering = true;
          try {
            remove = ctx.slots.register({
              name: "sidebar.right.tab.document",
              key: HTML_ID,
              priority: -10,
              inject: native.inject,
              locale: native.locale,
              store: native.store
            }, (props) => h(HtmlPreview, { ...props, Native: native.component }));
          } finally {
            registering = false;
          }
        };
        const unsubscribe = ctx.slots.subscribe("sidebar.right.tab.document", attach);
        attach();
        return () => {
          unsubscribe();
          remove?.();
        };
      }));
      off.push(ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
        name: "sidebar.right.pane.tab.title",
        key: "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
        priority: -10
      }, Title)));
      const beforeUnload = (event) => {
        if (docs.unsettled()) {
          event.preventDefault();
          event.returnValue = "";
        }
      };
      const keydown = (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "s") return;
        const root = event.target.closest?.("[data-dsh-file-editor]");
        if (!root) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void docs.get(root.getAttribute("data-dsh-file-editor")).save();
      };
      window.addEventListener("beforeunload", beforeUnload);
      window.addEventListener("keydown", keydown, true);
      const provider = createStateProvider(ctx, docs), capture = provider.capture;
      provider.capture = () => {
        if (closeGuard.getSnapshot().request) throw Error(t("\u8BF7\u5148\u5904\u7406\u672A\u4FDD\u5B58\u6587\u4EF6\u7684\u4FDD\u5B58\u786E\u8BA4\u63D0\u793A\uFF0C\u518D\u91CD\u542F\u3002"));
        return capture();
      };
      off.push(window.__DSH_UI_STATE__?.registerProvider("desktop-file-editor", provider));
      return () => {
        offCapability?.();
        off.reverse().forEach((fn) => fn?.());
        style.remove();
        window.removeEventListener("beforeunload", beforeUnload);
        window.removeEventListener("keydown", keydown, true);
      };
    }
    return { inject: ["slots", "sidebarRight", "sessions", "remote"], async apply(ctx) {
      const offRemote = await ctx.remote.$mount(contribution);
      const fiber = ctx.inject(["remote.desktopFileEditor"], install);
      return async () => {
        await fiber.dispose();
        await offRemote();
      };
    } };
  } });
})();
