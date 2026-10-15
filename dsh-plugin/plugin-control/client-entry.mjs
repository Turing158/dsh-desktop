import { t, useLocale } from '../i18n/api.mjs'
import { observeChrome } from '../observe-chrome.mjs'
import { contribution } from './protocol.mjs'
import styles from './style.mjs'
import inventoryStyles from './inventory-style.mjs'
import { createInventoryView, renderPluginColumns } from './inventory-view.mjs'
import { createMarketplacePrompt, mountMarketplaceHeader } from './marketplace-view.mjs'

window.__ModuleLoader__.load({ id: '@dsh-desktop/plugin-control', factory(require) {
  const React = require('react'), h = React.createElement
  const { createRoot } = require('react-dom/client')
  const ui = require('@deepseek-ai/dsh-client-ui-primitives')
  const { Switch, Tag, StateDot, IconChevronDownOutlineRegular: Chevron } = ui
  const phases = { get active() { return t('运行中') }, get disabled() { return t('已关闭') }, get inactive() { return t('未运行') }, get pending() { return t('等待依赖') }, get loading() { return t('加载中') }, get failed() { return t('加载失败') }, get unloading() { return t('卸载中') } }
  const desktop = () => window.top === window && Boolean(window.__TAURI__?.core?.invoke)
  const errorText = error => error?.message || (typeof error === 'string' ? error : t('操作失败，请稍后重试'))
  const readOnlyText = reason => ({ 'management-required': t('基础服务，不支持在此修改'), 'unaddressable': t('无法唯一定位配置，暂不支持修改'),
    'management-unavailable': t('当前宿主不提供插件管理'), 'desktop-managed': t('由桌面插件设置统一管理'), 'preset': t('由 Agent 预设管理') })[reason] || reason
  const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, { ...args, identity: window.__DSH_REMOTE_IDENTITY__ })
  // Keep the last visible content through the closing transition. CSS owns the
  // motion preference: disabling it cancels the transitions and releases content
  // immediately, including when the preference changes halfway through a close.
  function Reveal({ open, children, id, className = '' }) {
    const element = React.useRef(null), lastContent = React.useRef(null)
    const [retained, setRetained] = React.useState(open)
    if (open) lastContent.current = children
    if (open && !retained) setRetained(true)
    React.useLayoutEffect(() => {
      element.current.inert = !open
      if (open) return
      let current = true
      const transitions = element.current.getAnimations({ subtree: true })
      const clear = () => { if (current) { lastContent.current = null; setRetained(false) } }
      if (transitions.length) Promise.allSettled(transitions.map(animation => animation.finished)).then(clear)
      else clear()
      return () => { current = false }
    }, [open])
    return h('div', { ref: element, id, className: 'dshPlugins__reveal ' + className,
      'data-open': open ? 'true' : undefined, 'aria-hidden': !open },
      h('div', { className: 'dshPlugins__revealClip' },
        h('div', { className: 'dshPlugins__revealContent' }, (open || retained) && lastContent.current)))
  }
  // The upstream settings shell owns its navigation label and heading. Rename
  // only their text nodes; leave its dictionaries, components and page content intact.
  function renameSettingsHeadings() {
    const changed = new Map()
    const update = () => {
      for (const node of changed.keys()) if (!node.isConnected) changed.delete(node)
      for (const element of document.querySelectorAll('[data-shortcut-modal="settings"] :is(button, h2)')) {
        if (element.getAttribute('role') === 'tab') continue
        if (element.textContent.trim() !== t('内置插件')) continue
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        for (let node; (node = walker.nextNode());) if (node.textContent.trim() === t('内置插件')) {
          changed.set(node, node.textContent)
          node.textContent = node.textContent.replace(t('内置插件'), t('插件'))
        }
      }
    }
    const observer = observeChrome('[data-shortcut-modal="settings"]', update, { characterData: true })
    update()
    return () => { observer.disconnect(); for (const [node, text] of changed) if (node.textContent.trim() === t('插件')) node.textContent = text }
  }
  function install(ctx) {
    if (window.__DSH_UI_BOOT__?.smoke) window.__DSH_PLUGIN_SMOKE_CONTEXT__ = ctx
    let snapshot = null, error = '', busy = false, disposed = false, polling = false, revision = 0
    let restarting = false, restartError = ''
    const listeners = new Set()
    const publish = () => listeners.forEach(fn => fn())
    const offRestart = desktop() ? window.__DSH_UI_STATE__?.registerRestartAdapter(() => window.__DSH_CREATE_UI_ADAPTER__?.(ctx)) : null
    async function call(method, ...args) {
      const result = await ctx.remote.desktopPlugins[method](...args)
      if (!result.ok) throw Error(result.error.message)
      return result.value
    }
    async function refresh() {
      if (busy || restarting || polling || disposed) return
      polling = true
      const current = revision
      try { const next = await call('status'); if (!disposed && current === revision) { snapshot = next; error = ''; publish() } }
      catch (e) { if (!disposed && current === revision) { error = errorText(e); publish() } }
      finally { polling = false }
    }
    async function change(id, enabled, source) {
      if (busy || restarting || snapshot?.marketplace?.installing) return
      revision++; busy = true; error = ''; restartError = ''; publish()
      try { snapshot = await call(source === 'profile' ? 'setPluginEnabled' : 'setEnabled', id, enabled) }
      catch (e) { error = errorText(e) }
      finally { busy = false; if (!disposed) publish() }
    }
    async function installMarketplace() {
      if (busy || restarting || snapshot?.marketplace?.installing) return
      revision++; busy = true; error = ''; publish()
      if (snapshot?.marketplace) { snapshot = { ...snapshot, marketplace: { ...snapshot.marketplace, installing: true, error: '' } }; publish() }
      try { snapshot = await call('installMarketplace') }
      catch (e) { error = errorText(e) }
      finally { busy = false; if (!disposed) { publish(); refresh() } }
    }
    async function restart() {
      if (busy || restarting || snapshot?.marketplace?.installing || !desktop() || !snapshot?.restartRequired) return
      revision++; restarting = true; restartError = ''; publish()
      const bridge = window.__DSH_UI_STATE__
      try {
        const status = await invoke('remote_status')
        if (!bridge?.prepareRemoteApply) throw Error(t('页面保存服务尚未准备好，请稍后重试'))
        const payload = await bridge.prepareRemoteApply(status.frontendVersion, t('正在保存界面并重启 DSH…'))
        await invoke('plugins_restart', { payload })
        // Controls stay locked until the new backend replaces this document.
      } catch (e) {
        bridge?.finishRemoteApply()
        restarting = false; restartError = errorText(e)
        if (!disposed) publish()
      }
    }
    function useStatus() {
      const [, rerender] = React.useState(0)
      React.useEffect(() => { const fn = () => rerender(n => n + 1); listeners.add(fn); fn(); return () => listeners.delete(fn) }, [])
      return snapshot
    }
    function RestartCard({ state }) {
      useLocale(React)
      const open = Boolean(state?.restartRequired)
      return h(Reveal, { open, className: 'dshPlugins__restartReveal' }, open &&
        h('section', { className: 'dshPlugins__restart', 'aria-label': t('待重启的插件变更') },
        h('div', { className: 'dshPlugins__restartText', role: 'status' },
          h('strong', null, restarting ? t('正在重启 DSH…') : t('重启 DSH 以应用更改')),
          h('p', null, [...[...state.rows, ...(state.plugins || []).map(displayRow)].filter(row => row.restart).map(row => t(row.label)),
            ...(state.marketplace?.restartRequired ? [t('dshmarket 插件市场')] : [])].join('、')),
          h('p', null, t('重启会中断 DSH 任务及其内置终端；草稿和附件会保留。')),
          !desktop() && h('p', null, t('请在电脑桌面应用中重启。')),
          restartError && h('p', { className: 'dshPlugins__error', role: 'alert' }, restartError)),
        h('button', { type: 'button', className: 'dshPlugins__restartButton', onClick: restart,
          disabled: busy || restarting || state?.marketplace?.installing || !desktop() }, restarting ? t('正在重启…') : t('重启 DSH'))))
    }
    function PluginCard({ row, open, toggle }) {
      useLocale(React)
      const detailId = 'dsh-plugin-details-' + row.id
      const failed = Boolean(row.error) || row.phase === 'failed'
      const stateText = row.error ? t('切换失败') : failed ? t('启动失败') : row.restart ? t('等待重启') : row.application === 'overridden' ? t('配置未生效')
        : row.conditional ? t('条件启用') : row.enabled ? t('已启用') : t('已停用')
      const tone = failed ? 'danger' : row.restart || row.application === 'overridden' || row.conditional ? 'warning' : 'neutral'
      const dot = (row.running ?? row.enabled) && ({ pending: 'idle', loading: 'ongoing', unloading: 'ongoing' })[row.phase]
      return h('li', { className: 'dshInventory__card', 'data-plugin-id': row.id, 'data-open': open ? 'true' : undefined,
        'data-switch': 'true', 'data-failed': failed ? 'true' : undefined },
        h('div', { className: 'dshInventory__cardHead' },
          h('button', { type: 'button', className: 'dshInventory__cardContent', onClick: toggle,
            'aria-expanded': open, 'aria-controls': detailId, 'aria-label': row.label + t('详情') },
            h('span', { className: 'dshInventory__cardMainRow' },
              h('strong', { className: 'dshInventory__cardTitle', title: row.label }, row.label),
              h('span', { className: 'dshInventory__cardTrailing' },
                dot && h('span', { className: 'dshInventory__phaseDot', role: 'img', 'aria-label': phases[row.phase], title: phases[row.phase] }, h(StateDot, { state: dot })),
                stateText !== t('已启用') && h(Tag, { tone }, stateText),
                h(Chevron, { size: 12, className: 'dshInventory__chevron', 'aria-hidden': true }))),
            h('span', { className: 'dshInventory__cardDescription' }, row.hint)),
          h('div', { className: 'dshInventory__cardSwitch' },
            row.source !== 'preset' && h(Switch, { checked: row.enabled, onChange: enabled => change(row.id, enabled, row.source), label: row.label,
              disabled: busy || restarting || snapshot?.marketplace?.installing || Boolean(row.readOnlyReason) }))),
        h(Reveal, { open, id: detailId }, h('div', { className: 'dshInventory__cardDetails' },
          h('dl', { className: 'dshInventory__details' },
            h('div', null, h('dt', null, t('运行状态')), h('dd', null, phases[row.phase] || row.phase)),
            h('div', null, h('dt', null, t('生效方式')), h('dd', null, row.readOnlyReason ? readOnlyText(row.readOnlyReason) : row.hot ? t('立即生效') : t('重启 DSH 后生效'))),
            row.moduleName && h('div', null, h('dt', null, t('模块')), h('dd', null, row.moduleName)),
            row.entryId && h('div', null, h('dt', null, t('条目')), h('dd', null, row.entryId)),
            row.version && h('div', null, h('dt', null, t('版本')), h('dd', null, row.version)),
            row.condition && h('div', null, h('dt', null, t('启用条件')), h('dd', null, row.condition))),
          row.hotReason && !row.readOnlyReason && h('p', { className: 'dshInventory__detailNote' }, row.hotReason),
          row.application === 'overridden' && h('p', { className: 'dshInventory__brokenNote' }, t('已保存设置与实际状态不一致，请检查父组、配置覆盖或启动诊断。')),
          row.meta?.error && h('p', { className: 'dshInventory__brokenNote' }, row.meta.error),
          row.restart && h('p', { className: 'dshInventory__detailNote' }, t('已保存，重启后生效。改回当前运行状态可取消。')))),
        row.error && h('p', { role: 'alert', className: 'dshInventory__brokenNote' }, row.error, ' ',
          h('button', { type: 'button', disabled: busy || restarting || snapshot?.marketplace?.installing || Boolean(row.readOnlyReason), onClick: () => change(row.id, row.enabled, row.source) }, t('重试切换'))))
    }
    function displayRow(row) {
      const resolveText = text => typeof text === 'string' ? text : text ? ctx.locale.resolveText(text) : ''
      const title = resolveText(row.meta?.title)
      const shortName = text => text?.replace(/^@[^/]+\//, '').replace(/^dsh-(?:client-|host-)?/, '')
      return { ...row, source: row.source || 'profile',
        label: (title && title !== row.moduleName && title !== row.packageName ? title : '')
          || (row.moduleName?.startsWith('file:') ? row.patchId || row.entryId || row.id : shortName(row.moduleName)) || row.id,
        hint: resolveText(row.meta?.description) || (row.readOnlyReason ? readOnlyText(row.readOnlyReason) : row.moduleName) }
    }
    function ClientSync() {
      useLocale(React)
      const store = ctx.modules.entries.state
      const state = React.useSyncExternalStore(fn => store.subscribe(fn), () => store.getSnapshot())
      return state.syncing ? h('p', { role: 'status' }, t('正在同步页面插件…')) : state.failures.length ?
        h('p', { className: 'dshPlugins__error', role: 'alert' }, t('页面插件同步失败，后端状态已单独显示。 '),
          h('button', { type: 'button', onClick: () => ctx.modules.entries.retry().catch(e => { error = errorText(e); publish() }) }, t('重试页面同步'))) : null
    }
    const Inventory = createInventoryView({ React, ui, useStatus, RestartCard, ClientSync, displayRow, change, refresh,
      feedback: () => error, isBusy: () => busy || restarting || snapshot?.marketplace?.installing, readOnlyText, phases, presetName: p => {
        const key = { standard: 'presetStandardName', ptc: 'presetPtcName', minimal: 'presetMinimalName', cordis: 'presetCordisName' }[p.id]
        return p.name ?? (key ? ctx.locale.bind('settings.agentPreset')(key) : p.id)
      }
    })
    const MarketplacePrompt = createMarketplacePrompt(React, { useStatus, install: installMarketplace, refresh, isBusy: () => busy || restarting })
    function Settings() {
      useLocale(React)
      const state = useStatus(), [expanded, setExpanded] = React.useState(null)
      return h('div', { className: 'dshPlugins dshInventory' },
        h('div', { className: 'dshPlugins__summary' },
          h('p', { className: 'dshPlugins__intro' }, t('开关会自动保存。支持热切换的插件立即生效，其余插件在重启 DSH 后生效。')),
          h(RestartCard, { state })),
        error && h('p', { role: 'alert', className: 'dshPlugins__error' }, error, ' ', h('button', { type: 'button', onClick: refresh, disabled: busy || restarting }, t('重试'))),
        !state ? h('p', { role: 'status' }, t('正在读取插件…')) : renderPluginColumns(h, state.rows.map(row => h(PluginCard, {
          key: row.id, row: { ...row, label: t(row.label), hint: t(row.hint) }, open: expanded === row.id, toggle: () => setExpanded(current => current === row.id ? null : row.id),
        }))),
        h('p', { className: 'dshPlugins__footnote' }, t('标题栏、界面状态恢复和基础服务始终启用。远程访问请在「远程控制」设置中开启或关闭。')))
    }
    const style = document.createElement('style')
    style.textContent = styles + inventoryStyles
    document.head.appendChild(style)
    const offSettings = ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'desktop-builtins', order: 5, label: () => t('内置插件') }, Settings))
    const offInventory = ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'all', order: 10, label: () => t('插件列表') }, Inventory))
    const offHeadings = renameSettingsHeadings()
    const offMarketplace = mountMarketplaceHeader(React, createRoot, MarketplacePrompt)
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => { disposed = true; clearInterval(timer); offMarketplace(); offHeadings(); offSettings(); offInventory(); offRestart?.(); style.remove(); listeners.clear() }
  }
  return { inject: ['slots', 'remote', 'sessions', 'workspaces', 'uiWorkspace', 'conversation', 'layout', 'locale', 'modules'], async apply(ctx) {
    const off = await ctx.remote.$mount(contribution)
    const fiber = ctx.inject(['remote.desktopPlugins'], install)
    return async () => { await fiber.dispose(); await off() }
  } }
} })
