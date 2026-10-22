import { expect, test } from 'claude-code/testing'

import { GLINT_UP, mixColor } from '../hooks/cells'
import type { Cell } from '../hooks/cells'
import {
  DONE_FRAMES,
  FRAME_MS,
  IDLE_FRAME_MS,
  advance,
  composeBar,
  createMotion,
  frameMsFor,
  isActive,
  isBarActive,
  observe,
} from '../hooks/motion'
import type { MotionState } from '../hooks/motion'
import { markDone } from '../hooks/row'
import { STYLES, drawBar, normalizeSettings } from '../hooks/styles'
import type { BarId, BarPref, Motion } from '../types'

const GREEN = 0x5fff00
const TRACK = 0x585858
const NOW = Date.parse('2026-10-10T11:00:00Z')
const HOUR = 3600_000

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

test('motion comes from the setting, and defaults to lively', () => {
  expect(normalizeSettings({}).motion).toBe('lively')
  expect(normalizeSettings({ motion: 'subtle' }).motion).toBe('subtle')
  expect(normalizeSettings({ motion: 'off' }).motion).toBe('off')
  expect(normalizeSettings({ motion: 'wild' }).motion).toBe('lively')
})

test('a growing blocks bar eases its tip by eighths; at rest it is whole cells', () => {
  const pref = { style: 'blocks', width: 10 }
  const m = moved(pref, 12, 20)
  const cells = composeBar(m, 'ctx', pref, 'lively').slice(0, 10)
  expect(cells.some(c => c.cp >= 0x2589 && c.cp <= 0x258f)).toBe(true)
  const last = frames(m, pref, 'lively', 80).at(-1) ?? []
  expect(cellText(last).startsWith('██░░░░░░░░ 20%')).toBe(true)
})

test('a heavy bar draws its track in the dim heavy gray', () => {
  const pref = { style: 'heavy', width: 5 }
  const m = createMotion()
  observe(m, 'ctx', { percent: 40, resetsAtMs: null }, pref, 'lively')
  const cells = composeBar(m, 'ctx', pref, 'lively')
  expect(cells.slice(0, 2).map(c => [c.cp, c.fg])).toEqual([
    [0x2501, GREEN],
    [0x2501, GREEN],
  ])
  expect(cells.slice(2, 5).map(c => [c.cp, c.fg])).toEqual([
    [0x2501, 0x444444],
    [0x2501, 0x444444],
    [0x2501, 0x444444],
  ])
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

test('a bar with nothing moving draws the same frame from then on, and the line moves only while one of its bars or the done mark does', () => {
  const pref = { style: 'blocks', width: 5 }
  const ids: BarId[] = ['ctx', 'five', 'week']
  const scenarios: { name: string; id: BarId; make: () => MotionState }[] = [
    {
      name: 'a rise',
      id: 'ctx',
      make: () => {
        const m = createMotion()
        observe(m, 'ctx', { percent: 12, resetsAtMs: null }, pref, 'lively')
        observe(m, 'ctx', { percent: 52, resetsAtMs: null }, pref, 'lively')

        return m
      },
    },
    {
      name: 'a compaction',
      id: 'ctx',
      make: () => {
        const m = createMotion()
        observe(m, 'ctx', { percent: 85, resetsAtMs: null }, pref, 'lively')
        observe(m, 'ctx', { percent: 23, resetsAtMs: null }, pref, 'lively')

        return m
      },
    },
    {
      name: 'a reset',
      id: 'five',
      make: () => {
        const m = createMotion()
        observe(m, 'five', { percent: 40, resetsAtMs: NOW + 2 * HOUR }, pref, 'lively')
        observe(m, 'five', { percent: 0, resetsAtMs: NOW + 5 * HOUR }, pref, 'lively')

        return m
      },
    },
    {
      name: 'tokens',
      id: 'ctx',
      make: () => {
        const m = createMotion()
        observe(m, 'ctx', { percent: 12, resetsAtMs: null, tokens: 120_000 }, pref, 'lively')
        observe(m, 'ctx', { percent: 52, resetsAtMs: null, tokens: 520_000 }, pref, 'lively')

        return m
      },
    },
    {
      name: 'a bar entering',
      id: 'week',
      make: () => {
        const m = createMotion()
        observe(m, 'week', { percent: 30, resetsAtMs: null }, pref, 'lively', true)

        return m
      },
    },
  ]
  for (const { name, id, make } of scenarios) {
    const m = make()
    let settledAt = -1
    for (let i = 0; i < 400; i++) {
      expect(isActive(m), `${name}: tick ${i}`).toBe(ids.some(b => isBarActive(m, b)))
      if (!isBarActive(m, id)) {
        settledAt = i
        break
      }
      advance(m)
    }
    expect(settledAt, `${name} settles`).toBeGreaterThan(-1)
    const a = composeBar(m, id, pref, 'lively')
    for (let i = 0; i < 200; i++) advance(m)
    expect(isBarActive(m, id), `${name}: still settled`).toBe(false)
    expect(composeBar(m, id, pref, 'lively'), name).toEqual(a)
  }
})

test('the frame timer runs every frame only while something moves', () => {
  const pref = { style: 'blocks', width: 5 }
  const m = createMotion()
  expect(frameMsFor(m)).toBe(IDLE_FRAME_MS)
  observe(m, 'ctx', { percent: 12, resetsAtMs: null }, pref, 'lively')
  observe(m, 'ctx', { percent: 52, resetsAtMs: null }, pref, 'lively')
  expect(frameMsFor(m)).toBe(FRAME_MS)
  for (let i = 0; i < 400; i++) advance(m)
  expect(frameMsFor(m)).toBe(IDLE_FRAME_MS)
  markDone(m)
  expect(frameMsFor(m)).toBe(FRAME_MS)
  for (let i = 0; i < DONE_FRAMES; i++) advance(m)
  expect(frameMsFor(m)).toBe(IDLE_FRAME_MS)
})
