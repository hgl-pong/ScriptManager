import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from './api'
import type { AiHistoryEntry, AiState, ScriptRow, StatePayload } from './types'
import { LocalAgentDialog } from './LocalAgentDialog'
import { SaveScriptDialog, TYPE_OPTIONS } from './SaveScriptDialog'

type JobState = 'idle' | 'running' | 'done' | 'error' | 'stopped'

const KIND_LABELS: Record<string, string> = {
  generate: '生成',
  explain: '解释',
  diagnose: '诊断',
  logging: '加日志',
  harden: '安全改写',
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

function formatEntryAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

interface AiPaneProps {
  selected: ScriptRow | null
  scanRoots: string[]
  onScriptsChanged: (state: StatePayload) => void
}

export function AiPane({ selected, scanRoots, onScriptsChanged }: AiPaneProps) {
  const [ai, setAi] = useState<AiState | null>(null)
  const [prompt, setPrompt] = useState('')
  const [scriptType, setScriptType] = useState('cmd')
  const [result, setResult] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobState, setJobState] = useState<JobState>('idle')
  const [jobKind, setJobKind] = useState<string | null>(null)
  // The script the current result belongs to; apply must not follow a later selection change.
  const [resultPath, setResultPath] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<AiHistoryEntry[]>([])
  const [tab, setTab] = useState<'result' | 'chat'>('result')
  const [localOpen, setLocalOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const resultRef = useRef<HTMLTextAreaElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const jobIdRef = useRef<string | null>(null)
  // A job id the server already offered via /ai/state; reattach only once per id.
  const attachedJobRef = useRef<string | null>(null)
  // A 停止 click that landed before /ai/ask returned its jobId.
  const cancelRef = useRef(false)
  const atBottomRef = useRef(true)

  const busy = jobState === 'running'
  const resultReady = jobState === 'done' && !error

  const setActiveJob = (id: string | null) => {
    jobIdRef.current = id
    setJobId(id)
  }

  const loadAi = useCallback(async () => {
    try {
      const next = await api.aiState()
      setAi(next)
      setScriptType((current) => next.lastScriptType || current)
      // A reload orphaned the local job id, but the server still owns the job; reattach
      // instead of leaving every new ask blocked behind a 409 with 停止 disabled.
      const job = next.job
      if (job && job.state === 'running' && jobIdRef.current === null && attachedJobRef.current !== job.id) {
        attachedJobRef.current = job.id
        setResult('')
        setResultPath(null)
        setStatus('')
        setError(null)
        setJobKind(job.kind)
        setJobState('running')
        setActiveJob(job.id)
      }
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const payload = await api.aiHistory()
      setHistory(payload.entries)
    } catch {
      // History is secondary; the main error path handles request failures.
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    void loadAi()
  }, [loadAi])

  // Streaming text arrives by polling, same shape as a script run but with a character cursor.
  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    let cursor = 0
    let timer: number | undefined

    const tick = async () => {
      try {
        const chunk = await api.aiStream(jobId, cursor)
        if (cancelled) return
        cursor = chunk.cursor
        if (chunk.text) setResult((previous) => previous + chunk.text)
        setJobState(chunk.state)
        if (chunk.error) setError(chunk.error)
        if (chunk.state !== 'running') {
          setActiveJob(null)
          void loadHistory()
          return
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err))
          setActiveJob(null)
          setJobState('error')
        }
        return
      }
      timer = window.setTimeout(tick, 150)
    }

    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [jobId, loadHistory])

  useEffect(() => {
    const element = resultRef.current
    // Never yank the view back down while the user is reading above the stream.
    if (element && jobState === 'running' && atBottomRef.current) element.scrollTop = element.scrollHeight
  }, [result, jobState])

  useEffect(() => {
    if (tab !== 'chat') return
    const element = chatRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [history, tab])

  const start = async (kind: string, extra: { prompt?: string; path?: string; previous?: string }) => {
    if (!ai?.localAgent?.enabled) {
      setError('先点「设置…」启用本地 Code Agent')
      return
    }
    setError(null)
    setStatus('')
    setResult('')
    setTab('result')
    atBottomRef.current = true
    setJobKind(kind)
    setResultPath(kind === 'generate' ? null : (extra.path ?? null))
    setJobState('running')
    cancelRef.current = false
    try {
      const started = await api.aiAsk({ kind, type: scriptType, ...extra })
      if (cancelRef.current) {
        // 停止 was clicked while the request was still in flight; honour it now.
        cancelRef.current = false
        setActiveJob(null)
        setJobState('stopped')
        void api.aiStop(started.jobId).catch((err: unknown) => setError(errorMessage(err)))
        return
      }
      setActiveJob(started.jobId)
    } catch (err) {
      cancelRef.current = false
      setJobState('error')
      setError(errorMessage(err))
    }
  }

  const generate = () => {
    const previous = jobKind === 'generate' && result.trim() ? result.trim() : undefined
    void start('generate', { prompt, previous })
  }

  const act = (kind: string) => {
    if (!selected) return
    void start(kind, { path: selected.path })
  }

  const stop = () => {
    if (jobId) {
      api.aiStop(jobId).catch((err: unknown) => setError(errorMessage(err)))
    } else if (jobState === 'running') {
      // No jobId yet (the ask request has not resolved); remember the intent and
      // stop the job as soon as its id arrives instead of silently doing nothing.
      cancelRef.current = true
    }
  }

  const testLocal = async () => {
    if (!ai?.localAgent?.enabled) {
      setError('先点「设置…」启用本地 Code Agent')
      return
    }
    setStatus('测试连接中…')
    setError(null)
    try {
      const result = await api.aiLocalTest()
      setStatus(`连接正常：${result.text.slice(0, 120) || '(空回复)'}`)
    } catch (err) {
      setStatus('')
      setError(errorMessage(err))
    }
  }

  const showEntry = (entry: AiHistoryEntry) => {
    if (entry.state !== 'done' || entry.truncated || !entry.text) return
    setResult(entry.text)
    setResultPath(entry.path ?? null)
    setJobKind(entry.kind)
    setJobState('done')
    setStatus('')
    setError(null)
    setTab('result')
    atBottomRef.current = true
  }

  const clearHistory = async () => {
    try {
      await api.aiHistoryClear()
      setHistory([])
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const applyResult = async () => {
    if (!resultPath) return
    const label = resultPath.split(/[\\/]/).pop() ?? resultPath
    if (
      !window.confirm(
        `将用 AI 结果覆盖：\n${resultPath}\n\n覆盖前会先备份原文件；若已有旧的 .bak，会另存为新的备份路径。继续？`,
      )
    ) {
      return
    }
    setError(null)
    try {
      const info = await api.aiApply(resultPath, result)
      const backupLabel = info.backupPath ? (info.backupPath.split(/[\\/]/).pop() ?? info.backupPath) : null
      setStatus(
        `已回写 ${label}，改动约 ${info.changedLines} 行` +
          (backupLabel ? `；原文件已备份为 ${backupLabel}` : '；未收到备份路径，请自行确认原文件'),
      )
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const statusLabel = busy
    ? jobKind === 'generate'
      ? '生成中…'
      : '处理中…'
    : jobState === 'done'
      ? '完成'
      : jobState === 'stopped'
        ? '已停止'
        : jobState === 'error'
          ? '出错'
          : ''

  // Only a finished, error-free write-back job may overwrite the source script.
  const writable = (jobKind === 'logging' || jobKind === 'harden') && resultReady

  return (
    <section className="ai">
      <div className="pane-head">
        <span className="muted">AI</span>
        <span className="ai-agent" title={ai?.localAgent?.command ?? ''}>
          {ai?.localAgent?.enabled
            ? `本地 ${ai.localAgent.command || 'Claude Code'}${ai.localAgent.model ? ` · ${ai.localAgent.model}` : ''}`
            : '本地 Agent 未启用'}
        </span>
        <button
          type="button"
          className="ghost"
          onClick={() => void testLocal()}
          disabled={!ai?.localAgent?.enabled}
        >
          连接测试
        </button>
        <button type="button" className="ghost" onClick={() => setLocalOpen(true)}>
          设置…
        </button>
        <span className="spacer" />
        <span className={`status ${jobState === 'error' ? 'error' : busy ? 'running' : ''}`}>{statusLabel}</span>
      </div>

      <div className="ai-rows">
        <div className="ai-row">
          <input
            className="ai-prompt"
            value={prompt}
            placeholder="一句话描述要生成的脚本，例如：把某个目录下 30 天前的 .log 删掉"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              // Enter also commits an IME candidate; that must not start a request.
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (prompt.trim() && !busy) generate()
            }}
          />
          <select value={scriptType} onChange={(event) => setScriptType(event.target.value)}>
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button type="button" className="primary" onClick={generate} disabled={busy || !prompt.trim()}>
            {jobKind === 'generate' && result.trim() ? '重生成' : '生成'}
          </button>
        </div>

        <div className="ai-row">
          <button type="button" onClick={() => act('explain')} disabled={!selected || busy}>
            解释
          </button>
          <button type="button" onClick={() => act('diagnose')} disabled={!selected || busy}>
            为什么报错
          </button>
          <button type="button" onClick={() => act('logging')} disabled={!selected || busy}>
            加日志
          </button>
          <button type="button" onClick={() => act('harden')} disabled={!selected || busy}>
            改写更安全
          </button>
          <span className="spacer" />
          {jobKind === 'generate' ? (
            <button type="button" onClick={() => setSaveOpen(true)} disabled={!result.trim() || busy || !resultReady}>
              保存为脚本…
            </button>
          ) : null}
          {writable ? (
            <button
              type="button"
              onClick={() => void applyResult()}
              disabled={!resultPath || !result.trim() || busy || !resultReady}
              title={resultPath ?? ''}
            >
              回写文件
            </button>
          ) : null}
          <button type="button" onClick={stop} disabled={!busy}>
            停止
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setResult('')
              setResultPath(null)
              setStatus('')
              setError(null)
              setJobKind(null)
              setJobState('idle')
              setActiveJob(null)
              atBottomRef.current = true
            }}
            disabled={busy}
          >
            清空
          </button>
        </div>

        <div className="ai-tabs">
          <button type="button" className={tab === 'result' ? 'active' : ''} onClick={() => setTab('result')}>
            当前结果
          </button>
          <button type="button" className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
            聊天记录{history.length ? ` (${history.length})` : ''}
          </button>
          <span className="spacer" />
          {tab === 'chat' ? (
            <button
              type="button"
              className="ghost"
              onClick={() => void clearHistory()}
              disabled={history.length === 0}
            >
              清空记录
            </button>
          ) : null}
        </div>

        {tab === 'result' ? (
          <textarea
            className="ai-result"
            ref={resultRef}
            value={result}
            readOnly={busy}
            onChange={(event) => setResult(event.target.value)}
            onScroll={(event) => {
              const element = event.currentTarget
              atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
            }}
            placeholder={selected ? `选中：${selected.name}（解释 / 诊断 / 加日志 / 改写都作用于它）` : '选一个脚本，或用上面一句话生成一个新脚本'}
          />
        ) : (
          <div className="chat-log" ref={chatRef}>
            {history.length === 0 ? <p className="muted">还没有聊天记录</p> : null}
            {history.map((entry) => (
              <article className="chat-entry" key={entry.id}>
                <header>
                  <span className={`chat-kind${entry.state === 'done' ? '' : ' error'}`}>{kindLabel(entry.kind)}</span>
                  <span className="muted small">{formatEntryAt(entry.at)}</span>
                  {entry.path ? (
                    <span className="muted small">{entry.path.split(/[\\/]/).pop()}</span>
                  ) : null}
                  <span className="spacer" />
                  {entry.state !== 'done' ? (
                    <span className="error small">
                      {entry.state === 'stopped' ? '已停止' : '出错'}
                      {entry.error ? `：${entry.error}` : ''}
                    </span>
                  ) : null}
                </header>
                <div className="chat-user">
                  {entry.kind === 'generate'
                    ? entry.prompt
                    : `${kindLabel(entry.kind)}：${entry.path ? (entry.path.split(/[\\/]/).pop() ?? entry.path) : ''}`}
                </div>
                <pre className="chat-assistant">
                  {entry.text || '（无输出）'}
                  {entry.truncated ? '\n…（记录已截断，未载入完整结果）' : ''}
                </pre>
                <div className="chat-actions">
                  <button
                    type="button"
                    onClick={() => showEntry(entry)}
                    disabled={entry.state !== 'done' || entry.truncated || !entry.text}
                  >
                    载入结果
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {status ? <p className="ai-status">{status}</p> : null}
        {error ? (
          <p className="ai-error" onClick={() => setError(null)} role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {localOpen && ai ? (
        <LocalAgentDialog
          local={ai.localAgent}
          onClose={() => setLocalOpen(false)}
          onSaved={(next) => {
            setAi(next)
            setScriptType(next.lastScriptType || scriptType)
            setLocalOpen(false)
          }}
        />
      ) : null}

      {saveOpen ? (
        <SaveScriptDialog
          defaultDir={ai?.lastScriptDir || scanRoots[0] || ''}
          defaultType={scriptType}
          content={result}
          onClose={() => setSaveOpen(false)}
          onSaved={(next, path, backupPath) => {
            onScriptsChanged(next)
            const backupLabel = backupPath ? (backupPath.split(/[\\/]/).pop() ?? backupPath) : null
            setStatus(`已保存到 ${path}` + (backupLabel ? `；原文件已备份为 ${backupLabel}` : ''))
            setSaveOpen(false)
            // Refresh lastScriptDir (among other state) so the next save dialog defaults correctly.
            void loadAi()
          }}
        />
      ) : null}
    </section>
  )
}
