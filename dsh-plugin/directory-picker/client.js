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
  var pathCodec = { mode: "strict", typeSymbol: ID + "#path", create: () => ({ parse(value) {
    if (value !== void 0 && (typeof value !== "string" || !value || value.length > 32768 || value.includes("\0"))) throw Error("Invalid file path");
    return value;
  } }) };
  var contribution = { package: ID, descriptors: ["capability", "roots", "files", "readFile"].map((method) => ({
    id: "desktopDirectoryPicker/" + method,
    service: "desktopDirectoryPicker",
    namespace: "desktopDirectoryPicker",
    method,
    invocation: { kind: "direct" },
    parameters: ["files", "readFile"].includes(method) ? [{
      name: "path",
      wire: "path",
      source: "json",
      codec: pathCodec,
      // Initial browsing and Home omit the path; reading an attachment requires it.
      ...method === "files" ? { acceptsUndefined: true } : {}
    }] : [],
    cancellation: { parameter: "signal" },
    result: { mode: "src-json" }
  })) };

  // dsh-plugin/directory-picker/navigation.mjs
  var ROOTS = "desktop:roots";
  function createNavigation({ listDirectory, listRoots }) {
    let state = { location: null, history: [], index: -1, loading: false, error: null };
    let generation = 0, controller, lastRequest;
    const listeners = /* @__PURE__ */ new Set();
    const update = (changes) => {
      state = { ...state, ...changes };
      for (const listener of listeners) listener();
    };
    async function visit(target, { index, replace = false } = {}) {
      lastRequest = { target, options: { index, replace } };
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
      retry: () => visit(lastRequest?.target, lastRequest?.options),
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
  var style_default = '.dshDirectory.dshDirectory {\n  width: min(720px, 100%); height: min(560px, calc(100dvh - 32px)); min-height: 0;\n  padding: 0; gap: 0; overflow: hidden;\n}\n.dshDirectory__header { flex: none; padding: 20px 24px 12px; border-bottom: 1px solid var(--dsw-alias-border-l3); }\n.dshDirectory__header h2 { margin: 0 0 12px; font-size: 16px; font-weight: 510; color: var(--dsw-alias-label-primary); }\n.dshDirectory__toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 4px; }\n.dshDirectory__toolbar > button { flex: none; padding-inline: 10px; white-space: nowrap; }\n.dshDirectory__tool { width: 36px; padding: 0 !important; flex: none; }\n.dshDirectory__path { display: flex; align-items: center; gap: 8px; flex: 1 1 280px; min-width: min(280px, 100%); }\n.dshDirectory__path > input { flex: 1; }\n.dshDirectory__path > button { flex: none; white-space: nowrap; }\n.dshDirectory__input { box-sizing: border-box; width: 100%; min-width: 0; height: 36px; border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 6px 10px; }\n.dshDirectory__input::placeholder { color: var(--dsw-alias-label-tertiary); }\n.dshDirectory__input:focus-visible, .dshDirectory button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }\n.dshDirectory__crumbs { display: flex; align-items: center; gap: 6px; overflow-x: auto; min-height: 28px; margin-top: 6px; color: var(--dsw-alias-label-tertiary); }\n.dshDirectory__crumb { flex: none; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0;\n  background: transparent; color: var(--dsw-alias-label-secondary); padding: 4px 2px; font: inherit; font-size: 12px; cursor: pointer; }\n.dshDirectory__crumb[aria-current] { color: var(--dsw-alias-label-primary); }\n.dshDirectory__list { flex: 1 1 0; min-height: 0; overflow: auto; padding: 12px 20px; }\n.dshDirectory__list:focus { outline: none; }\n.dshDirectory__row { display: flex; align-items: center; gap: 8px; min-height: 34px; width: 100%; padding: 6px; text-align: left;\n  border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; font-size: 13px; }\n.dshDirectory__row svg { flex: none; color: var(--dsw-alias-label-secondary); }\n.dshDirectory__row span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.dshDirectory__row:enabled:hover, .dshDirectory__crumb:enabled:hover { background: var(--dsw-alias-interactive-bg-hover); }\n.dshDirectory__row[aria-pressed="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-state-business-primary); }\n.dshDirectory__row .dshDirectory__check { flex: none; width: 18px; height: 18px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 4px; text-align: center; }\n.dshDirectory button:disabled { cursor: default; opacity: .45; }\n.dshDirectory__error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; font-size: 13px; margin: 8px 0; }\n.dshDirectory__placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center;\n  box-sizing: border-box; min-height: 100%; padding: 20px 12px; gap: 16px; text-align: center; }\n.dshDirectory__placeholderCopy { width: min(440px, 100%); min-width: 0; }\n.dshDirectory__placeholderIcon { display: flex; align-items: center; justify-content: center; width: 56px; height: 56px;\n  margin: 0 auto 16px; border-radius: 16px; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }\n.dshDirectory__placeholderTitle { margin: 0; font-size: 15px; font-weight: 510; line-height: 1.5; color: var(--dsw-alias-label-primary); }\n.dshDirectory__placeholderHint { margin: 6px 0 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }\n.dshDirectory__reason { margin-top: 16px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; text-align: left; }\n.dshDirectory__reasonLabel { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }\n.dshDirectory__reason .dshDirectory__error { margin: 4px 0 0; line-height: 1.6; white-space: pre-wrap; }\n.dshDirectory__placeholderActions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }\n.dshDirectory__status { color: var(--dsw-alias-label-secondary); font-size: 13px; }\n.dshDirectory__status:not(:empty) { padding: 8px 6px; }\n.dshDirectory__footer { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; flex: none; padding: 16px 24px; border-top: 1px solid var(--dsw-alias-border-l3); }\n.dshDirectory__hidden { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--dsw-alias-label-secondary); cursor: pointer; }\n.dshDirectory__hidden input { accent-color: var(--dsw-alias-state-business-primary); }\n.dshDirectory__actions { display: flex; justify-content: flex-end; gap: 8px; margin-left: auto; }\n.dshDirectory__actions button { min-width: 64px; }\n.dshDirectory__create.dshDirectory__create { width: min(380px, 100%); }\n.dshDirectory__createForm { display: flex; flex-direction: column; gap: 16px; }\n.dshDirectory__createPath { font-size: 13px; color: var(--dsw-alias-label-secondary); margin: 0; overflow-wrap: anywhere; }\n@media (max-width: 480px) {\n  .dshDirectory__toolbar > .dshDirectory__home { width: 36px; padding: 0; }\n  .dshDirectory__homeText { display: none; }\n  .dshDirectory__header { padding: 16px 16px 8px; }\n  .dshDirectory__list { padding: 8px 12px; }\n  .dshDirectory__footer { padding: 12px 16px; gap: 10px; }\n  .dshDirectory__footer .dshDirectory__actions { width: 100%; }\n  .dshDirectory__row { min-height: 40px; }\n  .dshDirectory__placeholder { padding: 16px 4px; }\n  .dshDirectory__placeholderActions > button { min-height: 44px; }\n}\n';

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
    function FileIcon() {
      return h(
        "svg",
        { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true },
        h("path", { d: "M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 13h8M8 17h8" })
      );
    }
    function ErrorPlaceholder({ error, reading, busy, onRetry, onChoose }) {
      const denied = /\b(EACCES|EPERM)\b|permission denied|access (?:is )?denied|operation not permitted|权限不足|拒绝访问/i.test(error);
      const missing = /\bENOENT\b|no such file or directory/i.test(error);
      const title = denied ? "\u8BBF\u95EE\u6743\u9650\u4E0D\u8DB3" : missing ? reading ? "\u9644\u4EF6\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u79FB\u52A8" : "\u6587\u4EF6\u5939\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u79FB\u52A8" : reading ? "\u65E0\u6CD5\u8BFB\u53D6\u9644\u4EF6" : "\u65E0\u6CD5\u52A0\u8F7D\u6B64\u4F4D\u7F6E";
      return h(
        "div",
        { className: "dshDirectory__placeholder" },
        h(
          "div",
          { className: "dshDirectory__placeholderCopy", role: "alert" },
          h("div", { className: "dshDirectory__placeholderIcon", "aria-hidden": true }, h(Folder, { size: 32 })),
          h("h3", { className: "dshDirectory__placeholderTitle" }, t(title)),
          h("p", { className: "dshDirectory__placeholderHint" }, t(denied ? "\u8BF7\u786E\u8BA4\u8BBF\u95EE\u6743\u9650\uFF0C\u6216\u9009\u62E9\u5176\u4ED6\u4F4D\u7F6E\u3002" : reading ? "\u8BF7\u91CD\u65B0\u9009\u62E9\u6587\u4EF6\uFF0C\u6216\u7A0D\u540E\u91CD\u8BD5\u3002" : "\u8BF7\u9009\u62E9\u5176\u4ED6\u4F4D\u7F6E\uFF0C\u6216\u7A0D\u540E\u91CD\u8BD5\u3002")),
          h(
            "div",
            { className: "dshDirectory__reason" },
            h("p", { className: "dshDirectory__reasonLabel" }, t("\u9519\u8BEF\u539F\u56E0")),
            h("p", { className: "dshDirectory__error" }, error)
          )
        ),
        h(
          "div",
          { className: "dshDirectory__placeholderActions" },
          h(Button, { type: "button", variant: "outline", disabled: busy, onClick: onRetry }, t("\u91CD\u8BD5")),
          onChoose && h(Button, { type: "button", variant: "ghost", disabled: busy, onClick: onChoose }, t("\u91CD\u65B0\u9009\u62E9"))
        )
      );
    }
    function registerFlow(ctx, Flow) {
      const off = ["conversation.hero.workspace.directoryFlow", "sidebar.workspaces.directoryFlow"].map((name) => ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -10 }, Flow)));
      return () => {
        off.reverse().forEach((dispose) => dispose());
      };
    }
    function NativeFlow(props) {
      const owner = React.useRef(props), request = React.useRef(null), alive = React.useRef(true);
      owner.current = props;
      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);
      React.useEffect(() => {
        if (!props.open) {
          request.current = null;
          return;
        }
        if (props.busy || request.current) return;
        const current = {};
        request.current = current;
        const active = () => alive.current && owner.current.open && request.current === current;
        Promise.resolve().then(() => window.__TAURI__.core.invoke("pick_workspace_directory")).then((path) => {
          if (!active()) return;
          if (path === null) owner.current.onCancel();
          else owner.current.onPicked(path);
        }, (error) => {
          if (active()) owner.current.onError(error?.message || String(error));
        });
      }, [props.open, props.busy]);
      return null;
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
      const remoteValue = async (promise) => {
        const result = await promise;
        if (!result.ok) throw Error(result.error.message);
        return result.value;
      };
      function Browser({ busy, onPicked, onCancel, files = false, onLocal }) {
        useLocale(React);
        const navigation = React.useMemo(() => createNavigation({
          listDirectory: (path2, signal) => files ? remoteValue(ctx.remote.desktopDirectoryPicker.files(path2, signal)) : ctx.uiWorkspace.listDirectory(path2, signal),
          listRoots: async (signal) => {
            const result = await ctx.remote.desktopDirectoryPicker.roots(signal);
            if (!result.ok) throw Error(result.error.message);
            return result.value;
          }
        }), []);
        const state = React.useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
        const [draft, setDraft] = React.useState(""), [hidden, setHidden] = React.useState(false), [creating, setCreating] = React.useState(false);
        const [selected, setSelected] = React.useState([]), [picking, setPicking] = React.useState(false), [pickError, setPickError] = React.useState(null);
        const alive = React.useRef(true);
        React.useEffect(() => {
          alive.current = true;
          return () => {
            alive.current = false;
          };
        }, []);
        const list = React.useRef(null), crumbs = React.useRef(null), suggestions = React.useId();
        React.useEffect(() => {
          void navigation.visit();
          return () => navigation.dispose();
        }, [navigation]);
        React.useEffect(() => {
          if (state.loading) {
            setSelected([]);
            setPickError(null);
          }
        }, [state.loading]);
        const directory = state.location?.kind === "directory", path = directory ? state.location.path : "";
        React.useEffect(() => {
          setDraft(path);
          setSelected([]);
          setPickError(null);
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
        const inert = busy || creating, blocked = inert || picking || state.loading;
        const error = state.loading ? null : state.error || pickError;
        React.useEffect(() => {
          if (error && document.activeElement === document.body) list.current?.focus({ preventScroll: true });
        }, [error]);
        const entries = (state.location?.entries || []).filter((entry) => hidden || !entry.hidden);
        const title = files ? t("\u9009\u62E9\u9644\u4EF6") : t("\u9009\u62E9\u5DE5\u4F5C\u533A\u76EE\u5F55");
        const pick = async () => {
          if (blocked || state.error || files && !selected.length) return;
          setPicking(true);
          setPickError(null);
          try {
            await onPicked(files ? selected : path);
          } catch (error2) {
            if (alive.current) setPickError(error2?.message || String(error2));
          } finally {
            if (alive.current) setPicking(false);
          }
        };
        const toggle = (target) => setSelected((current) => current.includes(target) ? current.filter((path2) => path2 !== target) : [...current, target]);
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
              title,
              onClose: () => {
                if (!inert) onCancel();
              },
              className: "dshDirectory",
              onKeyDownCapture: keydown
            },
            h(
              "header",
              { className: "dshDirectory__header" },
              h("h2", null, title),
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
                    disabled: inert || picking,
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
                  h("datalist", { id: suggestions }, entries.filter((entry) => !files || entry.directory || !directory).map((entry) => h("option", { key: entry.path, value: entry.path }))),
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
              error ? h(ErrorPlaceholder, {
                error,
                reading: !state.error && !!pickError,
                busy: blocked,
                onRetry: state.error ? navigation.retry : pick,
                onChoose: !state.error && pickError ? () => setPickError(null) : void 0
              }) : h(
                React.Fragment,
                null,
                h("div", { className: "dshDirectory__status", role: "status" }, state.loading ? t("\u52A0\u8F7D\u4E2D\u2026") : state.location && !entries.length ? directory ? t(files ? "\u6CA1\u6709\u53EF\u663E\u793A\u7684\u6587\u4EF6" : "\u6CA1\u6709\u53EF\u663E\u793A\u7684\u6587\u4EF6\u5939") : t("\u6CA1\u6709\u53EF\u7528\u7684\u76D8\u7B26") : null),
                entries.map((entry) => h(
                  "button",
                  {
                    key: entry.path,
                    type: "button",
                    className: "dshDirectory__row",
                    disabled: blocked,
                    title: entry.path,
                    "aria-pressed": files && directory && !entry.directory ? selected.includes(entry.path) : void 0,
                    onClick: () => files && directory && !entry.directory ? toggle(entry.path) : navigation.visit(entry.path)
                  },
                  h(!directory ? Drive : files && !entry.directory ? FileIcon : Folder, { size: 18 }),
                  h("span", null, entry.name),
                  files && directory && !entry.directory ? h("span", { className: "dshDirectory__check", "aria-hidden": true }, selected.includes(entry.path) ? "\u2713" : "") : h(Forward, { size: 14 })
                )),
                state.location?.truncated && h("p", { className: "dshDirectory__status" }, t(files ? "\u6587\u4EF6\u8FC7\u591A\uFF0C\u4EC5\u663E\u793A\u5F00\u5934\u90E8\u5206\u3002" : "\u6587\u4EF6\u5939\u8FC7\u591A\uFF0C\u4EC5\u663E\u793A\u5F00\u5934\u90E8\u5206\u3002"))
              )
            ),
            h(
              "footer",
              { className: "dshDirectory__footer" },
              files ? h(Button, { type: "button", variant: "outline", disabled: blocked, onClick: onLocal }, t("\u4ECE\u6B64\u8BBE\u5907\u9009\u62E9")) : h(Button, { type: "button", variant: "outline", disabled: blocked || !!error || !directory, onClick: () => setCreating(true) }, t("\u65B0\u5EFA\u6587\u4EF6\u5939")),
              h("label", { className: "dshDirectory__hidden" }, h("input", {
                type: "checkbox",
                checked: hidden,
                disabled: inert || picking || !!error,
                onChange: (event) => {
                  setHidden(event.target.checked);
                  setSelected([]);
                }
              }), t("\u663E\u793A\u9690\u85CF\u6587\u4EF6")),
              files && h("span", { className: "dshDirectory__status", role: "status" }, t("\u5DF2\u9009\u62E9 {count} \u4E2A\u6587\u4EF6", { count: selected.length })),
              h(
                "div",
                { className: "dshDirectory__actions" },
                h(Button, { type: "button", variant: "outline", disabled: inert, onClick: onCancel }, t("\u53D6\u6D88")),
                h(
                  Button,
                  { type: "button", variant: "primary", disabled: blocked || !!error || !directory || draft !== path || files && !selected.length, onClick: pick },
                  picking && files ? t("\u8BFB\u53D6\u4E2D\u2026") : t(files ? "\u6DFB\u52A0\u9644\u4EF6" : "\u6253\u5F00")
                )
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
      function AttachmentFlow({ sessionId }) {
        const anchor = React.useRef(null), input = React.useRef(null), request = React.useRef(null), local = React.useRef(false);
        const [open, setOpen] = React.useState(false);
        const cancel = () => {
          request.current?.abort();
          request.current = null;
          setOpen(false);
        };
        React.useEffect(() => {
          const element = anchor.current?.closest("[data-composer-card]")?.querySelector('input[type="file"]');
          input.current = element;
          const show = (event) => {
            if (local.current || element.disabled) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          };
          element?.addEventListener("click", show);
          return () => {
            element?.removeEventListener("click", show);
            request.current?.abort();
            request.current = null;
            input.current = null;
          };
        }, []);
        const pick = async (paths) => {
          const controller = new AbortController();
          request.current = controller;
          const element = input.current, transfer = new DataTransfer();
          for (const path of paths) {
            const file = await remoteValue(ctx.remote.desktopDirectoryPicker.readFile(path, controller.signal));
            controller.signal.throwIfAborted();
            const binary = atob(file.data), bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
            transfer.items.add(new File([bytes], file.name, { type: file.type, lastModified: file.lastModified }));
          }
          controller.signal.throwIfAborted();
          if (!element?.isConnected || element !== input.current || element.disabled) return;
          element.files = transfer.files;
          element.dispatchEvent(new Event("change", { bubbles: true }));
          cancel();
        };
        return h(
          React.Fragment,
          null,
          h("span", { ref: anchor, hidden: true, "data-dsh-attachment-picker": sessionId }),
          open && h(Browser, { files: true, onPicked: pick, onCancel: cancel, onLocal: () => {
            cancel();
            local.current = true;
            try {
              input.current?.click();
            } finally {
              local.current = false;
            }
          } })
        );
      }
      const off = registerFlow(ctx, Flow);
      const offAttachments = ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register(
        { name: "conversation.input.overlay", id: ID },
        (props) => h(AttachmentFlow, { key: props.sessionId, sessionId: props.sessionId })
      ));
      return () => {
        offAttachments();
        off();
        style.remove();
      };
    }
    return { inject: ["slots", "uiWorkspace", "remote"], async apply(ctx) {
      if (window.__TAURI__?.core?.invoke) return registerFlow(ctx, NativeFlow);
      const offRemote = await ctx.remote.$mount(contribution);
      const fiber = ctx.inject(["remote.desktopDirectoryPicker"], install);
      return async () => {
        await fiber.dispose();
        await offRemote();
      };
    } };
  } });
})();
