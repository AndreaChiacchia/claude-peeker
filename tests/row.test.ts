import { expect, test } from 'claude-code/testing'

import { DEFAULT, DOT_EMPTY, DOT_FULL, HOT, LIVE, PLAIN, SPARK_FULL, SPARK_HOLLOW, TRACK, mixColor } from '../hooks/cells'
import type { Cell } from '../hooks/cells'
import { PULSE_PROFILE, createMotion, observe } from '../hooks/motion'
import { composeDot, composeTail, markDone, tailWidth } from '../hooks/row'
import type { TailState } from '../hooks/row'

const GREEN = 0x5fff00

const cellText = (cells: Cell[]): string => cells.map(c => String.fromCodePoint(c.cp)).join('')

test('the working dot blinks in Lively every 10 frames, in lavender', () => {
  const m = createMotion()
  for (let t = 0; t < 20; t++) {
    m.tick = t
    expect(composeDot(m, 'working', 'lively')).toEqual([{ cp: t < 10 ? DOT_FULL : DOT_EMPTY, fg: LIVE, bg: DEFAULT }])
  }
})

test('the working dot in Subtle stays full and alternates its color every 20 frames', () => {
  const m = createMotion()
  for (let t = 0; t < 40; t++) {
    m.tick = t
    const fg = t < 20 ? LIVE : mixColor(LIVE, TRACK, 0.5)
    expect(composeDot(m, 'working', 'subtle')).toEqual([{ cp: DOT_FULL, fg, bg: DEFAULT }])
  }
})

test('the idle dot is a gray full dot', () => {
  const m = createMotion()
  for (const t of [0, 10, 25]) {
    m.tick = t
    expect(composeDot(m, 'idle', 'lively')).toEqual([{ cp: DOT_FULL, fg: TRACK, bg: DEFAULT }])
    expect(composeDot(m, 'idle', 'subtle')).toEqual([{ cp: DOT_FULL, fg: TRACK, bg: DEFAULT }])
  }
})

test('the dot pulses red while ctx crosses 80%, in Lively, working or idle', () => {
  const pref = { style: 'blocks', width: 10 }
  const m = createMotion()
  observe(m, 'ctx', { percent: 70, resetsAtMs: null }, pref, 'lively')
  observe(m, 'ctx', { percent: 85, resetsAtMs: null }, pref, 'lively')
  const start = m.bars.ctx.pulse?.start ?? 0
  for (let k = 0; k < PULSE_PROFILE.length; k++) {
    m.tick = start + k
    const expected = [{ cp: DOT_FULL, fg: mixColor(LIVE, HOT, PULSE_PROFILE[k]!), bg: DEFAULT }]
    expect(composeDot(m, 'working', 'lively')).toEqual(expected)
    expect(composeDot(m, 'idle', 'lively')).toEqual(expected)
  }
  // Subtle does not pulse, and the pulse ends after three passes.
  m.tick = start + 2
  expect(composeDot(m, 'idle', 'subtle')[0]?.fg).toBe(TRACK)
  m.tick = start + PULSE_PROFILE.length * 3
  expect(composeDot(m, 'idle', 'lively')[0]?.fg).toBe(TRACK)
})

test('a crossing of 50% does not pulse the dot', () => {
  const pref = { style: 'blocks', width: 10 }
  const m = createMotion()
  observe(m, 'ctx', { percent: 30, resetsAtMs: null }, pref, 'lively')
  observe(m, 'ctx', { percent: 60, resetsAtMs: null }, pref, 'lively')
  expect(composeDot(m, 'idle', 'lively')[0]?.fg).toBe(TRACK)
})

test('the live time is plain and the last turn time is gray', () => {
  const m = createMotion()
  const live = composeTail(m, { kind: 'live', elapsedMs: 72_000 }, 'lively')
  expect(cellText(live)).toBe('1m12s')
  expect(live.every(c => c.fg === PLAIN)).toBe(true)
  const idle = composeTail(m, { kind: 'idle', durationMs: 6_000 }, 'lively')
  expect(cellText(idle)).toBe('6s')
  expect(idle.every(c => c.fg === TRACK)).toBe(true)
})

test('a lean done mark is green and twinkles every 4 frames after it starts', () => {
  const m = createMotion()
  m.tick = 100
  markDone(m)
  const tail: TailState = { kind: 'done', word: 'done', durationMs: 42_000, isLean: true }
  for (const [after, mark] of [
    [0, SPARK_FULL],
    [3, SPARK_FULL],
    [4, SPARK_HOLLOW],
    [7, SPARK_HOLLOW],
    [8, SPARK_FULL],
  ] as const) {
    m.tick = 100 + after
    const cells = composeTail(m, tail, 'lively')
    expect(cells[0]?.cp).toBe(mark)
    expect(cellText(cells).slice(1)).toBe(' done · 42s')
    expect(cells.every(c => c.fg === GREEN)).toBe(true)
  }
  // The mark starts once.
  m.tick = 150
  markDone(m)
  expect(m.row.doneStart).toBe(100)
})

test('the other done marks keep their colors; Subtle draws all of them plain', () => {
  const m = createMotion()
  const color = (tail: TailState, level: 'lively' | 'subtle') =>
    new Set(composeTail(m, tail, level).map(c => c.fg))
  const heavy: TailState = { kind: 'done', word: 'done', durationMs: 42_000, isLean: false }
  const failed: TailState = { kind: 'done', word: 'failed', durationMs: 5_000, isLean: true }
  const stopped: TailState = { kind: 'done', word: 'stopped', durationMs: 5_000, isLean: true }
  expect(color(heavy, 'lively')).toEqual(new Set([LIVE]))
  expect(color(failed, 'lively')).toEqual(new Set([HOT]))
  expect(color(stopped, 'lively')).toEqual(new Set([PLAIN]))
  for (const tail of [heavy, failed, stopped, { ...heavy, isLean: true }]) {
    expect(color(tail, 'subtle')).toEqual(new Set([PLAIN]))
  }
  expect(cellText(composeTail(m, failed, 'lively'))).toBe('✗ failed · 5s')
  expect(cellText(composeTail(m, stopped, 'lively'))).toBe('✗ stopped · 5s')
})

test('the tail width is the length of the cells it composes', () => {
  const m = createMotion()
  const tails: TailState[] = [
    { kind: 'live', elapsedMs: 9_000 },
    { kind: 'live', elapsedMs: 72_000 },
    { kind: 'idle', durationMs: 3_720_000 },
    { kind: 'done', word: 'done', durationMs: 42_000, isLean: true },
    { kind: 'done', word: 'stopped', durationMs: 63_000, isLean: false },
  ]
  for (const tail of tails) {
    expect(tailWidth(tail)).toBe(composeTail(m, tail, 'lively').length)
  }
})
