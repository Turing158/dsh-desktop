/* Capability-checked adapter for DSH service/slot contracts across versions.
 * No React internals, generated class names, full stores, or transcript copies.
 */
;(function () {
  'use strict'
  if (window.top !== window) return
  const required = ['page', 'drafts', 'attachments', 'selection', 'scroll', 'layout', 'dialogs']
  const fail = code => { throw new Error(code) }
  const clone = value => JSON.parse(JSON.stringify(value))
  const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const check = signal => signal.throwIfAborted()
  const versionOf = value => typeof value === 'string' && value.trim() ? value.trim() : 'unknown'
  const wait = async (predicate, signal, code) => {
    const end = Date.now() + 10000
    while (!predicate()) { check(signal); if (Date.now() > end) fail(code); await new Promise(resolve => setTimeout(resolve, 30)) }
    check(signal)
  }
  function encode(bytes) {
    let text = ''
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
    return btoa(text)
  }
  function decode(text) { return Uint8Array.from(atob(text), c => c.charCodeAt(0)) }
  function readPersisted(id) {
    try { return JSON.parse(localStorage.getItem('dsh.conversation.' + id) || '{}') } catch { fail('snapshot-draft-storage') }
  }
  function semanticDraft(value) {
    if (value == null || typeof value === 'string') return { text: value || '', references: [] }
    if (typeof value.text !== 'string' || !Array.isArray(value.references) || value.references.length > 10000) fail('snapshot-editor-unsupported')
    const result = { text: value.text, references: [] }
    let end = 0
    if (value.command != null) {
      const token = value.command.token
      if (typeof token !== 'string' || !token.startsWith('/') || token.length > 256 || !token.trimEnd()
        || !value.text.startsWith(token.trimEnd())) fail('snapshot-editor-unsupported')
      result.command = { token }; end = token.trimEnd().length
    }
    for (const ref of value.references) {
      if (!ref || ['source', 'ref', 'label', 'clipboardText'].some(key => typeof ref[key] !== 'string')
        || !ref.source || !ref.ref || !Number.isInteger(ref.offset) || !Number.isInteger(ref.length)
        || ref.offset < end || ref.length < 1 || ref.length !== ref.clipboardText.length
        || value.text.slice(ref.offset, ref.offset + ref.length) !== ref.clipboardText
        || (ref.appearance !== undefined && !['file', 'folder', 'session'].includes(ref.appearance))) fail('snapshot-editor-unsupported')
      result.references.push({ source: ref.source, ref: ref.ref, label: ref.label, clipboardText: ref.clipboardText,
        offset: ref.offset, length: ref.length, ...(ref.appearance ? { appearance: ref.appearance } : {}) })
      end = ref.offset + ref.length
    }
    return result
  }
  function getScroll(sessionId) {
    const scroller = document.querySelector('[data-conversation-scroll]')
    if (!scroller) return null
    const top = scroller.getBoundingClientRect().top
    const row = [...scroller.querySelectorAll('[data-chat-anchor-key]')].find(el => !el.hidden && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().bottom > top)
    return { sessionId, anchor: row?.getAttribute('data-chat-anchor-key') || null, offset: row ? row.getBoundingClientRect().top - top : 0,
      following: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 25, scrollTop: scroller.scrollTop }
  }
  function setSelection(editor, selection) {
    if (!selection?.focused) return
    const root = editor.getRootElement()
    if (!root) fail('snapshot-editor-missing')
    root.focus({ preventScroll: true })
    // DSH's plain composer projection inserts one newline between paragraphs.
    // A text-only TreeWalker loses those offsets (and offsets after <br>).
    const points = []
    let length = 0
    // An empty Lexical root has no paragraph until the first input. Its only
    // valid DOM position is the contenteditable root at offset zero.
    if (!root.childNodes.length) points[0] = [root, 0]
    const walk = node => {
      if (node.nodeType === 3) {
        for (let i = 0; i <= node.textContent.length; i++) points[length + i] ??= [node, i]
        length += node.textContent.length
      } else if (node.hasAttribute?.('data-composer-chip') || node.hasAttribute?.('data-composer-command')) {
        // Native caretSpan uses one detect-coordinate character per chip,
        // irrespective of its displayed label or clipboard representation.
        const parent = node.parentNode, index = [...parent.childNodes].indexOf(node)
        points[length] ??= [parent, index]
        points[++length] = [parent, index + 1]
      } else if (node.nodeName === 'BR') {
        const parent = node.parentNode, index = [...parent.childNodes].indexOf(node)
        points[length] ??= [parent, index]
        // Lexical uses a sole BR as the placeholder of an empty paragraph.
        if (parent.childNodes.length > 1) { length++; points[length] = [parent, index + 1] }
      } else for (const child of node.childNodes) walk(child)
    }
    ;[...root.childNodes].forEach((block, index) => {
      if (index) length++
      points[length] ??= [block, 0]
      walk(block)
    })
    function locate(offset) {
      if (!points[offset]) fail('snapshot-selection-verify')
      return points[offset]
    }
    const range = document.createRange()
    range.setStart(...locate(selection.start)); range.setEnd(...locate(selection.end))
    const selected = document.getSelection(); selected.removeAllRanges(); selected.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }

  window.__DSH_CREATE_UI_ADAPTER__ = function (ctx) {
    const installedAssets = new Map()
    async function matchesAsset(attachment, asset, signal) {
      const file = attachment?.file
      if (!file || file.name !== asset.name || file.size !== asset.size || file.type !== asset.mediaType) return false
      const content = encode(new Uint8Array(await file.arrayBuffer())); check(signal)
      return content === asset.data
    }
    function layoutStore() {
      const entry = ctx.slots.entriesOfSlot('root')[0]
      const store = entry?.store || entry?.options?.store
      if (!store?.create) fail('snapshot-layout-unsupported')
      const instance = store.create()
      // ui-layout deliberately publishes its ONE shared root instance through create.
      // Reject a changed upstream contract rather than reading a detached store.
      if (instance !== store.create() || typeof instance.getSnapshot !== 'function'
        || ['setSidebar', 'toggleSidebar', 'setRightbar'].some(key => typeof instance.actions?.[key] !== 'function')) fail('snapshot-layout-unsupported')
      const state = instance.getSnapshot()
      if (!Number.isFinite(state?.layoutInfo?.sidebar) || typeof state.layoutInfo.narrowExpanded !== 'boolean'
        || !(state.layoutInfo.rightbar === null || Number.isFinite(state.layoutInfo.rightbar)) || !state.panelInfo) fail('snapshot-layout-unsupported')
      return instance
    }
    function chatFace(id) {
      const entry = ctx.slots.entriesOfSlot('conversation.view').find(e => e.options?.id === 'chat')
      const inject = entry?.inject
      if (typeof inject !== 'function') fail('snapshot-scroll-unsupported')
      const face = inject(id)
      if (typeof face?.chatScroll?.read !== 'function' || typeof face.chatScroll.save !== 'function') fail('snapshot-scroll-unsupported')
      return face
    }
    function inputFor(id) {
      const scope = ctx.sessions.scope(id)
      return scope ? ctx.conversation.input.for(scope) : undefined
    }
    function validateCapabilities() {
      const methods = [
        [ctx.slots, 'entriesOfSlot'], [ctx.sessions?.list, 'getSnapshot'],
        [ctx.sessions, 'scope'], [ctx.sessions, 'binding'],
        [ctx.workspaces?.list, 'getSnapshot'], [ctx.uiWorkspace, 'openSession'],
        [ctx.conversation?.input, 'for'], [ctx.conversation, 'resolveDraftAttachments'],
        [ctx.conversation, 'createDrafts'], [ctx.conversation?.fileUploads, 'getSnapshot'],
        [ctx.layout, 'selectPanel'],
      ]
      if (methods.some(([owner, key]) => typeof owner?.[key] !== 'function')) fail('snapshot-adapter-unsupported')
      const list = ctx.sessions.list.getSnapshot(), workspaces = ctx.workspaces.list.getSnapshot()
      if (!Array.isArray(list?.ids) || !list.byId || !Array.isArray(workspaces?.items)
        || workspaces.items.some(w => !Array.isArray(w.sessionIds))) fail('snapshot-adapter-unsupported')
      layoutStore()
    }
    function currentSessionId(list) {
      if ('current' in list) return list.current || null
      const selected = Object.values(list.byId).filter(row => (row.retainedBy?.mainView ?? 0) > 0)
      if (selected.length > 1) fail('snapshot-panel-unsupported')
      return selected[0]?.id || null
    }
    function openInput(id) {
      if (typeof ctx.sessions.open === 'function') ctx.sessions.open(id)
      else ctx.uiWorkspace.openSession(id)
    }
    function canClearPage() { return typeof ctx.sessions.clear === 'function' || typeof ctx.uiWorkspace.clearMain === 'function' }
    function clearPage() {
      // Cancel startup/default-workspace navigation before releasing mainView.
      ctx.layout.beginNavigation?.()
      if (typeof ctx.sessions.clear === 'function') ctx.sessions.clear()
      else if (typeof ctx.uiWorkspace.clearMain === 'function') ctx.uiWorkspace.clearMain()
      else fail('snapshot-navigation-unsupported')
    }
    const supportsSemantic = input => input && 'draftSnapshot' in input && typeof input.setDraft === 'function'
    const editable = (input, semantic) => input.state.getSnapshot().phase === 'plain'
      || (input.state.getSnapshot().phase === 'claimed' && supportsSemantic(input) && semantic?.command)
    const retainedDrafts = new Map()
    // DSH 0.2 releases input scopes on navigation. Keep restored attachments
    // alive until the adapter's document is disposed, including across retries.
    function retainDraft(id) {
      if (typeof ctx.sessions.open === 'function' || retainedDrafts.has(id)) return
      if (typeof ctx.sessions.retain !== 'function') fail('snapshot-adapter-unsupported')
      const reference = ctx.sessions.retain(id, { source: 'desktopUiSnapshot' })
      if (typeof reference?.release !== 'function') fail('snapshot-adapter-unsupported')
      reference.ready?.catch(() => {})
      retainedDrafts.set(id, reference)
    }
    function dispose() { for (const reference of retainedDrafts.values()) reference.release(); retainedDrafts.clear() }
    function workspaceFor(id) { return ctx.workspaces.list.getSnapshot().items.find(w => w.sessionIds.includes(id))?.workspaceId || null }
    function validateFormCoverage(roots, providers, remoteApply = false, configurationRestore = false) {
      const owned = node => [...providers.values()].some(provider => provider.owns?.(node))
      // Exit animations leave inert DOM clones after React closes a surface.
      // They paint the old UI but no longer own any form state to preserve.
      const live = node => !node.closest('[data-dsh-ghost]')
      const hasLive = (node, selector) => [...node.querySelectorAll(selector)].some(live)
      for (const dialog of document.querySelectorAll('[role=dialog],dialog[open],[aria-modal=true]')) {
        if (!live(dialog) || dialog.closest('[data-dsh-ui-status]')) continue
        if (remoteApply && hasLive(dialog, '.dshRemote') && !hasLive(dialog, '.dshRemote [role=alertdialog]')) continue
        // Plugin switches are committed before restart can be requested. Only
        // exempt the settings shell; the editable-field audit below still runs.
        if (remoteApply && hasLive(dialog, '.dshPlugins') && !hasLive(dialog, '[role=alertdialog]')) continue
        if (remoteApply && configurationRestore && hasLive(dialog, '[data-dsh-configuration-restore]') && !hasLive(dialog, '[role=alertdialog]')) continue
        if (!owned(dialog)) fail('snapshot-form-unsupported')
      }
      for (const field of document.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=true]')) {
        if (!live(field)) continue
        if (remoteApply && field.closest('.dshRemote')) continue
        // Only reviewed, ephemeral selection/confirmation checkboxes belong to
        // this action. Passwords and unrelated settings still require coverage.
        if (remoteApply && configurationRestore && field.type === 'checkbox' && field.closest('[data-dsh-configuration-restore]')) continue
        if (roots.some(root => root && (root === field || root.contains(field))) || owned(field.closest('[role=dialog]') || field)) continue
        const visible = field.checkVisibility ? field.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : field.getClientRects?.().length > 0
        const visibleEditable = field.type !== 'file' && !field.readOnly && !field.disabled && visible
        if (visibleEditable || field.files?.length || field.value || field.textContent || field.checked || field.tagName === 'SELECT') fail('snapshot-form-unsupported')
      }
    }
    async function capture({ signal, frontendVersion, providers, remoteApply = false, configurationRestore = false, draftsOnly = false }) {
      const terminals = remoteApply ? providers.get('desktop-terminal') : undefined
      if (!draftsOnly && !terminals && window.__DSH_TERMINAL_IDENTITY__ && (await window.__TAURI__.core.invoke('terminal_list', { identity: window.__DSH_TERMINAL_IDENTITY__ })).length) fail('snapshot-terminal-active')
      validateCapabilities()
      frontendVersion = versionOf(frontendVersion)
      const list = ctx.sessions.list.getSnapshot()
      if (list.phase !== 'ready' || ctx.workspaces.list.getSnapshot().phase !== 'ready') fail('snapshot-page-not-ready')
      const currentId = currentSessionId(list)
      if (!draftsOnly && (list.currentAddress || (currentId && ctx.sessions.subagentAddress?.(currentId)))) fail('snapshot-panel-unsupported')
      if (!currentId && !canClearPage()) fail('snapshot-navigation-unsupported')
      const state = layoutStore().getSnapshot()
      const changes = providers.get('desktop-changes')
      const files = providers.get('desktop-file-editor')
      if (!draftsOnly && ((state.layoutInfo.rightbarShown && !terminals?.ownsSidebar() && !changes?.ownsSidebar() && !files?.ownsSidebar()) || (state.panelInfo.activePanelId && state.panelInfo.activePanelId !== 'conversation'))) fail('snapshot-panel-unsupported')
      const dialogs = []
      for (const [id, provider] of draftsOnly ? [] : providers) {
        const data = await provider.capture(); check(signal)
        if (data !== null) dialogs.push({ id, version: provider.version, data })
      }
      const drafts = [], assets = [], scrolls = [], roots = [], revisions = []
      const ids = new Set([...Object.keys(list.byId), ...(currentId ? [currentId] : [])])
      // Only this documented namespace: no copying of arbitrary browser storage.
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (key?.startsWith('dsh.conversation.')) ids.add(key.slice('dsh.conversation.'.length))
      }
      let totalBytes = 0
      for (const id of ids) {
        check(signal)
        const persisted = readPersisted(id)
        const input = inputFor(id)
        if (input && typeof input.state?.getSnapshot !== 'function') fail('snapshot-editor-unsupported')
        const current = input?.state.getSnapshot()
        if (input && (typeof current?.draft !== 'string' || !Array.isArray(current.attachmentIds)
          || typeof input.setDraft !== 'function' || typeof input.addAttachments !== 'function'
          || typeof input.removeAttachment !== 'function')) fail('snapshot-editor-unsupported')
        const content = semanticDraft(supportsSemantic(input) ? input.draftSnapshot : current?.draft ?? persisted.draft)
        const text = content.text
        const semantic = content.references.length || content.command ? content : null
        if (current && current.draft !== text) fail('snapshot-editor-unsupported')
        const view = persisted.view || null
        if (!draftsOnly && view && view !== 'chat') fail('snapshot-panel-unsupported')
        if (input && !editable(input, semantic)) fail('snapshot-input-busy')
        if (current?.queue?.length) fail('snapshot-input-busy')
        if (current?.occurrences?.length && !supportsSemantic(input)) fail('snapshot-editor-unsupported')
        const session = ctx.sessions.binding(id)?.session
        if (session?.getSnapshot().pendingSubmissions?.length) fail('snapshot-input-busy')
        const editor = input?.editor
        if (input && ['getEditorState', 'parseEditorState', 'setEditorState', 'getRootElement', 'isComposing'].some(key => typeof editor?.[key] !== 'function')) fail('snapshot-editor-unsupported')
        if (input && typeof input.caretSpan !== 'function') fail('snapshot-editor-unsupported')
        if (editor?.isComposing()) fail('snapshot-input-busy')
        if (editor) roots.push(editor.getRootElement())
        revisions.push({id,input,value:canonical({content,attachmentIds:current?.attachmentIds || [],revision:current?.draftRev,updatedAt:list.byId[id]?.updatedAt})})
        const attachmentKeys = []
        if (current?.attachmentIds.length && typeof ctx.sessions.open !== 'function' && typeof ctx.sessions.retain !== 'function') fail('snapshot-adapter-unsupported')
        const attachments = ctx.conversation.resolveDraftAttachments(current?.attachmentIds || [])
        if (attachments.length !== (current?.attachmentIds.length || 0)) fail('snapshot-attachment-missing')
        for (const attachment of attachments) {
          if (attachment.kind === 'file' && ctx.conversation.fileUploads.getSnapshot()[attachment.id]?.status !== 'ready') fail('snapshot-upload-pending')
          const file = attachment.file
          if (!(file instanceof Blob)) fail('snapshot-attachment-missing')
          totalBytes += file.size
          if (totalBytes > 8 * 1024 * 1024 || assets.length >= 32) fail('snapshot-attachment-limit')
          const data = encode(new Uint8Array(await file.arrayBuffer())); check(signal)
          assets.push({ key: attachment.id, name: file.name, mediaType: file.type, lastModified: file.lastModified, size: file.size, data })
          attachmentKeys.push(attachment.id)
        }
        if (draftsOnly ? text || semantic || attachmentKeys.length : input || text || id === currentId) {
          if (!list.byId[id]) fail('snapshot-session-missing')
          const selection = !draftsOnly && input ? { ...input.caretSpan(), focused: Boolean(editor.getRootElement()?.contains(document.activeElement)) } : null
          const serialized = !draftsOnly && editor ? editor.getEditorState().toJSON() : null
          drafts.push({ sessionId: id, text, ...(semantic ? { semantic } : {}), editor: serialized?.root?.children?.length === 0 ? null : serialized, selection, attachmentKeys, revision: current?.draftRev || 0, view:draftsOnly ? null : view,
            ...(Number.isFinite(list.byId[id].updatedAt) ? { sessionUpdatedAt: list.byId[id].updatedAt } : {}) })
          if (input && !draftsOnly) {
            const saved = id === currentId ? getScroll(id) : null
            const held = chatFace(id).chatScroll.read()
            if (saved) scrolls.push(saved)
            else if (held) scrolls.push({ sessionId: id, anchor: held.anchorKey, offset: held.anchorTop, scrollTop: held.scrollTop, following: false })
          }
        }
      }
      if (!draftsOnly) validateFormCoverage(roots, providers, remoteApply, configurationRestore)
      if (draftsOnly) {
        const latest=ctx.sessions.list.getSnapshot()
        const latestIds=new Set(Object.keys(latest.byId))
        for(let index=0;index<localStorage.length;index++) {
          const key=localStorage.key(index);if(key?.startsWith('dsh.conversation.'))latestIds.add(key.slice('dsh.conversation.'.length))
        }
        if(canonical([...ids].sort())!==canonical([...latestIds].sort()))fail('snapshot-draft-changed')
        for (const revision of revisions) {
          const input=inputFor(revision.id), current=input?.state.getSnapshot(), persisted=readPersisted(revision.id)
          const content=semanticDraft(supportsSemantic(input) ? input.draftSnapshot : current?.draft ?? persisted.draft)
          if (input!==revision.input || revision.value!==canonical({content,attachmentIds:current?.attachmentIds || [],revision:current?.draftRev,updatedAt:latest.byId[revision.id]?.updatedAt})) fail('snapshot-draft-changed')
        }
      }
      check(signal)
      return { schemaVersion: 1, frontendVersion, page: { kind: 'dsh', route: location.pathname + location.hash, sessionId: draftsOnly ? null : currentId, workspaceId: draftsOnly ? null : workspaceFor(currentId) },
        drafts, assets, scrolls, dialogs, layout: draftsOnly ? {sidebar:0,narrowExpanded:false,rightbar:null,panel:null} : { sidebar: state.layoutInfo.sidebar, narrowExpanded: state.layoutInfo.narrowExpanded, rightbar: state.layoutInfo.rightbar, panel: state.panelInfo.activePanelId },
        capabilities: required, blocked: [], sessionStorage: {} }
    }

    async function restore(snapshot, { signal, frontendVersion, providers }) {
      const payload = snapshot.payload
      validateCapabilities()
      const frontendChanged = payload.frontendVersion !== versionOf(frontendVersion)
      if (frontendChanged && snapshot.restoreFrontendVersion !== versionOf(frontendVersion)) fail('snapshot-adapter-version')
      if (payload.schemaVersion !== 1) fail('snapshot-schema-unsupported')
      await wait(() => ctx.sessions.list.getSnapshot().phase === 'ready' && ctx.workspaces.list.getSnapshot().phase === 'ready', signal, 'snapshot-page-not-ready')
      if (snapshot.profileSwitches?.length) {
        const service = () => ctx.get?.('remote.desktopPlugins') || ctx.remote?.desktopPlugins
        await wait(() => typeof service()?.status === 'function', signal, 'backup-profile-verify')
        const deadline=Date.now()+10000
        for (;;) {
          check(signal)
          const reply=await service().status();check(signal)
          const rows=reply?.ok ? reply.value?.plugins : null
          if (Array.isArray(rows) && snapshot.profileSwitches.every(intent => {
            const matches=rows.filter(row=>row.patchId===intent.patchId && row.moduleName===intent.moduleName),row=matches[0]
            return matches.length===1 && !row.readOnlyReason && row.running===intent.enabled
              && row.phase===(intent.enabled?'active':'disabled') && row.application==='applied'
          })) break
          if (Date.now()>=deadline) fail('backup-profile-verify')
          await new Promise(resolve=>setTimeout(resolve,100))
        }
      }
      const list = ctx.sessions.list.getSnapshot()
      const originalPage = snapshot.draftsOnly ? currentSessionId(list) : null
      const originalLayout = snapshot.draftsOnly ? clone(layoutStore().getSnapshot()) : null
      if (payload.page.sessionId && !list.byId[payload.page.sessionId]) fail('snapshot-session-missing')
      if (payload.page.workspaceId && !ctx.workspaces.list.getSnapshot().items.some(w => w.workspaceId === payload.page.workspaceId)) fail('snapshot-workspace-missing')
      for (const draft of payload.drafts) if (!list.byId[draft.sessionId]) fail('snapshot-session-missing')
      if (!payload.page.sessionId && !canClearPage()) fail('snapshot-navigation-unsupported')
      for (const draft of payload.drafts) if (draft.semantic != null && semanticDraft(draft.semantic).text !== draft.text) fail('snapshot-editor-unsupported')
      for (const dialog of payload.dialogs) await wait(() => providers.get(dialog.id)?.version === dialog.version, signal, 'snapshot-form-unsupported')
      if (snapshot.coldRecovery) {
        for (const dialog of payload.dialogs) {
          const provider = providers.get(dialog.id)
          if (provider.preflightRestore) await provider.preflightRestore(clone(dialog.data), { signal })
          else fail('snapshot-provider-preflight')
          check(signal)
        }
        // Inspect every destination before changing any draft. Local draft
        // revisions reset on a new document; durable session timestamps guard
        // sends/removals, while content and explicit empty storage guard edits.
        for (const draft of payload.drafts) {
          check(signal)
          const persisted = readPersisted(draft.sessionId)
          const before = inputFor(draft.sessionId)
          const previous = semanticDraft(supportsSemantic(before) ? before.draftSnapshot : before?.state.getSnapshot().draft ?? persisted.draft)
          const wanted = semanticDraft(draft.semantic ?? draft.text)
          if (canonical(previous) !== canonical(wanted) && (previous.text || previous.references.length || previous.command
            || Object.hasOwn(persisted, 'draft'))) fail('snapshot-draft-conflict')
          if ((draft.text || draft.attachmentKeys.length) && (draft.sessionUpdatedAt == null
            || !Number.isFinite(list.byId[draft.sessionId].updatedAt)
            || list.byId[draft.sessionId].updatedAt !== draft.sessionUpdatedAt)) fail('snapshot-session-changed')
          retainDraft(draft.sessionId)
          openInput(draft.sessionId)
          await wait(() => Boolean(inputFor(draft.sessionId)), signal, 'snapshot-editor-missing')
          await frame(); check(signal)
          const input = inputFor(draft.sessionId), current = input.state.getSnapshot()
          const actual = semanticDraft(supportsSemantic(input) ? input.draftSnapshot : current.draft)
          if (canonical(actual) !== canonical(wanted) && (actual.text || actual.references.length || actual.command)) fail('snapshot-draft-conflict')
          if (current.queue?.length || !editable(input, actual) || input.editor.isComposing()
            || ctx.sessions.binding(draft.sessionId)?.session.getSnapshot().pendingSubmissions?.length) fail('snapshot-input-busy')
          for (const attachment of ctx.conversation.resolveDraftAttachments(current.attachmentIds)) {
            let matched = false
            for (const key of draft.attachmentKeys) {
              const asset = payload.assets.find(a => a.key === key)
              if (asset && await matchesAsset(attachment, asset, signal)) { matched = true; break }
            }
            if (!matched) fail('snapshot-attachment-conflict')
          }
        }
      }
      // All target IDs are validated before any writes. No create/send/submit verbs.
      for (const draft of payload.drafts) {
        check(signal)
        if (draft.attachmentKeys.length) retainDraft(draft.sessionId)
        openInput(draft.sessionId)
        await wait(() => Boolean(inputFor(draft.sessionId)), signal, 'snapshot-editor-missing')
        await frame(); check(signal)
        const input = inputFor(draft.sessionId)
        const semantic = draft.semantic == null ? null : semanticDraft(draft.semantic)
        if (semantic && !supportsSemantic(input)) fail('snapshot-editor-unsupported')
        if (!editable(input, supportsSemantic(input) ? semanticDraft(input.draftSnapshot) : null)) fail('snapshot-input-busy')
        // A package update may change Lexical's document schema. The plain draft
        // and attachment bytes are the portable representation across versions.
        if (semantic) {
          // DSH resolves the command's submit handler from its own registry;
          // restoring never submits the command or serializes that handler.
          input.setDraft(clone(semantic))
          await wait(() => canonical(semanticDraft(input.draftSnapshot)) === canonical(semantic), signal, 'snapshot-editor-verify')
        } else if (!frontendChanged && draft.editor !== null && draft.editor?.root?.children?.length !== 0) input.editor.setEditorState(input.editor.parseEditorState(JSON.stringify(draft.editor)))
        else input.setDraft(draft.text)
        const attachmentIds = []
        for (const key of draft.attachmentKeys) {
          check(signal)
          const asset = payload.assets.find(a => a.key === key)
          if (!asset) fail('snapshot-attachment-missing')
          const cacheKey = snapshot.snapshotId + ':' + draft.sessionId + ':' + key
          let attachment = installedAssets.get(cacheKey)
          if (!attachment || attachmentIds.includes(attachment.id)) {
            // Adapter hot reloads can lose their local cache. Match already
            // restored content, without trusting a filename or stale blob URL.
            for (const existing of ctx.conversation.resolveDraftAttachments(input.state.getSnapshot().attachmentIds)) {
              if (attachmentIds.includes(existing.id)) continue
              if (await matchesAsset(existing, asset, signal)) { attachment = existing; installedAssets.set(cacheKey, existing); break }
            }
          }
          if (!attachment || ctx.conversation.resolveDraftAttachments([attachment.id]).length !== 1) {
            const file = new File([decode(asset.data)], asset.name, { type: asset.mediaType, lastModified: asset.lastModified })
            if (file.size !== asset.size) fail('snapshot-attachment-missing')
            attachment = ctx.conversation.createDrafts(draft.sessionId, [file])[0]
            installedAssets.set(cacheKey, attachment)
          }
          attachmentIds.push(attachment.id)
        }
        const currentIds = input.state.getSnapshot().attachmentIds
        // addAttachments APPENDS, including duplicate IDs. Reconcile exactly;
        // retain any unexpected content and fail instead of silently discarding it.
        if (currentIds.some(id => !attachmentIds.includes(id))) fail('snapshot-attachment-conflict')
        if (JSON.stringify(currentIds) !== JSON.stringify(attachmentIds)) {
          for (const id of new Set(currentIds)) if (!input.removeAttachment(id)) fail('snapshot-input-busy')
          if (!input.addAttachments(attachmentIds)) fail('snapshot-input-busy')
        }
        await frame(); check(signal)
        if (input.state.getSnapshot().draft !== draft.text) fail('snapshot-editor-verify')
        await wait(() => attachmentIds.every(id => {
          const attachment = ctx.conversation.resolveDraftAttachments([id])[0]
          const status = ctx.conversation.fileUploads.getSnapshot()[id]?.status
          if (status === 'error') fail('snapshot-upload-pending')
          return attachment?.kind === 'image' || status === 'ready'
        }), signal, 'snapshot-upload-pending')
        if (JSON.stringify(input.state.getSnapshot().attachmentIds) !== JSON.stringify(attachmentIds)) fail('snapshot-attachment-verify')
        for (let index = 0; index < attachmentIds.length; index++) {
          if (!await matchesAsset(ctx.conversation.resolveDraftAttachments([attachmentIds[index]])[0], payload.assets.find(a => a.key === draft.attachmentKeys[index]), signal)) fail('snapshot-attachment-verify')
        }
      }
      check(signal)
      if (snapshot.draftsOnly) {
        if (originalPage) ctx.uiWorkspace.openSession(originalPage); else clearPage()
        const store=layoutStore(),layout=originalLayout.layoutInfo
        store.actions.setSidebar(layout.sidebar)
        if(layout.rightbar!==null)store.actions.setRightbar(layout.rightbar)
        if(store.getSnapshot().layoutInfo.narrowExpanded!==layout.narrowExpanded)store.actions.toggleSidebar()
        ctx.layout.selectPanel(originalLayout.panelInfo.activePanelId)
        return
      }
      if (payload.page.sessionId) ctx.uiWorkspace.openSession(payload.page.sessionId)
      else clearPage()
      const store = layoutStore()
      store.actions.setSidebar(payload.layout.sidebar)
      if (payload.layout.sidebar === 0 && store.getSnapshot().layoutInfo.sidebar !== 0) store.actions.toggleSidebar()
      if (payload.layout.rightbar !== null) store.actions.setRightbar(payload.layout.rightbar)
      if (store.getSnapshot().layoutInfo.narrowExpanded !== payload.layout.narrowExpanded) store.actions.toggleSidebar()
      ctx.layout.selectPanel(payload.layout.panel)
      history.replaceState(null, '', payload.page.route)
      await frame(); check(signal)
      for (const position of payload.scrolls) {
        const face = chatFace(position.sessionId)
        face.chatScroll.save(position.following ? null : { anchorKey: position.anchor, anchorTop: position.offset, scrollTop: position.scrollTop })
        if (position.sessionId !== payload.page.sessionId) continue
        const scroller = document.querySelector('[data-conversation-scroll]')
        if (!scroller) { if (position.anchor) fail('snapshot-scroll-missing'); continue }
        if (position.following) scroller.scrollTop = scroller.scrollHeight
        else {
          const findRow = () => [...scroller.querySelectorAll('[data-chat-anchor-key]')].find(el => el.getAttribute('data-chat-anchor-key') === position.anchor)
          const session = ctx.sessions.binding(position.sessionId).session
          let previousFirst, attempts = 0
          while (!findRow() && attempts++ < 60) {
            check(signal)
            await session.loadOlder(); await frame(); check(signal)
            const first = scroller.querySelector('[data-chat-anchor-key]')?.getAttribute('data-chat-anchor-key')
            if (first === previousFirst) break
            previousFirst = first
          }
          const row = findRow()
          if (!row) fail('snapshot-scroll-missing')
          scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - position.offset
        }
        scroller.dispatchEvent(new Event('scroll'))
      }
      const selected = payload.drafts.find(d => d.sessionId === payload.page.sessionId)
      if (selected) {
        setSelection(inputFor(selected.sessionId).editor, selected.selection)
        await frame(); check(signal)
        if (selected.selection?.focused) {
          const caret = inputFor(selected.sessionId).caretSpan()
          if (caret.start !== selected.selection.start || caret.end !== selected.selection.end) fail('snapshot-selection-verify')
        }
      }
      for (const dialog of payload.dialogs) {
        check(signal); await providers.get(dialog.id).restore(clone(dialog.data)); await frame(); check(signal)
        const restored = await providers.get(dialog.id).capture()
        if (canonical(restored) !== canonical(dialog.data)) fail('snapshot-dialog-verify')
      }
      check(signal)
    }
    /** Open one session by id, for deep links. */
    async function openDeepLink(sessionId) {
      const end = Date.now() + 10000
      while (ctx.sessions.list.getSnapshot().phase !== 'ready') {
        if (Date.now() > end) fail('deep-link-page-not-ready')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      // `sessions.open` throws synchronously on an id it does not list, so the
      // existence check is what turns a deleted or archived session into a
      // coded failure instead of an exception racing the menu that invoked it.
      if (!ctx.sessions.list.getSnapshot().byId[sessionId]) fail('deep-link-session-missing')
      // The same service call a sidebar row click makes: it selects the
      // session and closes the right panel, with no snapshot machinery involved.
      ctx.uiWorkspace.openSession(sessionId)
    }
    function inspectCapabilities() {
      const observation = {featureId:'ui-recovery',availability:'limited',implementation:'hybrid',pluginState:'enabled',
        reasonCodes:[window.__DSH_CREATE_DRAFT_CHECKPOINTS__ ? 'recovery-background-checkpoint-limits' : 'recovery-background-checkpoints-pending','ui-recovery-state-preflight-required'],evidence:['ui-snapshot-service-selector']}
      try {
        validateCapabilities()
        if (!canClearPage()) observation.reasonCodes.push('snapshot-navigation-unsupported')
      } catch (error) {
        observation.availability = 'unavailable'
        observation.reasonCodes = ['snapshot-adapter-unsupported','snapshot-layout-unsupported'].includes(error.message)
          ? [error.message] : ['snapshot-adapter-unsupported']
      }
      return observation
    }
    return { capture, restore, openDeepLink, dispose, inspectCapabilities, capabilities: () => required.slice() }
  }
})()
