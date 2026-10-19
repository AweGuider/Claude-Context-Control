export type Reading = { tokens?: number; window: number; percent?: number }

/** `isGap`: the turns before it went unwatched, so no growth is read across it. */
export type Point = { tokens: number; isCompaction?: true; isGap?: true }

export type Category = { name: string; tokens: number; color: string }

export type FixedCost = { kind: string; name: string; tokens: number; color: string }

export type Breakdown = {
  used: Category[]
  threshold?: number
  isAutoCompactEnabled: boolean
  fixed: FixedCost[]
  isExact: boolean
  /** The breakdown's own total: shown, marked "~", while Claude Code reports no token count. */
  estimate: number
  messages?: number
}

export type Compaction = {
  at: number
  trigger: string
  before?: number
  after?: number
  focus?: string
  snapshot?: string
}

export type Phase = 'idle' | 'compacting' | 'compacted'

export type Tab = 'overview' | 'settings'

export type ControlSettings = {
  showBand: boolean
  startExpanded: boolean
  openPaneOnStart: boolean
  warnAt: number
  alertAt: number
  toastOnAlert: boolean
  averageOver: number
  exactCounts: boolean
  snapshot: boolean
  snapshotGitignore: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'context-control': {
      reading: Reading | null
      history: Point[]
      breakdown: Breakdown | null
      compactions: Compaction[]
      phase: Phase
      expanded: boolean
      composing: boolean
      draft: string
      tab: Tab
      settings: ControlSettings
      shownFill: number
      turnCount: number | null
      isAlerted: boolean
      error: string
    }
  }
}
