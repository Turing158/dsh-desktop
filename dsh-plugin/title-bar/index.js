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
  })
}

export { apply, inject, name }
