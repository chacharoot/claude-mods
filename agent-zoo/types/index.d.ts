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
}

declare module 'claude-code' {
  interface PluginState {
    'agent-zoo': { agents: AgentCard[]; tick: number }
  }
}
