# Changelog

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
