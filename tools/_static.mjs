/**
 * TEMPORARY: a minimal static page on 127.0.0.1, used to observe the app's own
 * document-created title-bar script at real document-created timing.
 *
 * WHY 127.0.0.1 AND NOT A data: URL. `boot.js` refuses any origin that is not the
 * app's own protocol or its loopback server, so the page has to be served over
 * http from 127.0.0.1 for the bar to be willing to mount at all.
 */

import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 18080)

const PAGE = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>doc-created probe</title></head>
  <body>
    <h1>probe page</h1>
    <p>Nothing here but a body for the injected bar to attach to.</p>
  </body>
</html>
`

createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
}).listen(PORT, '127.0.0.1', () => {
  console.error(`[static] http://127.0.0.1:${PORT}/`)
})
