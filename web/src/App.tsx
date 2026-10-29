import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { api, errorMessage } from './api'
import type { RunHistoryEntry, RunInfo, ScriptRow, StatePayload } from './types'
import { filterRows } from '../../shared/rows.js'
import {
  BottomBar,
  ContextMenu,
  DirsDialog,
  MetaDialog,
  OutputPane,
  RunHistoryDialog,
  ScriptList,
  TopBar,
  runHeader,
  runTone,
} from './components'
import { AiPane } from './AiPane'

const EMPTY_STATE: StatePayload = { scanRoots: [], tags: [], scripts: [], runs: [] }

export default function App() {
  const [state, setState] = useState<StatePayload>(EMPTY_STATE)
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [params, setParams] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; row: ScriptRow } | null>(null)
  const [metaDialog, setMetaDialog] = useState<{ row: ScriptRow; field: 'alias' | 'tags' } | null>(null)
  const [dirsOpen, setDirsOpen] = useState(false)
  const [runsOpen, setRunsOpen] = useState(false)

  const rows = useMemo(() => filterRows(state.scripts, { query, tag: tagFilter }), [state.scripts, query, tagFilter])
  const selected = useMemo(
    () => state.scripts.find((row) => row.path === selectedPath) ?? null,
    [state.scripts, selectedPath],
  )
  const recentParams = useMemo(() => {
    if (!selected) return []
    const values = state.runs
      .filter((run) => run.path.toLowerCase() === selected.path.toLowerCase() && run.params)
      .map((run) => run.params)
    return [...new Set(values)].slice(0, 12)
  }, [state.runs, selected])
  const running = runInfo?.state === 'running'

  const applyState = useCallback((next: StatePayload) => {
    setState(next)
    setSelectedPath((current) => (current && next.scripts.some((row) => row.path === current) ? current : null))
    // A page reload mid-run must re-attach to the server's run instead of orphaning it.
    if (next.running) {
      setRunId((current) => current ?? next.running ?? null)
      setRunInfo((current) => current ?? { name: '进行中的运行', state: 'running', exitCode: null, durationMs: null })
    } else {
      // No run on the server: a stale "运行中…" must not keep 运行 disabled forever.
      setRunInfo((current) => (current && current.state === 'running' ? null : current))
    }
  }, [])

  const loadState = useCallback(
    async (rescan: boolean) => {
      try {
        applyState(rescan ? await api.scan() : await api.state())
      } catch (err) {
        setError(errorMessage(err))
      }
    },
    [applyState],
  )

  useEffect(() => {
    void loadState(false)
  }, [loadState])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F5') {
        event.preventDefault()
        void loadState(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [loadState])

  // Output arrives by polling (see task-spec: reachable everywhere, no stream state to babysit).
  useEffect(() => {
    if (!runId) return
    let cancelled = false
    let cursor = 0
    let timer: number | undefined

    const tick = async () => {
      try {
        const chunk = await api.output(runId, cursor)
        if (cancelled) return
        cursor = chunk.cursor
        if (chunk.lines.length > 0) setLines((previous) => [...previous, ...chunk.lines])
        setRunInfo((previous) =>
          previous
            ? { ...previous, state: chunk.state, exitCode: chunk.exitCode, durationMs: chunk.durationMs }
            : previous,
        )
        if (chunk.state === 'exited') {
          setRunId(null)
          void loadState(false)
          return
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err))
          setRunId(null)
          // Without this the pane stays "运行中…" and 运行 stays disabled after a
          // server restart; clearing both lets a rescan recover.
          setRunInfo(null)
        }
        return
      }
      timer = window.setTimeout(tick, 200)
    }

    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [runId, loadState])

  const select = (row: ScriptRow) => {
    setSelectedPath(row.path)
    setParams(row.lastParams ?? '')
  }

  const startRun = async (row?: ScriptRow, explicitParams?: string) => {
    const target = row ?? selected
    if (!target || running) return
    // Double-clicking another row must run with *its* remembered params, not the box's stale text.
    const runParams =
      explicitParams ?? (row && row.path !== selectedPath ? (row.lastParams ?? '') : params)
    if (row) select(row)
    setError(null)
    setLines([])
    setRunInfo({ name: target.name, state: 'running', exitCode: null, durationMs: null })
    try {
      const started = await api.run(target.path, runParams)
      setRunId(started.runId)
    } catch (err) {
      setRunInfo(null)
      setError(errorMessage(err))
    }
  }

  const pickRun = (run: RunHistoryEntry, runNow: boolean) => {
    const row = state.scripts.find((item) => item.path.toLowerCase() === run.path.toLowerCase())
    if (!row) return
    select(row)
    setParams(run.params)
    setRunsOpen(false)
    if (runNow) void startRun(row, run.params)
  }

  const stopRun = () => {
    if (!runId) return
    api.stop(runId).catch((err: unknown) => setError(errorMessage(err)))
  }

  const runInTerminal = () => {
    if (!selected) return
    api.terminal(selected.path, params).catch((err: unknown) => setError(errorMessage(err)))
  }

  const saveMeta = (alias: string, tags: string[]) => {
    if (!metaDialog) return
    api
      .meta(metaDialog.row.path, alias, tags)
      .then((next) => {
        applyState(next)
        setMetaDialog(null)
      })
      .catch((err: unknown) => setError(errorMessage(err)))
  }

  const saveDirs = (roots: string[]) => {
    api
      .roots(roots)
      .then((next) => {
        applyState(next)
        setDirsOpen(false)
      })
      .catch((err: unknown) => setError(errorMessage(err)))
  }

  const openMenu = (event: ReactMouseEvent, row: ScriptRow) => {
    event.preventDefault()
    select(row)
    setMenu({ x: event.clientX, y: event.clientY, row })
  }

  const menuItems = menu
    ? [
        { label: '编辑别名…', onClick: () => setMetaDialog({ row: menu.row, field: 'alias' }) },
        { label: '编辑标签…', onClick: () => setMetaDialog({ row: menu.row, field: 'tags' }) },
        { label: '用默认编辑器打开', onClick: () => void api.open(menu.row.path).catch((err: unknown) => setError(errorMessage(err))) },
        { label: '在资源管理器中显示', onClick: () => void api.reveal(menu.row.path).catch((err: unknown) => setError(errorMessage(err))) },
        { label: '复制路径', onClick: () => void navigator.clipboard.writeText(menu.row.path) },
      ]
    : []

  return (
    <div className="app">
      <TopBar
        query={query}
        tag={tagFilter}
        tags={state.tags}
        count={rows.length}
        total={state.scripts.length}
        onQuery={setQuery}
        onTag={setTagFilter}
        onRefresh={() => void loadState(true)}
        onDirs={() => setDirsOpen(true)}
      />

      <div className="main">
        <ScriptList
          rows={rows}
          selectedPath={selectedPath}
          emptyHint={
            state.scanRoots.length === 0 ? '还没有扫描目录，点「目录…」添加' : '没有匹配的脚本'
          }
          onSelect={select}
          onRun={(row) => void startRun(row)}
          onMenu={openMenu}
        />
        <div className="right">
          <OutputPane
            header={runHeader(runInfo, selected)}
            tone={runTone(runInfo)}
            lines={lines}
            onClear={() => setLines([])}
          />
          <AiPane
            selected={selected}
            scanRoots={state.scanRoots}
            onScriptsChanged={(next) => applyState(next)}
          />
        </div>
      </div>

      <BottomBar
        params={params}
        recentParams={recentParams}
        running={Boolean(running)}
        canRun={Boolean(selected)}
        onParams={setParams}
        onRun={() => void startRun()}
        onStop={stopRun}
        onTerminal={runInTerminal}
        onHistory={() => setRunsOpen(true)}
      />

      {error ? (
        <div className="toast" onClick={() => setError(null)} role="alert">
          {error}
        </div>
      ) : null}

      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} /> : null}

      {metaDialog ? (
        <MetaDialog
          row={metaDialog.row}
          field={metaDialog.field}
          onSave={saveMeta}
          onCancel={() => setMetaDialog(null)}
        />
      ) : null}

      {dirsOpen ? (
        <DirsDialog roots={state.scanRoots} onSave={saveDirs} onCancel={() => setDirsOpen(false)} />
      ) : null}

      {runsOpen ? (
        <RunHistoryDialog
          runs={state.runs}
          scripts={state.scripts}
          onPick={pickRun}
          onClose={() => setRunsOpen(false)}
        />
      ) : null}
    </div>
  )
}
