/**
 * The text a terminal selection puts on the clipboard.
 *
 * ## Why this file exists
 *
 * The terminal is a grid of fixed-width cells, and every cell a program did not
 * print is padding. xterm.js builds a selection's text from the buffer's own line
 * strings, so dragging into the blank area to the right of a command — or across
 * the empty lower half of the screen — carried that padding into the clipboard.
 * Pasting it produced trailing spaces and blank lines that the user never typed.
 *
 * The rule that fixes it lives in `sidebar-terminal/selection.mjs` and is asserted
 * here, together with the two facts that make it reach the clipboard at all: the
 * screen rewrites xterm's own copy event, and the 复制 menu item shares the same
 * reader.
 *
 * Run with: `node --test dsh-plugin/`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { selectionText } from './sidebar-terminal/selection.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const runtime = readFileSync(join(here, 'sidebar-terminal', 'runtime.mjs'), 'utf8')

test('padding to the right of a command never reaches the clipboard', () => {
  // What a drag ending in the blank area right of the prompt really yields: the
  // row is `cols` wide and every unfilled cell is a space.
  assert.equal(selectionText('git status                    '), 'git status')
  assert.equal(
    selectionText('git status                    \nnpm run test:plugin           \n'),
    'git status\nnpm run test:plugin',
  )
})

test('indentation and interior blank lines survive; only the ends are trimmed', () => {
  // Leading blanks are content: YAML, Python and indented shell output all need
  // them, so trimming them would be a worse bug than the padding.
  assert.equal(selectionText('    indented: true   '), '    indented: true')
  assert.equal(selectionText('\tcolumns\tare\tkept\t \t'), '\tcolumns\tare\tkept')
  // A deliberate blank line between two blocks is content; the empty rows above
  // and below a selection are not.
  assert.equal(selectionText('\n\nfirst\n\nsecond\n\n\n'), 'first\n\nsecond')
})

test('a selection of nothing but padding copies nothing', () => {
  assert.equal(selectionText(''), '')
  assert.equal(selectionText('        '), '')
  assert.equal(selectionText('\n   \n\t\n'), '')
})

test('an already clean selection is copied byte for byte', () => {
  const text = 'PS C:\\work> ls\nMode  Name\n----  ----\n-a--- app.ts'
  assert.equal(selectionText(text), text)
})

test('xterm\'s own copy is redirected, because a listener on the event cannot win', () => {
  // xterm answers the browser's `copy` event itself and writes the PADDED value:
  // its handler reads `selection.selectionText` — a getter on the selection
  // service — not `getSelection()`. A listener of ours that writes the trimmed
  // text first therefore loses (measured in the live app: with a capture listener
  // on the screen element the clipboard still held the padding, because the
  // transfer commits as the dispatch settles and xterm writes later within it).
  // So the fix is to redirect the one accessor every reader shares.
  assert.match(runtime, /Object\.getOwnPropertyDescriptor\(Object\.getPrototypeOf\(found\), 'selectionText'\)/, 'the prototype getter must be read, not the instance value')
  assert.match(runtime, /Object\.defineProperty\(found, 'selectionText', \{ configurable: true, get: \(\) => selectionText\(rawGetter\(\)\) \}\)/, 'the service must report the trimmed text')
  // It has to be installed where the service exists: `term.open()` creates it.
  assert.match(runtime, /term\.open\(element\); redirectSelection\(\)/, 'the redirect must be installed once the service exists')
  // One reader for the menu item, and no path may write a raw selection.
  assert.match(runtime, /const copyText = \(\) => selectionText\(term\.getSelection\(\)\)/, 'the selection must be read through the trimming helper')
  assert.match(runtime, /const copy = \(\) => writeClipboard\(copyText\(\)\)/, 'the 复制 item must copy the trimmed text')
  assert.doesNotMatch(runtime, /clipboard_write_text', \{ text: term\.getSelection\(\) \}/, 'no copy path may write a raw selection')
})
