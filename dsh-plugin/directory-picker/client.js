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

  // dsh-plugin/directory-picker/protocol.mjs
  var ID = "@dsh-desktop/directory-picker";
  var contribution = { package: ID, descriptors: ["capability", "roots"].map((method) => ({
    id: "desktopDirectoryPicker/" + method,
    service: "desktopDirectoryPicker",
    namespace: "desktopDirectoryPicker",
    method,
    invocation: { kind: "direct" },
    parameters: [],
    cancellation: { parameter: "signal" },
    result: { mode: "src-json" }
  })) };

  // dsh-plugin/directory-picker/navigation.mjs
  var ROOTS = "desktop:roots";
  function createNavigation({ listDirectory, listRoots }) {
    let state = { location: null, history: [], index: -1, loading: false, error: null };
    let generation = 0, controller;
    const listeners = /* @__PURE__ */ new Set();
    const update = (changes) => {
      state = { ...state, ...changes };
      for (const listener of listeners) listener();
    };
    async function visit(target, { index, replace = false } = {}) {
      const ticket = ++generation;
      controller?.abort();
      controller = new AbortController();
      update({ loading: true, error: null });
      try {
        const location = target === ROOTS ? { kind: "roots", path: ROOTS, entries: await listRoots(controller.signal), crumbs: [] } : { ...await listDirectory(target, controller.signal), kind: "directory" };
        if (ticket !== generation) return false;
        let history = state.history, nextIndex = state.index;
        if (index !== void 0) nextIndex = index;
        else if (!replace && location.path !== history[nextIndex]) {
          history = [...history.slice(0, nextIndex + 1), location.path];
          nextIndex = history.length - 1;
        } else if (nextIndex < 0) {
          history = [location.path];
          nextIndex = 0;
        }
        update({ location, history, index: nextIndex, loading: false, error: null });
        return true;
      } catch (error) {
        if (ticket === generation) update({ loading: false, error: error?.rpcError?.message || error?.message || String(error) });
        return false;
      }
    }
    const move = (delta) => {
      const index = state.index + delta;
      if (index < 0 || index >= state.history.length) return Promise.resolve(false);
      return visit(state.history[index], { index });
    };
    return {
      getSnapshot: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      visit,
      back: () => move(-1),
      forward: () => move(1),
      parent: () => state.location?.kind === "directory" ? visit(state.location.crumbs.at(-2)?.path ?? ROOTS) : Promise.resolve(false),
      refresh: () => visit(state.location?.path, { replace: true }),
      dispose() {
        generation++;
        controller?.abort();
        listeners.clear();
      }
    };
  }

  // dsh-plugin/directory-picker/style.css
  var style_default = ".dshDirectory.dshDirectory {\n  width: min(720px, 100%); height: min(560px, calc(100dvh - 32px)); min-height: 0;\n  padding: 0; gap: 0; overflow: hidden;\n}\n.dshDirectory__header { flex: none; padding: 20px 24px 12px; border-bottom: 1px solid var(--dsw-alias-border-l3); }\n.dshDirectory__header h2 { margin: 0 0 12px; font-size: 16px; font-weight: 510; color: var(--dsw-alias-label-primary); }\n.dshDirectory__toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 4px; }\n.dshDirectory__toolbar > button { flex: none; padding-inline: 10px; white-space: nowrap; }\n.dshDirectory__tool { width: 36px; padding: 0 !important; flex: none; }\n.dshDirectory__path { display: flex; align-items: center; gap: 8px; flex: 1 1 280px; min-width: min(280px, 100%); }\n.dshDirectory__path > input { flex: 1; }\n.dshDirectory__path > button { flex: none; white-space: nowrap; }\n.dshDirectory__input { box-sizing: border-box; width: 100%; min-width: 0; height: 36px; border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 6px 10px; }\n.dshDirectory__input::placeholder { color: var(--dsw-alias-label-tertiary); }\n.dshDirectory__input:focus-visible, .dshDirectory button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }\n.dshDirectory__crumbs { display: flex; align-items: center; gap: 6px; overflow-x: auto; min-height: 28px; margin-top: 6px; color: var(--dsw-alias-label-tertiary); }\n.dshDirectory__crumb { flex: none; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0;\n  background: transparent; color: var(--dsw-alias-label-secondary); padding: 4px 2px; font: inherit; font-size: 12px; cursor: pointer; }\n.dshDirectory__crumb[aria-current] { color: var(--dsw-alias-label-primary); }\n.dshDirectory__list { flex: 1 1 0; min-height: 0; overflow: auto; padding: 12px 20px; }\n.dshDirectory__list:focus { outline: none; }\n.dshDirectory__row { display: flex; align-items: center; gap: 8px; min-height: 34px; width: 100%; padding: 6px; text-align: left;\n  border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; font-size: 13px; }\n.dshDirectory__row svg { flex: none; color: var(--dsw-alias-label-secondary); }\n.dshDirectory__row span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.dshDirectory__row:enabled:hover, .dshDirectory__crumb:enabled:hover { background: var(--dsw-alias-interactive-bg-hover); }\n.dshDirectory button:disabled { cursor: default; opacity: .45; }\n.dshDirectory__error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; font-size: 13px; margin: 8px 0; }\n.dshDirectory__status { color: var(--dsw-alias-label-secondary); font-size: 13px; }\n.dshDirectory__status:not(:empty) { padding: 8px 6px; }\n.dshDirectory__footer { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; flex: none; padding: 16px 24px; border-top: 1px solid var(--dsw-alias-border-l3); }\n.dshDirectory__hidden { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--dsw-alias-label-secondary); cursor: pointer; }\n.dshDirectory__hidden input { accent-color: var(--dsw-alias-state-business-primary); }\n.dshDirectory__actions { display: flex; justify-content: flex-end; gap: 8px; margin-left: auto; }\n.dshDirectory__actions button { min-width: 64px; }\n.dshDirectory__create.dshDirectory__create { width: min(380px, 100%); }\n.dshDirectory__createForm { display: flex; flex-direction: column; gap: 16px; }\n.dshDirectory__createPath { font-size: 13px; color: var(--dsw-alias-label-secondary); margin: 0; overflow-wrap: anywhere; }\n@media (max-width: 480px) {\n  .dshDirectory__toolbar > .dshDirectory__home { width: 36px; padding: 0; }\n  .dshDirectory__homeText { display: none; }\n  .dshDirectory__header { padding: 16px 16px 8px; }\n  .dshDirectory__list { padding: 8px 12px; }\n  .dshDirectory__footer { padding: 12px 16px; gap: 10px; }\n  .dshDirectory__footer .dshDirectory__actions { width: 100%; }\n  .dshDirectory__row { min-height: 40px; }\n}\n";

  // dsh-plugin/directory-picker/client-entry.mjs
  window.__ModuleLoader__.load({ id: ID, factory(require2) {
    const React = require2("react"), h = React.createElement;
    const {
      Modal,
      Button,
      IconChevronLeftOutlineRegular: Back,
      IconChevronRightOutlineRegular: Forward,
      IconChevronUpOutlineRegular: Up,
      IconRefreshOutlineRegular: Refresh,
      IconFolderCloseRegular: Folder
    } = require2("@deepseek-ai/dsh-client-ui-primitives");
    function Drive() {
      return h(
        "svg",
        { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true },
        h("path", { d: "M5 4h14l3 11v5H2v-5L5 4ZM2 15h20M16 18h1m2 0h1" })
      );
    }
    async function install(ctx) {
      const capability = await ctx.remote.desktopDirectoryPicker.capability();
      if (!capability.ok || capability.value !== "browse") return;
      const style = document.createElement("style");
      style.textContent = style_default;
      document.head.append(style);
      function NewFolder({ path, onCreated, onClose }) {
        useLocale(React);
        const [name, setName] = React.useState(""), [saving, setSaving] = React.useState(false), [error, setError] = React.useState(null);
        const alive = React.useRef(true);
        React.useEffect(() => {
          alive.current = true;
          return () => {
            alive.current = false;
          };
        }, []);
        const create = async (event) => {
          event.preventDefault();
          if (saving || !name.trim()) return;
          setSaving(true);
          setError(null);
          try {
            const target = await ctx.uiWorkspace.createDirectory(path, name);
            if (alive.current) onCreated(target);
          } catch (error2) {
            if (alive.current) {
              setError(error2?.rpcError?.message || error2.message);
              setSaving(false);
            }
          }
        };
        return h(
          Modal,
          { open: true, title: t("\u65B0\u5EFA\u6587\u4EF6\u5939"), closeLabel: t("\u53D6\u6D88"), onClose: () => {
            if (!saving) onClose();
          }, className: "dshDirectory__create" },
          h(
            "form",
            { onSubmit: create, className: "dshDirectory__createForm" },
            h("p", { className: "dshDirectory__createPath", title: path }, path),
            h("input", {
              className: "dshDirectory__input",
              "data-modal-autofocus": "",
              "aria-label": t("\u6587\u4EF6\u5939\u540D\u79F0"),
              value: name,
              onChange: (event) => setName(event.target.value),
              disabled: saving,
              placeholder: t("\u6587\u4EF6\u5939\u540D\u79F0")
            }),
            error && h("div", { role: "alert", className: "dshDirectory__error" }, error),
            h(
              "div",
              { className: "dshDirectory__actions" },
              h(Button, { type: "button", variant: "outline", disabled: saving, onClick: onClose }, t("\u53D6\u6D88")),
              h(Button, { type: "submit", variant: "primary", disabled: saving || !name.trim() }, saving ? t("\u6B63\u5728\u521B\u5EFA\u2026") : t("\u521B\u5EFA"))
            )
          )
        );
      }
      function Browser({ busy, onPicked, onCancel }) {
        useLocale(React);
        const navigation = React.useMemo(() => createNavigation({
          listDirectory: (path2, signal) => ctx.uiWorkspace.listDirectory(path2, signal),
          listRoots: async (signal) => {
            const result = await ctx.remote.desktopDirectoryPicker.roots(signal);
            if (!result.ok) throw Error(result.error.message);
            return result.value;
          }
        }), []);
        const state = React.useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
        const [draft, setDraft] = React.useState(""), [hidden, setHidden] = React.useState(false), [creating, setCreating] = React.useState(false);
        const list = React.useRef(null), crumbs = React.useRef(null), suggestions = React.useId();
        React.useEffect(() => {
          void navigation.visit();
          return () => navigation.dispose();
        }, [navigation]);
        const directory = state.location?.kind === "directory", path = directory ? state.location.path : "";
        React.useEffect(() => {
          setDraft(path);
          if (list.current) {
            list.current.scrollTop = 0;
            if (document.activeElement === document.body) list.current.focus({ preventScroll: true });
          }
          if (crumbs.current) crumbs.current.scrollLeft = crumbs.current.scrollWidth;
        }, [state.location]);
        React.useEffect(() => {
          const trail = crumbs.current;
          const observer = new ResizeObserver(() => {
            trail.scrollLeft = trail.scrollWidth;
          });
          observer.observe(trail);
          return () => observer.disconnect();
        }, []);
        const inert = busy || creating, blocked = inert || state.loading;
        const entries = (state.location?.entries || []).filter((entry) => hidden || !entry.hidden);
        const go = (event) => {
          event.preventDefault();
          if (!blocked && draft.trim()) void navigation.visit(draft.trim());
        };
        const keydown = (event) => {
          if (creating) return;
          let action;
          if (event.altKey && !event.ctrlKey && !event.metaKey) action = { ArrowLeft: navigation.back, ArrowRight: navigation.forward, ArrowUp: navigation.parent }[event.key];
          else if (event.key === "F5") action = navigation.refresh;
          if (action) {
            event.preventDefault();
            event.stopPropagation();
            if (!blocked) void action();
          }
        };
        const tool = (label, Icon, action, disabled) => h(Button, {
          type: "button",
          variant: "ghost",
          className: "dshDirectory__tool",
          title: t(label),
          "aria-label": t(label),
          disabled: blocked || disabled,
          onClick: action
        }, h(Icon, { size: 18 }));
        const crumb = (label, target, current = false) => h("button", {
          type: "button",
          className: "dshDirectory__crumb",
          disabled: blocked,
          title: target === ROOTS ? t("\u6B64\u7535\u8111") : target,
          "aria-current": current ? "location" : void 0,
          onClick: () => navigation.visit(target)
        }, label);
        return h(
          React.Fragment,
          null,
          h(
            Modal,
            {
              open: true,
              headless: true,
              title: t("\u9009\u62E9\u5DE5\u4F5C\u533A\u76EE\u5F55"),
              onClose: () => {
                if (!inert) onCancel();
              },
              className: "dshDirectory",
              onKeyDownCapture: keydown
            },
            h(
              "header",
              { className: "dshDirectory__header" },
              h("h2", null, t("\u9009\u62E9\u5DE5\u4F5C\u533A\u76EE\u5F55")),
              h(
                "div",
                { className: "dshDirectory__toolbar", role: "group", "aria-label": t("\u6587\u4EF6\u5939\u5BFC\u822A") },
                tool("\u540E\u9000", Back, navigation.back, state.index <= 0),
                tool("\u524D\u8FDB", Forward, navigation.forward, state.index >= state.history.length - 1),
                tool("\u4E0A\u4E00\u7EA7", Up, navigation.parent, !directory),
                tool("\u5237\u65B0", Refresh, navigation.refresh, false),
                h(Button, { type: "button", variant: "ghost", disabled: blocked, onClick: () => navigation.visit(ROOTS), icon: h(Drive) }, t("\u6B64\u7535\u8111")),
                h(
                  Button,
                  {
                    type: "button",
                    variant: "ghost",
                    className: "dshDirectory__home",
                    disabled: blocked,
                    title: t("\u4E3B\u76EE\u5F55"),
                    "aria-label": t("\u4E3B\u76EE\u5F55"),
                    icon: h(Folder, { size: 18 }),
                    onClick: () => navigation.visit()
                  },
                  h("span", { className: "dshDirectory__homeText" }, t("\u4E3B\u76EE\u5F55"))
                ),
                h(
                  "form",
                  { onSubmit: go, className: "dshDirectory__path" },
                  h("input", {
                    className: "dshDirectory__input",
                    value: draft,
                    onChange: (event) => setDraft(event.target.value),
                    "aria-label": t("\u6587\u4EF6\u5939\u8DEF\u5F84"),
                    placeholder: t("\u8F93\u5165\u5B8C\u6574\u8DEF\u5F84"),
                    disabled: inert,
                    list: suggestions,
                    spellCheck: false,
                    onKeyDown: (event) => {
                      if (event.key === "Escape" && draft !== path) {
                        event.preventDefault();
                        event.stopPropagation();
                        setDraft(path);
                      }
                    }
                  }),
                  h("datalist", { id: suggestions }, entries.map((entry) => h("option", { key: entry.path, value: entry.path }))),
                  h(Button, { type: "submit", variant: "outline", disabled: blocked || !draft.trim() }, t("\u8F6C\u5230"))
                )
              ),
              h(
                "nav",
                { ref: crumbs, className: "dshDirectory__crumbs", "aria-label": t("\u5F53\u524D\u4F4D\u7F6E") },
                crumb(t("\u6B64\u7535\u8111"), ROOTS, state.location?.kind === "roots"),
                ...(state.location?.crumbs || []).map((entry, index, crumbs2) => h(
                  React.Fragment,
                  { key: entry.path },
                  h("span", { "aria-hidden": true }, "\u203A"),
                  crumb(entry.name, entry.path, index === crumbs2.length - 1)
                ))
              )
            ),
            h(
              "div",
              { ref: list, tabIndex: -1, role: "region", "aria-label": t("\u6587\u4EF6\u5939\u5BFC\u822A"), className: "dshDirectory__list", "aria-busy": state.loading, "data-location": state.location?.path },
              state.error && h("div", { className: "dshDirectory__error", role: "alert" }, state.error),
              h("div", { className: "dshDirectory__status", role: "status" }, state.loading ? t("\u52A0\u8F7D\u4E2D\u2026") : state.location && !entries.length ? directory ? t("\u6CA1\u6709\u53EF\u663E\u793A\u7684\u6587\u4EF6\u5939") : t("\u6CA1\u6709\u53EF\u7528\u7684\u76D8\u7B26") : null),
              entries.map((entry) => h(
                "button",
                {
                  key: entry.path,
                  type: "button",
                  className: "dshDirectory__row",
                  disabled: blocked,
                  title: entry.path,
                  onClick: () => navigation.visit(entry.path)
                },
                h(directory ? Folder : Drive, { size: 18 }),
                h("span", null, entry.name),
                h(Forward, { size: 14 })
              )),
              state.location?.truncated && h("p", { className: "dshDirectory__status" }, t("\u6587\u4EF6\u5939\u8FC7\u591A\uFF0C\u4EC5\u663E\u793A\u5F00\u5934\u90E8\u5206\u3002"))
            ),
            h(
              "footer",
              { className: "dshDirectory__footer" },
              h(Button, { type: "button", variant: "outline", disabled: blocked || !directory, onClick: () => setCreating(true) }, t("\u65B0\u5EFA\u6587\u4EF6\u5939")),
              h("label", { className: "dshDirectory__hidden" }, h("input", { type: "checkbox", checked: hidden, disabled: inert, onChange: (event) => setHidden(event.target.checked) }), t("\u663E\u793A\u9690\u85CF\u6587\u4EF6")),
              h(
                "div",
                { className: "dshDirectory__actions" },
                h(Button, { type: "button", variant: "outline", disabled: inert, onClick: onCancel }, t("\u53D6\u6D88")),
                h(Button, { type: "button", variant: "primary", disabled: blocked || !directory || draft !== path, onClick: () => onPicked(path) }, t("\u6253\u5F00"))
              )
            )
          ),
          creating && h(NewFolder, { path, onClose: () => setCreating(false), onCreated: (target) => {
            setCreating(false);
            void navigation.visit(target);
          } })
        );
      }
      function Flow(props) {
        return props.open ? h(Browser, props) : null;
      }
      const off = ["conversation.hero.workspace.directoryFlow", "sidebar.workspaces.directoryFlow"].map((name) => ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -10 }, Flow)));
      return () => {
        off.reverse().forEach((dispose) => dispose());
        style.remove();
      };
    }
    return { inject: ["slots", "uiWorkspace", "remote"], async apply(ctx) {
      if (window.__TAURI__?.core?.invoke) return;
      const offRemote = await ctx.remote.$mount(contribution);
      const fiber = ctx.inject(["remote.desktopDirectoryPicker"], install);
      return async () => {
        await fiber.dispose();
        await offRemote();
      };
    } };
  } });
})();
