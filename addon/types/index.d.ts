export type Status = 'idle' | 'summarizing' | 'starting' | 'speaking' | 'waiting'
export type Summary = { source: string; text: string }
export type Spoken = { text: string; how: 'haiku' | 'saved' | 'full-text' | 'runaway' | 'separate'; reason?: string; warning?: string }
export type Place = { current: number; total: number }

declare module 'claude-code' {
  interface PluginState {
    'read-aloud': {
      reply: string
      status: Status
      place: Place | null
      prompt: string
      summary: Summary | null
      enabled: boolean
      voice: string
      defaultVoice: string
      title: string
      version: string
      replyTurn: string
      replyKind: 'reply' | 'thinking'
    }
  }
}
