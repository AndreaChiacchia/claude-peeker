export type BarId = 'ctx' | 'five' | 'week' | 'fable'

/** The bars that have a reset time. */
export type WindowId = 'five' | 'week' | 'fable'

export type BarPref = { style: string; width: number }

/** How a reset moment reads: relative `2h56m`, clock `13:52`, date `10/10 13:52`. */
export type TimeMode = 'relative' | 'clock' | 'date'

/** How much the bars move: `lively`, `subtle`, or not at all. */
export type Motion = 'lively' | 'subtle' | 'off'

export type Prefs = {
  bars: Record<BarId, BarPref>
  timeModes: Record<WindowId, TimeMode>
  motion: Motion
}

export type GitInfo = {
  branch: string
  /** `dirty`: uncommitted changes; `ahead`: commits not pushed. */
  mark: '' | 'dirty' | 'ahead'
}

/** The Fable weekly limit as claude.ai's usage endpoint reports it; the field names match a session rate limit. */
export type FableWindow = { percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    claudepeeker: {
      git: GitInfo | null
      fable: FableWindow | null
    }
  }
}
