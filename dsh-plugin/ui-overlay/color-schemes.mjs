import { readFileSync } from 'node:fs'

/** Neutral content with gently tinted navigation, dialogs and controls; Default supplies no overrides. */
export const colorSchemes = JSON.parse(readFileSync(new URL('./color-schemes.json', import.meta.url), 'utf8'))
export const colorSchemeIds = ['default', ...colorSchemes.map(scheme => scheme.id)]

export function normalizeColorScheme(value) {
  return colorSchemeIds.includes(value) ? value : 'default'
}

function tintSurface(base, accent, amount) {
  return '#' + [1, 3, 5].map(offset => Math.round(
    parseInt(base.slice(offset, offset + 2), 16) * (1 - amount) +
    parseInt(accent.slice(offset, offset + 2), 16) * amount,
  ).toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** Use upstream semantic tokens, with selectors stronger than runtime body styles. */
export function colorSchemeStyles() {
  const rules = []
  for (const scheme of colorSchemes) {
    for (const mode of ['light', 'dark']) {
      const p = scheme[mode]
      // Large dialog surfaces need less color than the smaller control fills.
      const dialog = tintSurface(p['layer-2'], p.accent, mode === 'dark' ? .06 : .04)
      const control = tintSurface(p.panel, p.accent, mode === 'dark' ? .09 : .08)
      const controlSoft = tintSurface(p.soft, p.accent, mode === 'dark' ? .09 : .08)
      const controlHover = tintSurface(p.hover, p.accent, mode === 'dark' ? .12 : .08)
      const variables = {
        '--dsh-palette-canvas': p.canvas,
        '--dsh-palette-sidebar': p.sidebar,
        '--dsh-palette-sidebar-hover': p['sidebar-hover'],
        '--dsh-palette-sidebar-selection': p['sidebar-selection'],
        // Both navigation surfaces use one palette before applying region alpha.
        '--dsh-palette-titlebar': p.sidebar,
        '--dsh-palette-titlebar-hover': p['sidebar-hover'],
        '--dsh-palette-titlebar-selection': p['sidebar-selection'],
        '--dsh-palette-panel': p.panel,
        '--dsh-palette-selection': p.selection,
        '--dsh-palette-dialog': dialog,
        '--dsh-palette-control-soft': controlSoft,
        '--dsh-palette-control-hover': controlHover,
        '--dsh-ui-accent': p.accent,
        // Switches, slider fills and focus rings share this accent token.
        '--dsw-alias-brand-primary': p.accent,
        '--dsw-alias-link': p.accent,
        '--dsw-alias-button-primary-fill': p.button,
        '--dsw-alias-button-primary-hover': p['button-hover'],
        '--dsw-alias-button-primary-dimmed': p.soft,
        '--dsw-alias-button-info-fill': p.button,
        '--dsw-alias-button-info-hover': p['button-hover'],
        '--dsw-alias-button-elevated-fill': control,
        '--dsw-alias-button-floating-fill': control,
        '--dsw-alias-button-floating-hover': controlHover,
        '--dsw-alias-label-primary-foreground': p['on-button'],
        '--dsw-alias-bg-base': p.canvas,
        '--dsw-alias-bg-layer-1': p.panel,
        '--dsw-alias-bg-layer-2': p['layer-2'],
        '--dsw-alias-bg-layer-3': p['layer-3'],
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
        '--dsw-alias-interactive-bg-hover': p.hover,
        '--dsw-alias-interactive-bg-active': p.selection,
        '--dsw-alias-interactive-bg-hover-solid': p.hover,
        '--dsw-alias-interactive-bg-hover-accent': p.hover,
        '--dsw-alias-state-business-primary': p.accent,
        '--dsw-alias-state-business-tertiary': p.selection,
        '--dsw-specific-sidebar-fill': p.sidebar,
        '--dsw-specific-sidebar-nav-item-active-accent': p['sidebar-selection'],
        '--dsw-specific-sidebar-nav-item-active': p['sidebar-selection'],
        '--dsw-specific-sidebar-nav-item-hover': p['sidebar-hover'],
        '--dsw-specific-input-major': p.panel,
        '--dsw-specific-login-input': p.soft,
        '--dsw-specific-bubble': p.soft,
        '--dsw-specific-bubble-highlight': p.selection,
        '--dsw-specific-selector': controlSoft,
        '--dsw-specific-tip': p.soft,
        '--dsh-menu-surface': p['layer-2'],
        '--dsh-menu-accent': p.accent,
        // Keep glass from amplifying wallpaper colors or adding a bright rim.
        '--dsh-composer-glass-saturation': '100%',
        '--dsh-composer-glass-highlight': mode === 'dark' ? '8%' : '12%',
        '--dsh-composer-glass-shine': mode === 'dark' ? '16%' : '60%',
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
  --dsw-alias-interactive-bg-hover: var(--dsh-palette-sidebar-hover);
  --dsw-alias-interactive-bg-hover-solid: var(--dsh-palette-sidebar-hover);
  --dsw-alias-interactive-bg-hover-accent: var(--dsh-palette-sidebar-hover);
  --dsw-alias-interactive-bg-active: var(--dsh-palette-sidebar-selection);
}
/* Match the sidebar's base, hover and selected colors at every opacity. */
${root} body .dshTb {
  --dsw-specific-sidebar-fill: var(--dsh-palette-titlebar);
  --dsw-alias-interactive-bg-hover: var(--dsh-palette-titlebar-hover);
  --dsw-alias-interactive-bg-hover-solid: var(--dsh-palette-titlebar-hover);
  --dsw-alias-interactive-bg-hover-accent: var(--dsh-palette-titlebar-hover);
  --dsw-alias-interactive-bg-active: var(--dsh-palette-titlebar-selection);
}
${root} body [data-dsh-desktop='session-row'][aria-current='page'],
${root} body [data-dsh-desktop='session-row'][data-active],
${root} body [class*='_sessionRow'][class*='_selected'] {
  background: var(--dsh-palette-sidebar-selection);
}
${root} body [data-dsh-desktop='composer'] {
  color: var(--dsw-alias-label-primary);
}
/* Scope the tint to dialog panels so content, menus and masks keep their fills.
   The material styles use this same token with their own opacity and blur. */
${root} body :is([role='dialog'][aria-modal='true'], [role='dialog'][class*='_dialog_'], [role='alertdialog']):not([data-dsh-chrome='layer']):not(:has(> img)) {
  --dsw-alias-bg-layer-2: var(--dsh-palette-dialog);
}
${root} body :is([role='dialog'], [role='alertdialog']) button[class*='_outline_'] {
  background-color: var(--dsh-palette-control-soft);
}
${root} body :is([role='dialog'], [role='alertdialog']) button[class*='_outline_']:hover:not(:disabled) {
  background-color: var(--dsh-palette-control-hover);
}
`)
  return rules.join('\n')
}
