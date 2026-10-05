import { t, useLocale } from '../i18n/api.mjs'
// The upstream page exposes tab bodies only. Mount in the shared section,
// anchored by our own tab identity, so tab visibility never hides the prompt.
export function mountMarketplaceHeader(React, createRoot, Prompt) {
  let container = null, root = null
  const clear = () => { root?.unmount(); container?.remove(); root = null; container = null }
  const update = () => {
    const tab = document.querySelector('[data-shortcut-modal="settings"] [role="tab"][id$="-tab-desktop-builtins"]')
    const tabs = tab?.closest('[role="tablist"]')
    if (container?.isConnected && container.nextSibling === tabs) return
    clear()
    if (!tabs) return
    container = document.createElement('div')
    container.className = 'dshPlugins dshPlugins__marketplaceHeader'
    tabs.before(container)
    root = createRoot(container)
    root.render(React.createElement(Prompt))
  }
  const observer = new MutationObserver(update)
  observer.observe(document.body, { childList: true, subtree: true })
  update()
  return () => { observer.disconnect(); clear() }
}

export function createMarketplacePrompt(React, { useStatus, install, refresh, isBusy }) {
  const h = React.createElement
  return function MarketplacePrompt() {
      useLocale(React)
    const market = useStatus()?.marketplace
    if (!market || (market.installed && !market.error)) return null
    const checking = market.installed === null
    return h('section', { className: 'dshPlugins__marketplace', 'aria-label': t('插件市场') },
      h('div', { className: 'dshPlugins__marketplaceText' },
        h('strong', null, t('插件市场')),
        h('p', null, t('安装 dshmarket，浏览、搜索和安装社区插件。')),
        market.installing && h('p', { role: 'status' }, t('正在安装 dshmarket…')),
        market.error && h('p', { className: 'dshPlugins__error', role: 'alert' }, market.error),
        !market.available && h('p', null, t('当前宿主不提供插件安装服务。'))),
      !market.installed && h('button', { type: 'button', className: 'dshPlugins__restartButton',
        disabled: isBusy() || market.installing || !market.available,
        onClick: checking ? refresh : install },
        market.installing ? t('正在安装…') : checking ? t('重新检查') : market.error ? t('重试安装') : t('安装插件市场')))
  }
}
