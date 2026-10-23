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

// A session whose fs, tools and processes are in memory; `files` is what is on disk.
async function rig($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], onTool?: (e: { tool: string }) => Promise<void> | void) {
  const files = new Map<string, string>()
  const ran: string[] = []
  on('command.register', () => ({ value: { command: 'todos' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's3' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/amy' : undefined }))
  on('fs.read', (_, e) => {
    const text = files.get(key(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => (files.set(key(e.path), e.text), { value: undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(key(e.path)) }))
  on('process.run', (_, e) => {
    const path = e.init?.env?.TH_PATH ?? ''
    ran.push(path)
    // Remove-Item fails on a file that is not there, unlike rm -f.
    if (!files.delete(key(path))) {
      return { value: { exitCode: 1, stdout: '', stderr: 'Cannot find path', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', async (_, e) => {
    if (e.tool === 'Edit' || e.tool === 'Write') files.set(key(e.file_path), `${files.get(key(e.file_path)) ?? ''}+${e.tool}`)
    await onTool?.(e)
    return { result: {} }
  })
  mock.clock(on)
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  return { files, ran }
}

const edit = (file_path: string) => ({ tool: 'Edit' as const, file_path, old_string: 'a', new_string: 'b', replace_all: false })
const plan = (status: 'pending' | 'in_progress' | 'completed') => ({ tool: 'TodoWrite' as const, todos: todos(['Refactor', status]) })

test('parallel edits keep a backup each, and an edit in the same millisecond as a step still counts', async ($, on) => {
  const { files } = await rig($, on)
  files.set('C:/proj/a.ts', 'A0')
  files.set('C:/proj/b.ts', 'B0')
  // No clock advance anywhere: steps and edits share one millisecond.
  await $.tool.call(plan('in_progress'))
  await Promise.all([$.tool.call(edit('C:/proj/a.ts')), $.tool.call(edit('C:/proj/b.ts'))])
  await $.tool.call(plan('completed'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'step-btn-1' })
  await ui.press({ key: 'all-1' })
  await ui.press({ key: 'yes' })
  expect(files.get('C:/proj/a.ts')).toBe('A0')
  expect(files.get('C:/proj/b.ts')).toBe('B0')
  await ui.unmount()
})

test('a restore can itself be rolled back, and a file already gone is not a failure', async ($, on) => {
  const { files } = await rig($, on)
  files.set('C:/proj/a.ts', 'A0')
  await $.tool.call(plan('in_progress'))
  await $.tool.call(edit('C:/proj/a.ts'))
  await $.tool.call({ tool: 'Write', file_path: 'C:/proj/tmp.ts', content: 'x' })
  // Removed behind the history's back, as a Bash `rm` would.
  files.delete('C:/proj/tmp.ts')
  await $.tool.call(plan('completed'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'step-btn-1' })
  await ui.press({ key: 'all-1' })
  await ui.press({ key: 'yes' })
  expect(files.get('C:/proj/a.ts')).toBe('A0')
  expect(await ui.find({ type: 'Text', text: /已回到 #1，還原 2 個檔案（要反悔就回到 #3）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /失敗/ })).toBeUndefined()

  // Back to the checkpoint: the edit the restore undid comes back.
  await ui.press({ key: 'step-btn-3' })
  await ui.press({ key: 'all-3' })
  await ui.press({ key: 'yes' })
  expect(files.get('C:/proj/a.ts')).toBe('A0+Edit')
  await ui.unmount()
})

test('an edit another agent makes while a restore runs is still backed up', async ($, on) => {
  let isRestoring = false
  const { files } = await rig($, on, async e => {
    // While the restore writes its list back, an agent edits a file.
    if (e.tool === 'TodoWrite' && isRestoring) {
      isRestoring = false
      await $.tool.call({ ...edit('C:/proj/c.ts'), agentId: 'a9' })
    }
  })
  files.set('C:/proj/c.ts', 'C0')
  await $.tool.call(plan('pending'))
  await $.tool.call(plan('in_progress'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  isRestoring = true
  await ui.press({ key: 'step-btn-1' })
  await ui.press({ key: 'list-1' })
  await ui.press({ key: 'yes' })
  expect(files.get('C:/proj/c.ts')).toBe('C0+Edit')
  expect(await ui.find({ type: 'Text', text: /1 個檔案備份/ })).toBeDefined()
  await ui.unmount()
})

test('changes saved by 0.1.0, without a step number, are not restored by a later rollback', async ($, on) => {
  const files = new Map<string, string>([
    ['C:/proj/old.ts', 'edited long ago'],
    ['C:/Users/amy/.claude/todo-history/s4/blobs/1.txt', 'ancient'],
    // As 0.1.0 wrote it: a change with no `after`.
    ['C:/Users/amy/.claude/todo-history/s4/history.json', JSON.stringify({
      snapshots: [], blobs: 1, pending: [],
      changes: [{ at: 1, owner: '', file: 'C:/proj/old.ts', blob: 'blobs/1.txt' }],
    })],
  ])
  on('command.register', () => ({ value: { command: 'todos' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's4' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/amy' : undefined }))
  on('fs.read', (_, e) => {
    const text = files.get(key(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => (files.set(key(e.path), e.text), { value: undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(key(e.path)) }))
  on('tool.call', () => ({ result: {} }))
  mock.clock(on)

  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'TodoWrite', todos: todos(['Later work', 'in_progress']) })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'step-btn-1' })
  expect(await ui.find({ type: 'Text', text: /之後沒有用 Edit／Write 改過檔案/ })).toBeDefined()
  expect(files.get('C:/proj/old.ts')).toBe('edited long ago')
  await ui.unmount()
})

test('without a todo tool of the engine, it serves its own, and a restore applies to it directly', async ($, on) => {
  const registered: unknown[] = []
  const builtinCalls: string[] = []
  on('command.register', () => ({ value: { command: 'todos' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's5' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'Read' }, { name: 'Edit' }] }))
  on('tool.register', (_, e) => (registered.push(e), { value: { tool: 'mcp__todo-history__todo' } }))
  on('tool.call', (_, e) => (builtinCalls.push(e.tool), { result: {} }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  mock.clock(on)

  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  expect(registered).toHaveLength(1)
  expect((registered[0] as { name: string; isDeferred: boolean }).name).toBe('todo')

  const call = (list: [string, 'pending' | 'in_progress' | 'completed'][]) =>
    $.tool.call({ tool: 'mcp__todo-history__todo', todos: list.map(([content, status]) => ({ content, status })) } as never)
  const answer = await call([['Read the spec', 'in_progress'], ['Write code', 'pending']])
  expect(JSON.stringify(answer)).toMatch(/Todo list saved: 0\/2 done/)
  await call([['Read the spec', 'completed'], ['Write code', 'in_progress']])
  // The plugin answers its own tool: nothing beneath it ran.
  expect(builtinCalls).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ Read the spec/ })).toBeDefined()
  await ui.press({ key: 'step-btn-1' })
  await ui.press({ key: 'list-1' })
  await ui.press({ key: 'yes' })
  expect(builtinCalls).toEqual([])
  const told = await $.prompt.submit({ text: 'go on', wait: false })
  expect(told.context?.join('\n')).toMatch(/rolled the todo list back to step #1 with the todo-history mod\. The list is now:\n- \[in_progress\] Read the spec/)
  await ui.unmount()
})
