import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, SessionMessage, Timer } from 'claude-code'

import type { AgentCard, Detail, Entry, ZooView } from '../types'
import { bodyColor, critter, hex, SPRITE_COLS, SPRITE_ROWS } from './sprite'

const PANE = 'agent-zoo'
const TITLE = 'Agent Zoo'
const agents = atom({ plugin: 'agent-zoo', key: 'agents' } as const, [])
const tick = atom({ plugin: 'agent-zoo', key: 'tick' } as const, 0)
const detail = atom({ plugin: 'agent-zoo', key: 'detail' } as const, null as Detail | null)
const view = atom({ plugin: 'agent-zoo', key: 'view' } as const, { compact: false } as ZooView)

const STALE_MS = 60_000
const DEPTH = 12

const COLOR: Record<AgentCard['status'], string> = {
  running: 'claude',
  waiting: 'warning',
  done: 'success',
  failed: 'error',
  killed: 'inactive',
}

const ORDER: Record<AgentCard['status'], number> = { running: 0, waiting: 1, failed: 2, killed: 2, done: 3 }
const isLive = (card: AgentCard) => card.status === 'running' || card.status === 'waiting'
// A phase of its own per critter, so they do not march in step.
const phase = (id: string) => [...id].reduce((n, ch) => n + ch.charCodeAt(0), 0)

let timer: Timer | undefined

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
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - cells(text)))
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const base = (path: unknown) => String(path ?? '').split(/[\\/]/).pop() ?? ''

function describeTool(e: { tool: string; [arg: string]: unknown }): string {
  switch (e.tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return `${e.tool} ${base(e.file_path)}`
    case 'Bash':
    case 'PowerShell':
      return `$ ${String(e.command ?? '').split('\n')[0]}`
    case 'Grep':
    case 'Glob':
      return `${e.tool} ${String(e.pattern ?? '')}`
    case 'WebFetch':
      return `fetch ${String(e.url ?? '')}`
    case 'WebSearch':
      return `search ${String(e.query ?? '')}`
    case 'Agent':
      return `spawn ${String(e.subagent_type ?? 'agent')}: ${String(e.description ?? '')}`
    case 'SendMessage':
      return `message → ${String(e.to ?? '')}`
    default:
      return e.tool
  }
}

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
}

// An agent's transcript as lines: what it said, each tool it called, and how that went.
function entriesOf(messages: readonly SessionMessage[]): Entry[] {
  const out: Entry[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    if (message.text.trim()) out.push({ kind: 'text', text: message.text.trim() })
    for (const use of message.toolUses) {
      out.push({ kind: 'tool', text: describeTool({ ...use.input, tool: use.tool }) })
      if (use.text !== undefined) {
        const first = use.text.split('\n').find(line => line.trim()) ?? ''
        out.push({ kind: 'result', text: oneLine(first) || '(no output)', isError: use.isError })
      }
    }
  }
  return out
}

const statusOf = (info: AgentInfo): AgentCard['status'] =>
  info.status === 'pending' || info.status === 'running' ? 'running'
    : info.status === 'waiting' || info.status === 'idle' ? 'waiting'
    : info.status === 'completed' ? 'done'
    : info.status

async function patch($: EngineInterface, id: string, fn: (card: AgentCard) => AgentCard) {
  await update($, agents, list => list.map(card => (card.id === id ? fn(card) : card)))
}

async function loadDetail($: EngineInterface, id: string) {
  const found = await $.session.messages({ agentId: id }).catch((err: unknown) => ({ deny: String(err) }))
  await update($, detail, now => {
    if (now?.id !== id) return now
    return 'deny' in found ? { ...now, error: found.deny } : { ...now, entries: entriesOf(found), error: undefined }
  })
}

async function select($: EngineInterface, id: string) {
  const now = await read($, detail)
  if (now?.id === id) return void (await update($, detail, () => null))
  await update($, detail, () => ({ id, entries: [], depth: DEPTH }))
  await loadDetail($, id)
}

// Agents this module did not see spawn (a reload, a teammate in a pane of its own).
async function adopt($: EngineInterface, live: readonly AgentInfo[], now: number) {
  const known = new Set((await read($, agents)).map(card => card.id))
  const fresh = live.filter(info => !known.has(info.id)).map((info): AgentCard => ({
    id: info.id,
    type: info.type,
    description: info.description,
    status: statusOf(info),
    toolCount: 0,
    startedAt: now,
    lastToolAt: now,
    parentId: info.parentId,
    teammateId: info.teammateId,
    name: info.name,
  }))
  if (fresh.length) await update($, agents, list => [...list, ...fresh].slice(-40))
}

// Animates while anything runs, and keeps an open detail current; stops once every agent settled.
function startTimer($: EngineInterface) {
  if (timer) return
  let beats = 0
  timer = $.clock.every(500, () => {
    void (async () => {
      beats += 1
      let list = await read($, agents)
      if (beats % 4 === 0) {
        const live = await $.agent.list().catch(() => [] as AgentInfo[])
        const byId = new Map(live.map(one => [one.id, one]))
        const now = await $.clock.now()
        await adopt($, live, now)
        list = await read($, agents)
        const next = list.map((card): AgentCard => {
          if (!isLive(card)) return card
          const info = byId.get(card.id)
          if (!info) return card
          const status = statusOf(info)
          if (status === card.status) return card
          return status === 'running' || status === 'waiting' ? { ...card, status } : { ...card, status, endedAt: now }
        })
        if (next.some((card, i) => card !== list[i])) list = await update($, agents, () => next)
      }
      const open = await read($, detail)
      if (open && beats % 2 === 0 && list.some(card => card.id === open.id && isLive(card))) await loadDetail($, open.id)
      if (!list.some(isLive)) {
        timer?.cancel()
        timer = undefined
        return
      }
      await update($, tick, n => n + 1)
    })()
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-zoo',
      description: 'Show the sub-agents and teammates of this session in a pane (compact: one line each; clear: drop finished ones)',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void $.agent.list().then(async live => {
      await adopt($, live, await $.clock.now())
      if (live.length) startTimer($)
    }).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'agent-zoo' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      const kept = await update($, agents, list => list.filter(isLive))
      await update($, detail, now => (now && kept.some(card => card.id === now.id) ? now : null))
      return { text: 'Agent Zoo: finished agents cleared.' }
    }
    if (arg === 'compact') {
      const { compact } = await update($, view, v => ({ ...v, compact: !v.compact }))
      return { text: `Agent Zoo: ${compact ? 'compact list' : 'critters'}.` }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Agent Zoo opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if ('agentId' in spawned && spawned.agentId) {
      const now = await $.clock.now()
      const card: AgentCard = {
        id: spawned.agentId,
        type: e.subagentType,
        description: e.description ?? e.name ?? '',
        model: spawned.model,
        status: 'running',
        toolCount: 0,
        startedAt: now,
        lastToolAt: now,
        parentId: e.parentAgentId,
        teammateId: spawned.teammateId,
        name: e.name,
        prompt: e.prompt,
      }
      await update($, agents, list =>
        [...list.filter(one => one.id !== card.id), card].slice(-40),
      )
      startTimer($)
    }

    return spawned
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (!id) return next(e)
    const now = await $.clock.now()
    await patch($, id, card =>
      isLive(card)
        ? { ...card, status: 'running', activity: describeTool(e), toolCount: card.toolCount + 1, lastToolAt: now }
        : card,
    )
    const result = await next(e)
    if ((await read($, detail))?.id === id) void loadDetail($, id)

    return result
  }).catch(($, e, next) => next(e))

  // A teammate woken by a message runs again.
  on('turn.start', async ($, e, next) => {
    if (e.agentId) await patch($, e.agentId, card => (card.teammateId && card.status === 'waiting' ? { ...card, status: 'running' } : card))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      const now = await $.clock.now()
      await patch($, id, card => ({
        ...card,
        // A teammate's turn ending leaves it idle, waiting for its next message.
        status: e.isAborted ? 'killed' : e.reason !== 'answer' ? 'failed' : card.teammateId ? 'waiting' : 'done',
        activity: e.answer ? clip(oneLine(e.answer), 80) : card.activity,
        endedAt: card.teammateId && !e.isAborted && e.reason === 'answer' ? undefined : now,
      }))
      if ((await read($, detail))?.id === id) await loadDetail($, id)
      await update($, tick, n => n + 1)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // Pixels on the terminal only; elsewhere the column stays blank.
    const Raster = 'Raster' in els ? els.Raster : undefined
    const list = await read($, agents)
    const frame = await read($, tick)
    const open = await read($, detail)
    const { compact } = await read($, view)
    const now = await $.clock.now()
    const W = Math.max(30, (e.props.bodyColumns ?? e.viewport?.columns ?? 48) - 1)
    const rows = e.viewport?.rows ?? 30
    const info = W - SPRITE_COLS - 2
    const rule = <Text color="subtle">{'─'.repeat(W)}</Text>
    const count = (status: AgentCard['status']) => list.filter(card => card.status === status).length
    const summary = [
      [count('running'), 'running', COLOR.running],
      [count('waiting'), 'waiting', COLOR.waiting],
      [count('failed') + count('killed'), 'failed', COLOR.failed],
      [count('done'), 'done', COLOR.done],
    ].filter(([n]) => n) as [number, string, string][]

    const bot = (key: string, type: string, status: AgentCard['status'], step: number) =>
      Raster ? (
        <Raster key={key} columns={SPRITE_COLS} rows={SPRITE_ROWS} cells={critter(type, status, step)} />
      ) : (
        <Box width={SPRITE_COLS} />
      )

    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text bold color="claude">AGENT ZOO</Text>
            {summary.length === 0 && <Text dimColor>{'  idle'}</Text>}
            {summary.map(([n, label, color]) => (
              <Text color={color}>{`  ● ${n} ${label}`}</Text>
            ))}
          </Text>
          {list.length > 0 && (
            <Button key="compact" hotkey="l" plain label={compact ? '◫ 圖示' : '≡ 清單'}
              onPress={() => void update($, view, v => ({ ...v, compact: !v.compact }))} />
          )}
        </Box>
        {rule}
      </Box>
    )

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          <Box flexDirection="row" gap={2} marginTop={1}>
            {bot('bot-empty', 'other', 'waiting', frame)}
            <Box flexDirection="column" justifyContent="center">
              <Text dimColor>還沒有 sub-agent。</Text>
              <Text dimColor>有 agent 被叫起來時，會出現在這裡。</Text>
            </Box>
          </Box>
        </Box>
      )
    }

    const label = (card: AgentCard) => card.name ?? card.teammateId?.split('@')[0] ?? card.type

    // The selected agent's transcript, newest last, with a way to open it whole.
    const detailBox = (card: AgentCard) => {
      if (!open || open.id !== card.id) return null
      const width = W - 4
      const shown = open.entries.slice(-open.depth)
      const hidden = open.entries.length - shown.length
      const lines = shown.flatMap((entry, i) => {
        if (entry.kind === 'tool') return [<Text key={`e-${i}`} color="claude">{clip(`⚙ ${entry.text}`, width)}</Text>]
        if (entry.kind === 'result') {
          return [<Text key={`e-${i}`} color={entry.isError ? 'error' : undefined} dimColor={!entry.isError}>{clip(`  ↳ ${entry.text}`, width)}</Text>]
        }
        // What the agent said: its last few lines, each clipped.
        const said = entry.text.split('\n').map(oneLine).filter(Boolean)
        const tail = said.slice(-4)
        return [
          ...(said.length > tail.length ? [<Text key={`e-${i}-more`} dimColor>{'  …'}</Text>] : []),
          ...tail.map((line, j) => <Text key={`e-${i}-${j}`}>{clip(`${j === 0 ? '💬 ' : '   '}${line}`, width)}</Text>),
        ]
      })
      return (
        <Box key={`detail-${card.id}`} flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text>
            <Text bold color="claude">{clip(`${label(card)} 的進度`, width - 12)}</Text>
            <Text dimColor>{`  ${open.entries.length} 筆`}</Text>
          </Text>
          {card.prompt && <Text dimColor>{clip(`任務：${oneLine(card.prompt)}`, width)}</Text>}
          <Text color="subtle">{'┄'.repeat(width)}</Text>
          {open.error && <Text color="error">{clip(`讀不到內容：${open.error}`, width)}</Text>}
          {!open.error && open.entries.length === 0 && <Text dimColor>還沒有內容…</Text>}
          {hidden > 0 && <Text dimColor>{`… 前面還有 ${hidden} 筆`}</Text>}
          {lines}
          <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
            <Button key={`full-${card.id}`} label="主畫面看完整對話" hotkey="v" variant="primary"
              onPress={() => void $.ui.view({ agentId: card.id })} />
            {hidden > 0 && (
              <Button key={`more-${card.id}`} label="更多" hotkey="m"
                onPress={() => void update($, detail, d => (d ? { ...d, depth: d.depth + 20 } : d))} />
            )}
            <Button key={`close-${card.id}`} label="收合" hotkey="x" onPress={() => void update($, detail, () => null)} />
          </Box>
        </Box>
      )
    }

    // Live agents first, newest first within a status.
    const sorted = [...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.startedAt - a.startedAt)
    const detailRows = open ? Math.min(open.depth, open.entries.length) + 8 : 0

    if (compact) {
      // Each agent under the one that spawned it; a team's teammates under their team.
      const byParent = new Map<string, AgentCard[]>()
      const ids = new Set(list.map(card => card.id))
      for (const card of sorted) {
        const parent = card.parentId && ids.has(card.parentId) ? card.parentId
          : card.teammateId ? `team:${card.teammateId.split('@')[1] ?? ''}` : ''
        byParent.set(parent, [...(byParent.get(parent) ?? []), card])
      }
      const ordered: [AgentCard, number][] = []
      const walk = (parent: string, depth: number) => {
        for (const card of byParent.get(parent) ?? []) {
          ordered.push([card, depth])
          walk(card.id, depth + 1)
        }
      }
      walk('', 0)
      const teams = [...byParent.keys()].filter(key => key.startsWith('team:'))
      const room = Math.max(3, rows - 4 - detailRows)
      const row = (card: AgentCard, depth: number) => {
        const quiet = (card.endedAt ?? now) - card.lastToolAt
        const isStale = card.status === 'running' && quiet > STALE_MS
        const indent = '  '.repeat(depth) + (depth ? '└ ' : '')
        const time = elapsed((card.endedAt ?? now) - card.startedAt).padStart(6)
        const name = clip(`${indent}${label(card)}`, 18)
        const rest = W - 2 - 18 - 1 - cells(time) - 1
        return (
          <Box key={`row-${card.id}`} flexDirection="column">
            <Button key={`open-${card.id}`} plain onPress={() => void select($, card.id)}>
              <Text color={COLOR[card.status]}>{open?.id === card.id ? '▾ ' : '● '}</Text>
              <Text bold color={hex(bodyColor(card.type))}>{pad(name, 18)}</Text>
              <Text dimColor>{` ${pad(clip(card.activity ?? card.description, rest), rest)} `}</Text>
              <Text color={isStale ? 'warning' : 'subtle'}>{time}</Text>
            </Button>
            {detailBox(card)}
          </Box>
        )
      }
      const visible = ordered.slice(0, room)
      return (
        <Box flexDirection="column">
          {header}
          {teams.length > 0 && <Text dimColor>{clip(`團隊：${teams.map(key => key.slice(5)).join('、')}`, W)}</Text>}
          {visible.map(([card, depth]) => row(card, depth))}
          {ordered.length > visible.length && <Text dimColor>{`+${ordered.length - visible.length} more`}</Text>}
          <Text dimColor>{clip('點一列看進度 · l 切換圖示', W)}</Text>
        </Box>
      )
    }

    // As many critters as fit, the open one always among them.
    const room = Math.max(1, Math.floor((rows - 3 - detailRows) / (SPRITE_ROWS + 1)))
    const picked = sorted.slice(0, room)
    const selected = open && sorted.find(card => card.id === open.id)
    const shown = selected && !picked.includes(selected) ? [...picked.slice(0, room - 1), selected] : picked

    return (
      <Box flexDirection="column">
        {header}
        {shown.map((card, i) => {
          const quiet = (card.endedAt ?? now) - card.lastToolAt
          const isStale = card.status === 'running' && quiet > STALE_MS
          const color = hex(bodyColor(card.type))
          const chip = `● ${card.status}`
          const isOpen = open?.id === card.id
          return (
            <Box key={card.id} flexDirection="column">
              <Box flexDirection="row" gap={2}>
                {bot(`bot-${card.id}`, card.type, card.status, frame + phase(card.id))}
                <Box flexDirection="column" width={info}>
                  <Text> </Text>
                  <Text>
                    <Text bold color={color}>{pad(clip(label(card), info - cells(chip) - 1), info - cells(chip))}</Text>
                    <Text color={COLOR[card.status]}>{chip}</Text>
                  </Text>
                  <Text dimColor>
                    {clip(`${elapsed((card.endedAt ?? now) - card.startedAt)} · ${card.toolCount} tools${card.model ? ` · ${card.model}` : ''}`, info)}
                  </Text>
                  <Text color="subtle">{'┄'.repeat(Math.min(info, 24))}</Text>
                  <Text bold>{clip(card.description || '(no description)', info)}</Text>
                  <Text dimColor>{clip(`› ${card.activity ?? '…'}`, info)}</Text>
                  {isStale && <Text color="warning">{clip(`⚠ ${elapsed(quiet)} 沒有動作，可能卡住了`, info)}</Text>}
                  <Button key={`open-${card.id}`} plain label={isOpen ? '▾ 收合進度' : '▸ 看進度'}
                    onPress={() => void select($, card.id)} />
                </Box>
              </Box>
              {detailBox(card)}
              {i < shown.length - 1 && <Text color="subtle">{'┈'.repeat(W)}</Text>}
            </Box>
          )
        })}
        {rule}
        {list.length > shown.length && <Text dimColor>{`+${list.length - shown.length} more · l 切換成清單`}</Text>}
      </Box>
    )
  })
}
