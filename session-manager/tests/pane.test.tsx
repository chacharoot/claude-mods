import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-manager',
  component: 'Pane',
  requestId: 'session-manager',
  props: {
    title: 'Session Manager',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const ROW = (id: string, title: string, cwd: string) => ({
  id, title, cwd, path: `/p/${id}.jsonl`, firstPrompt: `first of ${title}`, lastPrompt: 'last',
  branch: 'main', started: '2026-10-01T10:00:00Z', updated: 0, size: 2048, prompts: 3,
})

test('groups, searches, renames, deletes and starts sessions', async ($, on) => {
  const copied: string[] = []
  const calls: string[][] = []
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me' }))
  on('fs.exists', () => ({ value: true }))
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.copy', (_, e) => (copied.push(e.text), { value: { isCopied: true } }))
  on('process.run', (_, e) => {
    const args = e.argv.slice(3)
    calls.push(args)
    const out =
      args[0] === 'index'
        ? {
            rows: [ROW('me', 'This one', '/work/a'), ROW('s2', 'Raiden game', "/work/b's dir"), ROW('s3', 'Fly brain', '/work/a')],
            live: { me: { pid: 1, tty: '/dev/ttys001', status: 'idle', kind: 'interactive', name: 'a', app: 'Warp' },
                    s3: { pid: 2, tty: '/dev/ttys002', status: 'busy', kind: 'interactive', name: 'fly', app: 'Warp' } },
            platform: 'mac',
            apps: ['Warp', 'Terminal'],
          }
        : args[0] === 'search'
          ? [{ id: 's3', hits: 2, snippet: 'LIF neurons here' }]
          : { ok: true, msg: '' }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /3 sessions · 2 資料夾/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /~?\/work\/a/ })).toBeDefined()

  await ui.input({ key: 'query', text: 'neurons' })
  expect(await ui.find({ type: 'Text', text: /LIF neurons here/ })).toBeDefined()
  await ui.press({ key: 'clear' })

  // A live session jumps to its tab; a closed one resumes in the chosen app.
  await ui.press({ key: 'row-s3' })
  await ui.press({ key: 'jump-s3' })
  expect(calls.at(-1)).toEqual(['focus', 'Warp', '/dev/ttys002'])
  await ui.press({ key: 'row-s2' })
  await ui.press({ key: 'jump-s2' })
  expect(calls.find(c => c[0] === 'open')).toEqual(['open', 'Warp', "/work/b's dir", 'claude --resume s2'])

  await ui.press({ key: 'copy-s2' })
  expect(copied).toEqual([`cd '/work/b'\\''s dir' && claude --resume s2`])

  await ui.press({ key: 'rename-btn-s2' })
  await ui.input({ key: 'rename-s2', text: 'Raiden v2' })
  expect(calls.find(c => c[0] === 'rename')).toEqual(['rename', '/p/s2.jsonl', 's2', 'Raiden v2'])

  // Still open after the rename.
  await ui.press({ key: 'del-s2' })
  await ui.press({ key: 'confirm' })
  expect(calls.find(c => c[0] === 'trash')).toEqual(['trash', '/p/s2.jsonl'])

  await ui.press({ key: 'new' })
  await ui.input({ key: 'newdir', text: '/work/new' })
  expect(calls.find(c => c[0] === 'open' && c[3] === 'claude')).toEqual(['open', 'Warp', '/work/new', 'claude'])
  await ui.unmount()
})

test('on Windows: falls back to python, copies a PowerShell command, opens Windows Terminal', async ($, on) => {
  const copied: string[] = []
  const calls: string[][] = []
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me' }))
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.copy', (_, e) => (copied.push(e.text), { value: { isCopied: true } }))
  on('process.run', (_, e) => {
    calls.push([...e.argv.slice(0, 1), ...e.argv.slice(3)])
    // No python3 here, as on many Windows machines: the Store stub exits 9009.
    if (e.argv[0] === 'python3') {
      return { value: { exitCode: 9009, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const args = e.argv.slice(3)
    const out = args[0] === 'index'
      ? { rows: [ROW('w1', 'Win work', "C:\\Users\\amy\\it's here")], live: {}, platform: 'win', apps: ['Windows Terminal'] }
      : { ok: true, msg: '' }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: 'C:\\Users\\amy', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /~\\it's here/ })).toBeDefined()
  await ui.press({ key: 'row-w1' })
  await ui.press({ key: 'copy-w1' })
  expect(copied).toEqual([`cd 'C:\\Users\\amy\\it''s here'; claude --resume w1`])
  await ui.press({ key: 'jump-w1' })
  expect(calls.find(c => c[1] === 'open')).toEqual(['python', 'open', 'Windows Terminal', "C:\\Users\\amy\\it's here", 'claude --resume w1'])
  await ui.unmount()
})

test('on Windows with no Python: runs scanner.ps1, and a failed press says why', async ($, on) => {
  const calls: string[][] = []
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me' }))
  const clock = mock.clock(on)
  mock.store(on)
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    // Every Python here is the Store stub, which exits 9009 and runs nothing.
    if (e.argv[0] !== 'powershell') {
      return { value: { exitCode: 9009, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const args = e.argv.slice(e.argv.findIndex(a => a.endsWith('scanner.ps1')) + 1)
    if (args[0] === 'pickdir') {
      return { value: { exitCode: 1, stdout: '', stderr: 'Exception calling "ShowDialog"', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const out = args[0] === 'index'
      ? { rows: [ROW('w1', 'Win work', 'C:\work')], live: {}, platform: 'win', apps: ['Windows Terminal'] }
      : { ok: true, msg: '' }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: 'C:\work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /1 sessions · 1 資料夾/ })).toBeDefined()
  const ps = calls.find(c => c[0] === 'powershell')
  expect(ps?.slice(-3)).toEqual(['index', '~/.claude/projects', '~/.claude/session-manager/index.json'])
  expect(ps?.at(-4)).toMatch(/hooks[\/]scanner\.ps1$/)

  await ui.press({ key: 'new' })
  await ui.press({ key: 'browse' })
  expect(await ui.find({ type: 'Text', text: /瀏覽失敗：Exception calling "ShowDialog"/ })).toBeDefined()
  await ui.press({ key: 'start' })
  expect(calls.at(-1)?.slice(-4)).toEqual(['open', 'Windows Terminal', 'C:\work', 'claude'])
  await ui.unmount()
})

test('shows what is left of each rate-limit window, and follows session.measure', async ($, on) => {
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me' }))
  const clock = mock.clock(on)
  mock.store(on)
  const inTwoHours = new Date(2 * 3600_000 + 13 * 60_000).toISOString()
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 32, resetsAt: inTwoHours },
        { kind: 'seven_day', percentUsed: 85.5 },
      ],
    },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: JSON.stringify({ rows: [], live: {}, platform: 'win', apps: ['Windows Terminal'] }),
             stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.session.start({ cwd: 'C:\work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /5 小時/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /剩 68%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2h13m 後重置/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /剩 14\.5%/ })).toBeDefined()

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 90, resetsAt: inTwoHours }],
    changed: ['rateLimits'],
  })
  expect(await ui.find({ type: 'Text', text: /剩 10%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /7 天/ })).toBeUndefined()
  await ui.unmount()
})

test('a background session (a /fork) opens attached in a new tab', async ($, on) => {
  const calls: string[][] = []
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me' }))
  const clock = mock.clock(on)
  mock.store(on)
  on('process.run', (_, e) => {
    const args = e.argv.slice(3)
    calls.push(args)
    const out = args[0] === 'index'
      ? {
          rows: [ROW('fk', 'Forked talk', 'D:\\test')],
          live: { fk: { pid: 7, tty: '', status: 'idle', kind: 'bg', name: 'fork', app: 'Console', jobId: 'f4756600' } },
          platform: 'win',
          apps: ['Windows Terminal'],
        }
      : { ok: true, msg: '' }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: 'D:\\test', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'row-fk' })
  expect(await ui.find({ type: 'Text', text: /背景/ })).toBeDefined()
  await ui.press({ key: 'jump-fk' })
  expect(calls.find(c => c[0] === 'open')).toEqual(['open', 'Windows Terminal', 'D:\\test', 'claude attach f4756600'])
  expect(calls.some(c => c[0] === 'focus')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /已在 Windows Terminal 打開/ })).toBeDefined()
  await ui.unmount()
})

test('another plugin holding /sessions neither stops the pane nor loses its own command', async ($, on) => {
  const registered: string[] = []
  on('command.register', (_, e) => {
    if (e.name === 'sessions') throw new Error('"/sessions" refused: the plugin session-monitor registered it already')
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  const opened: string[] = []
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me' }))
  // What sits beneath: session-monitor's own answer to /sessions.
  on('command.run', () => ({ text: 'session-monitor: panel opened' }))
  const clock = mock.clock(on)
  mock.store(on)
  on('process.run', () => ({
    value: { exitCode: 0, stdout: JSON.stringify({ rows: [], live: {}, platform: 'mac', apps: ['Terminal'] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(registered).toEqual(['session-manager'])
  expect(opened).toContain('session-manager')

  // A typed-in command: the engine stamps origin and presentation on its own.
  const typed = (command: string) => ({ command, args: '' }) as Parameters<typeof $.command.run>[0]
  expect((await $.command.run(typed('session-manager'))).text).toBe('Session Manager opened.')
  expect((await $.command.run(typed('sessions'))).text).toBe('session-monitor: panel opened')
  // Let the refresh the open started finish inside the test.
  await clock.settle()
})

test('lists each match of a search, and previews the conversation around one', async ($, on) => {
  const contexts: string[][] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me' }))
  const clock = mock.clock(on)
  mock.store(on)
  const match = (line: number, role: string, snippet: string) => ({ line, role, ts: `2026-10-0${line}T10:0${line}:00Z`, snippet })
  const msg = (line: number, role: string, text: string, isHit = false) => ({ line, end: line, role, ts: '2026-10-01T09:00:00Z', text, isHit })
  on('process.run', (_, e) => {
    const args = e.argv.slice(3)
    const out =
      args[0] === 'index'
        ? { rows: [ROW('s1', 'Fly brain', '/work/a'), ROW('s2', 'Raiden', '/work/b')], live: {}, platform: 'mac', apps: ['Terminal'] }
        : args[0] === 'search'
          ? [{ id: 's1', hits: 7, snippet: 'neurons one', matches: [1, 2, 3, 4, 5, 6, 7].map(n => match(n, n % 2 ? 'user' : 'assistant', `neurons ${n}`)) }]
          : args[0] === 'context'
            ? (contexts.push(args.slice(1)),
              args[2] === '-1'
                ? { messages: [msg(8, 'user', 'last question'), msg(9, 'assistant', 'last answer')], total: 30 }
                : { messages: [msg(1, 'user', 'before it'), msg(Number(args[2]), 'assistant', `the neurons at ${args[2]}`, true), msg(9, 'user', 'after it')], total: 30 })
            : { ok: true, msg: '' }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.input({ key: 'query', text: 'neurons' })
  await ui.press({ key: 'row-s1' })
  // Five matches listed, each saying who wrote it; the rest a press away.
  expect(await ui.find({ type: 'Button', key: 'm-s1-4' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'm-s1-5' })).toBeUndefined()
  await ui.press({ key: 'more-s1' })
  expect(await ui.find({ type: 'Button', key: 'm-s1-6' })).toBeDefined()

  await ui.press({ key: 'm-s1-2' })
  expect(contexts.at(-1)).toEqual(['/p/s1.jsonl', '3', '2'])
  expect(await ui.find({ type: 'Text', text: /第 3\/7 處/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◀ 命中/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /before it/ })).toBeDefined()

  await ui.press({ key: 'next-match' })
  expect(contexts.at(-1)).toEqual(['/p/s1.jsonl', '4', '2'])
  await ui.press({ key: 'more-context' })
  expect(contexts.at(-1)).toEqual(['/p/s1.jsonl', '4', '5'])
  await ui.press({ key: 'close-preview' })
  expect(await ui.find({ type: 'Text', text: /預覽 ·/ })).toBeUndefined()

  // With no search, a session's last messages.
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'row-s2' })
  await ui.press({ key: 'peek-s2' })
  expect(contexts.at(-1)).toEqual(['/p/s2.jsonl', '-1', '2'])
  expect(await ui.find({ type: 'Text', text: /最後 2 則（共 30 則）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /last answer/ })).toBeDefined()
  await ui.unmount()
})
