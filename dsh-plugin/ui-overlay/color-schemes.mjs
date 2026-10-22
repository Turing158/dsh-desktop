import { readFileSync } from 'node:fs'

/** Palette proposals selected for the application; Default supplies no overrides. */
export const colorSchemes = JSON.parse(readFileSync(new URL('./color-schemes.json', import.meta.url), 'utf8'))
export const colorSchemeIds = ['default', ...colorSchemes.map(scheme => scheme.id)]

export function normalizeColorScheme(value) {
  return colorSchemeIds.includes(value) ? value : 'default'
}

/** Use upstream semantic tokens, with selectors stronger than runtime body styles. */
export function colorSchemeStyles() {
  const rules = []
  for (const scheme of colorSchemes) {
    for (const mode of ['light', 'dark']) {
      const p = scheme[mode]
      const variables = {
        '--dsh-palette-canvas': p.canvas,
        '--dsh-palette-sidebar': p.sidebar,
        '--dsh-palette-panel': p.panel,
        '--dsh-palette-selection': p.selection,
        '--dsh-ui-accent': p.accent,
        '--dsw-alias-brand-primary': p.accent,
        '--dsw-alias-link': p.accent,
        '--dsw-alias-button-primary-fill': p.button,
        '--dsw-alias-button-primary-hover': p.button,
        '--dsw-alias-button-primary-dimmed': p.soft,
        '--dsw-alias-button-info-fill': p.button,
        '--dsw-alias-button-info-hover': p.button,
        '--dsw-alias-label-primary-foreground': p['on-button'],
        '--dsw-alias-bg-base': p.canvas,
        '--dsw-alias-bg-layer-1': p.panel,
        '--dsw-alias-bg-layer-2': p.panel,
        '--dsw-alias-bg-layer-3': p.panel,
        '--dsw-alias-bg-module-platform': p.panel,
        '--dsw-alias-bg-multi-select': p.selection,
        '--dsw-alias-bg-overlay': p.soft,
        '--dsw-alias-bg-document-preview': p.panel,
        '--dsw-alias-label-document-preview': p.ink,
        '--dsw-alias-bg-document-selection': p.selection,
        '--dsw-alias-label-primary': p.ink,
        '--dsw-alias-label-primary-bluish': p.ink,
        '--dsw-alias-label-primary-dimmed': p.muted,
        '--dsw-alias-label-secondary': p.muted,
        '--dsw-alias-label-tertiary': p.muted,
        '--dsw-alias-label-caption': p.muted,
        '--dsw-alias-border-l1': p.border,
        '--dsw-alias-border-l2': p.border,
        '--dsw-alias-border-l2-darkmode-thin': p.border,
        '--dsw-alias-border-l3': p.border,
        '--dsw-alias-border-l4': p.border,
        '--dsw-alias-interactive-bg-hover': p.selection,
        '--dsw-alias-interactive-bg-active': p.selection,
        '--dsw-alias-interactive-bg-hover-solid': p.selection,
        '--dsw-alias-interactive-bg-hover-accent': p.selection,
        '--dsw-alias-state-business-primary': p.accent,
        '--dsw-alias-state-business-tertiary': p.selection,
        '--dsw-specific-sidebar-fill': p.sidebar,
        '--dsw-specific-sidebar-nav-item-active-accent': p.selection,
        '--dsw-specific-sidebar-nav-item-active': p.selection,
        '--dsw-specific-sidebar-nav-item-hover': p.selection,
        '--dsw-specific-input-major': p.panel,
        '--dsw-specific-login-input': p.soft,
        '--dsw-specific-bubble': p.soft,
        '--dsw-specific-bubble-highlight': p.selection,
        '--dsw-specific-selector': p.soft,
        '--dsw-specific-tip': p.soft,
        '--dsh-menu-surface': p.panel,
        '--dsh-menu-accent': p.accent,
      }
      const selector = `html:not([data-dsh-ui='vanilla'])[data-dsh-color-scheme='${scheme.id}'] body${mode === 'dark' ? '[data-ds-dark-theme]' : ':not([data-ds-dark-theme])'}`
      rules.push(`${selector} {\n${Object.entries(variables).map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}`)
    }
  }
  const root = `html:not([data-dsh-ui='vanilla']):is(${colorSchemes.map(scheme => `[data-dsh-color-scheme='${scheme.id}']`).join(',')})`
  rules.push(`
${root} body :is([class*='_sidebarCol'], [data-slot='sidebar']) {
  --dsw-alias-bg-base: var(--dsh-palette-sidebar);
  --dsw-alias-bg-layer-1: var(--dsh-palette-sidebar);
}
${root} body [data-dsh-desktop='session-row'][aria-current='page'],
${root} body [data-dsh-desktop='session-row'][data-active],
${root} body [class*='_sessionRow'][class*='_selected'] {
  background: var(--dsh-palette-selection);
}
${root} body [data-dsh-desktop='composer'] {
  color: var(--dsw-alias-label-primary);
}
`)
  return rules.join('\n')
}
