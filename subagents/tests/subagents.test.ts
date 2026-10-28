import { expect, test } from 'claude-code/testing'

test('a subagent tool call updates its row', async ($, on) => {
  on('agent.spawn', async () => ({ model: 'haiku', agentId: 'a1' }))
  on('tool.call', async () => ({ result: 'ok' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  await $.agent.spawn({
    tool_use_id: 's1', prompt: 'look', description: 'find RUM config', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background: false, fork: false,
  })
  // agentId is the engine's to stamp; the typings keep it off a caller's input.
  await $.tool.call({ tool: 'Bash', command: 'rg datadog\nmore', agentId: 'a1' } as never)

  const ui = await $.ui.mount({
    plugin: 'subagents', surface: 'terminal', component: 'Pane', requestId: 'subagents',
    props: { title: 'Subagents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect((await ui.find({ type: 'Text', text: /rg datadog/ }))?.text).toContain('rg datadog')
})


test('desktop draws chips as colored text and leaves out the strip', async ($, on) => {
  on('agent.spawn', async () => ({ model: 'sonnet', agentId: 'd2' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  await $.agent.spawn({
    tool_use_id: 's3', prompt: 'plan', description: 'apply eks', subagentType: 'devops',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background: false, fork: false,
  })
  const ui = await $.ui.mount({
    plugin: 'subagents', surface: 'desktop', component: 'Pane', requestId: 'subagents',
    props: { title: 'Subagents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const chip = await ui.find({ type: 'Text', text: /^devops$/ })
  expect(chip?.props.color).toBe('#7aa2f7')
  expect(chip?.props.backgroundColor).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /■/ })).toBeUndefined()
})
