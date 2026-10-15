import { expect, test } from 'claude-code/testing'

import { GLINT_UP, mixColor } from '../hooks/cells'
import type { Cell } from '../hooks/cells'
import { advance, composeBar, createMotion, isActive, observe } from '../hooks/motion'
import type { MotionState } from '../hooks/motion'
import { STYLES, drawBar, normalizePrefs } from '../hooks/styles'
import type { BarPref, Motion } from '../types'

const GREEN = 0x5fff00
const TRACK = 0x585858

const cellText = (cells: Cell[]): string => cells.map(c => String.fromCodePoint(c.cp)).join('')

/** A bar that has taken `from` silently, then sees `to`. */
function moved(pref: BarPref, from: number, to: number, level: Motion = 'lively', id: 'ctx' | 'five' | 'week' = 'ctx') {
  const m = createMotion()
  observe(m, id, { percent: from, resetsAtMs: null }, pref, level)
  observe(m, id, { percent: to, resetsAtMs: null }, pref, level)

  return m
}

/** Every frame from the tick after the change until `last`, as cells. */
function frames(m: MotionState, pref: BarPref, level: 'lively' | 'subtle', last: number, id: 'ctx' | 'five' | 'week' = 'ctx') {
  const out: Cell[][] = []
  for (let i = 0; i < last; i++) {
    advance(m)
    out.push(composeBar(m, id, pref, level))
  }

  return out
}

test('motion is read back from the store, and defaults to lively', () => {
  expect(normalizePrefs({}).motion).toBe('lively')
  expect(normalizePrefs({ motion: 'subtle' }).motion).toBe('subtle')
  expect(normalizePrefs({ motion: 'off' }).motion).toBe('off')
  expect(normalizePrefs({ motion: 'wild' }).motion).toBe('lively')
})

test('with nothing moving a bar is exactly the plain bar, in every style and width', () => {
  for (const style of STYLES) {
    for (const width of [3, 5, 20]) {
      for (const percent of [0, 7, 50, 100]) {
        const pref = { style: style.id, width }
        const m = createMotion()
        observe(m, 'ctx', { percent, resetsAtMs: null }, pref, 'lively')
        const plain = drawBar(pref, percent).map(part => part.text).join('')
        const expected = style.id === 'none' ? `${percent}%` : `${plain} ${percent}%`
        expect(cellText(composeBar(m, 'ctx', pref, 'lively'))).toBe(expected)
        expect(isActive(m)).toBe(false)
      }
    }
  }
})

test('a rise glints warm over the fill; Subtle glints softer', () => {
  const pref = { style: 'blocks', width: 10 }
  const lively = frames(moved(pref, 12, 20), pref, 'lively', 11)
  expect(lively.some(f => f.some(c => c.fg === mixColor(GREEN, GLINT_UP, 0.6)))).toBe(true)

  const subtle = frames(moved(pref, 12, 20, 'subtle'), pref, 'subtle', 11)
  expect(subtle.some(f => f.some(c => c.fg === mixColor(GREEN, GLINT_UP, 0.3)))).toBe(true)
  expect(subtle.some(f => f.some(c => c.fg === mixColor(GREEN, GLINT_UP, 0.6)))).toBe(false)
})

test('a fall glints cold over the empty cells', () => {
  const pref = { style: 'blocks', width: 10 }
  const GLINT_DOWN = 0x5fd7ff
  const fall = frames(moved(pref, 40, 30), pref, 'lively', 11)
  expect(fall.some(f => f.some(c => c.cp === 0x2591 && c.fg === mixColor(TRACK, GLINT_DOWN, 0.6)))).toBe(true)
})

test('the figure rolls toward its value in shrinking steps', () => {
  const pref = { style: 'blocks', width: 10 }
  const m = moved(pref, 12, 52)
  const seen: number[] = []
  for (let i = 0; i < 11; i++) {
    advance(m)
    advance(m)
    seen.push(m.bars.ctx.shown)
  }
  expect(seen).toEqual([22, 30, 36, 40, 43, 46, 48, 49, 50, 51, 52])
})

test('a compaction sparkles in Lively only, then settles', () => {
  const pref = { style: 'parallelogram', width: 10 }
  const lively = moved(pref, 85, 23)
  expect(cellText(composeBar(lively, 'ctx', pref, 'lively'))).toContain('↻ −62%')
  const livelyFrames = frames(lively, pref, 'lively', 60)
  expect(livelyFrames.some(f => f.some(c => c.cp === 0x2726))).toBe(true)
  expect(isActive(lively)).toBe(false)

  const subtle = moved(pref, 85, 23, 'subtle')
  expect(cellText(composeBar(subtle, 'ctx', pref, 'subtle'))).toContain('↻ −62%')
  const subtleFrames = frames(subtle, pref, 'subtle', 60)
  expect(subtleFrames.some(f => f.some(c => c.cp === 0x2726 || c.cp === 0x2727))).toBe(false)
  expect(isActive(subtle)).toBe(false)
})

test('only crossing 50 or 80 upward pulses the bar', () => {
  const pref = { style: 'blocks', width: 10 }
  expect(moved(pref, 45, 55).bars.ctx.pulse?.kind).toBe('level')
  expect(moved(pref, 55, 45).bars.ctx.pulse).toBeNull()
})

test('the token figure rolls like an odometer toward its value', () => {
  const pref = { style: 'blocks', width: 10 }
  const m = createMotion()
  observe(m, 'ctx', { percent: 12, resetsAtMs: null, tokens: 120_000 }, pref, 'lively')
  expect(cellText(composeBar(m, 'ctx', pref, 'lively')).endsWith('12% · 120K')).toBe(true)
  observe(m, 'ctx', { percent: 52, resetsAtMs: null, tokens: 520_000 }, pref, 'lively')
  const seen = new Set<string>()
  for (const frame of frames(m, pref, 'lively', 80)) {
    const figure = /% · +(\S+)$/.exec(cellText(frame))?.[1]
    if (figure !== undefined) seen.add(figure)
  }
  const middle = [...seen].filter(f => f !== '120K' && f !== '520K')
  expect(middle.length).toBeGreaterThan(0)
  expect(cellText(composeBar(m, 'ctx', pref, 'lively')).endsWith('52% · 520K')).toBe(true)
  expect(isActive(m)).toBe(false)
})

test('a bar entering after the first draw fills in from empty, without a level pulse', () => {
  const pref = { style: 'blocks', width: 10 }
  const m = createMotion()
  observe(m, 'five', { percent: 60, resetsAtMs: null }, pref, 'lively', true)
  expect(cellText(composeBar(m, 'five', pref, 'lively')).endsWith(' 0%')).toBe(true)
  expect(m.bars.five.pulse).toBeNull()
  expect(isActive(m)).toBe(true)
  const last = frames(m, pref, 'lively', 80, 'five').at(-1)!
  expect(cellText(last)).toBe('██████░░░░ 60%')
  expect(m.bars.five.pulse).toBeNull()

  // Without the entrance flag the first value is taken silently, as before.
  const silent = createMotion()
  observe(silent, 'five', { percent: 60, resetsAtMs: null }, pref, 'lively')
  expect(cellText(composeBar(silent, 'five', pref, 'lively'))).toBe('██████░░░░ 60%')
  expect(isActive(silent)).toBe(false)
})

test('a ctx rise past 80 pulses hot; the same rise on a rate window does not', () => {
  const pref = { style: 'blocks', width: 10 }
  expect(moved(pref, 70, 85).bars.ctx.pulse).toMatchObject({ kind: 'level', isHot: true })
  expect(moved(pref, 70, 85, 'lively', 'five').bars.five.pulse).toMatchObject({ kind: 'level', isHot: false })
  expect(moved(pref, 30, 60).bars.ctx.pulse).toMatchObject({ kind: 'level', isHot: false })
})

test('Off takes the tokens at once', () => {
  const pref = { style: 'blocks', width: 10 }
  const m = createMotion()
  observe(m, 'ctx', { percent: 12, resetsAtMs: null, tokens: 120_000 }, pref, 'lively')
  observe(m, 'ctx', { percent: 52, resetsAtMs: null, tokens: 520_000 }, pref, 'off')
  expect(m.bars.ctx.tokens).toEqual({ target: 520_000, shown: 520_000, flash: null })
  expect(isActive(m)).toBe(false)
})

test('a rate window that resets is fresh, never a glint; ctx is never a reset', () => {
  const pref = { style: 'blocks', width: 10 }
  const m = createMotion()
  observe(m, 'five', { percent: 63, resetsAtMs: 1_000_000 }, pref, 'lively')
  observe(m, 'five', { percent: 0, resetsAtMs: null }, pref, 'lively')
  expect(m.bars.five.badge?.kind).toBe('fresh')
  expect(m.bars.five.pulse?.kind).toBe('reset')
  expect(m.bars.five.glint).toBeNull()

  const ctx = createMotion()
  observe(ctx, 'ctx', { percent: 63, resetsAtMs: null }, pref, 'lively')
  observe(ctx, 'ctx', { percent: 0, resetsAtMs: null }, pref, 'lively')
  expect(ctx.bars.ctx.badge?.kind).toBe('compact')
})
