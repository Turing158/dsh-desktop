/**
 * Build a preview sheet of the generated icons.
 *
 * Checking an icon by reading its pixel values only proves it is not blank. This
 * composites the real files — including the entries packed inside `icon.ico` —
 * over both a light and a dark background, so the shape and the ink's legibility
 * on each can be judged by looking at them.
 *
 * The 16px cell is the one that matters most: that is the size the taskbar and
 * Explorer's details view use, and the point at which the whale's tail starts to
 * merge into its body.
 *
 * Run it after `node tools/make-icons.mjs`, then open `icon-preview.png`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ICON_DIR = join(HERE, '..', 'src-tauri', 'icons')

/* ── a minimal PNG decoder, enough for this generator's own RGBA output ───── */

function decodePng(bytes) {
  let at = 8
  let width = 0
  let height = 0
  const idat = []
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    const payload = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = payload.readUInt32BE(0)
      height = payload.readUInt32BE(4)
    } else if (type === 'IDAT') {
      idat.push(payload)
    } else if (type === 'IEND') {
      break
    }
    at += 12 + length
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    // Filter 0 (None) is what the generator writes, so each scanline is verbatim
    // after its filter byte.
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
  }
  return { width, height, pixels }
}

/** Pull each PNG-compressed entry out of an ICO. */
function decodeIco(bytes) {
  const count = bytes.readUInt16LE(4)
  const entries = []
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16
    const size = bytes[at] === 0 ? 256 : bytes[at]
    const length = bytes.readUInt32LE(at + 8)
    const offset = bytes.readUInt32LE(at + 12)
    entries.push({ size, png: decodePng(bytes.subarray(offset, offset + length)) })
  }
  return entries
}

/** Nearest-neighbour resample, so a 16px icon is inspected rather than smoothed. */
function resample(image, size) {
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(image.width - 1, Math.floor((x * image.width) / size))
      const sy = Math.min(image.height - 1, Math.floor((y * image.height) / size))
      image.pixels.copy(out, (y * size + x) * 4, (sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4)
    }
  }
  return { width: size, height: size, pixels: out }
}

/** Composite `src` over `dst` at (dx, dy), source-over. */
function blend(dst, dstW, src, dx, dy) {
  for (let y = 0; y < src.height; y += 1) {
    for (let x = 0; x < src.width; x += 1) {
      const s = (y * src.width + x) * 4
      const d = ((dy + y) * dstW + dx + x) * 4
      const a = src.pixels[s + 3] / 255
      if (a === 0) continue
      for (let c = 0; c < 3; c += 1) {
        dst[d + c] = Math.round(src.pixels[s + c] * a + dst[d + c] * (1 - a))
      }
      dst[d + 3] = 255
    }
  }
}

const icon = decodePng(readFileSync(join(ICON_DIR, '256x256.png')))
const ico = decodeIco(readFileSync(join(ICON_DIR, 'icon.ico')))
const markBlack = decodePng(readFileSync(join(ICON_DIR, 'mark-black.png')))
const markWhite = decodePng(readFileSync(join(ICON_DIR, 'mark-white.png')))

const CELL = 256
const WIDTH = CELL * 4
const HEIGHT = CELL * 2
const sheet = Buffer.alloc(WIDTH * HEIGHT * 4)

// Row 0 light, row 1 dark. An icon has to work on both, which is the whole
// reason the file icon is neither black nor white.
for (let y = 0; y < HEIGHT; y += 1) {
  for (let x = 0; x < WIDTH; x += 1) {
    const d = (y * WIDTH + x) * 4
    const v = y < CELL ? 245 : 32
    sheet[d] = v
    sheet[d + 1] = v
    sheet[d + 2] = v
    sheet[d + 3] = 255
  }
}

/** Centre `image` in one cell, drawn at `display` pixels. */
const place = (image, row, column, display) => {
  const drawn = resample(image, display)
  blend(
    sheet,
    WIDTH,
    drawn,
    column * CELL + Math.floor((CELL - display) / 2),
    row * CELL + Math.floor((CELL - display) / 2),
  )
}

// Row 0 (light): the app icon at 256, 128 and 32, then the ICO's 16 blown up.
place(icon, 0, 0, 256)
place(icon, 0, 1, 128)
place(icon, 0, 2, 64)
place(ico.find((entry) => entry.size === 16).png, 0, 3, 128)
// Row 1 (dark): the same file icon, plus the two monochrome taskbar marks.
place(icon, 1, 0, 256)
place(icon, 1, 1, 128)
place(markWhite, 1, 2, 128)
place(markBlack, 1, 3, 128)

/* ── encode the sheet ─────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, payload) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(WIDTH, 0)
ihdr.writeUInt32BE(HEIGHT, 4)
ihdr[8] = 8
ihdr[9] = 6
const stride = WIDTH * 4
const rawOut = Buffer.alloc((stride + 1) * HEIGHT)
for (let y = 0; y < HEIGHT; y += 1) {
  rawOut[y * (stride + 1)] = 0
  sheet.copy(rawOut, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
}

const out = join(HERE, '..', 'icon-preview.png')
writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rawOut, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]),
)
console.log(`wrote ${out} (${WIDTH}x${HEIGHT})`)
console.log(`icon.ico entries: ${ico.map((entry) => entry.size).join(', ')}`)
