import { expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput } from 'claude-code'

const PANE = {
  plugin: 'agent-zoo',
  component: 'Pane',
  requestId: 'agent-zoo',
  props: {
    title: 'Agent Zoo',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const SPAWN = {
  prompt: 'look', description: 'Find the config', subagentType: 'Explore',
  tool_use_id: 't1', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus',
  background: true, fork: false,
} as unknown as AgentSpawnInput

// Run inside the subagent's loop: the engine stamps `agentId` on its calls.
const inAgent = (file_path: string) => ({ tool: 'Read' as const, file_path, agentId: 'a1' })

test('a spawned agent shows its tool, and a late tool call does not revive it', async ($, on) => {
  on('command.register', () => ({ value: { command: 'agent-zoo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  mock.clock(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(SPAWN)
  await $.tool.call(inAgent('/x/config.json'))

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Find the config/ }))?.text).toBe('Find the config')
  expect((await ui.find({ type: 'Text', text: /Read config\.json/ }))?.text).toBe('Read config.json')
  await ui.unmount()

  await $.turn.complete({ answer: 'found it', durationMs: 1, isAborted: false, turnId: 'x', agentId: 'a1', reason: 'answer' })
  await $.tool.call(inAgent('/x/late.json'))

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /late\.json/ })).toBeUndefined()
  await ui.unmount()
})
