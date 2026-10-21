import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-manager',
  component: 'Pane',
  requestId: 'session-manager',
  props: {
    title: 'Sessions',
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
          }
        : args[0] === 'search'
          ? [{ id: 's3', hits: 2, snippet: 'LIF neurons here' }]
          : { ok: true, msg: '' }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /3 · 2 資料夾/ })).toBeDefined()
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
