import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentCard } from '../types'
import { bodyColor, critter, hex, SPRITE_COLS, SPRITE_ROWS } from './sprite'

const PANE = 'agent-zoo'
const TITLE = 'Agent Zoo'
const agents = atom({ plugin: 'agent-zoo', key: 'agents' } as const, [])
const tick = atom({ plugin: 'agent-zoo', key: 'tick' } as const, 0)

const STALE_MS = 60_000

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
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\ud800-\udbff]/
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

const base = (path: unknown) => String(path ?? '').split('/').pop() ?? ''

function describeTool(e: { tool: string; [arg: string]: unknown }): string {
  switch (e.tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return `${e.tool} ${base(e.file_path)}`
    case 'Bash':
      return `$ ${String(e.command ?? '').split('\n')[0]}`
    case 'Grep':
    case 'Glob':
      return `${e.tool} ${String(e.pattern ?? '')}`
    case 'WebFetch':
      return `fetch ${String(e.url ?? '')}`
    case 'WebSearch':
      return `search ${String(e.query ?? '')}`
    default:
      return e.tool
  }
}

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
}

async function patch($: EngineInterface, id: string, fn: (card: AgentCard) => AgentCard) {
  await update($, agents, list => list.map(card => (card.id === id ? fn(card) : card)))
}

// Animates while anything runs; stops itself once every agent settled.
function startTimer($: EngineInterface) {
  if (timer) return
  let beats = 0
  timer = $.clock.every(500, () => {
    void (async () => {
      beats += 1
      let list = await read($, agents)
      if (beats % 4 === 0) {
        const live = await $.agent.list().catch(() => [])
        const byId = new Map(live.map(one => [one.id, one.status]))
        const now = await $.clock.now()
        const next = list.map((card): AgentCard => {
          if (!isLive(card)) return card
          const status = byId.get(card.id)
          if ((status === 'waiting' || status === 'idle') && card.status !== 'waiting') return { ...card, status: 'waiting' }
          if ((status === 'running' || status === 'pending') && card.status !== 'running') return { ...card, status: 'running' }
          if (status === 'failed' || status === 'killed') return { ...card, status, endedAt: now }
          return card
        })
        if (next.some((card, i) => card !== list[i])) list = await update($, agents, () => next)
      }
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
      description: 'Show the sub-agents of this session as critters in a pane (clear: empty it)',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'agent-zoo' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, agents, list =>
        list.filter(card => card.status === 'running' || card.status === 'waiting'),
      )
      return { text: 'Agent Zoo: finished agents cleared.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Agent Zoo opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if ('agentId' in spawned && spawned.agentId) {
      const card: AgentCard = {
        id: spawned.agentId,
        type: e.subagentType,
        description: e.description ?? e.name ?? '',
        model: spawned.model,
        status: 'running',
        toolCount: 0,
        startedAt: await $.clock.now(),
        lastToolAt: await $.clock.now(),
      }
      await update($, agents, list =>
        [...list.filter(one => one.id !== card.id), card].slice(-30),
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

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      const now = await $.clock.now()
      await patch($, id, card => ({
        ...card,
        status: e.isAborted ? 'killed' : e.reason === 'answer' ? 'done' : 'failed',
        activity: e.answer ? clip(e.answer.replace(/\s+/g, ' '), 80) : card.activity,
        endedAt: now,
      }))
      await update($, tick, n => n + 1)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    // Pixels on the terminal only; elsewhere the column stays blank.
    const Raster = 'Raster' in els ? els.Raster : undefined
    const list = await read($, agents)
    const frame = await read($, tick)
    const now = await $.clock.now()
    const W = Math.max(30, (e.props.bodyColumns ?? e.viewport?.columns ?? 48) - 1)
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
        <Text>
          <Text bold color="claude">AGENT ZOO</Text>
          {summary.length === 0 && <Text dimColor>{'  idle'}</Text>}
          {summary.map(([n, label, color]) => (
            <Text color={color}>{`  ● ${n} ${label}`}</Text>
          ))}
        </Text>
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

    // Live agents first, newest first within a status; as many as fit.
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 30) - 3) / (SPRITE_ROWS + 1)))
    const sorted = [...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.startedAt - a.startedAt)
    const shown = sorted.slice(0, room)

    return (
      <Box flexDirection="column">
        {header}
        {shown.map((card, i) => {
          const quiet = (card.endedAt ?? now) - card.lastToolAt
          const isStale = card.status === 'running' && quiet > STALE_MS
          const color = hex(bodyColor(card.type))
          const chip = `● ${card.status}`
          return (
            <Box key={card.id} flexDirection="column">
              <Box flexDirection="row" gap={2}>
                {bot(`bot-${card.id}`, card.type, card.status, frame + phase(card.id))}
                <Box flexDirection="column" width={info}>
                  <Text> </Text>
                  <Text>
                    <Text bold color={color}>{pad(clip(card.type, info - cells(chip) - 1), info - cells(chip))}</Text>
                    <Text color={COLOR[card.status]}>{chip}</Text>
                  </Text>
                  <Text dimColor>
                    {clip(`${elapsed((card.endedAt ?? now) - card.startedAt)} · ${card.toolCount} tools${card.model ? ` · ${card.model}` : ''}`, info)}
                  </Text>
                  <Text color="subtle">{'┄'.repeat(Math.min(info, 24))}</Text>
                  <Text bold>{clip(card.description || '(no description)', info)}</Text>
                  <Text dimColor>{clip(`› ${card.activity ?? '…'}`, info)}</Text>
                  {isStale && <Text color="warning">{clip(`⚠ ${elapsed(quiet)} 沒有動作，可能卡住了`, info)}</Text>}
                </Box>
              </Box>
              {i < shown.length - 1 && <Text color="subtle">{'┈'.repeat(W)}</Text>}
            </Box>
          )
        })}
        {rule}
        {list.length > shown.length && <Text dimColor>{`+${list.length - shown.length} more`}</Text>}
      </Box>
    )
  })
}
