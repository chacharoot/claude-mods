// A shaded little robot drawn per pixel, two pixels to a terminal cell: the
// upper half block takes the top pixel as its foreground and the bottom one
// as its background, so a SPRITE_COLS x SPRITE_ROWS Raster holds 18 x 18 px.
import type { AgentCard } from '../types'

export const SPRITE_COLS = 18
export const SPRITE_ROWS = 9
const W = SPRITE_COLS
const H = SPRITE_ROWS * 2
const DEFAULT = 0x01000000
const UPPER = 0x2580
const LOWER = 0x2584

type Rgb = [number, number, number]
type Status = AgentCard['status']

// Body colour per agent type; anything else gets the slate one.
const BODY: Record<string, Rgb> = {
  Explore: [46, 196, 182],
  Plan: [155, 93, 229],
  'general-purpose': [244, 162, 97],
  fork: [241, 91, 181],
  'claude-code-guide': [76, 141, 246],
}
const SLATE: Rgb = [120, 144, 170]

export const bodyColor = (type: string): Rgb => BODY[type] ?? SLATE
export const hex = ([r, g, b]: Rgb) => `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`

const pack = ([r, g, b]: Rgb) => (clamp(r) << 16) | (clamp(g) << 8) | clamp(b)
const clamp = (c: number) => Math.max(0, Math.min(255, Math.round(c)))
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const scale = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k]

const WHITE: Rgb = [255, 255, 255]
const INK: Rgb = [24, 26, 40]
const SHADOW: Rgb = [48, 50, 60]
const GLOW: Record<Status, [Rgb, Rgb]> = {
  running: [[255, 214, 90], [150, 110, 40]],
  waiting: [[120, 130, 150], [90, 96, 110]],
  done: [[110, 231, 140], [110, 231, 140]],
  failed: [[255, 90, 90], [140, 40, 40]],
  killed: [[110, 110, 110], [110, 110, 110]],
}

// Light from the upper left, toward the viewer.
const L = (() => {
  const v = [-0.5, -0.65, 0.58]
  const n = Math.hypot(...v)
  return v.map(c => c / n) as [number, number, number]
})()

export function critter(type: string, status: Status, frame: number): string {
  const px: (Rgb | null)[] = new Array(W * H).fill(null)
  const set = (x: number, y: number, c: Rgb) => {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi >= 0 && xi < W && yi >= 0 && yi < H) px[yi * W + xi] = c
  }

  let base = bodyColor(type)
  if (status === 'killed') base = [128, 128, 128]
  if (status === 'failed') base = mix(base, [200, 70, 70], 0.55)
  if (status === 'waiting') base = scale(base, 0.8)

  const bob =
    status === 'running' ? [0, -1, 0, 0][frame % 4]! : status === 'waiting' ? [0, 0, 1, 1][frame % 4]! * 0.5 : status === 'done' ? -0.5 : 1
  const cx = 8.5
  const cy = 8.5 + bob
  const r = 6.3

  // Ground shadow, narrower while the body is up.
  const sw = bob < 0 ? 4 : 5
  for (let x = cx - sw; x <= cx + sw; x++) set(x, 17, SHADOW)

  // Feet, stepping while running.
  const lift = status === 'running' ? frame % 2 : -1
  for (const [i, fx] of [cx - 2.5, cx + 2.5].entries()) {
    const fy = cy + r + (lift === i ? -0.6 : 0.4)
    set(fx - 0.5, fy, scale(base, 0.45))
    set(fx + 0.5, fy, scale(base, 0.45))
  }

  // The body: a lit sphere with a specular spot and a dark rim.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5 - (cx + 0.5)) / r
      const dy = (y + 0.5 - (cy + 0.5)) / r
      const d2 = dx * dx + dy * dy
      if (d2 > 1) continue
      const nz = Math.sqrt(1 - d2)
      const diff = Math.max(0, dx * L[0] + dy * L[1] + nz * L[2])
      const spec = Math.pow(diff, 14) * 0.75
      const rim = d2 > 0.78 ? 0.75 : 1
      px[y * W + x] = mix(scale(base, (0.28 + 0.72 * diff) * rim), WHITE, spec)
    }
  }

  // Antenna with a tip that pulses while running.
  const top = cy - r - 0.5
  set(cx, top, scale(base, 0.55))
  const [on, off] = GLOW[status]
  set(cx, top - 1, status === 'running' && frame % 2 ? off : on)

  // Face: eyes by status on a 3x3 grid each, looking around while running.
  const ey = Math.round(cy - 1)
  const look = status === 'running' ? [0, 1, 0, -1][Math.floor(frame / 2) % 4]! : 0
  const EYES: Record<Status, string[]> = {
    running: ['.ww', '.wk', '...'],
    waiting: ['...', 'kkk', '...'],
    done: ['.k.', 'k.k', '...'],
    failed: ['k.k', '.k.', 'k.k'],
    killed: ['...', 'kkk', '...'],
  }
  for (const ex of [Math.round(cx - 3.5), Math.round(cx + 1.5)]) {
    EYES[status].forEach((line, dy) =>
      [...line].forEach((ch, dx) => {
        const x = ex + dx + (ch === 'k' && status === 'running' ? look - 1 : 0)
        if (ch === 'w') set(x, ey + dy, WHITE)
        if (ch === 'k') set(x, ey + dy, INK)
      }),
    )
  }
  // A mouth: a grin when done, a flat line when failed.
  const my = ey + 4
  if (status === 'done') ['k...k', '.kkk.'].forEach((line, dy) => [...line].forEach((ch, dx) => ch === 'k' && set(cx - 2 + dx, my + dy - 1, INK)))
  if (status === 'failed') for (let dx = -1; dx <= 1; dx++) set(cx + dx, my, INK)

  const words = new Uint32Array(SPRITE_COLS * SPRITE_ROWS * 3)
  for (let row = 0; row < SPRITE_ROWS; row++) {
    for (let x = 0; x < W; x++) {
      const hi = px[row * 2 * W + x] ?? null
      const lo = px[(row * 2 + 1) * W + x] ?? null
      const at = (row * W + x) * 3
      if (hi && lo) words.set([UPPER, pack(hi), pack(lo)], at)
      else if (hi) words.set([UPPER, pack(hi), DEFAULT], at)
      else if (lo) words.set([LOWER, pack(lo), DEFAULT], at)
      else words.set([0x20, DEFAULT, DEFAULT], at)
    }
  }
  return base64(new Uint8Array(words.buffer))
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
    out += b === undefined ? '=' : ALPHABET[(n >> 6) & 63]!
    out += c === undefined ? '=' : ALPHABET[n & 63]!
  }
  return out
}
