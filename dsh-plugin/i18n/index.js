import { readFileSync } from 'node:fs'
export const inject = ['webServer']
export function apply(ctx) {
  ctx.on('webserver/index-inject', table => {
    const messages = readFileSync(new URL('./en.json', import.meta.url), 'utf8')
    const runtime = readFileSync(new URL('./runtime.js', import.meta.url), 'utf8')
    table.unshift({ kind: 'script', placement: 'head', text: ('window.__DSH_I18N_MESSAGES__ = ' + messages + ';\n' + runtime).replace(/<\/script/gi, '<\\/script') })
  })
}
