/** Hide the duplicate account page while the desktop account surface is enabled. */
export function mountAccountSettingsNavigation(locale, doc = document) {
  const marker = 'data-dsh-account-settings-hidden'
  const t = locale.bind('settings.account')
  let nav
  const observer = new MutationObserver(sync)

  function observe() {
    observer.disconnect()
    // Settings is a body portal. Observe its navigation only, not chat streaming.
    observer.observe(doc.body, { childList: true })
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-dsh-ui'] })
    if (nav) observer.observe(nav, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['aria-current'],
    })
  }

  function sync() {
    const next = doc.querySelector('[data-shortcut-modal="settings"] nav')
    if (nav !== next) { nav = next; observe() }
    if (!nav) return
    const desktop = doc.documentElement.getAttribute('data-dsh-ui') !== 'vanilla'
    const buttons = [...nav.querySelectorAll('button')]
    const account = buttons.find(button => button.textContent.trim() === t('nav'))
    const hadFocus = account?.contains(doc.activeElement)
    for (const button of buttons) {
      button.toggleAttribute(marker, desktop && button === account)
    }
    if (!desktop || !account) return
    // Keep the native settings state and routing: selecting another page also
    // handles reopening settings with a previously selected account section.
    const fallback = buttons.find(button => button !== account && !button.disabled && !button.hidden)
    if (account.getAttribute('aria-current') === 'true' && fallback) {
      fallback.click()
      if (hadFocus) fallback.focus({ preventScroll: true })
    }
  }

  observe()
  sync()
  return () => {
    observer.disconnect()
    doc.querySelectorAll(`[${marker}]`).forEach(button => button.removeAttribute(marker))
  }
}
