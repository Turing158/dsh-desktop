import { t, useLocale } from '../i18n/api.mjs'
import { REASONS } from './shared/change-model.mjs'
import { createGitOperation, gitBusy, gitDraftKey, gitQuery } from './git-operation.mjs'
import { gitListStatistics } from './git-preview.mjs'

export function createGitActions(React, primitives) {
  const h = React.createElement
  const { Button, Menu, MenuItemButton, Modal, Tooltip, Toast, StateDot, IconChevronDownOutlineRegular: ChevronDown } = primitives
  const repositories = new WeakMap(), noop = () => {}
  const labels = () => ({ stage: t('暂存'), commit: t('提交'), push: t('提交并推送'), pushOnly: t('推送') })
  const phases = () => ({ generating: t('生成中…'), staging: t('暂存中…'), committing: t('提交中…'), pushing: t('推送中…'), switching: t('切换中…'), recovering: t('确认中…') })
  const complete = () => ({ stage: t('已暂存更改'), commit: t('已提交'), push: t('已提交并推送'), pushOnly: t('已推送') })
  const reason = error => REASONS[error?.code] || REASONS[error?.message] || error?.message || REASONS['git-failed']
  const BranchIcon = () => h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
    h('circle', { cx: 6, cy: 5, r: 2.5 }), h('circle', { cx: 6, cy: 19, r: 2.5 }), h('circle', { cx: 18, cy: 5, r: 2.5 }),
    h('path', { d: 'M6 7.5v9M18 7.5v2a5 5 0 0 1-5 5H6' }))
  const tip = (label, child, key) => h(Tooltip, { key, label, portal: true, side: 'bottom', maxWidth: 320 }, child)
  const loading = className => h('span', { className: 'dshChanges__gitLoading ' + (className || ''), role: 'status', 'aria-live': 'polite' },
    h(StateDot, { state: 'ongoing', size: 13 }), t('加载中…'))

  return function GitActions({ ctx, sessionId, capabilities, source, data, visible, onStaged, primaryAction = source === 'working' ? 'stage' : 'commit' }) {
    useLocale(React)
    const remote = ctx.remote.desktopChanges, available = capabilities?.gitAvailability?.status === 'available'
    const supported = capabilities?.gitContextVersion === 1
    const [menu, setMenu] = React.useState(false), [dialog, setDialog] = React.useState(false), [notice, setNotice] = React.useState(null)
    const [include, setInclude] = React.useState(source !== 'staged'), [context, setContext] = React.useState(null)
    const [preview, setPreview] = React.useState(null), [reuseList, setReuseList] = React.useState(true)
    const [draft, setDraft] = React.useState(''), [error, setError] = React.useState(null), [refresh, setRefresh] = React.useState(0)
    const [branchInfo, setBranchInfo] = React.useState(null), [branchMenu, setBranchMenu] = React.useState(false)
    const [branchLoading, setBranchLoading] = React.useState(true), [branchError, setBranchError] = React.useState(null)
    const [branchRefresh, setBranchRefresh] = React.useState(0), [contextLoading, setContextLoading] = React.useState(true)
    const mounted = React.useRef(true), requestVersion = React.useRef(0)
    const branchTrigger = React.useRef()
    const messageId = 'dsh-git-message-' + React.useId(), branchMenuClass = 'dshGitBranches-' + React.useId()
    const operation = React.useMemo(() => {
      let repos = repositories.get(ctx)
      if (!repos) { repos = new Map(); repositories.set(ctx, repos) }
      const key = JSON.stringify([capabilities?.endpointId, capabilities?.gitAvailability?.root])
      if (!repos.has(key)) repos.set(key, createGitOperation(remote, () => window.dispatchEvent(new Event('dsh-desktop:git-changed'))))
      return repos.get(key)
    }, [ctx, capabilities?.endpointId, capabilities?.gitAvailability?.root])
    const state = React.useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot)
    const busy = gitBusy(state), uncertain = state.phase === 'unknown', range = include ? 'working' : 'staged'
    const listStatistics = React.useMemo(() => reuseList ? gitListStatistics(data, sessionId, capabilities, range) : null,
      [data, sessionId, capabilities?.endpointId, capabilities?.workspaceRoot, range, reuseList])
    const savedPreview = preview?.sessionId === sessionId && preview.endpointId === capabilities?.endpointId
      && preview.workspaceRoot === capabilities?.workspaceRoot && preview.source === range ? preview : null
    const statistics = context || (listStatistics && listStatistics.listRevision !== savedPreview?.listRevision ? listStatistics : savedPreview || listStatistics)
    const branchPending = branchLoading && !branchInfo
    const draftScope = context || (branchInfo && available && { endpointId: capabilities.endpointId, repositoryRoot: capabilities.gitAvailability.root,
      workspaceRoot: capabilities.workspaceRoot, branch: branchInfo.branch })
    const draftKey = draftScope && gitDraftKey(draftScope)
    const sameDraft = context && state.context && gitDraftKey(context) === gitDraftKey(state.context)
    const retry = sameDraft && state.phase === 'error' && Boolean(state.commitId) && ['push', 'pushOnly'].includes(state.action)
    const done = sameDraft && state.phase === 'done'
    const locked = busy || uncertain || retry || done
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    React.useEffect(() => {
      requestVersion.current++; setDialog(false); setMenu(false); setBranchMenu(false); setContext(null); setDraft(''); setError(null)
      setPreview(null); setReuseList(true)
      setBranchInfo(null); setBranchError(null); setBranchLoading(true); setContextLoading(true)
    }, [operation, sessionId, capabilities?.workspaceRoot])
    React.useEffect(() => {
      if (!dialog || !supported || busy) return
      const own = new AbortController(), version = ++requestVersion.current
      setContext(null); setContextLoading(true)
      gitQuery(remote, 'getGitContext', sessionId, range, own.signal).then(value => {
        if (own.signal.aborted || version !== requestVersion.current) return
        if (value.endpointId !== capabilities.endpointId || value.workspaceRoot !== capabilities.workspaceRoot || value.source !== range) return
        operation.reconcile(value); setError(null); setContext(value); setReuseList(true)
        setPreview({ ...value, sessionId, listRevision: data?.revision })
      }).catch(failure => { if (!own.signal.aborted && version === requestVersion.current) setError(failure) })
        .finally(() => { if (!own.signal.aborted && version === requestVersion.current) setContextLoading(false) })
      return () => own.abort()
    }, [dialog, supported, sessionId, range, refresh, operation, busy, data?.revision])
    React.useEffect(() => {
      if (!available || !visible || !supported || busy) return
      const own = new AbortController()
      setBranchLoading(true); setBranchError(null)
      // Read branches with the changes view; opening the dialog can reuse them.
      gitQuery(remote, 'listGitBranches', sessionId, own.signal).then(value => {
        if (!own.signal.aborted) setBranchInfo(value)
      }).catch(failure => { if (!own.signal.aborted) setBranchError(failure) })
        .finally(() => { if (!own.signal.aborted) setBranchLoading(false) })
      return () => own.abort()
    }, [available, visible, supported, operation, sessionId, capabilities?.workspaceRoot, branchRefresh, busy])
    React.useEffect(() => {
      if (!visible || !supported) return
      const refreshContext = () => {
        if (!document.hidden) { setRefresh(value => value + 1); setBranchRefresh(value => value + 1) }
      }
      window.addEventListener('focus', refreshContext); window.addEventListener('dsh-desktop:git-changed', refreshContext)
      document.addEventListener('visibilitychange', refreshContext)
      return () => { window.removeEventListener('focus', refreshContext); window.removeEventListener('dsh-desktop:git-changed', refreshContext); document.removeEventListener('visibilitychange', refreshContext) }
    }, [visible, supported])
    React.useEffect(() => { if (draftScope) setDraft(operation.draft(draftScope)) }, [operation, draftKey])
    React.useEffect(() => { if (sameDraft && state.message && busy) setDraft(state.message) }, [state.message, busy, sameDraft])
    React.useEffect(() => { if (!visible || busy) { setMenu(false); setBranchMenu(false) } }, [visible, busy])
    React.useEffect(() => {
      if (!branchMenu) return
      const frame = requestAnimationFrame(() => {
        const list = document.getElementsByClassName(branchMenuClass)[0]
        if (document.activeElement === branchTrigger.current || document.activeElement === list) {
          list?.querySelector('[role="menuitem"]:not(:disabled)')?.focus()
        }
      })
      return () => cancelAnimationFrame(frame)
    }, [branchMenu, branchInfo, branchLoading, branchError])
    if (!available || !visible) return null

    const activate = action => {
      if (gitBusy(operation.getSnapshot())) return
      setMenu(false); setError(null)
      if (action === 'stage') {
        if (!data || uncertain) return
        void operation.run({ sessionId, action, source, revision: data.revision }).then(result => {
          if (!mounted.current || result?.phase !== 'done') return
          setNotice(complete().stage); onStaged?.()
        }); return
      }
      if (!supported) { setError({ code: 'git-upgrade-required' }); return }
      if (state.phase === 'done') operation.reset()
      const restoreRange = state.commitId && state.phase === 'error' && state.context?.workspaceRoot === capabilities.workspaceRoot
      setInclude(restoreRange ? state.context.source === 'working' : source !== 'staged'); setContext(null); setContextLoading(true)
      if (draftScope) setDraft(operation.draft(draftScope))
      setDialog(true); setRefresh(value => value + 1)
    }
    const run = action => {
      if (!context || gitBusy(operation.getSnapshot()) || uncertain || done) return
      const retrying = retry && action === state.action
      if (retry && !retrying) return
      if (!retrying && (action === 'pushOnly' ? !context.canPush : !context.hasCommittableChanges || action === 'push' && !context.canPushAfterCommit || !draft.trim() && !context.canGenerateMessage)) return
      setError(null); setBranchMenu(false)
      const saved = retrying ? state.context : context
      void operation.run({ sessionId, action: retrying && action === 'pushOnly' ? 'push' : action, displayAction: action, source: saved.source,
        revision: saved.contextRevision, message: retrying ? state.message : draft, committedId: retrying ? state.commitId : '', context: saved })
    }
    const close = () => { if (!gitBusy(operation.getSnapshot())) { setBranchMenu(false); setDialog(false) } }
    const reloadBranches = () => {
      branchTrigger.current?.focus({ preventScroll: true })
      setBranchError(null); setBranchLoading(true); setBranchRefresh(value => value + 1)
    }
    const openBranches = () => {
      if (locked) return
      if (branchMenu) { setBranchMenu(false); return }
      // Open synchronously. The same request can finish while the menu is closed,
      // but its response never opens the menu or steals focus from another view.
      setBranchMenu(true)
      if (!branchLoading) reloadBranches()
    }
    const chooseBranch = async branch => {
      setBranchMenu(false)
      if (locked || branch === (branchInfo ? branchInfo.branch : context?.branch)) return
      setError(null); setContext(null); setContextLoading(true); setPreview(null); setReuseList(false)
      await operation.switchBranch(sessionId, branch, context || {
        endpointId: capabilities.endpointId, workspaceRoot: capabilities.workspaceRoot, source: range,
      })
      if (mounted.current) setRefresh(value => value + 1)
    }
    const shownError = error || (sameDraft || !dialog || state.context == null ? state.error : null)
    const branchLabel = branchInfo ? branchInfo.branch || t('分离 HEAD') : context ? context.branch || t('分离 HEAD')
      : branchError ? t('分支读取失败') : t('加载中…')
    const block = busy || uncertain || !context || done
    const actionButton = action => {
      const ownRetry = retry && action === state.action, active = busy && state.action === action
      const disabled = block || retry && !ownRetry || (!ownRetry && (action === 'pushOnly' ? !context?.canPush
        : !context?.hasCommittableChanges || action === 'push' && !context?.canPushAfterCommit || !draft.trim() && !context?.canGenerateMessage))
      const title = ownRetry ? t('重试推送') : active ? phases()[state.phase] || t('处理中…') : labels()[action]
      const hint = ownRetry ? t('本次提交已保存，重试不会创建新的提交。') : action === 'pushOnly' ? REASONS[context?.pushReason]
        : REASONS[context?.commitReason] || (action === 'push' && REASONS[context?.pushReason]) || (!draft.trim() && !context?.canGenerateMessage ? t('请填写提交信息') : '')
      return tip(hint || title, h('span', { className: 'dshChanges__gitActionSlot' }, h(Button, {
        size: 'sm', type: 'button', className: 'dshChanges__gitSubmit', 'data-preferred': action === 'commit' && !retry || ownRetry,
        disabled, 'aria-busy': active, onClick: () => run(action),
      }, active && h(StateDot, { state: 'ongoing', size: 12 }), title)), action)
    }
    const errorContent = shownError && h('div', { className: 'dshChanges__gitError', role: 'alert' },
      retry && h('p', null, state.action === 'pushOnly' ? t('推送失败') : t('提交已保存 · 推送失败')),
      h('p', null, reason(shownError)), shownError.detail && shownError.detail !== reason(shownError) && h('pre', null, shownError.detail),
      !dialog && !busy && !uncertain && h(Button, { size: 'sm', onClick: () => { setError(null); operation.dismissError() } }, t('关闭')))
    return h(React.Fragment, null,
      h('div', { className: 'dshChanges__gitActions', role: 'group', 'aria-label': t('Git 操作') },
        h(Button, { size: 'sm', className: 'dshChanges__gitPrimary', disabled: busy || primaryAction === 'stage' && (!data || uncertain),
          'aria-busy': busy, onClick: () => activate(primaryAction) }, busy ? h(StateDot, { state: 'ongoing', size: 16 }) : labels()[primaryAction]),
        h(Menu, { open: menu && !busy, portal: true, compact: true, autoFocus: true, align: 'end',
          className: 'dshChanges__gitMenuAnchor', listClassName: 'dshChanges__gitMenu', onClose: () => setMenu(false), onSelect: activate,
          items: ['stage', 'commit', 'push'].filter(id => id !== primaryAction && (source !== 'staged' || id !== 'stage')).map(id => ({ id, label: labels()[id], disabled: id === 'stage' && uncertain })),
          anchor: h(Button, { size: 'sm', className: 'dshChanges__gitToggle', disabled: busy, 'aria-label': t('更多 Git 操作'),
            'aria-haspopup': 'menu', 'aria-expanded': menu, onClick: () => setMenu(value => !value), onKeyDown: event => {
              if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setMenu(true) }
            } }, h(ChevronDown, { size: 12 })) })),
      dialog && h(Modal, { open: true, headless: true, title: t('提交与推送'), onClose: busy ? noop : close, className: 'dshChanges__gitDialog',
        onKeyDownCapture: event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent?.isComposing && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault(); run(event.shiftKey ? 'push' : 'commit')
          }
        } },
        h('div', { className: 'dshChanges__gitTop', 'aria-busy': contextLoading || branchLoading },
          h(Menu, { open: branchMenu, portal: true, compact: true, autoFocus: true, selectedId: branchInfo ? branchInfo.branch : context?.branch,
            className: 'dshChanges__gitBranchPicker', listClassName: 'dshChanges__gitBranchMenu ' + branchMenuClass,
            onClose: () => setBranchMenu(false), onSelect: chooseBranch,
            items: !branchInfo && (branchLoading || branchError) ? [] : branchInfo?.branches?.length
              ? branchInfo.branches.map(branch => ({ id: branch.name, label: branch.name, disabled: branch.disabled || locked }))
              : [{ id: '', label: t('暂无本地分支'), disabled: true }],
            children: branchPending ? loading('dshChanges__gitBranchLoading') : branchError
              ? h(React.Fragment, null, h('div', { className: 'dshChanges__gitBranchError', role: 'alert' }, reason(branchError)),
                h(MenuItemButton, { onSelect: reloadBranches }, t('重试')))
              : null,
            anchor: tip(branchLabel, h(Button, { ref: branchTrigger, size: 'sm', className: 'dshChanges__gitBranch', disabled: locked,
              'aria-busy': branchLoading,
              'aria-label': t('切换分支：{branch}', { branch: branchLabel }), 'aria-haspopup': 'menu', 'aria-expanded': branchMenu, onClick: openBranches,
              onKeyDown: event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); openBranches() } },
            }, branchPending ? h(StateDot, { state: 'ongoing', size: 13 }) : h(BranchIcon), h('span', { className: 'dshChanges__gitBranchName' }, branchLabel), h(ChevronDown, { size: 12 }))) }),
          contextLoading && !statistics ? loading('dshChanges__gitStatsLoading') : tip(statistics?.statisticsComplete ? t('预计提交的行数变化') : t('仅统计可比较的文本，部分更改无法按行计算。'),
            h('span', { className: 'dshChanges__gitStats', tabIndex: 0, 'aria-busy': contextLoading }, h('span', null, '+' + (statistics?.added ?? '—')), h('span', null, '-' + (statistics?.removed ?? '—')))),
          h('label', { className: 'dshChanges__gitScope' }, h('input', { type: 'checkbox', checked: include, disabled: locked,
            onChange: event => { setContext(null); setContextLoading(true); setError(null); setInclude(event.target.checked) } }), t('含未暂存'))),
        h('div', { className: 'dshChanges__gitMessageArea' },
          h('label', { htmlFor: messageId, className: 'dshChanges__gitSrOnly' }, t('提交信息')),
          h('textarea', { id: messageId, className: 'dshChanges__gitMessage', value: draft, readOnly: locked || !draftScope, rows: 3, maxLength: 65536,
            'data-modal-autofocus': '', placeholder: context?.canGenerateMessage ? t('提交信息（可留空）') : t('请填写提交信息'),
            onChange: event => { const value = event.target.value; setDraft(value); if (draftScope) operation.saveDraft(draftScope, value) } })),
        errorContent,
        done && h('p', { className: 'dshChanges__gitSuccess', role: 'status' }, complete()[state.action]),
        uncertain ? h(Button, { size: 'sm', onClick: () => operation.recover() }, t('重新检查状态'))
          : done ? h('div', { className: 'dshChanges__gitFooter' }, h(Button, { size: 'sm', className: 'dshChanges__gitSubmit', onClick: close }, t('完成')))
          : h('div', { className: 'dshChanges__gitFooter' }, ...['commit', 'push', 'pushOnly'].map(actionButton))),
      !dialog && errorContent,
      notice && h(Toast, { text: notice, onDone: () => setNotice(null) }))
  }
}
