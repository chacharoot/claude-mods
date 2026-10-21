import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContentHit, LiveInfo, Mode, SessionRow, View } from '../types'
import { SCANNER } from './scanner'

const PANE = 'session-manager'
const TITLE = 'Sessions'
const PROJECTS = '~/.claude/projects'
const CACHE = '~/.claude/session-manager/index.json'
const APPS = ['Warp', 'iTerm', 'Terminal']
const LIMIT = 80
const POLL_MS = 20_000

const EMPTY: View = { query: '', hits: null, selected: null, mode: null, busy: null, note: null }
const sessions = atom({ plugin: 'session-manager', key: 'sessions' } as const, [])
const live = atom({ plugin: 'session-manager', key: 'live' } as const, {})
const view = atom({ plugin: 'session-manager', key: 'view' } as const, EMPTY)
const current = atom({ plugin: 'session-manager', key: 'current' } as const, '')
const appPref = atom({ plugin: 'session-manager', key: 'app' } as const, '')

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

const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, '~')

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

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const resumeCommand = (row: SessionRow) => `cd ${shq(row.cwd)} && claude --resume ${row.id}`

type Done = { ok: boolean; msg?: string; path?: string }

async function python<T>($: EngineInterface, args: string[]): Promise<T> {
  const ran = await $.process.run(['python3', '-I', '-', ...args], {
    stdin: SCANNER,
    timeoutMs: 120_000,
  })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n').pop() || 'scan failed')
  return JSON.parse(ran.stdout) as T
}

async function setView($: EngineInterface, patch: Partial<View>) {
  await update($, view, v => ({ ...v, ...patch }))
}
const say = ($: EngineInterface, note: string) => setView($, { busy: null, note })

async function refresh($: EngineInterface, quiet = false) {
  if (!quiet) await setView($, { busy: '索引中…', note: null })
  try {
    const found = await python<{ rows: SessionRow[]; live: Record<string, LiveInfo> }>($, [
      'index',
      PROJECTS,
      CACHE,
    ])
    await update($, sessions, () => found.rows)
    await update($, live, () => found.live)
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
      note: `內文命中 ${found.length} 個 session`,
    })
  } catch (err) {
    await say($, `搜尋失敗：${String(err)}`)
  }
}

async function chosenApp($: EngineInterface) {
  const pref = await read($, appPref)
  if (pref) return pref
  const me = (await read($, live))[await read($, current)]
  return me?.app || 'Terminal'
}

async function cycleApp($: EngineInterface) {
  const now = await chosenApp($)
  const next = APPS[(APPS.indexOf(now) + 1) % APPS.length] ?? 'Terminal'
  await update($, appPref, () => next)
  await $.store.set('app', next)
}

// A live session is brought to front; any other is resumed in a new window.
async function jump($: EngineInterface, row: SessionRow) {
  const info = (await read($, live))[row.id]
  if (info) {
    const app = info.app || (await chosenApp($))
    const done = await python<Done>($, ['focus', app, info.tty])
    const where = info.name ? `分頁「${info.name}」` : info.tty
    return say($, done.ok && done.msg !== 'app-only'
      ? `已切到 ${app} 的 ${where}`
      : `已叫出 ${app}，它在 ${where}（${app} 不支援直接選分頁）`)
  }
  const app = await chosenApp($)
  await setView($, { busy: `在 ${app} 開啟…` })
  const done = await python<Done>($, ['open', app, row.cwd, `claude --resume ${row.id}`])
  await say($, done.ok ? `已在 ${app} resume「${clip(row.title, 24)}」` : `${app} 開啟失敗：${done.msg}`)
  $.clock.after(4000, () => void refresh($, true))
}

async function startNew($: EngineInterface, dir: string) {
  const path = dir.trim().replace(/^~(?=\/|$)/, (await $.process.run(['sh', '-c', 'printf %s "$HOME"'])).stdout)
  if (!path || !(await $.fs.exists(path))) return say($, `找不到資料夾：${dir}`)
  const app = await chosenApp($)
  const done = await python<Done>($, ['open', app, path, 'claude'])
  await setView($, { mode: null })
  await say($, done.ok ? `已在 ${app} 的 ${tilde(path)} 開新 session` : `${app} 開啟失敗：${done.msg}`)
  $.clock.after(6000, () => void refresh($, true))
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const done = await next(e)
    await $.command.register({
      name: 'sessions',
      description: 'Browse, search, resume, rename, start and delete Claude Code sessions on this machine',
    })
    const stored = await $.store.get('app').catch(() => undefined)
    await update($, appPref, () => (typeof stored === 'string' ? stored : ''))
    void $.session.id().then(id => update($, current, () => id))
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    $.clock.every(POLL_MS, () => void refresh($, true))

    return done
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    void refresh($)

    return { text: 'Sessions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const rows = await read($, sessions)
    const alive = await read($, live)
    const v = await read($, view)
    const me = await read($, current)
    const app = await chosenApp($)
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

    const card = (row: SessionRow) => {
      const info = alive[row.id]
      const isMe = row.id === me
      const hit = v.hits?.[row.id]
      const inner = W - 4
      return (
        <Box key={`card-${row.id}`} flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text>
            {info ? <Text color="success">● {info.status === 'busy' ? '工作中' : '開著'}</Text> : <Text dimColor>○ 未開啟</Text>}
            <Text dimColor>
              {info ? ` · ${info.app || '?'} · ${info.tty.replace('/dev/', '')}${info.kind === 'bg' ? ' · 背景' : ''}` : ''}
              {isMe ? ' · 就是這個 session' : ''}
            </Text>
          </Text>
          <Text dimColor>{clip(`${row.branch || '-'} · ${row.prompts} prompts · ${sizeOf(row.size)} · ${row.started.replace('T', ' ').slice(0, 16)}`, inner)}</Text>
          <Text dimColor>{clip(row.id, inner)}</Text>
          <Text>
            <Text color="claude">首 </Text>
            {clip(row.firstPrompt || '-', inner * 2 - 3)}
          </Text>
          {row.lastPrompt !== row.firstPrompt && (
            <Text>
              <Text color="claude">末 </Text>
              {clip(row.lastPrompt || '-', inner * 2 - 3)}
            </Text>
          )}
          {hit && (
            <Text>
              <Text color="claude">搜 </Text>
              <Text dimColor>{clip(hit.snippet, inner * 2 - 3)}</Text>
            </Text>
          )}
          {mode?.kind === 'rename' && mode.id === row.id && Input ? (
            <Box flexDirection="column" marginTop={1}>
              <Input key={`rename-${row.id}`} label="新名稱 " value={row.title} autoFocus submitLabel="改名"
                onInput={() => {}} onSubmit={(value: string) => void rename($, row, value)} />
              <Button key="cancel" label="取消" hotkey="q" plain onPress={() => void setView($, { mode: null })} />
            </Box>
          ) : mode?.kind === 'delete' && mode.id === row.id ? (
            <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
              <Text color="error">移到垃圾桶？</Text>
              <Button key="confirm" label="確定刪除" hotkey="y" variant="primary" onPress={() => void remove($, row)} />
              <Button key="cancel" label="取消" hotkey="q" onPress={() => void setView($, { mode: null })} />
            </Box>
          ) : (
            <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
              {!isMe && (
                <Button key={`jump-${row.id}`} label={info ? '跳過去' : `Resume`} hotkey="t" variant="primary"
                  onPress={() => void jump($, row)} />
              )}
              <Button key={`rename-btn-${row.id}`} label="改名" hotkey="e"
                onPress={() => void setView($, { mode: { kind: 'rename', id: row.id } })} />
              <Button key={`copy-${row.id}`} label="複製指令" hotkey="c"
                onPress={() =>
                  void $.ui.copy({ text: resumeCommand(row) })
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

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text bold color="claude">SESSIONS</Text>
            <Text dimColor>{`  ${rows.length} · ${folders.length} 資料夾 · `}</Text>
            <Text color="success">{`${running} 開著`}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="new" label="+ 新增" hotkey="n" plain
              onPress={() => void setView($, { mode: mode?.kind === 'new' ? null : { kind: 'new', dir: tilde(rows.find(r => r.id === v.selected)?.cwd ?? folders[0] ?? '~') } })} />
            <Button key="refresh" label="↻" hotkey="r" plain onPress={() => void refresh($)} />
          </Box>
        </Box>

        {mode?.kind === 'new' && (
          <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
            <Text bold>新 session</Text>
            {Input && (
              <Input key="newdir" label="資料夾 " value={mode.dir} autoFocus submitLabel="開始"
                onInput={(value: string) => void setView($, { mode: { kind: 'new', dir: value } })}
                onSubmit={(value: string) => void startNew($, value)} />
            )}
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {folders.slice(0, 6).map((dir, i) => (
                <Button key={`dir-${i}`} label={clip(tilde(dir), 32)} plain dimColor={tilde(dir) !== mode.dir}
                  onPress={() => void setView($, { mode: { kind: 'new', dir: tilde(dir) } })} />
              ))}
            </Box>
            <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
              <Button key="start" label={`在 ${app} 開始`} hotkey="s" variant="primary" onPress={() => void startNew($, mode.dir)} />
              <Button key="browse" label="瀏覽…" hotkey="b"
                onPress={() =>
                  void python<Done>($, ['pickdir']).then(done =>
                    done.ok && done.path ? setView($, { mode: { kind: 'new', dir: tilde(done.path) } }) : undefined)
                } />
              <Button key="cancel-new" label="取消" hotkey="q" onPress={() => void setView($, { mode: null })} />
            </Box>
          </Box>
        )}

        {Input && (
          <Input key="query" placeholder="搜 title／資料夾／prompt · Enter 搜內文" submitLabel="搜內文" value={v.query}
            onInput={(value: string) => void setView($, { query: value, hits: null, note: null })}
            onSubmit={(value: string) => void searchContent($, value)} />
        )}

        <Box flexDirection="row" justifyContent="space-between">
          <Text color={v.busy ? 'warning' : 'subtle'}>{clip(v.busy ?? v.note ?? (q ? `符合 ${shown.length} 個` : ' '), W - 18)}</Text>
          <Box flexDirection="row" gap={1}>
            {v.query && <Button key="clear" label="清除" hotkey="x" plain onPress={() => void setView($, { query: '', hits: null, note: null })} />}
            <Button key="app" label={`開啟用 ${app}`} hotkey="a" plain dimColor onPress={() => void cycleApp($)} />
          </Box>
        </Box>

        {rows.length === 0 && !v.busy && <Text dimColor>這台機器上還沒有 session。</Text>}

        {[...groups].map(([dir, list]) => (
          <Box key={`group-${dir}`} flexDirection="column" marginTop={1}>
            <Text>
              <Text color="claude">▌</Text>
              <Text bold>{` ${clip(tilde(dir), W - 8)}`}</Text>
              <Text dimColor>{`  ${list.length}`}</Text>
            </Text>
            {list.map(row => {
              const info = alive[row.id]
              const isOpen = v.selected === row.id
              const isMe = row.id === me
              const hit = v.hits?.[row.id]
              const tail = hit ? `${hit.hits}×` : age(now - row.updated)
              return (
                <Box key={`item-${row.id}`} flexDirection="column">
                  <Button key={`row-${row.id}`} plain
                    onPress={() => void setView($, { selected: isOpen ? null : row.id, mode: null })}>
                    <Text color={isMe ? 'claude' : info ? 'success' : 'subtle'}>{isMe ? ' ◆ ' : info ? ' ● ' : ' · '}</Text>
                    <Text bold={isOpen} color={isOpen ? 'claude' : undefined}>{fit(row.title, W - 9)}</Text>
                    <Text dimColor>{tail.padStart(5)}</Text>
                  </Button>
                  {hit && !isOpen && <Text dimColor>{`   ↳ ${clip(hit.snippet, W - 6)}`}</Text>}
                  {isOpen && card(row)}
                </Box>
              )
            })}
          </Box>
        ))}
        {shown.length > LIMIT && <Text dimColor>{`還有 ${shown.length - LIMIT} 個，用搜尋縮小範圍`}</Text>}
        <Text dimColor>{' '}</Text>
        <Text dimColor>◆ 這個 session  ● 開著  · 已關閉</Text>
      </Box>
    )
  })
}
