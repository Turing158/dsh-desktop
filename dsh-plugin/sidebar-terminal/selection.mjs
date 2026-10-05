/**
 * What a terminal selection should actually put on the clipboard.
 *
 * ## The problem this exists for
 *
 * A terminal is a grid of fixed-width CELLS: a row is always `cols` wide, and
 * everything the program did not print is padding. xterm.js builds a selection's
 * text from the buffer's own line strings (`BufferLine.translateToString`), so a
 * drag that ends in the blank area to the right of a command — or a selection
 * that sweeps across a mostly-empty screen — carries every padding cell with it.
 * Pasting that text anywhere yields a tail of spaces: `git status            `,
 * or a block of blank lines when the drag started below the last output.
 *
 * The screen cannot fix this by hiding the highlight: xterm's selection is one
 * rectangle over whole cells, and a blank cell inside it is still a cell the user
 * dragged over. What can be fixed — and what a user means by "copy this" — is the
 * TEXT, so the trimming happens once, here, for every path that writes the
 * clipboard.
 *
 * ## The rules, and why each one is not the other
 *
 * - **Trailing blanks go, on every line.** That tail is the padding, never
 *   something the shell printed: a program that wants trailing spaces in its
 *   output is asking for a copy that has them, which is why a line is trimmed to
 *   its last NON-BLANK cell rather than to `cols`.
 * - **Leading blanks stay.** Indentation is content — YAML, Python, and a
 *   shell's own indented error output all depend on it, and trimming it would
 *   quietly corrupt what a user pastes.
 * - **Blank lines at the two ends go, blanks in the middle stay.** A selection
 *   that ends in the empty lower half of the screen is dragging over nothing; a
 *   deliberate blank line between two paragraphs of output is content, and a
 *   paste that silently joined the paragraphs would be the worse bug.
 * - **Whitespace means spaces and tabs.** A tab is a cell a program did not fill
 *   either, and a pasted `\t` at the end of a line is the same defect as a pasted
 *   space; both are stripped from the tail and neither from the head.
 *
 * Line endings are left exactly as xterm joined them (`\n`), so a multi-line
 * selection pastes as the lines it was copied from.
 *
 * @param raw - the selection text exactly as xterm reports it.
 * @returns the same text with the padding removed, or `''` when nothing but
 *   padding was selected.
 */
export function selectionText(raw) {
  if (typeof raw !== 'string' || raw === '') return ''
  const lines = raw.split('\n').map(line => line.replace(/[ \t]+$/, ''))
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}
