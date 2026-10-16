// The progress bar styles (claudeticker's meter styles plus pie, spark and none), each drawn as runs of fill, track and frame text, and the /config settings.

import type { BarId, BarPref, Motion, Prefs, TimeMode } from '../types'
import { TRACK, TRACK_HEAVY } from './cells'

export type BarPart = { kind: 'fill' | 'track' | 'frame'; text: string }

type Cells = { fill: string; track: string; open?: string; close?: string; head?: string }

export type BarStyle = {
  id: string
  /** One glyph whatever the width: the width setting does not apply. */
  isGlyph?: boolean
  /** The track cells' color; TRACK when absent. */
  trackColor?: number
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
  { id: 'blocks', draw: cells({ fill: '█', track: '░' }) },
  { id: 'parallelogram', draw: cells({ fill: '▰', track: '▱' }) },
  { id: 'shade', draw: cells({ fill: '▓', track: '░' }) },
  { id: 'solid', draw: cells({ fill: '█', track: '█' }) },
  { id: 'smooth', draw: smooth('░') },
  { id: 'smooth-bare', draw: smooth(' ') },
  { id: 'line', draw: cells({ fill: '━', track: '─' }) },
  { id: 'heavy', draw: cells({ fill: '━', track: '━' }), trackColor: TRACK_HEAVY },
  { id: 'dots', draw: cells({ fill: '●', track: '○' }) },
  { id: 'squares', draw: cells({ fill: '■', track: '□' }) },
  { id: 'diamonds', draw: cells({ fill: '◆', track: '◇' }) },
  { id: 'braille', draw: cells({ fill: '⣿', track: '⣀' }) },
  { id: 'ascii', draw: cells({ fill: '#', track: '-', open: '[', close: ']' }) },
  { id: 'arrow', draw: cells({ fill: '=', track: ' ', head: '>', open: '[', close: ']' }) },
  { id: 'pie', isGlyph: true, draw: glyph('○◔◑◕●') },
  { id: 'spark', isGlyph: true, draw: glyph(' ▁▂▃▄▅▆▇█') },
  { id: 'none', isGlyph: true, draw: () => [] },
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
  timeModes: { five: 'relative', week: 'relative' },
  motion: 'lively',
}

export const MOTIONS: readonly Motion[] = ['lively', 'subtle', 'off']

export function styleOf(id: string): BarStyle {
  return STYLES.find(style => style.id === id) ?? STYLES[0]!
}

export function drawBar(pref: BarPref, percent: number): BarPart[] {
  return styleOf(pref.style).draw(percent, pref.width)
}

/** The color of a bar's track cells: the style's own, else the shared gray. */
export function trackColorOf(pref: BarPref): number {
  return styleOf(pref.style).trackColor ?? TRACK
}

/** The drawing while the fill grows: blocks eases its tip by eighths of a cell, as claudeticker's blocks meter; every other style as at rest. */
export function drawMoving(pref: BarPref, percent: number): BarPart[] {
  return styleOf(pref.style).id === 'blocks' ? smooth('░')(percent, pref.width) : drawBar(pref, percent)
}

/** The /config settings, each falling back to its default when unknown. */
export function normalizeSettings(options: Record<string, unknown>): Prefs {
  const bar = (id: BarId, styleKey: string, widthKey: string): BarPref => {
    const style = options[styleKey]
    const width = Number(options[widthKey])

    return {
      style: typeof style === 'string' && STYLES.some(s => s.id === style) ? style : DEFAULT_PREFS.bars[id].style,
      width: WIDTHS.includes(width) ? width : DEFAULT_PREFS.bars[id].width,
    }
  }
  const time = (key: string): TimeMode => {
    const mode = options[key]

    return mode === 'relative' || mode === 'clock' || mode === 'date' ? mode : 'relative'
  }

  return {
    bars: {
      ctx: bar('ctx', 'ctxStyle', 'ctxWidth'),
      five: bar('five', 'fiveStyle', 'fiveWidth'),
      week: bar('week', 'weekStyle', 'weekWidth'),
    },
    timeModes: { five: time('fiveTime'), week: time('weekTime') },
    motion: MOTIONS.find(m => m === options.motion) ?? DEFAULT_PREFS.motion,
  }
}
