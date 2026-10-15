export type Reading = { tokens?: number; window: number; percent?: number }

export type Point = { tokens: number; isCompaction?: true }

export type Category = { name: string; tokens: number; color: string }

export type FixedCost = { kind: string; name: string; tokens: number; color: string }

export type Breakdown = {
  used: Category[]
  threshold?: number
  isAutoCompactEnabled: boolean
  fixed: FixedCost[]
  isExact: boolean
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

export type MeterSettings = {
  showBand: boolean
  startExpanded: boolean
  openPaneOnStart: boolean
  warnAt: number
  alertAt: number
  toastOnAlert: boolean
  averageOver: number
  exactCounts: boolean
  snapshot: boolean
  snapshotDir: string
  snapshotGitignore: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      reading: Reading | null
      history: Point[]
      breakdown: Breakdown | null
      compactions: Compaction[]
      phase: Phase
      expanded: boolean
      composing: boolean
      draft: string
      tab: Tab
      settings: MeterSettings
      shownFill: number
      isAlerted: boolean
      error: string
    }
  }
}
