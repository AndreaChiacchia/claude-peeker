// The progress bar styles, each drawn as runs of fill, track and frame text.

import type { BarId, BarPref, Prefs } from '../types'

export type BarPart = { kind: 'fill' | 'track' | 'frame'; text: string }

type Cells = { fill: string; track: string; open?: string; close?: string; head?: string }

export type BarStyle = {
  id: string
  name: string
  /** One glyph whatever the width: the width picker does not apply. */
  isGlyph?: boolean
  draw: (percent: number, width: number) => BarPart[]
}

/** Filled cells as the old script counted them: rounded, at least one above 0%. */
export function filledCells(percent: number, width: number): number {
  let filled = Math.floor((percent * width + 50) / 100)
  if (filled === 0 && percent > 0) filled = 1

  return Math.max(0, Math.min(filled, width))
}

function cells({ fill, track, open, close, head }: Cells): BarStyle['draw'] {
  return (percent, width) => {
    const filled = filledCells(percent, width)
    const parts: BarPart[] = []
    if (open) parts.push({ kind: 'frame', text: open })
    if (head && filled > 0 && filled < width) {
      parts.push({ kind: 'fill', text: fill.repeat(filled - 1) + head })
    } else {
      parts.push({ kind: 'fill', text: fill.repeat(filled) })
    }
    parts.push({ kind: 'track', text: track.repeat(width - filled) })
    if (close) parts.push({ kind: 'frame', text: close })

    return parts.filter(part => part.text !== '')
  }
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

function smooth(track: string): BarStyle['draw'] {
  return (percent, width) => {
    let eighths = Math.round((Math.min(percent, 100) * width * 8) / 100)
    if (eighths === 0 && percent > 0) eighths = 1
    const full = Math.floor(eighths / 8)
    const part = EIGHTHS[eighths % 8] ?? ''
    const rest = width - full - (part ? 1 : 0)

    return [
      { kind: 'fill' as const, text: '█'.repeat(full) + part },
      { kind: 'track' as const, text: track.repeat(Math.max(0, rest)) },
    ].filter(one => one.text !== '')
  }
}

function glyph(steps: string): BarStyle['draw'] {
  const list = [...steps]
  return percent => {
    const clamped = Math.max(0, Math.min(percent, 100))
    let at = Math.round((clamped / 100) * (list.length - 1))
    if (at === 0 && percent > 0) at = 1

    return [{ kind: 'fill', text: list[at] ?? '' }]
  }
}

export const STYLES: readonly BarStyle[] = [
  { id: 'blocks', name: 'Blocks', draw: cells({ fill: '█', track: '░' }) },
  { id: 'parallelogram', name: 'Parallelogram', draw: cells({ fill: '▰', track: '▱' }) },
  { id: 'shade', name: 'Shade', draw: cells({ fill: '▓', track: '░' }) },
  { id: 'solid', name: 'Solid track', draw: cells({ fill: '█', track: '█' }) },
  { id: 'smooth', name: 'Smooth', draw: smooth('░') },
  { id: 'smooth-bare', name: 'Smooth, bare', draw: smooth(' ') },
  { id: 'line', name: 'Line', draw: cells({ fill: '━', track: '─' }) },
  { id: 'dots', name: 'Dots', draw: cells({ fill: '●', track: '○' }) },
  { id: 'squares', name: 'Squares', draw: cells({ fill: '■', track: '□' }) },
  { id: 'diamonds', name: 'Diamonds', draw: cells({ fill: '◆', track: '◇' }) },
  { id: 'braille', name: 'Braille', draw: cells({ fill: '⣿', track: '⣀' }) },
  { id: 'ascii', name: 'ASCII', draw: cells({ fill: '#', track: '-', open: '[', close: ']' }) },
  { id: 'arrow', name: 'Arrow', draw: cells({ fill: '=', track: ' ', head: '>', open: '[', close: ']' }) },
  { id: 'pie', name: 'Pie', isGlyph: true, draw: glyph('○◔◑◕●') },
  { id: 'spark', name: 'Spark', isGlyph: true, draw: glyph(' ▁▂▃▄▅▆▇█') },
  { id: 'none', name: 'Hidden (percent only)', isGlyph: true, draw: () => [] },
]

export const WIDTHS: readonly number[] = [3, 4, 5, 6, 8, 10, 12, 15, 20]

export const BARS: readonly { id: BarId; label: string }[] = [
  { id: 'ctx', label: 'ctx' },
  { id: 'five', label: '5h' },
  { id: 'week', label: 'wk' },
]

export const DEFAULT_PREFS: Prefs = {
  bars: {
    ctx: { style: 'parallelogram', width: 5 },
    five: { style: 'blocks', width: 5 },
    week: { style: 'blocks', width: 5 },
  },
  timeModes: { five: 'rel', week: 'rel' },
}

export function styleOf(id: string): BarStyle {
  return STYLES.find(style => style.id === id) ?? STYLES[0]!
}

export function drawBar(pref: BarPref, percent: number): BarPart[] {
  return styleOf(pref.style).draw(percent, pref.width)
}

/** A stored value read back over the defaults, so a renamed style or a missing field never breaks a draw. */
export function normalizePrefs(raw: unknown): Prefs {
  const value = (raw ?? {}) as Partial<Prefs>
  const bar = (id: BarId): BarPref => {
    const one = value.bars?.[id]
    const style = one && STYLES.some(s => s.id === one.style) ? one.style : DEFAULT_PREFS.bars[id].style
    const width = one && WIDTHS.includes(one.width) ? one.width : DEFAULT_PREFS.bars[id].width

    return { style, width }
  }
  const mode = (m: unknown) => (m === 'clock' || m === 'date' ? m : 'rel')

  return {
    bars: { ctx: bar('ctx'), five: bar('five'), week: bar('week') },
    timeModes: { five: mode(value.timeModes?.five), week: mode(value.timeModes?.week) },
  }
}
