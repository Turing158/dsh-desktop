/**
 * One-shot rewrite: gate theme.css sections 1–8 behind `html:not([data-dsh-ui=
 * 'vanilla'])`, so the 原版 switch can disable the whole style overlay by
 * removing one attribute.
 *
 * Section 9 (the desktop title bar) is deliberately NOT gated: the window is
 * `decorations(false)`, so without the bar there is no window control, no drag
 * surface, and no way back to the new styles. The one rule at the top of section
 * 9 that cancels section 4's separator is left ungated too — it is a no-op once
 * section 4 stops matching, and harmless in either mode.
 *
 * Only SELECTOR lines are rewritten (trimmed form ends with `{` or `,`), so the
 * extensive prose in the block comments — which discusses `html body` and the
 * specificity rules by name — is left exactly as written.
 *
 * Run: node tools/gate-vanilla.mjs dsh-plugin/ui-overlay/theme.css
 */

import { readFileSync, writeFileSync } from 'node:fs'

const FILE = process.argv[2]
if (FILE === undefined) {
  console.error('usage: node gate-vanilla.mjs <theme.css>')
  process.exit(2)
}

/** The gate every overlay rule in sections 1–8 carries. */
const GATE = "html:not([data-dsh-ui='vanilla'])"

const source = readFileSync(FILE, 'utf8')
const lines = source.split('\n')

/** Section 9 begins here; nothing from this line down is rewritten. */
const section9 = lines.findIndex((line) => line.includes('── 9. desktop title bar'))
if (section9 < 0) {
  console.error('could not find the section 9 banner; refusing to guess')
  process.exit(1)
}

/**
 * Whether a line opens or continues a SELECTOR, rather than being a declaration
 * continuation, a nested at-rule, prose, or a brace.
 *
 * A naive "ends with `{` or `,`" test also catches multi-line declaration values
 * (`box-shadow: 0 1px 2px …,` / `transition: background-color 120ms …,`),
 * `@keyframes`, and the `from {` inside one. Those must be skipped: a selector
 * line is the only kind that can begin with an element or a class, so the test
 * anchors on the line's first token instead.
 */
function isSelector(line) {
  const trimmed = line.trim()
  if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return false
  if (trimmed.startsWith('@')) return false
  if (!trimmed.endsWith('{') && !trimmed.endsWith(',')) return false

  // A declaration continuation starts with `property:` and never with an element
  // or class token; `from`/`to`/`0%` are keyframe steps, not elements.
  const first = trimmed.split(/[\s{,:]/, 1)[0]
  if (/^(?:from|to|\d)/.test(first)) return false
  return !/^[-a-z]+$/.test(first) || /^(html|body|input|textarea|button|a|summary|svg)$/.test(first)
}

let rewritten = 0
let alreadyGated = 0
const missed = []

for (let i = 0; i < section9; i += 1) {
  const original = lines[i]
  if (!isSelector(original)) continue

  if (original.includes(GATE)) {
    alreadyGated += 1
    continue
  }

  let next = original

  // `html body…`, `html body[data-ds-dark-theme]…`
  next = next.replace(/\bhtml body/g, `${GATE} body`)

  // Selectors that already carry an animation gate get the mode gate as an extra
  // `:not()` on the same `html` compound, rather than a second `html` element:
  //   html:not([data-dsh-desktop-animation='on']) body button
  next = next.replace(
    /html:not\(\[data-dsh-desktop-animation=/g,
    `${GATE}:not([data-dsh-desktop-animation=`,
  )

  //   html[data-dsh-desktop-animation='off'] body button
  next = next.replace(
    /html\[data-dsh-desktop-animation=/g,
    `${GATE}[data-dsh-desktop-animation=`,
  )

  // The composer focus ring is the one overlay rule written without an `html`
  // prefix, so it needs the gate inserted rather than substituted.
  if (next.startsWith("[data-dsh-desktop='composer']")) {
    next = `${GATE} ${next}`
  }

  if (next === original) {
    missed.push(`${i + 1}: ${original.trim()}`)
    continue
  }

  lines[i] = next
  rewritten += 1
}

writeFileSync(FILE, lines.join('\n'), 'utf8')

console.log(`section 9 starts at line ${section9 + 1}`)
console.log(`rewrote ${rewritten} selector line(s); ${alreadyGated} already gated`)
if (missed.length > 0) {
  console.error(`\n${missed.length} selector line(s) matched no pattern:`)
  for (const entry of missed) console.error(`  ${entry}`)
  process.exit(1)
}
