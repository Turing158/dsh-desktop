(() => {
  // dsh-plugin/account-popover/model.mjs
  function formatBalance(amount, currency = "CNY") {
    const match = String(amount).match(/^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (!match) return null;
    const exponent = Number(match[4] || 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1e3) return null;
    const digits = match[2] + (match[3] || "");
    const point = match[2].length + exponent;
    const integer = (point <= 0 ? "0" : digits.slice(0, point).padEnd(point, "0")).replace(/^0+(?=\d)/, "");
    const fraction = point < 0 ? "0".repeat(-point) + digits : digits.slice(point);
    const nonzero = /[1-9]/.test(integer + fraction);
    const negative = match[1] === "-" && nonzero;
    const subcent = integer === "0" && !/[1-9]/.test(fraction.slice(0, 2)) && nonzero;
    let cents = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
    if (subcent) cents = 1n;
    else if (negative && Number(fraction[2] || 0) >= 5) cents += 1n;
    const number = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + (cents % 100n).toString().padStart(2, "0");
    const symbol = currency === "CNY" ? "\xA5" : currency === "USD" ? "$" : currency;
    const prefix = negative ? "-" : subcent ? "<" : "";
    return { prefix, symbol, number, text: prefix + symbol + number };
  }
  function balanceRows(details, bonus = false) {
    const balance = details?.balance;
    if (balance?.status !== "ready") return null;
    const wallets = bonus ? balance.bonusWallets : balance.value;
    if (!Array.isArray(wallets)) return null;
    if (bonus && !wallets.length) return [{ currency: balance.value?.[0]?.currency || "CNY", balance: "0" }];
    return wallets.length ? wallets : null;
  }
  function platformHref(view, page) {
    const value = page === "top-up" ? view?.links?.topUpUrl : view?.links?.usageUrl;
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) ? url.href : void 0;
    } catch {
      return void 0;
    }
  }

  // dsh-plugin/account-popover/icons.mjs
  var paths = [
    "M3.9961 1.40039C3.37842 1.40039 2.96028 1.40039 2.63867 1.42871C2.32631 1.45627 2.17171 1.50666 2.06641 1.56543C1.85606 1.68288 1.68189 1.85605 1.56446 2.06641C1.50569 2.17173 1.45625 2.32627 1.42871 2.63867C1.40036 2.9603 1.39942 3.37827 1.39942 3.9961L1.39942 9.5752C1.39942 10.193 1.40036 10.611 1.42871 10.9326C1.45625 11.245 1.50569 11.3996 1.56445 11.5049C1.68188 11.7153 1.85605 11.8884 2.06641 12.0059C2.17171 12.0646 2.32631 12.115 2.63867 12.1426C2.96028 12.1709 3.37842 12.1709 3.9961 12.1709V13.5713C3.4033 13.5713 2.91297 13.5721 2.51563 13.5371C2.10906 13.5013 1.73277 13.4233 1.38379 13.2285C0.946838 12.9845 0.585697 12.6235 0.341799 12.1865C0.14725 11.8377 0.0700118 11.4621 0.0341815 11.0557C-0.000847399 10.6583 1.58129e-06 10.1681 1.85029e-06 9.5752L2.09416e-06 3.9961C1.83027e-06 3.40325 -0.000846367 2.91297 0.0341818 2.51563C0.0700164 2.10924 0.147239 1.73362 0.341799 1.38477C0.585703 0.947758 0.946825 0.586744 1.38379 0.342775C1.73277 0.148001 2.10906 0.0700381 2.51563 0.0341813C2.91297 -0.000823893 3.40331 1.37805e-06 3.9961 1.71712e-06L3.9961 1.40039Z",
    "M13.6426 6.51953C13.6705 6.6957 13.6705 6.8756 13.6426 7.05176C13.5902 7.38188 13.4302 7.64112 13.2539 7.86035C13.0857 8.06937 12.8546 8.29971 12.6006 8.55371L9.3086 11.8447L8.31836 10.8545L11.6104 7.56348C11.637 7.53681 11.6628 7.51104 11.6875 7.48633H3.74317V6.08594H11.6885C11.6635 6.06088 11.6374 6.03487 11.6104 6.00781L8.31836 2.7168L9.3086 1.72656L12.6006 5.01758C12.8547 5.27169 13.0857 5.50185 13.2539 5.71094C13.4303 5.93018 13.5902 6.18939 13.6426 6.51953Z"
  ];
  function createLogoutIcon(React) {
    return function LogoutIcon({ size = 14 }) {
      return React.createElement(
        "svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        React.createElement(
          "svg",
          { x: 1.168, y: 1.214, width: 13.664, height: 13.571, viewBox: "0 0 14 14", fill: "currentColor", stroke: "none" },
          paths.map((d, key) => React.createElement("path", { key, d }))
        )
      );
    };
  }

  // dsh-plugin/account-popover/motion.mjs
  function createPopoverMotion(doc, onHidden) {
    const win = doc.defaultView;
    const root = doc.documentElement;
    const media = win.matchMedia?.("(prefers-reduced-motion: reduce)");
    let panel = null, animation = null, open = false, disposed = false;
    const active = () => root.getAttribute("data-dsh-ui") !== "vanilla" && root.getAttribute("data-dsh-desktop-animation") !== "off" && (root.getAttribute("data-dsh-desktop-animation") === "on" || !media?.matches);
    function cancel() {
      if (!animation) return;
      animation.onfinish = null;
      animation.cancel();
      animation = null;
    }
    function settle() {
      if (animation) {
        animation.onfinish = null;
        animation.finish();
      }
      if (open) cancel();
      else onHidden();
    }
    const preferenceChanged = () => {
      if (!active()) settle();
    };
    const observer = new win.MutationObserver(preferenceChanged);
    observer.observe(root, { attributes: true, attributeFilter: ["data-dsh-ui", "data-dsh-desktop-animation"] });
    media?.addEventListener?.("change", preferenceChanged);
    return {
      update(nextOpen, nextPanel) {
        if (disposed || nextOpen === open && nextPanel === panel) return;
        const continuing = panel === nextPanel && animation;
        const current = nextPanel && win.getComputedStyle(nextPanel);
        const from = continuing || !nextOpen ? { opacity: current?.opacity || "1", transform: current?.transform || "none" } : { opacity: 0, transform: "translateY(6px)" };
        cancel();
        open = nextOpen;
        panel = nextPanel;
        if (!panel || !active() || typeof panel.animate !== "function") {
          settle();
          return;
        }
        const to = open ? { opacity: 1, transform: "none" } : { opacity: 0, transform: "translateY(6px)" };
        animation = panel.animate([from, to], {
          duration: open ? 180 : 160,
          easing: open ? "cubic-bezier(.2, .8, .2, 1)" : "ease-in",
          fill: "both"
        });
        animation.onfinish = settle;
      },
      dispose() {
        disposed = true;
        cancel();
        panel = null;
        observer.disconnect();
        media?.removeEventListener?.("change", preferenceChanged);
      }
    };
  }

  // dsh-plugin/account-popover/update-badge-motion.mjs
  function createBadgeMotion(doc) {
    const win = doc.defaultView, root = doc.documentElement;
    const media = win.matchMedia?.("(prefers-reduced-motion: reduce)");
    const active = () => root.getAttribute("data-dsh-ui") !== "vanilla" && root.getAttribute("data-dsh-desktop-animation") !== "off" && (root.getAttribute("data-dsh-desktop-animation") === "on" || !media?.matches);
    let previous = null, animations = [], ghost = null, disposed = false;
    function cancel() {
      for (const animation of animations) {
        animation.onfinish = null;
        animation.cancel();
      }
      animations = [];
      ghost?.replaceChildren();
      ghost = null;
    }
    const preferenceChanged = () => {
      if (!active()) cancel();
    };
    const observer = new win.MutationObserver(preferenceChanged);
    observer.observe(root, { attributes: true, attributeFilter: ["data-dsh-ui", "data-dsh-desktop-animation"] });
    media?.addEventListener?.("change", preferenceChanged);
    return {
      update(key, pill, content, outgoing) {
        if (disposed || previous?.key === key && previous.pill === pill) return;
        const continuing = previous?.pill === pill && animations.length > 0;
        const currentWidth = continuing ? win.getComputedStyle(pill).width : previous?.width;
        const current = continuing ? win.getComputedStyle(content) : null;
        const from = { opacity: current?.opacity || 0, transform: current?.transform || "translateY(3px)" };
        const outgoingFrom = current ? { opacity: current.opacity, transform: current.transform } : { opacity: 1, transform: "none" };
        cancel();
        if (!pill || !content) {
          previous = null;
          return;
        }
        const width = win.getComputedStyle(pill).width;
        const snapshot = { key, pill, width, content: content.cloneNode(true) };
        if (active() && typeof content.animate === "function") {
          const options = { duration: 180, easing: "cubic-bezier(.2, .8, .2, 1)" };
          if (previous?.pill === pill && outgoing) {
            ghost = outgoing;
            ghost.replaceChildren(previous.content);
            animations.push(ghost.animate([
              outgoingFrom,
              { opacity: 0, transform: "translateY(-3px)" }
            ], { ...options, fill: "forwards" }));
            if (currentWidth !== width) animations.push(pill.animate([{ width: currentWidth }, { width }], options));
          }
          const entering = content.animate([from, { opacity: 1, transform: "none" }], options);
          animations.push(entering);
          entering.onfinish = cancel;
        }
        previous = snapshot;
      },
      dispose() {
        disposed = true;
        cancel();
        previous = null;
        observer.disconnect();
        media?.removeEventListener?.("change", preferenceChanged);
      }
    };
  }

  // dsh-plugin/account-popover/update-badge.mjs
  function createUpdateBadge(React, ui) {
    const h = React.createElement;
    return function UpdateBadge({ wide }) {
      window.__DSH_I18N__?.use(React);
      const t = (text2, values) => window.__DSH_I18N__?.t(text2, values) ?? text2.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match);
      const read = () => window.__DSH_DSH_UPDATE__?.getSnapshot() ?? null;
      const [update, setUpdate] = React.useState(read);
      const pill = React.useRef(null), content = React.useRef(null), outgoing = React.useRef(null), motion = React.useRef(null);
      React.useLayoutEffect(() => {
        motion.current = createBadgeMotion(document);
        return () => {
          motion.current.dispose();
          motion.current = null;
        };
      }, []);
      React.useEffect(() => {
        const sync = () => setUpdate(read());
        document.addEventListener("dsh-desktop:dsh-update", sync);
        sync();
        return () => document.removeEventListener("dsh-desktop:dsh-update", sync);
      }, []);
      const available = Boolean(update?.versions?.stableUpdateAvailable);
      const waiting = update?.busy === "waiting";
      const installing = Boolean(update?.busy && !["waiting", "check"].includes(update.busy));
      const busy = waiting || installing;
      const failed = Boolean(update?.error);
      const state = waiting ? "waiting" : installing ? "installing" : failed ? "error" : "available";
      const text = waiting ? t("\u7B49\u5F85\u4E2D") : installing ? t("\u66F4\u65B0\u4E2D") : failed ? t("\u91CD\u8BD5") : t("\u65B0\u7248\u672C");
      const contentKey = JSON.stringify([available, state, Boolean(wide), wide ? text : ""]);
      React.useLayoutEffect(() => {
        motion.current.update(contentKey, pill.current, content.current, outgoing.current);
      }, [contentKey]);
      if (!available) return null;
      const label = waiting ? t("\u7B49\u5F85\u4F1A\u8BDD\u7ED3\u675F\u540E\u66F4\u65B0\u2026") : installing ? t("\u6B63\u5728\u66F4\u65B0 dsh\u2026") : failed ? t("\u66F4\u65B0\u5931\u8D25\uFF0C\u70B9\u51FB\u67E5\u770B\u5E76\u91CD\u8BD5") : t("\u66F4\u65B0\u5230 dsh \u7A33\u5B9A\u7248 {version}", { version: update.versions.latest });
      const button = h("button", {
        type: "button",
        className: "dshUpdateBadge",
        "data-state": state,
        "data-compact": !wide,
        "aria-label": label,
        "aria-busy": busy,
        disabled: installing || update.busy === "check",
        title: ui.Tooltip ? void 0 : label,
        onClick: () => {
          const service = window.__DSH_DSH_UPDATE__;
          if (waiting || failed) service?.show();
          else void service?.installStable();
        }
      }, h(
        "span",
        { ref: pill, className: "dshUpdateBadge__pill" },
        h(
          "span",
          { ref: content, className: "dshUpdateBadge__content" },
          busy ? h("span", { className: "dshUpdateBadge__spinner", "aria-hidden": true }) : h(
            "svg",
            { width: 11, height: 11, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
            h("path", { d: failed ? "M8 3v6m0 3v.1" : "M8 12V3m-4 4 4-4 4 4", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" })
          ),
          wide && h("span", null, text)
        ),
        h("span", { ref: outgoing, className: "dshUpdateBadge__ghost", "aria-hidden": true })
      ));
      return h(
        "span",
        { className: "dshUpdateBadge__anchor" },
        ui.Tooltip ? h(ui.Tooltip, { label, portal: true, side: "top", delayMs: 250 }, button) : button,
        h("span", { className: "dshUpdateBadge__status", role: "status", "aria-live": "polite" }, label)
      );
    };
  }

  // dsh-plugin/account-popover/view.mjs
  function createAccountLauncher(React, ReactDOM, ui, Original) {
    const h = React.createElement;
    const LogoutIcon = createLogoutIcon(React);
    const UpdateBadge = createUpdateBadge(React, ui);
    function AccountLauncher(props) {
      if (typeof props.useAccount !== "function" || typeof props.contactUs !== "function" || typeof props.signOut !== "function" || typeof props.hasRunningAccountTasks !== "function") {
        return h(
          "div",
          { className: "dshAccountLauncher", "data-collapsed": !props.wide },
          h("div", { className: "dshAccountLauncher__native" }, h(Original, props)),
          h(UpdateBadge, { wide: props.wide })
        );
      }
      return h(EnhancedLauncher, props);
    }
    function EnhancedLauncher(props) {
      const { t } = props;
      const account = props.useAccount((value) => value);
      const signedIn = account.view?.status === "credential-stored";
      const native = React.useRef(null), panel = React.useRef(null), releasePage = React.useRef(null);
      const alive = React.useRef(true), currentSignedIn = React.useRef(signedIn), pending = React.useRef(false);
      currentSignedIn.current = signedIn;
      const [open, setOpen] = React.useState(false), [position, setPosition] = React.useState(null);
      const [present, setPresent] = React.useState(false);
      const motion = React.useRef(null);
      const [checking, setChecking] = React.useState(false), [impact, setImpact] = React.useState(void 0);
      const [busy, setBusy] = React.useState(false), [failed, setFailed] = React.useState(false);
      const [actionFailed, setActionFailed] = React.useState(false);
      const id = React.useId();
      const getTrigger = () => native.current?.querySelector("button[aria-haspopup]");
      const close = (restore = false) => {
        setOpen(false);
        if (restore) getTrigger()?.focus({ preventScroll: true });
      };
      React.useLayoutEffect(() => {
        motion.current = createPopoverMotion(document, () => setPresent(false));
        return () => {
          motion.current.dispose();
          motion.current = null;
        };
      }, []);
      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
          releasePage.current?.();
          releasePage.current = null;
        };
      }, []);
      React.useEffect(() => {
        if (signedIn) return;
        pending.current = false;
        setOpen(false);
        setPresent(false);
        setImpact(void 0);
        setActionFailed(false);
        setChecking(false);
        setBusy(false);
        releasePage.current?.();
        releasePage.current = null;
      }, [signedIn]);
      React.useEffect(() => {
        if (props.settingsOpen) setOpen(false);
      }, [props.settingsOpen]);
      React.useLayoutEffect(() => {
        if (!signedIn) return;
        const button = getTrigger();
        if (!button) return;
        const attributes = {
          "aria-haspopup": "dialog",
          "aria-expanded": String(open),
          "aria-controls": id,
          "aria-label": t("nav"),
          "data-dsh-account-trigger": ""
        };
        const before = Object.keys(attributes).map((key) => [key, button.getAttribute(key)]);
        Object.entries(attributes).forEach(([key, value]) => button.setAttribute(key, value));
        return () => before.forEach(([key, value]) => value === null ? button.removeAttribute(key) : button.setAttribute(key, value));
      });
      React.useLayoutEffect(() => {
        if (!open || !signedIn) return;
        const anchor = getTrigger(), surface = panel.current;
        if (!anchor || !surface) return;
        function place() {
          const r = anchor.getBoundingClientRect(), p = surface.getBoundingClientRect();
          const viewport = window.visualViewport;
          const leftEdge = (viewport?.offsetLeft || 0) + 8, topEdge = (viewport?.offsetTop || 0) + 8;
          const rightEdge = leftEdge + (viewport?.width || window.innerWidth) - 16;
          const bottomEdge = topEdge + (viewport?.height || window.innerHeight) - 16;
          if (!anchor.isConnected || r.bottom < topEdge || r.top > bottomEdge) {
            setOpen(false);
            return;
          }
          const above = r.top - p.height - 10;
          const top = above >= topEdge ? above : Math.max(topEdge, Math.min(r.bottom + 10, bottomEdge - p.height));
          const next = {
            left: Math.max(leftEdge, Math.min(r.left, rightEdge - p.width)),
            top,
            maxHeight: Math.max(80, bottomEdge - topEdge)
          };
          setPosition((previous) => previous?.left === next.left && previous?.top === next.top && previous?.maxHeight === next.maxHeight ? previous : next);
        }
        place();
        surface.focus({ preventScroll: true });
        const observer = new ResizeObserver(place);
        observer.observe(anchor);
        observer.observe(surface);
        window.addEventListener("resize", place);
        document.addEventListener("scroll", place, true);
        window.visualViewport?.addEventListener("resize", place);
        window.visualViewport?.addEventListener("scroll", place);
        return () => {
          observer.disconnect();
          window.removeEventListener("resize", place);
          document.removeEventListener("scroll", place, true);
          window.visualViewport?.removeEventListener("resize", place);
          window.visualViewport?.removeEventListener("scroll", place);
        };
      }, [open, signedIn]);
      React.useLayoutEffect(() => {
        if (open && signedIn && position) {
          setPresent(true);
          motion.current.update(true, panel.current);
        } else if (!open || !signedIn) {
          motion.current.update(false, panel.current);
        }
      }, [open, signedIn, present, Boolean(position)]);
      React.useEffect(() => {
        if (!open) return;
        const outside = (event) => {
          if (!panel.current?.contains(event.target) && !getTrigger()?.contains(event.target)) close();
        };
        const escape = (event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          close(true);
        };
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("focusin", outside);
        document.addEventListener("keydown", escape, true);
        return () => {
          document.removeEventListener("pointerdown", outside, true);
          document.removeEventListener("focusin", outside);
          document.removeEventListener("keydown", escape, true);
        };
      }, [open]);
      function activate(event) {
        if (!signedIn || !getTrigger()?.contains(event.target)) return;
        if (event.type === "keydown" && !["ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        const next = event.type === "keydown" || !open;
        setOpen(next);
        setActionFailed(false);
        if (next) {
          if (!present) setPosition(null);
          Promise.resolve().then(() => props.refreshAccount?.()).catch(() => {
            if (alive.current && currentSignedIn.current) setActionFailed(true);
          });
        }
      }
      async function feedback() {
        try {
          await props.contactUs();
          if (alive.current) close(true);
        } catch {
          if (alive.current) setActionFailed(true);
        }
      }
      async function requestSignOut() {
        if (pending.current) return;
        const request = {};
        pending.current = request;
        setChecking(true);
        setFailed(false);
        let running;
        try {
          running = await props.hasRunningAccountTasks();
        } catch {
          running = "unknown";
        }
        if (pending.current !== request) return;
        pending.current = false;
        if (!alive.current || !currentSignedIn.current) return;
        setChecking(false);
        close(true);
        setImpact(running);
      }
      function dismissSignOut() {
        if (pending.current) return;
        setImpact(void 0);
        setFailed(false);
        getTrigger()?.focus({ preventScroll: true });
      }
      async function confirmSignOut() {
        if (pending.current) return;
        const request = {};
        pending.current = request;
        setBusy(true);
        setFailed(false);
        try {
          await props.signOut();
          if (alive.current && pending.current === request) setImpact(void 0);
        } catch {
          if (alive.current && currentSignedIn.current && pending.current === request) setFailed(true);
        } finally {
          if (pending.current === request) {
            pending.current = false;
            if (alive.current) setBusy(false);
          }
        }
      }
      function platformAction(page, label, className) {
        const href = platformHref(account.view, page);
        const enabled = typeof props.openPlatformPage === "function" || Boolean(href);
        const onClick = (event) => {
          if (!enabled) {
            event.preventDefault();
            return;
          }
          if (props.openPlatformPage) {
            event.preventDefault();
            try {
              releasePage.current?.();
              releasePage.current = props.openPlatformPage(page, () => {
                releasePage.current = null;
                getTrigger()?.focus({ preventScroll: true });
              });
            } catch {
              setActionFailed(true);
              return;
            }
          }
          close(true);
        };
        return h(
          "a",
          {
            href,
            target: "_blank",
            rel: "noopener noreferrer",
            className: "dshAccount__action " + className,
            "aria-disabled": !enabled || void 0,
            tabIndex: enabled ? 0 : -1,
            onClick,
            "data-dsh-account-action": page
          },
          label,
          page === "usage" && h(ui.IconRightUpOutlineRegular, { size: 12 })
        );
      }
      function wallet(bonus) {
        const rows = balanceRows(account.details, bonus);
        const values = rows?.map((row) => formatBalance(row.balance, row.currency));
        const available = values?.length && values.every(Boolean);
        return h(
          "div",
          { className: "dshAccount__balance" + (bonus ? " dshAccount__bonus" : "") },
          h("div", { className: "dshAccount__label" }, t(bonus ? "bonusBalance" : "balance")),
          h(
            "div",
            { className: "dshAccount__valueRow" },
            h("div", { className: "dshAccount__amounts", "aria-live": "polite" }, available ? values.map((value, i) => h(
              "span",
              {
                key: rows[i].currency,
                className: "dshAccount__amount",
                title: value.text,
                "aria-label": value.text,
                "data-long": value.number.length > 11
              },
              h("span", { className: "dshAccount__currency" }, value.prefix + value.symbol),
              value.number
            )) : h("span", { className: "dshAccount__unavailable" }, t(account.details?.balance === void 0 && !account.failed ? "loading" : "balanceUnavailable"))),
            platformAction(bonus ? "usage" : "top-up", t(bonus ? "usage" : "topUp"), bonus ? "dshAccount__usage" : "dshAccount__topup")
          )
        );
      }
      const profile = account.details?.profile?.status === "ready" ? account.details.profile.value : void 0;
      const name = profile?.name || profile?.contact || t("signedIn");
      const contact = profile?.contact || t(account.details?.profile === void 0 && !account.failed ? "loading" : "profileUnavailable");
      const iconButton = (label, className, onClick, icon, disabled = false) => {
        const button = h("button", {
          type: "button",
          className: "dshAccount__icon " + className,
          "aria-label": label,
          title: ui.Tooltip ? void 0 : label,
          onClick,
          disabled
        }, icon);
        return ui.Tooltip ? h(ui.Tooltip, { label, portal: true, side: "top", delayMs: 400 }, button) : button;
      };
      return h(
        "div",
        { className: "dshAccountLauncher", "data-collapsed": !props.wide, onClickCapture: activate, onKeyDownCapture: activate },
        h("div", { ref: native, className: "dshAccountLauncher__native" }, h(Original, props)),
        h(UpdateBadge, { wide: props.wide }),
        signedIn && !props.hasDesktopSettingsLauncher && iconButton(t("settings"), "dshAccount__settings", () => {
          close();
          props.openSettings();
        }, h(ui.IconSettingsOutlineMedium, { size: 16 })),
        (open || present) && signedIn && ReactDOM.createPortal(h(
          "section",
          {
            ref: panel,
            id,
            className: "dshAccount",
            role: "dialog",
            "data-state": open ? "open" : "closing",
            inert: open ? void 0 : "",
            "aria-hidden": open ? void 0 : true,
            "aria-label": t("nav"),
            tabIndex: -1,
            style: position || { visibility: "hidden" },
            "data-dsh-account-popover": ""
          },
          h(
            "div",
            { className: "dshAccount__profile" },
            h("span", { className: "dshAccount__avatar" }, account.avatar?.status === "ready" ? h("img", { src: account.avatar.url, alt: "", referrerPolicy: "no-referrer", onError: () => props.avatarFailed?.(account.avatar) }) : h(ui.IconUserOutlineMedium, { size: 20 })),
            h("span", { className: "dshAccount__name", title: name }, name),
            iconButton(t("signOut"), "dshAccount__logout", requestSignOut, h(LogoutIcon, { size: 14 }), checking),
            h(
              "div",
              { className: "dshAccount__contact" },
              h("span", { className: "dshAccount__phone", title: contact }, contact),
              iconButton(t("contactUs"), "dshAccount__feedback", feedback, h(ui.IconPaperPlaneOutlineMedium, { size: 13 }))
            )
          ),
          h("div", { className: "dshAccount__finance" }, wallet(false), wallet(true)),
          actionFailed && h("p", { className: "dshAccount__error", role: "alert" }, t("failed"))
        ), document.body),
        signedIn && impact !== void 0 && h(
          ui.Modal,
          {
            open: true,
            title: t("signOut"),
            closeLabel: t("close"),
            onClose: dismissSignOut,
            description: t(impact === "unknown" ? "signOutUnknownDescription" : impact ? "signOutRunningDescription" : "signOutDescription"),
            footer: h(
              React.Fragment,
              null,
              h(ui.Button, { variant: "outline", onClick: dismissSignOut, disabled: busy }, t("cancel")),
              h(ui.Button, { variant: "primary", onClick: confirmSignOut, disabled: busy }, t("signOut"))
            )
          },
          failed && h("p", { role: "alert", className: "dshAccount__confirmError" }, t("failed"))
        )
      );
    }
    return AccountLauncher;
  }

  // dsh-plugin/account-popover/mount.mjs
  function mountAccountPopover(slots, createLauncher, root = document.documentElement) {
    if (!slots.entries || !slots.subscribe) return () => {
    };
    let source, remove, disposed = false, syncing = false;
    const replacements = /* @__PURE__ */ new WeakSet();
    function clear() {
      const off2 = remove;
      remove = source = void 0;
      off2?.();
    }
    function sync() {
      if (disposed || syncing) return;
      syncing = true;
      try {
        const next = root.getAttribute("data-dsh-ui") === "vanilla" ? void 0 : slots.entries("settings.launcher").find((entry) => !replacements.has(entry.component) && !entry.component?.__dshSettingsLauncher && typeof entry.component === "function" && (entry.locale === "settings.account" || entry.options.locale === "settings.account"));
        if (next === source) return;
        clear();
        if (!next) return;
        source = next;
        const Launcher = createLauncher(next.component);
        replacements.add(Launcher);
        remove = slots.register({
          ...next.options,
          name: "settings.launcher",
          priority: (next.options.priority || 0) - 10,
          inject: next.inject,
          locale: next.locale,
          store: next.store
        }, Launcher);
      } finally {
        syncing = false;
      }
    }
    const off = slots.subscribe("settings.launcher", sync);
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-dsh-ui"] });
    sync();
    return () => {
      disposed = true;
      observer.disconnect();
      off();
      clear();
    };
  }

  // dsh-plugin/account-popover/settings-navigation.mjs
  function mountAccountSettingsNavigation(locale, doc = document) {
    const marker = "data-dsh-account-settings-hidden";
    const t = locale.bind("settings.account");
    let nav;
    const observer = new MutationObserver(sync);
    function observe() {
      observer.disconnect();
      observer.observe(doc.body, { childList: true });
      observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-dsh-ui"] });
      if (nav) observer.observe(nav, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-current"]
      });
    }
    function sync() {
      const next = doc.querySelector('[data-shortcut-modal="settings"] nav');
      if (nav !== next) {
        nav = next;
        observe();
      }
      if (!nav) return;
      const desktop = doc.documentElement.getAttribute("data-dsh-ui") !== "vanilla";
      const buttons = [...nav.querySelectorAll("button")];
      const account = buttons.find((button) => button.textContent.trim() === t("nav"));
      const hadFocus = account?.contains(doc.activeElement);
      for (const button of buttons) {
        button.toggleAttribute(marker, desktop && button === account);
      }
      if (!desktop || !account) return;
      const fallback = buttons.find((button) => button !== account && !button.disabled && !button.hidden);
      if (account.getAttribute("aria-current") === "true" && fallback) {
        fallback.click();
        if (hadFocus) fallback.focus({ preventScroll: true });
      }
    }
    observe();
    sync();
    return () => {
      observer.disconnect();
      doc.querySelectorAll(`[${marker}]`).forEach((button) => button.removeAttribute(marker));
    };
  }

  // dsh-plugin/account-popover/style.css
  var style_default = ".dshAccountLauncher { position: relative; display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }\n.dshAccountLauncher__native { flex: 1; min-width: 0; }\n.dshAccountLauncher[data-collapsed=true] { flex-direction: column; }\n.dshAccountLauncher .dshAccount__settings { width: 36px; height: 36px; }\n.dshUpdateBadge__anchor { position: absolute; inset-inline-end: 4px; top: 50%; transform: translateY(-50%); z-index: 1; display: inline-flex; }\n.dshAccountLauncher[data-collapsed=true] .dshUpdateBadge__anchor { inset-inline-end: 50%; top: 0; transform: translate(50%, -100%); }\n.dshUpdateBadge { display: inline-flex; align-items: center; justify-content: center; flex: none; min-height: 32px; padding: 0 2px; border: 0; border-radius: 6px; background: transparent; color: #246541; font: inherit; cursor: pointer; }\n.dshUpdateBadge__pill { position: relative; display: inline-flex; align-items: center; justify-content: center; height: 20px; padding: 0 6px; border: 1px solid #31865735; border-radius: 6px; background: #31865714; font-size: 11px; font-weight: 500; line-height: 1; white-space: nowrap; transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease, transform 160ms cubic-bezier(.2, .8, .2, 1); }\n.dshUpdateBadge__content { display: inline-flex; align-items: center; gap: 3px; flex: none; }\n.dshUpdateBadge__ghost { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }\n.dshUpdateBadge__ghost .dshUpdateBadge__spinner { animation: none; }\n.dshUpdateBadge:enabled:is(:hover, :focus-visible) .dshUpdateBadge__pill { transform: var(--dsh-update-badge-hover, translateY(-1px) scale(1.03)); }\n.dshUpdateBadge:enabled:active .dshUpdateBadge__pill { transform: var(--dsh-update-badge-press, scale(.97)); }\n.dshUpdateBadge:hover .dshUpdateBadge__pill { background: #31865728; border-color: #31865760; }\n.dshUpdateBadge:focus-visible { outline: 2px solid var(--dsw-alias-link, #4176e6); outline-offset: 1px; }\n.dshUpdateBadge:disabled { cursor: default; }\n.dshUpdateBadge[data-state=waiting], .dshUpdateBadge[data-state=installing] { color: var(--dsw-alias-label-secondary, #555); }\n.dshUpdateBadge[data-state=waiting] .dshUpdateBadge__pill, .dshUpdateBadge[data-state=installing] .dshUpdateBadge__pill { background: var(--dsw-alias-interactive-bg-hover, #8881); border-color: var(--dsw-alias-border-l2, #8883); }\n.dshUpdateBadge[data-state=error] { color: var(--dsw-alias-state-error-primary, #b33948); }\n.dshUpdateBadge[data-state=error] .dshUpdateBadge__pill { background: #cf435514; border-color: #cf435540; }\n.dshUpdateBadge[data-compact=true] { min-width: 32px; }\n.dshUpdateBadge[data-compact=true] .dshUpdateBadge__pill { width: 24px; height: 24px; justify-content: center; padding: 0; }\n.dshUpdateBadge__spinner { box-sizing: border-box; width: 11px; height: 11px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: dsh-update-badge-spin .85s linear infinite; }\n.dshUpdateBadge__status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }\nbody[data-ds-dark-theme] .dshUpdateBadge[data-state=available] { color: #8bd6aa; }\nbody[data-ds-dark-theme] .dshUpdateBadge[data-state=available] .dshUpdateBadge__pill { background: #73c99718; border-color: #73c99736; }\nbody[data-ds-dark-theme] .dshUpdateBadge[data-state=available]:hover .dshUpdateBadge__pill { background: #73c9972b; border-color: #73c99760; }\n@keyframes dsh-update-badge-spin { to { transform: rotate(360deg); } }\nhtml[data-dsh-desktop-animation=off] .dshUpdateBadge__pill { --dsh-update-badge-hover: none; --dsh-update-badge-press: none; transition: none; }\nhtml[data-dsh-desktop-animation=off] .dshUpdateBadge__spinner { animation: none; }\n@media (prefers-reduced-motion: reduce) {\n  html:not([data-dsh-desktop-animation=on]) .dshUpdateBadge__pill { --dsh-update-badge-hover: none; --dsh-update-badge-press: none; transition: none; }\n  html:not([data-dsh-desktop-animation=on]) .dshUpdateBadge__spinner { animation: none; }\n}\n.dshAccount {\n  --dsh-account-surface-tint: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 30%, transparent);\n  --dsh-surface-overlay: linear-gradient(var(--dsh-account-surface-tint), var(--dsh-account-surface-tint));\n  box-sizing: border-box; position: fixed; z-index: 1000; width: 318px; max-width: calc(100vw - 16px);\n  max-height: calc(100dvh - 16px); overflow: auto; overscroll-behavior: contain;\n  background-color: var(--dsw-alias-bg-base, #fff);\n  background-image: var(--dsh-surface-overlay), linear-gradient(var(--dsw-menu-surface-fill, transparent), var(--dsw-menu-surface-fill, transparent));\n  color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px; box-shadow: var(--dsw-elevation-panel, 0 12px 28px #0003);\n  font-family: inherit; font-size: 13px; line-height: 1.5; outline: none;\n}\nbody[data-ds-dark-theme] .dshAccount { --dsh-account-surface-tint: rgb(0 0 0 / .3); }\n.dshAccount *, .dshAccount *::before, .dshAccount *::after { box-sizing: border-box; }\n.dshAccount[data-state=closing] { pointer-events: none; }\n.dshAccount__profile { display: grid; grid-template-columns: 32px minmax(0, 1fr) 20px; column-gap: 10px; row-gap: 4px; align-items: center; padding: 14px 16px; }\n.dshAccount__avatar { grid-column: 1; grid-row: 1 / 3; width: 32px; height: 32px; border-radius: 50%; background: var(--dsw-alias-bg-skeleton); overflow: hidden; display: grid; place-items: center; color: var(--dsw-alias-label-tertiary); }\n.dshAccount__avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }\n.dshAccount__name { grid-column: 2; grid-row: 1; font-size: 13px; font-weight: 600; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.dshAccount__contact { grid-column: 2 / 4; grid-row: 2; display: flex; align-items: center; min-width: 0; gap: 6px; }\n.dshAccount__phone { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }\n.dshAccount__icon { display: inline-grid; place-items: center; flex: none; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }\n.dshAccount__icon:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }\n.dshAccount__logout { grid-column: 3; grid-row: 1; width: 20px; height: 20px; }\n.dshAccount__logout:hover { color: var(--dsw-alias-state-error-primary, #d74d64); }\n.dshAccount__feedback { width: 18px; height: 18px; }\n.dshAccount__finance { border-top: 1px solid var(--dsw-alias-border-l2); padding: 14px 16px; }\n.dshAccount__balance + .dshAccount__balance { margin-top: 12px; }\n.dshAccount__label { font-size: 11px; line-height: 16px; margin-bottom: 4px; color: var(--dsw-alias-label-secondary); }\n.dshAccount__valueRow { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-height: 28px; }\n.dshAccount__amounts { min-width: 0; }\n.dshAccount__amount { display: block; height: 28px; font-size: 24px; font-weight: 550; line-height: 28px; letter-spacing: -.04em; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.dshAccount__bonus .dshAccount__amount { font-size: 20px; }\n.dshAccount__amount[data-long=true] { font-size: 18px; }\n.dshAccount__bonus .dshAccount__amount[data-long=true] { font-size: 16px; }\n.dshAccount__currency { font-size: .58em; font-weight: 400; color: var(--dsw-alias-label-secondary); margin-right: 2px; }\n.dshAccount__action { display: inline-flex; align-items: center; justify-content: center; gap: 5px; flex: none; height: 28px; min-width: 48px; padding: 0 10px; border: 0; border-radius: 6px; font: inherit; font-size: 11px; line-height: 28px; white-space: nowrap; text-decoration: none; cursor: pointer; }\n.dshAccount__topup { background: var(--dsw-alias-button-primary-fill, #4176e6); color: var(--dsw-alias-label-primary-foreground, #fff); }\n.dshAccount__topup:hover { filter: brightness(.94); }\n.dshAccount__usage { background: transparent; color: var(--dsw-alias-link, #4176e6); padding-left: 7px; padding-right: 0; }\n.dshAccount__usage:hover { background: var(--dsw-alias-interactive-bg-hover); }\n.dshAccount :is(button, a):focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #5686fe); outline-offset: 2px; }\n.dshAccount :is(button:disabled, [aria-disabled=true]) { opacity: .5; cursor: default; }\n.dshAccount__unavailable { font-size: 11px; line-height: 28px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }\n.dshAccount__error { margin: 0; padding: 0 16px 12px; font-size: 11px; color: var(--dsw-alias-state-error-primary, #d74d64); }\n.dshAccount__confirmError { color: var(--dsw-alias-state-error-primary, #d74d64); }\n[data-dsh-account-settings-hidden] { display: none !important; }\n";

  // dsh-plugin/account-popover/client-entry.mjs
  window.__ModuleLoader__.load({ id: "@dsh-desktop/account-popover", factory(require2) {
    const React = require2("react"), ReactDOM = require2("react-dom");
    const ui = require2("@deepseek-ai/dsh-client-ui-primitives");
    return { inject: ["slots", "locale"], apply(ctx) {
      if (!ui.Modal || !ui.Button) return;
      return ctx.slots.inject("settings.launcher", () => {
        const style = document.createElement("style");
        style.dataset.dshAccountStyle = "";
        style.textContent = style_default;
        document.head.append(style);
        const unmount = mountAccountPopover(ctx.slots, (Original) => createAccountLauncher(React, ReactDOM, ui, Original));
        const restoreNavigation = mountAccountSettingsNavigation(ctx.locale);
        return () => {
          restoreNavigation();
          unmount();
          style.remove();
        };
      });
    } };
  } });
})();
