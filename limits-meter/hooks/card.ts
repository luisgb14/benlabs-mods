import { captionOf, detailsOf, DARK, levelColor, type Seg, warningOf } from './band'
import { fmtPct, type View } from './meter'
import { modelLine } from './model'

/** A drawn card: the SVG markup, its size in CSS pixels, and its text equivalent. */
export type Card = { source: string; width: number; height: number; alt: string }

/** The session's model and effort, for the caption at the top right. */
export type Which = { model: string | null; effort: string | null }

// The desktop card draws the terminal band's design: three columns of label
// and percentage over a bar, in the same deep inks. where-am-i's card shares
// this width and grid, so its row lines up underneath; keep them in step.
const FONT = `'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace` // the terminal band's look
const PAD = 12 // the inset where-am-i's production banner needs, kept on both cards
const GAP = 28
/** The narrowest column; below it, one row per meter. */
const MIN_COLUMN = 170
const BAR = 8

const STYLE = `
text{font-family:${FONT};white-space:pre}
.num{font-variant-numeric:tabular-nums}
.t{fill:#ececee}.m{fill:#9a9aa0}.track{fill:#3a3a3a}
@media (prefers-color-scheme: light){.t{fill:#1c1c1e}.m{fill:#6e6e73}.track{fill:#d9d9d9}}`
const CAPTION = 22 // the caption row's height, when there is one

/** The card's width for a band `bodyColumns` wide: the image scales down when the slot is narrower. */
export function desktopWidth(bodyColumns: number): number {
  return Math.round(Math.min(860, Math.max(320, bodyColumns * 7.5)))
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Width of monospace text, on the generous side so runs never collide. */
const textWidth = (s: string, size: number, _bold = false) => s.length * size * 0.61

const n2 = (n: number) => Math.round(n * 100) / 100

type Run = { text: string; fill?: string; muted?: boolean; bold?: boolean }

const runsWidth = (runs: readonly Run[], size: number) => runs.reduce((n, r) => n + textWidth(r.text, size, r.bold), 0)

function tspans(runs: readonly Run[]): string {
  return runs
    .map(r => {
      const attrs = [r.muted ? 'class="m"' : '', r.fill ? `fill="${r.fill}"` : '', r.bold ? 'font-weight="700"' : '']
      return `<tspan ${attrs.filter(Boolean).join(' ')}>${esc(r.text)}</tspan>`
    })
    .join('')
}

export function cardTitle(v: View): string {
  if (v.kind === 'five_hour') return '5-hour limit'
  if (v.kind === 'seven_day') return 'Weekly limit'
  if (v.kind === 'context') return 'Context window'
  return `${v.label[0]?.toUpperCase() ?? ''}${v.label.slice(1)} limit`
}

export function cardReset(v: View): string {
  if (v.note !== undefined) return v.note
  if (v.resetIn === undefined) return ''
  return v.resetIn === 'reset' ? 'Resets now' : `Resets in ${v.resetIn}`
}

/** The warning (with the detail when it fits) or the longest detail that fits in `room`. */
function rightRuns(v: View, room: number, size: number): Run[] {
  const warning = warningOf(v, DARK)
  const details = detailsOf(v)
  const options: Run[][] = warning
    ? [
        ...details.map(d => [
          { text: warning.text, fill: warning.color ?? '', bold: true },
          { text: ` · ${d}`, muted: true },
        ]),
        [{ text: warning.text, fill: warning.color ?? '', bold: true }],
      ]
    : details.map(d => [{ text: d, muted: true }])
  return options.find(r => runsWidth(r, size) <= room) ?? []
}

/** A rounded bar: the track, and the fill in the meter's color. */
function bar(v: View, x: number, y: number, w: number): string {
  const fill = (Math.min(100, Math.max(0, v.pct)) / 100) * w
  return (
    `<rect class="track" x="${n2(x)}" y="${y}" width="${n2(w)}" height="${BAR}"/>` +
    (fill > 0
      ? `<rect x="${n2(x)}" y="${y}" width="${n2(Math.max(BAR, fill))}" height="${BAR}" fill="${levelColor(v, DARK)}"/>`
      : '')
  )
}

/**
 * The model and effort, right-aligned at the top: the terminal band's caption
 * as SVG text. Empty when neither is known.
 */
function captionSvg(which: Which, width: number): string {
  const segs: Seg[] = captionOf(which.model, which.effort, Math.floor((width - 2 * PAD) / (12 * 0.61)))
  if (segs.length === 0) return ''
  const spans = segs
    .map(s => {
      const cls = s.dim ? 'm' : s.color === undefined ? 't' : ''
      const attrs = [cls ? `class="${cls}"` : '', s.color ? `fill="${s.color}"` : '', s.bold ? 'font-weight="700"' : '']
      return `<tspan ${attrs.filter(Boolean).join(' ')}>${esc(s.text)}</tspan>`
    })
    .join('')
  return `<text x="${width - PAD}" y="${CAPTION / 2 - 2}" dy=".35em" text-anchor="end" font-size="12">${spans}</text>`
}

const hasCaption = (which: Which) => which.model !== null || which.effort !== null

function svg(width: number, height: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${STYLE}</style>${body}</svg>`
  )
}

function altText(list: readonly View[], which: Which): string {
  const model = modelLine(which.model, which.effort)
  return (
    'Usage limits: ' +
    list
      .map(v => `${cardTitle(v)} ${fmtPct(v.pct)} used${v.note ? `, ${v.note}` : v.resetIn ? `, ${cardReset(v).toLowerCase()}` : ''}`)
      .join('; ') +
    (model === '' ? '' : `. Model: ${model}`)
  )
}

/** The card: a column per meter (label and percentage over a bar), or a row each when narrow. */
export function limitsCard(list: readonly View[], bodyColumns: number, which: Which): Card {
  const width = desktopWidth(bodyColumns)
  const n = Math.max(3, list.length)
  const cw = (width - 2 * PAD - (n - 1) * GAP) / n
  if (cw < MIN_COLUMN) return limitsRows(list, width, which)

  const top = hasCaption(which) ? CAPTION : 0
  const height = 40 + top
  const ty = 14 + top
  const by = 25 + top
  const body =
    captionSvg(which, width) +
    list
    .map((v, i) => {
      const x = PAD + i * (cw + GAP)
      const pct = fmtPct(v.pct)
      const leftWidth = textWidth(v.label, 12) + 5 + textWidth(pct, 13, true)
      const right = rightRuns(v, cw - leftWidth - 14, 12)
      return (
        `<text x="${n2(x)}" y="${ty}" dy=".35em" font-size="12"><tspan class="m">${esc(v.label)}</tspan>` +
        `<tspan dx="5" font-size="13" font-weight="700" class="num" fill="${levelColor(v, DARK)}">${pct}</tspan></text>` +
        (right.length > 0
          ? `<text x="${n2(x + cw)}" y="${ty}" dy=".35em" text-anchor="end" font-size="12">${tspans(right)}</text>`
          : '') +
        bar(v, x, by, cw)
      )
    })
    .join('')
  return { source: svg(width, height, body), width, height, alt: altText(list, which) }
}

/** Narrow slots: one row per meter, the bars ending together. */
function limitsRows(list: readonly View[], width: number, which: Which): Card {
  const row = 24
  const top = hasCaption(which) ? CAPTION : 0
  const height = list.length * row + 8 + top
  const label = 60
  const pctWidth = 38
  const rights = list.map(v => rightRuns(v, width * 0.32, 12))
  const detail = Math.max(0, ...rights.map(r => runsWidth(r, 12)))
  const barEnd = width - PAD - (detail > 0 ? detail + 12 : 0) - pctWidth
  const body = list
    .map((v, i) => {
      const cy = top + 6 + i * row + row / 2
      const right = rights[i] ?? []
      return (
        `<text x="${PAD}" y="${cy}" dy=".35em" font-size="12" class="m">${esc(v.label)}</text>` +
        bar(v, PAD + label, cy - BAR / 2, Math.max(24, barEnd - PAD - label - 8)) +
        `<text x="${n2(barEnd + pctWidth)}" y="${cy}" dy=".35em" text-anchor="end" font-size="13" font-weight="700" class="num" fill="${levelColor(v, DARK)}">${fmtPct(v.pct)}</text>` +
        (right.length > 0
          ? `<text x="${width - PAD}" y="${cy}" dy=".35em" text-anchor="end" font-size="12">${tspans(right)}</text>`
          : '')
      )
    })
    .join('')
  return { source: svg(width, height, captionSvg(which, width) + body), width, height, alt: altText(list, which) }
}

/** Shown before the first reading arrives: the message, and the caption on the same row. */
export function waitingCard(bodyColumns: number, which: Which): Card {
  const width = desktopWidth(bodyColumns)
  const height = CAPTION + 6
  const text = "Claude usage appears after Claude's first reply"
  return {
    source: svg(
      width,
      height,
      `<text x="${PAD}" y="${CAPTION / 2 - 2}" dy=".35em" font-size="12" class="m">${esc(text)}</text>` + captionSvg(which, width),
    ),
    width,
    height,
    alt: text,
  }
}
