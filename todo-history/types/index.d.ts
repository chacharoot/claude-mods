export type Status = 'pending' | 'in_progress' | 'completed'

// One entry of a list: a TodoWrite item keyed by its text, or a task keyed by its id.
export type Item = { key: string; content: string; status: Status }

// Whose list: '' the main conversation's todos, 'tasks' the shared task list, else an agent id.
export type Owner = string

export type Snapshot = {
  n: number
  at: number
  owner: Owner
  items: Item[]
  // What changed from the owner's previous snapshot: `+ added`, `▶ started`, `✓ done`...
  note: string
  // Set on a snapshot a restore wrote: the step it went back to.
  restoredFrom?: number
  // The main conversation's length when it was taken, and the compaction epoch that
  // length counts in: a rewind to message m brings the list back to the last step
  // taken at m or before. Absent on agents' lists, which no rewind of the main one moves.
  msgs?: number
  epoch?: number
}

// A file's content before the first edit to it after a snapshot: what restoring to
// that snapshot writes back. `blob` names the saved copy; null when the file did not exist.
// `after` is the n of the newest snapshot when it was saved (0 before any): order by
// step, never by clock, so an edit in the same millisecond as a step still counts.
export type Change = {
  at: number
  after: number
  owner: Owner
  file: string
  blob: string | null
}

// A sub-agent or fork starting or ending, shown in the main timeline among the steps.
export type AgentEvent = {
  n: number
  at: number
  agentId: string
  kind: 'spawn' | 'done' | 'failed'
  fork: boolean
  text: string
}

// `pending`: what the model is told with the next prompt after a restore.
// `epoch` counts compactions, which shorten the conversation without being a rewind.
export type History = {
  snapshots: Snapshot[]
  changes: Change[]
  events: AgentEvent[]
  blobs: number
  pending: string[]
  epoch: number
}

export type Confirm =
  | { kind: 'restore'; n: number; withFiles: boolean }
  | { kind: 'revert'; key: string }

export type View = {
  // Which page: the list as it stands now, or the history of steps.
  page: 'now' | 'history'
  owner: Owner
  // The snapshot whose detail is open, the current item whose task panel is open,
  // and an action waiting for its yes.
  open: number | null
  task: string | null
  confirm: Confirm | null
  note: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'todo-history': { history: History; view: View }
  }
}
