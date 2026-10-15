# Context Meter

A Claude Code mod that puts your context window above the prompt: how full it is, what fills it, how many turns until auto-compact, and a Compact button that takes a focus.

<!-- Screenshot: add docs/band.png (collapsed and expanded band) and docs/pane.png once captured. -->

## What it does

- **Band above the prompt.** Fill bar, percentage, tokens / window, growth last turn and turns left until auto-compact. Click it (or **More**) for the breakdown: the window with the auto-compact marker, what fills it by category, last turn, average per turn.
- **Compact with focus.** **Compact** opens a field for what the summary must keep, then runs the same compaction `/compact` does. While Claude is working it waits for the turn to end.
- **Alerts.** The band turns amber, then red, as you approach auto-compact (70% and 85% of the threshold by default), and one toast fires when you cross the alert line.
- **Side pane** (`/context-meter`, or **Open pane ↗** in the expanded band): context over the session with compaction markers, what fills it, what is loaded on every turn (MCP servers, memory files, skill listing, agents) and compaction history.
- **Pre-compact snapshot** (off by default): before any compaction, manual or auto, writes a Markdown handoff of recent prompts, files touched and open tasks.

The bars animate as the numbers change: fill grows, the session chart draws in, the band breathes at the alert level and shimmers while compacting.

## Install

In a terminal Claude Code session:

```
/plugin install context-meter --marketplace AweGuider/claude-context-lens
```

Answer `y` to add the marketplace, then pick the user scope. Installed at user scope, it also loads in sessions the Claude desktop app starts (the install command itself is terminal-only).

Built against Claude Code 2.1.295. The mod API is early access and can change between releases.

## Settings

In the pane's **Settings** tab; saved across sessions.

| Setting | Default |
| --- | --- |
| Band above the prompt | On |
| Band starts | Collapsed |
| Open the pane when a session starts | Off |
| Warn at / Alert at | 70% / 85% of auto-compact |
| Toast once when crossing Alert | On |
| Turns-left estimate averages the last | 5 turns |
| Exact counts | Off |
| Pre-compact snapshot | Off |
| Snapshot folder | `.claude/context-snapshots` (relative to the project root, or absolute) |
| Keep snapshots out of git | On |

## Snapshots

When on, each compaction first writes `<project>/.claude/context-snapshots/<date>_<time>.md` with the trigger, model, context size, the focus you gave, your last 10 prompts, files edited and read, and open tasks. With **Keep snapshots out of git** on, the folder gets its own one-line `.gitignore`; your project's `.gitignore` is not touched. Old snapshots are not deleted.

## Privacy and cost

The mod makes no model calls. Figures come from the session's own usage and a local estimate of the breakdown. **Exact counts** switches the breakdown to Claude Code's token-count requests (one per tool and memory file, as `/context` does) after each turn; leave it off to send nothing.

## Limitations

- Where an organization manages Claude Code, hooks on compaction run only for plugins the organization lists, so snapshots and the compaction history record only the mod's own Compact button there.
- Figures appear after the first reply of a session and again after the first reply following a compaction.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`hooks/register.tsx` holds the hooks and drawings, `hooks/model.ts` the figures, `hooks/svg.ts` the bars and chart, `hooks/snapshot.ts` the snapshot writer, `types/index.d.ts` the state contract and `tests/meter.test.ts` the tests.

## License

MIT © 2026 Alan Safonov (AweDev)
