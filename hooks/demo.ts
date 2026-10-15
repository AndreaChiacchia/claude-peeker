// The /peeker demo: made-up figures for a 20-second tour of the bars' effects.

import type { LineData } from './line'

/** The demo clock's step, in milliseconds. */
export const DEMO_TICK_MS = 250
/** The demo's length, in milliseconds. */
export const DEMO_END_MS = 20_000

/** Reset times, as offsets from the demo's start. */
export const FIVE_BEFORE_MS = 7_980_000 // 2h13m
export const FIVE_AFTER_MS = 18_000_000 // 5h
export const WEEK_MS = 579_600_000 // 6d17h

export type DemoFrame = {
  /** Milliseconds from the start. */
  at: number
  ctx: number
  five: number
  week: number
  /** True once the 5h window has reset. */
  fiveReset: boolean
}

export const DEMO_SCRIPT: readonly DemoFrame[] = [
  { at: 0, ctx: 20, five: 40, week: 30, fiveReset: false }, // the baseline, taken silently
  { at: 1500, ctx: 23, five: 40, week: 30, fiveReset: false }, // a small rise
  { at: 3000, ctx: 26, five: 40, week: 30, fiveReset: false }, // another small rise
  { at: 4500, ctx: 31, five: 40, week: 30, fiveReset: false }, // a rise of 5: two glint passes
  { at: 6500, ctx: 56, five: 40, week: 30, fiveReset: false }, // a jump past 50%
  { at: 7500, ctx: 56, five: 40, week: 35, fiveReset: false }, // the weekly bar rises on its own
  { at: 9000, ctx: 84, five: 40, week: 35, fiveReset: false }, // a jump past 80%
  { at: 11500, ctx: 68, five: 40, week: 35, fiveReset: false }, // a drop
  { at: 13500, ctx: 15, five: 40, week: 35, fiveReset: false }, // a compaction
  { at: 16000, ctx: 15, five: 0, week: 35, fiveReset: true }, // the 5h window resets
]

/** The last row whose time has come (the first row for anything earlier). */
export function demoFrameAt(elapsedMs: number): DemoFrame {
  let found = DEMO_SCRIPT[0]!
  for (const frame of DEMO_SCRIPT) {
    if (frame.at <= elapsedMs) found = frame
  }

  return found
}

/**
 * `data` with only the three figures replaced by the script's. The pace delta is hidden so no
 * made-up `[+n%]` shows; the 5h reset time moves later at the reset row, which `observe` reads as a new window.
 */
export function demoLine(data: LineData, elapsedMs: number, startedAt: number): LineData {
  const frame = demoFrameAt(elapsedMs)

  return {
    ...data,
    ctx: { window: data.ctx?.window ?? 1_000_000, percent: frame.ctx },
    five: {
      percent: frame.five,
      resetsAtMs: startedAt + (frame.fiveReset ? FIVE_AFTER_MS : FIVE_BEFORE_MS),
      delta: null,
    },
    week: { percent: frame.week, resetsAtMs: startedAt + WEEK_MS, delta: null },
  }
}
