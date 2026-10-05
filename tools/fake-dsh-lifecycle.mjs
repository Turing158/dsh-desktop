// Isolated lifecycle fixture: no credentials, model requests, or user settings.
// Delayed --version leaves a real boot page available for capture before spawn.
import { createServer } from 'node:http'
if (process.argv.includes('--version')) {
  setTimeout(() => { console.log('0.0.0-lifecycle-test'); process.exit(0) }, 1800)
} else {
  const server = createServer((_, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><title>Lifecycle fixture</title><p>Background ready</p><script>window.__DSH_UI_STATE__?.registerAdapter({restore:async()=>{},capture:async()=>{throw Error("snapshot-adapter-version")}})</script>')
  })
  server.listen(0, '127.0.0.1', () => console.log(`dsh web: http://127.0.0.1:${server.address().port}/`))
  for (const [delay, kind] of [[700, 'question'], [1100, 'task-end']]) {
    setTimeout(() => console.log('__DSH_NOTIFY__ ' + JSON.stringify({kind, title:'生命周期测试', body:kind, sessionId:'lifecycle-fixture'})), delay)
  }
}
