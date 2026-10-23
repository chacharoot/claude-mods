import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'todo-history',
  component: 'Pane',
  requestId: 'todo-history',
  props: {
    title: 'Todo History',
    isFocused: true,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const todos = (...list: [string, 'pending' | 'in_progress' | 'completed'][]) =>
  list.map(([content, status]) => ({ content, status, activeForm: content }))

// The engine hands a path to fs hooks in the platform's spelling: keep files keyed one way.
const key = (path: string) => path.replace(/\\/g, '/')

test('records each step, and rolls the list and the files edited since back to one', async ($, on) => {
  const files = new Map<string, string>([['C:/proj/a.ts', 'old a']])
  const removed: string[] = []
  const ownCalls: unknown[] = []
  on('command.register', () => ({ value: { command: 'todos' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/amy' : undefined }))
  on('fs.read', (_, e) => {
    const text = files.get(key(e.path))
    if (text === undefined) throw new Error(`ENOENT: no such file, open '${e.path}'`)
    return { value: text }
  })
  on('fs.write', (_, e) => (files.set(key(e.path), e.text), { value: undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(key(e.path)) }))
  on('process.run', (_, e) => {
    removed.push(e.init?.env?.TH_PATH ?? '')
    files.delete(e.init?.env?.TH_PATH ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_, e) => {
    // The tools do their work: an edit or a write lands in the file.
    if (e.tool === 'Edit' || e.tool === 'Write') files.set(e.file_path, `edited ${e.file_path}`)
    if (e.tool === 'TodoWrite') ownCalls.push(e.todos)
    return { result: {} }
  })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'TodoWrite', todos: todos(['Write parser', 'pending'], ['Add tests', 'pending']) })
  await clock.advance(1000)
  await $.tool.call({ tool: 'TodoWrite', todos: todos(['Write parser', 'in_progress'], ['Add tests', 'pending']) })
  await clock.advance(1000)
  await $.tool.call({ tool: 'Edit', file_path: 'C:/proj/a.ts', old_string: 'old', new_string: 'new', replace_all: false })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/proj/a.ts', old_string: 'x', new_string: 'y', replace_all: false })
  await $.tool.call({ tool: 'Write', file_path: 'C:/proj/new.ts', content: 'fresh' })
  await clock.advance(1000)
  await $.tool.call({ tool: 'TodoWrite', todos: todos(['Write parser', 'completed'], ['Add tests', 'pending']) })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /3 步 · 2 個檔案備份/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▶ Write parser/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ Write parser/ })).toBeDefined()

  await ui.press({ key: 'step-btn-2' })
  expect(await ui.find({ type: 'Text', text: /之後改過 2 個檔案/ })).toBeDefined()
  await ui.press({ key: 'all-2' })
  await ui.press({ key: 'yes' })

  expect(files.get('C:/proj/a.ts')).toBe('old a')
  expect(removed).toEqual(['C:/proj/new.ts'])
  // Three from the model, then the restore's own, which writes step #2's list back.
  expect(ownCalls).toHaveLength(4)
  expect(ownCalls.at(-1)).toEqual(todos(['Write parser', 'in_progress'], ['Add tests', 'pending']))
  expect(await ui.find({ type: 'Text', text: /↶ 回到 #2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /已回到 #2，還原 2 個檔案/ })).toBeDefined()

  // The next prompt tells the model what was rolled back, once.
  const told = await $.prompt.submit({ text: 'continue', wait: false })
  expect(told.context?.join('\n')).toMatch(/rolled the todo list back to step #2[\s\S]*\[in_progress\] Write parser[\s\S]*C:\/proj\/a\.ts/)
  const again = await $.prompt.submit({ text: 'next', wait: false })
  expect(again.context ?? []).toEqual([])
  await ui.unmount()
})

test('follows the task tools, and keeps the history in a file under the home folder', async ($, on) => {
  const files = new Map<string, string>()
  on('command.register', () => ({ value: { command: 'todos' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's2' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/amy' : undefined }))
  on('fs.read', (_, e) => {
    const text = files.get(key(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => (files.set(key(e.path), e.text), { value: undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(key(e.path)) }))
  on('tool.call', (_, e) => ({ result: e.tool === 'TaskCreate' ? { task: { id: '7', subject: e.subject } } : {} }))
  mock.clock(on)

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Ship it', description: 'ship' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'in_progress' })

  // Saved under the home folder, however the platform roots it.
  const saved = [...files].find(([path]) => path.endsWith('/home/amy/.claude/todo-history/s2/history.json'))?.[1]
  expect(JSON.parse(saved ?? '{}').snapshots).toHaveLength(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /現在（Tasks）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▶ Ship it/ })).toBeDefined()
  await ui.unmount()
})
