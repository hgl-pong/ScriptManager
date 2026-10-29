// Packaged entry for ScriptManager.exe. Node SEA embeds this bundle plus web/dist;
// at launch we extract the static files to a temp cache and reuse start.js.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import * as sea from 'node:sea'
import { start } from './start.js'

main().catch((error) => {
  try {
    console.error(error?.stack || String(error))
  } catch {
    // A GUI-subsystem exe may have no usable stdout; the message box remains.
  }
  showError(`ScriptManager 启动失败：\n${error?.message ?? error}`)
})

async function main() {
  const root = chooseDataDir()
  redirectLogs(root)
  const distDir = extractWeb()
  console.log(`data=${root} web=${distDir}`)
  await start({ root, distDir, argv: process.argv.slice(2) })
}

// Prefer a portable data folder next to the exe; fall back to LocalAppData when
// the exe lives somewhere read-only (e.g. Program Files).
function chooseDataDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const candidates = [
    process.env.SM_DATA_DIR,
    path.dirname(process.execPath),
    path.join(local, 'ScriptManager'),
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      fs.mkdirSync(candidate, { recursive: true })
      const probe = path.join(candidate, `.sm-write-${process.pid}`)
      fs.writeFileSync(probe, '')
      fs.rmSync(probe, { force: true })
      return candidate
    } catch {
      // Try the next location.
    }
  }
  return os.tmpdir()
}

function redirectLogs(root) {
  const logDir = path.join(root, 'logs')
  const preferred = path.join(logDir, 'server.log')
  const fallback = path.join(logDir, `server-${process.pid}.log`)
  let active = preferred
  try {
    fs.mkdirSync(logDir, { recursive: true })
  } catch {
    // Logging is best effort.
  }

  const append = (level, args) => {
    const text = args
      .map((value) => (value instanceof Error ? value.stack : String(value)))
      .join(' ')
    const line = `[${new Date().toISOString()}] ${level} ${text}\n`
    try {
      fs.appendFileSync(active, line)
    } catch {
      // Another instance may hold server.log open; keep a per-process fallback.
      if (active !== fallback) {
        active = fallback
        try {
          fs.appendFileSync(active, line)
        } catch {
          // Logging is best effort.
        }
      }
    }
  }

  console.log = (...args) => append('info', args)
  console.error = (...args) => append('error', args)
}

function extractWeb() {
  let buildId = 'default'
  try {
    buildId = sea.getAsset('web/dist/.build-id', 'utf8').trim() || 'default'
  } catch {
    // Older bundles may not carry a build id.
  }

  const cacheRoot = path.join(os.tmpdir(), 'ScriptManager-web', buildId)
  const marker = path.join(cacheRoot, '.complete')
  if (fs.existsSync(marker)) return cacheRoot

  fs.rmSync(cacheRoot, { recursive: true, force: true })
  for (const key of sea.getAssetKeys()) {
    if (!key.startsWith('web/dist/')) continue
    const relative = key.slice('web/dist/'.length)
    if (!relative || relative.split('/').includes('..')) continue
    const target = path.join(cacheRoot, ...relative.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.from(sea.getAsset(key)))
  }
  fs.writeFileSync(marker, buildId)
  return cacheRoot
}

function showError(message) {
  try {
    const encoded = Buffer.from(String(message), 'utf8').toString('base64')
    const script =
      `Add-Type -AssemblyName PresentationFramework; ` +
      `$m=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ` +
      `[System.Windows.MessageBox]::Show($m,'ScriptManager 启动失败','OK','Error') | Out-Null`
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    }).unref()
  } catch {
    // The log is still the fallback.
  }
}
