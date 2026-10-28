/** One rate-limit window as the engine reports it. */
export type LimitWindow = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  /** 0 to 100 (past 100 only on an exceeded spend limit). */
  percentUsed: number
  /** ISO 8601 time the window resets. */
  resetsAt?: string
}

/** The latest reading, from this session or another one (shared via the store). */
export type LimitsSnapshot = {
  windows: LimitWindow[]
  /** Epoch ms when the reading was taken. */
  observedAt: number
}

/** How full this conversation's context is, as /context counts it. Per session, never shared. */
export type ContextReading = {
  /** Tokens in use: the last reply's input, or a local estimate before the first one. */
  tokens: number
  /** The window measured against: the compaction window when one is set, else the model's. */
  limit: number
  /** `tokens` over `limit` as a whole percentage, past 100 when over. */
  percent: number
  /** The token count where auto-compaction runs; absent when it is off. */
  compactAt?: number
  /** True until a reply reports real counts (a fresh or just-compacted conversation). */
  isEstimate: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'limits-meter': {
      snapshot: LimitsSnapshot | null
      isHidden: boolean
      hasNoLimits: boolean
      /** Big pixel numbers (`/limits big`) instead of the compact card. */
      isBig: boolean
      /** Shape-tagged (the engine's `Shaped`), so a reload from 0.5.0's shape reads as absent. */
      context: { shape: string; value: ContextReading | null }
      /** The main loop's model id, as `$.session.model()` gives it: `claude-opus-5-5[1m]`. */
      model: string | null
      /** The effort level: from the settings at first, then as each turn reports it. */
      effort: string | null
    }
  }
}
