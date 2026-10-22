// Pure figures and text for the status line, ported from statusline-command.js.

import type { GitInfo, TimeMode } from '../types'

export type Tone = 'ok' | 'warn' | 'hot'

export type WindowFigures = {
  percent: number
  resetsAtMs: number | null
  delta: number | null
}

const HOUR = 3600_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const TIME_MODES: readonly TimeMode[] = ['relative', 'clock', 'date']

export function nextTimeMode(mode: TimeMode): TimeMode {
  return TIME_MODES[(TIME_MODES.indexOf(mode) + 1) % TIME_MODES.length] ?? 'relative'
}

export function tone(percent: number): Tone {
  if (percent >= 80) return 'hot'
  if (percent >= 50) return 'warn'

  return 'ok'
}

/** `claude-opus-5-5[1m]` -> `Opus 5.5`; a name already shown as a display name passes through. */
export function modelLabel(model: string): string {
  const bare = model.replace(/\[[^\]]*\]$/, '').trim()
  const id = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(bare)
  if (!id) return bare || 'unknown'
  const family = id[1]!.charAt(0).toUpperCase() + id[1]!.slice(1).toLowerCase()

  return id[3] ? `${family} ${id[2]}.${id[3]}` : `${family} ${id[2]}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const whole = Math.floor(n / 1_000_000)
    const frac = Math.floor((n % 1_000_000) / 100_000)
    return frac === 0 ? `${whole}M` : `${whole}.${frac}M`
  }
  if (n >= 1000) return `${Math.floor(n / 1000)}K`

  return String(n)
}

/** Percentage points under (+) or over (-) an even burn rate; null under 5 or outside the window. */
export function paceDelta(used: number, resetsAtMs: number, windowHours: number, now: number): number | null {
  const windowMs = windowHours * HOUR
  const start = resetsAtMs - windowMs
  if (now >= resetsAtMs || now < start) return null
  const raw = ((now - start) * 100 - used * windowMs) / windowMs
  const delta = raw >= 0 ? Math.floor(raw + 0.5) : Math.ceil(raw - 0.5)

  return Math.abs(delta) < 5 ? null : delta
}

export function resetIn(resetsAtMs: number, now: number): string {
  const rem = Math.floor((resetsAtMs - now) / 1000)
  if (rem <= 0) return ''
  const d = Math.floor(rem / 86400)
  const h = Math.floor((rem % 86400) / 3600)
  const m = Math.floor((rem % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`
  if (m > 0) return `${m}m`

  return '<1m'
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The reset moment in the chosen notation: `2h56m`, `13:52` (`Fri 05:00` when
 * not today), `10/10 13:52`. Local time; `offsetMin` is the zone's offset east of UTC.
 */
export function resetLabel(resetsAtMs: number, now: number, mode: TimeMode, offsetMin: number): string {
  if (resetsAtMs <= now) return ''
  if (mode === 'relative') return resetIn(resetsAtMs, now)
  const at = new Date(resetsAtMs + offsetMin * 60_000)
  const today = new Date(now + offsetMin * 60_000)
  const clock = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`
  if (mode === 'date') return `${pad(at.getUTCDate())}/${pad(at.getUTCMonth() + 1)} ${clock}`
  const isToday =
    at.getUTCFullYear() === today.getUTCFullYear() &&
    at.getUTCMonth() === today.getUTCMonth() &&
    at.getUTCDate() === today.getUTCDate()

  return isToday ? clock : `${WEEKDAYS[at.getUTCDay()]} ${clock}`
}

export type FinishWord = 'done' | 'stopped' | 'failed'

/** How a turn that ended reads: answered is done, interrupted is stopped, anything else failed. */
export function wordForReason(reason: string): FinishWord {
  if (reason === 'answer') return 'done'

  return reason === 'aborted' ? 'stopped' : 'failed'
}

/** `42s`, `1m12s`, `1h02m`: the time of a turn. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`

  return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`
}

/** `✦ done · 42s`: the mark that replaces the elapsed time of a turn that ended. */
export function doneText(word: FinishWord, durationMs: number): string {
  return `${word === 'done' ? '✦' : '✗'} ${word} · ${formatElapsed(durationMs)}`
}

/** The effort a request sent, as the line shows it: a thinking budget reads `32K think`. */
export function effortLabel(effort: string | number | null | undefined): string | null {
  if (effort === null || effort === undefined) return null

  return typeof effort === 'number' ? `${formatTokens(effort)} think` : effort
}

/** A stored reading as it stands now: a window whose reset has passed reads as fresh. */
export function windowFigures(
  window: { percentUsed: number; resetsAt?: string } | undefined,
  windowHours: number,
  now: number,
): WindowFigures | null {
  if (!window) return null
  const parsed = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  const resetsAtMs = Number.isFinite(parsed) ? parsed : null
  if (resetsAtMs !== null && resetsAtMs <= now) return { percent: 0, resetsAtMs: null, delta: null }
  const percent = Math.round(window.percentUsed)

  return {
    percent,
    resetsAtMs,
    delta: resetsAtMs === null ? null : paceDelta(percent, resetsAtMs, windowHours, now),
  }
}

/** `git status --porcelain=v2 --branch` as the line shows it: the branch (`HEAD` when detached), `dirty` before `ahead`; null on an unborn branch, as `rev-parse HEAD` fails there. */
export function parseGitStatus(stdout: string): GitInfo | null {
  let branch: string | null = null
  let ahead = 0
  let isDirty = false
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.oid ')) {
      if (line.slice('# branch.oid '.length) === '(initial)') return null
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      branch = head === '(detached)' ? 'HEAD' : head
    } else if (line.startsWith('# branch.ab ')) {
      const first = line.slice('# branch.ab '.length).split(' ')[0] ?? ''
      ahead = parseInt(first.replace(/^\+/, ''), 10) || 0
    } else if (line !== '' && !line.startsWith('#')) {
      isDirty = true
    }
  }
  if (branch === null) return null

  return { branch, mark: isDirty ? 'dirty' : ahead > 0 ? 'ahead' : '' }
}
