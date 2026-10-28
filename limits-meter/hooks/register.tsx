import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionContextUsage } from 'claude-code'

import type { ContextReading, LimitWindow, LimitsSnapshot } from '../types'
import { captionOf, columnWidth, DARK, GAP, GRID_MIN, levelColor, LIGHT, MARGIN, meterLine, meterRow, type Palette, type Seg, widthOf } from './band'
import { cardReset, cardTitle, limitsCard, waitingCard } from './card'
import { effortIn, effortStep, modelLine } from './model'
import { bigBar, bigText, bigWidth, meterBar, rgb } from './term'
import { ago, compact, contextView, detail, fmtPct, levelOf, paceOf, views, type Pace, type View } from './meter'

const snapshot = atom({ plugin: 'limits-meter', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'limits-meter', key: 'isHidden' } as const, false)
const hasNoLimits = atom({ plugin: 'limits-meter', key: 'hasNoLimits' } as const, false)
const isBig = atom({ plugin: 'limits-meter', key: 'isBig' } as const, false)
// Shape-tagged: a hot reload from 0.5.0, which kept another shape here, reads it as absent.
const context = atom({ plugin: 'limits-meter', key: 'context' } as const, null, { shape: 'context-v2' })
const model = atom({ plugin: 'limits-meter', key: 'model' } as const, null)
const effort = atom({ plugin: 'limits-meter', key: 'effort' } as const, null)

const STORE_SNAPSHOT = 'snapshot'
const STORE_HIDDEN = 'isHidden'
const STORE_ALERTS = 'alerts'
const STORE_BIG = 'isBig'

const TICK_MS = 30_000
const STALE_MS = 5 * 60_000
const SEP_WIDTH = 3 // " │ " between big panels
const NUMBER_WIDTH = bigWidth('100') // the pixel digits
const DIGITS_WIDTH = NUMBER_WIDTH + 2 // plus " %"
const MIN_BLOCK = 34 // narrowest text block beside the big number: title and pace with room

/** Set per session from the /config theme; light themes get the deeper palette. */
let isLightTheme = false

async function readTheme($: $) {
  try {
    const row = (await $.config.list()).find(r => r.key === 'theme')
    isLightTheme = typeof row?.value === 'string' && row.value.includes('light')
  } catch {
    isLightTheme = false
  }
}

type $ = EngineInterface

function isSnapshot(v: unknown): v is LimitsSnapshot {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as LimitsSnapshot).windows) &&
    typeof (v as LimitsSnapshot).observedAt === 'number'
  )
}

/** Toast once per window per reset when it crosses 80% and 95%, across all sessions. */
async function alertOn($: $, windows: readonly LimitWindow[], now: number) {
  const raw = await $.store.get(STORE_ALERTS)
  const seen: Record<string, number> =
    typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, number>) } : {}
  for (const key of Object.keys(seen)) {
    const at = Date.parse(key.split('|')[1] ?? '')
    if (Number.isFinite(at) && at <= now) delete seen[key]
  }
  let changed = false
  for (const v of views(windows, now)) {
    const level = levelOf(v.pct)
    const window = windows.find(w => w.kind === v.kind)
    const key = `${v.kind}|${window?.resetsAt ?? ''}`
    if (level === 0 || (seen[key] ?? 0) >= level) continue
    seen[key] = level
    changed = true
    const icon = level >= 95 ? '🔴' : '🟠'
    const reset = v.resetIn ? ` · resets in ${v.resetIn}` : ''
    $.ui.toast(`${icon} ${v.label} limit at ${fmtPct(v.pct)}${reset}`, { timeoutMs: 10_000 })
  }
  if (changed) await $.store.set(STORE_ALERTS, seen)
}

/** Set per session: the VS Code and mobile panels draw no band, so they get a status line. */
let usesPlainStatus = false

/**
 * How full this conversation's context is, the way /context counts it: against
 * the compaction window, from the last reply's tokens or, before the first reply
 * (or just after a compaction), a local estimate. A few milliseconds.
 */
async function measureContext($: $): Promise<ContextReading | null> {
  let c: SessionContextUsage
  try {
    c = (await $.session.usage({ breakdown: 'summary' })).context
  } catch {
    return null
  }
  const b = c.breakdown
  if (b !== undefined && b.rawMaxTokens > 0) {
    const reading: ContextReading = {
      tokens: b.totalTokens,
      limit: b.rawMaxTokens,
      percent: b.percentage,
      isEstimate: b.apiUsage === null,
    }
    if (b.isAutoCompactEnabled && b.autoCompactThreshold !== undefined) reading.compactAt = b.autoCompactThreshold
    return reading
  }
  // No breakdown: the status line's figures, once a reply has reported them.
  if (c.tokens === undefined || c.percent === undefined) return null
  return { tokens: c.tokens, limit: c.window, percent: c.percent, isEstimate: false }
}

async function refreshContext($: $) {
  const reading = await measureContext($)
  if (JSON.stringify(reading) === JSON.stringify(await read($, context))) return
  await update($, context, () => reading)
  await refreshStatus($)
}

/**
 * The 30-second tick: other sessions' limit readings, and the context again,
 * which also catches a /compact between replies.
 */
async function tick($: $) {
  // After /clear the session's state starts empty: look up the model again.
  if ((await read($, model)) === null) await readModel($)
  await refreshContext($)
  await sync($)
}

/** Everything the card shows, in order: the limit windows, then this session's context. */
async function panels($: $, now: number): Promise<View[]> {
  const snap = await read($, snapshot)
  const ctx = await read($, context)
  const limits = snap === null || (await read($, hasNoLimits)) ? [] : views(snap.windows, now)
  return ctx === null ? limits : [...limits, contextView(ctx)]
}

async function refreshStatus($: $) {
  if (!usesPlainStatus) return
  const list = await panels($, await $.clock.now())
  if (list.length === 0 || (await read($, isHidden))) {
    $.ui.status(undefined)
    return
  }
  const which = modelLine(await read($, model), await read($, effort))
  $.ui.status(which === '' ? compact(list) : `${which}   ${compact(list)}`)
}

async function readJson($: $, path: string): Promise<unknown> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

/** The effort the settings set for `id`: user, then project, then local settings, the last one that says. */
async function settingsEffort($: $, id: string): Promise<string | null> {
  const home = (await $.env.get('HOME')) ?? ''
  const root = await $.session.root().catch(() => undefined)
  const files = [`${home}/.claude/settings.json`]
  if (root !== undefined) files.push(`${root}/.claude/settings.json`, `${root}/.claude/settings.local.json`)
  let level: string | null = null
  for (const file of files) level = effortIn(await readJson($, file), id) ?? level
  return level
}

/** The session's model, and its effort as the settings set it until a turn reports the real one. */
async function readModel($: $) {
  const id = await $.session.model().catch(() => null)
  await update($, model, () => id)
  if (id !== null) {
    const level = await settingsEffort($, id)
    if (level !== null) await update($, effort, () => level)
  }
  await refreshStatus($)
}

/** An effort a turn or /effort reported. */
async function noteEffort($: $, level: string | undefined) {
  if (level === undefined || level === '' || level === (await read($, effort))) return
  await update($, effort, () => level)
  await refreshStatus($)
}

/** Adopt a newer reading another conversation saved, then redraw the countdowns. */
async function sync($: $) {
  const stored = await $.store.get(STORE_SNAPSHOT)
  if (isSnapshot(stored)) {
    const current = await read($, snapshot)
    if (current === null || stored.observedAt > current.observedAt) {
      await update($, snapshot, () => stored)
    }
  }
  $.ui.invalidate('ui.render')
  await refreshStatus($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    usesPlainStatus = e.surface === 'vscode' || e.surface === 'mobile'
    await readTheme($)

    await $.command.register({
      name: 'limits',
      description: 'Show your Claude 5-hour and weekly usage limits (show | hide | big | small)',
    })

    const hidden = await $.store.get(STORE_HIDDEN)
    await update($, isHidden, () => hidden === true)
    const big = await $.store.get(STORE_BIG)
    await update($, isBig, () => big === true)

    const usage = await $.session.usage()
    const now = await $.clock.now()
    await readModel($)
    await refreshContext($)
    if (usage.rateLimits.length > 0) {
      const snap: LimitsSnapshot = { windows: toWindows(usage.rateLimits), observedAt: now }
      await update($, snapshot, () => snap)
      await $.store.set(STORE_SNAPSHOT, snap)
    } else {
      await sync($)
    }

    $.clock.every(TICK_MS, () => {
      void tick($)
    })
    await refreshStatus($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.changed.includes('context')) await refreshContext($)
    if (e.rateLimits.length > 0) {
      const snap: LimitsSnapshot = { windows: toWindows(e.rateLimits), observedAt: now }
      await update($, snapshot, () => snap)
      await update($, hasNoLimits, () => false)
      await $.store.set(STORE_SNAPSHOT, snap)
      await alertOn($, snap.windows, now)
      await refreshStatus($)
    } else if (e.changed.includes('context') && (await read($, snapshot)) === null) {
      // A reply came back with no limits: not a Pro/Max login, so stay out of the way.
      await update($, hasNoLimits, () => true)
    }

    return next(e)
  })

  // Each turn says the effort it ran at (after any downgrade for the model):
  // the first tool call, and the turn's end.
  on('classic.PostToolUse', async ($, e, next) => {
    await noteEffort($, e.effort?.level)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    await noteEffort($, e.effort?.level)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /effort high: the new level at once, rather than at the end of the next turn.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    const level = e.args.trim().toLowerCase()
    if (effortStep(level) > 0) await noteEffort($, level)
    return result
  }).catch(($, e, next) => next(e))

  // /model, the picker, a fallback: the new model, and the effort its settings give.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, model, () => e.to_model)
    const level = await settingsEffort($, e.to_model)
    if (level !== null) await update($, effort, () => level)
    await refreshStatus($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear starts a new conversation with fresh state, and no session.start
  // fires for it: once it is under way, measure its context and bring back
  // the limits rather than wait for the next tick.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      $.clock.after(1_000, () => {
        void tick($)
      })
    }
    return next(e)
  })

  on('command.run', { command: 'limits' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide' || arg === 'off') {
      await update($, isHidden, () => true)
      await $.store.set(STORE_HIDDEN, true)
      await refreshStatus($)
      return { text: 'Limits band hidden in every session. Run /limits show to bring it back.' }
    }
    if (arg === 'big' || arg === 'small') {
      await update($, isBig, () => arg === 'big')
      await $.store.set(STORE_BIG, arg === 'big')
      return {
        text: arg === 'big' ? 'Limits card now uses big pixel numbers. /limits small for the compact one.' : 'Limits card is compact again.',
      }
    }
    if (arg === 'show' || arg === 'on') {
      await update($, isHidden, () => false)
      await $.store.set(STORE_HIDDEN, false)
      await refreshStatus($)
      return { text: 'Limits band is back above the prompt.' }
    }

    const now = await $.clock.now()
    const list = await panels($, now)
    if (list.length === 0) {
      return {
        text: "No limit reading yet. Limits arrive with Claude's first reply, on Pro and Max plans.",
      }
    }
    const snap = await read($, snapshot)
    const which = modelLine(await read($, model), await read($, effort))
    const text = detail(list, snap === null ? 'as of now' : `as of ${ago(now - snap.observedAt)}`)
    return { text: which === '' ? text : `${text}\n\nModel: ${which}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) {
      return next(e)
    }

    const snap = await read($, snapshot)
    const now = await $.clock.now()
    const list = await panels($, now)
    const noLimits = await read($, hasNoLimits)
    const modelId = await read($, model)
    const level = await read($, effort)
    // Whatever other mods draw here stays: this card stacks above it.
    const rest = await next(e)
    // Nothing to show: no limits on this login, and no context reading yet.
    if (list.length === 0 && noLimits) return rest
    const age = snap === null ? 0 : now - snap.observedAt

    // The desktop app draws the same design as an image: columns of label and
    // percentage over a bar. It scales down when the slot is narrower than drawn.
    if (e.surface === 'desktop') {
      const { Box, Svg } = $.ui.resolve(e)
      const which = { model: modelId, effort: level }
      const card =
        list.length === 0 ? waitingCard(e.props.bodyColumns, which) : limitsCard(list, e.props.bodyColumns, which)
      return (
        <Box flexDirection="column">
          <Svg key="limits" source={card.source} alt={card.alt} />
          {rest}
        </Box>
      )
    }

    if (e.surface !== 'terminal') return rest
    const { Box, Text, Raster } = $.ui.resolve(e)
    const p = isLightTheme ? LIGHT : DARK
    const style = (s: Seg) => ({
      ...(s.color === undefined ? {} : { color: s.color }),
      ...(s.bold === true ? { bold: true } : {}),
      ...(s.dim === true ? { dimColor: true } : {}),
    })
    const columns = e.props.bodyColumns

    // The top line: the model and its effort at the right, over the context
    // column, with `left` (if any) at the left. Blank otherwise, to keep the
    // band apart from the conversation above.
    const topLine = (left: Seg[] = []) => {
      const caption = captionOf(modelId, level, columns - 2 * MARGIN - widthOf(left) - (left.length > 0 ? 2 : 0))
      const gap = columns - MARGIN - widthOf(left) - widthOf(caption)
      const segs: Seg[] = [...left, { text: ' '.repeat(Math.max(1, gap)) }, ...caption]
      return (
        <Box key="caption" flexDirection="row">
          {segs.map((s, i) => (
            <Text key={`caption-${i}`} {...style(s)}>
              {s.text}
            </Text>
          ))}
        </Box>
      )
    }

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Box key="limits" flexDirection="column">
            {topLine([{ text: ' '.repeat(MARGIN) + "Claude usage appears after Claude's first reply", dim: true }])}
          </Box>
          {rest}
        </Box>
      )
    }

    if (await read($, isBig)) {
      // /limits big: a big pixel percentage beside title, bar and reset.
      const n = list.length
      const panel = Math.floor((columns - 4 - (n - 1) * SEP_WIDTH) / n)
      const right = panel - DIGITS_WIDTH - 2
      if (right >= MIN_BLOCK) {
        const worst = list.reduce((a, b) => (b.pct > a.pct ? b : a))
        const updated = age > STALE_MS ? `updated ${ago(age)}` : ''
        const children: RenderChildren[] = []
        list.forEach((v, i) => {
          const pace = paceOf(v)
          const color = levelColor(v, p)
          const big = bigText(String(Math.round(v.pct)), rgb(color), NUMBER_WIDTH)
          const bar = bigBar(v.pct, right, rgb(p.track), rgb(color))
          if (i > 0) {
            children.push(
              <Box key={`sep-${v.kind}`} flexDirection="column" width={SEP_WIDTH} alignItems="center">
                <Text dimColor>│</Text>
                <Text dimColor>│</Text>
                <Text dimColor>│</Text>
              </Box>,
            )
          }
          children.push(
            <Box key={v.kind} flexDirection="row" width={panel}>
              <Raster key={`pct-${v.kind}`} {...big} />
              <Box flexDirection="column" width={2}>
                <Text> </Text>
                <Text> </Text>
                <Text bold color={color}>
                  {' %'}
                </Text>
              </Box>
              <Box flexDirection="column" width={right} marginLeft={2}>
                <Box flexDirection="row" justifyContent="space-between">
                  <Text bold>{cardTitle(v)}</Text>
                  {pace !== undefined && <Text color={paceColor(pace, p)}>{`● ${pace.text}`}</Text>}
                </Box>
                <Raster key={`bar-${v.kind}`} {...bar} />
                <Box flexDirection="row" justifyContent="space-between">
                  <Text dimColor>{cardReset(v)}</Text>
                  {i === n - 1 && updated !== '' && <Text dimColor>{updated}</Text>}
                </Box>
              </Box>
            </Box>,
          )
        })
        return (
          <Box flexDirection="column">
            {topLine()}
            <Box
              key="limits"
              borderStyle="round"
              borderColor={levelColor(worst, p)}
              borderDimColor={worst.pct < 80}
              paddingX={1}
              flexDirection="row"
            >
              {children}
            </Box>
            {rest}
          </Box>
        )
      }
    }

    if (columns >= GRID_MIN) {
      // Columns: label and percentage over a solid bar, the detail at the right.
      const cw = columnWidth(columns, Math.max(3, list.length))
      const top: Seg[] = [{ text: ' '.repeat(MARGIN) }]
      const bars: RenderChildren[] = [<Text key="bar-margin">{' '.repeat(MARGIN)}</Text>]
      list.forEach((v, i) => {
        if (i > 0) {
          top.push({ text: ' '.repeat(GAP) })
          bars.push(<Text key={`bar-gap-${v.kind}`}>{' '.repeat(GAP)}</Text>)
        }
        top.push(...meterLine(v, cw, p))
        bars.push(<Raster key={`bar-${v.kind}`} {...meterBar(v.pct, cw, rgb(levelColor(v, p)), rgb(p.track))} />)
      })
      return (
        <Box flexDirection="column">
          <Box key="limits" flexDirection="column">
            {topLine()}
            <Box flexDirection="row">
              {top.map((s, i) => (
                <Text key={`top-${i}`} {...style(s)}>
                  {s.text}
                </Text>
              ))}
            </Box>
            <Box flexDirection="row">{bars}</Box>
          </Box>
          {rest}
        </Box>
      )
    }

    // Narrow terminals: one row per meter.
    return (
      <Box flexDirection="column">
        <Box key="limits" flexDirection="column">
          {topLine()}
          {list.map(v => {
            const row = meterRow(v, columns, p)
            return (
              <Box key={v.kind} flexDirection="row">
                {row.label.map((s, i) => (
                  <Text key={`label-${i}`} {...style(s)}>
                    {s.text}
                  </Text>
                ))}
                <Raster key={`bar-${v.kind}`} {...meterBar(v.pct, row.bar, rgb(levelColor(v, p)), rgb(p.track))} />
                {row.right.map((s, i) => (
                  <Text key={`right-${i}`} {...style(s)}>
                    {s.text}
                  </Text>
                ))}
              </Box>
            )
          })}
        </Box>
        {rest}
      </Box>
    )
  })
}

/** A pace's color in the band's palette, by how bad it is. */
function paceColor(pace: Pace, p: Palette): string {
  return [p.green, p.yellow, p.peach, p.red][pace.severity] ?? p.green
}

function toWindows(
  list: ReadonlyArray<{ kind: string; percentUsed: number; resetsAt?: string }>,
): LimitWindow[] {
  return list.map(({ kind, percentUsed, resetsAt }) =>
    resetsAt === undefined ? { kind, percentUsed } : { kind, percentUsed, resetsAt },
  )
}
