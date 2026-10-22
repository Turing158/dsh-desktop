// The independent host row makes the client discoverable; notifications remain
// owned by desktop-notify even when there is no browser client.
export const name = 'desktop-ui-state'
export const inject = []
import { readFileSync } from 'node:fs'
export function apply(ctx) {
  ctx.inject?.(['webServer'],child=>child.on('webserver/index-inject',table=>{
    table.push({kind:'script',placement:'head',text:readFileSync(new URL('./checkpoints.js',import.meta.url),'utf8')})
  }))
}
