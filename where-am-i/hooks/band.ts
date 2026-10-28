import type { Tier, Where } from '../types'
import { clip, SSO_WARN_MS, ssoLeft } from './probe'

/**
 * The terminal band's colors: limits-meter's deep, saturated inks, the same on
 * dark and light themes, plus a color of its own for each part. Only the
 * production banner's background follows the theme.
 */
export type Palette = {
  blue: string
  peach: string
  mauve: string
  green: string
  yellow: string
  red: string
  sky: string
  badgeInk: string
  prodBg: string
}

const INKS = {
  blue: '#1e66f5',
  peach: '#fe640b',
  mauve: '#8839ef',
  green: '#40a02b',
  yellow: '#df8e1d',
  red: '#d20f39',
  sky: '#04a5e5',
  badgeInk: '#ffffff',
}

export const DARK: Palette = { ...INKS, prodBg: '#2c1418' }

export const LIGHT: Palette = { ...INKS, prodBg: '#fde4e8' }

/** A run of text in one style. */
export type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean; bg?: string }

// limits-meter's grid, so this row lines up under its three columns.
export const MARGIN = 1
export const GAP = 4
/** The narrowest terminal that gets the grid; below it, the parts are packed into one line. */
export const GRID_MIN = 80
const MIN_VALUE = 12 // a value keeps this much room before its right-hand detail is dropped

export const columnWidth = (columns: number) => Math.floor((columns - 2 * MARGIN - 2 * GAP) / 3)

export const widthOf = (segs: readonly Seg[]) => segs.reduce((n, s) => n + s.text.length, 0)

/** `left`, spaces, then `right`: exactly `n` columns when they fit. */
export function spread(left: readonly Seg[], right: readonly Seg[], n: number): Seg[] {
  const gap = n - widthOf(left) - widthOf(right)
  return gap > 0 ? [...left, { text: ' '.repeat(gap) }, ...right] : [...left, ...right]
}

/**
 * One part of the row: its label, its value, and what goes at its right,
 * longest first. With `keep`, the right-hand detail matters more than the end
 * of the value (a PROD badge, git's marks, an SSO login about to expire), so
 * the value is clipped before it goes.
 */
export type Part = {
  key: 'kube' | 'aws' | 'git'
  label: string
  value: string
  color: string
  rights: Seg[][]
  keep: boolean
}

/** A value's color: red on production, amber on staging-like targets, its own color otherwise. */
const tierInk = (tier: Tier, own: string, p: Palette) => (tier === 'prod' ? p.red : tier === 'caution' ? p.yellow : own)

function badge(env: string, tier: Tier, p: Palette): Seg {
  return { text: ` ${env === 'PRODUCTION' ? 'PROD' : env} `, color: p.badgeInk, bg: tier === 'prod' ? p.red : p.yellow, bold: true }
}

export function partsOf(w: Where, now: number, p: Palette): Part[] {
  const parts: Part[] = []
  if (w.kube) {
    const k = w.kube
    const ns: Seg | undefined = k.namespace && k.namespace !== 'default' ? { text: k.namespace, dim: true } : undefined
    let tag: Seg | undefined
    if ((k.tier === 'prod' || k.tier === 'caution') && k.env) tag = badge(k.env, k.tier, p)
    else if (k.tier === 'safe' && k.env) tag = { text: k.env.toLowerCase(), color: p.green }
    const rights: Seg[][] = []
    if (ns && tag) rights.push([ns, { text: ' ' }, tag])
    if (tag) rights.push([tag])
    else if (ns) rights.push([ns])
    const keep = k.tier === 'prod' || k.tier === 'caution'
    parts.push({ key: 'kube', label: 'k8s', value: k.name, color: tierInk(k.tier, p.blue, p), rights, keep })
  }
  if (w.aws) {
    const a = w.aws
    const region: Seg | undefined = a.region ? { text: a.region, dim: true } : undefined
    let sso: Seg | undefined
    let keep = false
    if (a.ssoExpiresAt !== undefined) {
      const ms = a.ssoExpiresAt - now
      const left = ssoLeft(a.ssoExpiresAt, now)
      sso =
        ms <= 0
          ? { text: 'sso expired', color: p.red, bold: true }
          : ms < SSO_WARN_MS
            ? { text: `sso ${left}`, color: p.yellow, bold: true }
            : { text: `sso ${left}`, dim: true }
      keep = ms < SSO_WARN_MS
    }
    const rights: Seg[][] = []
    if (region && sso) rights.push([region, { text: ' · ', dim: true }, sso])
    if (sso) rights.push([sso])
    else if (region) rights.push([region])
    parts.push({ key: 'aws', label: 'aws', value: a.profile, color: tierInk(a.tier, p.peach, p), rights, keep })
  }
  if (w.git) {
    const g = w.git
    // The marks your prompt uses (powerlevel10k): ⇣ behind, ⇡ ahead, ~ conflicts, + staged, ! modified, ? untracked.
    const marks: Seg[] = []
    const mark = (count: number | undefined, sym: string, color: string) => {
      if (count === undefined || count <= 0) return
      if (marks.length > 0) marks.push({ text: ' ' })
      marks.push({ text: `${sym}${count}`, color, bold: true })
    }
    mark(g.behind, '⇣', p.blue)
    mark(g.ahead, '⇡', p.blue)
    mark(g.conflicted, '~', p.red)
    mark(g.staged, '+', p.green)
    mark(g.unstaged, '!', p.yellow)
    mark(g.untracked, '?', p.sky)
    const rights = marks.length > 0 ? [marks] : []
    parts.push({ key: 'git', label: 'git', value: g.branch, color: p.mauve, rights, keep: marks.length > 0 })
  }
  return parts
}

/**
 * A part in a column `n` wide: label and value at the left, and at the right
 * the longest detail that leaves the value whole. Failing that, a part that
 * keeps its detail clips its value instead; any other drops the detail.
 */
export function cell(part: Part, n: number): Seg[] {
  const head: Seg[] = [{ text: part.label, dim: true }, { text: ' ' }]
  const room = (right: Seg[]) => n - widthOf(head) - (right.length > 0 ? widthOf(right) + 2 : 0)
  const draw = (right: Seg[]) =>
    spread([...head, { text: clip(part.value, Math.max(1, room(right))), color: part.color, bold: true }], right, n)
  const whole = part.rights.find(right => room(right) >= part.value.length)
  if (whole !== undefined) return draw(whole)
  if (part.keep) {
    const clipped = part.rights.find(right => room(right) >= MIN_VALUE)
    if (clipped !== undefined) return draw(clipped)
  }
  return draw([])
}

/** The parts on limits-meter's three columns. */
export function gridRow(parts: readonly Part[], columns: number): Seg[] {
  const n = columnWidth(columns)
  const row: Seg[] = [{ text: ' '.repeat(MARGIN) }]
  parts.forEach((part, i) => {
    if (i > 0) row.push({ text: ' '.repeat(GAP) })
    row.push(...cell(part, n))
  })
  return row
}

/**
 * Narrow terminals: the parts on one line, shortening their details, then
 * keeping only the ones that matter; when even that is too wide, one part per
 * row with the values aligned.
 */
export function narrowRows(parts: readonly Part[], columns: number): Seg[][] {
  const line = (pick: (part: Part) => Seg[] | undefined): Seg[] => {
    const row: Seg[] = [{ text: ' '.repeat(MARGIN) }]
    parts.forEach((part, i) => {
      if (i > 0) row.push({ text: '   ' })
      row.push({ text: part.label, dim: true }, { text: ' ' }, { text: part.value, color: part.color, bold: true })
      const right = pick(part)
      if (right !== undefined && right.length > 0) row.push({ text: ' ' }, ...right)
    })
    return row
  }
  const shortest = (part: Part) => part.rights[part.rights.length - 1]
  for (const pick of [(part: Part) => part.rights[0], shortest, (part: Part) => (part.keep ? shortest(part) : undefined)]) {
    const row = line(pick)
    if (widthOf(row) <= columns) return [row]
  }
  const head = MARGIN + 4 // margin, then "k8s "
  const valueWidth = Math.min(Math.max(...parts.map(part => part.value.length)), Math.max(6, columns - head))
  return parts.map(part => {
    const value = clip(part.value, valueWidth)
    const left: Seg[] = [
      { text: ' '.repeat(MARGIN) },
      { text: part.label, dim: true },
      { text: ' ' },
      { text: value, color: part.color, bold: true },
    ]
    const right = part.rights.find(r => head + valueWidth + 2 + widthOf(r) <= columns)
    if (right === undefined) return left
    return [...left, { text: ' '.repeat(valueWidth - value.length + 2) }, ...right]
  })
}

/** The row as a banner: every cell on `bg`, padded to the full width. */
export function tint(row: readonly Seg[], columns: number, bg: string): Seg[] {
  const padded = widthOf(row) < columns ? [...row, { text: ' '.repeat(columns - widthOf(row)) }] : [...row]
  return padded.map(s => (s.bg === undefined ? { ...s, bg } : s))
}
