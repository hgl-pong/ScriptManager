import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from './api'
import type { BrowsePayload, StatePayload } from './types'

export const TYPE_OPTIONS = [
  { value: 'cmd', label: 'BAT (.bat)' },
  { value: 'powershell', label: 'PS1 (.ps1)' },
  { value: 'python', label: 'PY (.py)' },
]

interface SaveScriptDialogProps {
  defaultDir: string
  defaultType: string
  content: string
  onClose: () => void
  onSaved: (state: StatePayload, path: string, backupPath: string | null) => void
}

export function SaveScriptDialog({ defaultDir, defaultType, content, onClose, onSaved }: SaveScriptDialogProps) {
  const [dir, setDir] = useState(defaultDir)
  const [type, setType] = useState(defaultType)
  const [name, setName] = useState('')
  const [listing, setListing] = useState<BrowsePayload | null>(null)
  const [needsOverwrite, setNeedsOverwrite] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  // Esc closes only when no save is in flight; the disabled 取消 button is the same guarantee.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const browse = (target: string) => {
    api
      .browse(target)
      .then(setListing)
      .catch((err: unknown) => setError(errorMessage(err)))
  }

  useEffect(() => {
    browse(defaultDir)
  }, [defaultDir])

  const save = async (overwrite: boolean) => {
    if (!dir.trim() || !name.trim()) {
      setError('目录和文件名都要填')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const saved = await api.aiSaveScript({
        dir: dir.trim(),
        name: name.trim(),
        type,
        content,
        overwrite,
      })
      onSaved(saved.state, saved.path, saved.backupPath ?? null)
    } catch (err) {
      const code = (err as { code?: string }).code
      setNeedsOverwrite(code === 'exists')
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={() => { if (!busy) onClose() }}>
      <div className="dialog wide" onMouseDown={(event) => event.stopPropagation()}>
        <h3>保存为脚本</h3>

        <div className="browser-head">
          <button type="button" onClick={() => browse(dir)}>
            打开此目录
          </button>
          <button type="button" onClick={() => browse(listing?.parent ?? '')} disabled={!listing?.path}>
            ↑ 上级
          </button>
          <code>{listing?.path || '选择盘符'}</code>
        </div>

        <div className="browser-list">
          {listing?.dirs.map((entry) => (
            <button
              type="button"
              key={entry.path}
              onClick={() => {
                setDir(entry.path)
                browse(entry.path)
              }}
            >
              {entry.name}
            </button>
          ))}
        </div>

        <label>
          目录
          <input value={dir} onChange={(event) => setDir(event.target.value)} />
        </label>
        <label>
          文件名
          <input
            ref={nameRef}
            value={name}
            placeholder="例如 clean-old-logs（扩展名自动补）"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          解释器
          <select value={type} onChange={(event) => setType(event.target.value)}>
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {error ? <p className="error">{error}</p> : null}

        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          {needsOverwrite ? (
            <button type="button" className="primary" onClick={() => void save(true)} disabled={busy}>
              覆盖（备份 .bak）
            </button>
          ) : null}
          <button type="button" className="primary" onClick={() => void save(false)} disabled={busy}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
