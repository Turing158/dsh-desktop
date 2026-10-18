/* Injected into every top-level document, including boot and failed loads. */
;(function () {
  'use strict'

  const t = (source, values) => window.__DSH_I18N__?.t(source, values) ?? (typeof source === 'string' ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source)
  if (window.top !== window || window.__DSH_UI_STATE__) return
  const boot = window.__DSH_UI_BOOT__
  const required = ['page', 'drafts', 'attachments', 'selection', 'scroll', 'layout', 'dialogs']
  const providers = new Map()
  let adapter, packet, controller, restoreKey, composing = false, picker = false
  let restartAdapterFactory, restartAdapter
  const restartTarget = () => adapter || (restartAdapter ||= restartAdapterFactory?.())
  let frozen = false, overlay
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args)
  const same = (a, b) => a && b && ['operationId', 'windowGeneration', 'documentGeneration', 'backendInstance'].every(k => a[k] === b[k])
  // The app's own page, in either form: the packaged protocol, or the origin the
  // Rust side reports for the development server it is being served from.
  const local = () => location.hostname === 'tauri.localhost' || location.protocol === 'tauri:' || location.origin === boot?.appOrigin
  const codes = {
    get 'snapshot-terminal-active'() { return t('当前操作无法保留桌面终端，请先关闭终端后重试。') },
    get 'snapshot-terminal-missing'() { return t('原终端会话已不可用，未自动新建或重新执行命令。') },
    get 'snapshot-terminal-unsupported'() { return t('当前终端接口或标签状态不兼容，原界面或快照仍保留。') },
    get 'snapshot-terminal-conflict'() { return t('终端标签的会话或 Shell 绑定已变化，恢复已暂停，原快照仍保留。') },
    get 'snapshot-form-unsupported'() { return t('有尚未适配的弹窗或表单，请先完成或关闭它。') },
    get 'snapshot-panel-unsupported'() { return t('当前面板尚未支持恢复，请先回到聊天并关闭右侧面板。') },
    get 'snapshot-adapter-version'() { return t('DSH 版本在保存后发生变化，请使用保存时的版本重试恢复。') },
    get 'snapshot-adapter-unsupported'() { return t('当前 DSH 缺少安全保存和恢复界面所需的接口，配置尚未应用。') },
    get 'snapshot-schema-unsupported'() { return t('界面快照格式不兼容，原快照仍保留。') },
    get 'snapshot-navigation-unsupported'() { return t('当前 DSH 无法恢复空白页面，请先打开一个会话再应用。') },
    get 'snapshot-layout-unsupported'() { return t('当前 DSH 的布局接口不兼容，配置尚未应用。') },
    get 'snapshot-scroll-unsupported'() { return t('当前 DSH 的聊天位置接口不兼容，配置尚未应用。') },
    get 'snapshot-adapter-missing'() { return t('界面状态服务尚未准备好，请稍后再试。') },
    get 'snapshot-upload-pending'() { return t('附件仍在上传或上传失败，请处理完毕后再试。') },
    get 'snapshot-attachment-limit'() { return t('未发送附件总量超过 8 MiB，暂时不能进入极简模式。') },
    get 'snapshot-input-busy'() { return t('输入或提交仍在进行，请稍后再试。') },
    get 'snapshot-editor-unsupported'() { return t('当前草稿含有尚未适配的引用或编辑状态，请先处理后再试。') },
    get 'snapshot-attachment-conflict'() { return t('界面中存在快照以外的附件，恢复已暂停，原快照仍保留。') },
    get 'snapshot-attachment-verify'() { return t('附件恢复校验未通过，原快照仍保留，可以重试。') },
    get 'snapshot-file-picker'() { return t('文件选择尚未完成，请关闭文件选择窗口后再试。') },
    get 'snapshot-session-missing'() { return t('原会话已不可用，草稿仍保留在本次快照中。') },
    get 'snapshot-workspace-missing'() { return t('原项目已不可用，草稿仍保留在本次快照中。') },
    get 'snapshot-backend-changed'() { return t('后台实例已变化，已保留原快照，未把草稿写入其他会话。') },
    get 'snapshot-backend-unavailable'() { return t('后台尚未就绪，请先处理启动页上的问题。原快照已保留。') },
    get 'snapshot-restore-timeout'() { return t('恢复等待超时，原快照已保留。可以重试恢复。') },
    get 'snapshot-capture-timeout'() { return t('保存等待超时，原界面已保留。') },
    get 'snapshot-scroll-missing'() { return t('原消息位置尚未加载，快照已保留，可以重试恢复。') },
    get 'snapshot-window-lost'() { return t('主窗口意外关闭，已重新连接。未保存的页面状态可能不可用。') },
    get 'snapshot-third-party'() { return t('当前插件界面尚未支持恢复，请先关闭该界面。') },
  }
  const message = code => codes[code] || t('保存或恢复未完成，原界面或快照已保留。')
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const abort = () => { controller?.abort(); controller = undefined }
  function setFrozen(value) {
    // Capture-phase input guards preserve programmatic editor focus/selection
    // and native window controls. Making #root inert would disable both.
    frozen = value
  }
  function display(text, retry = false, blocking = false) {
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => display(text, retry, blocking), { once: true }); return }
    const previous = overlay
    previous?.remove()
    if (!text) {
      overlay = undefined
      if (previous) window.__DSH_DESKTOP_BOOT__?.contentReady()
      return
    }
    overlay = document.createElement('div')
    overlay.dataset.dshUiStatus = 'true'
    overlay.setAttribute('role', retry ? 'alert' : 'status')
    overlay.style.cssText = `position:fixed;z-index:2147483000;${blocking ? 'inset:44px 0 0;display:grid;place-content:center;' : 'right:20px;bottom:calc(20px + var(--dsh-terminal-dock-height, 0px));max-width:440px;'}padding:24px;background:var(--dsw-alias-bg-base,var(--dsh-desktop-titlebar-bg,#f9f9fb));color:var(--dsw-alias-label-primary,var(--dsh-desktop-titlebar-fg,#202124));font:14px/1.7 system-ui;border:1px solid #8884;border-radius:12px;box-sizing:border-box;`
    if (blocking && !retry) {
      const visual = window.__DSH_DESKTOP_BOOT__?.progressVisual()
      if (visual) overlay.append(visual)
    }
    const label = document.createElement('div'); label.textContent = text; overlay.append(label)
    if (retry) {
      const button = document.createElement('button'); button.textContent = t('重试恢复'); button.dataset.dshUiRetry = 'true'
      button.style.cssText = 'margin-top:12px;padding:8px 16px;cursor:pointer;'
      button.onclick = () => { button.disabled = true; invoke('request_ui_restore', { identity: packet.identity, retry: true }).catch(() => { button.disabled = false }) }
      overlay.append(button)
    } else if (!blocking) {
      const button = document.createElement('button'); button.textContent = t('关闭提示'); button.dataset.dshUiRetry = 'true'
      button.onclick = () => overlay?.remove(); overlay.append(button)
    }
    document.body.append(overlay)
    if (blocking) window.__DSH_DESKTOP_BOOT__?.contentReady()
  }
  function blockInput(event) {
    if (!frozen) return
    if (event.target?.closest?.('[data-dsh-ui-retry], .dshTb__control, .dshBoot__control')) return
    event.preventDefault(); event.stopImmediatePropagation()
  }
  for (const name of ['beforeinput', 'keydown', 'keyup', 'click', 'dblclick', 'pointerdown', 'mousedown', 'touchstart', 'wheel', 'drop', 'paste', 'cut', 'submit']) document.addEventListener(name, blockInput, { capture: true, passive: false })
  document.addEventListener('compositionstart', () => { composing = true }, true)
  document.addEventListener('compositionend', () => { composing = false }, true)
  document.addEventListener('click', event => { if (event.target?.matches?.('input[type=file]')) picker = true }, true)
  document.addEventListener('change', event => { if (event.target?.matches?.('input[type=file]')) picker = false }, true)
  document.addEventListener('cancel', event => { if (event.target?.matches?.('input[type=file]')) picker = false }, true)
  window.addEventListener('pagehide', abort)

  // ── Deep links ────────────────────────────────────────────────────────────
  //
  // Rust pushes `openDeepLink({sessionId})` once its guards hold (backend
  // running, DSH document loaded, origin matching — see `deep_link.rs`). Until
  // this document's adapter registers, the id waits in a local queue and is
  // flushed on `registerAdapter`, which is what lets a push that lands during
  // plugin boot still activate. A link whose activation fails for a reason a
  // reload could fix (services not ready yet) is reported to nobody: the Rust
  // queue keeps it and the next page load re-pushes. Only a definitive
  // outcome — opened, or a session that no longer exists — reports back, which
  // is what clears the Rust-side slot.

  /** Ids received before this document had an adapter. */
  let deepLinkQueue = []

  /** Run one queued or pushed link through the adapter and report the result. */
  async function runDeepLink(sessionId) {
    if (!adapter?.openDeepLink) return
    // A snapshot restore in progress owns the page; opening a session
    // mid-restore would fight it. Wait for Active, bounded like the
    // adapter's own waits.
    const settle = Date.now() + 10000
    while (packet?.phase === 'restoring' && Date.now() < settle) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    try {
      await adapter.openDeepLink(sessionId)
      invoke('report_deep_link', { sessionId, outcome: 'opened' }).catch(() => {})
    } catch (error) {
      if (error?.message === 'deep-link-session-missing') {
        display(t('链接指向的会话不存在（可能已删除或归档）。'))
        invoke('report_deep_link', { sessionId, outcome: 'missing' }).catch(() => {})
      }
      // `deep-link-page-not-ready` and anything else stays silent: the Rust
      // queue re-pushes after the next navigation, and expires on its own.
    }
  }

  /** The Rust-facing entry: queue until an adapter can consume the id. */
  async function openDeepLink(payload) {
    const sessionId = payload?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (!adapter) {
      if (!deepLinkQueue.includes(sessionId)) deepLinkQueue.push(sessionId)
      return
    }
    await runDeepLink(sessionId)
  }

  async function capture(identity, bootPayload = null) {
    if (!packet || identity.windowGeneration !== boot.windowGeneration) return
    abort(); controller = new AbortController(); const signal = controller.signal
    packet = { ...packet, identity, phase: 'capturing' }
    try {
      const deadline = Date.now() + 800
      while (composing && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      signal.throwIfAborted()
      if (composing) throw new Error('snapshot-input-busy')
      if (picker) throw new Error('snapshot-file-picker')
      const isBoot = local() && bootPayload?.page?.kind === 'boot'
      if (!isBoot && !adapter) throw new Error('snapshot-adapter-missing')
      setFrozen(true)
      await frame(); signal.throwIfAborted()
      if (isBoot && document.querySelector('[role=dialog],dialog[open],[aria-modal=true],input,textarea,select,[contenteditable=true]')) throw new Error('snapshot-form-unsupported')
      const payload = isBoot ? bootPayload : await adapter.capture({ signal, frontendVersion: packet.frontendVersion, providers })
      signal.throwIfAborted()
      if (!same(identity, packet.identity)) return
      await invoke('submit_ui_snapshot', { identity, payload, error: null })
      // Stay frozen until native cancellation, destruction, or restored confirmation.
    } catch (error) {
      if (signal.aborted || !same(identity, packet?.identity)) return
      const code = /^[a-z0-9-]{1,80}$/.test(error.message) ? error.message : 'snapshot-adapter-error'
      try { invoke('submit_ui_snapshot', { identity, payload: null, error: code }).catch(() => {}) } catch {}
      setFrozen(false); display(message(code))
    }
  }

  async function maybeRestore() {
    if (!packet || packet.phase !== 'restoring' || (!adapter && !restartAdapterFactory && !local())) return
    const identity = packet.identity
    const key = JSON.stringify(identity)
    if (key === restoreKey) return
    restoreKey = key
    abort(); controller = new AbortController(); const signal = controller.signal
    setFrozen(true); display(t('正在恢复界面…'), false, true)
    let snapshot
    try {
      const reply = await invoke('request_ui_restore', { identity, retry: false })
      signal.throwIfAborted()
      if (!same(identity, packet?.identity) || !same(identity, reply.identity) || !reply.snapshot) return
      snapshot = reply.snapshot
      if (snapshot.payload.page.kind !== 'boot') {
        if (local()) throw new Error('snapshot-backend-unavailable')
        const target = restartTarget()
        if (!target) throw new Error('snapshot-adapter-missing')
        await target.restore(snapshot, { signal, frontendVersion: packet.frontendVersion, providers })
      }
      signal.throwIfAborted()
      if (!same(identity, packet?.identity)) return
      await invoke('finish_ui_restore', { identity, snapshotId: snapshot.snapshotId, restored: required, error: null })
    } catch (error) {
      if (signal.aborted || !same(identity, packet?.identity)) return
      const code = /^[a-z0-9-]{1,80}$/.test(error.message) ? error.message : 'snapshot-adapter-error'
      if (snapshot) await invoke('finish_ui_restore', { identity, snapshotId: snapshot.snapshotId, restored: [], error: code }).catch(() => {})
      display(message(code), true, !local())
      if (local()) setFrozen(false)
    }
  }

  window.__DSH_UI_STATE__ = {
    configure(next) {
      if (next.identity.windowGeneration !== boot.windowGeneration) return
      if (packet && next.identity.operationId < packet.identity.operationId) return
      const changed = !same(next.identity, packet?.identity)
      if (changed) abort()
      packet = next
      if (next.phase === 'active') { restoreKey = undefined; setFrozen(false); display(next.error ? message(next.error) : '') }
      else if (next.phase === 'restore-failed') { setFrozen(!local()); display(message(next.error), true, !local()) }
      else if (next.phase === 'restoring') { window.__DSH_DESKTOP_BOOT__?.markRestoring(); maybeRestore() }
    },
    capture,
    // Settings restarts use the audited adapter even while optional WebView
    // disposal is disabled. The payload stays native; no browser storage copy.
    async prepareRemoteApply(frontendVersion, notice = t('正在保存界面并应用远程控制配置…')) {
      if (composing || picker || frozen) throw new Error(t('请完成当前输入或文件选择后重试'))
      const target = restartTarget()
      if (!target) throw new Error(t('页面保存服务尚未准备好，请稍后重试'))
      setFrozen(true)
      try {
        await frame()
        const payload = await target.capture({ signal: new AbortController().signal, frontendVersion, providers, remoteApply: true })
        display(notice, false, true)
        return payload
      } catch (error) { setFrozen(false); throw new Error(message(error.message)) }
    },
    finishRemoteApply() { setFrozen(false); display('') },
    // Explicit restarts still protect drafts when optional automatic UI-state
    // capture is disabled. This lazy adapter never enables background capture.
    registerRestartAdapter(factory) {
      restartAdapterFactory = factory; maybeRestore()
      return () => {
        if (restartAdapterFactory !== factory) return
        restartAdapter?.dispose(); restartAdapter = undefined; restartAdapterFactory = undefined
      }
    },
    registerAdapter(value) {
      adapter = value; maybeRestore()
      // Flush in registration order; failures stay queued on the Rust side by
      // contract, so a fire-and-forget pass here is the whole handoff.
      const queued = deepLinkQueue; deepLinkQueue = []
      for (const sessionId of queued) runDeepLink(sessionId)
      return () => {
        if (adapter === value) {
          abort(); adapter = undefined; restoreKey = undefined
          deepLinkQueue = []
        }
      }
    },
    registerProvider(id, provider) { providers.set(id, provider); return () => { if (providers.get(id) === provider) providers.delete(id) } },
    openDeepLink,
    pendingOperation() { return composing || picker },
  }
  if (boot.restoring) {
    window.__DSH_DESKTOP_BOOT__?.markRestoring()
    display(t('正在恢复界面…'), false, true)
    document.addEventListener('DOMContentLoaded', () => setFrozen(true), { once: true })
  }
})()
