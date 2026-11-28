;(function () {
  'use strict'

  const listSelector = '[data-forge-review-list]'
  const missingCli = 'GitHub CLI (gh) was not found.'
  const installHint = '未找到 GitHub CLI（gh）。请在 PowerShell 运行 winget install --id GitHub.cli --exact，然后重启桌面应用。'
  const watched = new WeakSet()
  const translated = new WeakMap()
  const duplicates = new WeakSet()

  function sync(list) {
    const seen = new Set()
    for (const notice of list.querySelectorAll('[data-forge-review-section] > [role="status"]')) {
      const command = notice.querySelector('code')?.textContent
      let key = command?.startsWith('gh auth login --hostname ') ? command : null
      const text = notice.firstChild
      if (text?.nodeType === Node.TEXT_NODE && text === notice.lastChild &&
          (text.data.endsWith(missingCli) || text.data === translated.get(text))) {
        key = missingCli
        const message = window.__DSH_I18N__?.t(installHint) ?? installHint
        translated.set(text, message)
        if (text.data !== message) text.data = message
      }

      // The upstream notice uses display:flex and owns the login copy button.
      // Keep its first instance and leave React's children in place.
      if (key !== null && seen.has(key)) {
        if (!duplicates.has(notice)) {
          notice.style.setProperty('display', 'none', 'important')
          duplicates.add(notice)
        }
      } else {
        if (key !== null) seen.add(key)
        if (duplicates.delete(notice)) notice.style.removeProperty('display')
      }
    }
  }

  function watch(list) {
    if (watched.has(list)) return
    watched.add(list)
    new MutationObserver(() => sync(list)).observe(list, { childList: true, characterData: true, subtree: true })
    sync(list)
  }

  document.querySelectorAll(listSelector).forEach(watch)
  new MutationObserver(records => {
    for (const { target, addedNodes } of records) {
      if (target.closest?.(listSelector)) continue
      for (const node of addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE || !node.isConnected) continue
        if (node.matches(listSelector)) watch(node)
        else node.querySelectorAll(listSelector).forEach(watch)
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true })
  document.addEventListener('dsh-desktop:locale', () => document.querySelectorAll(listSelector).forEach(sync))
})()
