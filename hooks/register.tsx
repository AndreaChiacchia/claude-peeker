import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement, RenderNode, Timer } from 'claude-code'

import type { BarId, BarPref, GitInfo, Motion, Prefs } from '../types'
import { encodeCells } from './cells'
import { DEMO_END_MS, DEMO_TICK_MS, demoFrameAt, demoLine } from './demo'
import { nextTimeMode, resetLabel, tone, windowFigures } from './format'
import { GRAY, TONES, lineGroups } from './line'
import type { LineData, Segment } from './line'
import { FRAME_MS, advance, composeBar, createMotion, freshBar, isActive, observe } from './motion'
import type { MotionState } from './motion'
import {
  BARS,
  DEFAULT_PREFS,
  MOTIONS,
  MOTION_LABELS,
  STYLES,
  WIDTHS,
  drawBar,
  normalizePrefs,
  styleOf,
} from './styles'
import type { BarPart } from './styles'

const PANE = 'peeker-bars'
const STORE_KEY = 'prefs'
const TICK_MS = 30_000
const GIT_EVERY_MS = 10_000
/** The Raster keys are this prefix and the bar id; never claudeticker's `row`. */
const RASTER_PREFIX = 'peeker-'
/** Fresh draws whose first blit was refused before the slot is drawn still. */
const MAX_REFUSED_MOUNTS = 3
const BAR_IDS: readonly BarId[] = ['ctx', 'five', 'week']

const prefs = atom({ plugin: 'claudepeeker', key: 'prefs' } as const, DEFAULT_PREFS)
const git = atom({ plugin: 'claudepeeker', key: 'git' } as const, null)

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type Settings = { effortLevel?: unknown; modelSettings?: Record<string, { effortLevel?: unknown } | undefined> }

/** The effort in force, as settings hold it: the model's own, else the global one. */
function settingsEffort(settings: unknown, model: string): string | null {
  const s = (settings ?? {}) as Settings
  const id = model.replace(/\[[^\]]*\]$/, '').trim()
  const own = s.modelSettings?.[id]?.effortLevel
  if (typeof own === 'string') return own

  return typeof s.effortLevel === 'string' ? s.effortLevel : null
}

async function savePrefs($: EngineInterface, change: (p: Prefs) => Prefs): Promise<void> {
  await update($, prefs, change)
  await $.store.set(STORE_KEY, await read($, prefs))
}

// State of the running module. It is lost on a reload by design: the next render rebuilds it.
// `register` resets it, so a module instance shared by several loads starts each one clean.
let motion: MotionState = createMotion()
let level: Motion = 'lively'
let timer: Timer | null = null
let isBlitting = false
/** The mounted Rasters the timer repaints: the render's request and each bar's preference and width. */
type Site = { requestId: string; bars: Partial<Record<BarId, { pref: BarPref; width: number }>> }
let site: Site | null = null
/** What each Raster last showed, so an unchanged frame is not sent again. */
const lastBlit = new Map<BarId, string>()
/** Blits accepted since the last render that drew the Rasters. */
let framesSinceMount = 0
/** Fresh draws whose first blit was refused, while no blit has ever been accepted. */
let refusedMounts = 0
let everBlitted = false
/** Set when this slot keeps refusing the first blit: the bars are drawn still from then on. */
let isStaticFallback = false
/** The running `/peeker demo`: counted in its own ticks, so it is deterministic. */
type Demo = { ticks: number; startedAt: number; timer: Timer }
let demo: Demo | null = null

function stopTimer(): void {
  timer?.cancel()
  timer = null
}

/**
 * Every bar takes its next value silently (no effect fires going into or out of the demo), and no frame
 * of a silenced bar is blitted before the next render mounts the new values.
 */
function silenceBars(): void {
  for (const id of BAR_IDS) motion.bars[id] = freshBar()
  stopTimer()
  site = null
}

function endDemo($: EngineInterface): void {
  if (demo === null) return
  demo.timer.cancel()
  demo = null
  silenceBars()
  $.ui.invalidate('ui.render')
}

function onDemoTick($: EngineInterface): void {
  if (demo === null) return
  demo.ticks += 1
  const elapsed = demo.ticks * DEMO_TICK_MS
  if (elapsed >= DEMO_END_MS) endDemo($)
  else if (demoFrameAt(elapsed) !== demoFrameAt(elapsed - DEMO_TICK_MS)) $.ui.invalidate('ui.render')
}

/** Starts the demo, or restarts it from the beginning when one runs. */
async function startDemo($: EngineInterface): Promise<void> {
  const startedAt = await $.clock.now()
  demo?.timer.cancel()
  demo = { ticks: 0, startedAt, timer: $.clock.every(DEMO_TICK_MS, () => onDemoTick($)) }
  silenceBars()
  $.ui.invalidate('ui.render')
}

/** True while there are bars to repaint and something to move in them. */
function needsTimer(): boolean {
  return site !== null && !isStaticFallback && level !== 'off' && isActive(motion)
}

function kick($: EngineInterface): void {
  if (timer === null && needsTimer()) timer = $.clock.every(FRAME_MS, () => void step($))
}

/** One frame: the motion advances and each bar's Raster is repainted in place. */
async function step($: EngineInterface): Promise<void> {
  if (isBlitting || site === null) return
  isBlitting = true
  try {
    const target = site
    if (level === 'off') {
      stopTimer()

      return
    }
    advance(motion)
    for (const id of BAR_IDS) {
      const one = target.bars[id]
      if (one === undefined) continue
      const cells = composeBar(motion, id, one.pref, level)
      if (cells.length !== one.width) {
        // A width change (9% to 10%, a badge appearing or leaving) is a redraw, never a blit.
        stopTimer()
        $.ui.invalidate('ui.render')

        return
      }
      const encoded = encodeCells(cells)
      if (encoded === lastBlit.get(id)) continue
      const r = await $.ui.blit({ requestId: target.requestId, key: RASTER_PREFIX + id, cells: encoded })
      if (r.deny === undefined) {
        everBlitted = true
        framesSinceMount += 1
        lastBlit.set(id, encoded)
      } else if (framesSinceMount === 0 && !everBlitted) {
        // The first blit after a fresh draw was refused: this slot may not take blits. A fresh mount retries.
        refusedMounts += 1
        stopTimer()
        if (refusedMounts >= MAX_REFUSED_MOUNTS) {
          isStaticFallback = true
          site = null
        }
        $.ui.invalidate('ui.render')

        return
      } else {
        // Refused after earlier successes (a dialog, a resize, the prompt hidden): a later render restarts the timer.
        stopTimer()

        return
      }
    }
    if (!needsTimer()) stopTimer()
  } finally {
    isBlitting = false
  }
}

const cycleTime = ($: EngineInterface, id: 'five' | 'week') =>
  savePrefs($, old => ({ ...old, timeModes: { ...old.timeModes, [id]: nextTimeMode(old.timeModes[id]) } }))

async function lineData($: EngineInterface): Promise<LineData> {
  const [usage, model, root, settings, p, g, now] = await Promise.all([
    $.session.usage(),
    $.session.model(),
    $.session.root(),
    $.settings.read(),
    read($, prefs),
    read($, git),
    $.clock.now(),
  ])

  return {
    model,
    effort: settingsEffort(settings, model),
    project: basename(root),
    git: g,
    ctx:
      usage.context.window > 0
        ? { window: usage.context.window, percent: Math.round(usage.context.percent ?? 0) }
        : null,
    five: windowFigures(usage.rateLimits.find(w => w.kind === 'five_hour'), 5, now),
    week: windowFigures(usage.rateLimits.find(w => w.kind === 'seven_day'), 168, now),
    prefs: p,
    now,
    offsetMin: -new Date(now).getTimezoneOffset(),
  }
}

let isGitRunning = false

async function refreshGit($: EngineInterface): Promise<void> {
  if (isGitRunning) return
  isGitRunning = true
  try {
    const next = await readGit($)
    const now = await read($, git)
    if (now?.branch !== next?.branch || now?.mark !== next?.mark) await update($, git, () => next)
  } finally {
    isGitRunning = false
  }
}

async function readGit($: EngineInterface): Promise<GitInfo | null> {
  if ((await $.session.repo()) === null) return null
  const root = await $.session.root()
  const run = (...args: string[]) =>
    $.process.run(['git', '-C', root, '--no-optional-locks', ...args], { timeoutMs: 5000 })
  const head = await run('rev-parse', '--abbrev-ref', 'HEAD')
  if (head.exitCode !== 0) return null
  const branch = head.stdout.trim()
  const status = await run('status', '--porcelain', '--untracked-files=no')
  if (status.exitCode === 0 && status.stdout.trim() !== '') return { branch, mark: 'dirty' }
  const ahead = await run('rev-list', '--count', '@{u}..HEAD')
  const count = ahead.exitCode === 0 ? parseInt(ahead.stdout.trim(), 10) || 0 : 0

  return { branch, mark: count > 0 ? 'ahead' : '' }
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

/** The rows of a column another mod stacked under the hint, the hint first; else the hint alone. */
function stacked(drawn: RenderElement): RenderNode[] {
  if (drawn.type === 'Box' && drawn.props?.flexDirection === 'column' && drawn.children?.length) {
    return [...drawn.children]
  }

  return [drawn]
}

function partColor(part: BarPart, percent: number): string {
  return part.kind === 'fill' ? TONES[tone(percent)] : GRAY
}

/** The item `by` steps from `at`, wrapping round the list. */
function cycle<T>(list: readonly T[], at: T, by: 1 | -1): T {
  const i = list.indexOf(at)

  return list[(i + by + list.length) % list.length] ?? at
}

/**
 * The line as groups that never shrink, wrapping whole onto the next row when
 * narrow: each group one flow of nested Text (a fragment lays out as a column
 * here), a reset time its own Button. A bar is its own piece: `barNode` may draw it
 * (as a Raster); without one it stays the same colored Text.
 */
function drawLine(
  $: EngineInterface,
  ui: Ui,
  groups: Segment[][],
  barNode?: (id: BarId) => RenderNode | undefined,
) {
  const { Box, Text, Button } = ui
  const run = (segments: Segment[]) => (
    <Text>
      {segments.map(s => (
        <Text color={s.color} dimColor={s.color === undefined} bold={s.bold}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
  const group = (segments: Segment[], at: number) => {
    const pieces: Segment[][] = []
    for (const s of segments) {
      const last = pieces.at(-1)
      if (s.press || !last || last[0]?.press || last[0]?.bar !== s.bar) pieces.push([s])
      else last.push(s)
    }

    return (
      <Box flexDirection="row" flexShrink={0}>
        {at > 0 ? <Text dimColor> · </Text> : null}
        {pieces.map(piece => {
          const id = piece[0]?.press
          const bar = piece[0]?.bar
          if (bar) return barNode?.(bar) ?? run(piece)

          return id ? (
            <Button key={`reset-${id}`} plain onPress={() => cycleTime($, id)}>
              {run(piece)}
            </Button>
          ) : (
            run(piece)
          )
        })}
      </Box>
    )
  }

  return (
    <Box flexDirection="row" flexWrap="wrap">
      {groups.map(group)}
    </Box>
  )
}

export const register: Register = on => {
  // A fresh load starts from a clean state.
  stopTimer()
  demo?.timer.cancel()
  demo = null
  motion = createMotion()
  level = 'lively'
  isBlitting = false
  site = null
  lastBlit.clear()
  framesSinceMount = 0
  refusedMounts = 0
  everBlitted = false
  isStaticFallback = false

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)
    if (stored !== undefined) await update($, prefs, () => normalizePrefs(stored))
    await $.command.register({
      name: 'peeker',
      description: 'Pick the style and width of each status line bar, and how the bars move',
      argumentHint: '[5h | wk | demo]',
    })
    $.ui.status(undefined)
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    $.clock.every(GIT_EVERY_MS, () => void refreshGit($))
    void refreshGit($)
    // A /clear or a resume ends a demo. The first values after a start or a /clear are taken
    // silently: a cleared context is not a compaction.
    endDemo($)
    motion = createMotion()

    return next(e)
  })

  // The engine measures usage after each response: the line follows the context and the limits.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    $.ui.invalidate('ui.render')

    return result
  })

  // The usage moves with every model response, not only at the end of a turn: the line follows
  // each one. The streamed chunks and the result pass through unchanged.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    for await (const chunk of stream) yield chunk
    const result = await stream.result
    $.ui.invalidate('ui.render')

    return result
  })

  on('turn.complete', async ($, e, next) => {
    void refreshGit($)

    return next(e)
  })

  on('command.run', { command: 'peeker' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'demo') {
      await startDemo($)
      const off = (await read($, prefs)).motion === 'off'

      return {
        text:
          'Playing the motion demo for 20 s on the status line, with made-up figures. /peeker demo stop ends it.' +
          (off ? ' Motion is Off, so the figures change without effects: pick Lively or Subtle in /peeker to see them.' : ''),
      }
    }
    if (arg === 'demo stop') {
      if (demo === null) return { text: 'No demo is running.' }
      endDemo($)

      return { text: 'Stopped the demo: the line shows your real usage again.' }
    }
    if (arg === '5h' || arg === 'wk') {
      const id = arg === '5h' ? 'five' : 'week'
      await cycleTime($, id)
      return { text: `The ${arg} reset time now reads ${(await read($, prefs)).timeModes[id]}.` }
    }
    await $.ui.open({ id: PANE, title: 'Bar styles', focus: true, closeOnEscape: true })

    return { text: 'Opened the bar styles panel.' }
  })

  // The hint line under the prompt, kept as the engine draws it (its pills stay
  // live), with the status line on the row beneath, where a statusLine script draws.
  // Rows another mod stacked under the hint go after the line, whichever of the two
  // sits above the other.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const [drawn, real] = await Promise.all([next(e), lineData($)])
    // A running demo replaces only the three figures, in this render's local value: real usage is never written.
    const data = demo ? demoLine(real, demo.ticks * DEMO_TICK_MS, demo.startedAt) : real
    const ui = $.ui.resolve(e)
    const [hint, ...below] = stacked(drawn)

    // A changed value starts the bars' effects; a render alone never does. Off, a non-terminal
    // surface and a slot that refuses blits read every value silently and draw the plain line.
    level = data.prefs.motion
    const moving = level !== 'off' && e.surface === 'terminal' && !isStaticFallback ? level : null
    const readings: Partial<Record<BarId, { percent: number; resetsAtMs: number | null }>> = {}
    if (data.ctx) readings.ctx = { percent: data.ctx.percent, resetsAtMs: null }
    if (data.five) readings.five = { percent: data.five.percent, resetsAtMs: data.five.resetsAtMs }
    if (data.week) readings.week = { percent: data.week.percent, resetsAtMs: data.week.resetsAtMs }
    for (const id of BAR_IDS) {
      const reading = readings[id]
      if (reading) observe(motion, id, reading, data.prefs.bars[id], moving ?? 'off')
      else motion.bars[id] = freshBar()
    }

    let line: RenderNode
    if (moving && e.surface === 'terminal') {
      // Only the terminal surface has a Raster: narrowing `e` here narrows what `resolve` returns.
      const termUi = $.ui.resolve(e)
      const { Raster } = termUi
      const bars: Site['bars'] = {}
      const encoded: Partial<Record<BarId, string>> = {}
      lastBlit.clear()
      for (const id of BAR_IDS) {
        if (!readings[id]) continue
        const pref = data.prefs.bars[id]
        const cells = composeBar(motion, id, pref, moving)
        const mounted = encodeCells(cells)
        encoded[id] = mounted
        bars[id] = { pref, width: cells.length }
        lastBlit.set(id, mounted)
      }
      site = { requestId: e.requestId, bars }
      framesSinceMount = 0
      line = drawLine($, termUi, lineGroups(data), id => {
        const cells = encoded[id]
        const width = bars[id]?.width

        return cells === undefined || width === undefined ? undefined : (
          <Raster key={RASTER_PREFIX + id} columns={width} rows={1} cells={cells} />
        )
      })
      kick($)
    } else {
      stopTimer()
      site = null
      line = drawLine($, ui, lineGroups(data))
    }

    return (
      <ui.Box flexDirection="column">
        {hint}
        {line}
        {below}
      </ui.Box>
    )
  })

  // The panel: per bar, its live preview and ‹ › arrows stepping its style and width.
  // Buttons, not Selects: a Button takes a click anywhere on it, a Select only on its caret.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [p, usage, now] = await Promise.all([read($, prefs), $.session.usage(), $.clock.now()])
    const five = windowFigures(usage.rateLimits.find(w => w.kind === 'five_hour'), 5, now)
    const week = windowFigures(usage.rateLimits.find(w => w.kind === 'seven_day'), 168, now)
    const live: Record<BarId, number> = {
      ctx: Math.round(usage.context.percent ?? 0),
      five: five?.percent ?? 0,
      week: week?.percent ?? 0,
    }
    const offsetMin = -new Date(now).getTimezoneOffset()
    const when = (id: 'five' | 'week', at: number | null | undefined) =>
      at == null ? '–' : resetLabel(at, now, p.timeModes[id], offsetMin)
    const setBar = (id: BarId, change: Partial<Prefs['bars'][BarId]>) =>
      savePrefs($, old => ({ ...old, bars: { ...old.bars, [id]: { ...old.bars[id], ...change } } }))
    const preview = (id: BarId) => (
      <Text>
        {drawBar(p.bars[id], live[id]).map(part => (
          <Text color={partColor(part, live[id])}>{part.text}</Text>
        ))}
        <Text color={TONES[tone(live[id])]}> {live[id]}%</Text>
      </Text>
    )
    const stepper = (key: string, value: string, step: (by: 1 | -1) => void, isOff = false) => (
      <Box flexDirection="row" flexShrink={0}>
        <Button key={`${key}-prev`} plain dimColor={isOff} onPress={() => step(-1)}>
          ‹
        </Button>
        <Text dimColor={isOff}> {value} </Text>
        <Button key={`${key}-next`} plain dimColor={isOff} onPress={() => step(1)}>
          ›
        </Button>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {BARS.map(({ id, label }) => {
          const style = styleOf(p.bars[id].style)
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Box flexDirection="row">
                <Text bold>{label.padEnd(4)}</Text>
                {preview(id)}
              </Box>
              <Box flexDirection="row" flexWrap="wrap" columnGap={2} paddingLeft={4}>
                {stepper(`style-${id}`, style.name, by => setBar(id, { style: cycle(STYLES, style, by).id }))}
                {stepper(
                  `width-${id}`,
                  style.isGlyph ? '1 cell' : `${p.bars[id].width} cells`,
                  by => setBar(id, { width: cycle(WIDTHS, p.bars[id].width, by) }),
                  style.isGlyph,
                )}
              </Box>
            </Box>
          )
        })}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text bold>Reset</Text>
          <Button key="time-five" plain onPress={() => cycleTime($, 'five')}>
            {`5h ${when('five', five?.resetsAtMs)}`}
          </Button>
          <Button key="time-week" plain onPress={() => cycleTime($, 'week')}>
            {`wk ${when('week', week?.resetsAtMs)}`}
          </Button>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text bold>Motion</Text>
          {stepper('motion', MOTION_LABELS[p.motion], by =>
            savePrefs($, old => ({ ...old, motion: cycle(MOTIONS, old.motion, by) })),
          )}
        </Box>
        <Box flexDirection="row" marginTop={1} columnGap={1}>
          <Button key="reset" onPress={() => savePrefs($, old => ({ ...old, bars: DEFAULT_PREFS.bars }))}>
            Reset bars
          </Button>
          <Button key="close" role="dismiss" onPress={() => $.ui.close({ id: PANE })}>
            Close
          </Button>
        </Box>
        <Text dimColor>Click ‹ › or a time to change it.</Text>
      </Box>
    )
  })
}
