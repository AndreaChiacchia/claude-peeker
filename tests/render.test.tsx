import type { On, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { LIVE, TRACK, decodeCells, mixColor } from '../hooks/cells'
import type { Cell } from '../hooks/cells'

const NOW = Date.parse('2026-10-10T11:00:00Z')
const HOUR = 3600_000

const HINT = {
  plugin: 'claudepeeker',
  surface: 'terminal',
  component: 'PromptHint',
  requestId: 'hint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as never,
  viewport: { columns: 160, rows: 40 } as never,
} as const

const LINE =
  '● [Opus 5.5 ·high] · claudepeeker · ctx (1M) ▰▱▱▱▱ 12% · 120K · 5h (2h59m) █░░░░ 6% [+34%] · wk (6d18h) █░░░░ 1%'

type State = {
  ctx: number
  five: { percentUsed: number; resetsAt: string }
  week: { percentUsed: number; resetsAt: string }
  blitAnswer: { deny?: string }
  /** False: the engine reports no rate limits. */
  limits: boolean
  /** False: the engine reports no context token count. */
  tokens: boolean
  /** The `settings.read` value. */
  settings: unknown
  /** What `config.set` answers: a deny, or nothing (written). */
  configAnswer: { deny?: string }
}

/** What the engine measures for the figures `state` holds now. */
const figures = (state: State) => ({
  context: {
    ...(state.tokens ? { tokens: state.ctx * 10_000 } : {}),
    window: 1_000_000,
    percent: state.ctx,
  },
  rateLimits: state.limits
    ? [
        { kind: 'five_hour' as const, ...state.five },
        { kind: 'seven_day' as const, ...state.week },
      ]
    : [],
})

/**
 * `stacked`: another mod beneath has put rows of its own under the hint.
 * The figures the tests move live in `state`; the blits the mod sends are recorded in `blits`.
 */
function world(on: On, stacked: string[] = []) {
  const state: State = {
    ctx: 12,
    five: { percentUsed: 6, resetsAt: new Date(NOW + 2 * HOUR + 59 * 60_000).toISOString() },
    week: { percentUsed: 1, resetsAt: new Date(NOW + 6 * 24 * HOUR + 18 * HOUR).toISOString() },
    blitAnswer: {},
    limits: true,
    tokens: true,
    settings: { effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } },
    configAnswer: {},
  }
  const blits: { requestId: string; key: string; cells?: string }[] = []
  const configSets: { key: string; value: unknown }[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: NOW })
  // The mod's own key-value store, in memory; the test reads it back through `store`.
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.usage', () => ({ value: { startedAt: NOW - HOUR, ...figures(state) } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.root', () => ({ value: 'C:\\Users\\a\\projects\\mods\\claudepeeker' }))
  // Not a git repository: the git refresh that runs on every turn (and at start) settles at once, with nothing to show.
  on('session.repo', () => ({ value: null }) as never)
  on('settings.read', () => ({ value: state.settings }) as never)
  on('ui.blit', (_$, e) => {
    blits.push({ requestId: e.requestId, key: e.key, cells: (e as unknown as { cells?: string }).cells })
    return { value: state.blitAnswer }
  })
  on('config.set', (_$, e) => {
    configSets.push({ key: e.key, value: e.value })

    return (state.configAnswer.deny === undefined ? { value: e.value } : { deny: state.configAnswer.deny }) as never
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined } as never
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_$, e): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  })
  // The engine's own hint line, which the mod keeps above the status line.
  on('ui.render', ({ ui }, e) => {
    const { Box, Text } = ui.resolve(e)
    if (stacked.length === 0) return <Text>? for shortcuts</Text>
    return (
      <Box flexDirection="column">
        <Text>? for shortcuts</Text>
        {stacked.map(row => (
          <Text>{row}</Text>
        ))}
      </Box>
    )
  })

  return { state, blits, clock, store, configSets, toasts }
}

type World = ReturnType<typeof world>

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

const cellText = (cells: Cell[]): string => cells.map(c => String.fromCodePoint(c.cp)).join('')

/** The drawing as text; a Raster contributes its decoded cells, untrimmed. */
function text(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  const one = node as Node
  if (one.type === 'Raster') return cellText(decodeCells(String(one.props?.cells ?? '')))
  return (one.children ?? []).map(text).join('')
}

function walk(node: unknown, out: Node[] = []): Node[] {
  if (node === null || typeof node !== 'object') return out
  out.push(node as Node)
  for (const child of (node as Node).children ?? []) walk(child, out)
  return out
}

const rasters = (node: unknown) => walk(node).filter(n => n.type === 'Raster')

const keyOf = (n: Node): unknown => n.props?.key ?? (n as { key?: unknown }).key

/** The Raster drawn under `key`, if any. */
const raster = (node: unknown, key: string): Node | undefined => rasters(node).find(n => keyOf(n) === key)

function columnBoxes(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0
  const { type, props, children = [] } = node as Node
  const own = type === 'Box' && props?.flexDirection !== 'row' && props?.flexDirection !== 'column' ? 1 : 0
  return own + children.reduce<number>((n, child) => n + columnBoxes(child), 0)
}

/** The engine measures the figures `state` holds now. */
async function measure($: Engine, w: World, changed: string[]) {
  await $.session.measure({ ...figures(w.state), changed } as never)
}

/** The main loop's turn starts, or a subagent's when `agentId` is given. */
const startTurn = ($: Engine, agentId?: string) =>
  $.turn.start({ text: '', turnId: 't1', ...(agentId ? { agentId } : {}) } as never)

/** The turn ends. */
const endTurn = ($: Engine, durationMs: number, reason: 'answer' | 'aborted' | 'error' = 'answer', agentId?: string) =>
  $.turn.complete({
    answer: '',
    durationMs,
    isAborted: reason === 'aborted',
    turnId: 't1',
    reason,
    ...(agentId ? { agentId } : {}),
  } as never)

/** A request of the main loop, drained. */
async function mainStep($: Engine, effort: 'low' | 'high' | number): Promise<void> {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort, messageCount: 1 } as never)
  for await (const chunk of stream) void chunk
}

/** `/peeker <args>`, as the composer runs it. */
const command = ($: Engine, args: string) =>
  $.command.run({ command: 'peeker', args, origin: { kind: 'composer' } } as never) as Promise<{ text: string }>

/** What each blit painted, as text. */
const blitTexts = (w: World): string[] => w.blits.map(b => cellText(decodeCells(b.cells ?? '')))

test('the status line draws under the hint line, aligned with it, in one flow', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(HINT)
  const drawn = await ui.drawn()
  expect(text(drawn)).toBe(`? for shortcuts${LINE}`)
  // The hint slot is already indented: any padding pushes the line right of the hint.
  expect(JSON.stringify(drawn)).not.toContain('paddingLeft')
  // No fragment boxes: one lays out as a column and stacks the line's pieces.
  expect(columnBoxes(drawn)).toBe(0)
  // Plain text is dim, as the old status line draws it; colored text is not.
  expect(JSON.stringify(await ui.find({ type: 'Text', text: 'claudepeeker' }))).toContain('dimColor')
  // The dot and the three bars are Rasters, each under its own key.
  expect(rasters(drawn).map(keyOf)).toEqual(['peeker-dot', 'peeker-ctx', 'peeker-five', 'peeker-week'])
})

test("the status line stays right under the hint, before another mod's rows", async ($, on) => {
  world(on, ['subagents', 'general-purpose'])
  const drawn = await (await $.ui.mount(HINT)).drawn()
  expect(text(drawn)).toBe(`? for shortcuts${LINE}subagentsgeneral-purpose`)
})

test('a click on a reset time cycles it, each window on its own', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.press({ key: 'reset-five' })
  expect((await ui.find({ key: 'reset-five' }))?.text).toBe('(15:59)')
  expect((await ui.find({ key: 'reset-week' }))?.text).toBe('(6d18h)')
  await ui.press({ key: 'reset-five' })
  expect((await ui.find({ key: 'reset-five' }))?.text).toBe('(10/10 15:59)')
  await ui.press({ key: 'reset-week' })
  expect((await ui.find({ key: 'reset-week' }))?.text).toBe('(Sat 07:00)')
  await ui.press({ key: 'reset-five' })
  expect((await ui.find({ key: 'reset-five' }))?.text).toBe('(2h59m)')
  expect(w.configSets).toEqual([
    { key: 'claudepeeker.fiveTime', value: 'clock' },
    { key: 'claudepeeker.fiveTime', value: 'date' },
    { key: 'claudepeeker.weekTime', value: 'clock' },
    { key: 'claudepeeker.fiveTime', value: 'relative' },
  ])
})

test('a refused click puts the time back and says why', async ($, on) => {
  const w = world(on)
  w.state.configAnswer = { deny: 'locked by policy' }
  const ui = await $.ui.mount(HINT)
  await ui.press({ key: 'reset-five' })
  expect((await ui.find({ key: 'reset-five' }))?.text).toBe('(2h59m)')
  expect(w.toasts).toContain('Claude-Peeker: the 5h reset time stays relative: locked by policy')
})

test('the reset time settings reach the line', { options: { fiveTime: 'clock', weekTime: 'date' } }, async ($, on) => {
  world(on)
  const line = text(await (await $.ui.mount(HINT)).drawn())
  expect(line).toContain('5h (15:59)')
  expect(line).toContain('wk (17/10 07:00)')
})

test(
  'the bar settings reach the line, each bar on its own',
  { options: { weekStyle: 'dots', weekWidth: '8', fiveTime: 'clock' } },
  async ($, on) => {
    world(on)
    const line = text(await (await $.ui.mount(HINT)).drawn())
    expect(line).toContain('wk (6d18h) ●○○○○○○○ 1%')
    expect(line).toContain('5h (15:59) █░░░░ 6%')
    expect(line).toContain('ctx (1M) ▰▱▱▱▱ 12%')
  },
)

test('a heavy ctx bar draws ━ on a dim ━', { options: { ctxStyle: 'heavy' } }, async ($, on) => {
  world(on)
  const drawn = await (await $.ui.mount(HINT)).drawn()
  expect(text(drawn)).toContain('ctx (1M) ━━━━━ 12%')
  const cells = decodeCells(String(raster(drawn, 'peeker-ctx')?.props?.cells ?? ''))
  expect(cells[0]?.fg).toBe(0x5fff00)
  expect(cells.slice(1, 5).map(c => c.fg)).toEqual([0x444444, 0x444444, 0x444444, 0x444444])
})

test('the first draw is silent', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  await w.clock.advance(1000)
  expect(w.blits.length).toBe(0)
})

test('a rise animates and settles', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  w.state.ctx = 52
  await measure($, w, ['context'])
  await ui.drawn()
  await w.clock.advance(100)
  expect(w.blits.length).toBeGreaterThan(0)
  expect(w.blits.every(b => b.requestId === 'hint' && b.key === 'peeker-ctx')).toBe(true)

  await w.clock.advance(3000)
  const settled = w.blits.length
  await w.clock.advance(1000)
  expect(w.blits.length).toBe(settled)

  const last = decodeCells(w.blits.at(-1)?.cells ?? '')
  expect(cellText(last)).toBe('▰▰▰▱▱ 52% · 520K')
  expect(last.filter(c => c.cp === 0x25b0).every(c => c.fg === 0xffd700)).toBe(true)
  expect(w.blits.slice(0, -1).some(b => b.cells !== w.blits.at(-1)?.cells)).toBe(true)
})

test('a compaction drains the ctx bar and shows its badge for a moment', async ($, on) => {
  const w = world(on)
  w.state.ctx = 85
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  w.state.ctx = 23
  await measure($, w, ['context'])
  expect(text(await ui.drawn())).toContain('↻ −62%')

  await w.clock.advance(3000)
  const after = text(await ui.drawn())
  expect(after).toContain('ctx (1M) ▰▱▱▱▱ 23%')
  expect(after).not.toContain('↻')
})

test('a rate window that resets flashes fresh', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  w.state.five = { percentUsed: 0, resetsAt: new Date(NOW + 5 * HOUR).toISOString() }
  await measure($, w, ['rateLimits'])
  expect(text(await ui.drawn())).toContain('✦ fresh')
})

test('Off draws today\'s line and moves nothing', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  const drawn = await ui.drawn()
  expect(rasters(drawn).length).toBe(0)
  expect(text(drawn)).toBe(`? for shortcuts${LINE}`)

  w.state.ctx = 52
  await measure($, w, ['context'])
  await ui.drawn()
  await w.clock.advance(2000)
  expect(w.blits.length).toBe(0)
})

test('a slot that refuses its first blits three times is drawn still', async ($, on) => {
  const w = world(on)
  w.state.blitAnswer = { deny: 'no such site' }
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  for (let i = 0; i < 3; i++) {
    w.state.ctx += 5
    await measure($, w, ['context'])
    expect(rasters(await ui.drawn()).length).toBeGreaterThan(0)
    await w.clock.advance(100)
  }
  const again = text(await ui.drawn())
  expect(rasters(await ui.drawn()).length).toBe(0)
  expect(again).toContain('ctx (1M)')
  expect(again).toContain('27%')
})

test('the bars move after each response, before the turn ends', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  w.state.ctx = 30
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never)
  for await (const chunk of stream) void chunk
  // The motion takes the new figure in a render; the response's redraw is that render.
  await ui.drawn()
  // The figure then rolls through the Raster blits, which the drawing itself does not show.
  await w.clock.advance(2000)
  const ctx = w.blits.filter(b => b.key === 'peeker-ctx')
  expect(ctx.length).toBeGreaterThan(0)
  expect(cellText(decodeCells(ctx.at(-1)?.cells ?? ''))).toContain('30%')
})

test('the demo plays every effect, then returns silently to real usage', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  const started = await command($, 'demo')
  expect(started.text.startsWith('Playing the motion demo')).toBe(true)

  // The baseline figures are taken silently: the dot and the time legitimately blit during the demo turn, the bar does not.
  const first = await ui.drawn()
  expect(text(raster(first, 'peeker-ctx'))).toBe('▰▱▱▱▱ 20% · 200K')
  await w.clock.advance(1000)
  expect(w.blits.filter(b => b.key === 'peeker-ctx').length).toBe(0)

  // Past 1500 ms the first small rise starts.
  await w.clock.advance(1000)
  await ui.drawn()
  await w.clock.advance(300)
  expect(w.blits.some(b => b.key === 'peeker-ctx')).toBe(true)

  // Through the rest of the tour, drawing after each step as the row changes ask.
  const drawings: string[] = [text(first)]
  for (let at = 2300; at < 18300; at += 500) {
    await w.clock.advance(500)
    drawings.push(text(await ui.drawn()))
  }
  const seen = (part: string) => drawings.some(d => d.includes(part)) || blitTexts(w).some(t => t.includes(part))
  expect(seen('↻ −53%')).toBe(true)
  expect(seen('✦ fresh') || seen('✧ fresh')).toBe(true)
  // The demo turn: its time from 1m04s, and its done mark at 17 s.
  expect(seen('1m04s')).toBe(true)
  expect(seen('done · 1m21s')).toBe(true)

  // The demo is over at 20 s: the real figures are back, with no effect.
  await w.clock.advance(2700)
  const after = text(await ui.drawn())
  expect(after).toContain('ctx (1M) ▰▱▱▱▱ 12%')
  expect(after).toContain('█░░░░ 6% [+')
  expect(after).toContain('█░░░░ 1%')
  expect(after).not.toContain('↻')
  expect(after).not.toContain('fresh')
  const count = w.blits.length
  await w.clock.advance(2000)
  expect(w.blits.length).toBe(count)
})

test('under Off the demo still steps the figures, without effects', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  const started = await command($, 'demo')
  expect(started.text).toContain('Motion is Off')
  await w.clock.advance(7000)
  const drawn = await ui.drawn()
  expect(text(drawn)).toContain('ctx (1M) ▰▰▰▱▱ 56%')
  expect(rasters(drawn).length).toBe(0)
  expect(w.blits.length).toBe(0)
})

test('demo stop brings the real figures back; a second one says no demo runs', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  await command($, 'demo')
  await w.clock.advance(7000)
  const stopped = await command($, 'demo stop')
  expect(stopped.text).toBe('Stopped the demo: the line shows your real usage again.')
  const drawn = text(await ui.drawn())
  expect(drawn).toContain('ctx (1M) ▰▱▱▱▱ 12%')
  expect(drawn).toContain('█░░░░ 6%')
  expect(drawn).toContain('█░░░░ 1%')
  const count = w.blits.length
  await w.clock.advance(1000)
  expect(w.blits.length).toBe(count)
  expect((await command($, 'demo stop')).text).toBe('No demo is running.')
})

test('a second demo restarts from the beginning', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  await command($, 'demo')
  await w.clock.advance(14000)
  await command($, 'demo')
  const drawn = await ui.drawn()
  expect(text(raster(drawn, 'peeker-ctx'))).toBe('▰▱▱▱▱ 20% · 200K')
  const count = w.blits.filter(b => b.key === 'peeker-ctx').length
  await w.clock.advance(1000)
  expect(w.blits.filter(b => b.key === 'peeker-ctx').length).toBe(count)
})

test('a bare /peeker points to /config', async ($, on) => {
  world(on)
  const pointer =
    "Claude-Peeker's settings are in /config: each bar's style and width, the reset time formats and Motion. A click on a reset time steps its format. /peeker demo plays the motion tour."
  expect((await command($, '')).text).toBe(pointer)
  expect((await command($, '5h')).text).toBe(pointer)
})

test('no setting is written to the store', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  await ui.press({ key: 'reset-five' })
  await command($, 'demo')
  expect(w.store.size).toBe(0)
})

const GRAY_CELL = 0x585858

test('a main turn dims the dot and ticks the time', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  await startTurn($)
  const drawn = await ui.drawn()
  expect(text(raster(drawn, 'peeker-tail'))).toBe('0s')

  await w.clock.advance(1200)
  const dotCells = w.blits.filter(b => b.key === 'peeker-dot').flatMap(b => decodeCells(b.cells ?? ''))
  expect(dotCells.every(c => c.cp === 0x25cf)).toBe(true)
  expect(dotCells.map(c => c.fg)).toContain(LIVE)
  expect(dotCells.map(c => c.fg)).toContain(mixColor(LIVE, TRACK, 0.5))
  const tails = w.blits.filter(b => b.key === 'peeker-tail').map(b => cellText(decodeCells(b.cells ?? '')))
  expect(tails.includes('1s') || text(await ui.drawn()).endsWith('1s')).toBe(true)
})

test('a turn that ends shows its mark for 2 s, then its time in gray', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  await startTurn($)
  await ui.drawn()
  await endTurn($, 42_000)
  expect(text(await ui.drawn())).toContain('✦ done · 42s')

  await w.clock.advance(2100)
  const drawn = await ui.drawn()
  const line = text(drawn)
  expect(line.endsWith('42s')).toBe(true)
  expect(line).not.toContain('done')
  const tail = decodeCells(String(raster(drawn, 'peeker-tail')?.props?.cells ?? ''))
  expect(tail.length).toBeGreaterThan(0)
  expect(tail.every(c => c.fg === GRAY_CELL)).toBe(true)
  const dot = decodeCells(String(raster(drawn, 'peeker-dot')?.props?.cells ?? ''))
  expect(dot).toEqual([{ cp: 0x25cf, fg: GRAY_CELL, bg: 0x01000000 }])

  const count = w.blits.length
  await w.clock.advance(2000)
  expect(w.blits.length).toBe(count)
})

test('an interrupted turn reads stopped, a dead one failed', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  await startTurn($)
  await endTurn($, 42_000, 'aborted')
  expect(text(await ui.drawn())).toContain('✗ stopped · 42s')
  await startTurn($)
  await endTurn($, 42_000, 'error')
  expect(text(await ui.drawn())).toContain('✗ failed · 42s')
})

test('a subagent turn changes nothing on the line', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  await startTurn($, 'a1')
  const drawn = await ui.drawn()
  expect(raster(drawn, 'peeker-tail')).toBeUndefined()
  const dot = decodeCells(String(raster(drawn, 'peeker-dot')?.props?.cells ?? ''))
  expect(dot.map(c => c.fg)).toEqual([GRAY_CELL])
  await endTurn($, 5000, 'answer', 'a1')
  expect(raster(await ui.drawn(), 'peeker-tail')).toBeUndefined()
})

test('under Off the plain line still shows the time, and nothing is blitted', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  await ui.drawn()
  await startTurn($)
  const first = text(await ui.drawn())
  expect(first).toContain('● [')
  expect(first.endsWith('0s')).toBe(true)

  await w.clock.advance(1000)
  const later = await ui.drawn()
  expect(text(later).endsWith('1s')).toBe(true)
  expect(rasters(later).length).toBe(0)
  expect(w.blits.length).toBe(0)
})

test('a bar that appears after the first draw fills in from empty', async ($, on) => {
  const w = world(on)
  w.state.limits = false
  const ui = await $.ui.mount(HINT)
  const first = text(await ui.drawn())
  expect(first).not.toContain('5h')
  expect(first).not.toContain('wk')

  w.state.limits = true
  await measure($, w, ['rateLimits'])
  expect(text(await ui.drawn())).toContain('5h')
  await w.clock.advance(100)
  const five = w.blits.filter(b => b.key === 'peeker-five')
  expect(five.length).toBeGreaterThan(0)
  const percent = Number(/(\d+)%/.exec(cellText(decodeCells(five[0]?.cells ?? '')))?.[1])
  expect(percent).toBeLessThan(6)
})

test('the line shows the model and effort of the main loop requests, else the settings', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(HINT)
  expect(text(await ui.drawn())).toContain('[Opus 5.5 ·high]')

  await mainStep($, 'low')
  expect(text(await ui.drawn())).toContain('[Opus 5.5 ·low]')

  // A settings change counts from the next request on: until then the settings show.
  w.state.settings = { effortLevel: 'max' }
  await measure($, w, ['context'])
  expect(text(await ui.drawn())).toContain('[Opus 5.5 ·max]')

  await mainStep($, 32_000)
  expect(text(await ui.drawn())).toContain('[Opus 5.5 ·32K think]')
})

test('without a token count the ctx figure stands alone', async ($, on) => {
  const w = world(on)
  w.state.tokens = false
  const ui = await $.ui.mount(HINT)
  const line = text(await ui.drawn())
  expect(line).toContain('12%')
  expect(line).not.toContain('120K')
})
