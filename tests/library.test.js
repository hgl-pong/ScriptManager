import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { allTags, filterView, formatLastRun, mergeView, scriptType, skipDir, scanRoots, typeLabel } from '../server/library.js'
import { pathKey } from '../server/paths.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')

test('script type mapping', () => {
  assert.equal(scriptType('a.BAT'), 'cmd')
  assert.equal(scriptType('a.cmd'), 'cmd')
  assert.equal(scriptType('a.ps1'), 'powershell')
  assert.equal(scriptType('a.py'), 'python')
  assert.equal(scriptType('a.txt'), null)
  assert.equal(typeLabel('cmd'), 'BAT')
  assert.equal(typeLabel('python'), 'PY')
})

test('skip directory rules', () => {
  assert.equal(skipDir('node_modules'), true)
  assert.equal(skipDir('.git'), true)
  assert.equal(skipDir('.venv'), true)
  assert.equal(skipDir('logs'), true)
  assert.equal(skipDir('scripts'), false)
})

test('scan finds fixtures and skips node_modules', async () => {
  const found = await scanRoots([fixtures])
  const names = found.map((item) => item.name).sort()
  assert.deepEqual(names, ['echo-args.ps1', 'exit-42.bat', 'say.py', 'sleepy.bat'])
  assert.equal(found.every((item) => scriptType(item.name) !== null), true)
})

test('scan ignores missing roots instead of throwing', async () => {
  const found = await scanRoots([path.join(fixtures, 'does-not-exist')])
  assert.deepEqual(found, [])
})

test('mergeView puts recently run rows first, then sorts by name', () => {
  const scripts = [
    { path: 'C:\\a\\beta.bat', name: 'beta.bat', type: 'cmd' },
    { path: 'C:\\a\\alpha.bat', name: 'alpha.bat', type: 'cmd' },
    { path: 'C:\\a\\zed.ps1', name: 'zed.ps1', type: 'powershell' },
  ]
  const library = {
    [pathKey('C:\\a\\zed.ps1')]: {
      alias: '',
      tags: [],
      lastRun: { at: '2026-02-01 10:00:00', exitCode: 0, durationMs: 500, params: '' },
    },
  }
  const view = mergeView(library, scripts)
  assert.equal(view[0].name, 'zed.ps1')
  assert.deepEqual(view.slice(1).map((row) => row.displayName), ['alpha', 'beta'])
})

test('mergeView uses alias as display name and exposes last params', () => {
  const scripts = [{ path: 'C:\\a\\clean.bat', name: 'clean.bat', type: 'cmd' }]
  const library = {
    [pathKey('C:\\a\\clean.bat')]: {
      alias: '清理日志',
      tags: ['运维'],
      lastRun: { at: '2026-02-01 10:00:00', exitCode: 2, durationMs: 1500, params: '--dry' },
    },
  }
  const [row] = mergeView(library, scripts)
  assert.equal(row.displayName, '清理日志')
  assert.deepEqual(row.tags, ['运维'])
  assert.equal(row.lastParams, '--dry')
  assert.equal(formatLastRun(row), '2026-02-01 10:00:00 · 退出码 2 · 1.5s')
})

test('filterView matches name, path and tags, case-insensitively', () => {
  const view = mergeView({}, [
    { path: 'C:\\tools\\Clean-Logs.bat', name: 'Clean-Logs.bat', type: 'cmd' },
    { path: 'C:\\tools\\resize.py', name: 'resize.py', type: 'python' },
  ])
  view[0].tags = ['运维', '日志']

  assert.equal(filterView(view, { query: 'clean' }).length, 1)
  assert.equal(filterView(view, { query: 'TOOLS' }).length, 2)
  assert.equal(filterView(view, { query: '日志' }).length, 1)
  assert.equal(filterView(view, { tag: '运维' }).length, 1)
  assert.equal(filterView(view, { tag: '不存在' }).length, 0)
  assert.equal(filterView(view, {}).length, 2)
  assert.deepEqual(allTags(view), ['日志', '运维'])
})

test('formatLastRun handles a script that never ran', () => {
  assert.equal(formatLastRun(null), '—')
  assert.equal(formatLastRun({ lastRunAt: '' }), '—')
})
