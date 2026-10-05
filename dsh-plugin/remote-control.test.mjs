import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('./ui-remote/client.js', import.meta.url), 'utf8')
const cases = JSON.parse(readFileSync(new URL('./ui-remote/authority-cases.json', import.meta.url), 'utf8'))
function plugin() {
  let value
  const React = { createElement: (tag, props, ...children) => typeof tag === 'function' ? tag(props) : ({ tag, props, children }), useState: initial => [initial, () => {}], useEffect() {}, useRef: value => ({ current: value }) }
  const window = { __ModuleLoader__: { load({factory}) { value = factory(() => React) } } }; window.top = window
  vm.runInNewContext(source, { window, URL })
  return value
}
test('client rejects noncanonical authorities and preserves explicit default ports', () => {
  const { validateHost } = plugin()
  for (const text of cases.valid) assert.equal(validateHost(text), '', text)
  for (const text of [...cases.invalid, ...cases.policyInvalid, 'a'.repeat(254)]) assert.ok(validateHost(text), text)
})
test('shared authority corpus agrees with installed upstream canonical check', t => {
  const path = join(process.env.APPDATA || '', 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js')
  if (!existsSync(path)) return t.skip('No locally installed DSH')
  const source = readFileSync(path, 'utf8')
  const start = source.indexOf('function parseAuthority('), end = source.indexOf('function isTrustedApiRequest(')
  assert.ok(start > 0 && end > start)
  const upstream = vm.runInNewContext(source.slice(start, end) + '\nassertTrustedAuthority', { URL })
  for (const value of cases.valid) assert.doesNotThrow(() => upstream(value), value)
  for (const value of cases.invalid) assert.throws(() => upstream(value), value)
})
test('browser settings have only the desktop instruction and outside placeholder', () => {
  let component, row
  plugin().apply({ slots: { inject(_, fn) { fn() }, register(options, render) { row = options; component = render; return () => {} } } })
  assert.equal(row.id, 'remote-control'); assert.equal(row.order, 6)
  const tree = JSON.stringify(component())
  assert.match(tree, /请在电脑桌面应用中修改远程控制设置/)
  assert.match(tree, /待实现/)
  assert.doesNotMatch(tree, /"tag":"(?:input|button|select)"/)
  assert.doesNotMatch(tree, /Tailscale|隧道|端口映射/)
})
test('functional remote and mobile resources ship in the packaged overlay', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const patch = readFileSync(new URL('./desktop-notify.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /\.\/ui-remote\/index.js/)
  for (const file of ['ui-remote/package.json','ui-remote/index.js','ui-remote/client.js','ui-remote/style.css','ui-overlay/mobile.css','ui-overlay/browser-compat.js','ui-overlay/connection-note.js','runtime-import.mjs','lan-webserver.mjs','lan-web-runtime.mjs']) {
    assert.equal(config.bundle.resources['../dsh-plugin/'+file], 'dsh-plugin/'+file)
    assert.ok(readFileSync(new URL('./'+file, import.meta.url)).length)
  }
})
