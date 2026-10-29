import test from 'node:test'
import assert from 'node:assert/strict'
import { ASK_TIMEOUT_MS, readJob, runAiOnce, startAiJob, stopJob } from '../server/ai/job.js'
import { startStub } from './ai-stub.js'

async function waitFor(job, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (job.state === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return job
}

function startChatJob(stub, options = {}) {
  return startAiJob({
    profile: { protocol: 'openai-chat', baseUrl: stub.baseUrl, model: 'm', apiKey: 'k' },
    messages: [{ role: 'user', content: 'hi' }],
    ...options,
  })
}

const PROFILES = ['openai-chat', 'openai-responses', 'anthropic']

for (const protocol of PROFILES) {
  test(`${protocol}: job accumulates streamed text until done`, async (t) => {
    const stub = await startStub({ protocol, reply: '生成结果' })
    t.after(() => stub.close())

    const job = startAiJob({
      profile: { protocol, baseUrl: stub.baseUrl, model: 'test-model', apiKey: 'sk-test' },
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await waitFor(job)

    assert.equal(job.state, 'done')
    assert.equal(job.text, '生成结果')
    assert.equal(stub.requests.length, 1)
    assert.match(stub.requests[0].url, /\/(chat\/completions|responses|messages)$/)
  })
}

test('cursor reads only new text', async (t) => {
  const stub = await startStub({ protocol: 'openai-chat', reply: 'abcd' })
  t.after(() => stub.close())

  const job = startAiJob({
    profile: { protocol: 'openai-chat', baseUrl: stub.baseUrl, model: 'm', apiKey: 'k' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  await waitFor(job)

  const first = readJob(job, 0)
  assert.equal(first.text, 'abcd')
  assert.equal(first.cursor, 4)

  const second = readJob(job, first.cursor)
  assert.equal(second.text, '')
  assert.equal(second.cursor, 4)
})

test('http failure becomes a readable error state', async (t) => {
  const stub = await startStub({ protocol: 'openai-chat', status: 401 })
  t.after(() => stub.close())

  const job = startAiJob({
    profile: { protocol: 'openai-chat', baseUrl: stub.baseUrl, model: 'm', apiKey: 'bad' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  await waitFor(job)

  assert.equal(job.state, 'error')
  assert.match(job.error, /401/)
})

test('stop marks the job stopped', async (t) => {
  const stub = await startStub({ protocol: 'openai-chat', reply: '慢'.repeat(60), delayMs: 40 })
  t.after(() => stub.close())

  const job = startAiJob({
    profile: { protocol: 'openai-chat', baseUrl: stub.baseUrl, model: 'm', apiKey: 'k' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  await new Promise((resolve) => setTimeout(resolve, 120))
  stopJob(job)

  await waitFor(job)
  assert.equal(job.state, 'stopped')
  assert.ok(job.text.length < 60)
})

test('a chat error event ends as error and keeps the partial text', async (t) => {
  const stub = await startStub({ protocol: 'openai-chat', reply: '部分', errorAfterReply: 'quota exceeded' })
  t.after(() => stub.close())

  const job = startChatJob(stub)
  await waitFor(job)

  assert.equal(job.state, 'error')
  assert.equal(job.text, '部分')
  assert.match(job.error, /quota exceeded/)
})

test('responses response.incomplete ends as an incomplete error', async (t) => {
  const stub = await startStub({ protocol: 'openai-responses', reply: '被截断', incomplete: true })
  t.after(() => stub.close())

  const job = startAiJob({
    profile: { protocol: 'openai-responses', baseUrl: stub.baseUrl, model: 'm', apiKey: 'k' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  await waitFor(job)

  assert.equal(job.state, 'error')
  assert.equal(job.text, '被截断')
  assert.match(job.error, /不完整/)
})

test('a stream that closes without a done marker is an incomplete error', async (t) => {
  const stub = await startStub({ protocol: 'openai-chat', reply: 'abc', omitDone: true })
  t.after(() => stub.close())

  const job = startChatJob(stub)
  await waitFor(job)

  assert.equal(job.state, 'error')
  assert.equal(job.text, 'abc')
  assert.match(job.error, /不完整/)
})

test('timeout aborts a stalled stream', async (t) => {
  const stub = await startStub({ protocol: 'openai-chat', stall: true })
  t.after(() => stub.close())

  const job = startChatJob(stub, { timeoutMs: 150 })
  await waitFor(job, { timeoutMs: 5000 })

  assert.equal(job.state, 'error')
  assert.equal(job.error, '请求超时')
})

test('ask timeout ceiling is generous', () => {
  assert.ok(ASK_TIMEOUT_MS >= 300_000)
})

test('runAiOnce returns the whole answer', async (t) => {
  const stub = await startStub({ protocol: 'anthropic', reply: 'OK' })
  t.after(() => stub.close())

  const text = await runAiOnce({
    profile: { protocol: 'anthropic', baseUrl: stub.baseUrl, model: 'claude', apiKey: 'k' },
    system: 'ping',
    messages: [{ role: 'user', content: 'ping' }],
  })
  assert.equal(text, 'OK')
})
