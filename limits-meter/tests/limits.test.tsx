import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { effortIn, modelName } from '../hooks/model'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const IN = (ms: number) => new Date(NOW + ms).toISOString()
const H = 3_600_000

const band = (bodyColumns: number) =>
  ({
    plugin: 'limits-meter',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 12,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 11 },
      view: {},
    },
  }) as const

const limits = (fiveHour: number, weekly: number) => ({
  context: { window: 200_000 },
  rateLimits: [
    { kind: 'seven_day', percentUsed: weekly, resetsAt: IN(4 * 24 * H + 6 * H) },
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: IN(2 * H + 14 * 60_000) },
  ],
  changed: ['rateLimits' as const],
})

/** How full the conversation is, as the engine would measure it. */
type Fill = { tokens: number; window: number; limit: number; compactAt?: number; hasReplied: boolean }

/**
 * `$.session.usage()` as a real session answers it (recorded from 2.1.291):
 * the status line's figures only once a reply came back, and with `breakdown`
 * the /context count, estimated locally before that.
 */
function usageOf(fill: Fill | undefined, args: { breakdown?: string } | undefined) {
  if (fill === undefined) return { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] }
  const { tokens, window, limit, compactAt, hasReplied } = fill
  const context: Record<string, unknown> = { window }
  if (hasReplied) Object.assign(context, { tokens, percent: Math.round((tokens / window) * 100) })
  if (args?.breakdown !== undefined) {
    context['breakdown'] = {
      categories: [],
      totalTokens: tokens,
      maxTokens: limit,
      rawMaxTokens: limit,
      autocompactSource: 'clientdata',
      percentage: Math.round((tokens / limit) * 100),
      gridRows: [],
      model: 'claude-opus-5-5',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: compactAt !== undefined,
      ...(compactAt === undefined ? {} : { autoCompactThreshold: compactAt }),
      apiUsage: hasReplied
        ? { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 2 }
        : null,
    }
  }
  return { startedAt: NOW, context, rateLimits: [] }
}

/** Stand in for the engine beneath the plugin: what a real session answers. */
function engine(on: On, initial?: Fill) {
  mock.store(on)
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const ctx = { fill: initial }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.usage', ($, e) => ({ value: usageOf(ctx.fill, e) as never }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('config.list', () => ({ value: [] }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { toasts, setFill: (f: Fill) => void (ctx.fill = f) }
}

const run = (args: string) => ({
  command: 'limits',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

test('draws a colored meter for both windows on terminal and desktop', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const waiting = await $.ui.mount({ ...band(140), surface: 'terminal' })
  expect(await waiting.find({ text: /first reply/ })).toBeDefined()
  await waiting.unmount()
  const waitingCard = await $.ui.mount({ ...band(140), surface: 'desktop' })
  expect(String((await waitingCard.find({ type: 'Svg' }))?.props.alt)).toMatch(/first reply/)
  await waitingCard.unmount()

  await $.session.measure(limits(38, 72))

  // Default terminal band: columns of label and percentage over a solid bar.
  const wide = await $.ui.mount({ ...band(140), surface: 'terminal' })
  expect(await wide.find({ text: '5-hour' })).toBeDefined()
  expect(await wide.find({ text: 'weekly' })).toBeDefined()
  expect((await wide.find({ type: 'Text', text: '38%' }))?.props.color).toBe('#40a02b')
  expect((await wide.find({ type: 'Text', text: '72%' }))?.props.color).toBe('#df8e1d')
  expect(await wide.find({ text: 'resets in 2h 14m' })).toBeDefined()
  // On track says nothing; a weekly pace that runs out early says so, with the reset beside it.
  expect(await wide.find({ text: /On track/ })).toBeUndefined()
  expect((await wide.find({ type: 'Text', text: 'limit in ~1d 1h' }))?.props.color).toBe('#fe640b')
  expect(await wide.find({ text: ' · in 4d 6h' })).toBeDefined()
  const bars = await wide.findAll({ type: 'Raster' })
  expect(bars.map(r => r.key)).toEqual(['bar-five_hour', 'bar-seven_day'])
  // Three columns of 43 across 140: the grid where-am-i's row lines up under.
  expect(bars[0]?.props.columns).toBe(43)
  // Other mods' bands stay: the band stacks above what is drawn beneath it.
  expect(await wide.find({ text: 'engine' })).toBeDefined()
  await wide.unmount()

  // Close to the limit: red, with when it runs out at this rate.
  await $.session.measure(limits(93, 72))
  const hot = await $.ui.mount({ ...band(140), surface: 'terminal' })
  expect((await hot.find({ type: 'Text', text: '93%' }))?.props.color).toBe('#d20f39')
  expect((await hot.find({ type: 'Text', text: /^limit in ~/ }))?.props.color).toBe('#d20f39')
  await hot.unmount()
  await $.session.measure(limits(38, 72))

  // /limits big: big pixel percentages beside title, bar and reset.
  await $.command.run(run('big'))
  const big = await $.ui.mount({ ...band(140), surface: 'terminal' })
  const rasters = (await big.findAll({ type: 'Raster' })).map(r => r.key)
  expect(rasters).toEqual(['pct-five_hour', 'bar-five_hour', 'pct-seven_day', 'bar-seven_day'])
  await big.unmount()
  await $.command.run(run('small'))

  // Narrow terminal: one row per limit.
  const narrow = await $.ui.mount({ ...band(70), surface: 'terminal' })
  expect(await narrow.find({ text: '  38%' })).toBeDefined()
  expect(await narrow.find({ text: '  72%' })).toBeDefined()
  expect(await narrow.find({ text: 'in 2h 14m' })).toBeDefined()
  expect(await narrow.find({ text: 'limit in ~1d 1h' })).toBeDefined()
  expect((await narrow.findAll({ type: 'Raster' })).length).toBe(2)
  await narrow.unmount()
})

test('desktop draws the terminal design as an SVG card: columns, or rows when narrow', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(limits(91, 72))

  for (const cols of [140, 70]) {
    const ui = await $.ui.mount({ ...band(cols), surface: 'desktop' })
    const svg = await ui.find({ type: 'Svg' })
    const source = String(svg?.props.source)
    expect(String(svg?.props.alt)).toMatch(/5-hour limit 91% used, resets in 2h 14m; Weekly limit 72% used/)
    expect(source).toMatch(/^<svg /)
    // 91% used with 2h 14m of 5h left: at this rate the limit is hit in ~17m, in red.
    expect(source).toMatch(/<tspan fill="#d20f39" font-weight="700">limit in ~17m<\/tspan>/)
    // 72% weekly with 4d 6h of 7d left also runs out early, in about a day.
    expect(source).toMatch(/limit in ~1d 1h/)
    expect(source).toMatch(/fill="#fe640b">91%/)
    expect(source).toMatch(/prefers-color-scheme: light/)
    // No size given: the image takes its own width, scaled down when the slot is narrower.
    expect(svg?.props.width).toBeUndefined()
    await ui.unmount()
  }
})

test('toasts once at 80% and again at 95%, never twice per level', async ($, on) => {
  const { toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.session.measure(limits(50, 10))
  expect(toasts).toHaveLength(0)
  await $.session.measure(limits(81, 10))
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/5-hour limit at 81%/)
  await $.session.measure(limits(86, 10))
  expect(toasts).toHaveLength(1)
  await $.session.measure(limits(96, 10))
  expect(toasts).toHaveLength(2)
  expect(toasts[1]).toMatch(/🔴 5-hour limit at 96%/)
})

test('/limits prints the readout, and hide/show toggle the band', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure(limits(38, 72))

  const shown = await $.command.run(run(''))
  expect(shown.text).toMatch(/5-hour .*38%.*resets in 2h 14m/)
  expect(shown.text).toMatch(/weekly .*72%.*resets in 4d 6h/)

  await $.command.run(run('hide'))
  const hidden = await $.ui.mount({ ...band(140), surface: 'terminal' })
  expect(await hidden.find({ text: /5-hour/ })).toBeUndefined()
  await hidden.unmount()

  await $.command.run(run('show'))
  const back = await $.ui.mount({ ...band(140), surface: 'terminal' })
  expect(await back.find({ text: /5-hour/ })).toBeDefined()
})

// A 1M-token model on an account that compacts at 467k of a 500k window,
// as recorded from a real session.
const OPUS = { window: 1_000_000, limit: 500_000, compactAt: 467_000 }

test('shows this session’s context window as a third panel, estimated before the first reply', async ($, on) => {
  const { setFill } = engine(on, { ...OPUS, tokens: 37_604, hasReplied: false })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure(limits(29, 13))

  // A fresh session: no reply yet, so a local estimate, marked with ~.
  const fresh = await $.ui.mount({ ...band(150), surface: 'terminal' })
  expect((await fresh.find({ type: 'Text', text: '8%' }))?.props.color).toBe('#04a5e5')
  expect(await fresh.find({ text: '~38k of 500k tokens' })).toBeDefined()
  expect((await fresh.findAll({ type: 'Raster' })).map(r => r.key)).toEqual([
    'bar-five_hour',
    'bar-seven_day',
    'bar-context',
  ])
  await fresh.unmount()

  // After a reply: the real count, against the 500k compaction window as /context has it.
  setFill({ ...OPUS, tokens: 270_000, hasReplied: true })
  await $.session.measure({ ...limits(29, 13), changed: ['rateLimits', 'context'] })
  const ui = await $.ui.mount({ ...band(150), surface: 'terminal' })
  expect(await ui.find({ text: '54%' })).toBeDefined()
  expect(await ui.find({ text: 'context' })).toBeDefined()
  expect(await ui.find({ text: '270k of 500k tokens' })).toBeDefined()
  await ui.unmount()

  const narrow = await $.ui.mount({ ...band(70), surface: 'terminal' })
  expect(await narrow.find({ text: 'context ' })).toBeDefined()
  expect(await narrow.find({ text: '270k of 500k' })).toBeDefined()
  await narrow.unmount()

  const desk = await $.ui.mount({ ...band(150), surface: 'desktop' })
  expect(String((await desk.find({ type: 'Svg' }))?.props.alt)).toMatch(/Context window 54% used, 270k of 500k tokens/)
  await desk.unmount()

  const out = await $.command.run(run(''))
  expect(out.text).toMatch(/context .*54%.*270k of 500k tokens · auto-compacts at 467k/)

  // The badge counts toward the compaction point, not the window.
  setFill({ ...OPUS, tokens: 350_000, hasReplied: true })
  await $.session.measure({ ...limits(29, 13), changed: ['context'] })
  const filling = await $.ui.mount({ ...band(150), surface: 'terminal' })
  expect((await filling.find({ type: 'Text', text: '70%' }))?.props.color).toBe('#df8e1d')
  expect(await filling.find({ text: 'filling up' })).toBeDefined()
  await filling.unmount()

  setFill({ ...OPUS, tokens: 425_000, hasReplied: true })
  await $.session.measure({ ...limits(29, 13), changed: ['context'] })
  const full = await $.ui.mount({ ...band(150), surface: 'terminal' })
  expect((await full.find({ type: 'Text', text: '85%' }))?.props.color).toBe('#d20f39')
  expect(await full.find({ text: 'compacting soon' })).toBeDefined()
})

test('an API-key session with no limits still shows its context', async ($, on) => {
  engine(on, { tokens: 50_000, window: 200_000, limit: 200_000, compactAt: 167_000, hasReplied: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ ...band(150), surface: 'terminal' })
  expect(await ui.find({ text: /5-hour/ })).toBeUndefined()
  expect(await ui.find({ text: '25%' })).toBeDefined()
  expect(await ui.find({ text: '50k of 200k tokens' })).toBeDefined()
})

test('the model and its effort sit at the top right, and follow /effort, each turn and /model', async ($, on) => {
  engine(on)
  mock.env(on, { HOME: '/Users/dev' })
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.read', ($, e) => {
    if (e.path !== '/Users/dev/.claude/settings.json') throw new Error(`ENOENT ${e.path}`)
    return { value: JSON.stringify({ model: 'opus[1m]', modelSettings: { opus: { effortLevel: 'xhigh' } } }) }
  })
  // The built-in /effort, and the engine's own end of a turn and model switch, beneath the plugin.
  on('command.run', { command: 'effort' }, () => ({ text: 'Effort set' }))
  on('classic.Stop', () => ({}) as never)
  on('classic.PostModelSwitch', () => ({}) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.session.measure(limits(46, 16))

  // Before any turn: the model, and the effort the settings give it.
  const ui = await $.ui.mount({ ...band(115), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'Opus 5.5' }))?.props).toMatchObject({ color: '#d97757', bold: true })
  expect(await ui.find({ type: 'Text', text: ' · 1M' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^●●●●$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^xhigh$/ })).toBeDefined()
  // Right-aligned on the band's top line, over the context column.
  expect((await ui.find({ type: 'Box', key: 'caption' }))?.text).toMatch(/^ {40,}Opus 5\.5 · 1M {3}effort ●●●●○ xhigh$/)
  await ui.unmount()

  // /effort high: at once.
  await $.command.run({ ...run('high'), command: 'effort' })
  const after = await $.ui.mount({ ...band(115), surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /^high$/ })).toBeDefined()
  expect(await after.find({ type: 'Text', text: /^●●●$/ })).toBeDefined()
  await after.unmount()

  // A turn reports the effort it actually ran at.
  await $.classic.Stop({ stop_hook_active: false, effort: { level: 'max' } } as never)
  const turn = await $.ui.mount({ ...band(115), surface: 'desktop' })
  const source = String((await turn.find({ type: 'Svg' }))?.props.source)
  expect(source).toMatch(/<tspan fill="#d97757" font-weight="700">Opus 5\.5<\/tspan>/)
  expect(source).toMatch(/●●●●●/)
  expect(String((await turn.find({ type: 'Svg' }))?.props.alt)).toMatch(/Model: Opus 5\.5 · 1M · effort max/)
  await turn.unmount()

  // /model sonnet: the new model; its settings set no effort, so the last one stays.
  await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5[1m]', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'command' } as never)
  const switched = await $.ui.mount({ ...band(115), surface: 'terminal' })
  expect(await switched.find({ type: 'Text', text: 'Sonnet 5.5' })).toBeDefined()
  expect(await switched.find({ type: 'Text', text: ' · 1M' })).toBeUndefined()
  await switched.unmount()

  expect((await $.command.run(run(''))).text).toMatch(/Model: Sonnet 5\.5 · effort max/)
})

test('model names: families, versions, dated ids and the 1M window', () => {
  expect(modelName('claude-opus-5-5[1m]')).toEqual({ name: 'Opus 5.5', tag: '1M' })
  expect(modelName('claude-sonnet-5-5')).toEqual({ name: 'Sonnet 5.5' })
  expect(modelName('claude-haiku-4-5-20251001')).toEqual({ name: 'Haiku 4.5' })
  expect(modelName('claude-fable-5-1')).toEqual({ name: 'Fable 5.1' })
  expect(modelName('opusplan')).toEqual({ name: 'opusplan' })
  // Matched as Claude Code matches it: the exact id, then the alias, never a prefix or the top level.
  const opus = 'claude-opus-5-5[1m]'
  expect(effortIn({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' }, opus: { effortLevel: 'high' } } }, opus)).toBe('xhigh')
  expect(effortIn({ modelSettings: { opus: { effortLevel: 'low' } } }, opus)).toBe('low')
  expect(effortIn({ modelSettings: { 'opus[1m]': { effortLevel: 'max' } } }, opus)).toBe('max')
  expect(effortIn({ modelSettings: { 'claude-opus-5-5[1m]': { effortLevel: 'medium' } } }, opus)).toBe('medium')
  expect(effortIn({ modelSettings: { 'claude-opus-5': { effortLevel: 'xhigh' } } }, opus)).toBeUndefined()
  expect(effortIn({ effortLevel: 'high' }, 'claude-sonnet-5-5')).toBeUndefined()
  expect(effortIn({ modelSettings: { sonnet: { effortLevel: 'high' } } }, 'claude-sonnet-5-5')).toBe('high')
})
