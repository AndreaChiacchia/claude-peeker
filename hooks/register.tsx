import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement, RenderNode } from 'claude-code'

import type { BarId, GitInfo, Prefs } from '../types'
import { nextTimeMode, resetLabel, tone, windowFigures } from './format'
import { GRAY, TONES, lineGroups } from './line'
import type { LineData, Segment } from './line'
import { BARS, DEFAULT_PREFS, STYLES, WIDTHS, drawBar, normalizePrefs, styleOf } from './styles'
import type { BarPart } from './styles'

const PANE = 'peeker-bars'
const STORE_KEY = 'prefs'
const TICK_MS = 30_000
const GIT_EVERY_MS = 10_000

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
 * here), a reset time its own Button.
 */
function drawLine($: EngineInterface, ui: Ui, groups: Segment[][]) {
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
      if (s.press || !last || last[0]?.press) pieces.push([s])
      else last.push(s)
    }

    return (
      <Box flexDirection="row" flexShrink={0}>
        {at > 0 ? <Text dimColor> · </Text> : null}
        {pieces.map(piece => {
          const id = piece[0]?.press
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
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)
    if (stored !== undefined) await update($, prefs, () => normalizePrefs(stored))
    await $.command.register({
      name: 'peeker',
      description: 'Pick the style and width of each status line progress bar',
      argumentHint: '[5h | wk]',
    })
    $.ui.status(undefined)
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    $.clock.every(GIT_EVERY_MS, () => void refreshGit($))
    void refreshGit($)

    return next(e)
  })

  // The engine measures usage after each response: the line follows the context and the limits.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    $.ui.invalidate('ui.render')

    return result
  })

  on('turn.complete', async ($, e, next) => {
    void refreshGit($)

    return next(e)
  })

  on('command.run', { command: 'peeker' }, async ($, e) => {
    const arg = e.args.trim()
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
    const [drawn, data] = await Promise.all([next(e), lineData($)])
    const ui = $.ui.resolve(e)
    const [hint, ...below] = stacked(drawn)

    return (
      <ui.Box flexDirection="column">
        {hint}
        {drawLine($, ui, lineGroups(data))}
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
