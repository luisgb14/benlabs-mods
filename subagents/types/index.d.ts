export type Row = { type: string; description: string; isDone: boolean; tools: string[]; calls: number; detail: string }

declare module 'claude-code' {
  interface PluginState {
    subagents: { agents: Record<string, Row> }
  }
}
