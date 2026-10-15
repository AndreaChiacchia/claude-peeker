// The Raster's cells: colors as numbers, blending, the cell encoding.

/** The terminal's default color, as a Raster cell holds it (bit 24 alone). */
export const DEFAULT = 0x01000000

/** The empty cell and frame color: the same gray as `line.ts` GRAY (#585858), hard-coded to keep this file free of imports. */
export const TRACK = 0x585858
/** The warm white-gold of a rise's glint. */
export const GLINT_UP = 0xfff5d7
/** The ice cyan of a fall's glint. */
export const GLINT_DOWN = 0x5fd7ff
/** The badge color of the Subtle level. */
export const PLAIN = 0x8a8a8a
/** The working dot's lavender: the cell twin of `line.ts` LAVENDER. */
export const LIVE = 0xafafd7
/** The red the dot pulses toward when ctx crosses 80%. */
export const HOT = 0xff0000

/** Glyph code points, all narrow BMP characters. */
export const SPARK_FULL = 0x2726 // ✦
export const SPARK_HOLLOW = 0x2727 // ✧
export const COMPACT_MARK = 0x21bb // ↻
export const MINUS = 0x2212 // −
export const DOT_FULL = 0x25cf // ●
export const DOT_EMPTY = 0x25cb // ○

/** `#rrggbb` as the number `0xRRGGBB`. */
export function rgb(hex: string): number {
  return parseInt(hex.replace('#', ''), 16)
}

/** `color` moved `amount` (0..1) toward white, per channel; the terminal default stays as it is. */
export function lighten(color: number, amount: number): number {
  if (color === DEFAULT) return DEFAULT
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  const up = (c: number): number => Math.round(c + (255 - c) * amount)

  return (up(r) << 16) | (up(g) << 8) | up(b)
}

/** `a` blended into `b` by `t` (0..1), per channel. A side that is the terminal default cannot blend: it switches at the half. */
export function mixColor(a: number, b: number, t: number): number {
  if (a === DEFAULT || b === DEFAULT) return t < 0.5 ? a : b
  const mix = (shift: number): number => {
    const ca = (a >> shift) & 0xff
    const cb = (b >> shift) & 0xff

    return Math.round(ca + (cb - ca) * t)
  }

  return (mix(16) << 16) | (mix(8) << 8) | mix(0)
}

export type Cell = { cp: number; fg: number; bg: number }

const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6)

const isZeroWidth = (cp: number): boolean => (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f)

const isUnsafe = (cp: number): boolean =>
  cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp > 0xffff || isZeroWidth(cp) || isWide(cp)

/** A code point a Raster takes; anything it would refuse (control, wide, zero-width, beyond the BMP) becomes `?`. */
export function safeCp(cp: number): number {
  return isUnsafe(cp) ? 0x3f : cp
}

/** One cell per code point of `text`, each through `safeCp`. */
export function textCells(text: string, fg: number, bg: number = DEFAULT): Cell[] {
  const cells: Cell[] = []
  for (const ch of text) {
    cells.push({ cp: safeCp(ch.codePointAt(0) ?? 0x3f), fg, bg })
  }

  return cells
}

/** The Raster's `cells` prop: little-endian u32 triplets [code point, foreground, background], in base64. */
export function encodeCells(cells: Cell[]): string {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach((cell, i) => {
    words[i * 3] = cell.cp
    words[i * 3 + 1] = cell.fg
    words[i * 3 + 2] = cell.bg
  })
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

/** The inverse of `encodeCells`. */
export function decodeCells(b64: string): Cell[] {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const words = new Uint32Array(bytes.buffer)
  const cells: Cell[] = []
  for (let i = 0; i + 2 < words.length; i += 3) {
    cells.push({ cp: words[i] ?? 0, fg: words[i + 1] ?? 0, bg: words[i + 2] ?? 0 })
  }

  return cells
}
