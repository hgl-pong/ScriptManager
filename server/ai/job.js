// One AI request: fetch, accumulate streamed text, expose a character cursor,
// support stop and surface HTTP/stream errors. Same polling shape as the runner,
// but the cursor counts characters because replies arrive token by token.

import { randomUUID } from 'node:crypto'
import { buildRequest, extractResponseText, readStreamEvent } from './protocols.js'

const MAX_TEXT = 400_000

// Generous wall-clock ceiling for an ask: a stalled provider must not hold the
// single-job slot forever (the user can still press stop earlier).
export const ASK_TIMEOUT_MS = 300_000

export function startAiJob({ profile, system = '', messages = [], maxTokens = 4096, timeoutMs = 0 } = {}) {
  const request = buildRequest(profile, { system, messages, stream: true, maxTokens })
  const controller = new AbortController()
  let finish = () => {}

  const job = {
    id: randomUUID(),
    state: 'running',
    text: '',
    error: null,
    controller,
    startedAt: Date.now(),
    finished: new Promise((resolve) => {
      finish = resolve
    }),
  }

  const timer = timeoutMs
    ? setTimeout(() => {
        if (job.state !== 'running') return
        job.error = '请求超时'
        job.state = 'error'
        controller.abort()
      }, timeoutMs)
    : null

  run(job, request, controller.signal)
    .catch((error) => {
      if (job.state !== 'running') return
      if (controller.signal.aborted) {
        job.state = 'stopped'
        return
      }
      job.state = 'error'
      job.error = error?.message ?? String(error)
    })
    .finally(() => {
      if (timer) clearTimeout(timer)
      notifyJobFinished(job)
      finish()
    })

  return job
}

async function run(job, { protocol, url, headers, body }, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim()
    throw new Error(`HTTP ${response.status}${detail ? `：${detail.slice(0, 400)}` : ''}`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`响应不是 JSON：${text.slice(0, 300)}`)
    }
    const answer = extractResponseText(protocol, json)
    if (!answer) throw new Error(`响应里没有文本：${text.slice(0, 300)}`)
    job.text = answer.slice(0, MAX_TEXT)
    job.state = 'done'
    return
  }

  const feed = (line) => {
    if (!line.startsWith('data:')) return { delta: '' }
    return readStreamEvent(protocol, line.slice(5).trim())
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  let fallback = ''

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      const event = feed(line)
      if (event.error) throw new Error(event.error)
      if (event.delta) job.text = (job.text + event.delta).slice(0, MAX_TEXT)
      if (event.fallbackText) fallback = event.fallbackText
      if (event.done) {
        finished = true
        break
      }
    }
    if (finished) break
  }

  if (!finished) {
    buffer += decoder.decode()
    for (const line of buffer.split('\n')) {
      const event = feed(line.replace(/\r$/, ''))
      if (event.error) throw new Error(event.error)
      if (event.delta) job.text = (job.text + event.delta).slice(0, MAX_TEXT)
      if (event.fallbackText) fallback = event.fallbackText
      if (event.done) {
        finished = true
        break
      }
    }
  }

  if (!job.text && fallback) job.text = fallback.slice(0, MAX_TEXT)
  if (!job.text) throw new Error('连接已关闭，但没有收到任何文本')
  // Every protocol has an explicit done marker; text without one is a truncated reply.
  if (!finished) throw new Error('连接提前结束，结果可能不完整')
  job.state = 'done'
}

// The protocol is carried on the request; feed() only needs the data payload and
// the protocol, so the closure is created in run() through this helper below.

export function readJob(job, after = 0) {
  if (!job) return null
  const cursor = job.text.length
  const start = Math.max(0, Math.min(Number(after) || 0, cursor))
  return {
    jobId: job.id,
    text: job.text.slice(start),
    cursor,
    state: job.state,
    error: job.error,
  }
}

export function notifyJobFinished(job) {
  if (!job || job.notified) return
  job.notified = true
  try {
    job.onFinish?.(job)
  } catch {
    // History recording must not affect the job result.
  }
}

export function stopJob(job) {
  if (!job || job.state !== 'running') return
  job.state = 'stopped'
  if (typeof job.stop === 'function') {
    job.stop()
    notifyJobFinished(job)
    return
  }
  job.controller?.abort()
  notifyJobFinished(job)
}

export async function runAiOnce(options) {
  const job = startAiJob({ timeoutMs: 60_000, ...options })
  await job.finished
  if (job.state !== 'done') throw new Error(job.error || 'AI 请求失败')
  return job.text
}
