/** Real-browser regressions for conversation remounts, navigation and IME motion. */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const source = readFileSync('dsh-plugin/ui-overlay/dom.js', 'utf8').replace(/\r\n/g, '\n')
const start = source.indexOf('  function watchViewMotion()')
const end = source.indexOf('\n  /**', start)
assert.ok(start >= 0 && end > start)
const browser = await chromium.launch({ headless: true, channel: 'msedge' })
after(() => browser.close())

const conversation = session => `<div data-slot="main.conversation"><div data-phase="active">
  <div role="tablist" data-conversation-tabs><button role="tab" aria-selected="true">Chat</button><button role="tab" aria-selected="false">Details</button></div>
  <div data-conversation-content data-conversation-session="${session}"><div class="fixture_viewArea">Response</div>
  <div data-composer-card><div contenteditable="true" data-composer-input>Draft</div></div></div></div></div>`
async function fixture(t, html = conversation('a')) {
  const page = await browser.newPage()
  t.after(() => page.close())
  await page.setContent(`<main data-slot="main">${html}</main>`)
  await page.addScriptTag({ content: `
    window.motionCalls = [];
    window.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      motionCalls.push({ session: this.getAttribute('data-conversation-session'), id: this.id, frames });
      return animate.call(this, frames, options);
    };
    function animationsActive() { return document.documentElement.dataset.dshDesktopAnimation !== 'off' }
    ${source.slice(start, end)}
    watchViewMotion();` })
  await page.evaluate(async () => { await settle(); motionCalls = [] })
  return page
}
const calls = page => page.evaluate(async () => { await settle(); return motionCalls })

test('same-session content and slot remounts never replay an entrance', async t => {
  const page = await fixture(t)
  for (const replaceSlot of [false, true]) {
    await page.evaluate(({ html, replaceSlot }) => {
      motionCalls = []
      const main = document.querySelector('[data-slot="main"]')
      if (replaceSlot) main.outerHTML = `<main data-slot="main">${html}</main>`
      else main.innerHTML = html
    }, { html: conversation('a'), replaceSlot })
    assert.equal((await calls(page)).length, 0, 'recreating the same session must stay still')
  }
  await page.evaluate(() => document.querySelector('[data-slot="main"]').replaceChildren())
  await calls(page)
  await page.evaluate(html => { motionCalls = []; document.querySelector('[data-slot="main"]').innerHTML = html }, conversation('a'))
  assert.equal((await calls(page)).length, 0, 'a transient empty slot is not navigation')
})

test('real session switches animate, including replacement nodes and revisits', async t => {
  const page = await fixture(t)
  for (const session of ['b', 'a', 'b']) {
    await page.evaluate(html => { motionCalls = []; document.querySelector('[data-slot="main"]').innerHTML = html }, conversation(session))
    assert.deepEqual((await calls(page)).map(call => call.session), [session])
  }
  await page.evaluate(() => {
    motionCalls = []
    document.querySelector('[data-conversation-content]').setAttribute('data-conversation-session', 'c')
  })
  assert.deepEqual((await calls(page)).map(call => call.session), ['c'])
})

test('page identity survives child replacement and still changes on navigation', async t => {
  const page = await fixture(t, '<section data-slot="main.jobs"><p>Jobs</p></section>')
  await page.evaluate(() => { document.querySelector('[data-slot="main"]').innerHTML = '<section data-slot="main.jobs"><p>Updated</p></section>' })
  assert.equal((await calls(page)).length, 0)
  await page.evaluate(() => { document.querySelector('[data-slot="main"]').innerHTML = '<section data-slot="main.settings"><p>Settings</p></section>' })
  assert.equal((await calls(page)).length, 1)
})

test('replacement tab buttons are not a view switch; actual selections are', async t => {
  const page = await fixture(t)
  await page.evaluate(() => {
    const selected = document.querySelector('[aria-selected="true"]')
    selected.replaceWith(selected.cloneNode(true))
    document.querySelector('[aria-selected="true"]').setAttribute('aria-selected', 'true')
  })
  assert.equal((await calls(page)).length, 0)
  for (const index of [1, 0, 1]) {
    await page.evaluate(index => {
      motionCalls = []
      document.querySelectorAll('[role="tab"]').forEach((tab, i) => tab.setAttribute('aria-selected', String(i === index)))
    }, index)
    assert.equal((await calls(page)).length, 1)
  }
})

test('retained ARIA panels animate on revisit without reacting to button replacement', async t => {
  const page = await fixture(t, '<div role="tablist"><button role="tab" aria-controls="a" aria-selected="true">A</button><button role="tab" aria-controls="b" aria-selected="false">B</button></div><div role="tabpanel" id="a">A</div><div role="tabpanel" id="b" hidden>B</div>')
  for (const id of ['b', 'a', 'b']) {
    await page.evaluate(id => {
      motionCalls = []
      document.querySelectorAll('[role="tab"]').forEach(tab => tab.setAttribute('aria-selected', String(tab.getAttribute('aria-controls') === id)))
      document.querySelectorAll('[role="tabpanel"]').forEach(panel => { panel.hidden = panel.id !== id })
    }, id)
    assert.deepEqual((await calls(page)).map(call => call.id), [id])
  }
  await page.evaluate(() => {
    motionCalls = []
    const tab = document.querySelector('[aria-selected="true"]')
    tab.replaceWith(tab.cloneNode(true))
    document.querySelector('[aria-selected="true"]').setAttribute('aria-selected', 'true')
  })
  assert.equal((await calls(page)).length, 0)
})

test('native composition cancels motion and preserves text, focus and caret during updates', async t => {
  const page = await fixture(t)
  const editor = page.locator('[contenteditable]')
  await editor.fill('')
  await page.evaluate(() => document.querySelector('[data-conversation-content]').setAttribute('data-conversation-session', 'b'))
  assert.equal((await calls(page)).length, 1)
  const cdp = await page.context().newCDPSession(page)
  for (const text of ['n', 'ni', 'nih', 'niha', 'nihao']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
    await page.evaluate(() => {
      motionCalls = []
      const selected = document.querySelector('[aria-selected="true"]')
      selected.replaceWith(selected.cloneNode(true))
      document.querySelector('.fixture_viewArea').textContent += ' chunk'
    })
    assert.equal((await calls(page)).length, 0)
    assert.equal(await editor.innerText(), text)
    assert.deepEqual(await editor.evaluate(node => ({ focused: document.activeElement === node, offset: getSelection().anchorOffset,
      animations: document.querySelector('[data-conversation-content]').getAnimations().length })), { focused: true, offset: text.length, animations: 0 })
  }
  await page.evaluate(() => document.querySelector('[data-conversation-content]').setAttribute('data-conversation-session', 'c'))
  assert.equal((await calls(page)).length, 0, 'navigation during composition is recorded without motion')
  await cdp.send('Input.insertText', { text: '你好' })
  assert.equal(await editor.innerText(), '你好')
  assert.equal((await calls(page)).length, 0, 'finishing composition must not replay skipped motion')
  await page.evaluate(() => document.querySelector('[data-conversation-content]').setAttribute('data-conversation-session', 'd'))
  assert.deepEqual((await calls(page)).map(call => call.session), ['d'])
})

test('streamed updates and disabled animations stay still', async t => {
  const page = await fixture(t)
  await page.evaluate(async () => {
    for (let i = 0; i < 15; i++) {
      document.querySelector('.fixture_viewArea').replaceChildren(document.createTextNode('Chunk ' + i))
      await settle()
    }
    document.documentElement.dataset.dshDesktopAnimation = 'off'
    document.querySelector('[data-conversation-content]').setAttribute('data-conversation-session', 'b')
  })
  assert.equal((await calls(page)).length, 0)
})
