/** Exercise the adapter over the installed Cordis/settings provider, with temporary files. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { SettingsSchema as appearance } from './ui-client/index.js'
import { SettingsSchema as terminal } from './sidebar-terminal/index.js'

const bin = process.env.DSH_DESKTOP_DSH_BIN
  || (process.env.APPDATA && join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js'))
let runtime
if (bin && existsSync(bin)) {
  const previous = process.env.DSH_DESKTOP_DSH_BIN
  process.env.DSH_DESKTOP_DSH_BIN = bin
  try {
    const require = createRequire(bin)
    const { Context } = require('@deepseek-ai/cordis')
    const { default: Settings } = await import('./settings-compat.mjs')
    if (typeof Settings.prototype.writeDesktop === 'function') runtime = { Context, Settings }
  } finally {
    if (previous === undefined) delete process.env.DSH_DESKTOP_DSH_BIN
    else process.env.DSH_DESKTOP_DSH_BIN = previous
  }
}

async function fixture(t, seed) {
  if (!runtime) { t.skip('Requires an installed DSH 0.2 runtime'); return }
  const home = await mkdtemp(join(tmpdir(), 'dsh-settings-test-'))
  t.after(async () => {
    assert.equal(dirname(resolve(home)), resolve(tmpdir()))
    assert.ok(basename(home).startsWith('dsh-settings-test-'))
    await rm(home, { recursive: true, force: true })
  })
  if (seed) await writeFile(join(home, seed.name), seed.text)
  const ctx = new runtime.Context()
  ctx.provide('profileContext', { home, name: 'web' })
  ctx.provide('configEditor', { configuration: () => [] })
  // Isolate the adapter from the upstream one-time whole-profile importer.
  ctx.provide('loader', { await: () => new Promise(() => {}) })
  const settings = new runtime.Settings(ctx)
  settings.register('desktop-appearance', appearance)
  settings.register('desktop-terminal-dock', terminal)
  return { settings, home, file: join(home, 'desktop-settings.json'), ctx }
}

test('simultaneous namespace writes preserve both sections and publish only accepted values', async t => {
  const h = await fixture(t); if (!h) return
  const events = []
  h.ctx.on('settings/document-updated', ns => events.push([ns, h.settings.get(ns)]))
  await Promise.all([
    h.settings.mutate('desktop-appearance', [{ op: 'set', path: ['animation'], value: 'off' }], 0),
    h.settings.mutate('desktop-terminal-dock', [{ op: 'set', path: ['profileId'], value: 'cmd' }], 0),
  ])
  const disk = JSON.parse(await readFile(h.file, 'utf8'))
  assert.equal(disk.namespaces['desktop-appearance'].animation, 'off')
  assert.equal(disk.namespaces['desktop-terminal-dock'].profileId, 'cmd')
  assert.equal(events.length, 2)
  assert.equal(events[0][1].animation, 'off')
  assert.equal(events[1][1].profileId, 'cmd')
  assert.equal(h.settings.describe().find(row => row.ns === 'desktop-appearance').revision, 1)
})

test('stale, invalid and unknown-field mutations cannot overwrite saved preferences', async t => {
  const h = await fixture(t); if (!h) return
  await h.settings.update('desktop-appearance', { ui: 'vanilla' }, 0)
  const before = await readFile(h.file, 'utf8')
  await assert.rejects(h.settings.update('desktop-appearance', { ui: 'desktop' }, 0), { code: 'SETTINGS_CONFLICT' })
  await assert.rejects(h.settings.update('desktop-appearance', { ui: 'invalid' }, 1), /Invalid desktop settings/)
  await assert.rejects(h.settings.mutate('desktop-appearance', [{ op: 'set', path: ['__proto__'], value: {} }]), /Unknown desktop settings field/)
  await assert.rejects(h.settings.update('desktop-appearance', { unrelated: true }), /Unknown desktop settings field/)
  assert.equal(await readFile(h.file, 'utf8'), before)
  assert.equal(h.settings.get('desktop-appearance').ui, 'vanilla')
  // A refusal must not poison the shared write queue; clearing restores defaults.
  await h.settings.mutate('desktop-appearance', [{ op: 'unset', path: ['ui'] }], 1)
  assert.equal(h.settings.get('desktop-appearance').ui, 'desktop')
})

test('previously refused legacy migration recovers only desktop namespaces and leaves its backup intact', async t => {
  const legacy = 'desktop-appearance:\n  ui: vanilla\n  animation: off\ndesktop-terminal-dock:\n  profileId: cmd\n  position: right\nui-theme:\n  preference: dark\n'
  const h = await fixture(t, { name: 'settings.yaml.imported', text: legacy }); if (!h) return
  assert.equal(h.settings.get('desktop-appearance').ui, 'vanilla')
  assert.equal(h.settings.get('desktop-terminal-dock').profileId, 'cmd')
  await h.settings.update('desktop-appearance', { animation: 'on' })
  const disk = JSON.parse(await readFile(h.file, 'utf8'))
  assert.deepEqual(Object.keys(disk.namespaces).sort(), ['desktop-appearance', 'desktop-terminal-dock'])
  assert.equal(disk.namespaces['desktop-terminal-dock'].position, 'right')
  assert.equal(await readFile(join(h.home, 'settings.yaml.imported'), 'utf8'), legacy)
})

test('an unreadable settings document is preserved instead of overwritten with defaults', async t => {
  const broken = '{ incomplete'
  const h = await fixture(t, { name: 'desktop-settings.json', text: broken }); if (!h) return
  await assert.rejects(h.settings.update('desktop-appearance', { ui: 'vanilla' }))
  assert.equal(await readFile(h.file, 'utf8'), broken)
})


test('background settings validate images and percentage bounds, and persist independently', async t => {
  const image = 'data:image/png;base64,aGVsbG8='
  for (const value of [-1, 101, NaN, Infinity, '50']) {
    assert.equal(appearance.validate({ backgroundTransparency: value }), undefined)
    assert.equal(appearance.validate({ backgroundLeftTransparency: value }), undefined)
    assert.equal(appearance.validate({ backgroundLeftSurfaceTransparency: value }), undefined)
    assert.equal(appearance.validate({ backgroundNavigationSurfaceTransparency: value }), undefined)
  }
  for (const value of ['https://example.com/photo.png', 'data:image/svg+xml;base64,AAAA', 'url(x)', 'data:image/png;base64,AAA;']) {
    assert.equal(appearance.validate({ backgroundImage: value }), undefined)
  }
  assert.equal(appearance.validate({ backgroundRight: 'true' }), undefined)
  assert.equal(appearance.validate({ backgroundNavigation: 'true' }), undefined)
  assert.equal(appearance['~standard'].validate({ backgroundTransparency: 101 }).issues[0].path[0], 'backgroundTransparency')
  const h = await fixture(t)
  if (!h) return
  await h.settings.update('desktop-appearance', { backgroundImage: image, backgroundTransparency: 25, backgroundTitlebar: false, backgroundLeft: true, backgroundLeftTransparency: 60, backgroundChat: true })
  await h.settings.update('desktop-appearance', { animation: 'off', backgroundNavigation: false, backgroundNavigationSurfaceTransparency: 60 })
  const saved = JSON.parse(await readFile(h.file, 'utf8')).namespaces['desktop-appearance']
  assert.equal(saved.backgroundImage, image)
  assert.equal(saved.backgroundLeftTransparency, 60)
  assert.equal(saved.backgroundTitlebar, false)
  assert.equal(saved.backgroundNavigation, false)
  assert.equal(saved.backgroundNavigationSurfaceTransparency, 60)
  await h.settings.update('desktop-appearance', { backgroundImage: '' })
  assert.equal(h.settings.get('desktop-appearance').backgroundImage, '')
  assert.equal(h.settings.get('desktop-appearance').backgroundLeftTransparency, 60)
  assert.equal(h.settings.get('desktop-appearance').backgroundNavigation, false)
  assert.equal(h.settings.get('desktop-appearance').backgroundNavigationSurfaceTransparency, 60)
})
