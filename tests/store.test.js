import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathKey } from '../server/paths.js'
import {
  configPath,
  defaultConfig,
  getEntry,
  libraryPath,
  readConfig,
  readLibrary,
  saveConfig,
  saveLibrary,
  setMeta,
  setRun,
} from '../server/store.js'

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sm-store-'))
}

test('missing files read as defaults', async () => {
  const root = await tempRoot()
  assert.deepEqual(await readConfig(root), defaultConfig())
  assert.deepEqual(await readLibrary(root), {})
  await fs.rm(root, { recursive: true, force: true })
})

test('config roundtrip keeps scan roots and window size', async () => {
  const root = await tempRoot()
  await saveConfig(root, { scanRoots: ['E:\\Tools', 'D:\\scripts'], window: { width: 1000, height: 640 } })
  const config = await readConfig(root)
  assert.deepEqual(config.scanRoots, ['E:\\Tools', 'D:\\scripts'])
  assert.equal(config.window.width, 1000)
  assert.equal(config.window.height, 640)
  assert.ok(await fs.stat(configPath(root)))
  await fs.rm(root, { recursive: true, force: true })
})

test('broken config falls back to defaults instead of throwing', async () => {
  const root = await tempRoot()
  await fs.writeFile(configPath(root), '{ not json', 'utf8')
  const config = await readConfig(root)
  assert.deepEqual(config.scanRoots, [])
  await fs.rm(root, { recursive: true, force: true })
})

test('alias, tags and run record roundtrip', async () => {
  const root = await tempRoot()
  const script = 'C:\\tools\\clean-logs.bat'

  const library = await readLibrary(root)
  setMeta(library, script, { alias: '清理日志', tags: ['运维', '日志'] })
  setRun(library, script, { exitCode: 42, durationMs: 1234, params: '--dry' })
  await saveLibrary(root, library)

  const reloaded = await readLibrary(root)
  const entry = reloaded[pathKey(script)]
  assert.equal(entry.alias, '清理日志')
  assert.deepEqual(entry.tags, ['运维', '日志'])
  assert.equal(entry.lastRun.exitCode, 42)
  assert.equal(entry.lastRun.durationMs, 1234)
  assert.equal(entry.lastRun.params, '--dry')
  assert.match(entry.lastRun.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

  await fs.rm(root, { recursive: true, force: true })
})

test('setMeta without tags leaves tags untouched', async () => {
  const root = await tempRoot()
  const library = await readLibrary(root)
  const script = 'C:\\tools\\a.bat'
  setMeta(library, script, { alias: 'A', tags: ['x'] })
  setMeta(library, script, { alias: 'B' })
  assert.equal(library[pathKey(script)].alias, 'B')
  assert.deepEqual(library[pathKey(script)].tags, ['x'])
  await fs.rm(root, { recursive: true, force: true })
})

test('orphan records survive a save (hidden, not deleted)', async () => {
  const root = await tempRoot()
  const library = await readLibrary(root)
  library[pathKey('C:\\gone\\deleted.bat')] = { alias: 'gone', tags: ['旧'], lastRun: null }
  await saveLibrary(root, library)
  const reloaded = await readLibrary(root)
  assert.ok(reloaded[pathKey('C:\\gone\\deleted.bat')])
  assert.ok(await fs.stat(libraryPath(root)))
  await fs.rm(root, { recursive: true, force: true })
})

test('concurrent saves to the same file never collide and leave valid JSON', async () => {
  const root = await tempRoot()
  const indexes = Array.from({ length: 20 }, (_, index) => index)

  await Promise.all(
    indexes.map((index) => {
      const library = {}
      setRun(library, `C:\\tools\\${index}.bat`, { exitCode: index, durationMs: 1 })
      return saveLibrary(root, library)
    }),
  )
  await Promise.all(indexes.map((index) => saveConfig(root, { scanRoots: [`C:\\root${index}`] })))

  JSON.parse(await fs.readFile(libraryPath(root), 'utf8'))
  const config = await readConfig(root)
  assert.equal(config.scanRoots.length, 1)
  assert.match(config.scanRoots[0], /^C:\\root\d+$/)
  assert.equal((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')).length, 0)
  await fs.rm(root, { recursive: true, force: true })
})

test('entries with no metadata are not written', async () => {
  const root = await tempRoot()
  const library = await readLibrary(root)
  getEntry(library, 'C:\\tools\\plain.bat')
  await saveLibrary(root, library)
  const raw = JSON.parse(await fs.readFile(libraryPath(root), 'utf8'))
  assert.deepEqual(raw.scripts, {})
  await fs.rm(root, { recursive: true, force: true })
})
