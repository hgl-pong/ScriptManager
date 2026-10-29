import type {
  AiChunk,
  AiHistoryPayload,
  AiModelsPayload,
  AiProfile,
  AiState,
  BrowsePayload,
  LocalAgent,
  OutputPayload,
  StatePayload,
} from './types'

// The launch URL carries the token (?t=...); every API call echoes it as a header so a
// random web page cannot drive this server through 127.0.0.1.
const token = new URLSearchParams(window.location.search).get('t')

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
  if (init.body) headers['content-type'] = 'application/json'
  if (token) headers['x-sm-token'] = token

  const response = await fetch(`/api${pathname}`, { ...init, headers })
  if (!response.ok) {
    if (response.status === 401) throw new Error('没有访问 token，请用 ScriptManager.bat 重新启动')
    const detail = await response.text().catch(() => '')
    let message = detail
    let code: string | undefined
    try {
      const payload = JSON.parse(detail) as { error?: string; code?: string }
      message = payload.error ?? detail
      code = payload.code
    } catch {
      // Plain text body, already fine.
    }
    const error = new Error(message || `请求失败（${response.status}）`)
    if (code) Object.assign(error, { code })
    throw error
  }
  return (await response.json()) as T
}

export const api = {
  state: () => request<StatePayload>('/state'),
  scan: () => request<StatePayload>('/scan', { method: 'POST' }),
  roots: (roots: string[]) =>
    request<StatePayload>('/roots', { method: 'POST', body: JSON.stringify({ roots }) }),
  browse: (target: string) => request<BrowsePayload>(`/browse?path=${encodeURIComponent(target)}`),
  meta: (path: string, alias: string, tags: string[]) =>
    request<StatePayload>('/meta', { method: 'POST', body: JSON.stringify({ path, alias, tags }) }),
  run: (path: string, params: string) =>
    request<{ runId: string }>('/run', { method: 'POST', body: JSON.stringify({ path, params }) }),
  output: (runId: string, after: number) =>
    request<OutputPayload>(`/output?runId=${encodeURIComponent(runId)}&after=${after}`),
  stop: (runId: string) => request<{ ok: true }>('/stop', { method: 'POST', body: JSON.stringify({ runId }) }),
  terminal: (path: string, params: string) =>
    request<{ ok: true }>('/terminal', { method: 'POST', body: JSON.stringify({ path, params }) }),
  open: (path: string) => request<{ ok: true }>('/open', { method: 'POST', body: JSON.stringify({ path }) }),
  reveal: (path: string) => request<{ ok: true }>('/reveal', { method: 'POST', body: JSON.stringify({ path }) }),

  aiState: () => request<AiState>('/ai/state'),
  aiSaveProfiles: (profiles: AiProfile[], activeProfileId: string | null) =>
    request<AiState>('/ai/profiles', { method: 'POST', body: JSON.stringify({ profiles, activeProfileId }) }),
  aiSaveLocal: (local: LocalAgent) =>
    request<AiState>('/ai/local', { method: 'POST', body: JSON.stringify({ local }) }),
  aiLocalTest: (local?: LocalAgent) =>
    request<{ text: string }>('/ai/local/test', {
      method: 'POST',
      body: JSON.stringify(local ? { local } : {}),
    }),
  aiTest: (profile: AiProfile) =>
    request<{ text: string }>('/ai/test', { method: 'POST', body: JSON.stringify({ profile }) }),
  aiModels: (profile: AiProfile) =>
    request<AiModelsPayload>('/ai/models', { method: 'POST', body: JSON.stringify({ profile }) }),
  aiAsk: (payload: { kind: string; prompt?: string; type?: string; path?: string; previous?: string }) =>
    request<{ jobId: string }>('/ai/ask', { method: 'POST', body: JSON.stringify(payload) }),
  aiStream: (jobId: string, after: number) =>
    request<AiChunk>(`/ai/stream?jobId=${encodeURIComponent(jobId)}&after=${after}`),
  aiStop: (jobId: string) => request<{ ok: true }>('/ai/stop', { method: 'POST', body: JSON.stringify({ jobId }) }),
  aiHistory: () => request<AiHistoryPayload>('/ai/history'),
  aiHistoryClear: () => request<{ ok: true }>('/ai/history/clear', { method: 'POST' }),
  aiSaveScript: (payload: { dir: string; name: string; type: string; content: string; overwrite?: boolean }) =>
    request<{ path: string; state: StatePayload; backupPath?: string | null }>('/ai/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  aiApply: (path: string, content: string) =>
    request<{ changedLines: number; backupPath?: string | null }>('/ai/apply', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),
}
