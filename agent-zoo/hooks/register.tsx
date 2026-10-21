import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentCard } from '../types'

const PANE = 'agent-zoo'
const TITLE = 'Agent Zoo'
const agents = atom({ plugin: 'agent-zoo', key: 'agents' } as const, [])
const tick = atom({ plugin: 'agent-zoo', key: 'tick' } as const, 0)

// Two-line critters: a face and its legs, one frame list per status, every
// cell SPRITE_W wide so the columns line up.
const SPRITE_W = 7
const SPRITES: Record<AgentCard['status'], [string, string][]> = {
  running: [
    [' (o_o) ', '  /|   '],
    [' (o_o)>', '  |\\   '],
    ['<(o_o) ', '  /|   '],
    [' (o_o) ', '  |\\   '],
  ],
  waiting: [
    [' (-_-) ', ' z     '],
    [' (-_-) ', '  zZ   '],
  ],
  done: [[' (^_^)b', '  ||   ']],
  failed: [[' (x_x) ', '  ..   ']],
  killed: [[' (+_+) ', '  ..   ']],
}
// How far a running critter strolls, in cells, frame by frame.
const STROLL = [0, 1, 2, 3, 2, 1]
const WALK_W = SPRITE_W + Math.max(...STROLL)
const STALE_MS = 60_000

const COLOR: Record<AgentCard['status'], string> = {
  running: 'claude',
  waiting: 'warning',
  done: 'success',
  failed: 'error',
  killed: 'inactive',
}

// Each agent type gets a hat so they read apart at a glance.
const HAT: Record<string, string> = {
  Explore: '[?]',
  Plan: '[#]',
  'general-purpose': '[*]',
  fork: '[Y]',
  'claude-code-guide': '[i]',
}
const ORDER: Record<AgentCard['status'], number> = { running: 0, waiting: 1, failed: 2, killed: 2, done: 3 }
const isLive = (card: AgentCard) => card.status === 'running' || card.status === 'waiting'
// A phase of its own per critter, so they do not march in step.
const phase = (id: string) => [...id].reduce((n, ch) => n + ch.charCodeAt(0), 0)

let timer: Timer | undefined

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

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
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const frame = await read($, tick)
    const now = await $.clock.now()
    const width = Math.max(20, (e.props.bodyColumns ?? e.viewport?.columns ?? 40) - WALK_W - 2)
    const count = (status: AgentCard['status']) => list.filter(card => card.status === status).length
    const summary = [
      [count('running'), 'running'],
      [count('waiting'), 'waiting'],
      [count('failed') + count('killed'), 'failed'],
      [count('done'), 'done'],
    ]
      .filter(([n]) => n)
      .map(([n, label]) => `${n} ${label}`)
      .join(' · ')

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{' (._.) '}</Text>
          <Text dimColor>No sub-agents yet. They show up here when spawned.</Text>
        </Box>
      )
    }

    // Live agents first, newest first within a status; as many as fit (4 rows each).
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 3) / 4))
    const sorted = [...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.startedAt - a.startedAt)
    const shown = sorted.slice(0, room)

    return (
      <Box flexDirection="column">
        <Text dimColor>{summary}</Text>
        {shown.map(card => {
          const frames = SPRITES[card.status]
          const step = frame + phase(card.id)
          const [face, legs] = frames[step % frames.length] ?? frames[0]!
          const hat = HAT[card.type] ?? '[ ]'
          const pad = ' '.repeat(card.status === 'running' ? STROLL[step % STROLL.length] ?? 0 : 0)
          const quiet = (card.endedAt ?? now) - card.lastToolAt
          const isStale = card.status === 'running' && quiet > STALE_MS
          return (
            <Box key={card.id} flexDirection="row" gap={1} marginTop={1}>
              <Box flexDirection="column" width={WALK_W}>
                <Text color={COLOR[card.status]}>{`${pad}  ${hat}`}</Text>
                <Text color={COLOR[card.status]}>{pad + face}</Text>
                <Text color={COLOR[card.status]}>{pad + legs}</Text>
              </Box>
              <Box flexDirection="column" flexShrink={1}>
                <Text>
                  <Text bold color={COLOR[card.status]}>
                    {card.type}
                  </Text>
                  <Text dimColor>
                    {' '}
                    {card.status} · {elapsed((card.endedAt ?? now) - card.startedAt)} ·{' '}
                    {card.toolCount} tools
                  </Text>
                  {isStale && <Text color="warning">{` · idle ${elapsed(quiet)}`}</Text>}
                </Text>
                <Text>{clip(card.description || '(no description)', width)}</Text>
                <Text dimColor>{clip(card.activity ?? '…', width)}</Text>
              </Box>
            </Box>
          )
        })}
        {list.length > shown.length && <Text dimColor>{`+${list.length - shown.length} more`}</Text>}
      </Box>
    )
  })
}
