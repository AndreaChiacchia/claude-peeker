// The status line as groups of colored segments, ported from statusline-command.js.

import type { BarId, GitInfo, Prefs } from '../types'
import { doneText, formatElapsed, formatTokens, modelLabel, resetLabel, tone } from './format'
import type { FinishWord, Tone, WindowFigures } from './format'
import { drawBar, styleOf } from './styles'

// The old script's ANSI 256 colors, as the xterm palette's hex.
export const ORANGE = '#ffaf00' // 214
export const CYAN = '#00ffff' // 51
export const YELLOW = '#ffff00' // 226
export const RED = '#ff0000' // 196
export const GRAY = '#585858' // 240
export const TONES: Record<Tone, string> = { ok: '#5fff00', warn: '#ffd700', hot: RED }
/** The working dot's lavender: the text twin of `cells.LIVE`. */
export const LAVENDER = '#afafd7'

/** The animated pieces of the line: the three bars, the state dot and the time at the end. */
export type PieceId = BarId | 'dot' | 'tail'

export type Segment = {
  text: string
  color?: string
  bold?: boolean
  /** The reset time a press on this segment cycles. */
  press?: 'five' | 'week'
  /** The animated piece this segment draws; such segments are drawn as one Raster when animated. */
  piece?: PieceId
}

/** The main loop's turn as the line shows it. `startAt` is on the clock the frame timer uses: the real clock, or demo ms during the demo. */
export type TurnView =
  | { state: 'working'; startAt: number; elapsedMs: number }
  | { state: 'done'; word: FinishWord; durationMs: number }
  | { state: 'idle'; durationMs: number }

export type LineData = {
  model: string
  effort: string | null
  project: string
  git: GitInfo | null
  /** Absent before the session knows its window; `tokens` is absent while the engine reports no count. */
  ctx: { window: number; percent: number; tokens?: number | null } | null
  five: WindowFigures | null
  week: WindowFigures | null
  prefs: Prefs
  now: number
  /** The local zone's offset east of UTC, in minutes. */
  offsetMin: number
  /** Null before the first turn of the session. */
  turn: TurnView | null
}

function bar(prefs: Prefs, id: BarId, percent: number, tokens?: number | null): Segment[] {
  const col = TONES[tone(percent)]
  const cells: Segment[] = drawBar(prefs.bars[id], percent).map(part => ({
    text: part.text,
    color: part.kind === 'fill' ? col : GRAY,
    piece: id,
  }))
  const figure: Segment = { text: `${percent}%`, color: col, piece: id }
  const count: Segment[] =
    typeof tokens === 'number' ? [{ text: ' · ', piece: id }, { text: formatTokens(tokens), piece: id }] : []

  return styleOf(prefs.bars[id].style).id === 'none'
    ? [figure, ...count]
    : [...cells, { text: ' ', piece: id }, figure, ...count]
}

function windowGroup(d: LineData, id: 'five' | 'week', label: string, f: WindowFigures): Segment[] {
  const when = f.resetsAtMs === null ? '' : resetLabel(f.resetsAtMs, d.now, d.prefs.timeModes[id], d.offsetMin)
  const group: Segment[] = [{ text: `${label} ` }]
  if (when) group.push({ text: `(${when})`, color: GRAY, press: id }, { text: ' ' })
  group.push(...bar(d.prefs, id, f.percent))
  if (f.delta !== null) {
    group.push(
      { text: ' [' },
      { text: f.delta >= 0 ? `+${f.delta}%` : `${f.delta}%`, color: f.delta >= 0 ? TONES.ok : RED },
      { text: ']' },
    )
  }

  return group
}

/** The line's groups, joined by ` · ` when drawn. */
export function lineGroups(d: LineData): Segment[][] {
  const groups: Segment[][] = []
  const model: Segment[] = [
    { text: '●', color: d.turn?.state === 'working' ? LAVENDER : GRAY, piece: 'dot' },
    { text: ' ' },
    { text: `[${modelLabel(d.model)}`, color: ORANGE, bold: true },
  ]
  if (d.effort) model.push({ text: ` ·${d.effort}`, color: CYAN, bold: true })
  model.push({ text: ']', color: ORANGE, bold: true })
  groups.push(model)
  if (d.project && d.git) {
    const project: Segment[] = [{ text: `${d.project}/${d.git.branch}` }]
    if (d.git.mark !== '') project.push({ text: '*', color: d.git.mark === 'dirty' ? RED : YELLOW })
    groups.push(project)
  } else if (d.project) {
    groups.push([{ text: d.project }])
  }
  if (d.ctx) {
    groups.push([
      { text: 'ctx ' },
      { text: `(${formatTokens(d.ctx.window)})`, color: GRAY },
      { text: ' ' },
      ...bar(d.prefs, 'ctx', d.ctx.percent, d.ctx.tokens),
    ])
  }
  if (d.five) groups.push(windowGroup(d, 'five', '5h', d.five))
  if (d.week) groups.push(windowGroup(d, 'week', 'wk', d.week))
  const turn = d.turn
  if (turn !== null) {
    if (turn.state === 'working') groups.push([{ text: formatElapsed(turn.elapsedMs), piece: 'tail' }])
    else if (turn.state === 'done') groups.push([{ text: doneText(turn.word, turn.durationMs), piece: 'tail' }])
    else groups.push([{ text: formatElapsed(turn.durationMs), color: GRAY, piece: 'tail' }])
  }

  return groups
}
