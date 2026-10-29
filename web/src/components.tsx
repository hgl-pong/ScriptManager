import { useEffect, useRef, useState } from 'react'
import type { FormEvent, MouseEvent as ReactMouseEvent } from 'react'
import { api, errorMessage } from './api'
import type { BrowsePayload, RunHistoryEntry, RunInfo, ScriptRow } from './types'
import { formatLastRun, typeLabel } from '../../shared/rows.js'

interface TopBarProps {
  query: string
  tag: string
  tags: string[]
  count: number
  total: number
  onQuery: (value: string) => void
  onTag: (value: string) => void
  onRefresh: () => void
  onDirs: () => void
}

export function TopBar({ query, tag, tags, count, total, onQuery, onTag, onRefresh, onDirs }: TopBarProps) {
  return (
    <header className="toolbar">
      <input
        className="search"
        placeholder="搜索名称、别名、路径、标签"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        autoFocus
      />
      <select className="tag-filter" value={tag} onChange={(event) => onTag(event.target.value)}>
        <option value="">全部标签</option>
        {tags.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <button type="button" onClick={onRefresh} title="重新扫描目录（F5）">
        刷新
      </button>
      <button type="button" onClick={onDirs} title="管理扫描根目录">
        目录…
      </button>
      <span className="spacer" />
      <span className={`count${total === 0 ? ' warn' : ''}`}>
        {total === 0 ? '还没有扫描目录' : `${count} / ${total} 个脚本`}
      </span>
    </header>
  )
}

interface ScriptListProps {
  rows: ScriptRow[]
  selectedPath: string | null
  emptyHint: string
  onSelect: (row: ScriptRow) => void
  onRun: (row: ScriptRow) => void
  onMenu: (event: ReactMouseEvent, row: ScriptRow) => void
}

export function ScriptList({ rows, selectedPath, emptyHint, onSelect, onRun, onMenu }: ScriptListProps) {
  return (
    <section className="list">
      <div className="list-head">
        <span>名称</span>
        <span>类型</span>
        <span>最近</span>
        <span>标签</span>
      </div>
      <div className="rows">
        {rows.length === 0 ? <div className="empty">{emptyHint}</div> : null}
        {rows.map((row) => {
          const failed = row.lastExit !== null && row.lastExit !== 0
          return (
            <button
              type="button"
              key={row.path}
              className={`row${row.path === selectedPath ? ' selected' : ''}${failed ? ' failed' : ''}`}
              title={row.path}
              onClick={() => onSelect(row)}
              onDoubleClick={() => onRun(row)}
              onContextMenu={(event) => onMenu(event, row)}
            >
              <span className="cell name">{row.displayName}</span>
              <span className="cell type">{typeLabel(row.type)}</span>
              <span className="cell last">{formatLastRun(row)}</span>
              <span className="cell tags">{row.tags.join(', ')}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

interface OutputPaneProps {
  header: string
  tone: 'idle' | 'running' | 'ok' | 'error'
  lines: string[]
  onClear: () => void
}

export function OutputPane({ header, tone, lines, onClear }: OutputPaneProps) {
  const stream = useRef<HTMLPreElement>(null)
  // Only follow the tail while the user is already looking at it.
  const atBottomRef = useRef(true)

  useEffect(() => {
    const element = stream.current
    if (lines.length === 0) atBottomRef.current = true
    if (element && atBottomRef.current) element.scrollTop = element.scrollHeight
  }, [lines])

  return (
    <section className="output">
      <div className="pane-head">
        <span className={`status ${tone}`}>{header}</span>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={onClear} disabled={lines.length === 0}>
          清空
        </button>
      </div>
      <pre
        className="stream"
        ref={stream}
        onScroll={(event) => {
          const element = event.currentTarget
          atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
        }}
      >
        {lines.join('\n')}
      </pre>
    </section>
  )
}

interface BottomBarProps {
  params: string
  recentParams: string[]
  running: boolean
  canRun: boolean
  onParams: (value: string) => void
  onRun: () => void
  onStop: () => void
  onTerminal: () => void
  onHistory: () => void
}

export function BottomBar({
  params,
  recentParams,
  running,
  canRun,
  onParams,
  onRun,
  onStop,
  onTerminal,
  onHistory,
}: BottomBarProps) {
  return (
    <footer className="bottom">
      <label className="params-label" htmlFor="params">
        参数
      </label>
      <input
        id="params"
        className="params"
        list="recent-params"
        value={params}
        placeholder='例如 --dry-run "some dir"'
        onChange={(event) => onParams(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          // Enter also commits an IME candidate; that must not run the script.
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (canRun && !running) onRun()
        }}
      />
      <datalist id="recent-params">
        {recentParams.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <button type="button" className="primary" onClick={onRun} disabled={!canRun || running}>
        运行
      </button>
      <button type="button" onClick={onStop} disabled={!running}>
        停止
      </button>
      <button type="button" onClick={onTerminal} disabled={!canRun}>
        在终端里运行
      </button>
      <button type="button" onClick={onHistory}>
        运行记录…
      </button>
    </footer>
  )
}

interface MenuItem {
  label: string
  onClick: () => void
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('blur', close)
    }
  }, [onClose])

  return (
    <ul className="menu" style={{ left: x, top: y }} onMouseDown={(event) => event.stopPropagation()}>
      {items.map((item) => (
        <li key={item.label}>
          <button
            type="button"
            onClick={() => {
              item.onClick()
              onClose()
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  )
}

interface MetaDialogProps {
  row: ScriptRow
  field: 'alias' | 'tags'
  onSave: (alias: string, tags: string[]) => void
  onCancel: () => void
}

export function MetaDialog({ row, field, onSave, onCancel }: MetaDialogProps) {
  const [alias, setAlias] = useState(row.displayName)
  const [tags, setTags] = useState(row.tags.join(', '))
  const aliasRef = useRef<HTMLInputElement>(null)
  const tagsRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const target = field === 'tags' ? tagsRef.current : aliasRef.current
    target?.focus()
    target?.select()
  }, [field])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSave(
      alias.trim(),
      tags
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
    )
  }

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <form className="dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}>
        <h3>编辑条目</h3>
        <code className="path">{row.path}</code>
        <label>
          别名
          <input ref={aliasRef} value={alias} onChange={(event) => setAlias(event.target.value)} />
        </label>
        <label>
          标签
          <input ref={tagsRef} value={tags} onChange={(event) => setTags(event.target.value)} placeholder="运维, 日志" />
        </label>
        <p className="hint">标签用逗号分隔；别名留空则显示文件名。</p>
        <div className="actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="primary">
            确定
          </button>
        </div>
      </form>
    </div>
  )
}

interface DirsDialogProps {
  roots: string[]
  onSave: (roots: string[]) => void
  onCancel: () => void
}

export function DirsDialog({ roots, onSave, onCancel }: DirsDialogProps) {
  const [chosen, setChosen] = useState<string[]>(roots)
  const [listing, setListing] = useState<BrowsePayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const go = (target: string) => {
    api
      .browse(target)
      .then(setListing)
      .catch((err: unknown) => setError(errorMessage(err)))
  }

  useEffect(() => {
    go('')
  }, [])

  const add = () => {
    if (!listing?.path) return
    if (!chosen.includes(listing.path)) setChosen([...chosen, listing.path])
  }

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div className="dialog wide" onMouseDown={(event) => event.stopPropagation()}>
        <h3>扫描目录</h3>
        <p className="hint">递归扫描 .bat / .cmd / .ps1 / .py；跳过 .git、node_modules 等目录。</p>
        <div className="browser-head">
          <button type="button" onClick={() => go(listing?.parent ?? '')} disabled={!listing?.path}>
            ↑ 上级
          </button>
          <code>{listing?.path || '选择盘符'}</code>
        </div>
        <div className="browser-list">
          {listing?.dirs.length === 0 ? <span className="muted">没有子目录</span> : null}
          {listing?.dirs.map((dir) => (
            <button type="button" key={dir.path} onClick={() => go(dir.path)}>
              {dir.name}
            </button>
          ))}
        </div>
        <div className="browser-actions">
          <button type="button" onClick={add} disabled={!listing?.path}>
            添加此目录
          </button>
          {error ? <span className="error">{error}</span> : null}
        </div>
        <div className="chosen">
          {chosen.length === 0 ? <span className="muted">还没有选择目录</span> : null}
          {chosen.map((item) => (
            <div key={item} className="chosen-row">
              <code>{item}</code>
              <button type="button" className="ghost" onClick={() => setChosen(chosen.filter((entry) => entry !== item))}>
                移除
              </button>
            </div>
          ))}
        </div>
        <div className="actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => onSave(chosen)}>
            保存并扫描
          </button>
        </div>
      </div>
    </div>
  )
}

interface RunHistoryDialogProps {
  runs: RunHistoryEntry[]
  scripts: ScriptRow[]
  onPick: (run: RunHistoryEntry, runNow: boolean) => void
  onClose: () => void
}

export function RunHistoryDialog({ runs, scripts, onPick, onClose }: RunHistoryDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide run-history" onMouseDown={(event) => event.stopPropagation()}>
        <h3>运行记录</h3>
        <p className="hint">最近 100 次运行。可以填入当时的参数，或直接按同样的参数再次运行。</p>
        <div className="run-list">
          {runs.length === 0 ? <p className="muted">还没有运行记录</p> : null}
          {runs.map((run) => {
            const script = scripts.find((item) => item.path.toLowerCase() === run.path.toLowerCase())
            const seconds = ((run.durationMs ?? 0) / 1000).toFixed(1)
            return (
              <div className="run-entry" key={run.id}>
                <div className="run-meta">
                  <span className="run-time">{formatRunAt(run.at)}</span>
                  <span className="run-name">{run.name}</span>
                  <span className={`run-exit ${run.exitCode === 0 ? 'ok' : 'bad'}`}>
                    退出码 {run.exitCode ?? '—'}
                  </span>
                  <span className="muted small">{seconds}s</span>
                </div>
                <code className="run-params">{run.params || '（无参数）'}</code>
                <div className="run-actions">
                  {!script ? <span className="error small">脚本已不存在</span> : null}
                  <button type="button" onClick={() => onPick(run, false)} disabled={!script}>
                    填入参数
                  </button>
                  <button type="button" className="primary" onClick={() => onPick(run, true)} disabled={!script}>
                    再次运行
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        <div className="actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

function formatRunAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function runHeader(run: RunInfo | null, selected: ScriptRow | null): string {
  if (!run) return selected ? selected.name : '就绪'
  if (run.state === 'running') return `${run.name} · 运行中…`
  const seconds = (run.durationMs ?? 0) / 1000
  return `${run.name} · 退出码 ${run.exitCode} · ${seconds.toFixed(1)}s`
}

export function runTone(run: RunInfo | null): 'idle' | 'running' | 'ok' | 'error' {
  if (!run) return 'idle'
  if (run.state === 'running') return 'running'
  return run.exitCode === 0 ? 'ok' : 'error'
}
