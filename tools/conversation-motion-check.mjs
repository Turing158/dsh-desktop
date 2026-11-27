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

test('the view toggle keeps the active tab appearance and respects the hover motion preference', async t => {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  t.after(() => page.close())
  await page.setContent(`
    <style>
      .nativeTab { position: relative; background: transparent; border: 0; padding: 0 0 9px; font-size: 13px; }
      .nativeActive { color: rgb(65, 118, 230); }
      .nativeActive::after { content: ''; position: absolute; inset: auto 0 -1px; height: 2px; background: currentColor; }
    </style>
    <div data-conversation-tabs role="tablist">
      <button class="nativeTab nativeActive" role="tab" aria-selected="true">对话</button>
      <button class="nativeTab" role="tab" aria-selected="false">轨迹</button>
    </div>`)
  await page.addStyleTag({ content: readFileSync('dsh-plugin/ui-overlay/theme.css', 'utf8') })
  const tabs = page.locator('[role="tab"]')
  const tabStyle = node => [getComputedStyle(node).backgroundColor, getComputedStyle(node).color,
    getComputedStyle(node).padding, getComputedStyle(node).fontSize, getComputedStyle(node, '::after').backgroundColor]
  const originalStyle = await tabs.first().evaluate(tabStyle)
  await tabs.evaluateAll(nodes => nodes.forEach(tab => {
    tab.onclick = () => nodes.forEach(other => {
      other.setAttribute('aria-selected', String(other === tab))
      other.classList.toggle('nativeActive', other === tab)
    })
  }))
  await page.addScriptTag({ content: source })
  const toggle = page.getByRole('button', { name: '当前视图：会话。切换到轨迹' })
  assert.deepEqual(await toggle.evaluate(tabStyle), originalStyle)
  const bounds = await toggle.boundingBox()
  const labels = toggle.locator('[data-view-label]')
  const opacities = () => labels.evaluateAll(nodes => nodes.map(node => Number(getComputedStyle(node).opacity)))
  for (const [preference, reducedMotion, duration] of [
    ['system', 'reduce', '0s'], ['on', 'reduce', '0.16s'],
    ['off', 'no-preference', '0s'], ['system', 'no-preference', '0.16s'],
  ]) {
    await page.emulateMedia({ reducedMotion })
    await page.locator('html').evaluate((root, value) => {
      if (value === 'system') root.removeAttribute('data-dsh-desktop-animation')
      else root.dataset.dshDesktopAnimation = value
    }, preference)
    assert.equal(await labels.last().evaluate(node => getComputedStyle(node).transitionDuration), duration)
    assert.deepEqual(await opacities(), [1, 0])
    await toggle.hover()
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-view-label="next"]')).opacity === '1')
    assert.deepEqual(await opacities(), [0, 1])
    assert.deepEqual(await toggle.boundingBox(), bounds)
    await page.mouse.move(0, 0)
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-view-label="current"]')).opacity === '1')
    assert.deepEqual(await opacities(), [1, 0])
  }
  await toggle.click()
  const switched = page.getByRole('button', { name: '当前视图：轨迹。切换到会话' })
  await switched.click()
  assert.deepEqual(await toggle.locator('[data-view-label]').allTextContents(), ['会话', '轨迹'])
  assert.deepEqual(await toggle.evaluate(tabStyle), originalStyle)
})

test('session tab edge fades animate independently and respect the desktop motion preference', async t => {
  const page = await browser.newPage()
  t.after(() => page.close())
  await page.setContent('<div class="dshSessionTabs"><button>Session</button></div>')
  await page.addStyleTag({ content: readFileSync('dsh-plugin/ui-overlay/theme.css', 'utf8') })
  const strip = page.locator('.dshSessionTabs')
  for (const [preference, reducedMotion, animated] of [
    ['on', 'reduce', true], ['off', 'no-preference', false],
    ['system', 'reduce', false], ['system', 'no-preference', true],
  ]) {
    await page.emulateMedia({ reducedMotion })
    const samples = await strip.evaluate((node, preference) => {
      const root = document.documentElement
      if (preference === 'system') root.removeAttribute('data-dsh-desktop-animation')
      else root.dataset.dshDesktopAnimation = preference
      const edges = ['left', 'right']
      const alphas = () => edges.map(edge => Number(getComputedStyle(node).getPropertyValue(`--dsh-session-tabs-${edge}-alpha`)))
      alphas()
      return [[true, false], [false, true], [false, false]].map(overflow => {
        edges.forEach((edge, i) => node.toggleAttribute(`data-overflow-${edge}`, overflow[i]))
        const transitions = node.getAnimations()
        for (const transition of transitions) transition.currentTime = 90
        const halfway = alphas()
        for (const transition of transitions) transition.finish()
        return { halfway, end: alphas(), transitions: transitions.length }
      })
    }, preference)
    const endpoints = [[0, 1], [1, 0], [1, 1]]
    assert.deepEqual(samples.map(sample => sample.end), endpoints)
    assert.deepEqual(samples.map(sample => sample.transitions), animated ? [1, 2, 1] : [0, 0, 0])
    if (animated) {
      const [[showLeft, stillRight], [hideLeft, showRight], [stillLeft, hideRight]] = samples.map(sample => sample.halfway)
      for (const alpha of [showLeft, hideLeft, showRight, hideRight]) assert.ok(alpha > 0 && alpha < 1)
      assert.equal(stillLeft, 1)
      assert.equal(stillRight, 1)
    } else assert.deepEqual(samples.map(sample => sample.halfway), endpoints)
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
