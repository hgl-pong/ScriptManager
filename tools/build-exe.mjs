// Build a single-file, Node-free ScriptManager.exe with Node SEA:
//   1. vite build -> web/dist
//   2. esbuild bundle server/sea-main.js -> build/sea-main.cjs
//   3. generate the SEA blob with web/dist embedded as assets
//   4. copy node.exe -> ScriptManager.exe
//   5. inject the blob with postject

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const { inject } = require('postject')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'build')
const distDir = path.join(root, 'web', 'dist')
const outExe = path.join(root, 'release', 'ScriptManager.exe')
const blobPath = path.join(buildDir, 'sea-prep.blob')
const configPath = path.join(buildDir, 'sea-config.json')
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

function run(command, args) {
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

function listFiles(dir, prefix = '') {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

console.log('1/5 构建前端 web/dist …')
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'])

fs.rmSync(buildDir, { recursive: true, force: true })
fs.mkdirSync(buildDir, { recursive: true })

console.log('2/5 打包服务端 bundle …')
await build({
  entryPoints: [path.join(root, 'server', 'sea-main.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: path.join(buildDir, 'sea-main.cjs'),
  legalComments: 'none',
})

console.log('3/5 收集静态资源 …')
const buildId = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
fs.writeFileSync(path.join(distDir, '.build-id'), buildId, 'utf8')
const assets = {}
for (const relative of listFiles(distDir)) {
  assets[`web/dist/${relative}`] = path.join(distDir, ...relative.split('/'))
}
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: path.join(buildDir, 'sea-main.cjs'),
      output: blobPath,
      disableExperimentalSEAWarning: true,
      assets,
    },
    null,
    2,
  ),
)

console.log('4/5 生成 SEA blob …')
run(process.execPath, ['--experimental-sea-config', configPath])

try {
  fs.mkdirSync(path.dirname(outExe), { recursive: true })
  fs.copyFileSync(process.execPath, outExe)
} catch (error) {
  throw new Error(`无法写入 ${outExe}，请先关闭正在运行的 ScriptManager.exe：${error.message}`)
}

console.log('5/5 注入 blob 并切换为 Windows GUI 子系统 …')
await inject(outExe, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), { sentinelFuse: FUSE })
const previousSubsystem = setGuiSubsystem(outExe)

const size = (fs.statSync(outExe).size / 1024 / 1024).toFixed(1)
console.log(`完成：${outExe}（${size} MB，PE 子系统 ${previousSubsystem} -> 2）`)

// node.exe is a console-subsystem binary; a double-click would open a black
// console. Set IMAGE_SUBSYSTEM_WINDOWS_GUI (2) so no console is allocated.
function setGuiSubsystem(exePath) {
  const data = fs.readFileSync(exePath)
  const peOffset = data.readUInt32LE(0x3c)
  if (data.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`不是有效的 PE 文件：${exePath}`)
  }
  const optionalHeader = peOffset + 24
  const magic = data.readUInt16LE(optionalHeader)
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`未知的 PE 可选头格式：0x${magic.toString(16)}`)
  }
  // Subsystem sits 68 bytes into IMAGE_OPTIONAL_HEADER for both PE32 and PE32+.
  const subsystemOffset = optionalHeader + 68
  const current = data.readUInt16LE(subsystemOffset)
  if (current !== 2) {
    data.writeUInt16LE(2, subsystemOffset)
    fs.writeFileSync(exePath, data)
  }
  return current
}
