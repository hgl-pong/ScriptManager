// Runner: build the command line, start the child process, hand back decoded lines
// incrementally, report exit code + duration, kill the process tree, fall back to a
// real console window. No HTTP here - the server polls it, the tests poll it too.

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { scriptType } from './library.js'

const CODE_PAGE_ENCODINGS = {
  437: 'windows-1252',
  850: 'windows-1252',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  54936: 'gb18030',
  65001: 'utf-8',
}

const MAX_LINES = 6000
const TRIM_TO = 4000

let decoder = null

// Console tools on Windows write in the OEM code page (936 / gbk on zh-CN), not UTF-8.
export function consoleDecoder() {
  if (decoder) return decoder
  let label = 'utf-8'
  try {
    const output = execFileSync('cmd.exe', ['/c', 'chcp'], { encoding: 'latin1' })
    const match = String(output).match(/(\d{3,5})/)
    if (match) label = CODE_PAGE_ENCODINGS[Number(match[1])] ?? label
  } catch {
    // Keep utf-8; a wrong guess only affects non-ASCII output.
  }
  try {
    decoder = new TextDecoder(label)
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  return decoder
}

export function splitParams(text = '') {
  const tokens = []
  let current = ''
  let quote = null
  let started = false

  for (const char of String(text ?? '')) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started || current) tokens.push(current)
  return tokens
}

export function buildSpec(filePath, paramText = '') {
  const type = scriptType(filePath)
  if (!type) throw new Error(`不支持的脚本类型：${filePath}`)

  const params = splitParams(paramText)
  const quoted = `"${filePath}"`
  const cwd = path.dirname(filePath)

  if (type === 'cmd') {
    return {
      type,
      file: 'cmd.exe',
      args: ['/c', filePath, ...params],
      commandLine: [quoted, ...params].join(' '),
      cwd,
    }
  }
  if (type === 'powershell') {
    return {
      type,
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', filePath, ...params],
      commandLine: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', quoted, ...params].join(' '),
      cwd,
    }
  }
  return {
    type,
    file: 'python',
    args: ['-X', 'utf8', filePath, ...params],
    commandLine: ['python', '-X', 'utf8', quoted, ...params].join(' '),
    cwd,
  }
}

export function startRun(spec, { path: scriptPath = null, params = '', onExit = null } = {}) {
  const child = spawn(spec.file, spec.args, {
    cwd: spec.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const run = {
    id: randomUUID(),
    spec,
    path: scriptPath,
    params: String(params ?? ''),
    onExit,
    child,
    lines: [],
    offset: 0,
    state: 'running',
    exitCode: null,
    durationMs: null,
    startedAt: Date.now(),
  }

  const decode = consoleDecoder()

  const pump = (stream, prefix) => {
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += decode.decode(chunk, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        let line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        pushLine(run, prefix + line)
        index = buffer.indexOf('\n')
      }
    })
    stream.on('end', () => {
      buffer += decode.decode()
      if (buffer) pushLine(run, prefix + buffer.replace(/\r$/, ''))
    })
  }

  pump(child.stdout, '')
  pump(child.stderr, 'stderr> ')

  child.on('close', (code) => {
    if (run.state !== 'running') return
    finish(run, code ?? -1)
  })
  child.on('error', (error) => {
    if (run.state !== 'running') return
    pushLine(run, `stderr> 启动失败：${error.message}`)
    finish(run, -1)
  })

  return run
}

function pushLine(run, line) {
  run.lines.push(line)
  if (run.lines.length > MAX_LINES) {
    const drop = run.lines.length - TRIM_TO
    run.lines.splice(0, drop)
    run.offset += drop
  }
}

function finish(run, exitCode) {
  run.exitCode = exitCode
  run.durationMs = Date.now() - run.startedAt
  run.state = 'exited'
  try {
    run.child.removeAllListeners()
  } catch {
    // Best effort.
  }
  if (typeof run.onExit === 'function') {
    try {
      run.onExit(run)
    } catch {
      // A failing recorder must not take the run down with it.
    }
  }
}

export function readRun(run, after = 0) {
  const cursor = run.offset + run.lines.length
  const from = Math.max(0, Math.min(Number(after) - run.offset, run.lines.length))
  return {
    runId: run.id,
    lines: run.lines.slice(Number.isFinite(from) ? from : 0),
    cursor,
    state: run.state,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
  }
}

export function stopRun(run) {
  if (!run || run.state !== 'running') return
  try {
    spawn('taskkill.exe', ['/PID', String(run.child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  } catch {
    try {
      run.child.kill()
    } catch {
      // Already gone.
    }
  }
}

export function startInTerminal(spec) {
  // A real console window: needed for scripts that wait on input (pause, read, y/n).
  const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', spec.commandLine], {
    cwd: spec.cwd,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}
