/**
 * Discover the title-bar client and publish its functional window chrome.
 * The optional desktop-ui plugin can be off while the title bar stays enabled.
 * Keep one CSS source, but load the marked chrome section independently.
 */
import { readFileSync } from 'node:fs'

const name = 'desktop-title-bar'
const inject = []

export function readTitleBarStyles() {
  const source = readFileSync(new URL('../ui-overlay/theme.css', import.meta.url), 'utf8')
  const begin = '/* dsh-titlebar:start */', end = '/* dsh-titlebar:end */'
  const start = source.indexOf(begin), finish = source.indexOf(end, start + begin.length)
  if (start < 0 || finish < 0) throw Error('Desktop title-bar styles are missing')
  return source.slice(start + begin.length, finish).replace(/<\/style/gi, '<\\/style')
}

function apply(ctx) {
  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'style', placement: 'head', text: readTitleBarStyles() })
    const theme = readFileSync(new URL('../ui-overlay/remote-theme.js', import.meta.url), 'utf8')
    table.push({ kind: 'script', placement: 'head', text: theme.replace(/<\/script/gi, '<\\/script') })
    // Runs after upstream's body bootstrap, before the client modules mount.
    table.push({ kind: 'script', placement: 'body', text: 'window.__DSH_REMOTE_THEME__?.boot()' })
  })
}

export { apply, inject, name }
