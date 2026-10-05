import { basicSetup } from 'codemirror'
import { EditorState, Compartment, StateEffect } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, drawSelection, dropCursor } from '@codemirror/view'
import { indentWithTab, history, defaultKeymap, historyKeymap } from '@codemirror/commands'
import { searchKeymap } from '@codemirror/search'
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { go } from '@codemirror/legacy-modes/mode/go'

const languages = { js: () => javascript({ jsx: true }), jsx: () => javascript({ jsx: true }), mjs: javascript, cjs: javascript,
  ts: () => javascript({ typescript: true }), tsx: () => javascript({ typescript: true, jsx: true }), json, html, htm: html,
  css, md: markdown, markdown, py: python, rs: rust, c: cpp, h: cpp, cpp, hpp: cpp, cc: cpp, java, sql, yaml, yml: yaml,
  sh: () => StreamLanguage.define(shell), bash: () => StreamLanguage.define(shell), zsh: () => StreamLanguage.define(shell),
  ps1: () => StreamLanguage.define(powerShell), psm1: () => StreamLanguage.define(powerShell),
  toml: () => StreamLanguage.define(toml), go: () => StreamLanguage.define(go) }

const highlights = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--editor-keyword)' },
  { tag: [tags.string, tags.regexp], color: 'var(--editor-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--editor-number)' },
  { tag: tags.comment, color: 'var(--editor-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.tagName], color: 'var(--editor-function)' },
  { tag: tags.heading, fontWeight: 'bold' }, { tag: tags.link, textDecoration: 'underline' },
])

// Plain text keeps editing/navigation without token styles, word matching,
// automatic brackets or other language-specific decorations.
const plainSetup = [lineNumbers(), history(), drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
  keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap])]

export function mountEditor(parent, doc, { mode = 'code', wrap, onCursor, scrollportRef, line }) {
  const wrapping = new Compartment(), editable = new Compartment()
  const path = doc.file.path, ext = path.split('.').at(-1).toLowerCase()
  let external = false
  const extensions = [
    mode === 'plain' ? plainSetup : [basicSetup, (languages[ext] || (() => []))(), syntaxHighlighting(highlights)],
    keymap.of([indentWithTab, { key: 'Mod-s', run: () => { void doc.save(); return true } }]),
    wrapping.of(wrap ? EditorView.lineWrapping : []), editable.of(EditorView.editable.of(true)),
    EditorView.contentAttributes.of({ 'aria-label': '文件编辑器：' + path, spellcheck: 'false', autocapitalize: 'off' }),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !external) doc.edit(update.state.doc.toString())
      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main.head, row = update.state.doc.lineAt(head)
        onCursor({ line: row.number, column: head - row.from + 1 })
      }
    }),
  ]
  const initial = doc.editorState?.doc.toString() === doc.getSnapshot().text
    ? doc.editorState.update({ effects: StateEffect.reconfigure.of(extensions) }).state
    : EditorState.create({ doc: doc.getSnapshot().text, extensions })
  const view = new EditorView({ parent, state: initial })
  let loading = false
  const sync = () => {
    const state = doc.getSnapshot()
    if (view.state.doc.toString() !== state.text) {
      external = true
      try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: state.text } }) }
      finally { external = false }
    }
    if (loading !== state.loading) {
      loading = state.loading
      view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!loading)) })
    }
  }
  const off = doc.subscribe(sync)
  view.scrollDOM.scrollTop = doc.scrollTop || 0
  if (Number.isSafeInteger(line) && line > 0) {
    const pos = view.state.doc.line(Math.min(line, view.state.doc.lines)).from
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
  }
  scrollportRef?.(view.scrollDOM)
  return {
    wrap(value) { view.dispatch({ effects: wrapping.reconfigure(value ? EditorView.lineWrapping : []) }) },
    measure() { view.requestMeasure() },
    destroy() { doc.editorState = view.state; doc.scrollTop = view.scrollDOM.scrollTop; off(); scrollportRef?.(null); view.destroy() },
  }
}
