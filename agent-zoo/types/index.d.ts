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

// One SendMessage between agents: `from` the sender's agent id, or "main" for the
// lead; `to` the address as written (a teammate's name, "main", an agent id).
export type ChatMessage = {
  id: string
  from: string
  to: string
  text: string
  at: number
  failed?: boolean
}

export type ZooView = {
  // Compact draws one line per agent, nested under its parent, so a team fits.
  compact: boolean
  // The robots' size: small (10 px, the default) or big (18 px).
  size: 'small' | 'big'
  // The team chat under the zoo: hidden, every kept message or the last few, and
  // the one message drawn whole. Absent from views kept before the chat existed.
  chatHidden?: boolean
  chatAll?: boolean
  chatOpen?: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-zoo': { agents: AgentCard[]; tick: number; detail: Detail | null; view: ZooView; chat: ChatMessage[] }
  }
}
