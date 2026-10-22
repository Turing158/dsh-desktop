(() => {
  // dsh-plugin/ui-state/checkpoints.mjs
  function createDraftCheckpoints({
    capture,
    save,
    blocked = () => false,
    delay = 2500,
    interval = 3e4,
    maximum = 6e4,
    captureTimeout = 2e4,
    now = Date.now,
    schedule = setTimeout,
    cancel = clearTimeout,
    onStatus = () => {
    }
  }) {
    let dirty = false, disposed = false, running = false, revision = 0, first = 0, last = 0, timer, lastAttempt = null, controller;
    const arm = () => {
      cancel(timer);
      timer = void 0;
      if (!dirty || disposed || running) return;
      const at = Math.max(lastAttempt === null ? 0 : lastAttempt + interval, Math.min(last + delay, first + maximum));
      timer = schedule(run, Math.max(0, at - now()));
    };
    const run = async () => {
      timer = void 0;
      if (disposed || !dirty || running) return;
      if (blocked()) {
        last = now();
        timer = schedule(run, delay);
        return;
      }
      running = true;
      lastAttempt = now();
      controller = new AbortController();
      const active = controller, claimed = revision;
      let deadline, aborted, timedOut = false;
      try {
        const stopped = new Promise((_, reject) => {
          aborted = () => reject(Error(timedOut ? "snapshot-capture-timeout" : "snapshot-capture-cancelled"));
          active.signal.addEventListener("abort", aborted, { once: true });
          deadline = schedule(() => {
            timedOut = true;
            active.abort();
          }, captureTimeout);
        });
        const payload = await Promise.race([capture(active.signal), stopped]);
        cancel(deadline);
        active.signal.removeEventListener("abort", aborted);
        if (disposed || active.signal.aborted || blocked() || claimed !== revision) return;
        const result = await save(payload);
        lastAttempt = now();
        if (disposed || active.signal.aborted) return;
        if (claimed === revision) dirty = false;
        onStatus({ savedAt: result?.savedAt || now(), error: null });
      } catch (error) {
        if (!disposed && (!active.signal.aborted || timedOut)) {
          onStatus({ savedAt: 0, error: /^[a-z0-9-]{1,80}$/.test(String(error?.message ?? error)) ? String(error?.message ?? error) : "recovery-save-failed" });
        }
      } finally {
        cancel(deadline);
        active.signal.removeEventListener("abort", aborted);
        running = false;
        if (controller === active) controller = void 0;
        arm();
      }
    };
    return {
      changed() {
        if (disposed) return;
        revision++;
        last = now();
        if (!dirty) first = last;
        dirty = true;
        arm();
      },
      suspend() {
        controller?.abort();
        if (dirty) {
          last = now();
          arm();
        }
      },
      dispose() {
        disposed = true;
        cancel(timer);
        controller?.abort();
      }
    };
  }

  // dsh-plugin/ui-state/checkpoint-bridge-entry.mjs
  window.__DSH_CREATE_DRAFT_CHECKPOINTS__ = createDraftCheckpoints;
})();
