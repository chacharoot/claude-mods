import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { AgentEvent, Change, History, Item, Owner, Snapshot, Status, View } from '../types'

const PANE = 'todo-history'
const TITLE = 'Todo History'
const MAX_SNAPSHOTS = 500
const MAX_EVENTS = 300
const REWIND_POLL_MS = 3000
const EMPTY: History = { snapshots: [], changes: [], events: [], blobs: 0, pending: [], epoch: 0 }

const history = atom({ plugin: 'todo-history', key: 'history' } as const, EMPTY)
const view = atom({ plugin: 'todo-history', key: 'view' } as const, { owner: '', open: null, task: null, confirm: null, note: null } as View)

// Tools that edit a file in place: its content is saved before the first such edit after each step.
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

// Where the engine offers no todo tool, this plugin serves one of its own, shaped like TodoWrite.
const TODO_TOOL = 'mcp__todo-history__todo'
const TODO_SPEC = {
  name: 'todo',
  isDeferred: false,
  description:
    'Keep a todo list for work with several steps, so the user can follow progress and roll back to any step. ' +
    'Send the whole list on every call. Write it before starting, keep exactly one item in_progress while working, ' +
    'and mark each item completed as soon as it is done, one call per change (do not batch them).',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The whole updated list',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What to do, in the imperative' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
}
// Set at session start when the plugin's own tool serves the main list.
let ownTool = false

// Where this session's history and saved file copies live.
let dir = ''

// The main conversation when last looked at, one short print per message. A later one
// that is shorter and still opens with exactly those messages is a rewind; a compaction
// replaces the opening with its summary, so it never matches. Undefined until the first look.
let seen: string[] | undefined
let compacting = false

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

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const base = (path: string) => path.split(/[\\/]/).pop() ?? path
// Windows paths compare without case or slash direction.
const same = (path: string) => path.replace(/\\/g, '/').toLowerCase()
// A drive letter, a backslash, or a UNC share (`//server/share` too).
const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\') || path.startsWith('//')

const ownerOf = (agentId: string | undefined, tool: string): Owner => (tool.startsWith('Task') ? 'tasks' : agentId ?? '')
// Whose file edits a list's tasks made: the main loop's for the main and shared task lists.
const editorOf = (owner: Owner) => (owner === 'tasks' ? '' : owner)
const latest = (h: History, owner: Owner) => h.snapshots.filter(s => s.owner === owner).at(-1)
const nextN = (h: History) => Math.max(h.snapshots.at(-1)?.n ?? 0, h.events.at(-1)?.n ?? 0) + 1
// Lists the main conversation's rewinds move.
const followsRewind = (owner: Owner) => owner === '' || owner === 'tasks'

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

const listText = (items: readonly Item[]) =>
  items.length ? items.map(item => `- [${item.status}] ${item.content}`).join('\n') : '(empty)'

async function mainMessages($: EngineInterface): Promise<readonly SessionMessage[]> {
  const found = await $.session.messages().catch(() => [] as SessionMessage[])
  return Array.isArray(found) ? found : []
}
const mainLength = async ($: EngineInterface) => (await mainMessages($)).length
const prints = (messages: readonly SessionMessage[]) =>
  messages.map(m => `${m.role}:${m.text.length}:${m.text.slice(0, 40)}:${m.toolUses.map(use => use.tool_use_id).join(',')}`)

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
  const msgs = followsRewind(owner) ? await mainLength($) : undefined
  const snapshot: Snapshot = {
    n: nextN(h),
    at: await $.clock.now(),
    owner,
    items,
    note: note?.text ?? (note?.restoredFrom !== undefined ? `↶ 回到 #${note.restoredFrom}` : diffNote(prev?.items ?? [], items)),
    restoredFrom: note?.restoredFrom,
    ...(msgs === undefined ? {} : { msgs, epoch: h.epoch }),
  }
  await update($, history, now => ({ ...now, snapshots: [...now.snapshots, snapshot].slice(-MAX_SNAPSHOTS) }))
  await save($)
  return snapshot
}

async function addEvent($: EngineInterface, event: Omit<AgentEvent, 'n' | 'at'>) {
  await serial(async () => {
    const at = await $.clock.now()
    await update($, history, now => ({ ...now, events: [...now.events, { ...event, n: nextN(now), at }].slice(-MAX_EVENTS) }))
    await save($)
  })
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

// The latest stretch a task was in progress: from the step that started it to the step
// that ended it (absent while it still runs). Undefined when it never started.
function taskSpan(h: History, owner: Owner, key: string) {
  let span: { start: number; end?: number } | undefined
  let was = false
  for (const step of h.snapshots) {
    if (step.owner !== owner) continue
    const isOn = step.items.some(item => item.key === key && item.status === 'in_progress')
    if (isOn && !was) span = { start: step.n }
    if (!isOn && was && span) span = { ...span, end: step.n }
    was = isOn
  }
  return span
}

// What a task changed: each file its loop edited while it was in progress, with the
// content from before (`before`) and, when something edited the file after the task
// ended, the copy saved then (`later`): a revert must not write over that.
function taskFiles(h: History, owner: Owner, key: string) {
  const span = taskSpan(h, owner, key)
  if (!span) return { span, files: [] }
  const editor = editorOf(owner)
  const files = new Map<string, { before: Change; later?: Change }>()
  for (const change of h.changes) {
    const k = same(change.file)
    const isDuring = change.owner === editor && change.after >= span.start && (span.end === undefined || change.after < span.end)
    if (isDuring && !files.has(k)) files.set(k, { before: change })
    const had = files.get(k)
    if (had && !had.later && span.end !== undefined && change.after >= span.end) files.set(k, { ...had, later: change })
  }
  return { span, files: [...files.values()] }
}

// A line diff from `a` to `b` as hunks with two lines of context; a long pair gets the
// two texts' ends instead of an exact diff.
function lineDiff(a: string, b: string) {
  const x = a.split('\n')
  const y = b.split('\n')
  if (x.length * y.length > 4_000_000) return `--- before (last lines)\n${x.slice(-40).join('\n')}\n+++ after (last lines)\n${y.slice(-40).join('\n')}`
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const ops: { op: ' ' | '-' | '+'; line: string }[] = []
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) ops.push({ op: ' ', line: x[i++] }), j++
    else if (j < y.length && (i >= x.length || lcs[i][j + 1] >= lcs[i + 1][j])) ops.push({ op: '+', line: y[j++] })
    else ops.push({ op: '-', line: x[i++] })
  }
  const keep = ops.map((o, k) => o.op !== ' ' || ops.slice(Math.max(0, k - 2), k + 3).some(n => n.op !== ' '))
  const out: string[] = []
  ops.forEach((o, k) => {
    if (keep[k]) out.push(`${o.op}${o.line}`)
    else if (keep[k - 1]) out.push('…')
  })
  return out.join('\n')
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

// Writes a saved copy back, or removes the file when there was none.
async function putBack($: EngineInterface, change: Change) {
  if (change.blob === null) await removeFile($, change.file)
  else await $.fs.write(change.file, await $.fs.read(`${dir}/${change.blob}`))
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

// Puts a list in place where it lives. These tool calls carry this plugin as their
// origin, so the tool.call hook leaves them to the caller to record.
async function applyList($: EngineInterface, owner: Owner, items: Item[]) {
  if (owner === '' && ownTool) return { items, isApplied: true }
  if (owner === '') {
    const isApplied = await $.tool
      .call({ tool: 'TodoWrite', todos: items.map(item => ({ content: item.content, status: item.status, activeForm: item.content })) })
      .then(r => !('deny' in r), () => false)
    return { items, isApplied }
  }
  if (owner === 'tasks') {
    const h = await read($, history)
    return restoreTasks($, latest(h, 'tasks')?.items ?? [], items).then(
      out => ({ items: out, isApplied: true }),
      () => ({ items, isApplied: false }),
    )
  }
  return { items, isApplied: false }
}

const listName = (owner: Owner) => (owner === '' ? 'todo list' : owner === 'tasks' ? 'task list' : `todo list of agent ${owner}`)

async function tell($: EngineInterface, text: string) {
  await serial(async () => {
    await update($, history, now => ({ ...now, pending: [...now.pending, text] }))
    await save($)
  })
}

// Back to a step: the list, and with `withFiles` every file edited since, after a
// checkpoint that lets this restore itself be rolled back.
async function restore($: EngineInterface, n: number, withFiles: boolean) {
  const h = await read($, history)
  const step = h.snapshots.find(s => s.n === n)
  if (!step) return
  const failed: string[] = []
  const restored: string[] = []
  const targets = withFiles ? filesAfter(h, step) : []
  const checkpoint = withFiles
    ? await serial(async () => {
        const made = await record($, step.owner, latest(await read($, history), step.owner)?.items ?? [], { text: `📌 回到 #${n} 之前的狀態` })
        for (const change of targets) await backup($, change.owner, change.file, true)
        return made
      })
    : undefined
  for (const change of targets) {
    try {
      await putBack($, change)
      restored.push(change.file)
    } catch (err) {
      failed.push(`${base(change.file)}（${err instanceof Error ? err.message : String(err)}）`)
    }
  }
  const { items, isApplied } = await applyList($, step.owner, step.items)
  await serial(() => record($, step.owner, items, { restoredFrom: n }))
  const files = restored.length
    ? `\nThese files were also restored to their content at that step, undoing every edit made to them after it:\n${restored.map(f => `- ${f}`).join('\n')}`
    : ''
  await tell($, `The user rolled the ${listName(step.owner)} back to step #${n} with the todo-history mod${isApplied ? '' : ' (the list could not be written back for you; adopt it yourself)'}. The list is now:\n${listText(items)}${files}\nTreat this as the current state.`)
  const undo = checkpoint ? `（要反悔就回到 #${checkpoint.n}）` : ''
  const done = `已回到 #${n}${withFiles ? `，還原 ${restored.length} 個檔案${undo}` : ''}`
  await update($, view, v => ({
    ...v,
    confirm: null,
    open: null,
    note: failed.length ? `${done}；失敗：${failed.join('、')}` : `${done}。下一則訊息會告訴 Claude。`,
  }))
}

// Undoes one task and keeps the rest: files only it edited go back to their content
// from before it; files later work edited too are handed to the model with the task's
// own diff, to take out that part alone. The task goes back to pending.
async function revertTask($: EngineInterface, owner: Owner, key: string) {
  const h = await read($, history)
  const current = latest(h, owner)
  const item = current?.items.find(one => one.key === key)
  if (!current || !item) return
  const { files } = taskFiles(h, owner, key)
  const checkpoint = await serial(async () => {
    const made = await record($, owner, current.items, { text: `📌 撤銷「${item.content}」之前的狀態` })
    for (const { before } of files) await backup($, before.owner, before.file, true)
    return made
  })
  const restored: string[] = []
  const failed: string[] = []
  const merges: string[] = []
  for (const { before, later } of files) {
    try {
      if (!later) {
        await putBack($, before)
        restored.push(before.file)
        continue
      }
      const was = before.blob === null ? '' : await $.fs.read(`${dir}/${before.blob}`)
      const became = later.blob === null ? '' : await $.fs.read(`${dir}/${later.blob}`)
      merges.push(`### ${before.file}\n${before.blob === null ? '(the task created this file)\n' : ''}\`\`\`diff\n${lineDiff(was, became)}\n\`\`\``)
    } catch (err) {
      failed.push(`${base(before.file)}（${err instanceof Error ? err.message : String(err)}）`)
    }
  }
  const reopened = current.items.map(one => (one.key === key ? { ...one, status: 'pending' as Status } : one))
  const { items, isApplied } = await applyList($, owner, reopened)
  await serial(() => record($, owner, items, { text: `↩ 撤銷「${item.content}」` }))
  const restoredText = restored.length ? `\nThese files were restored to their content from before that task:\n${restored.map(f => `- ${f}`).join('\n')}` : ''
  await tell($, `The user undid the task "${item.content}" of the ${listName(owner)} with the todo-history mod, keeping the other tasks' work${isApplied ? '' : ' (the list could not be written back for you; adopt it yourself)'}. The task is pending again. The list is now:\n${listText(items)}${restoredText}`)
  if (merges.length) {
    // Later work edited these files too: only the task's own part should come out.
    await $.prompt.submit({
      text: `todo-history：使用者撤銷了 task「${item.content}」。下面這些檔案在那之後又被其他工作改過，所以沒有直接覆蓋。請只把這個 task 造成的修改（下面的 diff，- 是改之前、+ 是它改成的）從檔案的目前內容中拿掉，保留之後其他的修改；做完簡短說明你改了什麼。\n\n${merges.join('\n\n')}`,
    })
  }
  const parts = [`已撤銷「${clip(item.content, 20)}」`, restored.length ? `還原 ${restored.length} 個檔案` : '', merges.length ? `${merges.length} 個交給 Claude 處理` : '']
  const done = `${parts.filter(Boolean).join('，')}（要反悔就回到 #${checkpoint?.n}）`
  await update($, view, v => ({ ...v, confirm: null, task: null, note: failed.length ? `${done}；失敗：${failed.join('、')}` : done }))
}

// A rewind left the main conversation `length` messages long: each list it moves goes
// back to its last step taken at that length or before. Files are the rewind's own.
async function followRewind($: EngineInterface, length: number) {
  const h = await read($, history)
  for (const owner of ['', 'tasks']) {
    const mine = h.snapshots.filter(s => s.owner === owner)
    const now = mine.at(-1)
    if (!now) continue
    const inEpoch = mine.filter(s => s.msgs !== undefined && (s.epoch ?? 0) === h.epoch)
    // No step in this epoch is that old: the list as it stood when the conversation
    // was last compacted, or none at all.
    const target = inEpoch.filter(s => (s.msgs ?? 0) <= length).at(-1)
      ?? mine.filter(s => (s.epoch ?? 0) < h.epoch).at(-1)
    const items = target?.items ?? []
    if (sameItems(now.items, items)) continue
    const applied = await applyList($, owner, items)
    await serial(() => record($, owner, applied.items, {
      restoredFrom: target?.n,
      text: target ? `↶ rewind：對話回到第 ${length} 則 → 清單回到 #${target.n}` : `↶ rewind：對話回到第 ${length} 則 → 清單清空`,
    }))
    await tell($, `The conversation was rewound; the ${listName(owner)} followed it back${target ? ` to step #${target.n}` : ' to before it existed'}. The list is now:\n${listText(applied.items)}`)
  }
}

async function checkRewind($: EngineInterface) {
  if (compacting) return
  const now = prints(await mainMessages($))
  const was = seen
  seen = now
  const isRewind = was !== undefined && now.length < was.length && now.every((print, i) => print === was[i])
  if (isRewind) await followRewind($, now.length)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const done = await next(e)
    await $.command.register({
      name: 'todos',
      description: 'Show the history of the todo list, tasks and agents; undo one task or roll back to any step (clear: forget this session\'s history)',
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
    const tools = await $.tool.list().catch(() => [])
    ownTool = !tools.some(tool => tool.name === 'TodoWrite' || tool.name === 'TaskCreate')
    if (ownTool) await $.tool.register(TODO_SPEC).catch(() => (ownTool = false))
    seen = prints(await mainMessages($))
    $.clock.every(REWIND_POLL_MS, () => void checkRewind($))
    void $.ui.open({ id: PANE, title: TITLE })

    return done
  })

  on('command.run', { command: 'todos' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await serial(async () => {
        await update($, history, () => EMPTY)
        await save($)
      })
      await update($, view, v => ({ ...v, open: null, task: null, confirm: null, note: null }))
      return { text: 'Todo History: this session\'s history cleared.' }
    }
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Todo History opened.' }
  })

  on('tool.call', async ($, e, next) => {
    // A restore's own TodoWrite and task calls: it records the result itself.
    if (next.origin.plugin === 'todo-history') return next(e)
    if (e.tool === TODO_TOOL) {
      const input = e as unknown as { todos?: { content?: unknown; status?: unknown }[] }
      const items = (Array.isArray(input.todos) ? input.todos : []).flatMap((todo): Item[] => {
        const content = String(todo?.content ?? '').trim()
        const status = ['pending', 'in_progress', 'completed'].includes(String(todo?.status)) ? (todo.status as Status) : 'pending'
        return content ? [{ key: content, content, status }] : []
      })
      await serial(() => record($, e.agentId ?? '', items))
      const done = items.filter(item => item.status === 'completed').length
      // A registered tool answers with text (or content blocks), never an object.
      return { result: `Todo list saved: ${done}/${items.length} done.` }
    }
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

  // A compaction shortens the conversation too, but is no rewind: a new epoch starts.
  on('session.compact', async ($, e, next) => {
    if (e.agentId) return next(e)
    compacting = true
    try {
      const result = await next(e)
      if ('messages' in result && result.messages) {
        await serial(async () => {
          await update($, history, h => ({ ...h, epoch: h.epoch + 1 }))
          await save($)
        })
        seen = prints(await mainMessages($))
      }
      return result
    } finally {
      compacting = false
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if ('agentId' in spawned && spawned.agentId) {
      await addEvent($, { agentId: spawned.agentId, kind: 'spawn', fork: e.fork, text: e.description || e.subagentType })
    }
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    const spawn = id ? (await read($, history)).events.find(one => one.agentId === id && one.kind === 'spawn') : undefined
    if (id && spawn) {
      const ok = !e.isAborted && e.reason === 'answer'
      await addEvent($, { agentId: id, kind: ok ? 'done' : 'failed', fork: spawn.fork, text: `${spawn.text}${e.answer ? `：${oneLine(e.answer)}` : ''}` })
    }
    return next(e)
  })

  // After a restore, the next prompt carries what changed, so the model works from it.
  // A rewind done since the last look is caught here at the latest.
  on('prompt.submit', async ($, e, next) => {
    await checkRewind($)
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
    const setView = (patch: Partial<View>) => void update($, view, now => ({ ...now, ...patch }))

    const header = (
      <Box flexDirection="column">
        <Text>
          <Text bold color="claude">TODO HISTORY</Text>
          <Text dimColor>{`  ${hist.snapshots.length} 步 · ${hist.changes.length} 個檔案備份`}</Text>
        </Text>
        {owners.length > 1 && (
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {owners.map((o, i) => (
              <Button key={`owner-${i}`} plain onPress={() => setView({ owner: o, open: null, task: null, confirm: null })}>
                <Text color={o === owner ? 'claude' : undefined} bold={o === owner}>{`${o === owner ? '▸ ' : '  '}${ownerLabel(o)}`}</Text>
              </Button>
            ))}
          </Box>
        )}
        {rule}
      </Box>
    )

    if (hist.snapshots.length === 0 && hist.events.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>還沒有 todo 紀錄。</Text>
          <Text dimColor>Claude 用 todo 或 task、或叫起 agent 時，每一步都會記在這裡。</Text>
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
    const confirmRow = (text: string, onYes: () => Promise<unknown>) => (
      <Box flexDirection="column" marginTop={1}>
        <Text color="warning">{clip(text, W - 4)}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="yes" label="確定" hotkey="y" variant="primary"
            onPress={() => void onYes().catch(err => update($, view, now => ({ ...now, confirm: null, note: `失敗：${String(err)}` })))} />
          <Button key="no" label="取消" hotkey="q" onPress={() => setView({ confirm: null })} />
        </Box>
      </Box>
    )

    // One current task: what it changed, and undoing it alone.
    const taskPanel = (item: Item) => {
      const width = W - 4
      const { span, files } = taskFiles(hist, owner, item.key)
      const clashes = files.filter(f => f.later).length
      const confirm = v.confirm?.kind === 'revert' && v.confirm.key === item.key
      return (
        <Box key={`task-${item.key}`} flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text bold color="claude">{clip(`「${item.content}」改了什麼`, width)}</Text>
          {!span && <Text dimColor>這個 task 還沒開始過。</Text>}
          {span && files.length === 0 && <Text dimColor>{clip('它進行時沒有用 Edit／Write 改過檔案。', width)}</Text>}
          {files.slice(0, 8).map(({ before, later }, i) => (
            <Text key={`tf-${i}`}>
              <Text dimColor>{clip(`${before.blob === null ? '＋' : '✎'} ${base(before.file)}`, width - (later ? 16 : 0))}</Text>
              {later && <Text color="warning">{'  ⚠ 之後又被改過'}</Text>}
            </Text>
          ))}
          {files.length > 8 && <Text dimColor>{`…還有 ${files.length - 8} 個`}</Text>}
          {clashes > 0 && <Text dimColor>{clip('⚠ 的檔案不直接覆蓋，會請 Claude 只拿掉這個 task 的修改。', width)}</Text>}
          {span && (confirm
            ? confirmRow(`確定撤銷「${item.content}」？${files.length - clashes} 個檔案還原${clashes ? `、${clashes} 個交給 Claude` : ''}，task 變回未開始。`,
                () => revertTask($, owner, item.key))
            : (
              <Box flexDirection="row" gap={1} marginTop={1}>
                <Button key="revert-btn" label="撤銷這個 task" hotkey="u" variant="primary"
                  onPress={() => setView({ confirm: { kind: 'revert', key: item.key } })} />
                <Button key="task-close" label="收合" hotkey="x" onPress={() => setView({ task: null, confirm: null })} />
              </Box>
            ))}
        </Box>
      )
    }

    const detail = (step: Snapshot) => {
      const width = W - 4
      const files = filesAfter(hist, step)
      const confirm = v.confirm?.kind === 'restore' && v.confirm.n === step.n ? v.confirm : null
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
            confirmRow(confirm.withFiles
              ? `確定整段回到 #${step.n}，並覆寫 ${files.length} 個檔案？（＋ 的檔案會被刪除）`
              : `確定把清單回到 #${step.n}？檔案不會動。`, () => restore($, step.n, confirm.withFiles))
          ) : (
            <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
              <Button key={`list-${step.n}`} label="只還原清單" hotkey="r"
                onPress={() => setView({ confirm: { kind: 'restore', n: step.n, withFiles: false } })} />
              {files.length > 0 && (
                <Button key={`all-${step.n}`} label="整段回到這一步" hotkey="f"
                  onPress={() => setView({ confirm: { kind: 'restore', n: step.n, withFiles: true } })} />
              )}
              <Button key={`close-${step.n}`} label="收合" hotkey="x" onPress={() => setView({ open: null, confirm: null })} />
            </Box>
          )}
        </Box>
      )
    }

    // The main timeline also shows agents and forks starting and ending.
    type Row = { kind: 'step'; step: Snapshot } | { kind: 'event'; event: AgentEvent }
    const timeline: Row[] = [
      ...mine.map((step): Row => ({ kind: 'step', step })),
      ...(owner === '' ? hist.events.map((event): Row => ({ kind: 'event', event })) : []),
    ].sort((a, b) => (b.kind === 'step' ? b.step.n : b.event.n) - (a.kind === 'step' ? a.step.n : a.event.n))
    const openStep = mine.find(s => s.n === v.open)
    const openTask = current?.items.find(item => item.key === v.task)
    const used = 5 + (current?.items.length ?? 0) + 3 + (openStep ? openStep.items.length + 14 : 0) + (openTask ? 12 : 0)
    const room = Math.max(3, rows - used)
    const shown = timeline.slice(0, room)
    if (openStep && !shown.some(row => row.kind === 'step' && row.step === openStep)) shown.push({ kind: 'step', step: openStep })

    const eventLine = (event: AgentEvent) => {
      const who = event.fork ? '⑂ fork' : '🤖 agent'
      const what = event.kind === 'spawn' ? `${who}「${event.text}」開始`
        : event.kind === 'done' ? `✓ ${who}「${event.text}」` : `✗ ${who}「${event.text}」失敗`
      return (
        <Text key={`event-${event.n}`}>
          <Text color="subtle">{`  #${String(event.n).padEnd(3)} `}</Text>
          <Text dimColor>{`${age(now - event.at).padStart(4)}  `}</Text>
          <Text color={event.kind === 'failed' ? 'error' : 'subtle'}>{clip(what, W - 13)}</Text>
        </Text>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        <Text>
          <Text bold>{`現在（${ownerLabel(owner)}）`}</Text>
          <Text dimColor>{'  點一項看它改了什麼、單獨撤銷'}</Text>
        </Text>
        {current && current.items.length === 0 && <Text dimColor>（空的）</Text>}
        {!current && <Text dimColor>（還沒有清單）</Text>}
        {current?.items.map((item, i) => (
          <Box key={`now-${i}`} flexDirection="column">
            <Button key={`item-${i}`} plain onPress={() => setView({ task: v.task === item.key ? null : item.key, confirm: null })}>
              <Text color={TONE[item.status]}>{`${ICON[item.status]} `}</Text>
              <Text dimColor={item.status === 'completed'} bold={v.task === item.key}>{clip(item.content, W - 2)}</Text>
            </Button>
            {v.task === item.key && taskPanel(item)}
          </Box>
        ))}
        {rule}
        <Text>
          <Text bold>歷程</Text>
          <Text dimColor>{'  點一步可以整段回到那裡'}</Text>
        </Text>
        {shown.map(row => row.kind === 'event' ? eventLine(row.event) : (
          <Box key={`step-${row.step.n}`} flexDirection="column">
            <Button key={`step-btn-${row.step.n}`} plain
              onPress={() => setView({ open: v.open === row.step.n ? null : row.step.n, confirm: null })}>
              <Text color={v.open === row.step.n ? 'claude' : 'subtle'}>{`${v.open === row.step.n ? '▾' : '▸'} #${String(row.step.n).padEnd(3)} `}</Text>
              <Text dimColor>{`${age(now - row.step.at).padStart(4)}  `}</Text>
              <Text color={row.step.restoredFrom !== undefined || row.step.note.startsWith('↩') ? 'warning' : undefined}>{clip(row.step.note, W - 13)}</Text>
            </Button>
            {v.open === row.step.n && detail(row.step)}
          </Box>
        ))}
        {timeline.length > shown.length && <Text dimColor>{`…更早還有 ${timeline.length - shown.length} 筆`}</Text>}
        {v.note && <Text color="subtle">{clip(v.note, W)}</Text>}
      </Box>
    )
  })
}
