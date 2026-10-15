import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./ui-overlay/dom.js', import.meta.url), 'utf8')
const actions = source.slice(source.indexOf('  function attachmentImageFilename'), source.indexOf('  function openAttachmentImageMenu'))
const menuAction = source.slice(source.indexOf('  function openAttachmentImageMenu'), source.indexOf('  /** Text operations preserve'))
function fixture(overrides = {}) {
  const messages = []
  const sandbox = { window: {}, navigator: {}, URL, Blob, Image: class {},
    FileReader: class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then(buffer => {
          this.result = 'data:' + blob.type + ';base64,' + Buffer.from(buffer).toString('base64')
          this.onload()
        })
      }
    },
    showDesktopToast: (...args) => messages.push(args),
    t: (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]), ...overrides }
  vm.runInNewContext(actions, sandbox)
  return { ...sandbox, messages }
}

test('image filenames retain original extensions and remove path and invalid characters', () => {
  const f = fixture()
  assert.equal(f.attachmentImageFilename('透明图片.PNG', 'image/png'), '透明图片.PNG')
  assert.equal(f.attachmentImageFilename('C:\\images\\photo.jpg', 'image/jpeg'), 'photo.jpg')
  assert.equal(f.attachmentImageFilename('../album/a:b?', 'image/webp'), 'a_b_.webp')
  assert.equal(f.attachmentImageFilename('..', 'image/gif'), 'image.gif')
})

test('desktop copy works without browser clipboard APIs and propagates native errors', async () => {
  const image = new Blob([new Uint8Array([0, 1, 255])], { type: 'image/png' }), calls = []
  const api = { invoke: async (command, args) => calls.push({ command, args }) }
  const f = fixture({ window: { __TAURI__: { core: api } } })
  await f.copyAttachmentImage(image)
  assert.equal(calls[0].command, 'clipboard_write_image')
  assert.equal(calls[0].args.data, 'AAH/')
  assert.deepEqual(f.messages, [['已复制图片', false]])
  api.invoke = async () => { throw Error('clipboard busy') }
  await assert.rejects(f.copyAttachmentImage(image), /clipboard busy/)
  assert.equal(f.messages.length, 1)
})

test('desktop save uses native Save As with original bytes; cancellation and errors never start a browser download', async () => {
  const image = new Blob(['GIF89a'], { type: 'image/gif' }), calls = []
  let result = false
  const f = fixture({ window: {
    __TAURI__: { core: { invoke: async (command, args) => {
      calls.push({ command, args })
      if (result instanceof Error) throw result
      return result
    } } },
    showSaveFilePicker: () => assert.fail('desktop must use the native picker'),
  } })
  await f.saveAttachmentImage(image, '../动画.gif')
  assert.deepEqual(f.messages, [])
  result = true
  await f.saveAttachmentImage(image, '../动画.gif')
  assert.deepEqual(f.messages, [['已保存图片', false]])
  assert.equal(calls[1].command, 'save_attachment_image')
  assert.equal(calls[1].args.name, '动画.gif')
  assert.equal(Buffer.from(calls[1].args.data, 'base64').toString(), 'GIF89a')
  result = Error('disk full')
  await assert.rejects(f.saveAttachmentImage(image, '动画.gif'), /disk full/)
  assert.equal(f.messages.length, 1)
})

test('image menu enables desktop copy without ClipboardItem or navigator.clipboard', async () => {
  for (const native of [true, false]) {
    const buttons = [{ disabled: true }, { disabled: true }]
    const f = fixture({
      window: native ? { __TAURI__: { core: { invoke() {} } } } : {},
      document: { activeElement: null }, AbortController, MENU_MARGIN: 8, titlebarHeight: () => 44,
      showTextMenu: () => ({ menu: { setAttribute() {}, querySelectorAll: () => buttons } }),
      fetch: async () => ({ ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) }),
    })
    vm.runInNewContext(actions + menuAction, f)
    f.openAttachmentImageMenu({}, { src: 'blob:fixture', alt: 'image.png' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(buttons[0].disabled, !native)
    assert.equal(buttons[1].disabled, false)
  }
})

test('native image commands are granted to the active desktop backend', () => {
  const permissions = readFileSync(new URL('../src-tauri/permissions/title-bar.toml', import.meta.url), 'utf8')
  const host = readFileSync(new URL('../src-tauri/src/remote_control.rs', import.meta.url), 'utf8')
  assert.match(permissions, /identifier = "allow-attachment-images"[\s\S]*?commands.allow = \["clipboard_write_image", "save_attachment_image"\]/)
  assert.match(host.slice(host.indexOf('pub fn authorize_backend'), host.indexOf('pub fn page_load')), /"allow-attachment-images"/)
})

test('image reads reject HTTP failures, empty bodies and non-image responses', async () => {
  for (const response of [
    { ok: false, status: 404 },
    { ok: true, blob: async () => new Blob([]) },
    { ok: true, blob: async () => new Blob(['<html>login</html>'], { type: 'text/html' }) },
  ]) await assert.rejects(fixture({ fetch: async () => response }).readAttachmentImage('blob:fixture'))
  const image = new Blob(['image'], { type: 'image/png' }), signal = new AbortController().signal
  const f = fixture({ fetch: async (url, options) => {
    assert.equal(url, 'blob:fixture'); assert.equal(options.signal, signal)
    return { ok: true, blob: async () => image }
  } })
  assert.equal(await f.readAttachmentImage('blob:fixture', signal), image)
  assert.equal(await f.attachmentImagePng(image), image)
})

test('failed image decoding releases the temporary object URL', async () => {
  const revoked = []
  const f = fixture({ URL: { createObjectURL: () => 'blob:decoded', revokeObjectURL: url => revoked.push(url) },
    Image: class { set src(value) { assert.equal(value, 'blob:decoded'); queueMicrotask(() => this.onerror()) } } })
  await assert.rejects(f.attachmentImagePng(new Blob(['broken'], { type: 'image/jpeg' })))
  assert.deepEqual(revoked, ['blob:decoded'])
})

test('save cancellation does not write or report success; failed writes abort the stream', async () => {
  const image = new Blob(['original'], { type: 'image/gif' })
  const cancelled = fixture({ window: { showSaveFilePicker: async () => { throw new DOMException('Cancelled', 'AbortError') } } })
  await cancelled.saveAttachmentImage(image, 'animated.gif')
  assert.deepEqual(cancelled.messages, [])
  const calls = []
  const failed = fixture({ window: { showSaveFilePicker: async ({ suggestedName }) => {
    assert.equal(suggestedName, 'animated.gif')
    return { createWritable: async () => ({
      write: async blob => { assert.equal(blob, image); throw Error('disk full') },
      close: async () => calls.push('close'), abort: async () => calls.push('abort'),
    }) }
  } } })
  await assert.rejects(failed.saveAttachmentImage(image, 'animated.gif'), /disk full/)
  assert.deepEqual(calls, ['abort'])
  assert.deepEqual(failed.messages, [])
})

test('copy reports success only after the clipboard accepts the PNG data', async () => {
  const image = new Blob(['original'], { type: 'image/png' })
  const f = fixture({ ClipboardItem: class { constructor(types) { this.types = types } },
    navigator: { clipboard: { write: async items => {
      assert.equal(await items[0].types['image/png'], image)
      throw Error('clipboard denied')
    } } } })
  await assert.rejects(f.copyAttachmentImage(image), /clipboard denied/)
  assert.deepEqual(f.messages, [])
})
