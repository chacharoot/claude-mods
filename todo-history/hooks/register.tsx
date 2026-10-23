import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Change, History, Item, Owner, Snapshot, Status, View } from '../types'

const PANE = 'todo-history'
const TITLE = 'Todo History'
const MAX_SNAPSHOTS = 500
const EMPTY: History = { snapshots: [], changes: [], blobs: 0, pending: [] }

const history = atom({ plugin: 'todo-history', key: 'history' } as const, EMPTY)
const view = atom({ plugin: 'todo-history', key: 'view' } as const, { owner: '', open: null, confirm: null, note: null } as View)

// Tools that edit a file in place: its content is saved before the first such edit after each step.
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

// Where this session's history and saved file copies live.
let dir = ''

// Tool calls run in parallel (a turn's batch, several agents): every read-modify-write
// of the history and its file waits its turn here, so no two take the same blob name
// or interleave their writes of history.json.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

const ICON: Record<Status, string> = { pending: '☐', in_progress: '▶', completed: '✓' }
const TONE: Record<Status, string | undefined> = { pending: undefined, in_progress: 'claude', completed: 'success' }

// Terminal cells a string takes: CJK and emoji are two wide.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\ud800-\udbff]/
const cells = (s: string) => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)

function clip(text: string, width: number) {
  if (cells(text) <= width) return text
  let out = ''
  for (const ch of text) {
    if (cells(out + ch) > width - 1) break
    out += ch
  }
  return `${out}…`
}

function age(ms: number) {
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

const base = (path: string) => path.split(/[\\/]/).pop() ?? path
// Windows paths compare without case or slash direction.
const same = (path: string) => path.replace(/\\/g, '/').toLowerCase()
// A drive letter, a backslash, or a UNC share (`//server/share` too).
const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\') || path.startsWith('//')

const ownerOf = (agentId: string | undefined, tool: string): Owner => (tool.startsWith('Task') ? 'tasks' : agentId ?? '')
const latest = (h: History, owner: Owner) => h.snapshots.filter(s => s.owner === owner).at(-1)

// What changed from one list to the next, as a short line.
function diffNote(before: readonly Item[], after: readonly Item[]) {
  const was = new Map(before.map(item => [item.key, item]))
  const now = new Set(after.map(item => item.key))
  const parts: string[] = []
  for (const item of after) {
    const old = was.get(item.key)
    if (!old) parts.push(`+ ${item.content}`)
    else if (old.status !== item.status) {
      parts.push(item.status === 'completed' ? `✓ ${item.content}` : item.status === 'in_progress' ? `▶ ${item.content}` : `↺ ${item.content}`)
    } else if (old.content !== item.content) parts.push(`✎ ${item.content}`)
  }
  for (const item of before) if (!now.has(item.key)) parts.push(`− ${item.content}`)
  return parts.join('  ') || '（沒有變化）'
}

const sameItems = (a: readonly Item[], b: readonly Item[]) =>
  a.length === b.length && a.every((item, i) => item.key === b[i].key && item.status === b[i].status && item.content === b[i].content)

// Callers hold the queue (serial): a save never interleaves with another.
async function save($: EngineInterface) {
  if (!dir) return
  await $.fs.write(`${dir}/history.json`, JSON.stringify(await read($, history))).catch(() => undefined)
}

// Holds the queue; returns the snapshot written, or undefined when the list did not change.
async function record($: EngineInterface, owner: Owner, items: Item[], note?: { restoredFrom?: number; text?: string }) {
  const h = await read($, history)
  const prev = latest(h, owner)
  if (prev && !note && sameItems(prev.items, items)) return undefined
  const snapshot: Snapshot = {
    n: (h.snapshots.at(-1)?.n ?? 0) + 1,
    at: await $.clock.now(),
    owner,
    items,
    note: note?.text ?? (note?.restoredFrom !== undefined ? `↶ 回到 #${note.restoredFrom}` : diffNote(prev?.items ?? [], items)),
    restoredFrom: note?.restoredFrom,
  }
  await update($, history, now => ({ ...now, snapshots: [...now.snapshots, snapshot].slice(-MAX_SNAPSHOTS) }))
  await save($)
  return snapshot
}

// Holds the queue. Saves a file's content as it stands, unless it was already saved
// since the latest step (`force` saves it regardless, for a restore's own checkpoint).
async function backup($: EngineInterface, owner: Owner, file: string, force = false) {
  if (!dir || !file) return
  const h = await read($, history)
  const after = h.snapshots.at(-1)?.n ?? 0
  if (!force && h.changes.some(change => change.after === after && same(change.file) === same(file))) return
  const isThere = await $.fs.exists(file).catch(() => true)
  const content = isThere
    ? await $.fs.read(file).then(text => ({ text }), () => undefined)
    : { text: null }
  // Unreadable (over 4 MiB, not text): it cannot be restored, so nothing is kept.
  if (!content) return
  const at = await $.clock.now()
  let blob: string | null = null
  if (content.text !== null) {
    // The time in the name keeps it unique even if the count ever starts over.
    blob = `blobs/${h.blobs + 1}-${at}.txt`
    await $.fs.write(`${dir}/${blob}`, content.text)
  }
  const change: Change = { at, after, owner, file, blob }
  await update($, history, now => ({ ...now, changes: [...now.changes, change], blobs: blob ? now.blobs + 1 : now.blobs }))
  await save($)
}

// The files edited after a step, each with its content from just before the first such edit.
function filesAfter(h: History, step: Snapshot) {
  const first = new Map<string, Change>()
  for (const change of h.changes) {
    if (change.after < step.n) continue
    const key = same(change.file)
    if (!first.has(key)) first.set(key, change)
  }
  return [...first.values()]
}

async function removeFile($: EngineInterface, file: string) {
  // Already gone is what a restore wants; Remove-Item would fail on it where rm -f does not.
  if (!(await $.fs.exists(file).catch(() => true))) return
  const ran = isWindowsPath(file)
    ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Remove-Item -LiteralPath $env:TH_PATH -Force'],
        { env: { TH_PATH: file } })
    : await $.process.run(['rm', '-f', '--', file])
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `exit ${ran.exitCode}`)
}

// Brings the task list back to `items` with the task tools; tasks deleted since come back under new ids.
async function restoreTasks($: EngineInterface, current: readonly Item[], items: readonly Item[]) {
  const now = new Map(current.map(item => [item.key, item]))
  const wanted = new Set(items.map(item => item.key))
  for (const item of current) {
    if (!wanted.has(item.key)) await $.tool.call({ tool: 'TaskUpdate', taskId: item.key, status: 'deleted' })
  }
  const out: Item[] = []
  for (const item of items) {
    const had = now.get(item.key)
    if (had) {
      if (had.status !== item.status || had.content !== item.content) {
        await $.tool.call({ tool: 'TaskUpdate', taskId: item.key, status: item.status, subject: item.content })
      }
      out.push(item)
      continue
    }
    const made = await $.tool.call({ tool: 'TaskCreate', subject: item.content, description: item.content })
    const id = 'result' in made && made.result && typeof made.result === 'object' && 'task' in made.result
      ? (made.result as { task: { id: string } }).task.id
      : undefined
    if (!id) continue
    if (item.status !== 'pending') await $.tool.call({ tool: 'TaskUpdate', taskId: id, status: item.status })
    out.push({ ...item, key: id })
  }
  return out
}

const listText = (items: readonly Item[]) =>
  items.length ? items.map(item => `- [${item.status}] ${item.content}`).join('\n') : '(empty)'

async function restore($: EngineInterface, n: number, withFiles: boolean) {
  const h = await read($, history)
  const step = h.snapshots.find(s => s.n === n)
  if (!step) return
  const failed: string[] = []
  const restored: string[] = []
  const targets = withFiles ? filesAfter(h, step) : []
  // First a step holding things as they are now, with a copy of every file about to be
  // overwritten, so the restore itself can be rolled back from the same pane.
  const checkpoint = withFiles
    ? await serial(async () => {
        const made = await record($, step.owner, latest(await read($, history), step.owner)?.items ?? [], { text: `📌 回到 #${n} 之前的狀態` })
        for (const change of targets) await backup($, change.owner, change.file, true)
        return made
      })
    : undefined
  for (const change of targets) {
    try {
      if (change.blob === null) await removeFile($, change.file)
      else await $.fs.write(change.file, await $.fs.read(`${dir}/${change.blob}`))
      restored.push(change.file)
    } catch (err) {
      failed.push(`${base(change.file)}（${err instanceof Error ? err.message : String(err)}）`)
    }
  }
  // These tool calls carry this plugin as their origin; the tool.call hook skips them.
  let items = step.items
  let isApplied = false
  if (step.owner === '') {
    isApplied = await $.tool
      .call({ tool: 'TodoWrite', todos: items.map(item => ({ content: item.content, status: item.status, activeForm: item.content })) })
      .then(r => !('deny' in r), () => false)
  } else if (step.owner === 'tasks') {
    items = await restoreTasks($, latest(await read($, history), 'tasks')?.items ?? [], items).then(
      out => ((isApplied = true), out),
      () => items,
    )
  }
  const list = step.owner === '' ? 'todo list' : step.owner === 'tasks' ? 'task list' : `todo list of agent ${step.owner}`
  const files = restored.length
    ? `\nThese files were also restored to their content at that step, undoing every edit made to them after it:\n${restored.map(f => `- ${f}`).join('\n')}`
    : ''
  const told = `The user rolled the ${list} back to step #${n} with the todo-history mod${isApplied ? '' : ' (the list could not be written back for you; adopt it yourself)'}. The list is now:\n${listText(items)}${files}\nTreat this as the current state.`
  await serial(async () => {
    await record($, step.owner, items, { restoredFrom: n })
    await update($, history, now => ({ ...now, pending: [...now.pending, told] }))
    await save($)
  })
  const undo = checkpoint ? `（要反悔就回到 #${checkpoint.n}）` : ''
  const done = `已回到 #${n}${withFiles ? `，還原 ${restored.length} 個檔案${undo}` : ''}`
  await update($, view, v => ({
    ...v,
    confirm: null,
    open: null,
    note: failed.length ? `${done}；失敗：${failed.join('、')}` : `${done}。下一則訊息會告訴 Claude。`,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const done = await next(e)
    await $.command.register({
      name: 'todos',
      description: 'Show the history of the todo list and tasks, and roll back to any step (clear: forget this session\'s history)',
    })
    const home = (await $.env.get('USERPROFILE').catch(() => undefined)) || (await $.env.get('HOME').catch(() => undefined))
    const id = await $.session.id()
    if (home && id) {
      dir = `${home}/.claude/todo-history/${id}`
      const saved = await $.fs.read(`${dir}/history.json`).catch(() => undefined)
      if (saved) {
        try {
          const loaded = { ...EMPTY, ...(JSON.parse(saved) as History) }
          // 0.1.0 saved changes without `after`: they came before any step, which is 0.
          const changes = loaded.changes.map(change => ({ ...change, after: change.after ?? 0 }))
          await update($, history, () => ({ ...loaded, changes }))
        } catch {
          // A torn file starts the history over.
        }
      }
    }
    void $.ui.open({ id: PANE, title: TITLE })

    return done
  })

  on('command.run', { command: 'todos' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await serial(async () => {
        await update($, history, () => EMPTY)
        await save($)
      })
      await update($, view, v => ({ ...v, open: null, confirm: null, note: null }))
      return { text: 'Todo History: this session\'s history cleared.' }
    }
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Todo History opened.' }
  })

  on('tool.call', async ($, e, next) => {
    // A restore's own TodoWrite and task calls: it records the result itself.
    if (next.origin.plugin === 'todo-history') return next(e)
    if (FILE_TOOLS.has(e.tool)) {
      const input = e as { file_path?: unknown; notebook_path?: unknown }
      await serial(() => backup($, ownerOf(e.agentId, e.tool), String(input.file_path ?? input.notebook_path ?? '')))
    }
    const result = await next(e)
    if ('deny' in result || result.isError) return result

    if (e.tool === 'TodoWrite') {
      const items = e.todos.map((todo): Item => ({ key: todo.content, content: todo.content, status: todo.status }))
      await serial(() => record($, ownerOf(e.agentId, e.tool), items))
    } else if (e.tool === 'TaskCreate') {
      const made = result.result as { task?: { id: string; subject: string } } | undefined
      if (made?.task) {
        const task = made.task
        await serial(async () => {
          const items = latest(await read($, history), 'tasks')?.items ?? []
          await record($, 'tasks', [...items, { key: task.id, content: task.subject, status: 'pending' }])
        })
      }
    } else if (e.tool === 'TaskUpdate') {
      await serial(async () => {
        const items = latest(await read($, history), 'tasks')?.items ?? []
        const updated = e.status === 'deleted'
          ? items.filter(item => item.key !== e.taskId)
          : items.map(item =>
              item.key === e.taskId
                ? { ...item, content: e.subject ?? item.content, status: (e.status as Status | undefined) ?? item.status }
                : item)
        await record($, 'tasks', updated)
      })
    }

    return result
  }).catch(($, e, next) => next(e))

  // After a restore, the next prompt carries what changed, so the model works from it.
  on('prompt.submit', async ($, e, next) => {
    const pending = await serial(async () => {
      const taken = (await read($, history)).pending
      if (taken.length) {
        await update($, history, h => ({ ...h, pending: [] }))
        await save($)
      }
      return taken
    })
    if (!pending.length) return next(e)

    return next({ ...e, context: [...(e.context ?? []), ...pending] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const hist = await read($, history)
    const v = await read($, view)
    const now = await $.clock.now()
    const W = Math.max(30, (e.props.bodyColumns ?? e.viewport?.columns ?? 50) - 1)
    const rows = e.viewport?.rows ?? 30
    const rule = <Text color="subtle">{'─'.repeat(W)}</Text>

    const owners = [...new Set(hist.snapshots.map(s => s.owner))].sort((a, b) =>
      (a === '' ? 0 : a === 'tasks' ? 1 : 2) - (b === '' ? 0 : b === 'tasks' ? 1 : 2))
    const owner = owners.includes(v.owner) ? v.owner : owners[0] ?? ''
    const agentNames = new Map((await $.agent.list().catch(() => [])).map(info => [info.id, info.name ?? info.description ?? info.type]))
    const ownerLabel = (o: Owner) => (o === '' ? '主對話' : o === 'tasks' ? 'Tasks' : clip(agentNames.get(o) ?? `agent ${o.slice(0, 6)}`, 16))

    const header = (
      <Box flexDirection="column">
        <Text>
          <Text bold color="claude">TODO HISTORY</Text>
          <Text dimColor>{`  ${hist.snapshots.length} 步 · ${hist.changes.length} 個檔案備份`}</Text>
        </Text>
        {owners.length > 1 && (
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {owners.map((o, i) => (
              <Button key={`owner-${i}`} plain onPress={() => void update($, view, now => ({ ...now, owner: o, open: null, confirm: null }))}>
                <Text color={o === owner ? 'claude' : undefined} bold={o === owner}>{`${o === owner ? '▸ ' : '  '}${ownerLabel(o)}`}</Text>
              </Button>
            ))}
          </Box>
        )}
        {rule}
      </Box>
    )

    if (hist.snapshots.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>還沒有 todo 紀錄。</Text>
          <Text dimColor>Claude 用 todo 或 task 時，每一步都會記在這裡。</Text>
          {v.note && <Text color="subtle">{clip(v.note, W)}</Text>}
        </Box>
      )
    }

    const mine = hist.snapshots.filter(s => s.owner === owner)
    const current = mine.at(-1)
    const itemLine = (item: Item, key: string, width: number) => (
      <Text key={key}>
        <Text color={TONE[item.status]}>{`${ICON[item.status]} `}</Text>
        <Text dimColor={item.status === 'completed'}>{clip(item.content, width - 2)}</Text>
      </Text>
    )

    const detail = (step: Snapshot) => {
      const width = W - 4
      const files = filesAfter(hist, step)
      const confirm = v.confirm?.n === step.n ? v.confirm : null
      return (
        <Box key={`detail-${step.n}`} flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text bold color="claude">{`#${step.n} 那時的清單`}</Text>
          {step.items.length === 0 && <Text dimColor>（空的）</Text>}
          {step.items.map((item, i) => itemLine(item, `d-${step.n}-${i}`, width))}
          <Text color="subtle">{'┄'.repeat(width)}</Text>
          {files.length > 0 ? (
            <Box flexDirection="column">
              <Text>{`之後改過 ${files.length} 個檔案：`}</Text>
              {files.slice(0, 6).map((change, i) => (
                <Text key={`f-${step.n}-${i}`} dimColor>{clip(`  ${change.blob === null ? '＋' : '✎'} ${change.file}`, width)}</Text>
              ))}
              {files.length > 6 && <Text dimColor>{`  …還有 ${files.length - 6} 個`}</Text>}
            </Box>
          ) : (
            <Text dimColor>之後沒有用 Edit／Write 改過檔案。</Text>
          )}
          <Text dimColor>{clip('用 Bash／PowerShell 改的檔案不會被記錄。', width)}</Text>
          {confirm ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color="warning">
                {clip(confirm.withFiles
                  ? `確定把清單回到 #${step.n}，並覆寫 ${files.length} 個檔案？（＋ 的檔案會被刪除）`
                  : `確定把清單回到 #${step.n}？檔案不會動。`, width)}
              </Text>
              <Box flexDirection="row" gap={1}>
                <Button key="yes" label="確定" hotkey="y" variant="primary"
                  onPress={() => void restore($, step.n, confirm.withFiles).catch(err =>
                    update($, view, now => ({ ...now, confirm: null, note: `還原失敗：${String(err)}` })))} />
                <Button key="no" label="取消" hotkey="q" onPress={() => void update($, view, now => ({ ...now, confirm: null }))} />
              </Box>
            </Box>
          ) : (
            <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
              <Button key={`list-${step.n}`} label="只還原清單" hotkey="r"
                onPress={() => void update($, view, now => ({ ...now, confirm: { n: step.n, withFiles: false } }))} />
              {files.length > 0 && (
                <Button key={`all-${step.n}`} label="清單＋檔案一起還原" hotkey="f" variant="primary"
                  onPress={() => void update($, view, now => ({ ...now, confirm: { n: step.n, withFiles: true } }))} />
              )}
              <Button key={`close-${step.n}`} label="收合" hotkey="x" onPress={() => void update($, view, now => ({ ...now, open: null, confirm: null }))} />
            </Box>
          )}
        </Box>
      )
    }

    const openStep = mine.find(s => s.n === v.open)
    const used = 4 + (current?.items.length ?? 0) + 3 + (openStep ? openStep.items.length + 14 : 0)
    const room = Math.max(3, rows - used)
    const timeline = [...mine].reverse()
    const shown = timeline.slice(0, room)
    if (openStep && !shown.includes(openStep)) shown.push(openStep)

    return (
      <Box flexDirection="column">
        {header}
        <Text bold>{`現在（${ownerLabel(owner)}）`}</Text>
        {current && current.items.length === 0 && <Text dimColor>（空的）</Text>}
        {current?.items.map((item, i) => itemLine(item, `now-${i}`, W))}
        {rule}
        <Text bold>歷程</Text>
        {shown.map(step => (
          <Box key={`step-${step.n}`} flexDirection="column">
            <Button key={`step-btn-${step.n}`} plain
              onPress={() => void update($, view, now => ({ ...now, open: now.open === step.n ? null : step.n, confirm: null }))}>
              <Text color={v.open === step.n ? 'claude' : 'subtle'}>{`${v.open === step.n ? '▾' : '▸'} #${String(step.n).padEnd(3)} `}</Text>
              <Text dimColor>{`${age(now - step.at).padStart(4)}  `}</Text>
              <Text color={step.restoredFrom !== undefined ? 'warning' : undefined}>{clip(step.note, W - 13)}</Text>
            </Button>
            {v.open === step.n && detail(step)}
          </Box>
        ))}
        {timeline.length > shown.length && <Text dimColor>{`…更早還有 ${timeline.length - shown.length} 步`}</Text>}
        {v.note && <Text color="subtle">{clip(v.note, W)}</Text>}
      </Box>
    )
  })
}
