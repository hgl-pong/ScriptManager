import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from './api'
import type { AiModel, AiProfile, AiState, ReasoningEffort } from './types'

const REASONING_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: '', label: '默认（不指定）' },
  { value: 'minimal', label: '最低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

function headersToText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

function textToHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key) headers[key] = value
  }
  return headers
}

interface ProfileDialogProps {
  ai: AiState
  onClose: () => void
  onSaved: (state: AiState, activeId: string | null) => void
}

export function ProfileDialog({ ai, onClose, onSaved }: ProfileDialogProps) {
  const [profiles, setProfiles] = useState<AiProfile[]>(ai.profiles)
  const [activeId, setActiveId] = useState<string>(ai.activeProfileId ?? ai.profiles[0]?.id ?? '')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [headersText, setHeadersText] = useState<Record<string, string>>(
    Object.fromEntries(ai.profiles.map((profile) => [profile.id, headersToText(profile.headers)])),
  )
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [modelOptions, setModelOptions] = useState<Record<string, AiModel[]>>({})
  const [modelNotes, setModelNotes] = useState<Record<string, string>>({})
  const [modelBusy, setModelBusy] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement>(null)
  const modelSeq = useRef<Record<string, number>>({})
  const lastAutoId = useRef('')

  useEffect(() => {
    firstFieldRef.current?.focus()
  }, [])

  // Esc closes only when no save is in flight; the disabled 取消 button is the same guarantee.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const patch = (id: string, changes: Partial<AiProfile>) => {
    setProfiles((current) => current.map((profile) => (profile.id === id ? { ...profile, ...changes } : profile)))
  }

  const changeProtocol = (profile: AiProfile, protocol: string) => {
    const previous = ai.protocols.find((item) => item.id === profile.protocol)
    const changes: Partial<AiProfile> = { protocol }
    // Values left at the previous protocol's defaults would silently point at the wrong service.
    if (!profile.model || profile.model === previous?.defaultModel) changes.model = ''
    if (!profile.baseUrl || profile.baseUrl === previous?.defaultBaseUrl) changes.baseUrl = ''
    patch(profile.id, changes)
    setModelOptions((current) => ({ ...current, [profile.id]: [] }))
    setModelNotes((current) => ({ ...current, [profile.id]: '' }))
  }

  const protocolLabel = (id: string) => ai.protocols.find((item) => item.id === id)?.label ?? id

  const buildDraft = (profile: AiProfile): AiProfile => ({
    ...profile,
    headers: textToHeaders(headersText[profile.id] ?? ''),
    ...(keys[profile.id] ? { apiKey: keys[profile.id] } : {}),
  })

  const loadModels = async (profile: AiProfile, { silent = false }: { silent?: boolean } = {}) => {
    const draft = buildDraft(profile)
    const seq = (modelSeq.current[profile.id] ?? 0) + 1
    modelSeq.current[profile.id] = seq
    setModelBusy((current) => ({ ...current, [profile.id]: true }))
    setModelNotes((current) => ({ ...current, [profile.id]: silent ? '正在从端点获取模型…' : '获取中…' }))
    try {
      const result = await api.aiModels(draft)
      if (modelSeq.current[profile.id] !== seq) return
      setModelOptions((current) => ({ ...current, [profile.id]: result.models }))
      setModelNotes((current) => ({
        ...current,
        [profile.id]: result.error
          ? `自动获取失败：${result.error}（可手动输入）`
          : `已获取 ${result.models.length} 个模型${result.url ? ` · ${result.url}` : ''}`,
      }))
    } catch (err) {
      if (modelSeq.current[profile.id] !== seq) return
      setModelNotes((current) => ({
        ...current,
        [profile.id]: `自动获取失败：${errorMessage(err)}（可手动输入）`,
      }))
    } finally {
      if (modelSeq.current[profile.id] === seq) {
        setModelBusy((current) => ({ ...current, [profile.id]: false }))
      }
    }
  }

  // Fetch once for the active profile when the dialog opens, and again whenever
  // the radio selection changes. Other profiles fetch on demand or on blur.
  useEffect(() => {
    if (!activeId || lastAutoId.current === activeId) return
    const profile = profiles.find((item) => item.id === activeId)
    if (!profile || !profile.baseUrl.trim()) return
    lastAutoId.current = activeId
    void loadModels(profile, { silent: true })
    // `loadModels` reads the current form through buildDraft; deps are intentionally
    // just the active id so typing does not spam the endpoint.
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const addProfile = () => {
    const id = crypto.randomUUID()
    setProfiles((current) => [
      ...current,
      { id, name: '新配置', protocol: 'openai-chat', baseUrl: '', model: '', headers: {}, hasKey: false },
    ])
    setHeadersText((current) => ({ ...current, [id]: '' }))
    setActiveId((current) => current || id)
  }

  const removeProfile = (id: string) => {
    setProfiles((current) => {
      const next = current.filter((profile) => profile.id !== id)
      setActiveId((selected) => (selected === id ? (next[0]?.id ?? '') : selected))
      return next
    })
  }

  const testProfile = async (profile: AiProfile) => {
    setNotes((current) => ({ ...current, [profile.id]: '测试中…' }))
    try {
      const result = await api.aiTest(buildDraft(profile))
      setNotes((current) => ({
        ...current,
        [profile.id]: `连通：${result.text.slice(0, 120) || '(空回复)'}`,
      }))
    } catch (err) {
      setNotes((current) => ({ ...current, [profile.id]: `失败：${errorMessage(err)}` }))
    }
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const payload = profiles.map(buildDraft)
      const next = await api.aiSaveProfiles(payload, activeId || null)
      onSaved(next, activeId || null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={() => { if (!busy) onClose() }}>
      <div className="dialog wide profiles" onMouseDown={(event) => event.stopPropagation()}>
        <h3>AI 配置</h3>
        <p className="hint">
          三种协议各一套适配：OpenAI Chat Completions / OpenAI Responses / Anthropic Messages。
          Base URL 和模型留空时使用所选协议的默认值（由服务端补全）。
          推理强度：Chat 发 reasoning_effort，Responses 发 reasoning.effort，Anthropic 换算成 thinking 预算。
          API Key 用 Windows DPAPI 加密后存在本地 config.json，读取接口只返回是否已保存。
        </p>

        <div className="profile-list">
          {profiles.length === 0 ? <p className="muted">还没有配置，点下面的「新增配置」。</p> : null}
          {profiles.map((profile, index) => (
            <div key={profile.id} className={`profile-card${profile.id === activeId ? ' active' : ''}`}>
              <div className="profile-head">
                <label className="radio">
                  <input
                    type="radio"
                    name="active-profile"
                    checked={profile.id === activeId}
                    onChange={() => setActiveId(profile.id)}
                  />
                  当前生效
                </label>
                <input
                  ref={index === 0 ? firstFieldRef : undefined}
                  className="profile-name"
                  value={profile.name}
                  placeholder="配置名称"
                  onChange={(event) => patch(profile.id, { name: event.target.value })}
                />
                <button type="button" className="ghost" onClick={() => removeProfile(profile.id)}>
                  删除
                </button>
              </div>

              <div className="profile-grid">
                <label>
                  协议
                  <select value={profile.protocol} onChange={(event) => changeProtocol(profile, event.target.value)}>
                    {ai.protocols.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  推理强度
                  <select
                    value={profile.reasoningEffort ?? ''}
                    title="OpenAI Chat 传 reasoning_effort，OpenAI Responses 传 reasoning.effort，Anthropic 换算成 thinking 预算"
                    onChange={(event) =>
                      patch(profile.id, { reasoningEffort: event.target.value as ReasoningEffort })
                    }
                  >
                    {REASONING_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="span-2">
                  模型
                  <div className="model-row">
                    <input
                      list={`models-${profile.id}`}
                      value={profile.model}
                      placeholder={ai.protocols.find((item) => item.id === profile.protocol)?.defaultModel ?? ''}
                      onChange={(event) => patch(profile.id, { model: event.target.value })}
                    />
                    <button
                      type="button"
                      onClick={() => void loadModels(profile)}
                      disabled={busy || modelBusy[profile.id]}
                      title="从当前 Base URL 的 /models 端点获取模型；失败时仍可手动输入"
                    >
                      {modelBusy[profile.id] ? '获取中…' : modelOptions[profile.id]?.length ? '刷新模型' : '获取模型'}
                    </button>
                    <datalist id={`models-${profile.id}`}>
                      {(modelOptions[profile.id] ?? []).map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name ?? model.id}
                        </option>
                      ))}
                    </datalist>
                  </div>
                </label>
                <label className="span-2">
                  Base URL
                  <input
                    value={profile.baseUrl}
                    placeholder={ai.protocols.find((item) => item.id === profile.protocol)?.defaultBaseUrl ?? ''}
                    onChange={(event) => patch(profile.id, { baseUrl: event.target.value })}
                    onBlur={() => {
                      if (profile.baseUrl.trim()) void loadModels(profile, { silent: true })
                    }}
                  />
                </label>
                <label className="span-2">
                  API Key
                  <input
                    type="password"
                    value={keys[profile.id] ?? ''}
                    placeholder={profile.hasKey ? '已保存（留空则不修改）' : '粘贴 API Key'}
                    onChange={(event) => setKeys({ ...keys, [profile.id]: event.target.value })}
                  />
                </label>
                <label className="span-2">
                  额外请求头（每行 key: value）
                  <textarea
                    value={headersText[profile.id] ?? ''}
                    placeholder="HTTP-Referer: https://example.com"
                    onChange={(event) => setHeadersText({ ...headersText, [profile.id]: event.target.value })}
                  />
                </label>
              </div>

              {modelNotes[profile.id] ? (
                <p className={`model-note${modelNotes[profile.id].startsWith('自动获取失败') ? ' warn' : ''}`}>
                  {modelNotes[profile.id]}
                </p>
              ) : null}

              <div className="profile-actions">
                <button type="button" onClick={() => void testProfile(profile)} disabled={busy}>
                  测试连接
                </button>
                <span className="muted small">{notes[profile.id] ?? protocolLabel(profile.protocol)}</span>
              </div>
            </div>
          ))}
        </div>

        {error ? <p className="error">{error}</p> : null}

        <div className="actions">
          <button type="button" onClick={addProfile}>
            新增配置
          </button>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
