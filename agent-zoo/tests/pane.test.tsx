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
  expect((await ui.find({ type: 'Text', text: /Read config\.json/ }))?.text).toBe('› Read config.json')
  await ui.unmount()

  await $.turn.complete({ answer: 'found it', durationMs: 1, isAborted: false, turnId: 'x', agentId: 'a1', reason: 'answer' })
  await $.tool.call(inAgent('/x/late.json'))

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /late\.json/ })).toBeUndefined()
  await ui.unmount()
})

test('pressing an agent shows its transcript live, and opens it whole in the main view', async ($, on) => {
  const viewed: unknown[] = []
  const said = [
    { role: 'user', text: 'look', toolUses: [] },
    { role: 'assistant', text: 'Checking the config first.\nThen the tests.', toolUses: [
      { tool_use_id: 'u1', tool: 'Read', input: { file_path: 'C:/x/config.json' }, text: '{ "a": 1 }' },
      { tool_use_id: 'u2', tool: 'Bash', input: { command: 'npm test' }, text: 'FAIL 2 tests', isError: true },
    ] },
  ]
  on('command.register', () => ({ value: { command: 'agent-zoo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('agent.list', () => ({ value: [] }))
  on('session.messages', (_, e) => ({ value: e.agentId === 'a1' ? said : [] }))
  on('ui.view', (_, e) => (viewed.push(e), { value: {} }))
  on('tool.call', () => ({ result: {} }))
  mock.clock(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(SPAWN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'open-a1' })
  expect(await ui.find({ type: 'Text', text: /任務：look/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /💬 Checking the config first\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚙ Read config\.json/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↳ FAIL 2 tests/ })).toBeDefined()

  // A new message in the agent's loop shows without pressing again.
  said.push({ role: 'assistant', text: 'Fixed both.', toolUses: [] })
  await $.tool.call(inAgent('/x/b.json'))
  expect(await ui.find({ type: 'Text', text: /💬 Fixed both\./ })).toBeDefined()

  await ui.press({ key: 'full-a1' })
  expect(viewed).toEqual([{ agentId: 'a1' }])
  await ui.press({ key: 'close-a1' })
  expect(await ui.find({ type: 'Text', text: /Fixed both/ })).toBeUndefined()
  await ui.unmount()
})

test('the compact list nests agents under their parent, and a teammate idles instead of finishing', async ($, on) => {
  let next = 0
  on('command.register', () => ({ value: { command: 'agent-zoo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', (_, e) => {
    next += 1
    return e.isTeammate ? { model: 'opus', agentId: `t${next}`, teammateId: `reviewer@crew` } : { model: 'haiku', agentId: `a${next}` }
  })
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  mock.clock(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, description: 'Lead the search' })
  await $.agent.spawn({ ...SPAWN, description: 'Child search', parentAgentId: 'a1' } as AgentSpawnInput)
  await $.agent.spawn({ ...SPAWN, description: 'Review', isTeammate: true, name: 'reviewer' } as AgentSpawnInput)
  await $.command.run({ command: 'agent-zoo', args: 'compact' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /└ Explore/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /團隊：crew/ })).toBeDefined()

  await $.turn.complete({ answer: 'looks fine', durationMs: 1, isAborted: false, turnId: 'x', agentId: 't3', reason: 'answer' })
  expect(await ui.find({ type: 'Text', text: /1 waiting/ })).toBeDefined()
  await ui.unmount()
})

test('robots are small by default, and /agent-zoo big draws them big', async ($, on) => {
  const rasters: { columns: number; rows: number }[] = []
  on('command.register', () => ({ value: { command: 'agent-zoo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('agent.list', () => ({ value: [] }))
  mock.clock(on)
  mock.store(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(SPAWN)
  const size = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const raster = await ui.find({ type: 'Raster' })
    await ui.unmount()
    return raster && { columns: raster.props.columns, rows: raster.props.rows }
  }
  rasters.push((await size())!)
  await $.command.run({ command: 'agent-zoo', args: 'big' })
  rasters.push((await size())!)
  expect(rasters).toEqual([{ columns: 10, rows: 5 }, { columns: 18, rows: 9 }])
})

test('messages between the lead and its teammates show as a chat under the zoo', async ($, on) => {
  on('command.register', () => ({ value: { command: 'agent-zoo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'opus', agentId: 't1', teammateId: 'scout@crew' }))
  on('agent.list', () => ({ value: [] }))
  // A message to nobody the team has fails, as the engine would refuse it.
  on('tool.call', (_, e) => (e.tool === 'SendMessage' && e.to === 'ghost' ? { result: {}, isError: true } : { result: {} }))
  mock.clock(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, name: 'scout', isTeammate: true } as AgentSpawnInput)

  const send = (to: string, message: string, agentId?: string) =>
    ({ tool: 'SendMessage' as const, to, message, summary: 's', ...(agentId ? { agentId } : {}) })
  await $.tool.call(send('scout', 'Find where the config is loaded.\nThen report back.'))
  await $.tool.call(send('main', 'Found it in src/config.ts.', 't1'))
  await $.tool.call(send('ghost', 'Anyone there?'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /TEAM CHAT/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3 則/ })).toBeDefined()
  // Who wrote to whom, by name: the lead is "lead", the teammate its own name.
  const heads = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('say-')).map(b => b.text)
  expect(heads).toHaveLength(3)
  expect(heads[0]).toMatch(/^👑 lead → scout/)
  expect(heads[1]).toMatch(/^\S+ scout → lead/)
  expect(heads[2]).toMatch(/lead → ghost.*沒送出/)
  expect(await ui.find({ type: 'Text', text: /Found it in src\/config\.ts\./ })).toBeDefined()

  await ui.press({ key: 'chat-toggle' })
  expect(await ui.find({ type: 'Text', text: /Found it/ })).toBeUndefined()
  await ui.press({ key: 'chat-toggle' })
  await ui.press({ key: 'chat-clear' })
  expect(await ui.find({ type: 'Text', text: /TEAM CHAT/ })).toBeUndefined()
  await ui.unmount()
})
