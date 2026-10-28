/** A Raster's props minus its key: a fixed box of colored cells. */
export type Cells = { columns: number; rows: number; cells: string }

const DEFAULT = 0x01000000 // the terminal's own color
const FULL = 0x2588 // █
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄
const SPACE = 0x20
// ▏▎▍▌▋▊▉: 1/8 .. 7/8 of a cell, left-aligned
const EIGHTHS = [0, 0x258f, 0x258e, 0x258d, 0x258c, 0x258b, 0x258a, 0x2589]

/** 3 x 5 pixel digits, drawn in three terminal rows of half blocks. */
const FONT: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
}
const GLYPH = 3
const GLYPH_ROWS = 5
const PIXEL_ROWS = 6 // three terminal rows
const TOP = PIXEL_ROWS - GLYPH_ROWS // sit on the bottom row, level with the "%"

export function rgb(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16)
}

/** Mix a color toward white (t > 0) or black (t < 0). */
export function shade(color: number, t: number): number {
  const target = t >= 0 ? 255 : 0
  const k = Math.abs(t)
  const ch = (s: number) => Math.round(((color >> s) & 0xff) * (1 - k) + target * k)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** Standard padded base64 of the cells' little-endian u32 triplets. */
function encode(words: number[]): string {
  const bytes = new Uint8Array(words.length * 4)
  words.forEach((w, i) => {
    bytes[i * 4] = w & 0xff
    bytes[i * 4 + 1] = (w >>> 8) & 0xff
    bytes[i * 4 + 2] = (w >>> 16) & 0xff
    bytes[i * 4 + 3] = (w >>> 24) & 0xff
  })
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0)
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]!
    out += b1 === undefined ? '=' : A[(n >> 6) & 63]!
    out += b2 === undefined ? '=' : A[n & 63]!
  }
  return out
}

/** Columns a number takes in the pixel font: 3 per digit, 1 between. */
export const bigWidth = (digits: string) => Math.max(0, digits.length * (GLYPH + 1) - 1)

/**
 * `digits` in the 3 x 5 pixel font, three terminal rows tall (two pixels per
 * row via half blocks), right-aligned in `columns`, lit top to bottom.
 */
export function bigText(digits: string, color: number, columns: number): Cells {
  const rows = PIXEL_ROWS / 2
  const width = Math.max(columns, bigWidth(digits))
  const left = width - bigWidth(digits)
  const px = (x: number, y: number): boolean => {
    const gx = x - left
    if (gx < 0) return false
    const glyph = FONT[digits[Math.floor(gx / (GLYPH + 1))] ?? '']
    const col = gx % (GLYPH + 1)
    return glyph !== undefined && col < GLYPH && glyph[y - TOP]?.[col] === '#'
  }
  // A light top fading to the full color at the bottom.
  const tone = (y: number) => shade(color, 0.3 * (1 - (y - TOP) / (GLYPH_ROWS - 1)))
  const words: number[] = []
  for (let r = 0; r < rows; r += 1) {
    for (let x = 0; x < width; x += 1) {
      const top = px(x, 2 * r)
      const bottom = px(x, 2 * r + 1)
      if (top && bottom) words.push(UPPER, tone(2 * r), tone(2 * r + 1))
      else if (top) words.push(UPPER, tone(2 * r), DEFAULT)
      else if (bottom) words.push(LOWER, tone(2 * r + 1), DEFAULT)
      else words.push(SPACE, DEFAULT, DEFAULT)
    }
  }
  return { columns: width, rows, cells: encode(words) }
}

/**
 * A slim bar, the top half of one row: gradient fill in a track of the same
 * height, so stacked rows keep a gap between bars.
 */
export function slimBar(pct: number, columns: number, track: number, color: number): Cells {
  const halves = Math.round((Math.min(100, Math.max(0, pct)) / 100) * columns * 2)
  const words: number[] = []
  for (let i = 0; i < columns; i += 1) {
    const fill = sheen(color, i, columns)
    if (2 * i + 2 <= halves) words.push(UPPER, fill, DEFAULT)
    else if (2 * i + 1 === halves) words.push(0x2598, fill, DEFAULT) // ▘ half a cell
    else words.push(UPPER, track, DEFAULT)
  }
  return { columns, rows: 1, cells: encode(words) }
}

/**
 * The band's meter: a solid bar in the top half of one row, half-cell precise,
 * in a track of the same height. The empty lower half keeps it close to the
 * label above and apart from whatever is drawn below.
 */
export function meterBar(pct: number, columns: number, fill: number, track: number): Cells {
  const halves = Math.round((Math.min(100, Math.max(0, pct)) / 100) * columns * 2)
  const words: number[] = []
  for (let i = 0; i < columns; i += 1) {
    if (2 * i + 2 <= halves) words.push(UPPER, fill, DEFAULT)
    else if (2 * i + 1 === halves) words.push(0x2598, fill, DEFAULT) // ▘ half a cell
    else words.push(UPPER, track, DEFAULT)
  }
  return { columns, rows: 1, cells: encode(words) }
}

/** The fill's color at cell `i`: a little lighter at the start of the bar. */
function sheen(color: number, i: number, columns: number): number {
  return shade(color, 0.22 * (1 - i / Math.max(1, columns - 1)))
}

/**
 * A solid bar one row tall in a recessed track, filled in the level's color
 * with a soft sheen, ending on an eighth-of-a-cell boundary.
 */
export function bigBar(pct: number, columns: number, track: number, color: number): Cells {
  const eighths = Math.round((Math.min(100, Math.max(0, pct)) / 100) * columns * 8)
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  const words: number[] = []
  const fill = (i: number) => sheen(color, i, columns)
  for (let i = 0; i < columns; i += 1) {
    if (i < full) words.push(FULL, fill(i), track)
    else if (i === full && part > 0) words.push(EIGHTHS[part]!, fill(i), track)
    else words.push(FULL, track, track)
  }
  return { columns, rows: 1, cells: encode(words) }
}
