import type { ContextReading, LimitWindow } from '../types'

/** A run of same-colored characters in a bar. */
export type Run = { text: string; color: string }

/** Thresholds that raise a toast, once per window per reset. */
export const ALERT_LEVELS = [80, 95] as const

const EMPTY_COLOR = 'subtle'
const ORDER = ['five_hour', 'seven_day', 'spend_limit']

// Green → amber → orange → red, tuned to read well on dark and light themes.
const STOPS: Array<[number, [number, number, number]]> = [
  [0, [46, 204, 113]],
  [0.45, [46, 204, 113]],
  [0.65, [241, 196, 15]],
  [0.8, [243, 156, 18]],
  [0.92, [231, 76, 60]],
  [1, [214, 48, 49]],
]

const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0')

/** Color for a position 0..1 along the heat gradient (quantized so runs merge). */
export function heat(t: number): string {
  const q = Math.round(Math.min(1, Math.max(0, t)) * 20) / 20
  for (let i = 1; i < STOPS.length; i += 1) {
    const hi = STOPS[i]
    const lo = STOPS[i - 1]
    if (hi === undefined || lo === undefined) continue
    const [t1, c1] = hi
    const [t0, c0] = lo
    if (q <= t1) {
      const f = t1 === t0 ? 0 : (q - t0) / (t1 - t0)
      return `#${hex(c0[0] + (c1[0] - c0[0]) * f)}${hex(c0[1] + (c1[1] - c0[1]) * f)}${hex(c0[2] + (c1[2] - c0[2]) * f)}`
    }
  }
  return '#d63031'
}

/** Color for a percentage used. */
export const heatOf = (pct: number) => heat(pct / 100)

/** A gradient bar `width` cells wide, half-cell precise, as colored runs. */
export function barRuns(pct: number, width: number): Run[] {
  const clamped = Math.min(100, Math.max(0, pct))
  const halves = Math.round((clamped / 100) * width * 2)
  const full = Math.floor(halves / 2)
  const half = halves % 2
  const runs: Run[] = []
  const push = (text: string, color: string) => {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === color) last.text += text
    else runs.push({ text, color })
  }
  for (let i = 0; i < full; i += 1) push('━', heat((i + 0.5) / width))
  if (half === 1) push('╸', heat((full + 0.25) / width))
  const empty = width - full - half
  if (empty > 0) push('─'.repeat(empty), EMPTY_COLOR)
  return runs
}

/** Plain block bar for text output (no colors available there). */
export function blockBar(pct: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Colored dot emoji for surfaces that only take plain text. */
export function dot(pct: number): string {
  if (pct >= 95) return '🔴'
  if (pct >= 80) return '🟠'
  if (pct >= 50) return '🟡'
  return '🟢'
}

export function label(kind: string): string {
  if (kind === 'five_hour') return '5-hour'
  if (kind === 'seven_day') return 'weekly'
  if (kind === 'spend_limit') return 'spend'
  return kind.replace(/_/g, ' ')
}

/** Time until `ms` from now, compact: 42m, 2h 05m, 4d 6h. */
export function until(ms: number): string {
  if (ms <= 0) return 'now'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** How long ago `ms` was, compact. */
export function ago(ms: number): string {
  if (ms < 60_000) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** A window as of `now`: one whose reset has passed reads 0%. */
export type View = {
  kind: string
  label: string
  pct: number
  resetIn: string | undefined
  /** Milliseconds until the reset; absent when the engine gave no time. */
  msLeft?: number
  /** Shown instead of the reset time: the context window's "270k of 500k tokens". */
  note?: string
  /** Context only: how far toward auto-compaction (or toward full, with it off), 0 to 1. */
  fill?: number
  /** Context only: the token count where auto-compaction runs. */
  compactAt?: number
}

/** Token counts the short way: 850, 270k, 1M, 1.5M. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1))}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** The context window as a panel like the limits: kind `context`. A `~` marks an estimate. */
export function contextView(c: ContextReading): View {
  const view: View = {
    kind: 'context',
    label: 'context',
    pct: c.percent,
    resetIn: undefined,
    note: `${c.isEstimate ? '~' : ''}${fmtTokens(c.tokens)} of ${fmtTokens(c.limit)} tokens`,
    fill: c.compactAt === undefined || c.compactAt <= 0 ? c.percent / 100 : c.tokens / c.compactAt,
  }
  if (c.compactAt !== undefined) view.compactAt = c.compactAt
  return view
}

export function views(windows: readonly LimitWindow[], now: number): View[] {
  return [...windows]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(w => {
      const at = w.resetsAt === undefined ? NaN : Date.parse(w.resetsAt)
      const hasReset = Number.isFinite(at) && at <= now
      const view: View = {
        kind: w.kind,
        label: label(w.kind),
        pct: hasReset ? 0 : w.percentUsed,
        resetIn: Number.isFinite(at) ? (hasReset ? 'reset' : until(at - now)) : undefined,
      }
      if (Number.isFinite(at) && !hasReset) view.msLeft = at - now
      return view
    })
}

const SPAN_MS: Record<string, number> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 24 * 3_600_000,
}

export type Pace = {
  text: string
  color: string
  /** 0 all well, 1 worth a look, 2 heading for trouble, 3 trouble now. */
  severity: 0 | 1 | 2 | 3
  /** The terminal band's words for it, lower-case; empty when all is well. */
  short: string
}

const GREEN = '#2ecc71'
const AMBER = '#f1c40f'
const ORANGE = '#f39c12'
const RED = '#e74c3c'

/**
 * How the window is going, from usage so far against time elapsed in it:
 * on track, tight, or when the limit will be hit at this rate.
 */
export function paceOf(v: View): Pace | undefined {
  const fine = (text: string): Pace => ({ text, color: GREEN, severity: 0, short: '' })
  if (v.kind === 'context') {
    const fill = v.fill ?? v.pct / 100
    if (fill >= 0.9) {
      const text = v.compactAt === undefined ? 'Almost full' : 'Compacting soon'
      return { text, color: RED, severity: 3, short: text.toLowerCase() }
    }
    if (fill >= 0.7) return { text: 'Filling up', color: AMBER, severity: 1, short: 'filling up' }
    return fine('Plenty of room')
  }
  if (v.pct >= 100) return { text: 'Limit reached', color: RED, severity: 3, short: 'limit reached' }
  const span = SPAN_MS[v.kind]
  if (span === undefined || v.msLeft === undefined) return undefined
  const elapsed = span - v.msLeft
  if (v.pct < 1) return fine('Plenty left')
  if (elapsed < span * 0.05) return fine('Window just started')
  const rate = v.pct / elapsed // % per ms
  const msToFull = (100 - v.pct) / rate
  // Only call out a run-out time when it lands well before the reset.
  if (msToFull < v.msLeft * 0.85) {
    const hot = v.pct >= 80
    return { text: `Limit in ~${until(msToFull)}`, color: hot ? RED : ORANGE, severity: hot ? 3 : 2, short: `limit in ~${until(msToFull)}` }
  }
  const projected = v.pct + rate * v.msLeft
  if (projected > 85) return { text: 'Tight pace', color: AMBER, severity: 1, short: 'tight pace' }
  return fine('On track')
}

function rank(kind: string): number {
  const i = ORDER.indexOf(kind)
  return i === -1 ? ORDER.length : i
}

export const fmtPct = (pct: number) => `${Math.round(pct)}%`

/** One-line summary for a plain status line. */
export function compact(list: readonly View[]): string {
  return list
    .map(v => `${dot(v.pct)} ${v.label} ${fmtPct(v.pct)}${v.resetIn ? ` (${v.resetIn})` : ''}`)
    .join('   ')
}

/** Multi-line text for /limits. */
export function detail(list: readonly View[], age: string): string {
  const width = Math.max(...list.map(v => v.label.length))
  const rows = list.map(
    v =>
      `${dot(v.pct)} ${v.label.padEnd(width)}  ${blockBar(v.pct, 20)}  ${fmtPct(v.pct).padStart(4)}` +
      (v.resetIn ? `   resets ${v.resetIn === 'reset' ? 'now' : `in ${v.resetIn}`}` : v.note ? `   ${v.note}` : '') +
      (v.compactAt === undefined ? '' : ` · auto-compacts at ${fmtTokens(v.compactAt)}`),
  )
  return ['Claude usage limits · ' + age, ...rows].join('\n')
}

/** Highest level from ALERT_LEVELS reached, or 0. */
export function levelOf(pct: number): number {
  let level = 0
  for (const t of ALERT_LEVELS) if (pct >= t) level = t
  return level
}
