export type AgentCard = {
  id: string
  type: string
  description: string
  model?: string
  status: 'running' | 'waiting' | 'done' | 'failed' | 'killed'
  activity?: string
  toolCount: number
  startedAt: number
  // When its last tool call began; a running agent quiet past STALE_MS is flagged.
  lastToolAt: number
  endedAt?: number
  // The agent whose loop spawned it; absent when the main loop did.
  parentId?: string
  // A teammate's address, `<name>@<team>`; teammates idle between turns rather than finish.
  teammateId?: string
  name?: string
  // The task it was handed, as the spawn's prompt gave it.
  prompt?: string
}

// One line of an agent's transcript as the detail view draws it.
export type Entry = {
  kind: 'text' | 'tool' | 'result'
  text: string
  isError?: boolean
}

export type Detail = {
  id: string
  entries: Entry[]
  // How many of the newest entries to show; "more" raises it.
  depth: number
  error?: string
}

export type ZooView = {
  // Compact draws one line per agent, nested under its parent, so a team fits.
  compact: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'agent-zoo': { agents: AgentCard[]; tick: number; detail: Detail | null; view: ZooView }
  }
}
