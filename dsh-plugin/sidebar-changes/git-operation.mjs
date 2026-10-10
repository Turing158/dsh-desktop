export const gitBusy = state => ['starting', 'generating', 'switching', 'staging', 'committing', 'pushing', 'recovering'].includes(state.phase)
export const gitDraftKey = context => JSON.stringify([context.endpointId, context.repositoryRoot, context.workspaceRoot, context.branch])
export async function gitQuery(remote, method, ...args) {
  const result = await remote[method](...args)
  if (result?.ok === false) throw result.error
  return result?.ok === true ? result.value : result
}

/** Shared by every mounted view of an endpoint/worktree; writes outlive the view. */
export function createGitOperation(remote, onChanged = () => {}) {
  let state = { phase: 'idle', action: null, commitId: '', message: '', error: null, context: null }
  const listeners = new Set(), drafts = new Map()
  const publish = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
  const errorState = error => ({ phase: 'error', error: { code: error?.details?.reason || (error?.code?.startsWith('git-') ? error.code : error?.message || 'git-failed'), detail: error?.details?.detail || error?.message || '' } })
  const finish = () => {
    if (state.phase === 'done' && state.context && state.action !== 'pushOnly') drafts.delete(gitDraftKey(state.context))
    onChanged()
  }
  const operation = {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    draft: context => drafts.get(gitDraftKey(context)) || '',
    saveDraft: (context, message) => drafts.set(gitDraftKey(context), message),
    reconcile(context) {
      if (state.phase === 'error' && state.commitId && state.context && gitDraftKey(context) === gitDraftKey(state.context)
        && (context.head !== state.commitId || JSON.stringify(context.target) !== JSON.stringify(state.context.target))) {
        publish({ commitId: '', error: { code: 'git-head-changed', detail: '' } })
      }
    },
    reset: () => { if (!gitBusy(state) && state.phase !== 'unknown') publish({ phase: 'idle', error: null, commitId: '', context: null }) },
    async recover() {
      if (!state.request || state.phase === 'recovering') return
      publish({ phase: 'recovering' })
      const { sessionId, revision } = state.request
      try {
        for (let attempt = 0; attempt < 120; attempt++) {
          const update = await gitQuery(remote, 'getGitOperation', sessionId, revision, new AbortController().signal)
          if (!gitBusy(update)) { publish({ ...update, action: state.request.displayAction || state.request.action }); finish(); return }
          if (update.commitId) publish({ commitId: update.commitId })
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      } catch { /* Keep the receipt and require explicit status recovery. Never replay a commit. */ }
      publish({ phase: 'unknown', error: { code: 'git-result-unknown', detail: '' } }); onChanged()
    },
    async switchBranch(sessionId, branch, context) {
      if (gitBusy(state) || state.phase === 'unknown') return null
      publish({ phase: 'switching', error: null, context, commitId: '' })
      try {
        const signal = new AbortController().signal
        if (!context.contextRevision) {
          const expected = context
          context = await gitQuery(remote, 'getGitContext', sessionId, expected.source, signal)
          if (context.endpointId !== expected.endpointId || context.workspaceRoot !== expected.workspaceRoot || context.source !== expected.source) throw Error('stale')
          publish({ context })
        }
        const value = await gitQuery(remote, 'switchGitBranch', sessionId, branch, context.contextRevision, signal)
        publish({ phase: 'idle', context: null }); return value
      } catch (error) { publish(errorState(error)); return null }
      finally { onChanged() }
    },
    async run(request) {
      if (gitBusy(state) || state.phase === 'unknown') return null
      const { sessionId, action, source, revision, committedId = '', context } = request
      let message = action === 'pushOnly' ? '' : request.message || '', writing = false
      publish({ action: request.displayAction || action, message, commitId: committedId, error: null, context: context || null, request,
        phase: !message.trim() && context && !committedId && ['commit', 'push'].includes(action) ? 'generating'
          : committedId || action === 'pushOnly' ? 'pushing' : source !== 'staged' ? 'staging' : 'committing' })
      try {
        if (message.length > 65536 || message.includes('\0')) throw Error('git-message')
        const signal = new AbortController().signal
        if (state.phase === 'generating') {
          if (!context.canGenerateMessage) throw Error('git-generation-unavailable')
          const generated = await gitQuery(remote, 'generateCommitMessage', sessionId, source, revision, signal)
          if (generated.contextRevision !== revision) throw Error('stale')
          // Never overwrite a newer draft saved by another view while the model was running.
          if (operation.draft(context) !== message) throw Error('stale')
          message = generated.message; operation.saveDraft(context, message)
          publish({ message, phase: source === 'staged' ? 'committing' : 'staging' })
        }
        writing = true
        for await (const update of remote.runGitAction(sessionId, action, source, revision, message, committedId, signal)) publish({ ...update, action: request.displayAction || action })
        if (gitBusy(state)) throw Error('git-result-unknown')
      } catch (error) {
        if (writing && context) {
          publish({ phase: 'unknown', error: { code: 'git-result-unknown', detail: '' } })
          await operation.recover()
        } else publish(errorState(error))
      } finally { finish() }
      return state
    },
  }
  return operation
}
