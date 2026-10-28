/** The effort levels Claude Code takes, lowest first. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** Claude's own orange, for the model's name and its effort. */
export const MODEL_COLOR = '#d97757'

/**
 * A model id as people say it: `claude-opus-5-5[1m]` is Opus 5.5 with a 1M
 * window, `claude-haiku-4-5-20251001` is Haiku 4.5. Anything else stays as given.
 */
export function modelName(id: string): { name: string; tag?: string } {
  const m = id.match(/^(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i)
  if (m === null || m[1] === undefined || m[2] === undefined) return { name: id }
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  const name = `${family} ${m[3] === undefined ? m[2] : `${m[2]}.${m[3]}`}`
  return m[4] === undefined ? { name } : { name, tag: '1M' }
}

/** How far up the levels `effort` is, 1 to 5; 0 for a level this mod doesn't know. */
export function effortStep(effort: string): number {
  return (EFFORTS as readonly string[]).indexOf(effort) + 1
}

/**
 * The effort a settings file gives model `id`, matched the way Claude Code
 * matches it (checked against 2.1.291): the `modelSettings` entry for the
 * exact id, with its `[1m]` and then without, else for its alias (`opus[1m]`,
 * then `opus`). Keys match exactly, so `claude-opus-5` does not cover
 * `claude-opus-5-5`, and a top-level `effortLevel` is not applied.
 */
export function effortIn(settings: unknown, id: string): string | undefined {
  if (typeof settings !== 'object' || settings === null) return undefined
  const perModel = (settings as Record<string, unknown>)['modelSettings']
  if (typeof perModel !== 'object' || perModel === null) return undefined
  const entries = perModel as Record<string, unknown>
  const base = id.replace(/\[1m\]$/i, '')
  const family = base.match(/^(?:claude-)?([a-z]+)-\d/i)?.[1]?.toLowerCase()
  const keys = [id, base]
  if (family !== undefined) keys.push(...(base === id ? [family] : [`${family}[1m]`, family]))
  for (const key of keys) {
    const entry = entries[key]
    const level = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['effortLevel'] : undefined
    if (typeof level === 'string') return level
  }
  return undefined
}

/** One line for plain text: "Opus 5.5 · 1M · effort xhigh". */
export function modelLine(model: string | null, effort: string | null): string {
  const parts: string[] = []
  if (model !== null) {
    const m = modelName(model)
    parts.push(m.tag === undefined ? m.name : `${m.name} · ${m.tag}`)
  }
  if (effort !== null) parts.push(`effort ${effort}`)
  return parts.join(' · ')
}
