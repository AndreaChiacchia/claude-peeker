export type BarId = 'ctx' | 'five' | 'week'

export type BarPref = { style: string; width: number }

/** How a reset moment reads: `2h56m`, `13:52`, `10/10 13:52`. */
export type TimeMode = 'rel' | 'clock' | 'date'

/** How much the bars move: `lively`, `subtle`, or not at all. */
export type Motion = 'lively' | 'subtle' | 'off'

export type Prefs = {
  bars: Record<BarId, BarPref>
  timeModes: { five: TimeMode; week: TimeMode }
  motion: Motion
}

export type GitInfo = {
  branch: string
  /** `dirty`: uncommitted changes; `ahead`: commits not pushed. */
  mark: '' | 'dirty' | 'ahead'
}

declare module 'claude-code' {
  interface PluginState {
    claudepeeker: {
      prefs: Prefs
      git: GitInfo | null
    }
  }
}
