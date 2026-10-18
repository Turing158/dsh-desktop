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

  // dsh-plugin/sidebar-changes/shared/change-model.mjs
  var SOURCES = ["session", "working", "staged"];
  var VIEWS = [...SOURCES, "history"];
  var LABELS = { get session() {
    return t("\u5F53\u524D\u4F1A\u8BDD");
  }, get working() {
    return t("\u672A\u63D0\u4EA4");
  }, get staged() {
    return t("\u6682\u5B58\u533A");
  }, get history() {
    return t("\u63D0\u4EA4\u8BB0\u5F55");
  } };
  var BASES = { get session() {
    return [t("\u9996\u6B21\u4FEE\u6539\u524D"), t("\u672C\u4F1A\u8BDD\u6700\u540E\u4FEE\u6539\u540E")];
  }, get working() {
    return ["HEAD", t("\u5DE5\u4F5C\u533A")];
  }, get staged() {
    return ["HEAD", t("\u6682\u5B58\u533A")];
  } };
  var LIMITS = { bytes: 1024 * 1024, lines: 4e4, cells: 4e6, files: 2e3, operations: 1e4, disk: 256 * 1024 * 1024, scanBytes: 32 * 1024 * 1024 };
  var REASONS = {
    get binary() {
      return t("\u4E8C\u8FDB\u5236\u6587\u4EF6\u4E0D\u80FD\u9010\u884C\u5C55\u793A");
    },
    get encoding() {
      return t("\u6587\u4EF6\u4E0D\u662F\u6709\u6548\u7684 UTF-8 \u6587\u672C");
    },
    get large() {
      return t("\u6587\u4EF6\u8D85\u8FC7\u6587\u672C\u6BD4\u8F83\u9650\u5236");
    },
    get complexity() {
      return t("\u5DEE\u5F02\u8BA1\u7B97\u8D85\u8FC7\u590D\u6742\u5EA6\u9650\u5236");
    },
    get baseline() {
      return t("\u7F3A\u5C11\u9996\u6B21\u4FEE\u6539\u524D\u7684\u5B8C\u6574\u5185\u5BB9");
    },
    get interleaved() {
      return t("\u5B58\u5728\u5916\u90E8\u6216\u5176\u4ED6\u4F1A\u8BDD\u7684\u4EA4\u9519\u4FEE\u6539\uFF0C\u7D2F\u8BA1\u8BB0\u5F55\u4E0D\u5B8C\u6574");
    },
    get observed() {
      return t("\u6267\u884C\u671F\u95F4\u89C2\u5BDF\u5230\u7684\u53D8\u5316\uFF0C\u65E0\u6CD5\u786E\u8BA4\u4FEE\u6539\u4F5C\u8005");
    },
    get quota() {
      return t("\u5FEB\u7167\u5B58\u50A8\u5DF2\u8FBE\u5230\u914D\u989D\uFF0C\u8BB0\u5F55\u4E0D\u5B8C\u6574");
    },
    get interrupted() {
      return t("\u8C03\u7528\u672A\u5B8C\u6210\u6216\u8FDB\u7A0B\u4E2D\u65AD\uFF0C\u53EF\u80FD\u5B58\u5728\u672A\u8BB0\u5F55\u7684\u4FEE\u6539");
    },
    get storage() {
      return t("\u5FEB\u7167\u8BFB\u5199\u5931\u8D25\uFF0C\u8BB0\u5F55\u4E0D\u5B8C\u6574");
    },
    get legacy() {
      return t("\u6B64\u8C03\u7528\u6CA1\u6709\u63D0\u4F9B\u5B8C\u6574\u524D\u540E\u5185\u5BB9\uFF0C\u4EC5\u80FD\u4FDD\u7559\u89C2\u5BDF\u8BB0\u5F55");
    },
    get scan() {
      return t("\u90E8\u5206\u8DEF\u5F84\u672A\u88AB\u626B\u63CF\u8986\u76D6");
    },
    get conflict() {
      return t("\u6587\u4EF6\u5B58\u5728\u5408\u5E76\u51B2\u7A81");
    },
    get submodule() {
      return t("Git \u5B50\u6A21\u5757\u53D8\u5316");
    },
    get symlink() {
      return t("\u7B26\u53F7\u94FE\u63A5\u6216\u6587\u4EF6\u7C7B\u578B\u53D8\u5316");
    },
    get stale() {
      return t("\u5185\u5BB9\u7248\u672C\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u8BD5");
    },
    get missing() {
      return t("\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u8BBF\u95EE");
    },
    get unsupported() {
      return t("\u6267\u884C\u7AEF\u6587\u4EF6\u7CFB\u7EDF\u4E0D\u652F\u6301\u672C\u5730\u91C7\u96C6");
    },
    get "history-stale"() {
      return t("\u63D0\u4EA4\u8BB0\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u8BD5");
    },
    get "history-large"() {
      return t("\u63D0\u4EA4\u6D88\u606F\u6216\u5386\u53F2\u6570\u636E\u8D85\u8FC7\u8BFB\u53D6\u9650\u5236");
    },
    get concurrent() {
      return t("\u5B58\u5728\u91CD\u53E0\u6267\u884C\uFF0C\u6309\u5DF2\u8BB0\u5F55\u7247\u6BB5\u5C55\u793A");
    },
    get "legacy-scan"() {
      return t("\u5386\u53F2\u8BB0\u5F55\u7684\u91C7\u96C6\u8303\u56F4\u4E0D\u5B8C\u6574");
    },
    get "scan-content"() {
      return t("\u626B\u63CF\u5185\u5BB9\u9884\u7B97\u4E0D\u8DB3\uFF0C\u90E8\u5206\u6587\u4EF6\u53EA\u8BB0\u5F55\u72B6\u6001");
    },
    get excluded() {
      return t("\u90E8\u5206\u8DEF\u5F84\u6309\u914D\u7F6E\u6392\u9664\uFF0C\u8986\u76D6\u8303\u56F4\u6709\u9650");
    },
    get "git-busy"() {
      return t("\u5F53\u524D\u4ED3\u5E93\u6B63\u5728\u6267\u884C Git \u64CD\u4F5C\uFF0C\u8BF7\u7A0D\u5019\u3002");
    },
    get "git-invalid-action"() {
      return t("\u6B64 Git \u64CD\u4F5C\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002");
    },
    get "git-message"() {
      return t("\u8BF7\u586B\u5199\u63D0\u4EA4\u8BF4\u660E\uFF0C\u6700\u591A 65536 \u4E2A\u5B57\u7B26\u3002");
    },
    get "git-unavailable"() {
      return t("\u5F53\u524D Git \u4ED3\u5E93\u4E0D\u53EF\u7528\uFF0C\u8BF7\u68C0\u67E5\u5DE5\u4F5C\u76EE\u5F55\u3002");
    },
    get "git-empty-stage"() {
      return t("\u5F53\u524D\u89C6\u56FE\u6CA1\u6709\u53EF\u6682\u5B58\u7684\u66F4\u6539\u3002");
    },
    get "git-empty-index"() {
      return t("\u6682\u5B58\u533A\u6CA1\u6709\u53EF\u63D0\u4EA4\u7684\u66F4\u6539\u3002");
    },
    get "git-conflict"() {
      return t("\u8BF7\u5148\u89E3\u51B3\u5408\u5E76\u51B2\u7A81\u5E76\u6682\u5B58\uFF0C\u518D\u63D0\u4EA4\u3002");
    },
    get "git-other-root"() {
      return t("\u66F4\u6539\u5305\u542B\u5176\u4ED6\u5DE5\u4F5C\u76EE\u5F55\u7684\u6587\u4EF6\uFF0C\u8BF7\u5207\u6362\u5230\u201C\u672A\u63D0\u4EA4\u201D\u540E\u91CD\u8BD5\u3002");
    },
    get "git-outside-index"() {
      return t("\u6682\u5B58\u533A\u5305\u542B\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u4E4B\u5916\u7684\u66F4\u6539\uFF0C\u8BF7\u5207\u6362\u5230\u4ED3\u5E93\u6839\u76EE\u5F55\u540E\u63D0\u4EA4\u3002");
    },
    get "git-detached"() {
      return t("\u5F53\u524D\u5904\u4E8E\u5206\u79BB HEAD \u72B6\u6001\uFF0C\u8BF7\u5148\u9009\u62E9\u672C\u5730\u5206\u652F\u3002");
    },
    get "git-no-remote"() {
      return t("\u6CA1\u6709\u53EF\u7528\u7684\u63A8\u9001\u8FDC\u7A0B\u4ED3\u5E93\uFF0C\u8BF7\u5148\u914D\u7F6E Git \u8FDC\u7A0B\u4ED3\u5E93\u3002");
    },
    get "git-head-changed"() {
      return t("\u5F53\u524D\u5206\u652F\u6216\u63D0\u4EA4\u5DF2\u6539\u53D8\uFF0C\u8BF7\u68C0\u67E5\u4ED3\u5E93\u540E\u91CD\u65B0\u63A8\u9001\u3002");
    },
    get "git-timeout"() {
      return t("Git \u64CD\u4F5C\u8D85\u65F6\uFF0C\u8BF7\u68C0\u67E5\u4ED3\u5E93\u72B6\u6001\u540E\u91CD\u8BD5\u3002");
    },
    get "git-failed"() {
      return t("Git \u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u9519\u8BEF\u4FE1\u606F\u540E\u91CD\u8BD5\u3002");
    },
    get "git-no-head"() {
      return t("\u5C1A\u65E0\u63D0\u4EA4\uFF0C\u8BF7\u5148\u521B\u5EFA\u9996\u6B21\u63D0\u4EA4\u3002");
    },
    get "git-up-to-date"() {
      return t("\u6CA1\u6709\u5F85\u63A8\u9001\u7684\u63D0\u4EA4\u3002");
    },
    get "git-branch-in-use"() {
      return t("\u5206\u652F\u6B63\u88AB\u5176\u4ED6\u5DE5\u4F5C\u6811\u4F7F\u7528\u3002");
    },
    get "git-generation-unavailable"() {
      return t("\u6267\u884C\u7AEF\u672A\u914D\u7F6E\u53EF\u7528\u6A21\u578B\uFF0C\u8BF7\u586B\u5199\u63D0\u4EA4\u4FE1\u606F\u3002");
    },
    get "git-generation-failed"() {
      return t("\u63D0\u4EA4\u4FE1\u606F\u751F\u6210\u5931\u8D25\uFF0C\u8BF7\u586B\u5199\u540E\u91CD\u8BD5\u3002");
    },
    get "git-generation-large"() {
      return t("\u66F4\u6539\u8D85\u8FC7\u751F\u6210\u9650\u5236\uFF0C\u8BF7\u586B\u5199\u63D0\u4EA4\u4FE1\u606F\u3002");
    },
    get "git-result-unknown"() {
      return t("\u64CD\u4F5C\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u72B6\u6001\u3002");
    },
    get "git-upgrade-required"() {
      return t("\u8BF7\u66F4\u65B0\u6267\u884C\u7AEF\u540E\u4F7F\u7528\u63D0\u4EA4\u5F39\u7A97\u3002");
    }
  };
  var codec = (name) => ({ mode: "strict", typeSymbol: "@dsh-desktop/sidebar-changes#" + name, create: () => ({ parse(value) {
    const valid = name === "offset" ? Number.isSafeInteger(value) && value >= 0 : typeof value === "string" && value.length <= (name === "message" ? 65536 : 512) && !value.includes("\0") && (name !== "source" || SOURCES.includes(value)) && (name !== "action" || ["stage", "commit", "push", "pushOnly"].includes(value)) && (name !== "branch" || value.length > 0 && !value.startsWith("-") && !/[\s~^:?*\[\\]/.test(value)) && (!["commitId", "committedId"].includes(name) || name === "committedId" && value === "" || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value));
    if (!valid) throw Error("Invalid changes query parameter: " + name);
    return value;
  } }) });
  var contribution = { package: "@dsh-desktop/sidebar-changes", descriptors: [
    ["getCapabilities", []],
    ["listChanges", ["source"]],
    ["getFileDiff", ["source", "fileId", "revision", "offset"]],
    ["getFileContext", ["source", "fileId", "revision", "offset"]],
    ["subscribeChanges", ["sinceRevision"]],
    ["listCommits", ["revision", "offset"]],
    ["getCommitDetails", ["revision", "commitId"]],
    ["listFileOperations", ["fileId", "revision", "recordKind", "offset"]],
    ["getOperationDiff", ["fileId", "revision", "operationId", "offset"]],
    ["runGitAction", ["action", "source", "revision", "message", "committedId"]],
    ["getGitContext", ["source"]],
    ["listGitBranches", []],
    ["switchGitBranch", ["branch", "contextRevision"]],
    ["generateCommitMessage", ["source", "contextRevision"]],
    ["getGitOperation", ["contextRevision"]]
  ].map(([method, args]) => ({
    id: "desktopChanges/" + method,
    service: "desktopChanges",
    namespace: "desktopChanges",
    method,
    invocation: { kind: "direct" },
    ...["subscribeChanges", "runGitAction"].includes(method) ? { mode: "stream" } : {},
    parameters: [
      { name: "scope", wire: "sessionId", source: "lookup", lookup: "desktopChangesScope", codec: codec("sessionId") },
      ...args.map((name) => ({ name, wire: name, source: "json", codec: codec(name) }))
    ],
    cancellation: { parameter: "signal" },
    result: { mode: "src-json" }
  })) };

  // dsh-plugin/sidebar-changes/file-resource.mjs
  var FILE_KIND = "desktop-change";
  var FILE_PREFIX = "dsh-resource://desktop-change/";
  var changeAddress = (sessionId, source, entry) => FILE_PREFIX + [sessionId, source, entry.fileId, entry.path].map(encodeURIComponent).join("/");
  function parseChangeAddress(address) {
    if (typeof address !== "string" || !address.startsWith(FILE_PREFIX)) return null;
    try {
      const parts = address.slice(FILE_PREFIX.length).split("/").map(decodeURIComponent);
      if (parts.length !== 4 || parts.some((part) => !part || /[\0\r\n]/.test(part)) || !SOURCES.includes(parts[1])) return null;
      const [sessionId, source, fileId, path] = parts;
      return { sessionId, source, fileId, path };
    } catch {
      return null;
    }
  }
  var changeTitle = (address) => {
    const file = parseChangeAddress(address);
    return file ? file.path.split(/[\\/]/).at(-1) + " \xB7 " + t("\u66F4\u6539") : t("\u67E5\u770B\u66F4\u6539");
  };
  function absoluteFilePath(entry, workspaceRoot) {
    return entry.absolutePath || (workspaceRoot ? workspaceRoot.replace(/[\\/]$/, "") + "/" + entry.path : null);
  }
  var fileAddress = (sessionId, path) => "dsh-resource://file/session/" + encodeURIComponent(sessionId) + "/" + encodeURIComponent(path);

  // dsh-plugin/sidebar-changes/client-state.mjs
  var PREFIX = "dsh-resource://desktop-changes/";
  function migrateFileIds(ids, entries) {
    return [...new Set(ids.flatMap((id) => {
      const exact = entries.find((entry) => entry.fileId === id);
      if (exact) return [exact.fileId];
      const matches = entries.filter((entry) => entry.aliases?.includes(id));
      return matches.length === 1 ? [matches[0].fileId] : [];
    }))];
  }
  function createViewStates(states, view) {
    return {
      get(key) {
        const saved = states.get(key);
        const { views, ...legacy } = saved || {};
        return views?.[view] || (saved?.source === view ? legacy : { source: view, fileId: null, listScroll: 0, detailScroll: 0 });
      },
      set(key, value) {
        const saved = states.get(key) || { source: view };
        states.set(key, { ...saved, views: { ...saved.views, [view]: value } });
      }
    };
  }
  var isChanges = (tab) => tab?.kind === "desktop-changes" && tab.contentId?.startsWith(PREFIX) || tab?.kind === FILE_KIND && Boolean(parseChangeAddress(tab.contentId));
  function stores(ctx) {
    const handle = ctx.slots.entriesOfSlot("rightbar.session")[0]?.store;
    if (!handle?.create) return [];
    return ctx.sessions.list.getSnapshot().ids.flatMap((sessionId) => {
      const scope = ctx.sessions.scope(sessionId);
      return scope ? [{ sessionId, store: ctx.slots.resolveStore(handle, { key: sessionId, ctx: scope }) }] : [];
    });
  }
  function createStateProvider(ctx, states) {
    return {
      version: 1,
      owns: (node) => Boolean(node?.closest?.("[data-dsh-changes]")),
      ownsSidebar() {
        const list = ctx.sessions.list.getSnapshot(), current = list.current ?? Object.values(list.byId || {}).find((row) => row.retainedBy?.mainView > 0)?.id;
        const surface = stores(ctx).find((value) => value.sessionId === current);
        const tabs = Object.values(surface?.store.getSnapshot().bySession?.[current]?.layout.tabs || {});
        return tabs.some(isChanges) && tabs.every((tab) => isChanges(tab) || tab.kind === "guide");
      },
      capture() {
        const sides = [];
        for (const { sessionId, store } of stores(ctx)) {
          const layout = store.getSnapshot().bySession?.[sessionId]?.layout;
          if (!layout) continue;
          const tabs = Object.values(layout.tabs).filter(isChanges);
          if (!tabs.length) continue;
          sides.push({
            sessionId,
            expanded: Boolean(layout.expanded),
            tabs: tabs.map((tab) => ({ address: tab.contentId, state: states.get(sessionId + "\0" + tab.contentId) || { source: parseChangeAddress(tab.contentId)?.source || "session", fileId: null, listScroll: 0, detailScroll: 0 } })),
            active: tabs.find((tab) => layout.nodes[layout.activePaneId]?.activeTabId === tab.id)?.contentId || null
          });
        }
        return sides.length ? { sides } : null;
      },
      async restore(saved) {
        for (const side of saved.sides) {
          const store = stores(ctx).find((value) => value.sessionId === side.sessionId)?.store;
          if (!store) throw Error("snapshot-session-missing");
          const tabs = () => Object.values(store.getSnapshot().bySession?.[side.sessionId]?.layout.tabs || {});
          for (const tab of side.tabs) {
            const file = parseChangeAddress(tab.address);
            if (!file && !tab.address.startsWith(PREFIX) || !VIEWS.includes(tab.state.source)) throw Error("snapshot-panel-unsupported");
            states.set(side.sessionId + "\0" + tab.address, tab.state);
            if (!tabs().some((value) => value.contentId === tab.address)) store.actions.openContent(
              side.sessionId,
              { kind: file ? FILE_KIND : "desktop-changes", contentId: tab.address, title: file ? changeTitle(tab.address) : "\u66F4\u6539", revealIfOpened: false },
              () => {
              }
            );
          }
          const active = tabs().find((tab) => tab.contentId === side.active);
          if (active) store.actions.focusTab(side.sessionId, active.id);
          store.actions.setExpanded(side.sessionId, side.expanded);
        }
        document.dispatchEvent(new Event("dsh-desktop:changes-restore"));
      }
    };
  }

  // dsh-plugin/sidebar-changes/shared/commit-graph.mjs
  function layoutCommits(entries) {
    let lanes = [], nextColor = 0;
    return entries.map((entry) => {
      const before = lanes.map((lane) => ({ ...lane }));
      let column = lanes.findIndex((lane) => lane.id === entry.id);
      const incoming = column !== -1;
      if (!incoming) {
        column = lanes.length;
        lanes.push({ id: entry.id, color: nextColor++ % 6 });
      }
      const color = lanes[column].color;
      lanes.splice(column, 1);
      const parents = [...new Set(entry.parents)];
      parents.forEach((id, index) => {
        if (!lanes.some((lane) => lane.id === id)) lanes.splice(Math.min(column + index, lanes.length), 0, { id, color: index === 0 ? color : nextColor++ % 6 });
      });
      const after = lanes.map((lane) => ({ ...lane }));
      return {
        id: entry.id,
        column,
        color,
        incoming,
        passing: before.flatMap((lane, from) => lane.id === entry.id ? [] : [{ from, to: after.findIndex((value) => value.id === lane.id), color: lane.color }]),
        parents: parents.map((id) => {
          const to = after.findIndex((lane) => lane.id === id);
          return { id, to, color: after[to].color };
        }),
        columns: Math.max(1, before.length, after.length, column + 1),
        frontier: after
      };
    });
  }

  // dsh-plugin/sidebar-changes/history-disclosure.mjs
  function createHistoryDisclosure(React) {
    return function HistoryDisclosure({ open, id, animate = true, children }) {
      const outer = React.useRef(null), inner = React.useRef(null);
      const [mounted, setMounted] = React.useState(open);
      React.useLayoutEffect(() => {
        if (open && !mounted) {
          setMounted(true);
          return;
        }
        if (!open && !mounted) {
          outer.current.style.height = "0px";
          outer.current.style.opacity = "0";
          return;
        }
        const node = outer.current, body = inner.current;
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
        let motion = null, target = -1, disposed = false;
        const enabled = () => {
          const root = document.documentElement, setting = root.getAttribute("data-dsh-desktop-animation");
          return animate && root.getAttribute("data-dsh-ui") !== "vanilla" && setting !== "off" && (setting === "on" || !reduced.matches);
        };
        const finish = () => {
          if (!disposed && !open) setMounted(false);
        };
        const update = () => {
          const next = open && body ? body.getBoundingClientRect().height : 0;
          if (next === target && (enabled() || !motion)) return;
          const height = node.getBoundingClientRect().height, opacity = getComputedStyle(node).opacity;
          motion?.cancel();
          motion = null;
          target = next;
          node.style.height = next + "px";
          node.style.opacity = open ? "1" : "0";
          if (!enabled() || Math.abs(height - next) < 0.5) {
            finish();
            return;
          }
          motion = node.animate(
            [{ height: height + "px", opacity }, { height: next + "px", opacity: open ? 1 : 0 }],
            { duration: open ? 220 : 160, easing: "cubic-bezier(.2, .75, .25, 1)" }
          );
          motion.onfinish = () => {
            motion = null;
            finish();
          };
        };
        const size = new ResizeObserver(update);
        if (body) size.observe(body);
        const preferences = new MutationObserver(update);
        preferences.observe(document.documentElement, { attributes: true, attributeFilter: ["data-dsh-ui", "data-dsh-desktop-animation"] });
        reduced.addEventListener("change", update);
        update();
        return () => {
          disposed = true;
          const height = node.getBoundingClientRect().height, opacity = getComputedStyle(node).opacity;
          motion?.cancel();
          node.style.height = height + "px";
          node.style.opacity = opacity;
          size.disconnect();
          preferences.disconnect();
          reduced.removeEventListener("change", update);
        };
      }, [open, mounted, animate]);
      return React.createElement(
        "div",
        {
          ref: outer,
          id,
          className: "dshHistory__expanded",
          "aria-hidden": !open,
          inert: open ? void 0 : "",
          style: { height: 0, opacity: 0 }
        },
        mounted && React.createElement("div", { ref: inner, className: "dshHistory__reveal" }, children)
      );
    };
  }

  // dsh-plugin/sidebar-changes/history-view.mjs
  function createHistoryView(React, primitives, shared) {
    const h = React.createElement;
    const HistoryDisclosure = createHistoryDisclosure(React);
    const { Button, Tag, Tooltip, IconChevronUpOutlineRegular: CollapseIcon } = primitives;
    const { SourceMenu, Placeholder, StatusTag, call, message } = shared;
    const date = (value, full = false) => {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", full ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" } : { month: "2-digit", day: "2-digit" });
    };
    const commitInfo = (entry) => [
      t("\u63D0\u4EA4\uFF1A{0}", [entry.id]),
      t("\u4F5C\u8005\uFF1A{0}{1}", [entry.author, entry.authorEmail ? ` <${entry.authorEmail}>` : ""]),
      t("\u63D0\u4EA4\u8005\uFF1A{0}{1}", [entry.committer || "\u2014", entry.committerEmail ? ` <${entry.committerEmail}>` : ""]),
      t("\u63D0\u4EA4\u65F6\u95F4\uFF1A{0}", [date(entry.commitDate, true)])
    ].join("\n");
    function Refs({ refs }) {
      return h(
        "span",
        { className: "dshHistory__refs", title: refs.map((ref) => ref.name).join(" \xB7 ") },
        refs.map((ref) => h(Tag, { key: ref.kind + ref.name, tone: ref.kind === "head" ? "solid" : ref.current ? "info" : "neutral" }, ref.name))
      );
    }
    function Graph({ row, columns, boundary }) {
      const width = Math.min(96, columns * 14 + 6), step = columns === 1 ? 14 : (width - 14) / (columns - 1), x = (column) => 7 + column * step;
      const color = (index) => `var(--history-lane-${index})`;
      const children = [];
      const line = (key, column, y1, y2, lane) => h("line", { key, x1: x(column), x2: x(column), y1, y2, stroke: color(lane) });
      for (const edge of row.passing) {
        children.push(
          line("in-" + edge.from, edge.from, 0, 18, edge.color),
          h("path", { key: "pass-" + edge.from, d: `M ${x(edge.from)} 18 C ${x(edge.from)} 26 ${x(edge.to)} 26 ${x(edge.to)} 34`, stroke: color(edge.color) }),
          line("out-" + edge.from, edge.to, 34, "100%", edge.color)
        );
      }
      if (row.incoming) children.push(line("node-in", row.column, 0, 18, row.color));
      for (const edge of row.parents) children.push(
        h("path", { key: "parent-" + edge.id, d: `M ${x(row.column)} 18 C ${x(row.column)} 26 ${x(edge.to)} 26 ${x(edge.to)} 34`, stroke: color(edge.color) }),
        line("parent-line-" + edge.id, edge.to, 34, "100%", edge.color)
      );
      children.push(h("circle", { key: "node", cx: x(row.column), cy: 18, r: boundary ? 4 : 3.5, fill: boundary ? "var(--dsw-alias-bg-base)" : color(row.color), stroke: color(row.color) }));
      return h("svg", { className: "dshHistory__graph", width, height: "100%", fill: "none", strokeWidth: 1.5, "aria-hidden": true }, children);
    }
    function Details({ ctx, sessionId, revision, entry, signal, onReady, reload, busy }) {
      useLocale(React);
      const [data, setData] = React.useState(null), [error, setError] = React.useState(null);
      const ready = React.useRef(onReady);
      ready.current = onReady;
      React.useEffect(() => {
        const own = new AbortController(), active = AbortSignal.any([own.signal, signal]);
        call(ctx, "getCommitDetails", sessionId, revision, entry.id, active).then((value) => {
          if (!active.aborted) setData(value);
        }).catch((error2) => {
          if (!active.aborted) setError(message(error2));
        });
        return () => own.abort();
      }, [sessionId, revision, entry.id]);
      React.useLayoutEffect(() => {
        if (data || error) ready.current(entry.id);
      }, [data, error]);
      return h(
        "div",
        { className: "dshHistory__detail", "aria-busy": !data && !error },
        error ? h(Placeholder, { error: true, retry: reload, busy }, error) : !data ? h("div", { className: "dshChanges__loading", role: "status" }, t("\u6B63\u5728\u52A0\u8F7D\u63D0\u4EA4\u2026")) : h("pre", { className: "dshHistory__message" }, data.message || t("\uFF08\u65E0\u63D0\u4EA4\u6D88\u606F\uFF09"))
      );
    }
    return function HistoryView({ ctx, tab, sessionId, states, onSourceChange }) {
      useLocale(React);
      const stateKey = sessionId + "\0" + tab.contentId, saved = states.get(stateKey) || {};
      const [data, setData] = React.useState(null), [capabilities, setCapabilities] = React.useState(null), [error, setError] = React.useState(null);
      const [expanded, setExpanded] = React.useState(saved.commitIds || []), [loading, setLoading] = React.useState(true), [paging, setPaging] = React.useState(false);
      const [refresh, setRefresh] = React.useState(0), [attempt, setAttempt] = React.useState(0);
      const viewport = React.useRef(), sentinel = React.useRef(), request = React.useRef(), current = React.useRef(null), busy = React.useRef(false);
      const position = React.useRef(saved), opened = React.useRef(expanded), force = React.useRef(false), restoring = React.useRef(true), ready = React.useRef(/* @__PURE__ */ new Set());
      opened.current = expanded;
      const update = (patch) => {
        position.current = { ...position.current, ...patch, source: "history" };
        states.set(stateKey, position.current);
      };
      const assign = (value) => {
        current.current = value;
        setData(value);
      };
      const restoreScroll = (id) => {
        if (id) ready.current.add(id);
        const node = viewport.current;
        if (!node || !restoring.current) return;
        const anchor = [...node.querySelectorAll("[data-commit-id]")].find((row) => row.dataset.commitId === position.current.anchorId);
        node.scrollTop = anchor ? anchor.offsetTop - (position.current.anchorOffset || 0) : position.current.listScroll || 0;
        if (opened.current.every((id2) => ready.current.has(id2) || !current.current?.entries.some((row) => row.id === id2))) restoring.current = false;
      };
      const saveScroll = () => {
        const node = viewport.current;
        if (!node || restoring.current || !tab.visible) return;
        const anchor = [...node.querySelectorAll("[data-commit-id]")].find((row) => row.offsetTop + row.offsetHeight > node.scrollTop);
        update({ listScroll: node.scrollTop, anchorId: anchor?.dataset.commitId, anchorOffset: anchor ? anchor.offsetTop - node.scrollTop : 0 });
      };
      React.useEffect(() => {
        update({ commitIds: expanded });
      }, [expanded]);
      React.useLayoutEffect(() => {
        if (data) restoreScroll();
      }, [data, expanded]);
      React.useLayoutEffect(() => {
        if (!tab.visible) {
          restoring.current = true;
          ready.current.clear();
        }
      }, [tab.visible]);
      React.useEffect(() => {
        const restore = () => {
          position.current = states.get(stateKey) || {};
          restoring.current = true;
          ready.current.clear();
          setExpanded(position.current.commitIds || []);
          assign(null);
          setRefresh((n) => n + 1);
        };
        document.addEventListener("dsh-desktop:changes-restore", restore);
        return () => document.removeEventListener("dsh-desktop:changes-restore", restore);
      }, [stateKey]);
      React.useEffect(() => {
        if (!tab.visible) return;
        const own = new AbortController(), signal = AbortSignal.any([own.signal, tab.signal]);
        request.current = signal;
        setPaging(false);
        async function load() {
          if (busy.current || document.hidden || signal.aborted) return;
          busy.current = true;
          setLoading(true);
          setError(null);
          try {
            const cap = await call(ctx, "getCapabilities", sessionId, signal);
            if (signal.aborted) return;
            setCapabilities(cap);
            if (cap.gitAvailability.status !== "available") {
              onSourceChange("session");
              return;
            }
            let next = await call(ctx, "listCommits", sessionId, "", 0, signal);
            if (signal.aborted) return;
            const old = current.current;
            if (old?.revision === next.revision && old.snapshotId === next.snapshotId && !force.current) return;
            const target = Math.max(50, old?.entries.length || position.current.loadedCount || 50);
            while (next.nextOffset !== null && next.entries.length < target) {
              const page = await call(ctx, "listCommits", sessionId, next.revision, next.nextOffset, signal);
              next = { ...page, entries: [...next.entries, ...page.entries] };
            }
            if (signal.aborted || next.sessionId !== sessionId || next.workspaceRoot !== cap.workspaceRoot) return;
            restoring.current = true;
            ready.current.clear();
            assign(next);
            update({ loadedCount: next.entries.length });
            setExpanded((ids) => ids.filter((id) => next.entries.some((row) => row.id === id)));
            if (force.current) {
              force.current = false;
              setAttempt((n) => n + 1);
            }
          } catch (error2) {
            if (!signal.aborted) setError(message(error2));
          } finally {
            if (!signal.aborted) {
              busy.current = false;
              setLoading(false);
            }
          }
        }
        load();
        const focus = () => {
          if (!document.hidden) load();
        };
        window.addEventListener("focus", focus);
        document.addEventListener("visibilitychange", focus);
        window.addEventListener("dsh-desktop:git-changed", focus);
        const timer = setInterval(focus, 5e3);
        return () => {
          own.abort();
          busy.current = false;
          clearInterval(timer);
          window.removeEventListener("focus", focus);
          window.removeEventListener("dsh-desktop:git-changed", focus);
          document.removeEventListener("visibilitychange", focus);
        };
      }, [sessionId, tab.visible, refresh]);
      const reload = () => {
        force.current = true;
        setRefresh((n) => n + 1);
      };
      async function more() {
        const old = current.current, signal = request.current;
        if (busy.current || !old || old.nextOffset === null || !signal || signal.aborted) return;
        busy.current = true;
        setPaging(true);
        setError(null);
        try {
          const next = await call(ctx, "listCommits", sessionId, old.revision, old.nextOffset, signal);
          if (signal.aborted || current.current !== old) return;
          const value = { ...next, entries: [...old.entries, ...next.entries] };
          assign(value);
          update({ loadedCount: value.entries.length });
        } catch (error2) {
          if (!signal.aborted) setError(message(error2));
        } finally {
          if (!signal.aborted) {
            busy.current = false;
            setPaging(false);
          }
        }
      }
      React.useEffect(() => {
        if (!tab.visible || !sentinel.current || data?.nextOffset === null || loading || paging || error) return;
        const observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) more();
        }, { root: viewport.current, rootMargin: "160px" });
        observer.observe(sentinel.current);
        return () => observer.disconnect();
      }, [data, tab.visible, loading, paging, error]);
      const graph = React.useMemo(() => layoutCommits(data?.entries || []), [data]);
      const columns = graph.reduce((max, row) => Math.max(max, row.columns), 1), graphWidth = Math.min(96, columns * 14 + 6), panelId = React.useId();
      return h(
        "section",
        { className: "dshChanges dshHistory", "aria-label": t("\u66F4\u6539"), "data-dsh-changes": true, "data-source": "history" },
        h(
          "header",
          { className: "dshChanges__toolbar" },
          h(
            "div",
            { className: "dshChanges__scope" },
            h(SourceMenu, { source: "history", capabilities, onChange: onSourceChange, visible: tab.visible }),
            data?.shallow && h(StatusTag, { label: t("\u6D45\u514B\u9686\u53EA\u5305\u542B\u5DF2\u83B7\u53D6\u7684\u5386\u53F2\uFF0C\u8FB9\u754C\u4E4B\u5916\u7684\u63D0\u4EA4\u6682\u4E0D\u53EF\u89C1") }, t("\u6D45\u514B\u9686"))
          ),
          expanded.length > 0 && h(
            "div",
            { className: "dshChanges__toolbarActions" },
            h(Tooltip, { label: t("\u5168\u90E8\u6298\u53E0"), portal: true, side: "bottom" }, h(Button, { className: "dshChanges__collapse dshHistory__collapse", size: "sm", "aria-label": t("\u5168\u90E8\u6298\u53E0"), onClick: () => {
              restoring.current = false;
              setExpanded([]);
            } }, h(CollapseIcon, { size: 14 })))
          )
        ),
        error && h(Placeholder, { error: true, retry: reload, busy: loading }, error),
        !data && loading && !error && h(Placeholder, null, t("\u6B63\u5728\u52A0\u8F7D\u63D0\u4EA4\u8BB0\u5F55\u2026")),
        data && h(
          "div",
          {
            className: "dshChanges__list dshHistory__list",
            ref: viewport,
            onScroll: saveScroll,
            onWheel: () => {
              restoring.current = false;
            },
            onPointerDown: () => {
              restoring.current = false;
            }
          },
          !data.entries.length && h(Placeholder, null, t("\u6682\u65E0\u63D0\u4EA4\u8BB0\u5F55")),
          data.entries.map((entry, index) => {
            const open = expanded.includes(entry.id), id = panelId + entry.id;
            return h(
              "article",
              { key: entry.id, className: "dshHistory__commit", "data-commit-id": entry.id, "data-open": open, style: { "--history-graph-width": graphWidth + "px" } },
              h(Graph, { row: graph[index], columns, boundary: entry.boundary }),
              h(
                Tooltip,
                { label: commitInfo(entry), portal: true, side: "bottom", delayMs: 600, maxWidth: 420, disabled: !tab.visible },
                h(
                  Button,
                  {
                    className: "dshHistory__row",
                    size: "sm",
                    "aria-expanded": open,
                    "aria-controls": id,
                    "aria-label": t("\u63D0\u4EA4\uFF1A") + (entry.subject || entry.id),
                    "aria-description": commitInfo(entry),
                    onClick: () => {
                      restoring.current = false;
                      setExpanded((ids) => ids.includes(entry.id) ? ids.filter((id2) => id2 !== entry.id) : [...ids, entry.id]);
                    }
                  },
                  h("span", { className: "dshHistory__titleLine" }, h("span", { className: "dshHistory__subject" }, entry.subject || t("\uFF08\u65E0\u63D0\u4EA4\u6807\u9898\uFF09")), h(Refs, { refs: entry.refs })),
                  h(
                    "span",
                    { className: "dshHistory__byline" },
                    h("span", null, entry.author),
                    h("time", { dateTime: entry.commitDate }, date(entry.commitDate)),
                    entry.parents.length > 1 && h("span", null, t("\u5408\u5E76")),
                    entry.boundary && h("span", null, t("\u5386\u53F2\u8FB9\u754C"))
                  )
                )
              ),
              h(HistoryDisclosure, { id, open: open && tab.visible, animate: !restoring.current }, h(Details, { key: entry.id + data.revision + data.snapshotId + attempt, ctx, sessionId, revision: data.revision, entry, signal: tab.signal, onReady: restoreScroll, reload, busy: loading }))
            );
          }),
          data.nextOffset !== null && h("div", { ref: sentinel, className: "dshHistory__more" }, h(Button, { size: "sm", onClick: more, disabled: loading || paging || Boolean(error) }, paging ? t("\u6B63\u5728\u52A0\u8F7D\u2026") : t("\u52A0\u8F7D\u66F4\u591A\u63D0\u4EA4")))
        )
      );
    };
  }

  // dsh-plugin/sidebar-changes/session-details.mjs
  function createSessionDetails(React, { Button, Tag }, { call, message, Placeholder, DiffRows, stats }) {
    const h = React.createElement;
    function RecordDiff({ ctx, sessionId, fileId, revision, record, signal }) {
      const [data, setData] = React.useState(null), [error, setError] = React.useState(null), [pending, setPending] = React.useState(false);
      const active = React.useRef(), inFlight = React.useRef(false);
      async function load(offset = 0) {
        const current = active.current;
        if (!current || current.aborted || inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        setError(null);
        try {
          const value = await call(ctx, "getOperationDiff", sessionId, fileId, revision, record.id, offset, current);
          if (!current.aborted) setData((old) => ({ ...value, rows: offset ? [...old.rows, ...value.rows] : value.rows }));
        } catch (error2) {
          if (!current.aborted) setError(message(error2));
        } finally {
          if (!current.aborted) {
            inFlight.current = false;
            setPending(false);
          }
        }
      }
      React.useEffect(() => {
        const own = new AbortController();
        active.current = AbortSignal.any([own.signal, signal]);
        inFlight.current = false;
        load();
        return () => own.abort();
      }, []);
      return h(
        "div",
        { className: "dshChanges__recordDiff" },
        error && h(Placeholder, { error: true, retry: () => load(data?.nextOffset || 0), busy: pending }, error),
        !data && !error && h("div", { role: "status" }, t("\u6B63\u5728\u52A0\u8F7D\u5DEE\u5F02\u2026")),
        data?.reason && h(Placeholder, null, message({ message: data.reason })),
        data && h(DiffRows, { rows: data.rows }),
        data && (data.beforeNewline === false || data.afterNewline === false) && h(Tag, { tone: "quiet" }, t("\u6587\u4EF6\u672B\u5C3E\u65E0\u6362\u884C")),
        data && !data.rows.length && !data.reason && h("div", null, t("\u65E0\u6587\u672C\u884C\u53D8\u5316")),
        data?.nextOffset != null && h(Button, {
          size: "sm",
          className: "dshChanges__recordMore",
          disabled: pending,
          onClick: () => load(data.nextOffset)
        }, pending ? t("\u6B63\u5728\u52A0\u8F7D\u2026") : t("\u52A0\u8F7D\u66F4\u591A\u7247\u6BB5\u884C"))
      );
    }
    function Records({ ctx, sessionId, fileId, revision, recordKind, signal }) {
      useLocale(React);
      const [data, setData] = React.useState(null), [error, setError] = React.useState(null), [pending, setPending] = React.useState(false);
      const [opened, setOpened] = React.useState([]), active = React.useRef(), inFlight = React.useRef(false);
      async function load(offset = 0) {
        const current = active.current;
        if (!current || current.aborted || inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        setError(null);
        try {
          const value = await call(ctx, "listFileOperations", sessionId, fileId, revision, recordKind, offset, current);
          if (!current.aborted) setData((old) => ({ ...value, records: offset ? [...old.records, ...value.records] : value.records }));
        } catch (error2) {
          if (!current.aborted) setError(message(error2));
        } finally {
          if (!current.aborted) {
            inFlight.current = false;
            setPending(false);
          }
        }
      }
      React.useEffect(() => {
        const own = new AbortController();
        active.current = AbortSignal.any([own.signal, signal]);
        inFlight.current = false;
        load();
        return () => own.abort();
      }, []);
      return h(
        "div",
        { className: "dshChanges__records", "data-record-kind": recordKind },
        error && h(Placeholder, { error: true, retry: () => load(data?.nextOffset || 0), busy: pending }, error),
        !data && !error && h("div", { role: "status" }, t("\u6B63\u5728\u52A0\u8F7D\u8BB0\u5F55\u2026")),
        data?.records.map((record) => {
          const open = recordKind === "segments" || !record.noTextChange && opened.includes(record.id);
          const label = `${recordKind === "segments" ? t("\u8FDE\u7EED\u7247\u6BB5") : t("\u64CD\u4F5C")} ${record.index}`;
          return h(
            "div",
            { key: record.id, className: "dshChanges__record" },
            h(
              "div",
              { className: "dshChanges__metadata" },
              recordKind === "segments" || record.noTextChange ? h("span", { className: "dshChanges__recordLabel" }, label) : h(Button, {
                size: "sm",
                className: "dshChanges__recordToggle",
                "aria-expanded": open,
                onClick: () => setOpened((old) => open ? old.filter((id) => id !== record.id) : [...old, record.id])
              }, label),
              stats(record.stats),
              record.status === "added" && h(Tag, { tone: "success" }, t("\u65B0\u589E")),
              record.status === "deleted" && h(Tag, { tone: "danger" }, t("\u5220\u9664")),
              record.noTextChange && h(Tag, { tone: "quiet" }, t("\u65E0\u6587\u672C\u884C\u53D8\u5316")),
              record.evidenceOnly && h(Tag, { tone: "quiet" }, t("\u91CD\u53E0\u91C7\u96C6")),
              record.finalStatus === "error" && h(Tag, { tone: "warning" }, t("\u8C03\u7528\u5931\u8D25\uFF0C\u4FDD\u7559\u5DF2\u5199\u5165\u5185\u5BB9"))
            ),
            open && h(RecordDiff, { ctx, sessionId, fileId, revision, record, signal })
          );
        }),
        data?.nextOffset != null && h(Button, {
          size: "sm",
          className: "dshChanges__recordMore",
          disabled: pending,
          onClick: () => load(data.nextOffset)
        }, pending ? t("\u6B63\u5728\u52A0\u8F7D\u2026") : t("\u52A0\u8F7D\u66F4\u591A\u8BB0\u5F55\uFF08{0}/{1}\uFF09", [data.records.length, data.total]))
      );
    }
    return function SessionDetails({ ctx, sessionId, entry, revision, signal }) {
      useLocale(React);
      const [history, setHistory] = React.useState(false);
      const props = { ctx, sessionId, fileId: entry.fileId, revision, signal };
      return h(
        React.Fragment,
        null,
        entry.continuity === "broken" && h(Records, { ...props, key: "segments-" + revision, recordKind: "segments" }),
        h(
          Button,
          { size: "sm", className: "dshChanges__historyButton", "aria-expanded": history, onClick: () => setHistory((value) => !value) },
          history ? t("\u6536\u8D77\u64CD\u4F5C\u5386\u53F2") : t("\u67E5\u770B\u64CD\u4F5C\u5386\u53F2\uFF08{0}\uFF09", [entry.operationCount])
        ),
        history && h(Records, { ...props, key: "operations-" + revision, recordKind: "operations" })
      );
    };
  }

  // dsh-plugin/sidebar-changes/git-operation.mjs
  var gitBusy = (state) => ["starting", "generating", "switching", "staging", "committing", "pushing", "recovering"].includes(state.phase);
  var gitDraftKey = (context) => JSON.stringify([context.endpointId, context.repositoryRoot, context.workspaceRoot, context.branch]);
  async function gitQuery(remote, method, ...args) {
    const result = await remote[method](...args);
    if (result?.ok === false) throw result.error;
    return result?.ok === true ? result.value : result;
  }
  function createGitOperation(remote, onChanged = () => {
  }) {
    let state = { phase: "idle", action: null, commitId: "", message: "", error: null, context: null };
    const listeners = /* @__PURE__ */ new Set(), drafts = /* @__PURE__ */ new Map();
    const publish = (patch) => {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    };
    const errorState = (error) => ({ phase: "error", error: { code: error?.details?.reason || (error?.code?.startsWith("git-") ? error.code : error?.message || "git-failed"), detail: error?.details?.detail || error?.message || "" } });
    const finish = () => {
      if (state.phase === "done" && state.context && state.action !== "pushOnly") drafts.delete(gitDraftKey(state.context));
      onChanged();
    };
    const operation = {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      draft: (context) => drafts.get(gitDraftKey(context)) || "",
      saveDraft: (context, message) => drafts.set(gitDraftKey(context), message),
      reconcile(context) {
        if (state.phase === "error" && state.commitId && state.context && gitDraftKey(context) === gitDraftKey(state.context) && (context.head !== state.commitId || JSON.stringify(context.target) !== JSON.stringify(state.context.target))) {
          publish({ commitId: "", error: { code: "git-head-changed", detail: "" } });
        }
      },
      reset: () => {
        if (!gitBusy(state) && state.phase !== "unknown") publish({ phase: "idle", error: null, commitId: "", context: null });
      },
      dismissError: () => {
        if (!gitBusy(state) && state.phase !== "unknown") publish({ error: null });
      },
      async recover() {
        if (!state.request || state.phase === "recovering") return;
        publish({ phase: "recovering" });
        const { sessionId, revision } = state.request;
        try {
          for (let attempt = 0; attempt < 120; attempt++) {
            const update = await gitQuery(remote, "getGitOperation", sessionId, revision, new AbortController().signal);
            if (!gitBusy(update)) {
              publish({ ...update, action: state.request.displayAction || state.request.action });
              finish();
              return;
            }
            if (update.commitId) publish({ commitId: update.commitId });
            await new Promise((resolve) => setTimeout(resolve, 1e3));
          }
        } catch {
        }
        publish({ phase: "unknown", error: { code: "git-result-unknown", detail: "" } });
        onChanged();
      },
      async switchBranch(sessionId, branch, context) {
        if (gitBusy(state) || state.phase === "unknown") return null;
        publish({ phase: "switching", error: null, context, commitId: "" });
        try {
          const signal = new AbortController().signal;
          if (!context.contextRevision) {
            const expected = context;
            context = await gitQuery(remote, "getGitContext", sessionId, expected.source, signal);
            if (context.endpointId !== expected.endpointId || context.workspaceRoot !== expected.workspaceRoot || context.source !== expected.source) throw Error("stale");
            publish({ context });
          }
          const value = await gitQuery(remote, "switchGitBranch", sessionId, branch, context.contextRevision, signal);
          publish({ phase: "idle", context: null });
          return value;
        } catch (error) {
          publish(errorState(error));
          return null;
        } finally {
          onChanged();
        }
      },
      async run(request) {
        if (gitBusy(state) || state.phase === "unknown") return null;
        const { sessionId, action, source, revision, committedId = "", context } = request;
        let message = action === "pushOnly" ? "" : request.message || "", writing = false;
        publish({
          action: request.displayAction || action,
          message,
          commitId: committedId,
          error: null,
          context: context || null,
          request,
          phase: !message.trim() && context && !committedId && ["commit", "push"].includes(action) ? "generating" : committedId || action === "pushOnly" ? "pushing" : source !== "staged" ? "staging" : "committing"
        });
        try {
          if (message.length > 65536 || message.includes("\0")) throw Error("git-message");
          const signal = new AbortController().signal;
          if (state.phase === "generating") {
            if (!context.canGenerateMessage) throw Error("git-generation-unavailable");
            const generated = await gitQuery(remote, "generateCommitMessage", sessionId, source, revision, signal);
            if (generated.contextRevision !== revision) throw Error("stale");
            if (operation.draft(context) !== message) throw Error("stale");
            message = generated.message;
            operation.saveDraft(context, message);
            publish({ message, phase: source === "staged" ? "committing" : "staging" });
          }
          writing = true;
          for await (const update of remote.runGitAction(sessionId, action, source, revision, message, committedId, signal)) publish({ ...update, action: request.displayAction || action });
          if (gitBusy(state)) throw Error("git-result-unknown");
        } catch (error) {
          if (writing && context) {
            publish({ phase: "unknown", error: { code: "git-result-unknown", detail: "" } });
            await operation.recover();
          } else publish(errorState(error));
        } finally {
          finish();
        }
        return state;
      }
    };
    return operation;
  }

  // dsh-plugin/sidebar-changes/git-preview.mjs
  function gitListStatistics(data, sessionId, capabilities, source) {
    if (!data || !["working", "staged"].includes(source) || data.source !== source || data.sessionId !== sessionId || data.workspaceRoot !== capabilities?.workspaceRoot || data.endpointId !== capabilities?.endpointId) return null;
    const known = data.entries.filter((entry) => entry.stats.added !== null && entry.stats.removed !== null);
    const statisticsComplete = known.length === data.entries.length;
    return {
      added: known.length || statisticsComplete ? known.reduce((sum, entry) => sum + entry.stats.added, 0) : null,
      removed: known.length || statisticsComplete ? known.reduce((sum, entry) => sum + entry.stats.removed, 0) : null,
      statisticsComplete,
      listRevision: data.revision
    };
  }

  // dsh-plugin/sidebar-changes/git-actions.mjs
  function createGitActions(React, primitives) {
    const h = React.createElement;
    const { Button, Menu, MenuItemButton, Modal, Tooltip, Toast, StateDot, IconChevronDownOutlineRegular: ChevronDown } = primitives;
    const repositories = /* @__PURE__ */ new WeakMap(), noop = () => {
    };
    const labels = () => ({ stage: t("\u6682\u5B58"), commit: t("\u63D0\u4EA4"), push: t("\u63D0\u4EA4\u5E76\u63A8\u9001"), pushOnly: t("\u63A8\u9001") });
    const phases = () => ({ generating: t("\u751F\u6210\u4E2D\u2026"), staging: t("\u6682\u5B58\u4E2D\u2026"), committing: t("\u63D0\u4EA4\u4E2D\u2026"), pushing: t("\u63A8\u9001\u4E2D\u2026"), switching: t("\u5207\u6362\u4E2D\u2026"), recovering: t("\u786E\u8BA4\u4E2D\u2026") });
    const complete = () => ({ stage: t("\u5DF2\u6682\u5B58\u66F4\u6539"), commit: t("\u5DF2\u63D0\u4EA4"), push: t("\u5DF2\u63D0\u4EA4\u5E76\u63A8\u9001"), pushOnly: t("\u5DF2\u63A8\u9001") });
    const reason = (error) => REASONS[error?.code] || REASONS[error?.message] || error?.message || REASONS["git-failed"];
    const BranchIcon = () => h(
      "svg",
      { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, "aria-hidden": true },
      h("circle", { cx: 6, cy: 5, r: 2.5 }),
      h("circle", { cx: 6, cy: 19, r: 2.5 }),
      h("circle", { cx: 18, cy: 5, r: 2.5 }),
      h("path", { d: "M6 7.5v9M18 7.5v2a5 5 0 0 1-5 5H6" })
    );
    const tip = (label, child, key) => h(Tooltip, { key, label, portal: true, side: "bottom", maxWidth: 320 }, child);
    const loading = (className) => h(
      "span",
      { className: "dshChanges__gitLoading " + (className || ""), role: "status", "aria-live": "polite" },
      h(StateDot, { state: "ongoing", size: 13 }),
      t("\u52A0\u8F7D\u4E2D\u2026")
    );
    return function GitActions({ ctx, sessionId, capabilities, source, data, visible, onStaged, primaryAction = source === "working" ? "stage" : "commit" }) {
      useLocale(React);
      const remote = ctx.remote.desktopChanges, available = capabilities?.gitAvailability?.status === "available";
      const supported = capabilities?.gitContextVersion === 1;
      const [menu, setMenu] = React.useState(false), [dialog, setDialog] = React.useState(false), [notice, setNotice] = React.useState(null);
      const [include, setInclude] = React.useState(source !== "staged"), [context, setContext] = React.useState(null);
      const [preview, setPreview] = React.useState(null), [reuseList, setReuseList] = React.useState(true);
      const [draft, setDraft] = React.useState(""), [error, setError] = React.useState(null), [refresh, setRefresh] = React.useState(0);
      const [branchInfo, setBranchInfo] = React.useState(null), [branchMenu, setBranchMenu] = React.useState(false);
      const [branchLoading, setBranchLoading] = React.useState(true), [branchError, setBranchError] = React.useState(null);
      const [branchRefresh, setBranchRefresh] = React.useState(0), [contextLoading, setContextLoading] = React.useState(true);
      const mounted = React.useRef(true), requestVersion = React.useRef(0);
      const branchTrigger = React.useRef();
      const messageId = "dsh-git-message-" + React.useId(), branchMenuClass = "dshGitBranches-" + React.useId();
      const operation = React.useMemo(() => {
        let repos = repositories.get(ctx);
        if (!repos) {
          repos = /* @__PURE__ */ new Map();
          repositories.set(ctx, repos);
        }
        const key = JSON.stringify([capabilities?.endpointId, capabilities?.gitAvailability?.root]);
        if (!repos.has(key)) repos.set(key, createGitOperation(remote, () => window.dispatchEvent(new Event("dsh-desktop:git-changed"))));
        return repos.get(key);
      }, [ctx, capabilities?.endpointId, capabilities?.gitAvailability?.root]);
      const state = React.useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
      const busy = gitBusy(state), uncertain = state.phase === "unknown", range = include ? "working" : "staged";
      const listStatistics = React.useMemo(
        () => reuseList ? gitListStatistics(data, sessionId, capabilities, range) : null,
        [data, sessionId, capabilities?.endpointId, capabilities?.workspaceRoot, range, reuseList]
      );
      const savedPreview = preview?.sessionId === sessionId && preview.endpointId === capabilities?.endpointId && preview.workspaceRoot === capabilities?.workspaceRoot && preview.source === range ? preview : null;
      const statistics = context || (listStatistics && listStatistics.listRevision !== savedPreview?.listRevision ? listStatistics : savedPreview || listStatistics);
      const branchPending = branchLoading && !branchInfo;
      const draftScope = context || branchInfo && available && {
        endpointId: capabilities.endpointId,
        repositoryRoot: capabilities.gitAvailability.root,
        workspaceRoot: capabilities.workspaceRoot,
        branch: branchInfo.branch
      };
      const draftKey = draftScope && gitDraftKey(draftScope);
      const sameDraft = context && state.context && gitDraftKey(context) === gitDraftKey(state.context);
      const retry = sameDraft && state.phase === "error" && Boolean(state.commitId) && ["push", "pushOnly"].includes(state.action);
      const done = sameDraft && state.phase === "done";
      const locked = busy || uncertain || retry || done;
      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);
      React.useEffect(() => {
        requestVersion.current++;
        setDialog(false);
        setMenu(false);
        setBranchMenu(false);
        setContext(null);
        setDraft("");
        setError(null);
        setPreview(null);
        setReuseList(true);
        setBranchInfo(null);
        setBranchError(null);
        setBranchLoading(true);
        setContextLoading(true);
      }, [operation, sessionId, capabilities?.workspaceRoot]);
      React.useEffect(() => {
        if (!dialog || !supported || busy) return;
        const own = new AbortController(), version = ++requestVersion.current;
        setContext(null);
        setContextLoading(true);
        gitQuery(remote, "getGitContext", sessionId, range, own.signal).then((value) => {
          if (own.signal.aborted || version !== requestVersion.current) return;
          if (value.endpointId !== capabilities.endpointId || value.workspaceRoot !== capabilities.workspaceRoot || value.source !== range) return;
          operation.reconcile(value);
          setError(null);
          setContext(value);
          setReuseList(true);
          setPreview({ ...value, sessionId, listRevision: data?.revision });
        }).catch((failure) => {
          if (!own.signal.aborted && version === requestVersion.current) setError(failure);
        }).finally(() => {
          if (!own.signal.aborted && version === requestVersion.current) setContextLoading(false);
        });
        return () => own.abort();
      }, [dialog, supported, sessionId, range, refresh, operation, busy, data?.revision]);
      React.useEffect(() => {
        if (!available || !visible || !supported || busy) return;
        const own = new AbortController();
        setBranchLoading(true);
        setBranchError(null);
        gitQuery(remote, "listGitBranches", sessionId, own.signal).then((value) => {
          if (!own.signal.aborted) setBranchInfo(value);
        }).catch((failure) => {
          if (!own.signal.aborted) setBranchError(failure);
        }).finally(() => {
          if (!own.signal.aborted) setBranchLoading(false);
        });
        return () => own.abort();
      }, [available, visible, supported, operation, sessionId, capabilities?.workspaceRoot, branchRefresh, busy]);
      React.useEffect(() => {
        if (!visible || !supported) return;
        const refreshContext = () => {
          if (!document.hidden) {
            setRefresh((value) => value + 1);
            setBranchRefresh((value) => value + 1);
          }
        };
        window.addEventListener("focus", refreshContext);
        window.addEventListener("dsh-desktop:git-changed", refreshContext);
        document.addEventListener("visibilitychange", refreshContext);
        return () => {
          window.removeEventListener("focus", refreshContext);
          window.removeEventListener("dsh-desktop:git-changed", refreshContext);
          document.removeEventListener("visibilitychange", refreshContext);
        };
      }, [visible, supported]);
      React.useEffect(() => {
        if (draftScope) setDraft(operation.draft(draftScope));
      }, [operation, draftKey]);
      React.useEffect(() => {
        if (sameDraft && state.message && busy) setDraft(state.message);
      }, [state.message, busy, sameDraft]);
      React.useEffect(() => {
        if (!visible || busy) {
          setMenu(false);
          setBranchMenu(false);
        }
      }, [visible, busy]);
      React.useEffect(() => {
        if (!branchMenu) return;
        const frame = requestAnimationFrame(() => {
          const list = document.getElementsByClassName(branchMenuClass)[0];
          if (document.activeElement === branchTrigger.current || document.activeElement === list) {
            list?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
          }
        });
        return () => cancelAnimationFrame(frame);
      }, [branchMenu, branchInfo, branchLoading, branchError]);
      if (!available || !visible) return null;
      const activate = (action) => {
        if (gitBusy(operation.getSnapshot())) return;
        setMenu(false);
        setError(null);
        if (action === "stage") {
          if (!data || uncertain) return;
          void operation.run({ sessionId, action, source, revision: data.revision }).then((result) => {
            if (!mounted.current || result?.phase !== "done") return;
            setNotice(complete().stage);
            onStaged?.();
          });
          return;
        }
        if (!supported) {
          setError({ code: "git-upgrade-required" });
          return;
        }
        if (state.phase === "done") operation.reset();
        const restoreRange = state.commitId && state.phase === "error" && state.context?.workspaceRoot === capabilities.workspaceRoot;
        setInclude(restoreRange ? state.context.source === "working" : source !== "staged");
        setContext(null);
        setContextLoading(true);
        if (draftScope) setDraft(operation.draft(draftScope));
        setDialog(true);
        setRefresh((value) => value + 1);
      };
      const run = (action) => {
        if (!context || gitBusy(operation.getSnapshot()) || uncertain || done) return;
        const retrying = retry && action === state.action;
        if (retry && !retrying) return;
        if (!retrying && (action === "pushOnly" ? !context.canPush : !context.hasCommittableChanges || action === "push" && !context.canPushAfterCommit || !draft.trim() && !context.canGenerateMessage)) return;
        setError(null);
        setBranchMenu(false);
        const saved = retrying ? state.context : context;
        void operation.run({
          sessionId,
          action: retrying && action === "pushOnly" ? "push" : action,
          displayAction: action,
          source: saved.source,
          revision: saved.contextRevision,
          message: retrying ? state.message : draft,
          committedId: retrying ? state.commitId : "",
          context: saved
        });
      };
      const close = () => {
        if (!gitBusy(operation.getSnapshot())) {
          setBranchMenu(false);
          setDialog(false);
        }
      };
      const reloadBranches = () => {
        branchTrigger.current?.focus({ preventScroll: true });
        setBranchError(null);
        setBranchLoading(true);
        setBranchRefresh((value) => value + 1);
      };
      const openBranches = () => {
        if (locked) return;
        if (branchMenu) {
          setBranchMenu(false);
          return;
        }
        setBranchMenu(true);
        if (!branchLoading) reloadBranches();
      };
      const chooseBranch = async (branch) => {
        setBranchMenu(false);
        if (locked || branch === (branchInfo ? branchInfo.branch : context?.branch)) return;
        setError(null);
        setContext(null);
        setContextLoading(true);
        setPreview(null);
        setReuseList(false);
        await operation.switchBranch(sessionId, branch, context || {
          endpointId: capabilities.endpointId,
          workspaceRoot: capabilities.workspaceRoot,
          source: range
        });
        if (mounted.current) setRefresh((value) => value + 1);
      };
      const shownError = error || (sameDraft || !dialog || state.context == null ? state.error : null);
      const branchLabel = branchInfo ? branchInfo.branch || t("\u5206\u79BB HEAD") : context ? context.branch || t("\u5206\u79BB HEAD") : branchError ? t("\u5206\u652F\u8BFB\u53D6\u5931\u8D25") : t("\u52A0\u8F7D\u4E2D\u2026");
      const block = busy || uncertain || !context || done;
      const actionButton = (action) => {
        const ownRetry = retry && action === state.action, active = busy && state.action === action;
        const disabled = block || retry && !ownRetry || !ownRetry && (action === "pushOnly" ? !context?.canPush : !context?.hasCommittableChanges || action === "push" && !context?.canPushAfterCommit || !draft.trim() && !context?.canGenerateMessage);
        const title = ownRetry ? t("\u91CD\u8BD5\u63A8\u9001") : active ? phases()[state.phase] || t("\u5904\u7406\u4E2D\u2026") : labels()[action];
        const hint = ownRetry ? t("\u672C\u6B21\u63D0\u4EA4\u5DF2\u4FDD\u5B58\uFF0C\u91CD\u8BD5\u4E0D\u4F1A\u521B\u5EFA\u65B0\u7684\u63D0\u4EA4\u3002") : action === "pushOnly" ? REASONS[context?.pushReason] : REASONS[context?.commitReason] || action === "push" && REASONS[context?.pushReason] || (!draft.trim() && !context?.canGenerateMessage ? t("\u8BF7\u586B\u5199\u63D0\u4EA4\u4FE1\u606F") : "");
        return tip(hint || title, h("span", { className: "dshChanges__gitActionSlot" }, h(Button, {
          size: "sm",
          type: "button",
          className: "dshChanges__gitSubmit",
          "data-preferred": action === "commit" && !retry || ownRetry,
          disabled,
          "aria-busy": active,
          onClick: () => run(action)
        }, active && h(StateDot, { state: "ongoing", size: 12 }), title)), action);
      };
      const errorContent = shownError && h(
        "div",
        { className: "dshChanges__gitError", role: "alert" },
        retry && h("p", null, state.action === "pushOnly" ? t("\u63A8\u9001\u5931\u8D25") : t("\u63D0\u4EA4\u5DF2\u4FDD\u5B58 \xB7 \u63A8\u9001\u5931\u8D25")),
        h("p", null, reason(shownError)),
        shownError.detail && shownError.detail !== reason(shownError) && h("pre", null, shownError.detail),
        !dialog && !busy && !uncertain && h(Button, { size: "sm", onClick: () => {
          setError(null);
          operation.dismissError();
        } }, t("\u5173\u95ED"))
      );
      return h(
        React.Fragment,
        null,
        h(
          "div",
          { className: "dshChanges__gitActions", role: "group", "aria-label": t("Git \u64CD\u4F5C") },
          h(Button, {
            size: "sm",
            className: "dshChanges__gitPrimary",
            disabled: busy || primaryAction === "stage" && (!data || uncertain),
            "aria-busy": busy,
            onClick: () => activate(primaryAction)
          }, busy ? h(StateDot, { state: "ongoing", size: 16 }) : labels()[primaryAction]),
          h(Menu, {
            open: menu && !busy,
            portal: true,
            compact: true,
            autoFocus: true,
            align: "end",
            className: "dshChanges__gitMenuAnchor",
            listClassName: "dshChanges__gitMenu",
            onClose: () => setMenu(false),
            onSelect: activate,
            items: ["stage", "commit", "push"].filter((id) => id !== primaryAction && (source !== "staged" || id !== "stage")).map((id) => ({ id, label: labels()[id], disabled: id === "stage" && uncertain })),
            anchor: h(Button, {
              size: "sm",
              className: "dshChanges__gitToggle",
              disabled: busy,
              "aria-label": t("\u66F4\u591A Git \u64CD\u4F5C"),
              "aria-haspopup": "menu",
              "aria-expanded": menu,
              onClick: () => setMenu((value) => !value),
              onKeyDown: (event) => {
                if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                  event.preventDefault();
                  setMenu(true);
                }
              }
            }, h(ChevronDown, { size: 12 }))
          })
        ),
        dialog && h(
          Modal,
          {
            open: true,
            headless: true,
            title: t("\u63D0\u4EA4\u4E0E\u63A8\u9001"),
            onClose: busy ? noop : close,
            className: "dshChanges__gitDialog",
            onKeyDownCapture: (event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent?.isComposing && !event.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                run(event.shiftKey ? "push" : "commit");
              }
            }
          },
          h(
            "div",
            { className: "dshChanges__gitTop", "aria-busy": contextLoading || branchLoading },
            h(Menu, {
              open: branchMenu,
              portal: true,
              compact: true,
              autoFocus: true,
              selectedId: branchInfo ? branchInfo.branch : context?.branch,
              className: "dshChanges__gitBranchPicker",
              listClassName: "dshChanges__gitBranchMenu " + branchMenuClass,
              onClose: () => setBranchMenu(false),
              onSelect: chooseBranch,
              items: !branchInfo && (branchLoading || branchError) ? [] : branchInfo?.branches?.length ? branchInfo.branches.map((branch) => ({ id: branch.name, label: branch.name, disabled: branch.disabled || locked })) : [{ id: "", label: t("\u6682\u65E0\u672C\u5730\u5206\u652F"), disabled: true }],
              children: branchPending ? loading("dshChanges__gitBranchLoading") : branchError ? h(
                React.Fragment,
                null,
                h("div", { className: "dshChanges__gitBranchError", role: "alert" }, reason(branchError)),
                h(MenuItemButton, { onSelect: reloadBranches }, t("\u91CD\u8BD5"))
              ) : null,
              anchor: tip(branchLabel, h(Button, {
                ref: branchTrigger,
                size: "sm",
                className: "dshChanges__gitBranch",
                disabled: locked,
                "aria-busy": branchLoading,
                "aria-label": t("\u5207\u6362\u5206\u652F\uFF1A{branch}", { branch: branchLabel }),
                "aria-haspopup": "menu",
                "aria-expanded": branchMenu,
                onClick: openBranches,
                onKeyDown: (event) => {
                  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                    event.preventDefault();
                    openBranches();
                  }
                }
              }, branchPending ? h(StateDot, { state: "ongoing", size: 13 }) : h(BranchIcon), h("span", { className: "dshChanges__gitBranchName" }, branchLabel), h(ChevronDown, { size: 12 })))
            }),
            contextLoading && !statistics ? loading("dshChanges__gitStatsLoading") : tip(
              statistics?.statisticsComplete ? t("\u9884\u8BA1\u63D0\u4EA4\u7684\u884C\u6570\u53D8\u5316") : t("\u4EC5\u7EDF\u8BA1\u53EF\u6BD4\u8F83\u7684\u6587\u672C\uFF0C\u90E8\u5206\u66F4\u6539\u65E0\u6CD5\u6309\u884C\u8BA1\u7B97\u3002"),
              h("span", { className: "dshChanges__gitStats", tabIndex: 0, "aria-busy": contextLoading }, h("span", null, "+" + (statistics?.added ?? "\u2014")), h("span", null, "-" + (statistics?.removed ?? "\u2014")))
            ),
            h("label", { className: "dshChanges__gitScope" }, h("input", {
              type: "checkbox",
              checked: include,
              disabled: locked,
              onChange: (event) => {
                setContext(null);
                setContextLoading(true);
                setError(null);
                setInclude(event.target.checked);
              }
            }), t("\u542B\u672A\u6682\u5B58"))
          ),
          h(
            "div",
            { className: "dshChanges__gitMessageArea" },
            h("label", { htmlFor: messageId, className: "dshChanges__gitSrOnly" }, t("\u63D0\u4EA4\u4FE1\u606F")),
            h("textarea", {
              id: messageId,
              className: "dshChanges__gitMessage",
              value: draft,
              readOnly: locked || !draftScope,
              rows: 3,
              maxLength: 65536,
              "data-modal-autofocus": "",
              placeholder: context?.canGenerateMessage ? t("\u63D0\u4EA4\u4FE1\u606F\uFF08\u53EF\u7559\u7A7A\uFF09") : t("\u8BF7\u586B\u5199\u63D0\u4EA4\u4FE1\u606F"),
              onChange: (event) => {
                const value = event.target.value;
                setDraft(value);
                if (draftScope) operation.saveDraft(draftScope, value);
              }
            })
          ),
          errorContent,
          done && h("p", { className: "dshChanges__gitSuccess", role: "status" }, complete()[state.action]),
          uncertain ? h(Button, { size: "sm", onClick: () => operation.recover() }, t("\u91CD\u65B0\u68C0\u67E5\u72B6\u6001")) : done ? h("div", { className: "dshChanges__gitFooter" }, h(Button, { size: "sm", className: "dshChanges__gitSubmit", onClick: close }, t("\u5B8C\u6210"))) : h("div", { className: "dshChanges__gitFooter" }, ...["commit", "push", "pushOnly"].map(actionButton))
        ),
        !dialog && errorContent,
        notice && h(Toast, { text: notice, onDone: () => setNotice(null) })
      );
    };
  }

  // dsh-plugin/sidebar-changes/file-menu.mjs
  function createFileMenu(React, primitives) {
    const h = React.createElement, {
      Menu,
      FileTypeIcon,
      IconFolderOpenOutlineRegular: Folder,
      IconCompareSplitOutlineRegular: Compare,
      IconChevronDownOutlineRegular: Down,
      IconChevronUpOutlineRegular: Up
    } = primitives;
    const icon = (Icon) => Icon ? h(Icon, { size: 16 }) : void 0;
    const fileIcon = h(FileTypeIcon, { kind: "other", size: 16 });
    return function FileMenu({ ctx, tab, sessionId, source, entry, workspaceRoot, point, expanded, toggle, dismiss, onError }) {
      useLocale(React);
      const path = absoluteFilePath(entry, workspaceRoot);
      const [apps, setApps] = React.useState(null), [available, setAvailable] = React.useState(false), [failed, setFailed] = React.useState(false);
      React.useEffect(() => {
        const own = new AbortController(), signal = AbortSignal.any([own.signal, tab.signal]);
        setApps(null);
        setAvailable(false);
        setFailed(false);
        void (async () => {
          try {
            const desktop = await ctx.remote.session.canOpenWorkspacePath();
            if (signal.aborted) return;
            if (!desktop.ok || !desktop.value || !path) {
              setApps([]);
              return;
            }
            setAvailable(true);
            if (entry.status === "deleted") {
              setApps([]);
              return;
            }
            const result = await ctx.remote.session.workspacePathApplications({ path }, signal);
            if (signal.aborted) return;
            if (!result.ok) throw result.error;
            setApps(result.value);
          } catch {
            if (!signal.aborted) {
              setApps([]);
              setFailed(true);
            }
          }
        })();
        return () => own.abort();
      }, [ctx, path, entry.status, tab.signal]);
      React.useEffect(() => {
        const frame = requestAnimationFrame(() => document.querySelector(".dshChanges__fileMenu button:not(:disabled)")?.focus({ preventScroll: true }));
        return () => cancelAnimationFrame(frame);
      }, []);
      const nativeOpen = async (id) => {
        try {
          const reveal = id === "reveal";
          const target = reveal && entry.status === "deleted" ? entry.directoryPath || path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) : path;
          const result = await ctx.remote.session.openWorkspacePath(reveal ? { path: target, action: "reveal" } : { path, application: id.slice(4) });
          if (!result.ok) throw result.error;
        } catch (error) {
          onError(t("\u65E0\u6CD5\u6253\u5F00\u6587\u4EF6\u6216\u6587\u4EF6\u5939\uFF0C\u8BF7\u68C0\u67E5\u8DEF\u5F84\u548C\u5E94\u7528\u662F\u5426\u53EF\u7528\u3002"), error);
        }
      };
      const select = (id) => {
        dismiss();
        if (tab.signal.aborted) return;
        if (id === "file") tab.actions.openResource(fileAddress(sessionId, path));
        else if (id === "diff") tab.actions.openResource(changeAddress(sessionId, source, entry));
        else if (id === "toggle") toggle(entry.fileId);
        else void nativeOpen(id);
      };
      const applications = apps?.map((app) => ({
        id: "app:" + app.id,
        label: app.default ? t("{0}\uFF08\u9ED8\u8BA4\uFF09", [app.name]) : app.name,
        icon: app.icon ? h("img", { src: app.icon, alt: "", width: 16, height: 16, className: "dshChanges__appIcon" }) : fileIcon
      })) || [];
      return h(Menu, {
        open: true,
        anchor: null,
        portal: true,
        compact: true,
        autoFocus: true,
        listClassName: "dshChanges__fileMenu",
        onClose: dismiss,
        onSelect: select,
        getAnchorRect: () => ({ left: point.x, right: point.x, top: point.y, bottom: point.y }),
        items: [
          { id: "file", label: t("\u6253\u5F00\u6587\u4EF6"), icon: fileIcon, disabled: !path || entry.status === "deleted" },
          { id: "diff", label: t("\u67E5\u770B\u66F4\u6539"), icon: icon(Compare) },
          { id: "toggle", label: expanded ? t("\u6536\u8D77\u66F4\u6539") : t("\u5C55\u5F00\u66F4\u6539"), icon: icon(expanded ? Up : Down) },
          { type: "separator", id: "native" },
          {
            id: "open",
            label: t("\u6253\u5F00"),
            icon: icon(Folder),
            disabled: !path || entry.status === "deleted",
            submenu: applications.length ? applications : [{
              id: "unavailable",
              disabled: true,
              label: apps === null ? t("\u6B63\u5728\u52A0\u8F7D\u2026") : failed ? t("\u5E94\u7528\u5217\u8868\u8BFB\u53D6\u5931\u8D25") : t("\u6CA1\u6709\u53EF\u7528\u7684\u5E94\u7528")
            }]
          },
          { id: "reveal", label: t("\u5728\u8D44\u6E90\u7BA1\u7406\u5668\u4E2D\u6253\u5F00"), icon: icon(Folder), disabled: !path || !available }
        ]
      });
    };
  }

  // dsh-plugin/sidebar-changes/file-view.mjs
  function createFileView(React, primitives, { call, message, Placeholder, Details, stats }) {
    const h = React.createElement, { Button, FileTypeIcon, PathLabel, Tag } = primitives;
    return function FileView({ ctx, tab, sessionId: ownerSessionId, states }) {
      useLocale(React);
      const file = React.useMemo(() => parseChangeAddress(tab.contentId), [tab.contentId]);
      const stateKey = ownerSessionId + "\0" + tab.contentId, viewport = React.useRef(null);
      const [data, setData] = React.useState(null), [error, setError] = React.useState(null), [loading, setLoading] = React.useState(true);
      const [refresh, setRefresh] = React.useState(0);
      const reload = React.useCallback(() => setRefresh((value) => value + 1), []);
      React.useEffect(() => tab.actions.bindCommands({ refresh: reload }), [tab.actions, reload]);
      React.useEffect(() => {
        document.addEventListener("dsh-desktop:changes-restore", reload);
        return () => document.removeEventListener("dsh-desktop:changes-restore", reload);
      }, [reload]);
      React.useEffect(() => {
        if (!file || !tab.visible) return;
        const own = new AbortController(), signal = AbortSignal.any([own.signal, tab.signal]);
        setLoading(true);
        setError(null);
        setData(null);
        call(ctx, "listChanges", file.sessionId, file.source, signal).then((value) => {
          if (signal.aborted) return;
          if (value.sessionId !== file.sessionId || value.source !== file.source) throw Error(t("\u65E0\u6CD5\u8BC6\u522B\u6B64\u6587\u4EF6\u7684\u66F4\u6539\u94FE\u63A5\u3002"));
          const entries = [...value.entries, ...value.restoredEntries || []];
          const aliases = entries.filter((entry3) => entry3.aliases?.includes(file.fileId));
          const entry2 = entries.find((entry3) => entry3.fileId === file.fileId) || (aliases.length === 1 ? aliases[0] : void 0);
          setData({ ...value, entry: entry2 });
        }).catch((error2) => {
          if (!signal.aborted) setError(message(error2));
        }).finally(() => {
          if (!signal.aborted) setLoading(false);
        });
        return () => own.abort();
      }, [file, refresh, tab.visible, tab.signal]);
      const restoreScroll = () => {
        if (viewport.current) viewport.current.scrollTop = states.get(stateKey)?.listScroll || 0;
      };
      if (!file) return h(Placeholder, { error: true }, t("\u65E0\u6CD5\u8BC6\u522B\u6B64\u6587\u4EF6\u7684\u66F4\u6539\u94FE\u63A5\u3002"));
      const entry = data?.entry, path = entry && absoluteFilePath(entry, data.workspaceRoot);
      return h(
        "section",
        { className: "dshChanges dshChangeFile", "data-dsh-changes": true, "data-dsh-change-file": file.fileId, "data-source": file.source, "aria-label": t("\u67E5\u770B\u66F4\u6539") },
        h(
          "header",
          { className: "dshChanges__toolbar dshChangeFile__toolbar" },
          h(
            "div",
            { className: "dshChangeFile__path", title: entry?.path || file.path },
            h(FileTypeIcon, { path: entry?.path || file.path, size: 16 }),
            h(PathLabel, { path: entry?.path || file.path })
          ),
          h(
            "div",
            { className: "dshChanges__toolbarActions" },
            h(Button, { size: "sm", disabled: !path || entry.status === "deleted", onClick: () => tab.actions.openResource(fileAddress(file.sessionId, path)) }, t("\u6253\u5F00\u6587\u4EF6")),
            h(Button, { size: "sm", disabled: loading, onClick: reload }, t("\u5237\u65B0"))
          )
        ),
        h(
          "div",
          { className: "dshChanges__metadata dshChangeFile__summary" },
          h(Tag, null, LABELS[file.source]),
          h("span", null, BASES[file.source].join(" \u2192 ")),
          entry && stats(entry.stats)
        ),
        h(
          "div",
          { ref: viewport, className: "dshChangeFile__content", onScroll: (event) => {
            if (tab.visible && !loading) states.set(stateKey, { source: file.source, listScroll: event.currentTarget.scrollTop });
          } },
          error ? h(Placeholder, { error: true, retry: reload, busy: loading }, error) : loading ? h(Placeholder, null, t("\u6B63\u5728\u52A0\u8F7D\u5DEE\u5F02\u2026")) : entry ? h(Details, {
            key: entry.fileId + data.revision + refresh,
            ctx,
            sessionId: file.sessionId,
            source: file.source,
            entry,
            revision: data.revision,
            signal: tab.signal,
            onReady: restoreScroll,
            reload,
            retryBusy: loading
          }) : h(Placeholder, { retry: reload }, t("\u8BE5\u6587\u4EF6\u5DF2\u4E0D\u5728\u6B64\u66F4\u6539\u8303\u56F4\u4E2D\u3002"))
        )
      );
    };
  }

  // dsh-plugin/sidebar-changes/client-entry.mjs
  var ID = "@dsh-desktop/sidebar-changes";
  var KIND = "desktop-changes";
  var PREFIX2 = "dsh-resource://desktop-changes/";
  var STATUS = { get added() {
    return t("\u65B0\u589E");
  }, get deleted() {
    return t("\u5220\u9664");
  }, get renamed() {
    return t("\u91CD\u547D\u540D");
  }, get modified() {
    return t("\u4FEE\u6539");
  }, get restored() {
    return t("\u5DF2\u6062\u590D\u539F\u72B6");
  }, get conflict() {
    return t("\u5408\u5E76\u51B2\u7A81");
  }, get submodule() {
    return t("\u5B50\u6A21\u5757");
  }, get symlink() {
    return t("\u7B26\u53F7\u94FE\u63A5");
  } };
  window.__ModuleLoader__.load({ id: ID, factory(require2) {
    const React = require2("react"), h = React.createElement;
    const primitives = require2("@deepseek-ai/dsh-client-ui-primitives");
    const {
      Button,
      Menu,
      Tag,
      Tooltip,
      PathLabel,
      FileTypeIcon,
      IconChevronDownOutlineRegular: ChevronDown,
      IconChevronRightOutlineRegular: ChevronRight,
      IconChevronUpOutlineRegular: ChevronUp,
      IconCompareSplitOutlineRegular: ChangesIcon,
      IconWarningOutlineRegular: WarningIcon
    } = primitives;
    function FilePath({ path }) {
      return h("span", { className: "dshChanges__path" }, h(PathLabel, { path }));
    }
    const stats = (value) => h("span", { className: "dshChanges__stats" }, h("span", { className: "dshChanges__added" }, "+" + (value?.added ?? "\u2014")), " ", h("span", { className: "dshChanges__removed" }, "-" + (value?.removed ?? "\u2014")));
    const message = (error) => REASONS[error?.message] || error?.message || t("\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5");
    function Placeholder({ children, error = false, retry, busy = false }) {
      return h(
        "div",
        { className: "dshChanges__placeholder", role: error ? "alert" : "status" },
        h("span", { className: "dshChanges__placeholderIcon", "aria-hidden": true }, h(error ? WarningIcon : ChangesIcon, { size: 24 })),
        h("span", null, children),
        retry && h(Button, { size: "sm", variant: "outline", onClick: retry, disabled: busy }, busy ? t("\u6B63\u5728\u91CD\u8BD5\u2026") : t("\u91CD\u8BD5"))
      );
    }
    function StatusTag({ children, label, tone = "neutral" }) {
      return h(
        Tooltip,
        { label: label || children, portal: true, side: "bottom", maxWidth: 320 },
        h("span", { className: "dshChanges__tag", tabIndex: 0 }, h(Tag, { tone }, children))
      );
    }
    function SourceMenu({ source, capabilities, onChange, visible }) {
      const [open, setOpen] = React.useState(false);
      const trigger = React.useRef(), menuClass = "dshChanges__menu-" + React.useId();
      React.useEffect(() => {
        if (!visible) setOpen(false);
      }, [visible]);
      React.useEffect(() => {
        if (!open || !visible) return;
        const frame = requestAnimationFrame(() => {
          if (document.activeElement === trigger.current) document.getElementsByClassName(menuClass)[0]?.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
      }, [open, visible]);
      return h(Menu, {
        open: open && visible,
        portal: true,
        compact: true,
        autoFocus: true,
        selectedId: source,
        className: "dshChanges__source",
        listClassName: "dshChanges__sourceMenu " + menuClass,
        onClose: () => setOpen(false),
        onSelect: (value) => {
          setOpen(false);
          onChange(value);
        },
        items: VIEWS.map((value) => ({ id: value, label: LABELS[value], disabled: value !== "session" && capabilities?.gitAvailability.status !== "available" || value === "history" && !capabilities?.supportedViews?.includes("history") })),
        anchor: h(
          Button,
          {
            ref: trigger,
            size: "sm",
            className: "dshChanges__sourceButton",
            "aria-label": t("\u66F4\u6539\u8303\u56F4"),
            "aria-haspopup": "menu",
            "aria-expanded": open && visible,
            onClick: () => setOpen((value) => !value),
            onKeyDown: (event) => {
              if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                setOpen(true);
              }
            }
          },
          LABELS[source],
          h(ChevronDown, { size: 12 })
        )
      });
    }
    async function call(ctx, method, ...args) {
      const result = await ctx.remote.desktopChanges[method](...args);
      if (!result.ok) throw result.error;
      return result.value;
    }
    function DiffRows({ rows }) {
      return h("div", { className: "dshChanges__code", role: "table", "aria-label": t("\u6587\u4EF6\u5DEE\u5F02") }, rows.map((row, i) => h(
        "div",
        { role: "row", key: i, className: "dshChanges__line", "data-kind": row.kind },
        h("span", { role: "cell", className: "dshChanges__number" }, row.old),
        h("span", { role: "cell", className: "dshChanges__number" }, row.next),
        h("span", { role: "cell", className: "dshChanges__sign" }, row.kind),
        h("code", { role: "cell" }, row.text || " ")
      )));
    }
    function Details({ ctx, sessionId, source, entry, revision, signal, onReady, reload, retryBusy }) {
      useLocale(React);
      const [data, setData] = React.useState(null), [error, setError] = React.useState(null), [expanded, setExpanded] = React.useState({}), [pending, setPending] = React.useState(false);
      const controller = React.useRef(), requests = React.useRef(/* @__PURE__ */ new Set()), ready = React.useRef(onReady);
      ready.current = onReady;
      React.useEffect(() => {
        const own = new AbortController(), active = AbortSignal.any([signal, own.signal]);
        controller.current = active;
        requests.current = /* @__PURE__ */ new Set();
        setData(null);
        setError(null);
        setExpanded({});
        setPending(false);
        call(ctx, "getFileDiff", sessionId, source, entry.fileId, revision, 0, active).then((value) => {
          if (!active.aborted) setData(value);
        }).catch((error2) => {
          if (!active.aborted) setError(message(error2));
        });
        return () => own.abort();
      }, [sessionId, source, entry.fileId, revision]);
      React.useLayoutEffect(() => {
        if (data || error) ready.current(entry.fileId);
      }, [Boolean(data), error]);
      async function more() {
        const active = controller.current;
        if (pending || active.aborted) return;
        setPending(true);
        setError(null);
        try {
          const value = await call(ctx, "getFileDiff", sessionId, source, entry.fileId, revision, data.nextOffset, active);
          if (!active.aborted) setData((old) => ({ ...value, operations: old.operations, rows: [...old.rows, ...value.rows] }));
        } catch (error2) {
          if (!active.aborted) setError(message(error2));
        } finally {
          if (!active.aborted) setPending(false);
        }
      }
      async function context(gap) {
        const active = controller.current, current = expanded[gap.offset], inFlight = requests.current;
        if (inFlight.has(gap.offset) || active.aborted) return;
        inFlight.add(gap.offset);
        setError(null);
        setExpanded((old) => ({ ...old, [gap.offset]: { ...old[gap.offset], pending: true } }));
        try {
          const value = await call(ctx, "getFileContext", sessionId, source, entry.fileId, revision, current?.nextOffset ?? gap.offset, active);
          if (!active.aborted) setExpanded((old) => ({ ...old, [gap.offset]: { ...value, rows: [...old[gap.offset]?.rows || [], ...value.rows] } }));
        } catch (error2) {
          if (!active.aborted) setError(message(error2));
        } finally {
          inFlight.delete(gap.offset);
          if (!active.aborted) setExpanded((old) => ({ ...old, [gap.offset]: { ...old[gap.offset], pending: false } }));
        }
      }
      const rendered = [], group = [];
      const flush = () => {
        if (group.length) {
          rendered.push(h(DiffRows, { key: "lines-" + rendered.length, rows: group.splice(0) }));
        }
      };
      for (const row of data?.rows || []) {
        if (row.kind !== "gap") {
          group.push(row);
          continue;
        }
        flush();
        const opened = expanded[row.offset];
        if (opened?.rows) rendered.push(h(DiffRows, { key: "context-" + row.offset, rows: opened.rows }));
        if (!opened || opened.nextOffset !== null) rendered.push(h(Button, { key: "gap-" + row.offset, size: "sm", className: "dshChanges__context", disabled: opened?.pending, onClick: () => context(row) }, opened?.pending ? t("\u6B63\u5728\u52A0\u8F7D\u2026") : t("\u5C55\u5F00 {0} \u884C\u4E0A\u4E0B\u6587", [row.length - (opened?.rows?.length || 0)])));
      }
      flush();
      return h(
        "div",
        { className: "dshChanges__detail" },
        error && h(Placeholder, { error: true, retry: reload, busy: retryBusy }, error),
        !data && !error && h("div", { className: "dshChanges__loading", role: "status" }, t("\u6B63\u5728\u52A0\u8F7D\u5DEE\u5F02\u2026")),
        data && h(
          React.Fragment,
          null,
          data.previousPath && h("div", { className: "dshChanges__metadata" }, h(StatusTag, { label: `${data.previousPath} \u2192 ${data.path}` }, t("\u91CD\u547D\u540D"))),
          data.reason && h(Placeholder, null, REASONS[data.reason] || data.reason),
          rendered,
          (data.beforeNewline === false || data.afterNewline === false) && h("div", { className: "dshChanges__metadata" }, h(Tag, { tone: "quiet" }, t("\u6587\u4EF6\u672B\u5C3E\u65E0\u6362\u884C"))),
          data.totalRows === 0 && !data.reason && h(Placeholder, null, t("\u65E0\u6587\u672C\u884C\u53D8\u5316")),
          data.nextOffset !== null && h(Button, { size: "sm", className: "dshChanges__context", onClick: more, disabled: pending }, pending ? t("\u6B63\u5728\u52A0\u8F7D\u2026") : t("\u52A0\u8F7D\u66F4\u591A\u5DEE\u5F02")),
          source === "session" && entry.operationCount > 0 && h(SessionDetails, { ctx, sessionId, entry, revision, signal })
        )
      );
    }
    const SessionDetails = createSessionDetails(React, primitives, { call, message, Placeholder, DiffRows, stats });
    const GitActions = createGitActions(React, primitives);
    const HistoryView = createHistoryView(React, primitives, { SourceMenu, Placeholder, StatusTag, call, message });
    const FileMenu = createFileMenu(React, primitives);
    const FileView = createFileView(React, primitives, { call, message, Placeholder, Details, stats });
    function Panel(props) {
      useLocale(React);
      const { states, sessionId, tab } = props, key = sessionId + "\0" + tab.contentId;
      const [source, setSource] = React.useState(() => states.get(key)?.source || "session");
      const viewStates = React.useMemo(() => createViewStates(states, source), [states, source]);
      const onSourceChange = (value) => {
        states.set(key, { ...states.get(key), source: value });
        setSource(value);
      };
      React.useEffect(() => {
        const restore = () => setSource(states.get(key)?.source || "session");
        document.addEventListener("dsh-desktop:changes-restore", restore);
        return () => document.removeEventListener("dsh-desktop:changes-restore", restore);
      }, [key]);
      return h(source === "history" ? HistoryView : ChangesPanel, { ...props, key: source, source, states: viewStates, onSourceChange });
    }
    function ChangesPanel({ ctx, tab, sessionId, states, source, onSourceChange }) {
      useLocale(React);
      const stateKey = sessionId + "\0" + tab.contentId;
      const saved = states.get(stateKey) || { source: "session", fileId: null, listScroll: 0, detailScroll: 0 };
      const openedFiles = (value) => value.fileIds || (value.fileId ? [value.fileId] : []);
      const [expanded, setExpanded] = React.useState(() => openedFiles(saved));
      const [showRestored, setShowRestored] = React.useState(Boolean(saved.showRestored));
      const [capabilities, setCapabilities] = React.useState(null), [data, setData] = React.useState(null), [error, setError] = React.useState(null);
      const [refresh, setRefresh] = React.useState(0), [loading, setLoading] = React.useState(true);
      const [detailAttempt, setDetailAttempt] = React.useState(0), retryDetails = React.useRef(false);
      const [fileMenu, setFileMenu] = React.useState(null), [actionError, setActionError] = React.useState(null);
      const list = React.useRef(), position = React.useRef(saved), root = React.useRef(null);
      const restoring = React.useRef(true), readyFiles = React.useRef(/* @__PURE__ */ new Set());
      const fetching = React.useRef(false);
      const update = (patch) => {
        position.current = { ...position.current, ...patch };
        states.set(stateKey, position.current);
      };
      React.useEffect(() => {
        update({ source, fileIds: expanded, fileId: expanded.at(-1) || null });
      }, [source, expanded]);
      const restoreScroll = (fileId) => {
        if (fileId) readyFiles.current.add(fileId);
        if (!restoring.current || !list.current) return;
        list.current.scrollTop = position.current.listScroll || 0;
        if (expanded.every((id) => readyFiles.current.has(id))) restoring.current = false;
      };
      React.useLayoutEffect(() => {
        if (!tab.visible) {
          restoring.current = true;
          readyFiles.current.clear();
        }
      }, [tab.visible]);
      React.useEffect(() => {
        const restore = () => {
          const value = states.get(stateKey);
          if (!value) return;
          position.current = value;
          restoring.current = true;
          readyFiles.current.clear();
          setData(null);
          setExpanded(openedFiles(value));
          setRefresh((n) => n + 1);
        };
        document.addEventListener("dsh-desktop:changes-restore", restore);
        return () => document.removeEventListener("dsh-desktop:changes-restore", restore);
      }, [stateKey]);
      React.useEffect(() => {
        if (!tab.visible) return;
        const own = new AbortController(), signal = AbortSignal.any([own.signal, tab.signal]);
        fetching.current = true;
        setLoading(true);
        setError(null);
        call(ctx, "getCapabilities", sessionId, signal).then(async (cap) => {
          if (signal.aborted) return;
          if (source !== "session" && root.current && root.current !== cap.workspaceRoot) {
            setData(null);
            setExpanded([]);
            update({ listScroll: 0, detailScroll: 0 });
          }
          root.current = cap.workspaceRoot;
          setCapabilities(cap);
          if (source !== "session" && cap.gitAvailability.status !== "available") {
            onSourceChange("session");
            return;
          }
          const value = await call(ctx, "listChanges", sessionId, source, signal);
          if (signal.aborted || value.sessionId !== sessionId || value.source !== source || value.workspaceRoot !== root.current) return;
          setData({ ...value, endpointId: cap.endpointId });
          if (retryDetails.current) {
            retryDetails.current = false;
            setDetailAttempt((attempt) => attempt + 1);
          }
          setExpanded((current) => migrateFileIds(current, [...value.entries, ...value.restoredEntries || []]));
        }).catch((error2) => {
          if (!signal.aborted) setError(message(error2));
        }).finally(() => {
          if (!signal.aborted) {
            fetching.current = false;
            setLoading(false);
          }
        });
        return () => {
          own.abort();
          fetching.current = false;
        };
      }, [sessionId, source, refresh, tab.visible]);
      React.useEffect(() => {
        if (!tab.visible) return;
        const own = new AbortController();
        let debounce;
        const invalidate = () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => setRefresh((n) => n + 1), 250);
        };
        const focus = () => {
          if (!document.hidden && !fetching.current) invalidate();
        };
        window.addEventListener("focus", focus);
        document.addEventListener("visibilitychange", focus);
        window.addEventListener("dsh-desktop:git-changed", invalidate);
        const timer = setInterval(focus, source === "session" ? 3e4 : 5e3);
        if (source === "session") (async () => {
          try {
            const stream = ctx.remote.desktopChanges.subscribeChanges(sessionId, "", AbortSignal.any([own.signal, tab.signal]));
            let first = true;
            for await (const value of stream) {
              if (own.signal.aborted) break;
              if (!first) invalidate();
              first = false;
            }
          } catch {
          }
        })();
        return () => {
          own.abort();
          clearTimeout(debounce);
          clearInterval(timer);
          window.removeEventListener("focus", focus);
          window.removeEventListener("dsh-desktop:git-changed", invalidate);
          document.removeEventListener("visibilitychange", focus);
        };
      }, [sessionId, source, tab.visible]);
      React.useLayoutEffect(() => {
        if (data) restoreScroll();
      }, [Boolean(data), expanded]);
      const changeSource = (value) => {
        if (value === source) return;
        update({ source, fileIds: expanded, fileId: expanded.at(-1) || null });
        onSourceChange(value);
      };
      const reload = () => {
        retryDetails.current = true;
        setRefresh((n) => n + 1);
      };
      const toggle = (id) => {
        restoring.current = false;
        setExpanded((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
      };
      React.useEffect(() => {
        setFileMenu(null);
      }, [source, tab.visible]);
      const showFileMenu = (event, fileId, keyboard = false) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setFileMenu({ fileId, trigger: event.currentTarget, point: keyboard ? { x: rect.left + 8, y: rect.bottom } : { x: event.clientX, y: event.clientY } });
      };
      const dismissFileMenu = () => {
        setFileMenu(null);
        fileMenu?.trigger?.focus({ preventScroll: true });
      };
      const totals = data?.entries.reduce((total, entry) => ({
        added: total.added === null || entry.stats.added === null ? null : total.added + entry.stats.added,
        removed: total.removed === null || entry.stats.removed === null ? null : total.removed + entry.stats.removed
      }), { added: 0, removed: 0 });
      const git = capabilities?.gitAvailability;
      const noGit = git && git.status !== "available";
      const panelId = React.useId();
      const entries = [...data?.entries || [], ...showRestored ? data?.restoredEntries || [] : []];
      const menuEntry = fileMenu && entries.find((entry) => entry.fileId === fileMenu.fileId);
      const summary = source === "session" && data?.totals ? h(
        React.Fragment,
        null,
        data.totals.session.files > 0 && h("span", { title: t("\u5DF2\u786E\u8BA4\u7684\u4F1A\u8BDD\u51C0\u53D8\u5316") }, stats(data.totals.session)),
        data.totals.observed.files > 0 && h("span", { title: t("\u5305\u542B\u6267\u884C\u671F\u95F4\u89C2\u5BDF\u5230\u7684\u53D8\u5316") }, stats(data.totals.observed)),
        data.totals.unavailable > 0 && h("span", null, t("{0} \u4E2A\u5F85\u5B8C\u6574\u6BD4\u8F83", [data.totals.unavailable]))
      ) : stats(totals);
      return h(
        "section",
        { className: "dshChanges", "aria-label": t("\u66F4\u6539"), "data-dsh-changes": true, "data-source": source },
        h(
          "header",
          { className: "dshChanges__toolbar" },
          h(
            "div",
            { className: "dshChanges__scope" },
            h(SourceMenu, { source, capabilities, onChange: changeSource, visible: tab.visible }),
            noGit && h(StatusTag, { label: git.reason }, git.status === "none" ? t("\u975E Git \u4ED3\u5E93") : git.status === "missing" ? t("Git \u672A\u5B89\u88C5") : t("Git \u4E0D\u53EF\u7528"))
          ),
          h(
            "div",
            { className: "dshChanges__toolbarActions" },
            Boolean(data?.entries.length) && h(
              "div",
              { className: "dshChanges__summary", "aria-label": t("{0} \u4E2A\u6587\u4EF6", [data.entries.length]) },
              h(Tag, { tone: "neutral" }, data.entries.length),
              summary
            ),
            h(GitActions, { ctx, sessionId, capabilities, source, data, visible: tab.visible, onStaged: () => changeSource("staged") }),
            expanded.length > 0 && h(
              Tooltip,
              { label: t("\u5168\u90E8\u6298\u53E0"), portal: true, side: "bottom" },
              h(Button, { size: "sm", className: "dshChanges__collapse", "aria-label": t("\u5168\u90E8\u6298\u53E0"), onClick: () => {
                restoring.current = false;
                setExpanded([]);
              } }, h(ChevronUp, { size: 14 }))
            )
          )
        ),
        source === "session" && data?.pendingCount > 0 && h(
          "div",
          { className: "dshChanges__metadata" },
          h(Tag, { tone: "quiet" }, t("\u6B63\u5728\u91C7\u96C6"))
        ),
        actionError && h(
          "div",
          { className: "dshChanges__actionError", role: "alert" },
          actionError,
          h(Button, { size: "sm", onClick: () => setActionError(null) }, t("\u5173\u95ED"))
        ),
        tab.visible && menuEntry && h(FileMenu, {
          key: menuEntry.fileId,
          ctx,
          tab,
          sessionId,
          source,
          entry: menuEntry,
          workspaceRoot: data.workspaceRoot,
          point: fileMenu.point,
          expanded: expanded.includes(menuEntry.fileId),
          toggle,
          dismiss: dismissFileMenu,
          onError: setActionError
        }),
        error && h(Placeholder, { error: true, retry: reload, busy: loading }, error),
        loading && !data && !error && h(Placeholder, null, t("\u6B63\u5728\u52A0\u8F7D\u66F4\u6539\u2026")),
        data && h(
          "div",
          {
            className: "dshChanges__list",
            ref: list,
            onWheel: () => {
              restoring.current = false;
            },
            onPointerDown: () => {
              restoring.current = false;
            },
            onScroll: (event) => {
              setFileMenu(null);
              if (tab.visible && !restoring.current) update({ listScroll: event.currentTarget.scrollTop });
            }
          },
          !data.entries.length && h(Placeholder, null, source === "session" ? data.gaps.length ? t("\u6682\u672A\u627E\u5230\u53EF\u5C55\u793A\u7684\u66F4\u6539\uFF0C\u91C7\u96C6\u8303\u56F4\u5B58\u5728\u7F3A\u53E3") : data.restoredEntries?.length ? t("\u5DF2\u8BB0\u5F55\u7684\u6587\u4EF6\u5747\u5DF2\u6062\u590D\u539F\u72B6") : t("\u5C1A\u65E0\u5DF2\u8BB0\u5F55\u7684\u6587\u4EF6\u66F4\u6539") : source === "staged" ? t("\u6682\u65E0\u6682\u5B58\u7684\u66F4\u6539") : t("\u6CA1\u6709\u672A\u63D0\u4EA4\u7684\u66F4\u6539")),
          data.restoredEntries?.length > 0 && h(Button, {
            size: "sm",
            className: "dshChanges__historyButton",
            "aria-expanded": showRestored,
            onClick: () => {
              setShowRestored((value) => !value);
              update({ showRestored: !showRestored });
            }
          }, t("{0}\u5DF2\u6062\u590D\u539F\u72B6\uFF08{1}\uFF09", [showRestored ? t("\u6536\u8D77") : t("\u67E5\u770B"), data.restoredEntries.length])),
          entries.map((entry, index) => {
            const open = expanded.includes(entry.fileId), detailId = panelId + "-" + entry.fileId;
            const segmented = entry.reason && entry.continuity === "broken";
            return h(
              "article",
              { key: entry.fileId, className: "dshChanges__item", "data-open": open },
              data.roots?.length > 1 && entry.root !== entries[index - 1]?.root && h("div", { className: "dshChanges__metadata dshChanges__root" }, entry.root),
              h(
                Tooltip,
                { label: entry.path, portal: true, side: "bottom", delayMs: 600, focusDelayMs: 400, maxWidth: 420 },
                h(
                  Button,
                  {
                    size: "sm",
                    className: "dshChanges__file",
                    onClick: () => toggle(entry.fileId),
                    onContextMenu: (event) => showFileMenu(event, entry.fileId),
                    onKeyDown: (event) => {
                      if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") showFileMenu(event, entry.fileId, true);
                    },
                    "data-context-open": menuEntry?.fileId === entry.fileId || void 0,
                    "aria-expanded": open,
                    "aria-controls": detailId,
                    "aria-label": t("{0}\uFF0C{1}\uFF0C\u65B0\u589E {2} \u884C\uFF0C\u5220\u9664 {3} \u884C", [entry.path, STATUS[entry.status], entry.stats.added ?? t("\u672A\u77E5"), entry.stats.removed ?? t("\u672A\u77E5")])
                  },
                  h("span", { className: "dshChanges__chevron", "aria-hidden": true }, h(open ? ChevronDown : ChevronRight, { size: 12 })),
                  h(FileTypeIcon, { path: entry.path, size: 16, className: "dshChanges__fileIcon" }),
                  h("span", { className: "dshChanges__row" }, h(FilePath, { path: entry.path }), stats(entry.stats))
                )
              ),
              (segmented || !["added", "modified"].includes(entry.status)) && h(
                "div",
                { className: "dshChanges__fileTags" },
                !["added", "modified"].includes(entry.status) && h(Tag, { tone: entry.status === "deleted" ? "danger" : "neutral" }, STATUS[entry.status]),
                segmented && h(StatusTag, { tone: "warning", label: REASONS[entry.reason] || entry.reason }, t("\u5206\u6BB5\u6BD4\u8F83"))
              ),
              h("div", { id: detailId, "aria-hidden": !open }, open && tab.visible && h(Details, { key: entry.fileId + source + detailAttempt, ctx, sessionId, source, entry, revision: data.revision, signal: tab.signal, onReady: restoreScroll, reload, retryBusy: loading }))
            );
          })
        )
      );
    }
    function installUI(ctx) {
      const states = /* @__PURE__ */ new Map(), addresses = /* @__PURE__ */ new WeakMap();
      function Body(props) {
        useLocale(React);
        const tab = props.useTabInfo().tab;
        React.useLayoutEffect(() => {
          if (tab.contentId !== "sidebar://" + KIND) return;
          if (!addresses.has(tab.signal)) addresses.set(tab.signal, PREFIX2 + encodeURIComponent(tab.id) + "-" + crypto.randomUUID());
          tab.actions.openResource(addresses.get(tab.signal), { replaceTab: true, revealIfOpened: false });
        }, [tab.contentId, tab.signal]);
        return tab.contentId.startsWith(PREFIX2) ? h(Panel, { key: props.sessionId + tab.contentId, ctx, tab, sessionId: props.sessionId, states }) : h(Placeholder, null, t("\u6B63\u5728\u6253\u5F00\u66F4\u6539\u2026"));
      }
      const offBody = ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: ID, inject: (sessionId) => ({ sessionId }) }, Body));
      const offFileBody = ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab",
        key: ID + "/file",
        inject: (sessionId) => ({ sessionId })
      }, (props) => h(FileView, { ctx, tab: props.useTabInfo().tab, sessionId: props.sessionId, states })));
      const offFileType = ctx.sidebarRightTabs.register({
        id: ID + "/file",
        kind: FILE_KIND,
        patterns: [FILE_PREFIX + "**"],
        canOpen: (address) => Boolean(parseChangeAddress(address)),
        title: changeTitle
      });
      let offType, mode;
      const sync = () => {
        const next = document.documentElement.getAttribute("data-dsh-ui") !== "vanilla";
        if (next === mode) return;
        mode = next;
        offType?.();
        offType = ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          patterns: [PREFIX2 + "**"],
          canOpen: (address) => address.startsWith(PREFIX2),
          title: () => t("\u66F4\u6539"),
          ...mode ? { guide: [{ order: 30, title: () => t("\u66F4\u6539"), description: () => t("\u67E5\u770B\u6587\u4EF6\u4FEE\u6539\u524D\u540E\u7684\u5DEE\u5F02"), icon: (props) => h(ChangesIcon, { size: props.size || 22 }) }] } : {}
        });
      };
      sync();
      document.addEventListener("dsh-desktop:ui-mode", sync);
      const observer = new MutationObserver(sync);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-dsh-ui"] });
      const provider = createStateProvider(ctx, states);
      const offState = window.__DSH_UI_STATE__?.registerProvider("desktop-changes", provider);
      return () => {
        observer.disconnect();
        document.removeEventListener("dsh-desktop:ui-mode", sync);
        offType?.();
        offFileType();
        offFileBody();
        offBody();
        offState?.();
        states.clear();
      };
    }
    return { inject: ["slots", "sidebarRightTabs", "sessions", "remote", "remote.session"], async apply(ctx) {
      const offRemote = await ctx.remote.$mount(contribution);
      const fiber = ctx.inject(["remote.desktopChanges"], installUI);
      return async () => {
        await fiber.dispose();
        await offRemote();
      };
    } };
  } });
})();
