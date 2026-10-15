(() => {
  // dsh-plugin/session-links/links.mjs
  function parseSessionLink(input) {
    if (typeof input !== "string") return null;
    const match = /^deepseekharness:(?:\/\/)?session\/([^/?#]+?)\/?$/i.exec(input.trim());
    if (!match) return null;
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
    const suffix = id.replace(/^session-/, "");
    if (!suffix || suffix.length > 120 || !/^[A-Za-z0-9._~-]+$/.test(suffix) || /^\.{1,2}$/.test(suffix)) return null;
    return "session-" + suffix;
  }
  function sessionLinksInText(text) {
    return sessionLinkRanges(text).map(({ sessionId, label }) => ({ sessionId, label }));
  }
  function sessionLinkRanges(text) {
    const references = [];
    for (const match of text.matchAll(/\bdeepseekharness:[^\s<>"'`()\[\]{}，。！？；：、“”‘’（）【】,;!]+/gi)) {
      const link = match[0];
      const sessionId = parseSessionLink(link);
      if (sessionId) references.push({ sessionId, label: link, start: match.index, end: match.index + link.length });
    }
    return references;
  }
  function linksForNode(node) {
    const blocks = node?.kind === "assistant-step" ? node.data?.blocks : node?.data?.content;
    const found = /* @__PURE__ */ new Map();
    for (const block of blocks || []) {
      if (block.type !== "text" && block.kind !== "text") continue;
      for (const link of sessionLinksInText(block.text || "")) if (!found.has(link.sessionId)) found.set(link.sessionId, link);
    }
    return [...found.values()];
  }
  async function openSessionLink(ctx, link) {
    const id = parseSessionLink(link);
    if (!id) throw Error("invalid-session-link");
    if (!ctx.sessions.list.getSnapshot().byId[id]) throw Error("deep-link-session-missing");
    await ctx.uiWorkspace.openSession(id);
  }

  // dsh-plugin/session-links/inline.mjs
  function mountInlineSessionLinks(root, links, open) {
    const document = root.ownerDocument;
    const allowed = new Set(links.map((link) => link.sessionId));
    const decorated = [];
    const excluded = 'a,button,input,textarea,select,script,style,pre,[role="button"],[contenteditable="true"],[data-ref-chip]';
    function restore(records) {
      const changed = new Set(records.filter((record) => record.type === "characterData").map((record) => record.target));
      for (const { node, text, prefix, siblings } of decorated.splice(0)) {
        for (const sibling of siblings) sibling.remove();
        if (root.contains(node) && !changed.has(node) && node.data === prefix) node.data = text;
      }
    }
    function refresh(records = []) {
      restore(records);
      const walker = document.createTreeWalker(
        root,
        4
        /* SHOW_TEXT */
      );
      const pending = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement.closest(excluded)) continue;
        const ranges = sessionLinkRanges(node.data).filter((link) => allowed.has(link.sessionId));
        if (ranges.length) pending.push({ node, ranges });
      }
      for (const { node, ranges } of pending) {
        const text = node.data, prefix = text.slice(0, ranges[0].start), siblings = [];
        let cursor = ranges[0].start;
        for (const range of ranges) {
          if (range.start > cursor) siblings.push(document.createTextNode(text.slice(cursor, range.start)));
          const anchor = document.createElement("a");
          anchor.href = range.label;
          anchor.textContent = range.label;
          anchor.dataset.dshSessionLink = range.sessionId;
          anchor.style.cssText = "color:var(--dsw-alias-label-link, #4169c1);text-decoration:underline;cursor:pointer;overflow-wrap:anywhere";
          siblings.push(anchor);
          cursor = range.end;
        }
        if (cursor < text.length) siblings.push(document.createTextNode(text.slice(cursor)));
        node.data = prefix;
        node.after(...siblings);
        decorated.push({ node, text, prefix, siblings });
      }
      observer.takeRecords();
    }
    function onClick(event) {
      const anchor = event.target.closest?.("a[data-dsh-session-link]");
      if (!anchor || !root.contains(anchor)) return;
      event.preventDefault();
      event.stopPropagation();
      open(anchor.getAttribute("href"));
    }
    const observer = new document.defaultView.MutationObserver(refresh);
    refresh();
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    root.addEventListener("click", onClick);
    return () => {
      const records = observer.takeRecords();
      observer.disconnect();
      root.removeEventListener("click", onClick);
      restore(records);
    };
  }

  // dsh-plugin/i18n/api.mjs
  function t(source, values) {
    const runtime = globalThis.window?.__DSH_I18N__;
    if (runtime) return runtime.t(source, values);
    return typeof source === "string" ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source;
  }
  function useLocale(React) {
    globalThis.window?.__DSH_I18N__?.use(React);
  }

  // dsh-plugin/session-links/client-entry.mjs
  window.__ModuleLoader__.load({ id: "@dsh-desktop/session-links", factory(require2) {
    const React = require2("react"), h = React.createElement;
    return { inject: ["slots", "sessions", "uiWorkspace"], apply(ctx) {
      const slot = "conversation.chat.node";
      if (typeof ctx.slots.entries !== "function") return;
      ctx.slots.inject(slot, () => {
        const mounted = /* @__PURE__ */ new Map(), wrappers = /* @__PURE__ */ new Set();
        let syncing = false;
        function sync() {
          if (syncing) return;
          syncing = true;
          try {
            const keys = /* @__PURE__ */ new Set();
            const entries = ctx.slots.entries(slot).filter((entry) => {
              const key = entry.options.key;
              if (entry.component.__dshTranscriptViewport || wrappers.has(entry.component) || keys.has(key) || !["user", "steering", "assistant-step"].includes(key)) return false;
              keys.add(key);
              return true;
            });
            for (const [entry, remove] of mounted) if (!entries.includes(entry)) {
              remove();
              mounted.delete(entry);
            }
            for (const entry of entries) {
              let LinkedMessage = function(props) {
                useLocale(React);
                const root = React.useRef(null);
                const links = React.useMemo(() => linksForNode(props.node), [props.node]);
                const [error, setError] = React.useState("");
                const node = React.useMemo(() => {
                  const labels = props.node.data?.referenceLabels;
                  if (!labels?.some((label) => parseSessionLink(label))) return props.node;
                  return { ...props.node, data: {
                    ...props.node.data,
                    referenceLabels: labels.filter((label) => !parseSessionLink(label))
                  } };
                }, [props.node]);
                React.useLayoutEffect(() => {
                  if (!links.length || !root.current) return;
                  return mountInlineSessionLinks(root.current, links, (link) => {
                    setError("");
                    void openSessionLink(ctx, link).catch(() => setError(t("\u94FE\u63A5\u6307\u5411\u7684\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u5220\u9664\u6216\u5F52\u6863\uFF09\u3002")));
                  });
                }, [links]);
                return h(
                  "div",
                  { ref: root, "data-dsh-session-message": props.node.kind, style: { display: "contents" } },
                  h(entry.component, { ...props, node }),
                  error ? h("span", { role: "alert" }, error) : null
                );
              };
              if (mounted.has(entry)) continue;
              wrappers.add(LinkedMessage);
              mounted.set(entry, ctx.slots.register({
                ...entry.options,
                name: slot,
                priority: (entry.options.priority || 0) - 1,
                inject: entry.inject,
                store: entry.store,
                locale: entry.locale
              }, LinkedMessage));
            }
          } finally {
            syncing = false;
          }
        }
        const off = ctx.slots.subscribe(slot, sync);
        sync();
        return () => {
          off();
          for (const remove of mounted.values()) remove();
          mounted.clear();
          wrappers.clear();
        };
      });
    } };
  } });
})();
