// config.json / library.json store. Writes go through a temp file + rename so a
// half-written file can never be read back; access is serialized per file.

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathKey } from './library.js'

const DEFAULT_WINDOW = { width: 1200, height: 760 }

export const LOCAL_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max']

export function defaultLocalAgent() {
  return {
    enabled: true,
    command: 'claude',
    model: '',
    effort: '',
    cwd: '',
    extraArgs: '',
    timeoutMs: 300_000,
  }
}

export function normalizeLocalAgent(raw, fallback = defaultLocalAgent()) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const seconds = Number(value.timeoutMs)
  return {
    enabled: value.enabled !== false,
    command:
      typeof value.command === 'string' && value.command.trim()
        ? value.command.trim()
        : fallback.command,
    model: typeof value.model === 'string' ? value.model.trim() : fallback.model,
    effort: LOCAL_EFFORTS.includes(value.effort) ? value.effort : fallback.effort,
    cwd: typeof value.cwd === 'string' ? value.cwd.trim() : fallback.cwd,
    extraArgs: typeof value.extraArgs === 'string' ? value.extraArgs : fallback.extraArgs,
    timeoutMs: Number.isFinite(seconds)
      ? Math.min(Math.max(Math.round(seconds), 10_000), 3_600_000)
      : fallback.timeoutMs,
  }
}

export function defaultAi() {
  return {
    activeProfileId: null,
    profiles: [],
    lastScriptDir: '',
    lastScriptType: 'cmd',
    localAgent: defaultLocalAgent(),
  }
}

export function defaultConfig() {
  return { scanRoots: [], window: { ...DEFAULT_WINDOW }, ai: defaultAi() }
}

export function configPath(root) {
  return path.join(root, 'config.json')
}

export function libraryPath(root) {
  return path.join(root, 'library.json')
}

export function runHistoryPath(root) {
  return path.join(root, 'run-history.json')
}

export function aiHistoryPath(root) {
  return path.join(root, 'ai-history.json')
}

export async function readRunHistory(root) {
  const raw = await readJson(runHistoryPath(root), null)
  return Array.isArray(raw?.entries) ? raw.entries.filter((entry) => entry && typeof entry === 'object') : []
}

export async function saveRunHistory(root, entries) {
  await writeJson(runHistoryPath(root), { entries: Array.isArray(entries) ? entries : [] })
}

export async function readAiHistory(root) {
  const raw = await readJson(aiHistoryPath(root), null)
  return Array.isArray(raw?.entries) ? raw.entries.filter((entry) => entry && typeof entry === 'object') : []
}

export async function saveAiHistory(root, entries) {
  await writeJson(aiHistoryPath(root), { entries: Array.isArray(entries) ? entries : [] })
}

// All access to one file is serialized in-process. Writes use a unique temp name
// and rename, but Windows refuses to replace a file while another handle has it
// open (`EPERM`), so reads take the same lock. A failed action never stalls the
// queue: the chain keeps the settled guard, while the caller sees its own error.
const fileLocks = new Map()
let tempCounter = 0

function withFileLock(file, action) {
  const previous = fileLocks.get(file) ?? Promise.resolve()
  const run = previous.then(action, action)
  const guard = run.catch(() => {})
  fileLocks.set(file, guard)
  guard.finally(() => {
    if (fileLocks.get(file) === guard) fileLocks.delete(file)
  })
  return run
}

async function readJson(file, fallback) {
  return withFileLock(file, async () => {
    try {
      const raw = await fs.readFile(file, 'utf8')
      return JSON.parse(raw)
    } catch {
      return fallback
    }
  })
}

async function writeJson(file, value) {
  return withFileLock(file, async () => {
    const temp = `${file}.${process.pid}.${++tempCounter}.tmp`
    try {
      await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
      await fs.rename(temp, file)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {})
      throw error
    }
  })
}

export async function readConfig(root) {
  const raw = await readJson(configPath(root), null)
  const config = defaultConfig()
  if (!raw || typeof raw !== 'object') return config

  if (Array.isArray(raw.scanRoots)) {
    config.scanRoots = raw.scanRoots.filter((item) => typeof item === 'string' && item)
  }
  if (raw.window && typeof raw.window === 'object') {
    const width = Number(raw.window.width)
    const height = Number(raw.window.height)
    if (Number.isFinite(width) && width > 400) config.window.width = width
    if (Number.isFinite(height) && height > 300) config.window.height = height
  }
  config.ai = normalizeAi(raw.ai)
  return config
}

function normalizeAi(raw) {
  const ai = defaultAi()
  if (!raw || typeof raw !== 'object') return ai

  if (typeof raw.activeProfileId === 'string') ai.activeProfileId = raw.activeProfileId
  if (typeof raw.lastScriptDir === 'string') ai.lastScriptDir = raw.lastScriptDir
  if (['cmd', 'powershell', 'python'].includes(raw.lastScriptType)) ai.lastScriptType = raw.lastScriptType
  if (Array.isArray(raw.profiles)) {
    ai.profiles = raw.profiles
      .filter((profile) => profile && typeof profile.id === 'string' && profile.id)
      .map((profile) => ({
        id: profile.id,
        name: typeof profile.name === 'string' ? profile.name : '',
        protocol: typeof profile.protocol === 'string' ? profile.protocol : 'openai-chat',
        baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl : '',
        model: typeof profile.model === 'string' ? profile.model : '',
        apiKey: typeof profile.apiKey === 'string' ? profile.apiKey : '',
        reasoningEffort: ['', 'minimal', 'low', 'medium', 'high'].includes(profile.reasoningEffort)
          ? profile.reasoningEffort
          : '',
        headers:
          profile.headers && typeof profile.headers === 'object' && !Array.isArray(profile.headers)
            ? Object.fromEntries(
                Object.entries(profile.headers).filter(
                  ([key, value]) => typeof key === 'string' && typeof value === 'string',
                ),
              )
            : {},
      }))
  }
  ai.localAgent = normalizeLocalAgent(raw.localAgent, defaultLocalAgent())
  return ai
}

export async function saveConfig(root, config) {
  await writeJson(configPath(root), {
    scanRoots: (config?.scanRoots ?? []).filter((item) => typeof item === 'string' && item),
    window: {
      width: Number(config?.window?.width) || DEFAULT_WINDOW.width,
      height: Number(config?.window?.height) || DEFAULT_WINDOW.height,
    },
    ai: {
      activeProfileId: config?.ai?.activeProfileId ?? null,
      profiles: (config?.ai?.profiles ?? []).map((profile) => ({
        id: profile.id,
        name: profile.name ?? '',
        protocol: profile.protocol ?? 'openai-chat',
        baseUrl: profile.baseUrl ?? '',
        model: profile.model ?? '',
        apiKey: profile.apiKey ?? '',
        reasoningEffort: profile.reasoningEffort ?? '',
        headers: profile.headers ?? {},
      })),
      localAgent: normalizeLocalAgent(config?.ai?.localAgent),
      lastScriptDir: config?.ai?.lastScriptDir ?? '',
      lastScriptType: config?.ai?.lastScriptType ?? 'cmd',
    },
  })
}

export async function readLibrary(root) {
  const raw = await readJson(libraryPath(root), null)
  const library = {}
  if (!raw || typeof raw.scripts !== 'object' || !raw.scripts) return library

  for (const [key, entry] of Object.entries(raw.scripts)) {
    if (!entry || typeof entry !== 'object') continue
    library[key] = {
      alias: typeof entry.alias === 'string' ? entry.alias : '',
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string' && tag) : [],
      lastRun: normalizeRun(entry.lastRun),
    }
  }
  return library
}

function normalizeRun(lastRun) {
  if (!lastRun || typeof lastRun !== 'object') return null
  return {
    at: typeof lastRun.at === 'string' ? lastRun.at : '',
    exitCode: Number.isFinite(Number(lastRun.exitCode)) ? Number(lastRun.exitCode) : null,
    durationMs: Number.isFinite(Number(lastRun.durationMs)) ? Number(lastRun.durationMs) : null,
    params: typeof lastRun.params === 'string' ? lastRun.params : '',
  }
}

export async function saveLibrary(root, library = {}) {
  const scripts = {}
  for (const [key, entry] of Object.entries(library)) {
    const hasMeta = Boolean(entry?.alias) || (entry?.tags?.length ?? 0) > 0 || Boolean(entry?.lastRun)
    if (!hasMeta) continue
    scripts[key] = {
      alias: entry.alias ?? '',
      tags: entry.tags ?? [],
      lastRun: entry.lastRun ?? null,
    }
  }
  await writeJson(libraryPath(root), { scripts })
}

export function getEntry(library, filePath) {
  const key = pathKey(filePath)
  if (!library[key]) library[key] = { alias: '', tags: [], lastRun: null }
  return library[key]
}

export function setMeta(library, filePath, { alias, tags }) {
  const entry = getEntry(library, filePath)
  if (alias !== undefined) entry.alias = String(alias ?? '').trim()
  if (tags !== undefined) {
    entry.tags = (Array.isArray(tags) ? tags : [])
      .map((tag) => String(tag).trim())
      .filter(Boolean)
  }
  return entry
}

export function setRun(library, filePath, { exitCode, durationMs, params = '' }) {
  const entry = getEntry(library, filePath)
  entry.lastRun = {
    at: timestamp(new Date()),
    exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
    durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
    params: String(params ?? ''),
  }
  return entry
}

function timestamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}
