import type { Where } from '../types'
import { DARK, partsOf, type Part, type Seg } from './band'
import { clip, ssoLeft, worst } from './probe'

/** A drawn card: the SVG markup, its size in CSS pixels, and its text equivalent. */
export type Card = { source: string; width: number; height: number; alt: string }

// The desktop card draws the terminal line's design: label and value at the
// left of each column, details at the right, a red banner on production. It
// shares limits-meter's card width and grid, so it lines up underneath that
// card's columns; keep them in step.
const FONT = `'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace` // the terminal band's look
const PAD = 12 // room inside the production banner, kept on both cards so the columns align
const GAP = 28
/** The narrowest column; below it, one part per row. */
const MIN_COLUMN = 170
const MIN_VALUE = 96 // a value keeps this much room (about 12 characters) before a kept detail clips it

const STYLE = `
text{font-family:${FONT};white-space:pre}
.m{fill:#9a9aa0}.banner{fill:rgba(210,15,57,.16)}
@media (prefers-color-scheme: light){.m{fill:#6e6e73}.banner{fill:#fde4e8}}`

/** limits-meter's card width for a band `bodyColumns` wide. */
export function desktopWidth(bodyColumns: number): number {
  return Math.round(Math.min(860, Math.max(320, bodyColumns * 7.5)))
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Width of monospace text, on the generous side so runs never collide. */
const textWidth = (s: string, size: number, _bold = false) => s.length * size * 0.61

const n2 = (n: number) => Math.round(n * 100) / 100

/** A badge is the one segment with a background: drawn as a pill, not text. */
const isBadge = (s: Seg) => s.bg !== undefined
const BADGE_SIZE = 10.5
const badgeWidth = (s: Seg) => textWidth(s.text.trim(), BADGE_SIZE, true) + 12

function segsWidth(segs: readonly Seg[], size: number): number {
  return segs.reduce((n, s) => n + (isBadge(s) ? badgeWidth(s) + 6 : textWidth(s.text, size, s.bold)), 0)
}

function tspans(segs: readonly Seg[]): string {
  return segs
    .map(s => {
      const attrs = [s.dim ? 'class="m"' : '', s.color ? `fill="${s.color}"` : '', s.bold ? 'font-weight="700"' : '']
      return `<tspan ${attrs.filter(Boolean).join(' ')}>${esc(s.text)}</tspan>`
    })
    .join('')
}

/** Segments right-aligned at `right`: text runs, then a badge pill at the very end. */
function rightSvg(segs: readonly Seg[], right: number, cy: number): string {
  const badge = segs.find(isBadge)
  const text = segs.filter(s => !isBadge(s))
  let out = ''
  let end = right
  if (badge !== undefined) {
    const w = badgeWidth(badge)
    const h = 18
    out +=
      `<rect x="${n2(right - w)}" y="${n2(cy - h / 2)}" width="${n2(w)}" height="${h}" rx="5" fill="${badge.bg}"/>` +
      `<text x="${n2(right - w / 2)}" y="${cy}" dy=".36em" text-anchor="middle" font-size="${BADGE_SIZE}" font-weight="700" letter-spacing=".04em" fill="${badge.color ?? '#ffffff'}">${esc(badge.text.trim())}</text>`
    end = right - w - 6
  }
  // Drop the gap a badge leaves at the end of the text run.
  while (text.length > 0 && text[text.length - 1]?.text.trim() === '') text.pop()
  if (text.length > 0) {
    out += `<text x="${n2(end)}" y="${cy}" dy=".35em" text-anchor="end" font-size="12">${tspans(text)}</text>`
  }
  return out
}

/**
 * A part in a column `cw` wide: the longest right-hand detail that leaves the
 * value whole; failing that, a part that keeps its detail clips its value,
 * and any other drops the detail. The same rule as the terminal line's.
 */
function cellSvg(part: Part, x: number, cw: number, cy: number): string {
  const head = textWidth(part.label, 12) + 6
  const room = (right: Seg[]) => cw - head - (right.length > 0 ? segsWidth(right, 12) + 14 : 0)
  const valueWidth = textWidth(part.value, 13, true)
  let right: Seg[] = part.rights.find(r => room(r) >= valueWidth) ?? []
  if (right.length === 0 && part.keep) right = part.rights.find(r => room(r) >= MIN_VALUE) ?? []
  const fits = Math.max(1, Math.floor(room(right) / (13 * 0.61)))
  return (
    `<text x="${n2(x)}" y="${cy}" dy=".35em" font-size="12"><tspan class="m">${esc(part.label)}</tspan>` +
    `<tspan dx="6" font-size="13" font-weight="700" fill="${part.color}">${esc(clip(part.value, fits))}</tspan></text>` +
    (right.length > 0 ? rightSvg(right, x + cw, cy) : '')
  )
}

function svg(width: number, height: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${STYLE}</style>${body}</svg>`
  )
}

function altText(w: Where, now: number): string {
  const { env } = worst(w)
  const parts: string[] = []
  if (env) parts.push(`Environment ${env}`)
  if (w.kube) parts.push(`kube ${w.kube.name}${w.kube.namespace ? ` namespace ${w.kube.namespace}` : ''}`)
  if (w.aws) {
    let a = `aws ${w.aws.profile}`
    if (w.aws.ssoExpiresAt !== undefined) a += `, SSO ${ssoLeft(w.aws.ssoExpiresAt, now)}`
    parts.push(a)
  }
  if (w.git) {
    const g = w.git
    const bits = [`git ${g.branch}`]
    for (const [count, what] of [
      [g.conflicted, 'conflicted'],
      [g.staged, 'staged'],
      [g.unstaged, 'modified'],
      [g.untracked, 'untracked'],
      [g.ahead, 'to push'],
      [g.behind, 'to pull'],
    ] as const) {
      if (count > 0) bits.push(`${count} ${what}`)
    }
    parts.push(bits.join(', '))
  }
  return parts.join('; ')
}

/** One row on limits-meter's columns, or one part per row when narrow; a red banner on production. */
export function whereCard(w: Where, now: number, bodyColumns: number): Card {
  const width = desktopWidth(bodyColumns)
  const parts = partsOf(w, now, DARK)
  const isProd = worst(w).tier === 'prod'
  const cw = (width - 2 * PAD - 2 * GAP) / 3
  const alt = altText(w, now)

  if (cw >= MIN_COLUMN) {
    const height = 30
    const cy = height / 2
    const body =
      (isProd ? `<rect class="banner" x="0" y="0" width="${width}" height="${height}" rx="8"/>` : '') +
      parts.map((part, i) => cellSvg(part, PAD + i * (cw + GAP), cw, cy)).join('')
    return { source: svg(width, height, body), width, height, alt }
  }

  const row = 24
  const height = parts.length * row + 8
  const body =
    (isProd ? `<rect class="banner" x="0" y="0" width="${width}" height="${height}" rx="8"/>` : '') +
    parts.map((part, i) => cellSvg(part, PAD, width - 2 * PAD, 4 + i * row + row / 2)).join('')
  return { source: svg(width, height, body), width, height, alt }
}
