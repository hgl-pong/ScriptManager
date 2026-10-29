export interface ScriptRow {
  path: string
  name: string
  type: string
  displayName: string
  tags: string[]
  lastRunAt: string
  lastExit: number | null
  lastDurationMs: number | null
  lastParams: string
}

export interface StatePayload {
  scanRoots: string[]
  tags: string[]
  scripts: ScriptRow[]
  runs: RunHistoryEntry[]
  running?: string | null
}

export interface RunHistoryEntry {
  id: string
  at: string
  path: string
  name: string
  params: string
  exitCode: number | null
  durationMs: number | null
}

export interface OutputPayload {
  runId: string
  lines: string[]
  cursor: number
  state: 'running' | 'exited'
  exitCode: number | null
  durationMs: number | null
}

export interface BrowsePayload {
  path: string
  parent: string | null
  dirs: { name: string; path: string }[]
}

export interface RunInfo {
  name: string
  state: 'running' | 'exited'
  exitCode: number | null
  durationMs: number | null
}

export interface AiProtocol {
  id: string
  label: string
  defaultBaseUrl: string
  defaultModel: string
}

export type ReasoningEffort = '' | 'minimal' | 'low' | 'medium' | 'high'

export interface AiProfile {
  id: string
  name: string
  protocol: string
  baseUrl: string
  model: string
  reasoningEffort?: ReasoningEffort
  headers: Record<string, string>
  hasKey: boolean
  apiKey?: string | null
}

export interface AiModel {
  id: string
  name?: string
}

export interface AiModelsPayload {
  models: AiModel[]
  error: string | null
  url?: string
}

export interface AiHistoryEntry {
  id: string
  at: string
  kind: string
  prompt: string
  path: string | null
  state: 'done' | 'error' | 'stopped'
  error: string | null
  text: string
  truncated: boolean
}

export interface AiHistoryPayload {
  entries: AiHistoryEntry[]
}

export interface AiJob {
  id: string
  kind: string
  state: 'running' | 'done' | 'error' | 'stopped'
}

export type LocalEffort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface LocalAgent {
  enabled: boolean
  command: string
  model: string
  effort: LocalEffort
  cwd: string
  extraArgs: string
  timeoutMs: number
}

export interface AiState {
  activeProfileId: string | null
  profiles: AiProfile[]
  lastScriptDir: string
  lastScriptType: string
  protocols: AiProtocol[]
  localAgent: LocalAgent
  // A job the server is still running; lets a reloaded page reattach instead of deadlocking.
  job: AiJob | null
}

export interface AiChunk {
  jobId: string
  text: string
  cursor: number
  state: 'running' | 'done' | 'error' | 'stopped'
  error: string | null
}
