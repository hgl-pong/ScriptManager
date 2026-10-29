// Local Claude Code adapter. The agent is invoked non-interactively with tools
// disabled; the prompt is written to stdin and stdout is streamed into the same
// text/cursor contract as the API jobs.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { splitParams } from '../runner.js'
import { notifyJobFinished } from './job.js'

const MAX_TEXT = 400_000
const MAX_STDERR = 8_000

export function buildClaudeArgs(local) {
  const args = ['-p', '--output-format', 'text', '--tools', '', '--permission-prompts', 'none']
  const model = String(local?.model ?? '').trim()
  if (model) args.push('--model', model)
  if (local?.effort) args.push('--effort', local.effort)
  args.push(...splitParams(local?.extraArgs ?? ''))
  return args
}

export function startLocalJob({ local, prompt, timeoutMs }) {
  const command = String(local?.command ?? '').trim() || 'claude'
  const executable = resolveExecutable(command)
  const spec = wrapExecutable(executable, buildClaudeArgs(local))
  const effectiveTimeout = Number.isFinite(Number(timeoutMs))
    ? Number(timeoutMs)
    : Number(local?.timeoutMs) || 300_000

  let finish = () => {}
  const job = {
    id: randomUUID(),
    state: 'running',
    text: '',
    error: null,
    stderr: '',
    child: null,
    startedAt: Date.now(),
    finished: new Promise((resolve) => {
      finish = resolve
    }),
  }

  let child
  try {
    child = spawn(spec.file, spec.args, {
      cwd: String(local?.cwd ?? '').trim() || undefined,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsVerbatimArguments: spec.verbatim,
    })
  } catch (error) {
    job.state = 'error'
    job.error = `启动本地 Agent 失败：${error.message}`
    finish()
    return job
  }
  job.child = child

  const stdoutDecoder = new TextDecoder('utf-8')
  const stderrDecoder = new TextDecoder('utf-8')

  child.stdout.on('data', (chunk) => {
    job.text = (job.text + stripAnsi(stdoutDecoder.decode(chunk, { stream: true }))).slice(0, MAX_TEXT)
  })
  child.stdout.on('end', () => {
    job.text = (job.text + stripAnsi(stdoutDecoder.decode())).slice(0, MAX_TEXT)
  })
  child.stderr.on('data', (chunk) => {
    job.stderr = (job.stderr + stripAnsi(stderrDecoder.decode(chunk, { stream: true }))).slice(-MAX_STDERR)
  })
  child.stderr.on('end', () => {
    job.stderr = (job.stderr + stripAnsi(stderrDecoder.decode())).slice(-MAX_STDERR)
  })

  child.on('error', (error) => {
    if (job.state !== 'running') return
    job.state = 'error'
    job.error = `启动本地 Agent 失败：${error.message}`
    finish()
  })

  child.on('close', (code) => {
    if (job.state !== 'running') {
      finish()
      return
    }
    if (code === 0 && job.text.trim()) {
      job.state = 'done'
    } else if (code === 0) {
      job.state = 'error'
      job.error = job.stderr.trim().slice(-1000) || '本地 Agent 没有输出'
    } else {
      job.state = 'error'
      job.error = job.stderr.trim().slice(-1000) || `本地 Agent 退出码 ${code}`
    }
    finish()
  })

  const timer = effectiveTimeout
    ? setTimeout(() => {
        if (job.state !== 'running') return
        job.state = 'error'
        job.error = '本地 Agent 超时'
        killTree(child)
        finish()
      }, effectiveTimeout)
    : null

  job.stop = () => {
    killTree(child)
  }
  job.cleanup = () => {
    if (timer) clearTimeout(timer)
  }
  job.finished = job.finished.then((value) => {
    if (timer) clearTimeout(timer)
    return value
  })
  job.finished.then(() => notifyJobFinished(job))

  child.stdin.on('error', () => {
    // The agent may exit before reading stdin; close reports the real failure.
  })
  child.stdin.end(String(prompt ?? ''), 'utf8')

  return job
}

export async function runLocalOnce({ local, prompt, timeoutMs = 60_000 }) {
  const job = startLocalJob({ local, prompt, timeoutMs })
  await job.finished
  if (job.state !== 'done') throw new Error(job.error || '本地 Agent 请求失败')
  return job.text
}

function resolveExecutable(command) {
  const value = String(command ?? '').trim()
  if (!value) throw new Error('本地 Agent 命令为空')
  if (value.includes('\\') || value.includes('/')) {
    const resolved = path.resolve(value)
    if (!fs.existsSync(resolved)) throw new Error(`找不到本地 Agent：${resolved}`)
    return resolved
  }

  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  const names = [value, ...exts.map((ext) => value + ext)]
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error(`找不到本地 Agent 命令：${value}（请检查 PATH 或填写完整路径）`)
}

function wrapExecutable(executable, args) {
  const lower = executable.toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const line = [quoteCmd(executable), ...args.map(quoteCmd)].join(' ')
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', line], verbatim: true }
  }
  if (lower.endsWith('.ps1')) {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args],
      verbatim: false,
    }
  }
  return { file: executable, args, verbatim: false }
}

function quoteCmd(value) {
  const text = String(value ?? '')
  if (!text) return '""'
  if (!/[\s"&|<>^]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function killTree(child) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
}

function stripAnsi(text) {
  return String(text)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}
