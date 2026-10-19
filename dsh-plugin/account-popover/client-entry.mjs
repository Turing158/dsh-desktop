import { createAccountLauncher } from './view.mjs'
import { mountAccountPopover } from './mount.mjs'
import { mountAccountSettingsNavigation } from './settings-navigation.mjs'
import css from './style.css'

window.__ModuleLoader__.load({ id: '@dsh-desktop/account-popover', factory(require) {
  const React = require('react'), ReactDOM = require('react-dom')
  const ui = require('@deepseek-ai/dsh-client-ui-primitives')
  return { inject: ['slots', 'locale'], apply(ctx) {
    if (!ui.Modal || !ui.Button) return
    return ctx.slots.inject('settings.launcher', () => {
      const style = document.createElement('style')
      style.dataset.dshAccountStyle = ''
      style.textContent = css
      document.head.append(style)
      const unmount = mountAccountPopover(ctx.slots, Original => createAccountLauncher(React, ReactDOM, ui, Original))
      const restoreNavigation = mountAccountSettingsNavigation(ctx.locale)
      return () => { restoreNavigation(); unmount(); style.remove() }
    })
  } }
} })
