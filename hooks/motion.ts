// The bars' motion: what changed, the effects it started, and each frame of a bar as cells.

import type { BarId, BarPref, Motion } from '../types'
import {
  COMPACT_MARK,
  DEFAULT,
  GLINT_DOWN,
  GLINT_UP,
  MINUS,
  PLAIN,
  SPARK_FULL,
  SPARK_HOLLOW,
  TRACK,
  lighten,
  mixColor,
  rgb,
  safeCp,
  textCells,
} from './cells'
import type { Cell } from './cells'
import { formatTokens, tone } from './format'
import { TONES } from './line'
import { drawBar, styleOf } from './styles'
import type { BarPart } from './styles'

/** One frame, in milliseconds: 20 frames a second. */
export const FRAME_MS = 50
/** One glint pass (0.6 s). */
export const GLINT_FRAMES = 12
/** A change of at least this many points glints twice (Lively only). */
export const BIG_STEP = 5
/** Fill growth (0.4 s). */
export const GROW_FRAMES = 8
/** Fill color blend (0.4 s). */
export const COLOR_FRAMES = 8
/** The figure rolls one step every this many frames. */
export const ROLL_EVERY = 2
/** Changed digits stay flashed this long after each roll step. */
export const FLASH_FRAMES = 6
/** Vacated cells fade to the track color (0.4 s). */
export const DRAIN_FRAMES = 8
/** Compaction sparkle drain: frames between neighbouring cells. */
export const SPARK_STRIDE = 2
/** One pulse, frame by frame. */
export const PULSE_PROFILE: readonly number[] = [0.2, 0.6, 1, 1, 0.6, 0.2]
/** Pulses per level-up or reset flash. */
export const PULSE_COUNT = 3
/** The compaction / reset badge stays this long (2 s). */
export const BADGE_FRAMES = 40
/** A ctx drop of at least this many points is a compaction. */
export const COMPACT_DROP = 20
/** A rate window's reset time moving later by more than this (10 min) is a new window. */
export const RESET_SHIFT_MS = 600_000
/** The done mark of a turn stays this long (2 s). */
export const FINISH_MS = 2000
/** The done mark's time, in frames. */
export const DONE_FRAMES = FINISH_MS / FRAME_MS
/** The Lively working dot blinks every this many frames (0.5 s). */
export const DOT_BLINK_FRAMES = 10
/** The Subtle working dot changes color every this many frames (1 s). */
export const DOT_BREATHE_FRAMES = 20
/** The done mark twinkles every this many frames. */
export const TWINKLE_FRAMES = 4

const PULSE_LENGTH = PULSE_PROFILE.length

export type Level = {
  /** Blend at the sweep head; the two neighbours get half. */
  glint: number
  /** Passes for a change of at least `BIG_STEP` (smaller changes always 1). */
  glintPasses: 1 | 2
  /** Level-up lighten amount, times the profile. */
  pulse: number
  /** Blend toward green on a reset, times the profile. */
  resetFlash: number
  /** How far flashed digits go to the flash color. */
  flashMix: number
  /** ✦✧ in the compaction drain and the reset badge. */
  sparkle: boolean
  /** Badge in its color, else `PLAIN`. */
  badgeColored: boolean
}

export const LEVELS: Record<'lively' | 'subtle', Level> = {
  lively: { glint: 0.6, glintPasses: 2, pulse: 0.55, resetFlash: 0.7, flashMix: 1, sparkle: true, badgeColored: true },
  subtle: { glint: 0.3, glintPasses: 1, pulse: 0.3, resetFlash: 0.35, flashMix: 0.5, sparkle: false, badgeColored: false },
}

type Dir = 'up' | 'down'

/** A figure that rolls like an odometer toward its target. */
export type Odo = {
  /** The value it rolls toward; `null` = no figure. */
  target: number | null
  /** The value shown now. */
  shown: number
  /** Digit index from which the figure flashes, until which tick. */
  flash: { from: number; until: number; dir: Dir } | null
}

export type BarAnim = {
  /** The last percent seen; `null` = never seen (the next value is taken silently). */
  target: number | null
  /** The last reset time seen (5h/wk; always null for ctx). */
  resetsAtMs: number | null
  /** The rolling figure (integer). */
  shown: number
  /** Digit index from which the figure flashes, until which tick. */
  flash: { from: number; until: number; dir: Dir } | null
  /** The percent the fill is drawn at, tweened (rises only). */
  grow: { from: number; to: number; start: number } | null
  /** Fill color tween (0xRRGGBB numbers). */
  color: { from: number; to: number; start: number } | null
  /** `fill` = filled interior cells of the target drawing. */
  glint: { dir: Dir; start: number; passes: 1 | 2; fill: number } | null
  /** Interior cells in `[to, from)` were filled and are now empty; `oldCps` are the old drawing's interior code points. */
  drain: {
    from: number
    to: number
    start: number
    oldCps: number[]
    oldColor: number
    sparkle: boolean
  } | null
  /** A pulse; `isHot` when ctx crossed 80% (the state dot pulses red with it). */
  pulse: { kind: 'level' | 'reset'; start: number; isHot: boolean } | null
  /** `text` is used by `compact`; `fresh` builds its text per frame. */
  badge: { kind: 'compact' | 'fresh'; text: string; start: number } | null
  /** The context tokens, rolling. Only ctx ever has a target. */
  tokens: Odo
}

/** The line's state outside the bars. */
export type RowAnim = {
  /** When the turn's done mark started; null while none shows. */
  doneStart: number | null
}

export type MotionState = { tick: number; bars: Record<BarId, BarAnim>; row: RowAnim }

export function freshBar(): BarAnim {
  return {
    target: null,
    resetsAtMs: null,
    shown: 0,
    flash: null,
    grow: null,
    color: null,
    glint: null,
    drain: null,
    pulse: null,
    badge: null,
    tokens: { target: null, shown: 0, flash: null },
  }
}

export function freshRow(): RowAnim {
  return { doneStart: null }
}

export function createMotion(): MotionState {
  return { tick: 0, bars: { ctx: freshBar(), five: freshBar(), week: freshBar() }, row: freshRow() }
}

/** Ease-out quad: `1 - (1 - p)^2` with `p = min(1, elapsed / frames)`. */
function ease(elapsed: number, frames: number): number {
  const p = Math.min(1, Math.max(0, elapsed / frames))

  return 1 - (1 - p) * (1 - p)
}

const RANK: Record<ReturnType<typeof tone>, number> = { ok: 0, warn: 1, hot: 2 }

const toneColor = (percent: number): number => rgb(TONES[tone(percent)])

/** A cell of a drawn bar: `i` is its place among the interior cells (fill and track), -1 for a frame. */
type Slot = { cp: number; kind: BarPart['kind']; i: number }

function slots(parts: BarPart[]): Slot[] {
  const out: Slot[] = []
  let i = 0
  for (const part of parts) {
    for (const ch of part.text) {
      const cp = safeCp(ch.codePointAt(0) ?? 0x3f)
      out.push({ cp, kind: part.kind, i: part.kind === 'frame' ? -1 : i++ })
    }
  }

  return out
}

const fillCount = (list: Slot[]): number => list.filter(s => s.kind === 'fill').length

/** The fill color tween's value at `t`, or null when none is in progress. */
function colorAt(b: BarAnim, t: number): number | null {
  const c = b.color
  if (c === null || t >= c.start + COLOR_FRAMES) return null

  return mixColor(c.from, c.to, ease(t - c.start, COLOR_FRAMES))
}

/** The percent the fill is drawn at `t` while a grow is in progress, or null. */
function growAt(b: BarAnim, t: number): number | null {
  const g = b.grow
  if (g === null || t >= g.start + GROW_FRAMES) return null

  return g.from + (g.to - g.from) * ease(t - g.start, GROW_FRAMES)
}

/** Takes both figures as they are, with no effect running. */
function settle(b: BarAnim, next: { percent: number; resetsAtMs: number | null; tokens?: number | null }): void {
  b.target = next.percent
  b.shown = next.percent
  b.resetsAtMs = next.resetsAtMs
  b.flash = null
  b.grow = null
  b.color = null
  b.glint = null
  b.drain = null
  b.pulse = null
  b.badge = null
  b.tokens =
    next.tokens == null
      ? { target: null, shown: 0, flash: null }
      : { target: next.tokens, shown: next.tokens, flash: null }
}

/**
 * Called once per present bar on every render: a changed value starts its effects, the same value does nothing
 * (repeated renders are harmless), the first value is taken silently unless it is an entrance (a bar that
 * appears after the mod's first draw fills in from empty), and every value under Off is taken silently.
 */
export function observe(
  m: MotionState,
  id: BarId,
  next: { percent: number; resetsAtMs: number | null; tokens?: number | null },
  pref: BarPref,
  level: Motion,
  isEntrance = false,
): void {
  const b = m.bars[id]
  const t = m.tick
  let entering = false
  if (b.target === null) {
    if (level === 'off' || !isEntrance) {
      settle(b, next)

      return
    }
    entering = true
    b.target = 0
    b.shown = 0
    b.resetsAtMs = next.resetsAtMs
    b.tokens = { target: next.tokens == null ? null : 0, shown: 0, flash: null }
  }
  if (level === 'off') {
    settle(b, next)

    return
  }
  const prev = b.target ?? 0
  if (next.tokens == null) b.tokens = { target: null, shown: 0, flash: null }
  else if (b.tokens.target === null && !entering) b.tokens = { target: next.tokens, shown: next.tokens, flash: null }
  else b.tokens.target = next.tokens
  if (next.percent === prev) {
    b.resetsAtMs = next.resetsAtMs

    return
  }

  const L = LEVELS[level]
  const d = next.percent - prev
  const oldSlots = slots(drawBar(pref, prev))
  const newSlots = slots(drawBar(pref, next.percent))
  const oldF = fillCount(oldSlots)
  const newF = fillCount(newSlots)
  const cur = colorAt(b, t) ?? toneColor(prev)
  const nextTone = tone(next.percent)

  const startColor = (): void => {
    if (tone(prev) !== nextTone || colorAt(b, t) !== null) {
      b.color = { from: cur, to: rgb(TONES[nextTone]), start: t }
    }
  }
  const startDrain = (sparkle: boolean): void => {
    if (newF < oldF) {
      b.drain = {
        from: oldF,
        to: newF,
        start: t,
        oldCps: oldSlots.filter(s => s.i >= 0).map(s => s.cp),
        oldColor: cur,
        sparkle,
      }
    }
  }

  const isReset =
    id !== 'ctx' &&
    d < 0 &&
    ((next.resetsAtMs === null && b.resetsAtMs !== null) ||
      (next.resetsAtMs !== null && b.resetsAtMs !== null && next.resetsAtMs > b.resetsAtMs + RESET_SHIFT_MS))

  if (isReset) {
    b.pulse = { kind: 'reset', start: t, isHot: false }
    b.badge = { kind: 'fresh', text: '', start: t }
    startDrain(false)
    startColor()
    b.glint = null
    b.grow = null
  } else if (id === 'ctx' && -d >= COMPACT_DROP) {
    b.glint = { dir: 'down', start: t, passes: L.glintPasses, fill: newF }
    startDrain(L.sparkle)
    b.badge = { kind: 'compact', text: `${String.fromCodePoint(COMPACT_MARK)} ${String.fromCodePoint(MINUS)}${-d}%`, start: t }
    startColor()
    b.grow = null
  } else if (d > 0) {
    b.glint = { dir: 'up', start: t, passes: d >= BIG_STEP ? L.glintPasses : 1, fill: newF }
    b.grow = { from: growAt(b, t) ?? prev, to: next.percent, start: t }
    startColor()
    if (RANK[nextTone] > RANK[tone(prev)] && !entering) {
      b.pulse = { kind: 'level', start: t, isHot: id === 'ctx' && nextTone === 'hot' }
    }
  } else {
    b.glint = { dir: 'down', start: t, passes: -d >= BIG_STEP ? L.glintPasses : 1, fill: newF }
    startDrain(false)
    startColor()
    b.grow = null
  }

  b.target = next.percent
  b.resetsAtMs = next.resetsAtMs
}

/** The digit index where two figure texts first differ. */
function firstDiff(before: string, after: string): number {
  let from = 0
  const shorter = Math.min(before.length, after.length)
  while (from < shorter && before[from] === after[from]) from++

  return from
}

/** The token figure as drawn: right-aligned to the width its target takes. */
function tokenText(o: Odo): string {
  return formatTokens(o.shown).padStart(formatTokens(o.target ?? o.shown).length)
}

/** One frame on: the tick moves, and on roll ticks every figure steps toward its target, flashing the digits that changed. */
export function advance(m: MotionState): void {
  m.tick += 1
  if (m.tick % ROLL_EVERY !== 0) return
  for (const id of Object.keys(m.bars) as BarId[]) {
    const b = m.bars[id]
    if (b.target !== null && b.shown !== b.target) {
      const gap = b.target - b.shown
      const step = Math.min(Math.abs(gap), Math.max(1, Math.ceil(Math.abs(gap) / 4)))
      const before = `${b.shown}%`
      b.shown += gap > 0 ? step : -step
      const after = `${b.shown}%`
      b.flash = { from: firstDiff(before, after), until: m.tick + FLASH_FRAMES, dir: gap > 0 ? 'up' : 'down' }
    }
    const o = b.tokens
    if (o.target !== null && o.shown !== o.target) {
      const unit = o.target < 1000 ? 1 : o.target < 1_000_000 ? 1000 : 100_000
      const gap = o.target - o.shown
      const step = Math.min(Math.abs(gap), Math.max(unit, Math.ceil(Math.abs(gap) / 4)))
      const before = tokenText(o)
      o.shown += Math.sign(gap) * step
      const after = tokenText(o)
      if (before !== after) {
        o.flash = { from: firstDiff(before, after), until: m.tick + FLASH_FRAMES, dir: gap > 0 ? 'up' : 'down' }
      }
    }
  }
}

function drainEnd(d: NonNullable<BarAnim['drain']>): number {
  return d.sparkle ? d.start + SPARK_STRIDE * (d.from - d.to - 1) + 4 : d.start + DRAIN_FRAMES
}

/** True while anything is still moving: a figure rolling, or an effect before its end. */
export function isActive(m: MotionState): boolean {
  const t = m.tick
  for (const id of Object.keys(m.bars) as BarId[]) {
    const b = m.bars[id]
    if (b.target !== null && b.shown !== b.target) return true
    if (b.glint !== null && t < b.glint.start + GLINT_FRAMES * b.glint.passes) return true
    if (b.grow !== null && t < b.grow.start + GROW_FRAMES) return true
    if (b.color !== null && t < b.color.start + COLOR_FRAMES) return true
    if (b.drain !== null && t < drainEnd(b.drain)) return true
    if (b.pulse !== null && t < b.pulse.start + PULSE_LENGTH * PULSE_COUNT) return true
    if (b.badge !== null && t < b.badge.start + BADGE_FRAMES) return true
    if (b.flash !== null && t < b.flash.until) return true
    if (b.tokens.target !== null && b.tokens.shown !== b.tokens.target) return true
    if (b.tokens.flash !== null && t < b.tokens.flash.until) return true
  }
  if (m.row.doneStart !== null && t < m.row.doneStart + DONE_FRAMES) return true

  return false
}

/** The frame of one bar at `m.tick`: the bar cells, a space and the figure, then the tokens and the badge when they show. */
export function composeBar(m: MotionState, id: BarId, pref: BarPref, level: 'lively' | 'subtle'): Cell[] {
  const b = m.bars[id]
  const L = LEVELS[level]
  const t = m.tick
  const target = b.target ?? b.shown

  // 1. The drawing.
  const p = growAt(b, t) ?? target
  const list = slots(drawBar(pref, p))
  const fillColor = colorAt(b, t) ?? toneColor(target)
  const cells: Cell[] = list.map(s => ({ cp: s.cp, fg: s.kind === 'fill' ? fillColor : TRACK, bg: DEFAULT }))
  const width = list.filter(s => s.i >= 0).length

  // 2. The drain of the cells a fall emptied.
  const drain = b.drain
  if (drain !== null && t < drainEnd(drain)) {
    const elapsed = t - drain.start
    list.forEach((s, n) => {
      const cell = cells[n]!
      if (s.kind !== 'track' || s.i < drain.to || s.i >= drain.from) return
      const old = drain.oldCps[s.i] ?? s.cp
      if (!drain.sparkle) {
        if (elapsed >= DRAIN_FRAMES) return
        cell.cp = old
        cell.fg = mixColor(drain.oldColor, TRACK, ease(elapsed, DRAIN_FRAMES))
        return
      }
      const k = drain.from - 1 - s.i
      const sp = elapsed - SPARK_STRIDE * k
      if (sp < 0) {
        cell.cp = old
        cell.fg = drain.oldColor
      } else if (sp < 2) {
        cell.cp = SPARK_FULL
        cell.fg = GLINT_DOWN
      } else if (sp < 4) {
        cell.cp = SPARK_HOLLOW
        cell.fg = mixColor(GLINT_DOWN, TRACK, 0.5)
      }
    })
  }

  // 3. The pulse.
  let figureLift = 0
  const pulse = b.pulse
  if (pulse !== null && t < pulse.start + PULSE_LENGTH * PULSE_COUNT) {
    const a = PULSE_PROFILE[(t - pulse.start) % PULSE_LENGTH] ?? 0
    if (pulse.kind === 'level') {
      figureLift = a * L.pulse
      list.forEach((s, n) => {
        if (s.kind === 'fill') cells[n]!.fg = lighten(cells[n]!.fg, figureLift)
      })
    } else {
      const green = rgb(TONES.ok)
      list.forEach((s, n) => {
        if (s.i >= 0) cells[n]!.fg = mixColor(cells[n]!.fg, green, a * L.resetFlash)
      })
    }
  }

  // 4. The glint.
  const glint = b.glint
  if (glint !== null && t < glint.start + GLINT_FRAMES * glint.passes && width > 0) {
    const elapsed = t - glint.start
    const f = elapsed % GLINT_FRAMES
    const q = f / (GLINT_FRAMES - 1)
    const isLastPass = Math.floor(elapsed / GLINT_FRAMES) === glint.passes - 1
    const sweep = (amount: number, at: number, i: number): number => {
      const gap = Math.abs(i - at)

      return gap === 0 ? amount : gap === 1 ? amount / 2 : 0
    }
    if (glint.dir === 'up') {
      const head = Math.round(-1 + q * (glint.fill + 1))
      list.forEach((s, n) => {
        if (s.kind !== 'fill' || s.i >= glint.fill) return
        let amount = sweep(L.glint, head, s.i)
        if (isLastPass && f >= GLINT_FRAMES - 4 && s.i === glint.fill - 1) amount = Math.max(amount, L.glint)
        if (amount > 0) cells[n]!.fg = mixColor(cells[n]!.fg, GLINT_UP, amount)
      })
    } else {
      const head = Math.round(width - q * (width + 1))
      list.forEach((s, n) => {
        if (s.i < 0) return
        const amount = sweep(L.glint, head, s.i)
        if (amount > 0) cells[n]!.fg = mixColor(cells[n]!.fg, GLINT_DOWN, amount)
      })
    }
  }

  const out: Cell[] = cells
  const isBare = styleOf(pref.style).id === 'none'
  if (!isBare) out.push({ cp: 0x20, fg: DEFAULT, bg: DEFAULT })

  // 5. The figure.
  const figureFg = lighten(fillColor, figureLift)
  const figure = textCells(`${b.shown}%`, figureFg)
  const flash = b.flash
  if (flash !== null && t < flash.until) {
    const color = flash.dir === 'up' ? GLINT_UP : GLINT_DOWN
    figure.forEach((cell, i) => {
      if (i >= flash.from) cell.fg = mixColor(cell.fg, color, L.flashMix)
    })
  }
  out.push(...figure)

  // 6. The token figure, an odometer: ` · ` then the tokens, changed digits flashing.
  if (b.tokens.target !== null) {
    out.push(...textCells(' · ', PLAIN))
    const tokens = textCells(tokenText(b.tokens), PLAIN)
    const tokenFlash = b.tokens.flash
    if (tokenFlash !== null && t < tokenFlash.until) {
      const color = tokenFlash.dir === 'up' ? GLINT_UP : GLINT_DOWN
      tokens.forEach((cell, i) => {
        if (i >= tokenFlash.from) cell.fg = mixColor(cell.fg, color, L.flashMix)
      })
    }
    out.push(...tokens)
  }

  // 7. The badge.
  const badge = b.badge
  if (badge !== null && t < badge.start + BADGE_FRAMES) {
    out.push({ cp: 0x20, fg: DEFAULT, bg: DEFAULT })
    if (badge.kind === 'compact') {
      out.push(...textCells(badge.text, L.badgeColored ? GLINT_DOWN : PLAIN))
    } else if (L.sparkle) {
      const spark = Math.floor((t - badge.start) / 4) % 2 === 0 ? SPARK_FULL : SPARK_HOLLOW
      out.push(...textCells(`${String.fromCodePoint(spark)} fresh`, rgb(TONES.ok)))
    } else {
      out.push(...textCells('fresh', PLAIN))
    }
  }

  return out
}
