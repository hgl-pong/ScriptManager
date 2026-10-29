// Minimal upstream that speaks each protocol's SSE shape, so job/API tests never touch the network.

import http from 'node:http'

function deltaFrame(protocol, text) {
  if (protocol === 'openai-chat') {
    return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
  }
  if (protocol === 'openai-responses') {
    return `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`
  }
  return `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`
}

function doneFrame(protocol) {
  if (protocol === 'openai-chat') return 'data: [DONE]\n\n'
  if (protocol === 'openai-responses') {
    return `data: ${JSON.stringify({ type: 'response.completed', response: { output: [] } })}\n\n`
  }
  return `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`
}

function errorFrame(protocol, message) {
  if (protocol === 'openai-chat') return `data: ${JSON.stringify({ error: { message } })}\n\n`
  return `data: ${JSON.stringify({ type: 'error', error: { message } })}\n\n`
}

function incompleteFrame() {
  return `data: ${JSON.stringify({
    type: 'response.incomplete',
    response: { incomplete_details: { reason: 'max_output_tokens' } },
  })}\n\n`
}

export async function startStub({
  protocol = 'openai-chat',
  reply = '好的',
  status = 200,
  delayMs = 0,
  errorAfterReply = '',
  incomplete = false,
  omitDone = false,
  stall = false,
  modelsStatus = 200,
} = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', async () => {
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = body
      }
      requests.push({ url: req.url, headers: req.headers, body: parsed })

      if (req.method === 'GET' && String(req.url ?? '').split('?')[0].endsWith('/models')) {
        if (modelsStatus !== 200) {
          res.writeHead(modelsStatus, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'no model list' } }))
          return
        }
        const list =
          protocol === 'anthropic'
            ? {
                data: [
                  { id: 'claude-b', display_name: 'Claude B' },
                  { id: 'claude-a', display_name: 'Claude A' },
                ],
                has_more: false,
                last_id: null,
              }
            : { data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-b' }] }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(list))
        return
      }

      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'stub failure' } }))
        return
      }

      // Never answer: fetch resolves only if headers are sent, so stay silent and
      // let the job's timeout / stop abort the connection.
      if (stall) return

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      for (const character of String(reply).split('')) {
        res.write(deltaFrame(protocol, character))
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      if (errorAfterReply) {
        res.write(errorFrame(protocol, errorAfterReply))
        res.end()
        return
      }
      if (incomplete) {
        res.write(incompleteFrame())
        res.end()
        return
      }
      if (!omitDone) res.write(doneFrame(protocol))
      res.end()
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
