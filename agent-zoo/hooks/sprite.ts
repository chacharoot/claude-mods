// A shaded little robot drawn per pixel, two pixels to a terminal cell: the
// upper half block takes the top pixel as its foreground and the bottom one
// as its background, so a robot `size` px across is a size x size/2 Raster.
// Drawn at 18 px (big) or 10 px (small, the default): the body scales, the
// face has a pattern of its own per size.
import type { AgentCard } from '../types'

export const SIZES = { small: 10, big: 18 } as const
export type Size = keyof typeof SIZES
export const spriteCols = (size: Size) => SIZES[size]
export const spriteRows = (size: Size) => SIZES[size] / 2
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

// Eyes on a grid of their own per size: w white, k ink.
const EYES: Record<Size, Record<Status, string[]>> = {
  big: {
    running: ['.ww', '.wk', '...'],
    waiting: ['...', 'kkk', '...'],
    done: ['.k.', 'k.k', '...'],
    failed: ['k.k', '.k.', 'k.k'],
    killed: ['...', 'kkk', '...'],
  },
  small: {
    running: ['w', 'k'],
    waiting: ['.', 'k'],
    done: ['k', '.'],
    failed: ['k', 'k'],
    killed: ['.', 'k'],
  },
}

// Where the parts sit at each size: body centre and radius, ground row and shadow half-width,
// feet (spread, and their drop below the body when down and when lifted), eyes and mouth.
type Geom = { cx: number; cy: number; r: number; ground: number; shadow: number; feet: number; down: number; up: number; eyes: number[]; eyeDy: number; mouthDy: number }
const GEOM: Record<Size, Geom> = {
  big: { cx: 8.5, cy: 8.5, r: 6.3, ground: 17, shadow: 5, feet: 2.5, down: 0.4, up: -0.6, eyes: [-3.5, 1.5], eyeDy: -1, mouthDy: 4 },
  small: { cx: 4.5, cy: 5, r: 3.1, ground: 9, shadow: 3, feet: 1.5, down: -0.1, up: -1.1, eyes: [-1.5, 1.5], eyeDy: -1, mouthDy: 2 },
}

export function critter(type: string, status: Status, frame: number, size: Size = 'small'): string {
  const W = SIZES[size]
  const H = W
  const g = GEOM[size]
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
  const cx = g.cx
  const cy = g.cy + bob
  const r = g.r

  // Ground shadow, narrower while the body is up.
  const sw = bob < 0 ? g.shadow - 1 : g.shadow
  for (let x = cx - sw; x <= cx + sw; x++) set(x, g.ground, SHADOW)

  // Feet, stepping while running.
  const lift = status === 'running' ? frame % 2 : -1
  for (const [i, fx] of [cx - g.feet, cx + g.feet].entries()) {
    const fy = cy + r + (lift === i ? g.up : g.down)
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
  // Kept on the canvas when a hop lifts the body to its top row.
  set(cx, Math.max(0, top - 1), status === 'running' && frame % 2 ? off : on)

  // Face: eyes by status, looking around while running.
  const ey = Math.round(cy + g.eyeDy)
  const look = status === 'running' ? [0, 1, 0, -1][Math.floor(frame / 2) % 4]! : 0
  // The big pupil sits right of centre in its grid; the small one is the grid.
  const pupil = size === 'big' ? look - 1 : look
  for (const ex of g.eyes.map(dx => Math.round(cx + dx))) {
    EYES[size][status].forEach((line, dy) =>
      [...line].forEach((ch, dx) => {
        const x = ex + dx + (ch === 'k' && status === 'running' ? pupil : 0)
        if (ch === 'w') set(x, ey + dy, WHITE)
        if (ch === 'k') set(x, ey + dy, INK)
      }),
    )
  }
  // A mouth: a grin when done, a flat line when failed.
  const my = ey + g.mouthDy
  const grin = size === 'big' ? ['k...k', '.kkk.'] : ['.kk.']
  if (status === 'done') grin.forEach((line, dy) => [...line].forEach((ch, dx) => ch === 'k' && set(cx - (line.length - 1) / 2 + dx, my + dy - grin.length + 1, INK)))
  if (status === 'failed') for (let dx = size === 'big' ? -1 : -0.5; dx <= (size === 'big' ? 1 : 0.5); dx++) set(cx + dx, my, INK)

  const cols = spriteCols(size)
  const rows = spriteRows(size)
  const words = new Uint32Array(cols * rows * 3)
  for (let row = 0; row < rows; row++) {
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
