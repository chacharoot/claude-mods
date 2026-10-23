import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContentHit, Host, Limit, LiveInfo, Match, Mode, Preview, PreviewMessage, SessionRow, View } from '../types'
import { SCANNER } from './scanner'

const PANE = 'session-manager'
const TITLE = 'Session Manager'
const PROJECTS = '~/.claude/projects'
const CACHE = '~/.claude/session-manager/index.json'
const LIMIT = 80
const POLL_MS = 20_000

const EMPTY: View = { query: '', hits: null, selected: null, allMatches: false, preview: null, mode: null, busy: null, note: null }
const SHOWN_MATCHES = 5
const sessions = atom({ plugin: 'session-manager', key: 'sessions' } as const, [])
const live = atom({ plugin: 'session-manager', key: 'live' } as const, {})
const view = atom({ plugin: 'session-manager', key: 'view' } as const, EMPTY)
const current = atom({ plugin: 'session-manager', key: 'current' } as const, '')
const appPref = atom({ plugin: 'session-manager', key: 'app' } as const, '')
const host = atom({ plugin: 'session-manager', key: 'host' } as const, { platform: 'mac', apps: ['Terminal'] } as Host)
const limits = atom({ plugin: 'session-manager', key: 'limits' } as const, [] as Limit[])

const LIMIT_NAMES: Record<string, string> = { five_hour: '5 小時', seven_day: '7 天', spend_limit: '花費' }

// Time until a window resets: `2h13m`, `3d4h`, `12m`.
function until(iso: string | undefined, now: number) {
  const at = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(at)) return ''
  const m = Math.max(0, Math.ceil((at - now) / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`
  return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`
}

// Terminal cells a string takes: CJK and emoji are two wide.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\ud800-\udbff]/
const cells = (s: string) => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)

function fit(s: string, width: number) {
  if (cells(s) <= width) return s + ' '.repeat(width - cells(s))
  let out = ''
  for (const ch of s) {
    if (cells(out + ch) > width - 1) break
    out += ch
  }
  return out + '…' + ' '.repeat(Math.max(0, width - 1 - cells(out)))
}
const clip = (s: string, width: number) => fit(s, width).trimEnd()

const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+|^[A-Za-z]:\\Users\\[^\\]+/, '~')

function age(ms: number) {
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return d < 30 ? `${d}d` : `${Math.floor(d / 30)}mo`
}

const sizeOf = (bytes: number) =>
  bytes > 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`

// What to paste into the person's shell: a POSIX one, or PowerShell on Windows.
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const psq = (s: string) => `'${s.replace(/'/g, `''`)}'`
const resumeCommand = (row: SessionRow, platform: Host['platform']) =>
  platform === 'win'
    ? `cd ${psq(row.cwd)}; claude --resume ${row.id}`
    : `cd ${shq(row.cwd)} && claude --resume ${row.id}`

type Done = { ok: boolean; msg?: string; path?: string }

// Windows often has `python` or the `py` launcher and no `python3` (or a Store
// stub of it that exits without running anything): the first that runs wins.
// With no Python at all, Windows runs scanner.ps1, the same modes in PowerShell.
const PYTHONS = [['python3'], ['python'], ['py', '-3']]
let scannerArgv: string[] | undefined

const powershell = ($: EngineInterface) =>
  ['powershell', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', `${$.plugin.root}/hooks/scanner.ps1`]

async function python<T>($: EngineInterface, args: string[]): Promise<T> {
  const tried = scannerArgv ? [scannerArgv] : [...PYTHONS.map(argv => [...argv, '-I', '-']), powershell($)]
  for (const argv of tried) {
    const isPython = argv.at(-1) === '-'
    const ran = await $.process
      .run([...argv, ...args], isPython ? { stdin: SCANNER, timeoutMs: 120_000 } : { timeoutMs: 120_000 })
      .catch(() => undefined)
    if (ran?.exitCode === 0) {
      scannerArgv = argv
      return JSON.parse(ran.stdout) as T
    }
    if (ran?.stderr.includes('Traceback')) throw new Error(ran.stderr.trim().split('\n').pop())
    // PowerShell ran but the script failed: its first line says why.
    if (ran && !isPython) throw new Error(ran.stderr.trim().split('\n')[0] || `PowerShell exit ${ran.exitCode}`)
  }
  throw new Error('找不到可用的 Python（試過 python3、python、py -3），也沒有 PowerShell')
}

// A failed run says so on the status line instead of leaving the press unanswered.
const attempt = ($: EngineInterface, what: string, work: () => Promise<unknown>) =>
  void work().catch(err => say($, `${what}失敗：${err instanceof Error ? err.message : String(err)}`))

async function setView($: EngineInterface, patch: Partial<View>) {
  await update($, view, v => ({ ...v, ...patch }))
}
const say = ($: EngineInterface, note: string) => setView($, { busy: null, note })

// The conversation around match `at` of the session's hit, or its last messages (`at` -1).
async function showPreview($: EngineInterface, row: SessionRow, at: number, radius = 2) {
  const match = at >= 0 ? (await read($, view)).hits?.[row.id]?.matches?.[at] : undefined
  if (at >= 0 && !match) return
  await setView($, { busy: '讀取對話…', note: null })
  const found = await python<{ messages: PreviewMessage[]; total: number }>($, [
    'context', row.path, String(match ? match.line : -1), String(radius),
  ])
  const preview: Preview = { id: row.id, at, radius, messages: found.messages, total: found.total }
  await setView($, { busy: null, preview })
}

async function refresh($: EngineInterface, quiet = false) {
  if (!quiet) await setView($, { busy: '索引中…', note: null })
  try {
    const found = await python<{ rows: SessionRow[]; live: Record<string, LiveInfo> } & Host>($, [
      'index',
      PROJECTS,
      CACHE,
    ])
    await update($, sessions, () => found.rows)
    await update($, live, () => found.live)
    await update($, host, () => ({ platform: found.platform ?? 'mac', apps: found.apps?.length ? found.apps : ['Terminal'] }))
    if (!quiet) await setView($, { busy: null })
  } catch (err) {
    await say($, `索引失敗：${String(err)}`)
  }
}

async function searchContent($: EngineInterface, query: string) {
  const q = query.trim()
  if (!q) return setView($, { query: '', hits: null })
  await setView($, { query, busy: `搜尋內文「${q}」…`, note: null })
  try {
    const found = await python<ContentHit[]>($, ['search', PROJECTS, q])
    await setView($, {
      busy: null,
      hits: Object.fromEntries(found.map(hit => [hit.id, hit])),
      preview: null,
      note: `內文命中 ${found.length} 個 session`,
    })
  } catch (err) {
    await say($, `搜尋失敗：${String(err)}`)
  }
}

async function chosenApp($: EngineInterface) {
  const pref = await read($, appPref)
  const { apps } = await read($, host)
  if (pref && apps.includes(pref)) return pref
  const me = (await read($, live))[await read($, current)]
  return me?.app && apps.includes(me.app) ? me.app : apps[0] ?? 'Terminal'
}

async function cycleApp($: EngineInterface) {
  const { apps } = await read($, host)
  const now = await chosenApp($)
  const next = apps[(apps.indexOf(now) + 1) % apps.length] ?? now
  await update($, appPref, () => next)
  await $.store.set('app', next)
}

// A live session is brought to front; a background one (a /fork, a --bg run) has no
// window, so it is attached in a new one; any other is resumed in a new window.
async function jump($: EngineInterface, row: SessionRow) {
  const info = (await read($, live))[row.id]
  if (info?.kind === 'bg') {
    const app = await chosenApp($)
    await setView($, { busy: `在 ${app} 打開背景 session…` })
    // attach takes the job's short id, not the session id; it has been the id's first 8 characters.
    const done = await python<Done>($, ['open', app, row.cwd, `claude attach ${info.jobId || row.id.slice(0, 8)}`])
    return say($, done.ok
      ? `已在 ${app} 打開「${clip(row.title, 20)}」；在空白輸入框按 ← 離開，它會繼續在背景`
      : `${app} 開啟失敗：${done.msg}`)
  }
  if (info) {
    const app = info.app || (await chosenApp($))
    const done = await python<Done>($, ['focus', app, info.tty])
    const where = info.name ? `分頁「${info.name}」` : info.tty || `pid ${info.pid}`
    if (done.ok && done.msg !== 'app-only') return say($, `已切到 ${app} 的 ${where}`)
    return say($, (await read($, host)).platform === 'win'
      ? `它已經在 ${app} 開著（${where}），請切到那個分頁；${app} 不讓外部選分頁`
      : `已叫出 ${app}，它在 ${where}（${app} 不支援直接選分頁）`)
  }
  const app = await chosenApp($)
  await setView($, { busy: `在 ${app} 開啟…` })
  const done = await python<Done>($, ['open', app, row.cwd, `claude --resume ${row.id}`])
  await say($, done.ok ? `已在 ${app} resume「${clip(row.title, 24)}」` : `${app} 開啟失敗：${done.msg}`)
  $.clock.after(4000, () => void refresh($, true))
}

async function startNew($: EngineInterface, dir: string) {
  // The scanner expands `~` and checks the folder, on either platform.
  const path = dir.trim()
  if (!path) return say($, '請輸入資料夾')
  const app = await chosenApp($)
  const done = await python<Done>($, ['open', app, path, 'claude'])
  await setView($, { mode: null })
  await say($, done.ok ? `已在 ${app} 的 ${tilde(path)} 開新 session` : `${app} 開啟失敗：${done.msg}`)
  $.clock.after(6000, () => void refresh($, true))
}

async function pickDir($: EngineInterface) {
  await setView($, { busy: '等你選資料夾…', note: null })
  const done = await python<Done>($, ['pickdir'])
  if (done.ok && done.path) await setView($, { mode: { kind: 'new', dir: tilde(done.path) } })
  await setView($, { busy: null })
}

async function rename($: EngineInterface, row: SessionRow, title: string) {
  const name = title.trim()
  if (!name || name === row.title) return setView($, { mode: null })
  await python<Done>($, ['rename', row.path, row.id, name])
  await setView($, { mode: null })
  await refresh($, true)
  await say($, `已改名為「${clip(name, 30)}」`)
}

async function remove($: EngineInterface, row: SessionRow) {
  const done = await python<Done>($, ['trash', row.path])
  await setView($, { mode: null, selected: null })
  await refresh($, true)
  await say($, done.ok ? `「${clip(row.title, 24)}」已移到垃圾桶` : '刪除失敗')
}

const matches = (row: SessionRow, q: string) =>
  `${row.title}\n${row.cwd}\n${row.firstPrompt}\n${row.lastPrompt}\n${row.id}\n${row.branch}`
    .toLowerCase()
    .includes(q)

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE, focus: true })
  void refresh($)

  return { text: 'Session Manager opened.' }
}

export const register: Register = on => {
  // Whether `/sessions` is ours this load; another plugin's stays its own.
  let ownsSessions = false

  on('session.start', async ($, e, next) => {
    const done = await next(e)
    // `/sessions` is a common name (session-monitor takes it too): claim it only
    // when free, so a clash never stops the pane from opening.
    const description = 'Browse, search, resume, rename, start and delete Claude Code sessions on this machine'
    await $.command.register({ name: 'session-manager', description }).catch(() => undefined)
    ownsSessions = await $.command.register({ name: 'sessions', description }).then(() => true, () => false)
    const stored = await $.store.get('app').catch(() => undefined)
    await update($, appPref, () => (typeof stored === 'string' ? stored : ''))
    void $.session.id().then(id => update($, current, () => id))
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    $.clock.every(POLL_MS, () => void refresh($, true))
    void $.session.usage()
      .then(usage => update($, limits, () => usage.rateLimits))
      .catch(() => undefined)

    return done
  })

  // Pushed after each turn and whenever a window moves a whole point.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await update($, limits, () => e.rateLimits)
    return next(e)
  })

  on('command.run', { command: 'session-manager' }, openPane)
  on('command.run', { command: 'sessions' }, ($, e, next) => (ownsSessions ? openPane($) : next(e)))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const rows = await read($, sessions)
    const alive = await read($, live)
    const v = await read($, view)
    const me = await read($, current)
    const app = await chosenApp($)
    const { platform, apps } = await read($, host)
    const quota = await read($, limits)
    const now = await $.clock.now()
    const W = Math.max(28, (e.props.bodyColumns ?? 50) - 1)

    const q = v.query.trim().toLowerCase()
    const shown = rows.filter(row => !q || matches(row, q) || v.hits?.[row.id] !== undefined)
    if (v.hits) shown.sort((a, b) => (v.hits?.[b.id]?.hits ?? 0) - (v.hits?.[a.id]?.hits ?? 0))

    // Folders in the order of their newest session; rows keep their order within.
    const groups = new Map<string, SessionRow[]>()
    for (const row of shown.slice(0, LIMIT)) groups.set(row.cwd, [...(groups.get(row.cwd) ?? []), row])
    const folders = [...new Set(rows.map(row => row.cwd))]
    const running = rows.filter(row => alive[row.id]).length
    const mode: Mode = v.mode

    // Widths inside a bordered, padded box, and inside a card within a group.
    const inner = W - 4
    const cardInner = inner - 4
    const spread = (left: string, right: string, width: number) =>
      `${clip(left, width - cells(right) - 1)}${' '.repeat(Math.max(1, width - cells(clip(left, width - cells(right) - 1)) - cells(right)))}${right}`

    const field = (label: string, value: string, color?: string) => (
      <Text>
        <Text color="claude">{fit(label, 6)}</Text>
        <Text color={color} dimColor={!color}>{clip(value, cardInner - 6)}</Text>
      </Text>
    )

    const stamp = (ts: string) => ts.replace('T', ' ').slice(5, 16)
    const who = (role: Match['role']) => (role === 'user' ? '你' : 'Claude')

    // The query lit up wherever it falls in a text.
    const lit = (text: string) => {
      const needle = v.query.trim().toLowerCase()
      if (!needle || !v.hits) return text
      const out: (string | ReturnType<typeof Text>)[] = []
      let from = 0
      for (let i = text.toLowerCase().indexOf(needle); i >= 0; i = text.toLowerCase().indexOf(needle, i + needle.length)) {
        out.push(text.slice(from, i))
        out.push(<Text color="warning" bold>{text.slice(i, i + needle.length)}</Text>)
        from = i + needle.length
      }
      out.push(text.slice(from))
      return out
    }

    const matchList = (row: SessionRow, hit: ContentHit) => {
      const all = hit.matches ?? []
      const list = v.allMatches ? all : all.slice(0, SHOWN_MATCHES)
      return (
        <Box flexDirection="column">
          <Text>
            <Text color="claude">{fit('命中', 6)}</Text>
            <Text color="warning">{`${hit.hits} 處`}</Text>
            <Text dimColor>{all.length < hit.hits ? `（列出前 ${all.length} 處）` : ''} · 點一處看前後對話</Text>
          </Text>
          {all.length === 0 && <Text dimColor>{clip(hit.snippet, cardInner)}</Text>}
          {list.map((m, i) => {
            const isOn = v.preview?.id === row.id && v.preview.at === i
            const head = `${isOn ? '▸' : ' '} ${fit(who(m.role), 6)} ${stamp(m.ts)}  `
            return (
              <Button key={`m-${row.id}-${i}`} plain onPress={() => attempt($, '預覽', () => showPreview($, row, i))}>
                <Text color={isOn ? 'claude' : m.role === 'user' ? 'claude' : 'success'} bold={isOn}>{head}</Text>
                <Text dimColor={!isOn}>{lit(clip(m.snippet, cardInner - cells(head)))}</Text>
              </Button>
            )
          })}
          {all.length > SHOWN_MATCHES && (
            <Button key={`more-${row.id}`} plain dimColor label={v.allMatches ? '  ▴ 收起' : `  ▾ 再列 ${all.length - SHOWN_MATCHES} 處`}
              onPress={() => void setView($, { allMatches: !v.allMatches })} />
          )}
        </Box>
      )
    }

    const previewBox = (row: SessionRow, p: Preview) => {
      const count = v.hits?.[row.id]?.matches?.length ?? 0
      const title = p.at >= 0 ? `預覽 · 第 ${p.at + 1}/${count} 處` : `預覽 · 最後 ${p.messages.length} 則（共 ${p.total} 則）`
      const width = cardInner - 4
      return (
        <Box flexDirection="column" borderStyle="single" borderColor="subtle" paddingX={1}>
          <Text bold color="claude">{title}</Text>
          {p.messages.map((m, i) => (
            <Box key={`pm-${i}`} flexDirection="column" marginTop={i ? 1 : 0}>
              <Text>
                <Text bold color={m.role === 'user' ? 'claude' : 'success'}>{who(m.role)}</Text>
                <Text dimColor>{`  ${stamp(m.ts)}`}</Text>
                {m.isHit && <Text color="warning">{'  ◀ 命中'}</Text>}
              </Text>
              <Text wrap="wrap" dimColor={!m.isHit}>{lit(clip(m.text, m.isHit ? width * 8 : width * 3))}</Text>
            </Box>
          ))}
          <Text color="subtle">{'┄'.repeat(width)}</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {p.at > 0 && <Button key="prev-match" label="↑ 上一處" hotkey="k" onPress={() => attempt($, '預覽', () => showPreview($, row, p.at - 1))} />}
            {p.at >= 0 && p.at < count - 1 && <Button key="next-match" label="↓ 下一處" hotkey="j" onPress={() => attempt($, '預覽', () => showPreview($, row, p.at + 1))} />}
            <Button key="more-context" label="多看幾則" hotkey="m" onPress={() => attempt($, '預覽', () => showPreview($, row, p.at, p.radius + 3))} />
            <Button key="close-preview" label="收起" hotkey="z" onPress={() => void setView($, { preview: null })} />
          </Box>
        </Box>
      )
    }

    const card = (row: SessionRow) => {
      const info = alive[row.id]
      const isMe = row.id === me
      const hit = v.hits?.[row.id]
      const state = info
        ? `● ${info.status === 'busy' ? '工作中' : '開著'} · ${info.app || '?'} ${info.tty.replace('/dev/', '')}${info.kind === 'bg' ? ' · 背景' : ''}`
        : '○ 已關閉'
      return (
        <Box key={`card-${row.id}`} flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          {field('狀態', isMe ? `◆ 就是這個 session` : state, isMe ? 'claude' : info ? 'success' : undefined)}
          {field('分支', `${row.branch || '-'}   ${row.prompts} prompts   ${sizeOf(row.size)}`)}
          {field('建立', row.started.replace('T', ' ').slice(0, 16))}
          {field('ID', row.id)}
          <Text color="subtle">{'┄'.repeat(cardInner)}</Text>
          {field('首句', row.firstPrompt || '-', 'text')}
          {row.lastPrompt !== row.firstPrompt && field('末句', row.lastPrompt || '-', 'text')}
          {hit && matchList(row, hit)}
          {v.preview?.id === row.id && previewBox(row, v.preview)}
          <Text color="subtle">{'┄'.repeat(cardInner)}</Text>
          {mode?.kind === 'rename' && mode.id === row.id && Input ? (
            <Box flexDirection="column">
              <Input key={`rename-${row.id}`} label="新名稱 " value={row.title} autoFocus submitLabel="改名"
                onInput={() => {}} onSubmit={(value: string) => attempt($, '改名', () => rename($, row, value))} />
              <Button key="cancel" label="取消" hotkey="q" plain onPress={() => void setView($, { mode: null })} />
            </Box>
          ) : mode?.kind === 'delete' && mode.id === row.id ? (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text color="error">移到垃圾桶？</Text>
              <Button key="confirm" label="確定刪除" hotkey="y" variant="primary" onPress={() => attempt($, '刪除', () => remove($, row))} />
              <Button key="cancel" label="取消" hotkey="q" onPress={() => void setView($, { mode: null })} />
            </Box>
          ) : (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {!isMe && (
                <Button key={`jump-${row.id}`} label={info?.kind === 'bg' ? '打開' : info ? '跳過去' : 'Resume'} hotkey="t" variant="primary"
                  onPress={() => attempt($, info ? '切換' : 'Resume', () => jump($, row))} />
              )}
              {v.preview?.id !== row.id && (
                <Button key={`peek-${row.id}`} label="預覽對話" hotkey="p" onPress={() => attempt($, '預覽', () => showPreview($, row, -1))} />
              )}
              <Button key={`rename-btn-${row.id}`} label="改名" hotkey="e"
                onPress={() => void setView($, { mode: { kind: 'rename', id: row.id } })} />
              <Button key={`copy-${row.id}`} label="複製指令" hotkey="c"
                onPress={() =>
                  void $.ui.copy({ text: resumeCommand(row, platform) })
                    .then(r => say($, r.isCopied ? '已複製 resume 指令' : '複製失敗'))
                } />
              {!info && (
                <Button key={`del-${row.id}`} label="刪除" hotkey="d"
                  onPress={() => void setView($, { mode: { kind: 'delete', id: row.id } })} />
              )}
            </Box>
          )}
        </Box>
      )
    }

    // One row per rate-limit window: what is left of it, as a bar, and when it resets.
    const quotaRow = (limit: Limit) => {
      const left = Math.max(0, Math.round((100 - limit.percentUsed) * 10) / 10)
      const color = left < 20 ? 'error' : left < 50 ? 'warning' : 'success'
      const pct = ` 剩 ${left}%`.padStart(8)
      const reset = until(limit.resetsAt, now)
      const resetText = reset ? `${reset} 後重置`.padStart(13) : ''
      const barWidth = Math.max(4, inner - 6 - cells(pct) - cells(resetText))
      const filled = Math.round((barWidth * left) / 100)
      return (
        <Text key={`quota-${limit.kind}`}>
          <Text color="claude">{fit(LIMIT_NAMES[limit.kind] ?? limit.kind, 6)}</Text>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text color="subtle">{'░'.repeat(barWidth - filled)}</Text>
          <Text color={color}>{pct}</Text>
          <Text dimColor>{resetText}</Text>
        </Text>
      )
    }

    const status = v.busy ?? v.note ?? (q ? `符合 ${shown.length} 個` : '')

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text>
            <Text bold color="claude">SESSIONS</Text>
            <Text dimColor>{spread('', `${rows.length} sessions · ${folders.length} 資料夾 · `, inner - 8 - cells(`${running} 開著`))}</Text>
            <Text color="success">{`${running} 開著`}</Text>
          </Text>
          {quota.length > 0
            ? quota.map(quotaRow)
            : <Text dimColor>{clip('額度：訂閱帳號送出第一則訊息後顯示', inner)}</Text>}
          {Input && (
            <Input key="query" placeholder="搜 title／資料夾／prompt · Enter 搜內文" submitLabel="搜內文" value={v.query}
              onInput={(value: string) => void setView($, { query: value, hits: null, note: null })}
              onSubmit={(value: string) => void searchContent($, value)} />
          )}
          <Text color="subtle">{'─'.repeat(inner)}</Text>
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            <Button key="new" label="+ 新增" hotkey="n" plain
              onPress={() => void setView($, { mode: mode?.kind === 'new' ? null : { kind: 'new', dir: tilde(rows.find(r => r.id === v.selected)?.cwd ?? folders[0] ?? '~') } })} />
            <Button key="refresh" label="↻ 重新整理" hotkey="r" plain onPress={() => void refresh($)} />
            {apps.length > 1 ? (
              <Button key="app" label={`⇢ ${app}`} hotkey="a" plain onPress={() => void cycleApp($)} />
            ) : (
              <Text dimColor>{`⇢ ${app}`}</Text>
            )}
            {v.query && <Button key="clear" label="✕ 清除" hotkey="x" plain onPress={() => void setView($, { query: '', hits: null, note: null })} />}
          </Box>
          {status && <Text color={v.busy ? 'warning' : 'subtle'}>{clip(status, inner)}</Text>}
        </Box>

        {mode?.kind === 'new' && (
          <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
            <Text bold color="claude">新 SESSION</Text>
            {Input && (
              <Input key="newdir" label="資料夾 " value={mode.dir} submitLabel="開始"
                onInput={(value: string) => void setView($, { mode: { kind: 'new', dir: value } })}
                onSubmit={(value: string) => attempt($, '開新 session', () => startNew($, value))} />
            )}
            <Text color="subtle">{'┄'.repeat(inner)}</Text>
            <Text dimColor>最近的資料夾</Text>
            {folders.slice(0, 6).map((dir, i) => (
              <Button key={`dir-${i}`} plain onPress={() => void setView($, { mode: { kind: 'new', dir: tilde(dir) } })}>
                <Text color={tilde(dir) === mode.dir ? 'claude' : undefined}>{tilde(dir) === mode.dir ? '▸ ' : '  '}</Text>
                <Text dimColor={tilde(dir) !== mode.dir}>{clip(tilde(dir), inner - 2)}</Text>
              </Button>
            ))}
            <Text color="subtle">{'┄'.repeat(inner)}</Text>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="start" label={`在 ${app} 開始`} hotkey="s" variant="primary" onPress={() => attempt($, '開新 session', () => startNew($, mode.dir))} />
              <Button key="browse" label="瀏覽…" hotkey="b"
                onPress={() => attempt($, '瀏覽', () => pickDir($))} />
              <Button key="cancel-new" label="取消" hotkey="q" onPress={() => void setView($, { mode: null })} />
            </Box>
          </Box>
        )}

        {rows.length === 0 && !v.busy && <Text dimColor>這台機器上還沒有 session。</Text>}

        {[...groups].map(([dir, list]) => (
          <Box key={`group-${dir}`} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text>
              <Text color="claude">▌ </Text>
              <Text bold>{fit(tilde(dir), inner - 2 - 6)}</Text>
              <Text dimColor>{`${list.length} 個`.padStart(6)}</Text>
            </Text>
            <Text color="subtle">{'─'.repeat(inner)}</Text>
            {list.map(row => {
              const info = alive[row.id]
              const isOpen = v.selected === row.id
              const isMe = row.id === me
              const hit = v.hits?.[row.id]
              const tail = hit ? `${hit.hits} 處` : age(now - row.updated)
              return (
                <Box key={`item-${row.id}`} flexDirection="column">
                  <Button key={`row-${row.id}`} plain
                    onPress={() => void setView($, { selected: isOpen ? null : row.id, mode: null, preview: null, allMatches: false })}>
                    <Text color={isMe ? 'claude' : info ? 'success' : 'subtle'}>{isMe ? '◆ ' : info ? '● ' : '○ '}</Text>
                    <Text bold={isOpen} color={isOpen ? 'claude' : undefined}>{fit(row.title, inner - 2 - 7)}</Text>
                    <Text dimColor>{fit(tail.padStart(7), 7)}</Text>
                  </Button>
                  {hit && !isOpen && <Text dimColor>{`  ↳ ${clip(hit.snippet, inner - 4)}`}</Text>}
                  {isOpen && card(row)}
                </Box>
              )
            })}
          </Box>
        ))}
        {shown.length > LIMIT && <Text dimColor>{`還有 ${shown.length - LIMIT} 個，用搜尋縮小範圍`}</Text>}
        <Text dimColor>{' ◆ 這個 session   ● 開著   ○ 已關閉'}</Text>
      </Box>
    )
  })
}
