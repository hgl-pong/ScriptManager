// Script library: scanning, type detection, view merge/sort.
// Row helpers (filter / tags / formatting) live in shared/rows.js so the browser reuses them.

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathKey } from './paths.js'

export { filterRows as filterView, allTags, formatLastRun, typeLabel } from '../shared/rows.js'
export { pathKey }

const TYPE_BY_EXT = new Map([
  ['.bat', 'cmd'],
  ['.cmd', 'cmd'],
  ['.ps1', 'powershell'],
  ['.py', 'python'],
])

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'bin', 'obj', '.idea', '.vs', 'logs',
])

export function scriptType(filePath) {
  return TYPE_BY_EXT.get(path.extname(filePath).toLowerCase()) ?? null
}

export function skipDir(name) {
  const lower = String(name).toLowerCase()
  return SKIP_DIRS.has(lower) || lower.startsWith('.')
}

export async function scanRoots(roots = []) {
  const found = []
  for (const root of roots) {
    if (!root) continue
    let stats
    try {
      stats = await fs.stat(root)
    } catch {
      continue
    }
    if (!stats.isDirectory()) continue

    const stack = [root]
    while (stack.length > 0) {
      const dir = stack.pop()
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!skipDir(entry.name)) stack.push(path.join(dir, entry.name))
          continue
        }
        if (!entry.isFile()) continue
        const type = scriptType(entry.name)
        if (!type) continue
        found.push({ path: path.join(dir, entry.name), name: entry.name, type })
      }
    }
  }
  return found
}

// Merge scanned files with their metadata into display rows: recently run first, then by name.
export function mergeView(library = {}, scripts = []) {
  const rows = scripts.map((script) => {
    const entry = library[pathKey(script.path)]
    const lastRun = entry?.lastRun ?? null
    return {
      path: script.path,
      name: script.name,
      type: script.type,
      displayName: entry?.alias ? entry.alias : script.name.replace(/\.[^.]+$/, ''),
      tags: entry?.tags ?? [],
      lastRunAt: lastRun?.at ?? '',
      lastExit: lastRun?.exitCode ?? null,
      lastDurationMs: lastRun?.durationMs ?? null,
      lastParams: lastRun?.params ?? '',
    }
  })

  const withRun = rows
    .filter((row) => row.lastRunAt)
    .sort((a, b) => b.lastRunAt.localeCompare(a.lastRunAt))
  const withoutRun = rows
    .filter((row) => !row.lastRunAt)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'))
  return [...withRun, ...withoutRun]
}
