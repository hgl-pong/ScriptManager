import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../server/server.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')
const TOKEN = 'test-token'

async function startApp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-api-'))
  const distDir = path.join(root, 'dist')
  await fs.mkdir(distDir, { recursive: true })
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>stub</title>', 'utf8')

  const app = await createServer({ root, distDir, token: TOKEN, port: 0 })
  t.after(async () => {
    await app.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  const base = `http://127.0.0.1:${app.port}`
  const authHeaders = { 'x-sm-token': TOKEN, 'content-type': 'application/json' }
  return {
    root,
    base,
    get: (pathname, headers = { 'x-sm-token': TOKEN }) => fetch(base + pathname, { headers }),
    post: (pathname, body) =>
      fetch(base + pathname, { method: 'POST', headers: authHeaders, body: JSON.stringify(body ?? {}) }),
  }
}

async function pollOutput(app, runId, { until = (chunk) => chunk.state === 'exited', timeoutMs = 25000 } = {}) {
  let cursor = 0
  let lines = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await app.get(`/api/output?runId=${runId}&after=${cursor}`)
    assert.equal(response.status, 200)
    const chunk = await response.json()
    cursor = chunk.cursor
    lines = lines.concat(chunk.lines)
    if (until(chunk)) return { chunk, lines }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('等待输出超时')
}

test('api requires the startup token', async (t) => {
  const app = await startApp(t)
  const unauthorized = await app.get('/api/health', {})
  assert.equal(unauthorized.status, 401)

  const authorized = await app.get('/api/health')
  assert.equal(authorized.status, 200)
  assert.deepEqual(await authorized.json(), { ok: true })
})

test('static hosting serves the built app and falls back to index.html', async (t) => {
  const app = await startApp(t)
  const index = await app.get('/')
  assert.equal(index.status, 200)
  assert.match(await index.text(), /stub/)

  const deep = await app.get('/some/deep/route')
  assert.equal(deep.status, 200)
  assert.match(await deep.text(), /stub/)
})

test('state reflects saved scan roots, and meta edits come back in the rows', async (t) => {
  const app = await startApp(t)

  const empty = await (await app.get('/api/state')).json()
  assert.deepEqual(empty.scanRoots, [])
  assert.deepEqual(empty.scripts, [])

  const scanned = await (await app.post('/api/roots', { roots: [fixtures] })).json()
  assert.deepEqual(scanned.scanRoots, [fixtures])
  assert.equal(scanned.scripts.length, 4)
  assert.equal(scanned.scripts.some((row) => row.name === 'ignored.bat'), false)

  const exitPath = path.join(fixtures, 'exit-42.bat')
  const withMeta = await (await app.post('/api/meta', { path: exitPath, alias: '退出码测试', tags: ['测试', '退出码'] })).json()
  const row = withMeta.scripts.find((item) => item.path === exitPath)
  assert.equal(row.displayName, '退出码测试')
  assert.deepEqual(row.tags, ['测试', '退出码'])
  assert.ok(withMeta.tags.includes('测试'))
})

test('running a script streams lines and records exit code plus duration', async (t) => {
  const app = await startApp(t)
  await app.post('/api/roots', { roots: [fixtures] })

  const exitPath = path.join(fixtures, 'exit-42.bat')
  const started = await (await app.post('/api/run', { path: exitPath, params: '--dry' })).json()
  const { chunk, lines } = await pollOutput(app, started.runId)

  assert.equal(chunk.state, 'exited')
  assert.equal(chunk.exitCode, 42)
  assert.match(lines.join('\n'), /running exit-42/)
  assert.ok(chunk.durationMs >= 0)

  const state = await (await app.get('/api/state')).json()
  const row = state.scripts.find((item) => item.path === exitPath)
  assert.equal(row.lastExit, 42)
  assert.equal(row.lastParams, '--dry')

  const run = state.runs.find((item) => item.path === exitPath)
  assert.ok(run)
  assert.equal(run.name, 'exit-42.bat')
  assert.equal(run.params, '--dry')
  assert.equal(run.exitCode, 42)
})

test('a second run is refused while one is running, and stop ends the first', async (t) => {
  const app = await startApp(t)
  await app.post('/api/roots', { roots: [fixtures] })

  const sleepy = path.join(fixtures, 'sleepy.bat')
  const started = await (await app.post('/api/run', { path: sleepy })).json()
  await pollOutput(app, started.runId, { until: (chunk) => chunk.lines.includes('starting sleep'), timeoutMs: 15000 })

  const conflict = await app.post('/api/run', { path: sleepy })
  assert.equal(conflict.status, 409)

  const stopped = await app.post('/api/stop', { runId: started.runId })
  assert.equal(stopped.status, 200)

  const { chunk } = await pollOutput(app, started.runId)
  assert.equal(chunk.state, 'exited')
})

test('browse lists drives and subdirectories, hiding skipped folders', async (t) => {
  const app = await startApp(t)

  const drives = await (await app.get('/api/browse')).json()
  assert.equal(drives.path, '')
  assert.ok(drives.dirs.length > 0)

  const listing = await (await app.get(`/api/browse?path=${encodeURIComponent(fixtures)}`)).json()
  assert.equal(listing.path, fixtures)
  assert.deepEqual(listing.dirs.map((dir) => dir.name), ['nested'])
  assert.ok(listing.parent)
})

test('unknown endpoints and bad bodies fail cleanly', async (t) => {
  const app = await startApp(t)
  const missing = await app.get('/api/nope')
  assert.equal(missing.status, 404)

  const broken = await fetch(`${app.base}/api/meta`, {
    method: 'POST',
    headers: { 'x-sm-token': TOKEN, 'content-type': 'application/json' },
    body: '{oops',
  })
  assert.equal(broken.status, 500)

  const stillAlive = await app.get('/api/health')
  assert.equal(stillAlive.status, 200)
})
