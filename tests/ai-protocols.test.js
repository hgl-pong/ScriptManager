import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest, modelHeaders, modelsEndpointFor, protocolList, readStreamEvent } from '../server/ai/protocols.js'
import { buildMessages } from '../server/ai/prompts.js'

test('three protocols are advertised', () => {
  const ids = protocolList().map((item) => item.id)
  assert.deepEqual(ids, ['openai-chat', 'openai-responses', 'anthropic'])
})

test('openai-chat request: chat/completions with bearer auth and system first', () => {
  const request = buildRequest(
    { protocol: 'openai-chat', baseUrl: 'https://api.example.com/v1/', model: 'm1', apiKey: 'sk-1' },
    { system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
  )
  assert.equal(request.url, 'https://api.example.com/v1/chat/completions')
  assert.equal(request.headers.authorization, 'Bearer sk-1')
  assert.equal(request.body.model, 'm1')
  assert.equal(request.body.stream, true)
  assert.deepEqual(request.body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ])
})

test('openai-responses request: instructions plus input_text blocks', () => {
  const request = buildRequest(
    { protocol: 'openai-responses', baseUrl: 'https://api.example.com/v1', model: 'm2', apiKey: 'sk-2' },
    { system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
  )
  assert.equal(request.url, 'https://api.example.com/v1/responses')
  assert.equal(request.headers.authorization, 'Bearer sk-2')
  assert.equal(request.body.instructions, 'sys')
  assert.equal(request.body.stream, true)
  assert.deepEqual(request.body.input[0], {
    role: 'user',
    content: [{ type: 'input_text', text: 'hi' }],
  })
})

test('anthropic request: x-api-key, version header, system field, max_tokens', () => {
  const request = buildRequest(
    { protocol: 'anthropic', baseUrl: 'https://api.example.com/v1', model: 'claude', apiKey: 'sk-ant' },
    { system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
  )
  assert.equal(request.url, 'https://api.example.com/v1/messages')
  assert.equal(request.headers['x-api-key'], 'sk-ant')
  assert.equal(request.headers['anthropic-version'], '2023-06-01')
  assert.equal(request.body.system, 'sys')
  assert.equal(request.body.stream, true)
  assert.ok(request.body.max_tokens > 0)
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'hi' }])
})

test('unknown protocol is rejected', () => {
  assert.throws(() => buildRequest({ protocol: 'gemini' }, { messages: [] }), /未知协议/)
})

test('stream events map per protocol', () => {
  assert.deepEqual(readStreamEvent('openai-chat', { choices: [{ delta: { content: 'ab' } }] }), { delta: 'ab' })
  assert.deepEqual(readStreamEvent('openai-chat', '[DONE]'), { done: true })
  assert.deepEqual(readStreamEvent('openai-chat', { choices: [{}] }), {})

  assert.deepEqual(readStreamEvent('openai-responses', { type: 'response.output_text.delta', delta: 'x' }), {
    delta: 'x',
  })
  assert.deepEqual(
    readStreamEvent('openai-responses', {
      type: 'response.completed',
      response: { output: [{ content: [{ text: 'full text' }] }] },
    }),
    { done: true, fallbackText: 'full text' },
  )

  assert.deepEqual(
    readStreamEvent('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'y' } }),
    { delta: 'y' },
  )
  assert.deepEqual(readStreamEvent('anthropic', { type: 'message_stop' }), { done: true })
  assert.deepEqual(readStreamEvent('anthropic', { type: 'error', error: { message: 'nope' } }), { error: 'nope' })
})

test('chat errors and responses incomplete are terminal errors', () => {
  assert.deepEqual(readStreamEvent('openai-chat', { error: { message: 'quota exceeded' } }), {
    error: 'quota exceeded',
  })
  assert.deepEqual(readStreamEvent('openai-chat', { error: 'boom' }), { error: 'boom' })
  assert.deepEqual(
    readStreamEvent('openai-responses', {
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' } },
    }),
    { error: '响应不完整（max_output_tokens），结果可能不完整' },
  )
})

test('blank base url and model use the protocol defaults', () => {
  const chat = buildRequest({ protocol: 'openai-chat', baseUrl: '  ', model: '' }, { messages: [] })
  assert.equal(chat.url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(chat.body.model, 'deepseek-chat')

  const responses = buildRequest({ protocol: 'openai-responses' }, { messages: [] })
  assert.equal(responses.url, 'https://api.openai.com/v1/responses')
  assert.equal(responses.body.model, 'gpt-5.1')

  const anthropic = buildRequest({ protocol: 'anthropic', baseUrl: '', model: '  ' }, { messages: [] })
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(anthropic.body.model, 'claude-sonnet-5-5')
})

test('prompts carry what each action needs', () => {
  const generated = buildMessages('generate', { prompt: '删掉旧日志', type: 'cmd' })
  assert.match(generated.system, /批处理/)
  assert.match(generated.messages[0].content, /删掉旧日志/)

  const regenerated = buildMessages('generate', { prompt: '加上确认', type: 'python', previous: 'old script body' })
  assert.match(regenerated.messages[0].content, /old script body/)
  assert.match(regenerated.system, /Python/)

  const explained = buildMessages('explain', { script: 'echo hi' })
  assert.match(explained.messages[0].content, /echo hi/)

  const diagnosed = buildMessages('diagnose', { script: 'exit /b 1', lastExitCode: 7, lastRunText: 'stderr> boom' })
  assert.match(diagnosed.messages[0].content, /退出码：7/)
  assert.match(diagnosed.messages[0].content, /stderr> boom/)

  const logging = buildMessages('logging', { script: 'echo x' })
  assert.match(logging.messages[0].content, /日志/)
  assert.match(logging.messages[0].content, /完整脚本/)

  const hardened = buildMessages('harden', { script: 'echo x' })
  assert.match(hardened.messages[0].content, /安全/)

  assert.throws(() => buildMessages('chat', {}), /未知的 AI 用途/)
})

test('model list endpoint derives from base and full endpoint URLs', () => {
  assert.equal(modelsEndpointFor('openai-chat', 'https://api.deepseek.com'), 'https://api.deepseek.com/v1/models')
  assert.equal(modelsEndpointFor('openai-chat', 'https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/models')
  assert.equal(modelsEndpointFor('openai-responses', 'https://api.openai.com/v1/responses'), 'https://api.openai.com/v1/models')
  assert.equal(modelsEndpointFor('anthropic', 'https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1/models')
  assert.equal(modelsEndpointFor('openai-chat', ''), 'https://api.deepseek.com/v1/models')
})

test('model headers follow the protocol auth style', () => {
  assert.equal(modelHeaders({ protocol: 'openai-chat', apiKey: 'sk' }).authorization, 'Bearer sk')
  const anthropic = modelHeaders({ protocol: 'anthropic', apiKey: 'sk-ant' })
  assert.equal(anthropic['x-api-key'], 'sk-ant')
  assert.equal(anthropic['anthropic-version'], '2023-06-01')
  assert.equal(modelHeaders({ protocol: 'openai-chat', apiKey: 'sk', headers: { 'X-Trace': '1' } })['X-Trace'], '1')
})

test('reasoning effort maps to each protocol field', () => {
  const messages = [{ role: 'user', content: 'hi' }]
  const chat = buildRequest(
    { protocol: 'openai-chat', baseUrl: 'https://x/v1', model: 'm', reasoningEffort: 'high' },
    { messages },
  )
  assert.equal(chat.body.reasoning_effort, 'high')

  const responses = buildRequest(
    { protocol: 'openai-responses', baseUrl: 'https://x/v1', model: 'm', reasoningEffort: 'medium' },
    { messages },
  )
  assert.deepEqual(responses.body.reasoning, { effort: 'medium' })

  const anthropic = buildRequest(
    { protocol: 'anthropic', baseUrl: 'https://x/v1', model: 'm', reasoningEffort: 'high' },
    { messages },
  )
  assert.deepEqual(anthropic.body.thinking, { type: 'enabled', budget_tokens: 8192 })
  assert.ok(anthropic.body.max_tokens > 8192)

  const off = buildRequest(
    { protocol: 'openai-chat', baseUrl: 'https://x/v1', model: 'm', reasoningEffort: '' },
    { messages },
  )
  assert.equal('reasoning_effort' in off.body, false)
})
