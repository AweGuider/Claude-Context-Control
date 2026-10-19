import type { SessionContextBreakdown } from 'claude-code'

import type { Breakdown, Category, FixedCost, Point, Reading, ControlSettings } from '../types'

export const DEFAULTS: ControlSettings = {
  showBand: true,
  startExpanded: false,
  openPaneOnStart: false,
  warnAt: 70,
  alertAt: 85,
  toastOnAlert: true,
  averageOver: 5,
  exactCounts: false,
  snapshot: false,
  snapshotGitignore: true,
  arrowTooltip: true,
}

export type Level = 'calm' | 'warn' | 'alert'

export const TONE: Record<Level, string> = { calm: '#9a968c', warn: '#d99a3a', alert: '#e0624a' }

export const TEXT_TONE: Record<Level, string | undefined> = { calm: undefined, warn: 'warning', alert: 'error' }

const CATEGORY_COLORS: Record<string, string> = {
  Messages: '#6f9be0',
  'MCP tools': '#3f9a96',
  'System tools': '#8a99a8',
  'System prompt': '#77736b',
  Skills: '#9a86c9',
  'Custom agents': '#b48ad6',
  'Memory files': '#c9a24f',
}

const FALLBACK_COLORS = ['#c77b9b', '#7fb37a', '#d08a5a', '#5aa9c9']

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

export function toBreakdown(b: SessionContextBreakdown, isExact: boolean): Breakdown {
  const used: Category[] = b.categories
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .map((c, i) => ({
      name: c.name,
      tokens: c.tokens,
      color: CATEGORY_COLORS[c.name] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length] ?? '#9a968c',
    }))
    .sort((x, y) => y.tokens - x.tokens)

  const fixed: FixedCost[] = []
  const servers = new Map<string, number>()
  for (const tool of b.mcpTools) {
    if (tool.isLoaded) servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + tool.tokens)
  }
  for (const [name, tokens] of servers) fixed.push({ kind: 'MCP', name, tokens, color: CATEGORY_COLORS['MCP tools']! })
  for (const file of b.memoryFiles) {
    fixed.push({ kind: 'Memory', name: `${baseName(file.path)} · ${file.type}`, tokens: file.tokens, color: CATEGORY_COLORS['Memory files']! })
  }
  if (b.skills && b.skills.tokens > 0) {
    fixed.push({ kind: 'Skills', name: `Skill listing · ${b.skills.includedSkills} skills`, tokens: b.skills.tokens, color: CATEGORY_COLORS.Skills! })
  }
  const agentTokens = b.agents.reduce((sum, a) => sum + a.tokens, 0)
  if (agentTokens > 0) {
    fixed.push({ kind: 'Agents', name: `Custom agents · ${b.agents.length}`, tokens: agentTokens, color: CATEGORY_COLORS['Custom agents']! })
  }
  if (b.slashCommands && b.slashCommands.tokens > 0) {
    fixed.push({ kind: 'Commands', name: `Command listing · ${b.slashCommands.includedCommands}`, tokens: b.slashCommands.tokens, color: '#8a99a8' })
  }
  fixed.sort((x, y) => y.tokens - x.tokens)

  return {
    used,
    threshold: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
    isAutoCompactEnabled: b.isAutoCompactEnabled,
    fixed: fixed.slice(0, 8),
    isExact,
    estimate: b.totalTokens,
    messages: used.find(c => c.name === 'Messages')?.tokens,
  }
}

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export function fmtWindow(n: number): string {
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`
  if (n % 1000 === 0) return `${n / 1000}k`
  return fmt(n)
}

export function fmtDelta(n: number | undefined): string {
  if (n === undefined) return '—'
  return `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`
}

export const limitOf = (reading: Reading, breakdown: Breakdown | null) => breakdown?.threshold ?? reading.window

export function levelOf(tokens: number, limit: number, s: ControlSettings): Level {
  const ratio = (tokens / limit) * 100
  if (ratio >= s.alertAt) return 'alert'
  if (ratio >= s.warnAt) return 'warn'
  return 'calm'
}

/** Growth per turn since the last compaction: the newest delta and the mean of the last `over`. */
export function growth(history: readonly Point[], over: number): { last?: number; avg?: number } {
  const start = history.findLastIndex(p => p.isCompaction === true)
  const run = history.slice(Math.max(0, start))
  const deltas: number[] = []
  for (let i = 1; i < run.length; i++) if (!run[i]!.isGap) deltas.push(run[i]!.tokens - run[i - 1]!.tokens)
  if (deltas.length === 0) return {}
  const recent = deltas.slice(-Math.max(1, over)).filter(d => d > 0)
  const avg = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : undefined
  return { last: run.at(-1)?.isGap ? undefined : deltas.at(-1), avg }
}

/**
 * Growth per turn guessed from the conversation so far: message tokens over prompts sent.
 * Counts every prompt since the session began, so after a compaction it reads low.
 */
export function estimatedAvg(b: Breakdown | null, turns: number | null): number | undefined {
  if (b?.messages === undefined || !turns || turns <= 0) return undefined
  return b.messages / turns
}

export function turnsLeft(tokens: number, limit: number, avg: number | undefined): number | undefined {
  if (avg === undefined || avg <= 0) return undefined
  return Math.max(0, Math.ceil((limit - tokens) / avg))
}

export function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, n))
}
