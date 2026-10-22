// These selectors consume the execution adapters' own result objects. Version
// allowlists contribute evidence only; they never turn on a missing service.
export function terminalObservation(registeredType) {
  return { featureId:'terminal-dock', availability:'limited', implementation:registeredType ? 'hybrid' : 'desktop', pluginState:'enabled',
    reasonCodes:['terminal-processes-not-restored'], evidence:['registered-terminal-selector'] }
}
// The file editor uses this same selector before installing its close guard or
// registering renderers. A service name alone cannot certify safe editing.
export function fileEditorObservation(ctx) {
  const methods = [
    [ctx.remote?.desktopFileEditor, 'read'], [ctx.remote?.desktopFileEditor, 'save'],
    ...['inject','register','subscribe','entriesOfSlot','resolveStore'].map(key => [ctx.slots,key]),
    ...['removeAfterCleanup','tabsIn'].map(key => [ctx.sidebarRight,key]),
    [ctx.sidebarRight?.tabDomain,'occurrence'], [ctx.sidebarRight?.mounted,'getSnapshot'],
    [ctx.sidebarRight?.openTabs,'getSnapshot'], [ctx.sidebarRight?.openTabs,'subscribe'],
    [ctx.sidebarRight?.mounted,'subscribe'], [ctx.sessions,'scope'], [ctx.sessions?.list,'getSnapshot'],
  ]
  const available = methods.every(([owner,key]) => typeof owner?.[key] === 'function')
  return { featureId:'file-editor', availability:available ? 'limited' : 'unavailable', implementation:'hybrid', pluginState:'enabled',
    reasonCodes:available ? ['file-editor-text-resource-limits'] : ['file-editor-contract-unavailable'], evidence:['file-editor-service-selector'] }
}

export function selectedSession(ctx) {
  const list = ctx.sessions?.list?.getSnapshot?.()
  if (!list?.byId) throw Error('session-selection-contract')
  if ('current' in list) return list.current || null
  const selected = Object.entries(list.byId).filter(([,row]) => (row.retainedBy?.mainView ?? 0) > 0)
  if (selected.length > 1) throw Error('session-selection-ambiguous')
  return selected[0]?.[0] || null
}
export function changesContract(ctx) {
  return ['getCapabilities','listChanges','getFileDiff','getFileContext','listFileOperations','getOperationDiff','subscribeChanges','listCommits','getCommitDetails',
    'runGitAction','getGitContext','listGitBranches','switchGitBranch','generateCommitMessage','getGitOperation'].every(key => typeof ctx.remote?.desktopChanges?.[key] === 'function')
    && ['getSnapshot','subscribe'].every(key => typeof ctx.sessions?.list?.[key] === 'function')
}
export function changesObservation(ctx, capability, reason = null) {
  const base = {featureId:'session-changes-git',implementation:'desktop',pluginState:'enabled',evidence:['changes-service-selector']}
  if (!changesContract(ctx)) return {...base,availability:'unavailable',reasonCodes:['changes-contract-unavailable']}
  if (reason) return {...base,availability:'unknown',reasonCodes:[reason]}
  if (!capability || typeof capability.workspaceRoot !== 'string' || !capability.workspaceRoot || typeof capability.endpointId !== 'string'
    || !['session','working','staged'].every(source=>capability.supportedSources?.includes(source)) || !capability.supportedViews?.includes('history')
    || capability.gitContextVersion !== 1 || typeof capability.recordingCoverage !== 'string' || !['available','none','missing','error'].includes(capability.gitAvailability?.status)) {
    return {...base,availability:'unknown',reasonCodes:['changes-response-unrecognized']}
  }
  const codes = ['changes-recording-coverage-limited']
  const git = capability.gitAvailability.status
  if (git !== 'available') codes.push({'none':'changes-workspace-not-git','missing':'changes-git-missing','error':'changes-git-unavailable'}[git])
  return {...base,availability:'limited',reasonCodes:codes,evidence:[...base.evidence,'workspace-git-selector']}
}
export function watchChanges(ctx, reporter, events = null) {
  let disposed = false, request, selected
  const select = async () => {
    request?.abort()
    if (!changesContract(ctx)) return changesObservation(ctx)
    let id
    try { id=selectedSession(ctx) } catch { return changesObservation(ctx,null,'changes-session-ambiguous') }
    if (!id) return changesObservation(ctx,null,'changes-no-current-session')
    const own = new AbortController(); request = own
    const cancellation = new Promise((_,reject)=>own.signal.addEventListener('abort',()=>reject(Error('changes-query-interrupted')),{once:true}))
    const timeout = setTimeout(()=>own.abort(),16_000)
    try {
      const result = await Promise.race([ctx.remote.desktopChanges.getCapabilities(id,own.signal),cancellation])
      if (disposed || own.signal.aborted || selectedSession(ctx)!==id) return changesObservation(ctx,null,'changes-query-interrupted')
      return result?.ok ? changesObservation(ctx,result.value) : changesObservation(ctx,null,'changes-query-failed')
    } catch { return changesObservation(ctx,null,'changes-query-failed') }
    finally { clearTimeout(timeout) }
  }
  const off = reporter?.watch('session-changes-git',select)
  const changed = () => reporter?.recheck('session-changes-git')
  const sessionChanged = () => {
    let next
    try { next=selectedSession(ctx) } catch { next='ambiguous' }
    if (next!==selected) { selected=next; changed() }
  }
  try { selected=selectedSession(ctx) } catch { selected='ambiguous' }
  const offSession = ctx.sessions?.list?.subscribe?.(sessionChanged)
  events?.addEventListener('dsh-desktop:git-changed',changed)
  return () => { disposed=true;request?.abort();offSession?.();off?.();events?.removeEventListener('dsh-desktop:git-changed',changed) }
}

export function sessionNavigationContract(ctx) {
  return typeof ctx?.sessions?.list?.getSnapshot === 'function' && typeof ctx?.uiWorkspace?.openSession === 'function'
}
export function sessionLinksContract(ctx) {
  return sessionNavigationContract(ctx) && ['entries','inject','register','subscribe'].every(key=>typeof ctx?.slots?.[key]==='function')
}
export function sessionExportContract(ctx, controller) {
  return typeof ctx?.effect === 'function' && ['run','publish','fetcher','save'].every(key=>typeof controller?.[key]==='function')
    && typeof controller?.store?.getSnapshot === 'function'
}
export function sessionLinksExportObservation(links, exporting, native) {
  const linkReady=sessionLinksContract(links), exportReady=native && sessionExportContract(exporting?.ctx,exporting?.controller)
  return {featureId:'session-links-export',availability:linkReady || exportReady ? 'limited' : links || exporting ? 'unavailable' : 'unknown',
    implementation:'hybrid',pluginState:'enabled',reasonCodes:[
      linkReady ? 'session-link-target-preflight' : 'session-links-contract-unavailable',
      exportReady ? 'session-export-completion-preflight' : 'session-export-contract-unavailable',
    ],evidence:[...(linkReady ? ['session-link-navigation-selector']:[]),...(exportReady ? ['session-export-controller-selector']:[])]}
}
export function createSessionReporter(reporter, native) {
  let links, exporting
  const off=reporter.watch('session-links-export',()=>sessionLinksExportObservation(links?.ctx,exporting,native()))
  const bind = (kind,ctx,controller) => {
    const registration={ctx,controller}
    if (kind==='links') links=registration; else exporting=registration
    reporter.recheck('session-links-export')
    return () => {
      if ((kind==='links' ? links : exporting)!==registration) return
      if (kind==='links') links=undefined; else exporting=undefined
      reporter.recheck('session-links-export')
    }
  }
  return {sessionLinks:ctx=>bind('links',ctx),sessionExport:(ctx,controller)=>bind('export',ctx,controller),sessionExportContract,dispose:off}
}

export const CLIENT_FEATURES = ['terminal-dock','file-editor','ui-recovery','session-changes-git','session-links-export']
// Reevaluate live selectors on refresh. Unregistering an older adapter must not
// remove its replacement; failures must replace the last successful report.
export function createClientReporter(send) {
  const observations = new Map()
  const emit = async (id, registration) => {
    const revision = ++registration.revision
    const current = () => observations.get(id)===registration && revision===registration.revision
    let report
    try {
      const value=registration.selector()
      if (typeof value?.then==='function') {
        const settled=Promise.resolve(value).then(report=>({report}),()=>({report:{featureId:id,availability:'unknown',implementation:null,pluginState:'unknown',reasonCodes:['capability-selector-failed'],evidence:[]}}))
        if (current()) await send({featureId:id,availability:'checking',implementation:null,pluginState:'enabled',reasonCodes:[],evidence:[]})
        report = (await settled).report
      } else report=value
    }
    catch { report = {featureId:id,availability:'unknown',implementation:null,pluginState:'unknown',reasonCodes:['capability-selector-failed'],evidence:[]} }
    if (current() && report?.featureId === id) return send(report)
  }
  const start = (id,registration) => { void emit(id,registration).catch(()=>{}) }
  return {
    report(value) { if (!CLIENT_FEATURES.includes(value?.featureId)) return; const registration={selector:()=>value,revision:0}; observations.set(value.featureId,registration); start(value.featureId,registration) },
    watch(id, selector) {
      if (!CLIENT_FEATURES.includes(id) || typeof selector !== 'function') return () => {}
      const registration={selector,revision:0}
      observations.set(id,registration); start(id,registration)
      return () => {
        if (observations.get(id) !== registration) return
        observations.delete(id)
        Promise.resolve(send({featureId:id,availability:'unknown',implementation:null,pluginState:'unknown',reasonCodes:['feature-provider-unreported'],evidence:[]})).catch(()=>{})
      }
    },
    refresh() { return Promise.allSettled([...observations].map(([id,selector]) => emit(id,selector))) },
    recheck(id) { const registration=observations.get(id); if (registration) start(id,registration) },
    clear() { observations.clear() },
  }
}
export function pluginObservations(status) {
  const rows = status?.rows
  if (!Array.isArray(rows)) return []
  const appearance = rows.find(row=>row.id==='desktop-ui')
  const pluginState = !appearance ? 'unknown' : appearance.error || appearance.phase === 'failed' ? 'load-failed'
    : appearance.restart ? 'pending-restart' : appearance.enabled === false ? 'user-disabled' : 'enabled'
  const reports = [
    { featureId:'plugin-management', availability:status.managementAvailable ? 'available' : 'limited', implementation:'hybrid', pluginState:'enabled',
      reasonCodes:status.managementAvailable ? [] : ['profile-management-unavailable'], evidence:['plugin-control-status'] },
    { featureId:'appearance-settings', availability:pluginState==='load-failed' ? 'limited' : 'available', implementation:'hybrid', pluginState,
      reasonCodes:pluginState==='load-failed' ? ['optional-plugin-load-failed'] : [], evidence:['plugin-control-status'] },
  ]
  for (const [id,featureId] of [['desktop-sidebar-terminal','terminal-dock'],['desktop-sidebar-changes','session-changes-git'],['desktop-notify','window-notifications']]) {
    const row=rows.find(row=>row.id===id)
    if (!row) continue
    const pluginState=row.error || row.phase==='failed' ? 'load-failed' : row.restart ? 'pending-restart' : row.enabled===false ? 'user-disabled' : 'enabled'
    reports.push({featureId,availability:'unknown',implementation:'desktop',pluginState,
      reasonCodes:pluginState==='load-failed' ? ['optional-plugin-load-failed'] : [],evidence:['plugin-control-status']})
  }
  return reports
}
export function createPluginReporter(write = text => process.stdout.write(text), now = Date.now) {
  const last = new Map()
  return status => {
    for (const observation of pluginObservations(status)) {
      const text = JSON.stringify(observation), previous = last.get(observation.featureId)
      if (previous?.text === text && now() - previous.at < 60_000) continue
      last.set(observation.featureId, { text, at:now() })
      write('__DSH_CAPABILITY__ ' + text + '\n')
    }
  }
}
