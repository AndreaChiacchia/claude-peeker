// The line's dot and tail as cells: the turn's state glyph, its elapsed time and its finish.

import {
  DEFAULT,
  DOT_FULL,
  HOT,
  LIVE,
  PLAIN,
  SPARK_FULL,
  SPARK_HOLLOW,
  TRACK,
  mixColor,
  rgb,
  textCells,
} from './cells'
import type { Cell } from './cells'
import { doneText, formatElapsed } from './format'
import type { FinishWord } from './format'
import { TONES } from './line'
import { DOT_BLINK_FRAMES, DOT_BREATHE_FRAMES, PULSE_COUNT, PULSE_PROFILE, TWINKLE_FRAMES } from './motion'
import type { MotionState } from './motion'

/** What the dot shows: the main loop at work, or not. */
export type DotState = 'working' | 'idle'

const glyph = (cp: number, fg: number): Cell[] => [{ cp, fg, bg: DEFAULT }]

/** The state dot: one cell. It pulses red while ctx's level-up pulse crosses 80% (Lively). */
export function composeDot(m: MotionState, state: DotState, level: 'lively' | 'subtle'): Cell[] {
  const t = m.tick
  const pulse = m.bars.ctx.pulse
  if (
    level === 'lively' &&
    pulse !== null &&
    pulse.kind === 'level' &&
    pulse.isHot &&
    t < pulse.start + PULSE_PROFILE.length * PULSE_COUNT
  ) {
    return glyph(DOT_FULL, mixColor(LIVE, HOT, PULSE_PROFILE[(t - pulse.start) % PULSE_PROFILE.length] ?? 0))
  }
  if (state === 'idle') return glyph(DOT_FULL, TRACK)
  if (level === 'lively') return glyph(DOT_FULL, Math.floor(t / DOT_BLINK_FRAMES) % 2 === 0 ? LIVE : mixColor(LIVE, TRACK, 0.5))

  return glyph(DOT_FULL, Math.floor(t / DOT_BREATHE_FRAMES) % 2 === 0 ? LIVE : mixColor(LIVE, TRACK, 0.5))
}

export type TailState =
  | { kind: 'live'; elapsedMs: number }
  | { kind: 'done'; word: FinishWord; durationMs: number; isLean: boolean }
  | { kind: 'idle'; durationMs: number }

/** The end of the line: the elapsed time, the finish mark, or the last turn's time. */
export function composeTail(m: MotionState, tail: TailState, level: 'lively' | 'subtle'): Cell[] {
  if (tail.kind === 'live') return textCells(formatElapsed(tail.elapsedMs), PLAIN)
  if (tail.kind === 'idle') return textCells(formatElapsed(tail.durationMs), TRACK)

  const text = doneText(tail.word, tail.durationMs)
  if (level === 'subtle') return textCells(text, PLAIN)
  if (tail.word === 'failed') return textCells(text, HOT)
  if (tail.word === 'stopped') return textCells(text, PLAIN)
  if (!tail.isLean) return textCells(text, LIVE)
  const cells = textCells(text, rgb(TONES.ok))
  const doneStart = m.row.doneStart
  const isHollow = doneStart !== null && Math.floor((m.tick - doneStart) / TWINKLE_FRAMES) % 2 === 1
  const mark = cells[0]
  if (mark !== undefined) mark.cp = isHollow ? SPARK_HOLLOW : SPARK_FULL

  return cells
}

/** The columns a tail takes now. */
export function tailWidth(tail: TailState): number {
  if (tail.kind === 'live') return Array.from(formatElapsed(tail.elapsedMs)).length
  if (tail.kind === 'idle') return Array.from(formatElapsed(tail.durationMs)).length

  return Array.from(doneText(tail.word, tail.durationMs)).length
}

/** The turn ended: its done mark starts now (once). */
export function markDone(m: MotionState): void {
  if (m.row.doneStart === null) m.row.doneStart = m.tick
}
