import { readFileSync } from 'node:fs'

// Rust owns remote-control.json. Serve the UI styles even without desktop appearance.
export const name = 'desktop-remote-control'
export function apply(ctx) {
  ctx.on('webserver/index-inject', table => {
    const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
    table.push({ kind: 'style', placement: 'head', text: css.replace(/<\/style/gi, '<\\/style') })
  })
}
