import { expect, test } from 'claude-code/testing'

import {
  DEMO_END_MS,
  DEMO_SCRIPT,
  DEMO_TICK_MS,
  FIVE_AFTER_MS,
  FIVE_BEFORE_MS,
  demoFrameAt,
  demoLine,
} from '../hooks/demo'
import type { LineData } from '../hooks/line'
import { advance, createMotion, observe } from '../hooks/motion'
import { DEFAULT_PREFS } from '../hooks/styles'

const STARTED = 1_000_000

const data = (ctx: LineData['ctx']): LineData => ({
  model: 'claude-opus-5-5',
  effort: 'high',
  project: 'claudepeeker',
  git: null,
  ctx,
  five: null,
  week: null,
  prefs: DEFAULT_PREFS,
  now: STARTED,
  offsetMin: 0,
})

test('the script is read by the time that has passed', () => {
  expect(demoFrameAt(0)).toMatchObject({ ctx: 20, five: 40, week: 30 })
  expect(demoFrameAt(1499)).toMatchObject({ ctx: 20, five: 40, week: 30 })
  expect(demoFrameAt(13499).ctx).toBe(68)
  expect(demoFrameAt(13500).ctx).toBe(15)
  expect(demoFrameAt(16000)).toMatchObject({ five: 0, fiveReset: true })
  expect(demoFrameAt(19999)).toBe(DEMO_SCRIPT.at(-1))
  for (const row of DEMO_SCRIPT) expect(row.at % DEMO_TICK_MS).toBe(0)
  expect(DEMO_SCRIPT.at(-1)!.at).toBeLessThanOrEqual(DEMO_END_MS - 4000)
})

test('the demo replaces the three figures and nothing else', () => {
  const real = data({ window: 200_000, percent: 3 })
  const early = demoLine(real, 0, STARTED)
  expect(early.model).toBe(real.model)
  expect(early.project).toBe(real.project)
  expect(early.prefs).toBe(real.prefs)
  expect(early.ctx).toEqual({ window: 200_000, percent: 20 })
  expect(early.five).toEqual({ percent: 40, resetsAtMs: STARTED + FIVE_BEFORE_MS, delta: null })
  expect(early.week?.delta).toBeNull()

  const late = demoLine(real, 16000, STARTED)
  expect(late.five).toEqual({ percent: 0, resetsAtMs: STARTED + FIVE_AFTER_MS, delta: null })

  expect(demoLine(data(null), 0, STARTED).ctx).toEqual({ window: 1_000_000, percent: 20 })
})

test('walking the script starts the effects it was written for', () => {
  const pref = { style: 'blocks', width: 5 }
  const m = createMotion()
  const seen: Record<number, { ctxPulse?: string; ctxBadge?: string; ctxBadgeText?: string; fivePulse?: string; fiveBadge?: string }> = {}
  for (const row of DEMO_SCRIPT) {
    const line = demoLine(data({ window: 1_000_000, percent: 0 }), row.at, STARTED)
    observe(m, 'ctx', { percent: line.ctx!.percent, resetsAtMs: null }, pref, 'lively')
    observe(m, 'five', { percent: line.five!.percent, resetsAtMs: line.five!.resetsAtMs }, pref, 'lively')
    observe(m, 'week', { percent: line.week!.percent, resetsAtMs: line.week!.resetsAtMs }, pref, 'lively')
    const ctx = m.bars.ctx
    const five = m.bars.five
    seen[row.at] = {
      ctxPulse: ctx.pulse?.start === m.tick ? ctx.pulse.kind : undefined,
      ctxBadge: ctx.badge?.start === m.tick ? ctx.badge.kind : undefined,
      ctxBadgeText: ctx.badge?.start === m.tick ? ctx.badge.text : undefined,
      fivePulse: five.pulse?.start === m.tick ? five.pulse.kind : undefined,
      fiveBadge: five.badge?.start === m.tick ? five.badge.kind : undefined,
    }
    // Let every effect of this row end before the next one is read.
    for (let i = 0; i < 60; i++) advance(m)
  }
  expect(seen[0]).toEqual({})
  expect(seen[6500]?.ctxPulse).toBe('level')
  expect(seen[9000]?.ctxPulse).toBe('level')
  expect(seen[13500]?.ctxBadge).toBe('compact')
  expect(seen[13500]?.ctxBadgeText).toBe('↻ −53%')
  expect(seen[16000]?.fiveBadge).toBe('fresh')
  expect(seen[16000]?.fivePulse).toBe('reset')
})
