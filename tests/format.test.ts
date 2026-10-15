import { expect, test } from 'claude-code/testing'

import {
  doneText,
  effortLabel,
  formatElapsed,
  formatTokens,
  modelLabel,
  nextTimeMode,
  paceDelta,
  resetLabel,
  windowFigures,
  wordForReason,
} from '../hooks/format'
import { STYLES, drawBar, filledCells, normalizePrefs } from '../hooks/styles'

const HOUR = 3600_000
// Sat 10 Oct 2026, 11:00 UTC; Italy is UTC+2 (120 minutes east).
const NOW = Date.parse('2026-10-10T11:00:00Z')
const ROME = 120

test('model ids read as the old status line showed them', () => {
  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
  expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1')
  expect(modelLabel('Opus 5.5')).toBe('Opus 5.5')
})

test('reset time cycles rel, clock, date in short notation', () => {
  const five = NOW + 2 * HOUR + 56 * 60_000
  expect(resetLabel(five, NOW, 'rel', ROME)).toBe('2h56m')
  expect(resetLabel(five, NOW, 'clock', ROME)).toBe('15:56')
  expect(resetLabel(five, NOW, 'date', ROME)).toBe('10/10 15:56')

  const week = Date.parse('2026-10-16T03:00:00Z')
  expect(resetLabel(week, NOW, 'rel', ROME)).toBe('5d16h')
  expect(resetLabel(week, NOW, 'clock', ROME)).toBe('Fri 05:00')
  expect(resetLabel(week, NOW, 'date', ROME)).toBe('16/10 05:00')

  expect(nextTimeMode('rel')).toBe('clock')
  expect(nextTimeMode('clock')).toBe('date')
  expect(nextTimeMode('date')).toBe('rel')
})

test('a reset past local midnight is shown with its weekday', () => {
  // 23:30 local today, reset at 01:30 local tomorrow (Sunday)
  const now = Date.parse('2026-10-10T21:30:00Z')
  expect(resetLabel(now + 2 * HOUR, now, 'clock', ROME)).toBe('Sun 01:30')
})

test('pace delta and a window past its reset', () => {
  expect(paceDelta(6, NOW + 2 * HOUR + 59 * 60_000, 5, NOW)).toBe(34)
  expect(paceDelta(58, NOW + 2 * HOUR, 5, NOW)).toBe(null)
  expect(windowFigures({ percentUsed: 73, resetsAt: new Date(NOW - 1).toISOString() }, 5, NOW)).toEqual({
    percent: 0,
    resetsAtMs: null,
    delta: null,
  })
})

test('tokens', () => {
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(formatTokens(200_000)).toBe('200K')
  expect(formatTokens(1_500_000)).toBe('1.5M')
})

test('a turn time reads seconds, minutes, then hours', () => {
  expect(formatElapsed(0)).toBe('0s')
  expect(formatElapsed(-5)).toBe('0s')
  expect(formatElapsed(42_999)).toBe('42s')
  expect(formatElapsed(72_000)).toBe('1m12s')
  expect(formatElapsed(3_720_000)).toBe('1h02m')
})

test('the finish mark and the word for how a turn ended', () => {
  expect(doneText('done', 42_000)).toBe('✦ done · 42s')
  expect(doneText('failed', 5_000)).toBe('✗ failed · 5s')
  expect(doneText('stopped', 63_000)).toBe('✗ stopped · 1m03s')
  expect(wordForReason('answer')).toBe('done')
  expect(wordForReason('aborted')).toBe('stopped')
  expect(wordForReason('error')).toBe('failed')
  expect(wordForReason('refusal')).toBe('failed')
})

test('an effort reads as the request sent it', () => {
  expect(effortLabel(32_000)).toBe('32K think')
  expect(effortLabel(null)).toBeNull()
  expect(effortLabel(undefined)).toBeNull()
  expect(effortLabel('high')).toBe('high')
})

test('bars keep the old cell count and every style draws its width', () => {
  expect(filledCells(6, 5)).toBe(1)
  expect(filledCells(48, 5)).toBe(2)
  expect(filledCells(0, 5)).toBe(0)
  expect(drawBar({ style: 'blocks', width: 5 }, 6)).toEqual([
    { kind: 'fill', text: '█' },
    { kind: 'track', text: '░░░░' },
  ])
  expect(drawBar({ style: 'parallelogram', width: 5 }, 100)).toEqual([{ kind: 'fill', text: '▰▰▰▰▰' }])
  for (const style of STYLES) {
    if (style.isGlyph) continue
    for (const percent of [0, 1, 37, 50, 99, 100]) {
      const text = style.draw(percent, 8).map(part => part.text).join('')
      const frame = style.id === 'ascii' || style.id === 'arrow' ? 2 : 0
      expect([...text].length).toBe(8 + frame)
    }
  }
})

test('stored prefs are read back over the defaults', () => {
  const prefs = normalizePrefs({ bars: { five: { style: 'gone', width: 7 } }, timeModes: { week: 'date' } })
  expect(prefs.bars.five).toEqual({ style: 'blocks', width: 5 })
  expect(prefs.bars.ctx).toEqual({ style: 'parallelogram', width: 5 })
  expect(prefs.timeModes).toEqual({ five: 'rel', week: 'date' })
})
