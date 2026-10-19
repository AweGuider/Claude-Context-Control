# Changelog

## Unreleased (0.2.0)

- The band appears as soon as a session opens: it draws from Claude Code's free usage figures first and fetches the breakdown after.
- Before a session's first reply, the band shows the breakdown's own estimate, marked `~`, instead of "measuring".
- Last turn, Avg / turn and Auto-compact in survive a resume or an app restart: each session's context size per turn is kept in the mod's plugin storage (the 20 most recent sessions).
- A session with no history yet shows an estimated Avg / turn (marked `~`) from message tokens over prompts sent, so turns until auto-compact show at once.
- Strip: the percentage sits bold beside the bar; tokens, the last turn's growth (in its own colour) and "last turn" are spaced apart. The right side reads auto-compact, **Compact**, then a ↗ icon that opens the pane and a ▲/▼ arrow, replacing More / Less. Both name themselves on hover in a small dim line; a setting turns that off.
- Click anywhere on the band to open the breakdown, and anywhere on it to close it. It opens in four short stages from the strip and closes the same way.
- The open breakdown never scrolls: on a short band it gives up spacing, then its lowest legend rows ("+N more"). The legend takes three columns on a wide band.
- The pane opens with the keyboard focus, so its first click lands on Overview or Settings. In its Settings, number fields no longer repeat their label, and wrap in a narrow pane.
- On a narrow band the strip shortens ("~6 turns left", no "last turn", no "/ 1M"), then drops the growth and turns, so **Compact** and the arrow always fit.
- Opening and closing the breakdown no longer replays the bar's grow or the composition's fade; they animate only when the figures change.

## 0.1.3 (2026-10-15)

- Snapshots now always go to `.claude/context-snapshots/` in the session's working directory. The **Snapshot folder** setting is removed, so the plugin directory can read exactly which files the mod writes.
- README and privacy policy: an explicit list of the files the mod writes, what its compaction hook does, and what its one command does.

## 0.1.2 (2026-10-15)

- Fixed: the mod didn't load ("hooks module did not load"). Claude Code follows the mod's engine handle only into functions in the same file, so the snapshot writer's file access moved into the main module.
- Clears the plugin directory's blocking check on how the mod uses its engine handle.

## 0.1.1 (2026-10-15)

- Shown as **Context Control** in plugin listings, with a new description, a category and tags.
- Added an icon, a privacy policy, a changelog, and directory listing links (documentation, support, privacy).
- README: a text heading, a comparison with Claude Code's built-in context tools, an FAQ, and a full list of what the mod reads, sends and writes.
- No change to the mod's behaviour.

## 0.1.0 (2026-10-15)

First release.

- Band above the prompt: context fill, tokens / window, growth last turn, and turns until auto-compact. Expands to a breakdown of what fills the context.
- Compact with a focus: a field for what the summary must keep. Waits while Claude is working.
- Alerts: the band turns amber, then red, near auto-compact, and one toast fires at the alert level.
- Side pane (`/context-control`): a session chart with compaction markers, what fills the context, what is loaded on every turn, compaction history, and settings.
- Optional pre-compact snapshot: a Markdown handoff of recent prompts, files touched and open tasks, written before each compaction.
