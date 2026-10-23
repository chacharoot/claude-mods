export type SessionRow = {
  id: string
  path: string
  cwd: string
  title: string
  firstPrompt: string
  lastPrompt: string
  branch: string
  started: string
  updated: number
  size: number
  prompts: number
}

// A session with a live process, from ~/.claude/sessions/<pid>.json.
export type LiveInfo = {
  pid: number
  tty: string
  status: string
  kind: string
  name: string
  app: string
  // A background session's short id, what `claude attach` takes; absent from older scans.
  jobId?: string
}

// Where the scanner runs, and the terminal apps it can open a session in.
export type Host = { platform: 'mac' | 'win'; apps: string[] }

export type ContentHit = { id: string; hits: number; snippet: string }

// One rate-limit window of the account, as the last API response reported it.
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Mode =
  | { kind: 'rename'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'new'; dir: string }
  | null

export type View = {
  query: string
  // Content search results for `query`, keyed by session id; null until searched.
  hits: Record<string, ContentHit> | null
  selected: string | null
  mode: Mode
  busy: string | null
  note: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-manager': {
      sessions: SessionRow[]
      live: Record<string, LiveInfo>
      view: View
      current: string
      app: string
      host: Host
      limits: Limit[]
    }
  }
}
