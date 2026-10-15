# Claude-Peeker

![version](https://img.shields.io/badge/version-0.4.0-blue)

A mod for the Claude Code CLI that replaces a `statusLine` script with a status line the mod draws itself. It shows the model and effort, the project and git branch, the context window, and the 5-hour and weekly rate limits. You can click the reset times and restyle each bar.

```
╭──────────────────────────────────────────────────────────────────────────────────────╮
│ >                                                                                    │
╰──────────────────────────────────────────────────────────────────────────────────────╯
  ⏵⏵ accept edits on (shift+tab to cycle)
  ● [Opus 5.5 ·high] · claudepeeker/main* · ctx (1M) ▰▰▱▱▱ 29% · 290K · 5h (2h13m) █░░░░ 10% [+45%] · wk (6d17h) █░░░░ 1% · 1m12s
```

## Features

- **The status line, under the prompt's hint line:** `● [model ·effort] · project/branch · ctx · 5h · wk · time`, in the colors of the classic ANSI status line.
- **A state dot:** lavender while Claude works, blinking in Lively and alternating its color in Subtle; gray when idle. It pulses red when the context crosses 80% (Lively).
- **Turn time:** ticks while a turn runs. When the turn ends it shows `✦ done · 6m24s` (or `✗ stopped`, `✗ failed`) for 2 seconds, then the time of the last turn stays in gray until the next turn starts.
- **Git state:** a red `*` after the branch for uncommitted changes, a yellow one for commits not yet pushed.
- **Context window:** the window size, how full it is and the tokens in it (`29% · 290K`), the count rolling to new values.
- **Rate limits:** the 5-hour and weekly windows, each with a bar, the time until reset and a pace delta. The delta reads `[+n%]` when you're under an even burn rate and `[-n%]` when you're over it, and is hidden under 5 points.
- **Clickable reset times:** a click cycles `2h13m` → `13:50` → `10/10 13:50`. A reset that isn't today shows its weekday (`Fri 05:00`). Each window keeps its own format, across sessions too.
- **Bar styles** (`/peeker`): each bar gets its own style and width. There are 16 styles: Blocks, Parallelogram, Shade, Solid track, Smooth, Smooth bare, Line, Dots, Squares, Diamonds, Braille, ASCII, Arrow, Pie, Spark and Hidden (percent only).
- **Colors follow the fill:** green below 50%, yellow from 50%, red from 80%.
- **Motion:** the bars glint when they change. A warm sweep runs left to right when usage rises; an icy sweep runs right to left when it falls, and the emptied cells fade. The fill grows smoothly and blends its color, and the percent rolls to its new value with the changed digits flashing. Crossing 50% or 80% pulses the bar. A compaction drains the ctx bar with sparkles and shows `↻ −62%` for a moment. A 5h or weekly reset flashes the bar green with `✦ fresh`. A 5h or weekly bar that appears after the first draw fills in from empty. The bars also move after every model response, not only at the end of a turn. Pick Lively (default), Subtle or Off in `/peeker`.
- **Matches claudespotter:** the same dot, token count and time as its subagent rows.

## Install

**Claude Code CLI only.** The mod runs in the CLI in any terminal, including the terminals built into VS Code or JetBrains. It does not run in the Claude desktop app, the VS Code extension's chat panel, the web or mobile, because it runs `git` to read the branch, and the mod API allows local commands only in the CLI.

You also need Claude Code 2.1.296 or later. The branch and its `*` need `git` on `PATH`; without it the line shows the project name alone.

Load it in every session by adding the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (separate several folders with `;` on Windows, `:` elsewhere):

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\<you>\\projects\\mods\\claude-peeker"
  }
}
```

Or load it for a single session with `claude --plugin-dir <path to this folder>`.

Remove the `statusLine` entry from the same file, or both lines will show.

## Usage

| Command | What it does |
|---|---|
| `/peeker` | Open the bar styles panel |
| `/peeker 5h` | Cycle the 5-hour reset time's format (same as clicking it) |
| `/peeker wk` | Cycle the weekly reset time's format |
| `/peeker demo` | Play a 20-second tour of the bar effects on the status line with made-up figures; `/peeker demo stop` ends it |

The demo uses your Motion choice (with Off the figures change without effects) and goes back to your real usage when it ends.

The panel docks beside the transcript. Click `‹` or `›` to step a bar's style or width, or click a reset time to change its format:

```
ctx  ▰▰▱▱▱ 33%
    ‹ Parallelogram ›  ‹ 5 cells ›

5h   █░░░░ 11%
    ‹ Blocks ›  ‹ 5 cells ›

wk   █░░░░ 1%
    ‹ Blocks ›  ‹ 5 cells ›

Reset  5h 13:50  wk 17/10 05:00
Motion  ‹ Lively ›
[ Reset bars ] [ Close ]
```

Click `‹` or `›` beside Motion to pick Lively, Subtle or Off.

## How it works

- **Figures:** context and rate limits come from `$.session.usage()`. These are the same readings a `statusLine` script gets on stdin as `context_window` and `rate_limits`. The tokens come from `context.tokens` in the same reading. The line redraws after every model response and every 30 seconds.
- **Turn time:** counted from the `turn.start` of the main loop to its `turn.complete`. Subagent turns don't count.
- **Painting:** the dot, the bars and the time are small cell grids repainted in place 20 times a second while a turn runs or an effect plays. Nothing is repainted while the line is idle. Off draws the plain line, which redraws once a second while a turn runs.
- **Effort:** read from each request the main session sends (`turn.step`), so it is what the model actually runs on. Before the first request, and after a `/model` or `/effort` change until the next request, it comes from settings: the model's own `modelSettings.<model>.effortLevel` first, then `effortLevel`, which is what `/effort` saves.
- **Git:** read every 10 seconds and after each turn, with `git rev-parse --abbrev-ref HEAD`, `git status --porcelain --untracked-files=no` and `git rev-list --count @{u}..HEAD`.
- **Your choices:** bar styles, widths and reset time formats are kept in the mod's own store, so they last across sessions.

## Limitations

- **Under the hint line.** The mod API has no hook into the row a `statusLine` script draws in. The mod keeps Claude Code's hint line (`? for shortcuts`, the mode pill) as it is and draws the status line on the row beneath it. Rows another mod adds under the hint line go below the status line.
- **Two states only.** The dot shows working or idle; the mod API has no reliable signal for the main session waiting on a permission prompt.

## Development

```
npx -y -p typescript@5.6.3 tsc -p .
claude plugin validate .
claude plugin test .
```

| Path | Contents |
|---|---|
| `hooks/register.tsx` | the mod: the line under the hint, the `/peeker` panel and command, git and usage reading |
| `hooks/line.ts` | the status line as colored segments |
| `hooks/format.ts` | figures: pace delta, reset times, model names, token counts, elapsed time and finish marks |
| `hooks/styles.ts` | the bar styles and the stored preferences |
| `hooks/motion.ts` | the bars' motion: what changed, the effects, each frame |
| `hooks/row.ts` | the dot and turn time of the line: the state glyph, the elapsed time and the finish mark |
| `hooks/cells.ts` | colors, blending, the cell encoding |
| `hooks/demo.ts` | the demo's script |
| `types/index.d.ts` | the mod's state contract |
| `tests/` | tests for the figures, the bars, the line, the clicks and the panel |

## License

MIT, see [LICENSE](LICENSE).
