import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const source = readFileSync('dsh-plugin/ui-overlay/dom.js', 'utf8')
const watcher = source.slice(source.indexOf('  function watchModelDisclosures()'), source.indexOf('\n  begin()', source.indexOf('  function watchModelDisclosures()')))
const gate = source.slice(source.indexOf('  function animationsActive()'), source.indexOf('\n  /** Animate navigation', source.indexOf('  function animationsActive()')))
const browser = await chromium.launch({ headless: true, channel: 'msedge' })
try {
  const page = await browser.newPage()
  await page.setContent(`<style>${readFileSync('dsh-plugin/ui-overlay/theme.css', 'utf8')}</style>
    <div data-shortcut-modal="settings">
      <div class="fixture_rowCard" id="provider"></div><div class="fixture_addBlock" id="add"></div>
      <div class="fixture_modelEntry" id="advanced"></div>
      <ul class="fixture_rows" id="providers"></ul>
      <section class="fixture_modelCatalog" id="catalog"><div class="fixture_modelList" id="models"></div></section>
      <details class="fixture_customized"><summary>Custom settings</summary><div style="height:180px">Fields</div></details>
    </div>`)
  await page.addScriptTag({ content: `function isVanilla(){return document.documentElement.dataset.dshUi==='vanilla'}\n${gate}\n${watcher}\nwatchModelDisclosures()` })
  const add = (id, cls) => page.evaluate(([id, cls]) => {
    const node = document.createElement('div'); node.className = cls
    node.innerHTML = '<input value="draft"><div style="height:160px">Fields</div>'
    document.getElementById(id).append(node)
  }, [id, cls])
  const remove = id => page.evaluate(id => document.getElementById(id).firstElementChild.remove(), id)
  const settle = () => page.waitForFunction(() => !document.querySelector('[data-dsh-model-motion], [data-dsh-model-exit]'))
  // React reuses the addActions div as addCard (and back). There is no mount or
  // removal of that div, only a class mutation and replacement of its children.
  await page.evaluate(() => {
    const block = document.createElement('div')
    block.id = 'retained-provider'; block.className = 'fixture_addBlock'
    block.innerHTML = '<div class="fixture_addActions"><button style="height:44px">Add provider</button></div>'
    document.querySelector('[data-shortcut-modal]').append(block)
    window.providerNode = block.firstElementChild
  })
  const toggleProvider = open => page.evaluate(open => {
    const node = window.providerNode
    node.className = open ? 'fixture_addCard' : 'fixture_addActions'
    node.innerHTML = open ? '<input value="provider draft"><div style="height:220px">Provider fields</div>' : '<button style="height:44px">Add provider</button>'
  }, open)
  await toggleProvider(true)
  assert.equal(await page.locator('#retained-provider').evaluate(node => node.getAnimations().length), 1, 'retained provider container must expand')
  await settle()
  assert.equal(await page.locator('#retained-provider input').inputValue(), 'provider draft')
  await toggleProvider(false)
  assert.equal(await page.locator('#retained-provider [data-dsh-model-exit][inert][aria-hidden=true]').count(), 1)
  assert.equal(await page.locator('#retained-provider').evaluate(node => node.getAnimations().length), 1, 'retained provider container must collapse')
  await toggleProvider(true)
  await settle()
  assert.equal(await page.locator('#retained-provider [data-dsh-model-exit]').count(), 0)
  assert.equal(await page.locator('#retained-provider > div').evaluate(node => node === window.providerNode), true, 'React keeps ownership of the real form')
  await toggleProvider(false)
  await settle()
  assert.equal(await page.locator('#retained-provider').evaluate(node => node.getBoundingClientRect().height), 44)
  for (const [id, cls] of [['provider', 'fixture_editor'], ['add', 'fixture_addCard'], ['advanced', 'fixture_modelAdvanced']]) {
    await add(id, cls)
    assert.equal(await page.locator(`#${id} [data-dsh-model-motion]`).count(), 1)
    await settle()
    assert.equal(await page.locator(`#${id} input`).inputValue(), 'draft')
    await remove(id)
    assert.equal(await page.locator(`#${id} [data-dsh-model-exit][inert][aria-hidden=true]`).count(), 1)
    await add(id, cls) // reopen before exit completes
    assert.equal(await page.locator(`#${id} [data-dsh-model-exit]`).count(), 0)
    await settle()
    await remove(id)
    await settle()
    assert.equal(await page.locator(`#${id} > *`).count(), 0)
  }
  for (const [id, cls] of [['providers', 'fixture_rowCard'], ['models', 'fixture_modelEntry']]) {
    await add(id, cls)
    assert.equal(await page.locator(`#${id} [data-dsh-model-motion]`).count(), 1)
    await settle()
    await add(id, cls)
    await settle()
    await page.evaluate(id => document.getElementById(id).replaceChildren(), id)
    assert.equal(await page.locator(`#${id} [data-dsh-model-exit]`).count(), 2)
    await settle()
    assert.equal(await page.locator(`#${id} > *`).count(), 0)
  }
  // The last/first model removes/mounts the entire list in the upstream editor.
  await remove('catalog')
  assert.equal(await page.locator('#catalog [data-dsh-model-exit]').count(), 1)
  await settle()
  await add('catalog', 'fixture_modelList')
  assert.equal(await page.locator('#catalog [data-dsh-model-motion]').count(), 1)
  await settle()
  await page.locator('summary').click()
  assert.ok(await page.locator('details').evaluate(n => n.getAnimations({subtree:true}).length > 0))
  await page.waitForFunction(() => !document.querySelector('details').getAnimations({subtree:true}).length)
  await page.locator('summary').click()
  assert.ok(await page.locator('details').evaluate(n => n.getAnimations({subtree:true}).length > 0))
  await add('provider', 'fixture_editor')
  await page.evaluate(() => document.documentElement.dataset.dshDesktopAnimation = 'off')
  await settle()
  await toggleProvider(true)
  assert.equal(await page.locator('#retained-provider').evaluate(node => node.getAnimations({subtree:true}).length), 0)
  await toggleProvider(false)
  assert.equal(await page.locator('#retained-provider [data-dsh-model-exit]').count(), 0)
  await remove('provider')
  assert.equal(await page.locator('[data-dsh-model-exit]').count(), 0)
  await add('provider', 'fixture_editor')
  assert.equal(await page.locator('[data-dsh-model-motion]').count(), 0)
  await add('providers', 'fixture_rowCard')
  assert.equal(await page.locator('[data-dsh-model-motion]').count(), 0)
  await remove('providers')
  assert.equal(await page.locator('[data-dsh-model-exit]').count(), 0)
  await page.locator('summary').click()
  assert.equal(await page.locator('details').evaluate(n => n.getAnimations({subtree:true}).length), 0)
  await page.evaluate(() => delete document.documentElement.dataset.dshDesktopAnimation)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await add('advanced', 'fixture_modelAdvanced')
  assert.equal(await page.locator('[data-dsh-model-motion]').count(), 0)
  await page.evaluate(() => document.documentElement.dataset.dshDesktopAnimation = 'on')
  await add('add', 'fixture_addCard')
  assert.equal(await page.locator('[data-dsh-model-motion]').count(), 1)
  await page.evaluate(() => document.documentElement.dataset.dshUi = 'vanilla')
  await settle()
  console.log('PASS: disclosures, model/provider insert and batch delete, first/last model, native details, drafts, off/system/on/vanilla preferences')
} finally { await browser.close() }
