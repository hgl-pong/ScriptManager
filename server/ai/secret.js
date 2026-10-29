// API keys at rest: Windows DPAPI (CurrentUser) through a short PowerShell child
// process. Node has no DPAPI binding; the decrypted value is cached in memory so
// only the first request after startup pays the ~200-400ms process cost.

import { spawn } from 'node:child_process'

const PREFIX = 'dpapi:'
const cache = new Map()

const ENCRYPT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$s=[Console]::In.ReadToEnd()',
  '$b=[Text.Encoding]::UTF8.GetBytes($s)',
  '$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,"CurrentUser")',
  '[Console]::Out.Write([Convert]::ToBase64String($p))',
].join('; ')

// The plaintext is returned base64-encoded so the console code page cannot mangle it.
const DECRYPT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$s=[Console]::In.ReadToEnd().Trim()',
  '$b=[Convert]::FromBase64String($s)',
  '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,"CurrentUser")',
  '[Console]::Out.Write([Convert]::ToBase64String($p))',
].join('; ')

export function isProtected(value) {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

export async function protectSecret(plain) {
  const text = String(plain ?? '')
  if (!text) return ''
  const sealed = await runPowerShell(ENCRYPT_SCRIPT, text)
  if (!sealed) throw new Error('DPAPI 没有返回密文')
  return PREFIX + sealed
}

export async function unprotectSecret(stored) {
  if (!stored) return ''
  if (!isProtected(stored)) return stored // A hand-edited config.json may still hold plaintext.
  if (cache.has(stored)) return cache.get(stored)

  const encoded = await runPowerShell(DECRYPT_SCRIPT, stored.slice(PREFIX.length))
  const plain = Buffer.from(encoded, 'base64').toString('utf8')
  cache.set(stored, plain)
  return plain
}

function runPowerShell(script, input, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new Error(`无法启动 PowerShell：${error.message}`))
      return
    }

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('DPAPI 调用超时'))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 PowerShell：${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`DPAPI 调用失败：${(stderr || stdout).trim().slice(0, 400)}`))
        return
      }
      resolve(stdout.trim())
    })

    child.stdin.on('error', () => {
      // The child may exit before reading stdin; the close handler reports the failure.
    })
    child.stdin.end(String(input), 'utf8')
  })
}
