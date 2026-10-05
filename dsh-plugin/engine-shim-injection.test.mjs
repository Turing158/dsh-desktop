/**
 * The engine shims REACH the served page.
 *
 * `browser-compat.test.mjs` proves the shim script works; this proves it is
 * delivered, through the same `webserver/index-inject` seam the app mounts
 * (`desktop-ui.mjs`, with the config `desktop-notify.patch.yml` ships).
 *
 * Delivery is not a detail. Upstream renders head rows immediately after the
 * opening `<head>` tag, i.e. ahead of every script the shell's own index.html
 * carries, and `dsh-client-modules` imports the client plugin bundles only after
 * the app mounts — so a head row is early enough, and a body row pushed behind a
 * deferred module would not be. The phone failure this answers was a plugin
 * *import* throwing, so the shim has to be in place before the first import.
 *
 * These tests run the real `desktop-ui.mjs` against a stub context and read the
 * injection table it builds, which is the table upstream turns into markup.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply } from './desktop-ui.mjs'

/** The config `dsh-plugin/desktop-notify.patch.yml` mounts this plugin with. */
const SHIPPED_CONFIG = { css: true, dom: true, diag: true }

/**
 * Mount the host plugin over a stub context and collect the rows it injects.
 *
 * @param config - the plugin's row config.
 * @returns the collected injection table.
 */
function mount(config = SHIPPED_CONFIG) {
  const rows = []
  const ctx = {
    logger: { warn() {} },
    // The settings and diagnostics halves are other tests' business; what matters
    // here is that their absence cannot stop the injection from being registered.
    inject() {},
    get: () => undefined,
    on(event, handler) {
      if (event === 'webserver/index-inject') handler(rows)
    },
  }
  apply(ctx, config)
  return rows
}

test('the engine shim is injected as a head row, ahead of the body tier', () => {
  const rows = mount()
  const shim = rows.find(row => row.kind === 'script' && row.placement === 'head' && row.text.includes('installEngineShims'))
  assert.ok(shim, 'the browser-compat row carries the engine shim installer')
  // Both halves have to be in that one row: the page realm needs the globals, and
  // the worker realm — a blob module worker pdf.js builds from a string — is only
  // reachable through the seam this part wraps.
  assert.match(shim.text, /installBlobScriptShim/)
  assert.match(shim.text, /createObjectURL/)

  // placement: head is what puts it before the shell's own scripts; the DOM tier
  // rides in the body, so it must come later in the table.
  const bodyAt = rows.findIndex(row => row.placement === 'body')
  assert.ok(bodyAt > rows.indexOf(shim), 'the head row precedes every body row')

  // The row is the shipped file, not a transcription of it — and it is rendered by
  // string concatenation, so a `</script` inside it must be neutralised.
  const source = readFileSync(new URL('./ui-overlay/browser-compat.js', import.meta.url), 'utf8')
  assert.equal(shim.text, source.replace(/<\/script/gi, '<\\/script'))

  // The mode script is pushed first so 原版 is set before first paint; the shims
  // must not have displaced it.
  assert.equal(rows[0].kind, 'script')
  assert.match(rows[0].text, /data-dsh-ui/)
})

test('the shim row is injected in the shipped config, and re-rendering it is stable', () => {
  const first = mount()
  const second = mount()
  assert.deepEqual(second, first, 'the same config renders the same table')
  assert.ok(first.some(row => row.text.includes('installEngineShims')))
  // A page rendered in 原版 still gets the shims: upstream keeps the plugin loader
  // running there, and the document's own floor is unchanged.
  assert.ok(mount({ ...SHIPPED_CONFIG }).some(row => row.text.includes('installEngineShims')))
})
