import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from './api'
import type { AiState, LocalAgent, LocalEffort } from './types'

const EFFORT_OPTIONS: { value: LocalEffort; label: string }[] = [
  { value: '', label: '默认（不指定）' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
]

interface LocalAgentDialogProps {
  local: LocalAgent
  onClose: () => void
  onSaved: (state: AiState) => void
}

export function LocalAgentDialog({ local, onClose, onSaved }: LocalAgentDialogProps) {
  const [form, setForm] = useState<LocalAgent>({ ...local })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstFieldRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const patch = (changes: Partial<LocalAgent>) => {
    setForm((current) => ({ ...current, ...changes }))
  }

  const test = async () => {
    setBusy(true)
    setError(null)
    setNote('测试中…')
    try {
      const result = await api.aiLocalTest(form)
      setNote(`连通：${result.text.slice(0, 160) || '(空回复)'}`)
    } catch (err) {
      setNote('')
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.aiSaveLocal(form))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={() => { if (!busy) onClose() }}>
      <div className="dialog wide" onMouseDown={(event) => event.stopPropagation()}>
        <h3>本地 Code Agent</h3>
        <p className="hint">
          使用本机 Claude Code CLI：固定附加 <code>-p --output-format text --tools "" --permission-prompts none</code>，
          提示词通过 stdin 传入；模型和推理强度会追加 <code>--model</code> / <code>--effort</code>。
          需要先安装并登录 <code>claude</code>。
        </p>

        <label className="radio">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
          启用本地 Code Agent
        </label>

        <label>
          命令
          <input
            ref={firstFieldRef}
            value={form.command}
            placeholder="claude"
            onChange={(event) => patch({ command: event.target.value })}
          />
        </label>

        <div className="profile-grid">
          <label>
            模型
            <input
              value={form.model}
              placeholder="留空使用 Claude Code 默认"
              onChange={(event) => patch({ model: event.target.value })}
            />
          </label>
          <label>
            推理强度
            <select
              value={form.effort}
              onChange={(event) => patch({ effort: event.target.value as LocalEffort })}
            >
              {EFFORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="span-2">
            工作目录
            <input
              value={form.cwd}
              placeholder="留空使用应用目录"
              onChange={(event) => patch({ cwd: event.target.value })}
            />
          </label>
          <label className="span-2">
            额外参数
            <input
              value={form.extraArgs}
              placeholder="例如 --permission-mode plan"
              onChange={(event) => patch({ extraArgs: event.target.value })}
            />
          </label>
          <label>
            超时（秒）
            <input
              type="number"
              min={10}
              max={3600}
              value={Math.round(form.timeoutMs / 1000)}
              onChange={(event) => patch({ timeoutMs: Number(event.target.value) * 1000 })}
            />
          </label>
        </div>

        {error ? <p className="error">{error}</p> : null}

        <div className="profile-actions">
          <button type="button" onClick={() => void test()} disabled={busy}>
            测试连接
          </button>
          <span className="muted small">{note}</span>
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
