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
}

// A file's content before the first edit to it after a snapshot: what restoring to
// that snapshot writes back. `blob` names the saved copy; null when the file did not exist.
export type Change = {
  at: number
  owner: Owner
  file: string
  blob: string | null
}

// `pending`: what the model is told with the next prompt after a restore.
export type History = { snapshots: Snapshot[]; changes: Change[]; blobs: number; pending: string[] }

export type Confirm = { n: number; withFiles: boolean }

export type View = {
  owner: Owner
  // The snapshot whose detail is open, and a restore waiting for its yes.
  open: number | null
  confirm: Confirm | null
  note: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'todo-history': { history: History; view: View }
  }
}
