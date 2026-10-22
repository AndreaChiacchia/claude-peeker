import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement, RenderNode, Timer } from 'claude-code'

import type { BarId, GitInfo, Motion, Prefs, TimeMode } from '../types'
import { encodeCells } from './cells'
import type { Cell } from './cells'
import { DEMO_END_MS, DEMO_TICK_MS, demoLine, isDemoChangeAt } from './demo'
import { effortLabel, nextTimeMode, parseGitStatus, tone, windowFigures, wordForReason } from './format'
import type { FinishWord } from './format'
import { lineGroups } from './line'
import type { LineData, PieceId, Segment, TurnView } from './line'
import {
  FINISH_MS,
  FRAME_MS,
  IDLE_FRAME_MS,
  IDLE_FRAME_TICKS,
  advance,
  composeBar,
  createMotion,
  frameMsFor,
  freshBar,
  freshRow,
  isActive,
  isBarActive,
  observe,
} from './motion'
import type { MotionState } from './motion'
import { composeDot, composeTail, markDone, tailWidth } from './row'
import type { DotState, TailState } from './row'
import { DEFAULT_PREFS, normalizeSettings } from './styles'

const TICK_MS = 30_000
const GIT_EVERY_MS = 10_000
/** The plain line redraws this often while a turn runs, so the elapsed time ticks. */
const ELAPSED_TICK_MS = 1000
/** The Raster keys are this prefix and the piece id; never claudeticker's `row`. */
const RASTER_PREFIX = 'peeker-'
/** Fresh draws whose first blit was refused before the slot is drawn still. */
const MAX_REFUSED_MOUNTS = 3
const BAR_IDS: readonly BarId[] = ['ctx', 'five', 'week']

function isBarPiece(id: PieceId): id is BarId {
  return id !== 'dot' && id !== 'tail'
}

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

/** The /config settings, read in `register`: a module variable, so /clear and /resume keep them; a /config change reloads the module. */
let settings: Prefs = DEFAULT_PREFS
/** True while a click's reset time format is being written to /config: further clicks wait for it. */
let isTimeWriting = false

// State of the running module. It is lost on a reload by design: the next render rebuilds it.
// `register` resets it, so a module instance shared by several loads starts each one clean.
let motion: MotionState = createMotion()
let level: Motion = 'lively'
let timer: Timer | null = null
/** The running frame timer's period. */
let timerMs = FRAME_MS
/** Redraws the plain line once a second while a turn runs. */
let stillTimer: Timer | null = null
let isBlitting = false
/** One Raster of the line: its id, its width at the render, and its cells at a moment (ms on the demo or the real clock). */
type Piece = { id: PieceId; width: number; compose: (now: number) => Cell[] }
/** The mounted Rasters the timer repaints: the render's request, each piece, and whether a turn is working. */
type Site = { requestId: string; pieces: Piece[]; isLive: boolean }
let site: Site | null = null
/** What each Raster last showed, so an unchanged frame is not sent again. */
const lastBlit = new Map<PieceId, string>()
/** Bars whose last frame drawn or sent had nothing moving in it: until the next render their frame cannot change, so it is not composed again. */
const settledBars = new Set<BarId>()
/** The main loop's running turn; null between turns. */
let turn: { startAt: number } | null = null
/** How the main loop's last turn ended, and when. */
let lastTurn: { word: FinishWord; durationMs: number; at: number } | null = null
/** False until a render has drawn: a bar that appears after that enters with its effects, the first ones are taken silently. */
let primed = false
/** What the main loop's last request sent, and the model/settings basis the line showed when it did. */
let mainStep: { model: string; effort: string | number | null; basis: string | null } | null = null
/** The model/settings basis of the last line drawn: a request counts only while the settings still match it. */
let lastBasis: string | null = null
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

function stopStill(): void {
  stillTimer?.cancel()
  stillTimer = null
}

function ensureStill($: EngineInterface): void {
  if (stillTimer === null) stillTimer = $.clock.every(ELAPSED_TICK_MS, () => $.ui.invalidate('ui.render'))
}

/**
 * Every bar takes its next value silently (no effect fires going into or out of the demo), and no frame
 * of a silenced bar is blitted before the next render mounts the new values.
 */
function silenceBars(): void {
  for (const id of BAR_IDS) motion.bars[id] = freshBar()
  motion.row = freshRow()
  settledBars.clear()
  stopTimer()
  site = null
}

function endDemo($: EngineInterface): void {
  if (demo === null) return
  demo.timer.cancel()
  demo = null
  silenceBars()
  // The real figures come back silently.
  primed = false
  $.ui.invalidate('ui.render')
}

/** A /clear or a resume: the demo ends, the bars take the next values silently, and the last turn is forgotten. */
function forgetSession($: EngineInterface): void {
  endDemo($)
  silenceBars()
  stopStill()
  turn = null
  lastTurn = null
  primed = false
  mainStep = null
  lastBasis = null
  $.ui.invalidate('ui.render')
}

function onDemoTick($: EngineInterface): void {
  if (demo === null) return
  demo.ticks += 1
  const elapsed = demo.ticks * DEMO_TICK_MS
  if (elapsed >= DEMO_END_MS) endDemo($)
  else if (isDemoChangeAt(elapsed)) $.ui.invalidate('ui.render')
}

/** Starts the demo, or restarts it from the beginning when one runs. */
async function startDemo($: EngineInterface): Promise<void> {
  const startedAt = await $.clock.now()
  demo?.timer.cancel()
  demo = { ticks: 0, startedAt, timer: $.clock.every(DEMO_TICK_MS, () => onDemoTick($)) }
  silenceBars()
  // The demo's baseline is taken silently.
  primed = false
  $.ui.invalidate('ui.render')
}

/** True while there are pieces to repaint and something to move in them: a working turn, or an effect before its end. */
function needsTimer(): boolean {
  return site !== null && !isStaticFallback && level !== 'off' && (site.isLive || isActive(motion))
}

/** Starts the frame timer, or changes its period: every frame while an effect plays, every `IDLE_FRAME_MS` while only the dot and the time move. */
function kick($: EngineInterface): void {
  if (!needsTimer()) return
  const ms = frameMsFor(motion)
  if (timer !== null && timerMs === ms) return
  timer?.cancel()
  timerMs = ms
  timer = $.clock.every(ms, () => void step($))
}

/** One frame: the motion advances and each piece's Raster is repainted in place. */
async function step($: EngineInterface): Promise<void> {
  if (isBlitting || site === null) return
  isBlitting = true
  try {
    const target = site
    if (level === 'off') {
      stopTimer()

      return
    }
    // On the slow period one frame stands for IDLE_FRAME_TICKS ticks; nothing rolls then, so each only moves the tick.
    const ticks = timerMs === IDLE_FRAME_MS ? IDLE_FRAME_TICKS : 1
    for (let i = 0; i < ticks; i++) advance(motion)
    // Only a working turn's live time reads the clock; every other piece ignores `now`.
    const now = demo !== null ? demo.ticks * DEMO_TICK_MS : target.isLive ? await $.clock.now() : 0
    // A render replaced the site while the clock was read: its own mount is the newer frame; the timer goes on.
    if (site !== target) return
    for (const piece of target.pieces) {
      if (isBarPiece(piece.id) && settledBars.has(piece.id) && !isBarActive(motion, piece.id)) continue
      const cells = piece.compose(now)
      if (cells.length !== piece.width) {
        // A width change (9% to 10%, a badge appearing or leaving, 9s to 10s) is a redraw, never a blit.
        stopTimer()
        $.ui.invalidate('ui.render')

        return
      }
      const encoded = encodeCells(cells)
      if (isBarPiece(piece.id) && !isBarActive(motion, piece.id)) settledBars.add(piece.id)
      if (encoded === lastBlit.get(piece.id)) continue
      const r = await $.ui.blit({ requestId: target.requestId, key: RASTER_PREFIX + piece.id, cells: encoded })
      if (r.deny === undefined) {
        everBlitted = true
        framesSinceMount += 1
        lastBlit.set(piece.id, encoded)
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
      if (site !== target) return
    }
    if (!needsTimer()) stopTimer()
    else kick($)
  } finally {
    isBlitting = false
  }
}

/** Sets one reset time's format in the module variable and redraws the line. */
function setTimeMode($: EngineInterface, id: 'five' | 'week', mode: TimeMode): void {
  settings = { ...settings, timeModes: { ...settings.timeModes, [id]: mode } }
  $.ui.invalidate('ui.render')
}

/**
 * A click on a reset time: the next format shows at once and is written to its /config row; the write
 * reloads the module, which then reads it from its options.
 */
async function cycleTime($: EngineInterface, id: 'five' | 'week'): Promise<void> {
  if (isTimeWriting) return
  const before = settings.timeModes[id]
  const next = nextTimeMode(before)
  setTimeMode($, id, next)
  isTimeWriting = true
  const key = id === 'five' ? 'claudepeeker.fiveTime' : 'claudepeeker.weekTime'
  const label = id === 'five' ? '5h' : 'weekly'
  try {
    const r = await $.config.set({ key, value: next })
    if (r.deny !== undefined) {
      if (settings.timeModes[id] === next) setTimeMode($, id, before)
      $.ui.toast(`Claude-Peeker: the ${label} reset time stays ${before}: ${r.deny}`)
    }
  } catch {
    if (settings.timeModes[id] === next) setTimeMode($, id, before)
    $.ui.toast(`Claude-Peeker: could not save the ${label} reset time format in /config.`)
  } finally {
    isTimeWriting = false
  }
}

/** The main loop's turn as the line shows it at `now`: working, the done mark for `FINISH_MS`, then the last turn's time. */
function turnView(now: number): TurnView | null {
  if (turn !== null) return { state: 'working', startAt: turn.startAt, elapsedMs: Math.max(0, now - turn.startAt) }
  if (lastTurn === null) return null
  if (now - lastTurn.at < FINISH_MS) return { state: 'done', word: lastTurn.word, durationMs: lastTurn.durationMs }

  return { state: 'idle', durationMs: lastTurn.durationMs }
}

async function lineData($: EngineInterface): Promise<LineData> {
  const [usage, model, root, engineSettings, g, now] = await Promise.all([
    $.session.usage(),
    $.session.model(),
    $.session.root(),
    $.settings.read(),
    read($, git),
    $.clock.now(),
  ])
  // What the main loop's last request sent wins over settings, for as long as the model and settings are those it was sent under.
  const settingsValue = settingsEffort(engineSettings, model)
  const basis = `${model}\n${settingsValue ?? ''}`
  lastBasis = basis
  const fromStep = mainStep !== null && mainStep.basis === basis ? mainStep : null

  return {
    model: fromStep?.model ?? model,
    effort: fromStep === null ? settingsValue : effortLabel(fromStep.effort),
    project: basename(root),
    git: g,
    ctx:
      usage.context.window > 0
        ? {
            window: usage.context.window,
            percent: Math.round(usage.context.percent ?? 0),
            tokens: usage.context.tokens ?? null,
          }
        : null,
    five: windowFigures(usage.rateLimits.find(w => w.kind === 'five_hour'), 5, now),
    week: windowFigures(usage.rateLimits.find(w => w.kind === 'seven_day'), 168, now),
    prefs: settings,
    now,
    offsetMin: -new Date(now).getTimezoneOffset(),
    turn: turnView(now),
  }
}

let isGitRunning = false

async function refreshGit($: EngineInterface): Promise<void> {
  if (isGitRunning) return
  isGitRunning = true
  try {
    let next: GitInfo | null
    try {
      next = await readGit($)
    } catch {
      // A git that cannot start, or outlives its 5 s, leaves the branch as shown.
      return
    }
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
  // One process reports the branch, the changes and the commits ahead (git 2.11 and later); an older git falls through.
  const all = await run('status', '--porcelain=v2', '--branch', '--untracked-files=no')
  if (all.exitCode === 0) return parseGitStatus(all.stdout)
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

/**
 * The line as groups that never shrink, wrapping whole onto the next row when
 * narrow: each group one flow of nested Text (a fragment lays out as a column
 * here), a reset time its own Button. A bar, the dot and the time are each their own piece:
 * `pieceNode` may draw one (as a Raster); without one it stays the same colored Text.
 */
function drawLine(
  $: EngineInterface,
  ui: Ui,
  groups: Segment[][],
  pieceNode?: (id: PieceId) => RenderNode | undefined,
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
    const runs: Segment[][] = []
    for (const s of segments) {
      const last = runs.at(-1)
      if (s.press || !last || last[0]?.press || last[0]?.piece !== s.piece) runs.push([s])
      else last.push(s)
    }

    return (
      <Box flexDirection="row" flexShrink={0}>
        {at > 0 ? <Text dimColor> · </Text> : null}
        {runs.map(one => {
          const id = one[0]?.press
          const piece = one[0]?.piece
          if (piece) return pieceNode?.(piece) ?? run(one)

          return id ? (
            <Button key={`reset-${id}`} plain onPress={() => cycleTime($, id)}>
              {run(one)}
            </Button>
          ) : (
            run(one)
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

export const register: Register = (on, options) => {
  settings = normalizeSettings(options)
  // A fresh load starts from a clean state.
  stopTimer()
  stopStill()
  demo?.timer.cancel()
  demo = null
  motion = createMotion()
  level = settings.motion
  isTimeWriting = false
  isBlitting = false
  site = null
  lastBlit.clear()
  settledBars.clear()
  framesSinceMount = 0
  refusedMounts = 0
  everBlitted = false
  isStaticFallback = false
  turn = null
  lastTurn = null
  primed = false
  mainStep = null
  lastBasis = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'peeker',
      description: "Play the status line's motion demo; the settings are in /config",
      argumentHint: '[demo | demo stop]',
    })
    $.ui.status(undefined)
    // The old, now unused store key: dropped (the settings live in /config).
    void $.store.delete('prefs').catch(() => undefined)
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    $.clock.every(GIT_EVERY_MS, () => void refreshGit($))
    void refreshGit($)
    // A start or a reload ends a demo (a /clear or a resume reaches the line through `session.end`).
    // The first values after a start are taken silently: a cleared context is not a compaction.
    endDemo($)
    motion = createMotion()
    settledBars.clear()
    stopStill()
    turn = null
    lastTurn = null
    primed = false
    mainStep = null
    lastBasis = null
    // A module reloaded by a /config change redraws at once.
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // /clear and /resume fire no `session.start`: the line sees them as the end of the old session.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') forgetSession($)

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
  // The main loop's request also tells the model and effort it runs on: kept for the line (no await before `next`).
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) mainStep = { model: e.model, effort: e.effort ?? null, basis: lastBasis }
    const stream = next(e)
    for await (const chunk of stream) yield chunk
    const result = await stream.result
    $.ui.invalidate('ui.render')

    return result
  })

  // The main loop's turn starts the dot and the time; a subagent's turn changes nothing here.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    turn = { startAt: await $.clock.now() }
    motion.row.doneStart = null
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // The main loop's end: the done mark shows for `FINISH_MS`, then the last turn's time stays.
  on('turn.complete', async ($, e, next) => {
    void refreshGit($)
    const result = await next(e)
    if (e.agentId === undefined) {
      turn = null
      lastTurn = { word: wordForReason(e.reason), durationMs: e.durationMs, at: await $.clock.now() }
      $.ui.invalidate('ui.render')
      $.clock.after(FINISH_MS, () => $.ui.invalidate('ui.render'))
    }

    return result
  })

  on('command.run', { command: 'peeker' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'demo') {
      await startDemo($)
      const off = settings.motion === 'off'

      return {
        text:
          'Playing the motion demo for 20 s on the status line, with made-up figures. /peeker demo stop ends it.' +
          (off ? ' Motion is Off, so the figures change without effects: set Motion to lively or subtle in /config to see them.' : ''),
      }
    }
    if (arg === 'demo stop') {
      if (demo === null) return { text: 'No demo is running.' }
      endDemo($)

      return { text: 'Stopped the demo: the line shows your real usage again.' }
    }

    return {
      text:
        "Claude-Peeker's settings are in /config: each bar's style and width, the reset time formats and Motion. A click on a reset time steps its format. /peeker demo plays the motion tour.",
    }
  })

  // The hint line under the prompt, kept as the engine draws it (its pills stay
  // live), with the status line on the row beneath, where a statusLine script draws.
  // Rows another mod stacked under the hint go after the line, whichever of the two
  // sits above the other.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const [drawn, real] = await Promise.all([next(e), lineData($)])
    // A running demo replaces only the three figures, the tokens and the turn, in this render's local value: real usage is never written.
    const data = demo ? demoLine(real, demo.ticks * DEMO_TICK_MS, demo.startedAt) : real
    const ui = $.ui.resolve(e)
    const [hint, ...below] = stacked(drawn)

    // A changed value starts the bars' effects; a render alone never does. Off, a non-terminal
    // surface and a slot that refuses blits read every value silently and draw the plain line.
    level = data.prefs.motion
    const moving = level !== 'off' && e.surface === 'terminal' && !isStaticFallback ? level : null
    const readings: Partial<Record<BarId, { percent: number; resetsAtMs: number | null; tokens?: number | null }>> = {}
    if (data.ctx) readings.ctx = { percent: data.ctx.percent, resetsAtMs: null, tokens: data.ctx.tokens ?? null }
    if (data.five) readings.five = { percent: data.five.percent, resetsAtMs: data.five.resetsAtMs }
    if (data.week) readings.week = { percent: data.week.percent, resetsAtMs: data.week.resetsAtMs }
    for (const id of BAR_IDS) {
      const reading = readings[id]
      if (reading) observe(motion, id, reading, data.prefs.bars[id], moving ?? 'off', primed)
      else motion.bars[id] = freshBar()
    }
    primed = true

    // The dot follows the main loop's turn; the tail is its time, its finish mark, or the last turn's time.
    const view = data.turn
    const dot: DotState = view?.state === 'working' ? 'working' : 'idle'
    let tail: TailState | null = null
    if (view?.state === 'working') tail = { kind: 'live', elapsedMs: view.elapsedMs }
    else if (view?.state === 'done') {
      tail = {
        kind: 'done',
        word: view.word,
        durationMs: view.durationMs,
        isLean: data.ctx !== null && tone(data.ctx.percent) === 'ok',
      }
    } else if (view?.state === 'idle') tail = { kind: 'idle', durationMs: view.durationMs }
    if (moving !== null && view?.state === 'done') markDone(motion)
    else motion.row.doneStart = null

    let line: RenderNode
    if (moving && e.surface === 'terminal') {
      // Only the terminal surface has a Raster: narrowing `e` here narrows what `resolve` returns.
      const termUi = $.ui.resolve(e)
      const { Raster } = termUi
      stopStill()
      const pieces: Piece[] = []
      const encoded: Partial<Record<PieceId, string>> = {}
      lastBlit.clear()
      settledBars.clear()
      const mount = (id: PieceId, width: number, cells: Cell[], compose: (now: number) => Cell[]): void => {
        const mounted = encodeCells(cells)
        encoded[id] = mounted
        pieces.push({ id, width, compose })
        lastBlit.set(id, mounted)
      }
      mount('dot', 1, composeDot(motion, dot, moving), () => composeDot(motion, dot, moving))
      for (const id of BAR_IDS) {
        if (!readings[id]) continue
        const pref = data.prefs.bars[id]
        const cells = composeBar(motion, id, pref, moving)
        if (!isBarActive(motion, id)) settledBars.add(id)
        mount(id, cells.length, cells, () => composeBar(motion, id, pref, moving))
      }
      if (tail !== null) {
        const shown = tail
        const startAt = view?.state === 'working' ? view.startAt : 0
        mount('tail', tailWidth(shown), composeTail(motion, shown, moving), at =>
          composeTail(
            motion,
            shown.kind === 'live' ? { kind: 'live', elapsedMs: Math.max(0, at - startAt) } : shown,
            moving,
          ),
        )
      }
      const widths = new Map(pieces.map(p => [p.id, p.width] as const))
      site = { requestId: e.requestId, pieces, isLive: dot === 'working' }
      framesSinceMount = 0
      line = drawLine($, termUi, lineGroups(data), id => {
        const cells = encoded[id]
        const width = widths.get(id)

        return cells === undefined || width === undefined ? undefined : (
          <Raster key={RASTER_PREFIX + id} columns={width} rows={1} cells={cells} />
        )
      })
      kick($)
    } else {
      stopTimer()
      site = null
      line = drawLine($, ui, lineGroups(data))
      if (dot === 'working') ensureStill($)
      else stopStill()
    }

    return (
      <ui.Box flexDirection="column">
        {hint}
        {line}
        {below}
      </ui.Box>
    )
  })
}
