// Shared startup: pick a port, generate a token, start the HTTP server and open
// the app window. Used by the development entry (server/app.js) and the packaged
// single-file executable (server/sea-main.js).

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from './server.js'
import { readConfig, saveConfig } from './store.js'

export async function start({ root, distDir, argv = [] }) {
  // Fresh installs start with <app dir>\scripts as the scan root. A config that
  // already exists is never rewritten, so an explicit empty root list is kept.
  const scriptsDir = path.join(root, 'scripts')
  fs.mkdirSync(scriptsDir, { recursive: true })
  if (!fs.existsSync(path.join(root, 'config.json'))) {
    const config = await readConfig(root)
    config.scanRoots = [scriptsDir]
    await saveConfig(root, config)
  }

  const noOpen = argv.includes('--no-open')
  const noToken = argv.includes('--no-token') || process.env.SM_NO_TOKEN === '1'
  const portArg = argv.find((arg) => arg.startsWith('--port='))
  const requestedPort = portArg ? Number(portArg.split('=')[1]) : 8765
  const basePort = Number.isFinite(requestedPort) ? requestedPort : 8765
  const token = noToken ? null : randomBytes(16).toString('hex')

  let started = null
  for (let offset = 0; offset < 20 && !started; offset += 1) {
    try {
      started = await createServer({ root, distDir, token, port: basePort + offset })
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
    }
  }

  if (!started) {
    console.error(`端口 ${basePort}-${basePort + 19} 都被占用，启动失败`)
    process.exit(1)
  }

  const url = `http://127.0.0.1:${started.port}/${token ? `?t=${token}` : ''}`
  console.log(`ScriptManager ${url}`)

  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.log('提示：未找到 web/dist，先执行 npm install && npm run build')
  }

  if (!noOpen) {
    const config = await readConfig(root)
    openAppWindow(url, `${config.window.width},${config.window.height}`)
  }

  return { ...started, url }
}

function openAppWindow(target, size) {
  const candidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean)

  const browser = candidates.find((candidate) => fs.existsSync(candidate))
  if (browser) {
    // --app: no address bar, own taskbar entry - as close to a native window as a web UI gets.
    spawn(browser, [`--app=${target}`, `--window-size=${size}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    return
  }
  spawn('cmd.exe', ['/c', 'start', '', target], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref()
}
