(() => {
  // dsh-plugin/compatibility/selectors.mjs
  function terminalObservation(registeredType) {
    return {
      featureId: "terminal-dock",
      availability: "limited",
      implementation: registeredType ? "hybrid" : "desktop",
      pluginState: "enabled",
      reasonCodes: ["terminal-processes-not-restored"],
      evidence: ["registered-terminal-selector"]
    };
  }
  function sessionNavigationContract(ctx) {
    return typeof ctx?.sessions?.list?.getSnapshot === "function" && typeof ctx?.uiWorkspace?.openSession === "function";
  }
  function sessionLinksContract(ctx) {
    return sessionNavigationContract(ctx) && ["entries", "inject", "register", "subscribe"].every((key) => typeof ctx?.slots?.[key] === "function");
  }
  function sessionExportContract(ctx, controller) {
    return typeof ctx?.effect === "function" && ["run", "publish", "fetcher", "save"].every((key) => typeof controller?.[key] === "function") && typeof controller?.store?.getSnapshot === "function";
  }
  function sessionLinksExportObservation(links, exporting, native) {
    const linkReady = sessionLinksContract(links), exportReady = native && sessionExportContract(exporting?.ctx, exporting?.controller);
    return {
      featureId: "session-links-export",
      availability: linkReady || exportReady ? "limited" : links || exporting ? "unavailable" : "unknown",
      implementation: "hybrid",
      pluginState: "enabled",
      reasonCodes: [
        linkReady ? "session-link-target-preflight" : "session-links-contract-unavailable",
        exportReady ? "session-export-completion-preflight" : "session-export-contract-unavailable"
      ],
      evidence: [...linkReady ? ["session-link-navigation-selector"] : [], ...exportReady ? ["session-export-controller-selector"] : []]
    };
  }
  function createSessionReporter(reporter, native) {
    let links, exporting;
    const off = reporter.watch("session-links-export", () => sessionLinksExportObservation(links?.ctx, exporting, native()));
    const bind = (kind, ctx, controller) => {
      const registration = { ctx, controller };
      if (kind === "links") links = registration;
      else exporting = registration;
      reporter.recheck("session-links-export");
      return () => {
        if ((kind === "links" ? links : exporting) !== registration) return;
        if (kind === "links") links = void 0;
        else exporting = void 0;
        reporter.recheck("session-links-export");
      };
    };
    return { sessionLinks: (ctx) => bind("links", ctx), sessionExport: (ctx, controller) => bind("export", ctx, controller), sessionExportContract, dispose: off };
  }
  var CLIENT_FEATURES = ["terminal-dock", "file-editor", "ui-recovery", "session-changes-git", "session-links-export"];
  function createClientReporter(send) {
    const observations = /* @__PURE__ */ new Map();
    const emit = async (id, registration) => {
      const revision = ++registration.revision;
      const current = () => observations.get(id) === registration && revision === registration.revision;
      let report;
      try {
        const value = registration.selector();
        if (typeof value?.then === "function") {
          const settled = Promise.resolve(value).then((report2) => ({ report: report2 }), () => ({ report: { featureId: id, availability: "unknown", implementation: null, pluginState: "unknown", reasonCodes: ["capability-selector-failed"], evidence: [] } }));
          if (current()) await send({ featureId: id, availability: "checking", implementation: null, pluginState: "enabled", reasonCodes: [], evidence: [] });
          report = (await settled).report;
        } else report = value;
      } catch {
        report = { featureId: id, availability: "unknown", implementation: null, pluginState: "unknown", reasonCodes: ["capability-selector-failed"], evidence: [] };
      }
      if (current() && report?.featureId === id) return send(report);
    };
    const start = (id, registration) => {
      void emit(id, registration).catch(() => {
      });
    };
    return {
      report(value) {
        if (!CLIENT_FEATURES.includes(value?.featureId)) return;
        const registration = { selector: () => value, revision: 0 };
        observations.set(value.featureId, registration);
        start(value.featureId, registration);
      },
      watch(id, selector) {
        if (!CLIENT_FEATURES.includes(id) || typeof selector !== "function") return () => {
        };
        const registration = { selector, revision: 0 };
        observations.set(id, registration);
        start(id, registration);
        return () => {
          if (observations.get(id) !== registration) return;
          observations.delete(id);
          Promise.resolve(send({ featureId: id, availability: "unknown", implementation: null, pluginState: "unknown", reasonCodes: ["feature-provider-unreported"], evidence: [] })).catch(() => {
          });
        };
      },
      refresh() {
        return Promise.allSettled([...observations].map(([id, selector]) => emit(id, selector)));
      },
      recheck(id) {
        const registration = observations.get(id);
        if (registration) start(id, registration);
      },
      clear() {
        observations.clear();
      }
    };
  }

  // dsh-plugin/desktop-maintenance/capability-bridge-entry.mjs
  if (window.top === window && !window.__DSH_CAPABILITIES__) {
    let disposed = false;
    const send = (report) => {
      if (disposed || !window.__DSH_REMOTE_IDENTITY__ || !window.__TAURI__?.core?.invoke) return;
      return window.__TAURI__.core.invoke("desktop_capabilities_report", { identity: window.__DSH_REMOTE_IDENTITY__, report }).catch(() => {
      });
    };
    const reporter = createClientReporter(send);
    const sessions = createSessionReporter(reporter, () => typeof window.__TAURI__?.core?.invoke === "function");
    window.__DSH_CAPABILITIES__ = { ...reporter, ...sessions, terminal: (registered) => reporter.report(terminalObservation(registered)) };
    const timer = setInterval(() => reporter.refresh(), 6e4);
    window.addEventListener("beforeunload", () => {
      disposed = true;
      clearInterval(timer);
      reporter.clear();
    }, { once: true });
  }
})();
