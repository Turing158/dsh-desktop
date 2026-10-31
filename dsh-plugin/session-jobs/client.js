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

  // dsh-plugin/session-jobs/model.mjs
  var CANCELLABLE_STATUSES = ["running", "stopping"];
  function isCancellable(job) {
    return Boolean(job) && CANCELLABLE_STATUSES.includes(job.status);
  }
  function cancellableJobs(rows) {
    return Array.isArray(rows) ? rows.filter(isCancellable) : [];
  }
  function orderCancellable(rows) {
    return [...rows].sort((left, right) => {
      const rank = (job) => job.status === "running" ? 0 : 1;
      return rank(left) - rank(right) || left.startedAt - right.startedAt || String(left.id).localeCompare(String(right.id));
    });
  }
  function liveSummary(rows) {
    let running = 0, stopping = 0;
    for (const job of rows) {
      if (job.status === "running") running += 1;
      else if (job.status === "stopping") stopping += 1;
    }
    return { running, stopping, total: running + stopping };
  }
  function formatDuration(elapsedMs, t2) {
    const total = Math.max(0, Math.floor(elapsedMs / 1e3));
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    const parts = [];
    if (hours > 0) parts.push(t2("{hours}\u5C0F\u65F6", { hours }));
    if (minutes > 0) parts.push(t2("{minutes}\u5206\u949F", { minutes }));
    if (seconds > 0 || parts.length === 0) parts.push(t2("{seconds}\u79D2", { seconds }));
    return parts.join("");
  }
  function triggerLabel(total, t2) {
    return total > 0 ? `${t2("\u540E\u53F0\u4EFB\u52A1")} \xB7 ${t2("{n} \u4E2A\u8FD0\u884C\u4E2D", { n: total })}` : t2("\u540E\u53F0\u4EFB\u52A1");
  }
  function badgeText(total) {
    return total > 9 ? "9+" : String(total);
  }
  function summaryText(counts, t2) {
    if (!counts.total) return t2("\u7A7A\u95F2");
    return counts.stopping > 0 && counts.running === 0 ? t2("{n} \u4E2A\u6B63\u5728\u505C\u6B62", { n: counts.stopping }) : t2("{n} \u4E2A\u8FD0\u884C\u4E2D", { n: counts.running || counts.stopping });
  }

  // dsh-plugin/session-jobs/geometry.mjs
  var CONTROL_SIZE = 28;
  var PANEL_GAP = 6;
  var EDGE = 8;
  var PANEL_WIDTH = 360;
  var PANEL_MIN_WIDTH = 240;
  var painted = (box) => Boolean(box) && box.width > 0 && box.height > 0;
  function seatGeometry(header, corner, tabs) {
    const edge = painted(corner) ? corner.right : painted(tabs) ? tabs.right : header.right - EDGE;
    const right = Math.max(0, Math.round(header.right - edge));
    const top = painted(tabs) ? Math.round(tabs.top - header.top + (tabs.height - CONTROL_SIZE) / 2) : Math.round(header.height - CONTROL_SIZE - EDGE);
    return { right, top: Math.max(0, Math.min(top, Math.round(header.height - CONTROL_SIZE))) };
  }
  function panelGeometry(anchor, size, viewport) {
    const width = Math.min(PANEL_WIDTH, Math.max(PANEL_MIN_WIDTH, viewport.width - EDGE * 2));
    const left = Math.max(EDGE, Math.min(anchor.right - width, viewport.width - width - EDGE));
    const below = anchor.bottom + PANEL_GAP;
    const top = size.height > 0 && below + size.height > viewport.height - EDGE ? Math.max(EDGE, anchor.top - size.height - PANEL_GAP) : below;
    return { left: Math.round(left), top: Math.round(top), width };
  }

  // dsh-plugin/session-jobs/style.css
  var style_default = "/* Session jobs control: the header button and its popup list of live work.\n *\n * The seat is a zero-flow span appended to the session <header>, which is\n * already `position: relative` for this control (see client-entry.mjs). It is\n * absolutely positioned on the tabs row so the button lines up with the\n * shipped \u6253\u5F00\u4FA7\u8FB9\u680F control while leaving that corner seat untouched.\n *\n * Only desktop mode paints any of this: \u539F\u7248 renders neither the seat nor the\n * panel, and the gate below keeps a stale stylesheet harmless if a mode switch\n * races the unmount.\n */\n\nhtml:not([data-dsh-ui='vanilla']) .dshSessionJobs__seat {\n  position: absolute;\n  z-index: 2;\n  display: inline-flex;\n  align-items: center;\n  pointer-events: none;\n}\n\nhtml:not([data-dsh-ui='vanilla']) .dshSessionJobs__seat > * {\n  pointer-events: auto;\n}\n\n.dshSessionJobs__anchor {\n  display: none;\n}\n\n/* The trigger matches the neighbouring header utilities: a 28px ghost surface\n * that only shows its fill on hover, so an idle conversation gains a button\n * without gaining a visual weight it did not ask for. */\n.dshSessionJobs__trigger {\n  position: relative;\n  display: inline-grid;\n  grid-auto-flow: column;\n  align-items: center;\n  justify-content: center;\n  gap: 3px;\n  box-sizing: border-box;\n  min-width: 28px;\n  height: 28px;\n  padding: 0 5px;\n  border: 0;\n  border-radius: var(--dsw-radius-sm, 6px);\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  font: inherit;\n  cursor: pointer;\n  transition: background-color 120ms ease, color 120ms ease;\n}\n\n.dshSessionJobs__trigger:hover,\n.dshSessionJobs__trigger:focus-visible,\n.dshSessionJobs__trigger[aria-expanded='true'] {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-secondary);\n}\n\n/* Work that is actually running is worth a colour, but the button must not\n * read as an alarm: the colour is the dot's count badge, not the glyph. */\n.dshSessionJobs__trigger[data-running='true'] {\n  color: var(--dsw-alias-label-secondary);\n}\n\n.dshSessionJobs__trigger:focus-visible {\n  outline: 2px solid var(--dsw-focus-ring-color, #5686fe);\n  outline-offset: -2px;\n}\n\n.dshSessionJobs__badge {\n  min-width: 15px;\n  height: 15px;\n  padding: 0 3px;\n  border-radius: 8px;\n  background: var(--dsw-alias-state-business-primary, #4176e6);\n  color: var(--dsw-alias-label-primary-foreground, #fff);\n  font-size: 10px;\n  line-height: 15px;\n  font-variant-numeric: tabular-nums;\n  text-align: center;\n}\n\n/* The panel floats above the conversation; `position: fixed` keeps it out of\n * the header's clipping and lets the scroll/resize observer place it from\n * measured rects instead of from a CSS offset chain. */\n.dshSessionJobs__panel {\n  position: fixed;\n  z-index: 100;\n  display: flex;\n  flex-direction: column;\n  box-sizing: border-box;\n  max-height: min(420px, 100vh - 96px);\n  padding: 6px;\n  border: 1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-border-l1));\n  border-radius: var(--dsw-radius-lg, 12px);\n  background: var(--dsw-alias-bg-module-platform, #fff);\n  box-shadow: var(--dsw-elevation-prominent);\n  color: var(--dsw-alias-label-primary);\n  overflow: hidden;\n}\n\n.dshSessionJobs__panel:focus-visible {\n  outline: 2px solid var(--dsw-focus-ring-color, #5686fe);\n  outline-offset: -1px;\n}\n\n.dshSessionJobs__head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 4px 4px 6px 6px;\n}\n\n.dshSessionJobs__title {\n  font-size: 12px;\n  line-height: 18px;\n  font-weight: 500;\n  color: var(--dsw-alias-label-primary);\n}\n\n.dshSessionJobs__summary {\n  flex: 1;\n  min-width: 0;\n  font-size: 11px;\n  line-height: 16px;\n  color: var(--dsw-alias-label-tertiary);\n  font-variant-numeric: tabular-nums;\n}\n\n.dshSessionJobs__close {\n  display: inline-grid;\n  place-items: center;\n  flex: none;\n  width: 22px;\n  height: 22px;\n  padding: 0;\n  border: 0;\n  border-radius: var(--dsw-radius-sm, 6px);\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  cursor: pointer;\n}\n\n.dshSessionJobs__close:hover,\n.dshSessionJobs__close:focus-visible {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.dshSessionJobs__list {\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  min-height: 0;\n  overflow: auto;\n  overscroll-behavior: contain;\n}\n\n.dshSessionJobs__row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  box-sizing: border-box;\n  min-height: 32px;\n  padding: 3px 6px 3px 8px;\n  border-radius: var(--dsw-radius-md, 8px);\n}\n\n.dshSessionJobs__row:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.dshSessionJobs__dot {\n  flex: none;\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  background: var(--dsw-alias-state-idle-primary, #a6a6a6);\n}\n\n.dshSessionJobs__dot[data-status='running'] {\n  background: var(--dsw-alias-state-success-primary, #2f9e63);\n}\n\n.dshSessionJobs__dot[data-status='stopping'] {\n  background: var(--dsw-alias-state-warn-primary, #d69a2f);\n}\n\n.dshSessionJobs__body {\n  display: flex;\n  flex-direction: column;\n  flex: 1;\n  min-width: 0;\n  gap: 1px;\n}\n\n.dshSessionJobs__label {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-primary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.dshSessionJobs__error {\n  font-size: 11px;\n  line-height: 16px;\n  color: var(--dsw-alias-state-error-primary, #d74d64);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n/* Duration and stop share a grid cell, so hovering never shifts the label. */\n.dshSessionJobs__stop {\n  display: inline-grid;\n  grid-template-areas: 'action';\n  place-items: center;\n  flex: none;\n  min-width: 26px;\n  height: 26px;\n  padding: 0;\n  border: 0;\n  border-radius: var(--dsw-radius-sm, 6px);\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  cursor: pointer;\n  transition: background-color 120ms ease, color 120ms ease;\n}\n\n.dshSessionJobs__duration {\n  grid-area: action;\n  justify-self: end;\n  font-size: 11px;\n  line-height: 16px;\n  font-variant-numeric: tabular-nums;\n  white-space: nowrap;\n}\n\n.dshSessionJobs__stopIcon {\n  grid-area: action;\n  justify-self: end;\n  display: inline-grid;\n  place-items: center;\n  width: 26px;\n  height: 26px;\n  border-radius: var(--dsw-radius-sm, 6px);\n  opacity: 0;\n}\n\n.dshSessionJobs__row:is(:hover, :focus-within) .dshSessionJobs__duration,\n.dshSessionJobs__stop[data-state='stopping'] .dshSessionJobs__duration {\n  opacity: 0;\n}\n\n.dshSessionJobs__row:is(:hover, :focus-within) .dshSessionJobs__stopIcon,\n.dshSessionJobs__stop[data-state='stopping'] .dshSessionJobs__stopIcon {\n  opacity: 1;\n}\n\n.dshSessionJobs__row:hover .dshSessionJobs__stop,\n.dshSessionJobs__stop:focus-visible {\n  color: var(--dsw-alias-label-secondary);\n}\n\n.dshSessionJobs__stop:hover:not(:disabled) .dshSessionJobs__stopIcon,\n.dshSessionJobs__stop:focus-visible .dshSessionJobs__stopIcon {\n  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(215, 77, 100, .12));\n  color: var(--dsw-alias-state-error-primary, #d74d64);\n}\n\n.dshSessionJobs__stop:disabled {\n  cursor: default;\n  color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary));\n}\n\n.dshSessionJobs__stop:focus-visible {\n  outline: 2px solid var(--dsw-focus-ring-color, #5686fe);\n  outline-offset: -1px;\n}\n\n.dshSessionJobs__busy {\n  animation: dshSessionJobsSpin 900ms linear infinite;\n}\n\n@keyframes dshSessionJobsSpin {\n  to { transform: rotate(360deg); }\n}\n\n/* Reduced motion and the app's own \u5173\u95ED\u52A8\u6548 preference both still the spinner:\n * the row's \u6B63\u5728\u505C\u6B62 text, not the animation, carries the state. */\n@media (prefers-reduced-motion: reduce) {\n  html:not([data-dsh-desktop-animation='on']) .dshSessionJobs__busy { animation: none; }\n  html:not([data-dsh-desktop-animation='on']) .dshSessionJobs__trigger,\n  html:not([data-dsh-desktop-animation='on']) .dshSessionJobs__stop { transition: none; }\n}\n\nhtml[data-dsh-desktop-animation='off'] .dshSessionJobs__busy { animation: none; }\nhtml[data-dsh-desktop-animation='off'] :is(.dshSessionJobs__trigger, .dshSessionJobs__stop) { transition: none; }\n";

  // dsh-plugin/session-jobs/client-entry.mjs
  var HEADER_SLOT = "conversation.session.header.utilities";
  var CONTROL_ID = "desktop-session-jobs";
  var MODE_ATTRIBUTE = "data-dsh-ui";
  var PANEL_ID = "dsh-session-jobs-panel";
  var FAILED_HINT_MS = 4e3;
  function isVanilla(doc = globalThis.document) {
    return doc?.documentElement?.getAttribute(MODE_ATTRIBUTE) === "vanilla";
  }
  function useVanilla(React, doc) {
    const subscribe = React.useCallback((listener) => {
      doc.addEventListener("dsh-desktop:ui-mode", listener);
      const observer = new MutationObserver(listener);
      observer.observe(doc.documentElement, { attributes: true, attributeFilter: [MODE_ATTRIBUTE] });
      return () => {
        doc.removeEventListener("dsh-desktop:ui-mode", listener);
        observer.disconnect();
      };
    }, [doc]);
    return React.useSyncExternalStore(subscribe, () => isVanilla(doc), () => false);
  }
  function createGlyphs(React) {
    const h = React.createElement;
    const svg = (size, box, props, ...children) => h("svg", {
      width: size,
      height: size,
      viewBox: `0 0 ${box} ${box}`,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.3,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
      ...props
    }, ...children);
    return {
      trigger: () => svg(
        16,
        16,
        {},
        h("rect", { x: 1.7, y: 2.2, width: 12.6, height: 11.6, rx: 2.6 }),
        h("path", { d: "M4.6 5.8 6.9 8.1 4.6 10.4" }),
        h("path", { d: "M8.7 10.5h3" })
      ),
      stop: () => h(
        "svg",
        { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true", focusable: "false" },
        h("rect", { x: 3.7, y: 3.7, width: 6.6, height: 6.6, rx: 1.8, fill: "currentColor" })
      ),
      busy: () => svg(
        14,
        14,
        { className: "dshSessionJobs__busy" },
        h("circle", { cx: 7, cy: 7, r: 4.6, fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeDasharray: "7 22" })
      ),
      close: () => svg(12, 12, {}, h("path", { d: "M2.6 2.6 9.4 9.4M9.4 2.6 2.6 9.4" }))
    };
  }
  function createControl(React, ReactDOM, ctx) {
    const h = React.createElement;
    const Icon = createGlyphs(React);
    function JobsPanel({ triggerRef, rows, counts, now, pending, onStop, onClose }) {
      const panel = React.useRef(null);
      const [box, setBox] = React.useState(null);
      const place = React.useCallback(() => {
        const node = panel.current, target = triggerRef.current;
        if (!node || !target) return;
        const next = panelGeometry(
          target.getBoundingClientRect(),
          { width: node.offsetWidth, height: node.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight }
        );
        setBox((previous) => previous && previous.left === next.left && previous.top === next.top && previous.width === next.width ? previous : next);
      }, [triggerRef]);
      React.useLayoutEffect(() => {
        place();
        const observer = new ResizeObserver(place);
        if (panel.current) observer.observe(panel.current);
        window.addEventListener("resize", place);
        document.addEventListener("scroll", place, true);
        return () => {
          observer.disconnect();
          window.removeEventListener("resize", place);
          document.removeEventListener("scroll", place, true);
        };
      }, [place]);
      React.useEffect(() => {
        panel.current?.focus({ preventScroll: true });
      }, []);
      const closing = (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      };
      return h(
        "div",
        {
          id: PANEL_ID,
          ref: panel,
          role: "dialog",
          "aria-label": t("\u540E\u53F0\u4EFB\u52A1"),
          tabIndex: -1,
          className: "dshSessionJobs__panel",
          "data-dsh-session-jobs": "",
          style: box ? { left: box.left, top: box.top, width: box.width } : { left: 0, top: 0, visibility: "hidden" },
          onKeyDown: (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            onClose(true);
          }
        },
        h(
          "div",
          { className: "dshSessionJobs__head" },
          h("span", { className: "dshSessionJobs__title" }, t("\u540E\u53F0\u4EFB\u52A1")),
          h("span", { className: "dshSessionJobs__summary" }, summaryText(counts, t)),
          h(
            "button",
            { type: "button", className: "dshSessionJobs__close", "aria-label": t("\u5173\u95ED\u9762\u677F"), title: t("\u5173\u95ED\u9762\u677F"), onClick: closing },
            h(Icon.close)
          )
        ),
        h("div", { className: "dshSessionJobs__list", role: "list" }, rows.map((job) => {
          const state = pending[job.id];
          const stopping = job.status === "stopping" || state === "stopping";
          const failed = state === "failed";
          return h(
            "div",
            { key: job.id, role: "listitem", className: "dshSessionJobs__row", "data-status": job.status },
            h("span", { className: "dshSessionJobs__dot", "data-status": job.status, "aria-hidden": "true" }),
            h(
              "span",
              { className: "dshSessionJobs__body" },
              h("span", { className: "dshSessionJobs__label", title: job.label || String(job.id) }, job.label || String(job.id)),
              failed && h("span", { className: "dshSessionJobs__error", role: "alert" }, t("\u505C\u6B62\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5"))
            ),
            h(
              "button",
              {
                type: "button",
                className: "dshSessionJobs__stop",
                "aria-label": t(stopping ? "\u6B63\u5728\u505C\u6B62\u2026" : "\u505C\u6B62") + " " + (job.label || job.id),
                title: t(stopping ? "\u6B63\u5728\u505C\u6B62\u2026" : "\u505C\u6B62"),
                "aria-busy": stopping,
                disabled: job.status !== "running" || stopping,
                "data-state": stopping ? "stopping" : "idle",
                onClick: () => onStop(job)
              },
              h("span", { className: "dshSessionJobs__duration", "aria-hidden": "true" }, formatDuration(now - job.startedAt, t)),
              h("span", { className: "dshSessionJobs__stopIcon", "aria-hidden": "true" }, stopping ? h(Icon.busy) : h(Icon.stop))
            )
          );
        }))
      );
    }
    return function SessionJobsControl({ sessionId }) {
      useLocale(React);
      const doc = globalThis.document;
      const vanilla = useVanilla(React, doc);
      const anchor = React.useRef(null);
      const trigger = React.useRef(null);
      const [seat, setSeat] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [now, setNow] = React.useState(() => Date.now());
      const [pending, setPending] = React.useState({});
      const timers = React.useRef(/* @__PURE__ */ new Set());
      const jobs = ctx.jobs;
      const subscribe = React.useCallback((listener) => jobs.state.subscribe(listener), [jobs]);
      const getSnapshot = React.useCallback(() => jobs.state.getSnapshot(), [jobs]);
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const rows = orderCancellable(cancellableJobs(sessionId ? snapshot.rows?.[sessionId] : void 0));
      const counts = liveSummary(rows);
      const hasJobs = counts.total > 0;
      React.useEffect(() => sessionId ? jobs.watchRows(sessionId) : void 0, [jobs, sessionId]);
      React.useEffect(() => {
        if (vanilla || !hasJobs) setOpen(false);
      }, [vanilla, hasJobs]);
      React.useEffect(() => {
        if (!open || rows.length === 0) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1e3);
        return () => clearInterval(timer);
      }, [open, rows.length]);
      React.useEffect(() => () => {
        for (const timer of timers.current) clearTimeout(timer);
        timers.current.clear();
      }, []);
      React.useEffect(() => {
        setPending((current) => {
          const live = new Set(rows.map((row) => row.id));
          const kept = Object.entries(current).filter(([id]) => live.has(id));
          return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
        });
      }, [rows]);
      React.useLayoutEffect(() => {
        if (vanilla || !hasJobs) return void 0;
        const host = anchor.current?.closest("header");
        if (!host) return void 0;
        const spot = doc.createElement("span");
        spot.className = "dshSessionJobs__seat";
        const hadInline = host.style.position;
        if (!hadInline) host.style.position = "relative";
        host.append(spot);
        setSeat(spot);
        const place = () => {
          const geometry = seatGeometry(
            host.getBoundingClientRect(),
            host.querySelector("[data-conversation-header-corner]")?.getBoundingClientRect(),
            host.querySelector("[data-conversation-tabs]")?.getBoundingClientRect()
          );
          spot.style.right = geometry.right + "px";
          spot.style.top = geometry.top + "px";
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(host);
        const tabs = host.querySelector("[data-conversation-tabs]");
        if (tabs) observer.observe(tabs);
        window.addEventListener("resize", place);
        const mutation = new MutationObserver(place);
        mutation.observe(host, { childList: true, subtree: true });
        return () => {
          mutation.disconnect();
          observer.disconnect();
          window.removeEventListener("resize", place);
          host.style.position = hadInline;
          spot.remove();
          setSeat(null);
        };
      }, [doc, vanilla, hasJobs]);
      React.useEffect(() => {
        if (!open) return void 0;
        const outside = (event) => {
          const panel = doc.getElementById(PANEL_ID);
          if (panel?.contains(event.target) || trigger.current?.contains(event.target) || seat?.contains(event.target)) return;
          setOpen(false);
        };
        const escape = (event) => {
          if (event.key !== "Escape") return;
          setOpen(false);
          trigger.current?.focus({ preventScroll: true });
        };
        doc.addEventListener("pointerdown", outside, true);
        doc.addEventListener("keydown", escape, true);
        return () => {
          doc.removeEventListener("pointerdown", outside, true);
          doc.removeEventListener("keydown", escape, true);
        };
      }, [doc, open, seat]);
      const close = React.useCallback((restore) => {
        setOpen(false);
        if (restore) trigger.current?.focus({ preventScroll: true });
      }, []);
      const stop = React.useCallback((job) => {
        if (!sessionId) return;
        setPending((current) => current[job.id] === "stopping" ? current : { ...current, [job.id]: "stopping" });
        const fail = () => {
          setPending((current) => ({ ...current, [job.id]: "failed" }));
          const timer = setTimeout(() => {
            timers.current.delete(timer);
            setPending((current) => {
              if (current[job.id] !== "failed") return current;
              const next = { ...current };
              delete next[job.id];
              return next;
            });
          }, FAILED_HINT_MS);
          timers.current.add(timer);
        };
        Promise.resolve().then(() => jobs.kill(sessionId, job.id)).then((result) => {
          if (!result?.ok) fail();
        }, fail);
      }, [jobs, sessionId]);
      if (vanilla || !hasJobs) return null;
      const label = triggerLabel(counts.total, t);
      const button = h(
        "button",
        {
          ref: trigger,
          type: "button",
          className: "dshSessionJobs__trigger",
          "data-dsh-session-jobs-trigger": "",
          "aria-label": label,
          title: label,
          "aria-haspopup": "dialog",
          "aria-expanded": open,
          "aria-controls": open ? PANEL_ID : void 0,
          "data-running": counts.total > 0 ? "true" : "false",
          // Taking focus here would drop the composer's selection and a pending paste.
          onMouseDown: (event) => {
            event.preventDefault();
          },
          onClick: () => setOpen((value) => !value)
        },
        h(Icon.trigger),
        counts.total > 0 && h("span", { className: "dshSessionJobs__badge", "aria-hidden": "true" }, badgeText(counts.total))
      );
      return h(
        React.Fragment,
        null,
        h("span", { ref: anchor, className: "dshSessionJobs__anchor", hidden: Boolean(seat) }),
        seat ? ReactDOM.createPortal(button, seat) : button,
        open && seat && ReactDOM.createPortal(h(JobsPanel, {
          triggerRef: trigger,
          rows,
          counts,
          now,
          pending,
          onStop: stop,
          onClose: close
        }), doc.body)
      );
    };
  }
  window.__ModuleLoader__.load({ id: "@dsh-desktop/session-jobs", factory(require2) {
    const React = require2("react"), ReactDOM = require2("react-dom");
    return {
      inject: ["slots", "jobs"],
      apply(ctx) {
        if (!ctx.jobs || !ctx.slots) return void 0;
        const style = document.createElement("style");
        style.dataset.dshSessionJobsStyle = "";
        style.textContent = style_default;
        document.head.append(style);
        const Control = createControl(React, ReactDOM, ctx);
        const off = ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
          name: HEADER_SLOT,
          id: CONTROL_ID,
          order: 2
        }, Control));
        if (window.__DSH_UI_BOOT__?.smoke) window.__DSH_SESSION_JOBS_SMOKE__ = { seatGeometry, panelGeometry, CONTROL_ID };
        return () => {
          off?.();
          style.remove();
        };
      }
    };
  } });
})();
