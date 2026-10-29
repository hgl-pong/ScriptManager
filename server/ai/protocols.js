// Three AI protocols, one adapter each. Request building and stream-event parsing
// are pure functions so tests can assert them without touching the network.

const PROTOCOL_PATHS = {
  'openai-chat': '/chat/completions',
  'openai-responses': '/responses',
  anthropic: '/messages',
}

const PROTOCOL_INFO = [
  {
    id: 'openai-chat',
    label: 'OpenAI Chat Completions',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'openai-responses',
    label: 'OpenAI Responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.1',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Messages',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5-5',
  },
]

export const PROTOCOL_LABELS = Object.fromEntries(PROTOCOL_INFO.map((item) => [item.id, item.label]))

// A per-profile reasoning tier. Empty means "do not send anything"; each
// protocol maps the tier to its own field.
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high']
const ANTHROPIC_THINKING_BUDGET = { minimal: 1024, low: 2048, medium: 4096, high: 8192 }

export function protocolList() {
  return PROTOCOL_INFO.map((item) => ({ ...item }))
}

export function isProtocol(value) {
  return Object.hasOwn(PROTOCOL_PATHS, value)
}

// A full endpoint URL is used as-is; otherwise append the protocol path, keeping
// an explicit /v1 in the Base URL (https://api.deepseek.com/v1).
export function endpointFor(protocol, baseUrl) {
  if (!isProtocol(protocol)) throw new Error(`未知协议：${protocol}`)
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('缺少 Base URL')

  const suffix = PROTOCOL_PATHS[protocol]
  const lower = base.toLowerCase()
  if (lower.endsWith(suffix)) return base
  if (base.includes('?')) return base
  if (/\/v\d+$/i.test(base)) return base + suffix
  return `${base}/v1${suffix}`
}

// Where a protocol's model list lives. A full chat/responses/messages URL is
// reduced to its API root first; a blank Base URL uses the protocol default.
export function modelsEndpointFor(protocol, baseUrl) {
  if (!isProtocol(protocol)) throw new Error(`未知协议：${protocol}`)
  const info = PROTOCOL_INFO.find((item) => item.id === protocol)
  let base = String(baseUrl ?? '').trim() || info.defaultBaseUrl
  base = base.replace(/[?#].*$/, '').replace(/\/+$/, '')
  base = base.replace(/\/(chat\/completions|responses|messages|models)$/i, '')
  if (/\/v\d+$/i.test(base)) return `${base}/models`
  return `${base}/v1/models`
}

// GET /models uses the same authentication as the protocol's chat request.
export function modelHeaders(profile) {
  const headers = { accept: 'application/json', ...(profile?.headers ?? {}) }
  const apiKey = String(profile?.apiKey ?? '')
  if (apiKey) {
    if (profile?.protocol === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01'
    } else {
      headers.authorization = `Bearer ${apiKey}`
    }
  }
  return headers
}

// The request shape for one chat turn. `stream` picks SSE vs a single JSON reply.
// A blank Base URL / model falls back to the protocol defaults shown in the UI.
export function buildRequest(profile, { system = '', messages = [], stream = true, maxTokens = 4096 } = {}) {
  const protocol = profile?.protocol
  if (!isProtocol(protocol)) throw new Error(`未知协议：${protocol}`)
  const info = PROTOCOL_INFO.find((item) => item.id === protocol)
  const url = endpointFor(protocol, String(profile?.baseUrl ?? '').trim() || info.defaultBaseUrl)
  const model = String(profile?.model ?? '').trim() || info.defaultModel
  if (!model) throw new Error('缺少模型名')

  const apiKey = String(profile?.apiKey ?? '')
  const headers = { 'content-type': 'application/json', ...(profile?.headers ?? {}) }
  const body = { model, stream }
  const effort = REASONING_EFFORTS.includes(profile?.reasoningEffort) ? profile.reasoningEffort : ''

  if (protocol === 'openai-chat') {
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    body.messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.map((message) => ({ role: roleOf(message), content: message.content })),
    ]
    if (effort) body.reasoning_effort = effort
  } else if (protocol === 'openai-responses') {
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    if (system) body.instructions = system
    body.input = messages.map((message) => ({
      role: roleOf(message),
      content: [
        {
          type: roleOf(message) === 'assistant' ? 'output_text' : 'input_text',
          text: String(message.content ?? ''),
        },
      ],
    }))
    if (effort) body.reasoning = { effort }
  } else if (protocol === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01'
    body.max_tokens = maxTokens
    if (system) body.system = system
    body.messages = messages.map((message) => ({ role: roleOf(message), content: message.content }))
    if (effort) {
      const budget = ANTHROPIC_THINKING_BUDGET[effort]
      body.thinking = { type: 'enabled', budget_tokens: budget }
      // Anthropic requires max_tokens to leave room beyond the thinking budget.
      body.max_tokens = Math.max(maxTokens, budget + 1024)
    }
  }

  return { protocol, url, headers, body }
}

function roleOf(message) {
  return message?.role === 'assistant' ? 'assistant' : 'user'
}

// Map one SSE data payload (already parsed JSON, or the literal "[DONE]") to the
// shared shape { delta, done, fallbackText, error }. Unknown events return {}.
export function readStreamEvent(protocol, event) {
  let payload = event
  if (typeof payload === 'string') {
    if (protocol === 'openai-chat' && payload.trim() === '[DONE]') return { done: true }
    payload = parseJson(payload)
  }
  if (!payload || typeof payload !== 'object') return {}

  if (protocol === 'openai-chat') {
    if (payload.error) return { error: errorText(payload) }
    const delta = payload.choices?.[0]?.delta?.content
    return typeof delta === 'string' && delta ? { delta } : {}
  }

  if (protocol === 'openai-responses') {
    if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      return { delta: payload.delta }
    }
    if (payload.type === 'response.completed') {
      return { done: true, fallbackText: extractResponsesText(payload.response ?? payload) }
    }
    if (payload.type === 'response.incomplete') {
      return { error: incompleteText(payload) }
    }
    if (payload.type === 'response.failed' || payload.type === 'error') {
      return { error: errorText(payload) }
    }
    return {}
  }

  if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
    return { delta: String(payload.delta.text ?? '') }
  }
  if (payload.type === 'message_stop') return { done: true }
  if (payload.type === 'error') return { error: errorText(payload) }
  return {}
}

// Non-streaming reply extraction, used by test-connection and stream fallbacks.
export function extractResponseText(protocol, json) {
  if (!json || typeof json !== 'object') return ''

  if (protocol === 'openai-chat') {
    const content = json.choices?.[0]?.message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('')
    return ''
  }

  if (protocol === 'openai-responses') return extractResponsesText(json)

  if (Array.isArray(json.content)) {
    return json.content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text ?? '')
      .join('')
  }
  return typeof json.completion === 'string' ? json.completion : ''
}

function extractResponsesText(json) {
  if (typeof json?.output_text === 'string' && json.output_text) return json.output_text
  const parts = []
  for (const item of Array.isArray(json?.output) ? json.output : []) {
    if (!Array.isArray(item?.content)) continue
    for (const part of item.content) {
      if (typeof part?.text === 'string') parts.push(part.text)
    }
  }
  return parts.join('')
}

function errorText(json) {
  const error = json?.error
  if (typeof error === 'string' && error) return error
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message) return error.message
    if (typeof error.type === 'string' && error.type) return error.type
  }
  if (typeof json?.message === 'string' && json.message) return json.message
  return JSON.stringify(json).slice(0, 300)
}

function incompleteText(payload) {
  const reason = payload?.response?.incomplete_details?.reason
  return reason ? `响应不完整（${reason}），结果可能不完整` : '响应不完整，结果可能不完整'
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
