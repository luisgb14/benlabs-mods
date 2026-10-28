import { fmtPct, paceOf, type View } from './meter'
import { EFFORTS, effortStep, MODEL_COLOR, modelName } from './model'

/**
 * The terminal band's colors: one set of deep, saturated inks on dark and
 * light themes alike; only the bar's track follows the theme. where-am-i
 * keeps the same set, so the two bands match.
 */
export type Palette = { green: string; yellow: string; peach: string; red: string; sky: string; track: string }

const INKS = { green: '#40a02b', yellow: '#df8e1d', peach: '#fe640b', red: '#d20f39', sky: '#04a5e5' }

export const DARK: Palette = { ...INKS, track: '#3a3a3a' }

export const LIGHT: Palette = { ...INKS, track: '#d9d9d9' }

/** A run of text in one style. */
export type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean }

// The grid, shared with where-am-i, whose row lines up under these columns.
export const MARGIN = 1
export const GAP = 4
/** The narrowest terminal that gets columns; below it, one row per meter. */
export const GRID_MIN = 80
const LABEL = 8 // "context " in the one-row-per-meter layout

/** The width of each of `n` columns across `columns`. */
export function columnWidth(columns: number, n = 3): number {
  return Math.floor((columns - 2 * MARGIN - (n - 1) * GAP) / n)
}

export const widthOf = (segs: readonly Seg[]) => segs.reduce((n, s) => n + s.text.length, 0)

/** `left`, spaces, then `right`: exactly `n` columns when they fit. */
export function spread(left: readonly Seg[], right: readonly Seg[], n: number): Seg[] {
  const gap = n - widthOf(left) - widthOf(right)
  return gap > 0 ? [...left, { text: ' '.repeat(gap) }, ...right] : [...left, ...right]
}

/** A meter's color: how full it is; for the context, how near auto-compaction. */
export function levelColor(v: View, p: Palette): string {
  if (v.kind === 'context') {
    const fill = v.fill ?? v.pct / 100
    return fill >= 0.9 ? p.red : fill >= 0.7 ? p.yellow : p.sky
  }
  return v.pct >= 92 ? p.red : v.pct >= 80 ? p.peach : v.pct >= 60 ? p.yellow : p.green
}

/** The forecast or warning worth showing, colored by how bad it is; nothing when all is well. */
export function warningOf(v: View, p: Palette): Seg | undefined {
  const pace = paceOf(v)
  if (pace === undefined || pace.severity === 0) return undefined
  const color = pace.severity === 1 ? p.yellow : pace.severity === 2 ? p.peach : p.red
  return { text: pace.short, color, bold: true }
}

/** The detail beside a meter, longest first: when it resets, or the context's tokens. */
export function detailsOf(v: View): string[] {
  if (v.kind === 'context' && v.note !== undefined) {
    const short = v.note.replace(/ tokens$/, '')
    return [v.note, short, short.replace(' of ', '/')]
  }
  if (v.resetIn === undefined) return []
  if (v.resetIn === 'reset') return ['window reset', 'reset']
  return [`resets in ${v.resetIn}`, `in ${v.resetIn}`, v.resetIn]
}

const SHORT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', context: 'ctx' }

/**
 * A meter's top line in a column `n` wide: the label and percentage at the
 * left, the warning or the detail at the right, the longest that fits.
 */
export function meterLine(v: View, n: number, p: Palette): Seg[] {
  const pct: Seg = { text: fmtPct(v.pct), color: levelColor(v, p), bold: true }
  let left: Seg[] = [{ text: v.label, dim: true }, { text: ' ' }, pct]
  if (widthOf(left) > n) left = [{ text: SHORT_LABEL[v.kind] ?? v.label.slice(0, 3), dim: true }, { text: ' ' }, pct]
  const warning = warningOf(v, p)
  const details = detailsOf(v)
  const options: Seg[][] = warning
    ? [...details.map(d => [warning, { text: ` · ${d}`, dim: true }]), [warning]]
    : details.map(d => [{ text: d, dim: true }])
  const right = options.find(r => widthOf(left) + 2 + widthOf(r) <= n) ?? []
  return spread(left, right, n)
}

/**
 * A meter as a row of its own, for narrow terminals: the label, then a bar
 * `bar` wide, then the percentage and the warning or a short detail.
 */
export function meterRow(v: View, columns: number, p: Palette): { label: Seg[]; bar: number; right: Seg[] } {
  const label: Seg[] = [{ text: ' '.repeat(MARGIN) }, { text: v.label.slice(0, LABEL - 1).padEnd(LABEL), dim: true }]
  const pct: Seg = { text: fmtPct(v.pct).padStart(5), color: levelColor(v, p), bold: true }
  const warning = warningOf(v, p)
  const options: Seg[][] = [
    ...(warning ? [[warning]] : []),
    ...detailsOf(v)
      .slice(1)
      .map(d => [{ text: d, dim: true }]),
  ]
  for (const option of options) {
    const bar = columns - widthOf(label) - widthOf([pct]) - 2 - widthOf(option) - MARGIN
    if (bar >= 10) return { label, bar, right: [pct, { text: '  ' }, ...option] }
  }
  return { label, bar: Math.max(4, columns - widthOf(label) - widthOf([pct]) - MARGIN), right: [pct] }
}

/**
 * The model and its effort, for the top right of the band, over the context
 * column: "Opus 5.5 · 1M   effort ●●●●○ xhigh", shortened to fit `room`.
 */
export function captionOf(model: string | null, effort: string | null, room: number): Seg[] {
  const m = model === null ? undefined : modelName(model)
  const head: Seg[] =
    m === undefined
      ? []
      : [{ text: m.name, color: MODEL_COLOR, bold: true }, ...(m.tag === undefined ? [] : [{ text: ` · ${m.tag}`, dim: true }])]
  if (effort === null) return widthOf(head) <= room ? head : []
  const step = effortStep(effort)
  const dots: Seg[] =
    step === 0
      ? []
      : [
          { text: '●'.repeat(step), color: MODEL_COLOR },
          { text: '○'.repeat(EFFORTS.length - step), dim: true },
          { text: ' ' },
        ]
  const word: Seg = { text: effort, bold: true }
  const gap: Seg[] = head.length > 0 ? [{ text: '   ' }] : []
  const options: Seg[][] = [
    [...head, ...gap, { text: 'effort ', dim: true }, ...dots, word],
    [...head, ...gap, ...dots, word],
    [...head, ...(head.length > 0 ? [{ text: ' · ', dim: true }] : []), word],
    head,
  ]
  return options.find(o => widthOf(o) <= room) ?? []
}
