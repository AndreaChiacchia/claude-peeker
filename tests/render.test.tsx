import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-10T11:00:00Z')
const HOUR = 3600_000

const PANE = {
  plugin: 'claudepeeker',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'peeker-bars',
  props: { title: 'Bar styles', isFocused: false } as never,
} as const

const BAND = {
  plugin: 'claudepeeker',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 155 } as never,
  viewport: { columns: 160, rows: 40 } as never,
} as const

function world(on: On) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.usage', () => ({
    value: {
      startedAt: NOW - HOUR,
      context: { tokens: 120_000, window: 1_000_000, percent: 12 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 6, resetsAt: new Date(NOW + 2 * HOUR + 59 * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 1, resetsAt: new Date(NOW + 6 * 24 * HOUR + 18 * HOUR).toISOString() },
      ],
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.root', () => ({ value: 'C:\\Users\\a\\projects\\mods\\claudepeeker' }))
  on('settings.read', () => ({
    value: { effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } },
  }))
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

function text(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  return ((node as Node).children ?? []).map(text).join('')
}

function columnBoxes(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0
  const { type, props, children = [] } = node as Node
  const own = type === 'Box' && props?.flexDirection !== 'row' && props?.flexDirection !== 'column' ? 1 : 0
  return own + children.reduce<number>((n, child) => n + columnBoxes(child), 0)
}

test('the band draws the old status line, indented as it was, in one flow', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(BAND)
  const drawn = await ui.drawn()
  expect(text(drawn)).toBe(
    '[Opus 5.5 ·high] · claudepeeker · ctx (1M) ▰▱▱▱▱ 12% · 5h (2h59m) █░░░░ 6% [+34%] · wk (6d18h) █░░░░ 1%',
  )
  expect(JSON.stringify(drawn)).toContain('"paddingLeft":2')
  // In the flow: a negative margin empties the band, an overlay outside it is clipped.
  expect(JSON.stringify(drawn)).not.toContain('marginBottom')
  expect(JSON.stringify(drawn)).not.toContain('absolute')
  // No fragment boxes: one lays out as a column and stacks the line's pieces.
  expect(columnBoxes(drawn)).toBe(0)
  // Plain text is dim, as the old status line draws it; colored text is not.
  expect(JSON.stringify(await ui.find({ type: 'Text', text: 'claudepeeker' }))).toContain('dimColor')
})

test('a survey takes the band back', async ($, on) => {
  world(on)
  on('ui.render', ({ ui }, e) => {
    const { Text } = ui.resolve(e)
    return <Text>survey</Text>
  })
  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: true, isWorking: false, maxRows: 10, bodyColumns: 155 } as never })
  expect(text(await ui.drawn())).toBe('survey')
})

test('a click on a reset time cycles it, each window on its own', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'reset-five' })
  expect((await ui.find({ key: 'reset-five' }))?.text).toBe('(15:59)')
  expect((await ui.find({ key: 'reset-week' }))?.text).toBe('(6d18h)')
  await ui.press({ key: 'reset-five' })
  expect((await ui.find({ key: 'reset-five' }))?.text).toBe('(10/10 15:59)')
  await ui.press({ key: 'reset-week' })
  expect((await ui.find({ key: 'reset-week' }))?.text).toBe('(Sat 07:00)')
  await ui.press({ key: 'reset-five' })
  expect((await ui.find({ key: 'reset-five' }))?.text).toBe('(2h59m)')
})

test('the panel restyles one bar and leaves the others', async ($, on) => {
  world(on)
  const pane = await $.ui.mount(PANE)
  // Blocks steps on to Dots, seven along; back then on again leaves 5h as it was.
  for (let i = 0; i < 7; i++) await pane.press({ key: 'style-week-next' })
  await pane.press({ key: 'width-week-next' })
  await pane.press({ key: 'width-week-next' })
  await pane.press({ key: 'style-five-prev' })
  await pane.press({ key: 'style-five-next' })
  await pane.press({ key: 'time-five' })
  const line = text(await (await $.ui.mount(BAND)).drawn())
  expect(line).toContain('wk (6d18h) ●○○○○○○○ 1%')
  expect(line).toContain('5h (15:59) █░░░░ 6%')
  expect(line).toContain('ctx (1M) ▰▱▱▱▱ 12%')
})
