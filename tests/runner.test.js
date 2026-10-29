import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSpec, readRun, splitParams, startRun } from '../server/runner.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')

async function waitForExit(run, timeoutMs = 20000) {
  const lines = []
  let cursor = 0
  const deadline = Date.now() + timeoutMs
  while (run.state === 'running' && Date.now() < deadline) {
    const chunk = readRun(run, cursor)
    cursor = chunk.cursor
    lines.push(...chunk.lines)
    if (run.state === 'running') await new Promise((resolve) => setTimeout(resolve, 30))
  }
  const tail = readRun(run, cursor)
  lines.push(...tail.lines)
  return lines
}

test('splitParams honours quotes and repeated spaces', () => {
  assert.deepEqual(splitParams(''), [])
  assert.deepEqual(splitParams('  --a  b '), ['--a', 'b'])
  assert.deepEqual(splitParams('--path "C:\\some dir" --flag'), ['--path', 'C:\\some dir', '--flag'])
  assert.deepEqual(splitParams("--name 'bob smith'"), ['--name', 'bob smith'])
  assert.deepEqual(splitParams('""'), [''])
})

test('buildSpec: cmd runs through cmd.exe with the quoted script path', () => {
  const scriptPath = 'C:\\a b\\x.bat'
  const spec = buildSpec(scriptPath, '--a 1')
  assert.equal(spec.type, 'cmd')
  assert.equal(spec.file, 'cmd.exe')
  assert.deepEqual(spec.args, ['/c', scriptPath, '--a', '1'])
  assert.equal(spec.cwd, 'C:\\a b')
  assert.equal(spec.commandLine, '"C:\\a b\\x.bat" --a 1')
})

test('buildSpec: powershell and python use their interpreters', () => {
  const ps = buildSpec('C:\\a\\x.ps1', '-Name bob')
  assert.equal(ps.file, 'powershell.exe')
  assert.deepEqual(ps.args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\a\\x.ps1', '-Name', 'bob'])

  const py = buildSpec('C:\\a\\x.py')
  assert.equal(py.file, 'python')
  assert.deepEqual(py.args, ['-X', 'utf8', 'C:\\a\\x.py'])
})

test('buildSpec rejects unsupported extensions', () => {
  assert.throws(() => buildSpec('C:\\a\\x.txt'), /不支持的脚本类型/)
})

test('a real run reports its exit code, output and duration', async () => {
  const run = startRun(buildSpec(path.join(fixtures, 'exit-42.bat')))
  const lines = await waitForExit(run)
  assert.equal(run.state, 'exited')
  assert.equal(run.exitCode, 42)
  assert.match(lines.join('\n'), /running exit-42/)
  assert.ok(run.durationMs >= 0)
})

test('stdout lines are read incrementally', async () => {
  const run = startRun(buildSpec(path.join(fixtures, 'sleepy.bat')))
  const first = readRun(run, 0)
  assert.equal(first.cursor, 0)

  const deadline = Date.now() + 15000
  let cursor = 0
  let seen = ''
  while (Date.now() < deadline && !/starting sleep/.test(seen)) {
    const chunk = readRun(run, cursor)
    cursor = chunk.cursor
    seen += chunk.lines.join('\n')
    if (!/starting sleep/.test(seen)) await new Promise((resolve) => setTimeout(resolve, 30))
  }
  assert.match(seen, /starting sleep/)

  await waitForExit(run)
  assert.equal(run.state, 'exited')
  assert.equal(run.exitCode, 0)
})

test('python scripts run with utf-8 output', async (t) => {
  try {
    const run = startRun(buildSpec(path.join(fixtures, 'say.py')))
    const lines = await waitForExit(run, 30000)
    assert.equal(run.exitCode, 0)
    assert.match(lines.join('\n'), /py ok/)
  } catch (error) {
    if (/ENOENT/.test(String(error))) {
      t.skip('python 不在 PATH 上')
      return
    }
    throw error
  }
})
