# Privacy policy

Context Control is a Claude Code mod by AweDev. It runs inside your own Claude Code session and collects nothing about you.

## What it reads

- The session's own usage figures that Claude Code already shows: context fill, window size, and a breakdown of the context by category.
- The session's transcript, only when a pre-compact snapshot is turned on, to list your recent prompts, the files Claude read or edited, and open tasks.

## What it sends

- Nothing, by default. The mod makes no network requests and no model calls.
- With **Exact counts** turned on in its settings (off by default), the breakdown uses Claude Code's own token-count requests, one per tool and memory file, the same requests the built-in `/context` command makes. They go to the same Anthropic API your session already uses, under your account. Nothing goes to AweDev or any third party.

## What it writes

- Its settings, through Claude Code's own plugin storage on your machine.
- Pre-compact snapshots, only when you turn them on (off by default): Markdown files in `.claude/context-snapshots/` under the session's working directory, plus a one-line `.gitignore` in that folder when **Keep snapshots out of git** is on. Snapshots stay on your machine and are never uploaded.

## What it collects

Nothing. There is no telemetry, analytics, account, or server.

## Contact

Questions or concerns: open an issue at https://github.com/AweGuider/Claude-Context-Control/issues.
