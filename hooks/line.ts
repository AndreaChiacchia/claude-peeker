// The status line as groups of colored segments, ported from statusline-command.js.

import type { BarId, GitInfo, Prefs } from '../types'
import { formatTokens, modelLabel, resetLabel, tone } from './format'
import type { Tone, WindowFigures } from './format'
import { drawBar, styleOf } from './styles'

// The old script's ANSI 256 colors, as the xterm palette's hex.
export const ORANGE = '#ffaf00' // 214
export const CYAN = '#00ffff' // 51
export const YELLOW = '#ffff00' // 226
export const RED = '#ff0000' // 196
export const GRAY = '#585858' // 240
export const TONES: Record<Tone, string> = { ok: '#5fff00', warn: '#ffd700', hot: RED }

export type Segment = {
  text: string
  color?: string
  bold?: boolean
  /** The reset time a press on this segment cycles. */
  press?: 'five' | 'week'
}

export type LineData = {
  model: string
  effort: string | null
  project: string
  git: GitInfo | null
  /** Absent before the session knows its window. */
  ctx: { window: number; percent: number } | null
  five: WindowFigures | null
  week: WindowFigures | null
  prefs: Prefs
  now: number
  /** The local zone's offset east of UTC, in minutes. */
  offsetMin: number
}

function bar(prefs: Prefs, id: BarId, percent: number): Segment[] {
  const col = TONES[tone(percent)]
  const cells = drawBar(prefs.bars[id], percent).map(part => ({
    text: part.text,
    color: part.kind === 'fill' ? col : GRAY,
  }))
  const figure = { text: `${percent}%`, color: col }

  return styleOf(prefs.bars[id].style).id === 'none' ? [figure] : [...cells, { text: ' ' }, figure]
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
  const model: Segment[] = [{ text: `[${modelLabel(d.model)}`, color: ORANGE, bold: true }]
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
      ...bar(d.prefs, 'ctx', d.ctx.percent),
    ])
  }
  if (d.five) groups.push(windowGroup(d, 'five', '5h', d.five))
  if (d.week) groups.push(windowGroup(d, 'week', 'wk', d.week))

  return groups
}
