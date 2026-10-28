import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Row } from '../types'

const PANE = 'subagents'
const rows = atom({ plugin: 'subagents', key: 'agents' } as const, {} as Record<string, Row>)

const ACCENTS = ['#7aa2f7', '#bb9af7', '#2ac3de', '#ff9e64', '#f7768e', '#9ece6a', '#e0af68']
const TOOL_COLORS: Record<string, string> = {
  Bash: '#9ece6a', Read: '#7aa2f7', Grep: '#bb9af7', Glob: '#bb9af7',
  Edit: '#ff9e64', Write: '#ff9e64', WebFetch: '#2ac3de', WebSearch: '#2ac3de',
}
const RUNNING = '#e0af68'
const DONE = '#9ece6a'

const set = (id: string, change: (row: Row) => Partial<Row>) => (all: Record<string, Row>) =>
  all[id] ? { ...all, [id]: { ...all[id], ...change(all[id]) } } : all

// Tool inputs arrive flat on the tool.call event.
const summary = (e: object) => {
  const i = e as Record<string, unknown>
  const text = String(i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? '')
  return (text.split('\n')[0] ?? '').slice(0, 80)
}

export const register: Register = on => {
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId) {
      const row: Row = { type: e.subagentType, description: e.description, isDone: false, tools: [], calls: 0, detail: '' }
      await update($, rows, all => ({ ...all, [started.agentId!]: row }))
      void $.ui.open({ id: PANE, title: 'Subagents' })
    }
    return started
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      await update($, rows, set(e.agentId, row => ({
        tools: [...row.tools, e.tool].slice(-12), calls: row.calls + 1, detail: summary(e),
      })))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) await update($, rows, set(e.agentId, () => ({ isDone: true })))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const all = Object.entries(await read($, rows))
    const running = all.filter(([, row]) => !row.isDone).length
    // Filled chips and the strip of squares are terminal idioms; the desktop gets colored text.
    const isTerminal = e.surface === 'terminal'
    const chip = (color: string, text: string) =>
      isTerminal
        ? <Text backgroundColor={color} color="#1a1b26" bold> {text} </Text>
        : <Text color={color} bold>{text}</Text>
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          {chip(RUNNING, `${running} RUNNING`)}
          <Text>{isTerminal ? ' ' : '   '}</Text>
          {chip(DONE, `${all.length - running} DONE`)}
        </Text>
        {all.map(([id, row], n) => {
          const accent = ACCENTS[n % ACCENTS.length]
          const last = row.tools.at(-1)
          return (
            <Box key={id} flexDirection="column" borderStyle="round" borderColor={row.isDone ? DONE : accent} paddingX={1}>
              <Text wrap="truncate-end">
                {chip(accent, row.type)}
                <Text color={row.isDone ? DONE : RUNNING} bold> {row.isDone ? '✓ done' : '● running'} </Text>
                <Text dimColor>{row.calls} calls</Text>
              </Text>
              <Text bold dimColor={row.isDone} wrap="truncate-end">{row.description}</Text>
              {isTerminal
                ? <Text wrap="truncate-end">
                    {row.tools.map(tool => <Text color={TOOL_COLORS[tool] ?? '#a9b1d6'}>■</Text>)}
                  </Text>
                : []}
              <Text wrap="truncate-end">
                {last
                  ? chip(TOOL_COLORS[last] ?? '#a9b1d6', last)
                  : <Text dimColor>starting…</Text>}
                <Text color={TOOL_COLORS[last ?? ''] ?? '#a9b1d6'}> {row.detail}</Text>
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
