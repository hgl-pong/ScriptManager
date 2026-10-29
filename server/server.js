// HTTP layer: node:http routing, token check, static hosting of web/dist.
// createServer() returns a ready server so tests can drive the real endpoints.

import http from 'node:http'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import * as library from './library.js'
import * as store from './store.js'
import * as runner from './runner.js'
import * as aiJobs from './ai/job.js'
import * as aiLocal from './ai/local.js'
import * as aiPrompts from './ai/prompts.js'
import * as aiSecret from './ai/secret.js'
import { isProtocol, modelHeaders, modelsEndpointFor, protocolList } from './ai/protocols.js'
import { decodeScript, encodeScript } from './encoding.js'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const MISSING_DIST_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<body style="font-family:system-ui;padding:40px;line-height:1.7">
<h2>还没构建前端</h2>
<p>在项目目录里执行一次：</p>
<pre>npm install
npm run build</pre>
<p>然后重新双击 <code>ScriptManager.bat</code>。</p></body></html>`

export async function createServer({ root, distDir, token = null, port = 8765, host = '127.0.0.1' }) {
  let currentRun = null
  let currentJob = null
  // True from the moment an ask reserves the single-job slot until its job is
  // assigned (or the request fails); guards the awaits before startAiJob.
  let startingAsk = false
  let scanCache = null
  // Run records are written when the process exits; a state read waits for that write.
  let pendingSave = Promise.resolve()
  let pendingAiHistory = Promise.resolve()

  async function buildState(rescan) {
    await pendingSave
    if (rescan || !scanCache) {
      const config = await store.readConfig(root)
      scanCache = { config, scripts: await library.scanRoots(config.scanRoots) }
    }
    const libraryStore = await store.readLibrary(root)
    const view = library.mergeView(libraryStore, scanCache.scripts)
    return {
      scanRoots: scanCache.config.scanRoots,
      tags: library.allTags(view),
      scripts: view,
      runs: (await store.readRunHistory(root)).slice(-100).reverse(),
      running: currentRun && currentRun.state === 'running' ? currentRun.id : null,
    }
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 1_000_000) {
          reject(new Error('请求体过大'))
          req.destroy()
        }
      })
      req.on('end', () => {
        if (!data) return resolve({})
        try {
          resolve(JSON.parse(data))
        } catch {
          reject(new Error('请求体不是 JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  async function browse(target) {
    if (!target) {
      const drives = []
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
        const candidate = `${letter}:\\`
        try {
          const stats = await fs.stat(candidate)
          if (stats.isDirectory()) drives.push({ name: candidate, path: candidate })
        } catch {
          // Drive does not exist.
        }
      }
      return { path: '', parent: null, dirs: drives }
    }

    const entries = await fs.readdir(target, { withFileTypes: true })
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !library.skipDir(entry.name))
      .map((entry) => ({ name: entry.name, path: path.join(target, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    const parent = path.dirname(target)
    return { path: target, parent: parent === target ? null : parent, dirs }
  }

  function maskProfiles(config) {
    return (config.ai?.profiles ?? []).map((profile) => ({
      id: profile.id,
      name: profile.name,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort ?? '',
      headers: profile.headers ?? {},
      hasKey: Boolean(profile.apiKey),
    }))
  }

  async function aiState() {
    const config = await store.readConfig(root)
    return {
      activeProfileId: config.ai.activeProfileId,
      profiles: maskProfiles(config),
      lastScriptDir: config.ai.lastScriptDir,
      lastScriptType: config.ai.lastScriptType,
      protocols: protocolList(),
      localAgent: { ...config.ai.localAgent },
      job:
        currentJob && currentJob.state === 'running'
          ? { id: currentJob.id, kind: currentJob.kind ?? null, state: currentJob.state }
          : null,
    }
  }

  // Draft from the settings dialog wins; otherwise fall back to the saved profile (key decrypted).
  async function resolveProfile(draft) {
    const config = await store.readConfig(root)
    const saved = (config.ai.profiles ?? []).find((item) => item.id === draft?.id)
    const profile = {
      id: draft?.id ?? saved?.id ?? 'draft',
      name: draft?.name ?? saved?.name ?? '',
      protocol: draft?.protocol ?? saved?.protocol ?? 'openai-chat',
      baseUrl: draft?.baseUrl ?? saved?.baseUrl ?? '',
      model: draft?.model ?? saved?.model ?? '',
      reasoningEffort: draft?.reasoningEffort ?? saved?.reasoningEffort ?? '',
      headers: draft?.headers ?? saved?.headers ?? {},
      apiKey: '',
    }

    if (draft?.apiKey === null) profile.apiKey = ''
    else if (typeof draft?.apiKey === 'string' && draft.apiKey) profile.apiKey = draft.apiKey
    else if (saved?.apiKey) profile.apiKey = await aiSecret.unprotectSecret(saved.apiKey)
    return profile
  }

  // Upstream failures are returned as data ({models: [], error}) so the settings
  // dialog can keep manual model entry usable when /models is missing.
  async function fetchModelList(profile) {
    const primary = modelsEndpointFor(profile.protocol, profile.baseUrl)
    const headers = modelHeaders(profile)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      let url = profile.protocol === 'anthropic' ? `${primary}?limit=100` : primary
      let response = await fetch(url, { headers, signal: controller.signal })
      if (response.status === 404 && primary.endsWith('/v1/models')) {
        url = `${primary.slice(0, -'/v1/models'.length)}/models`
        response = await fetch(url, { headers, signal: controller.signal })
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).trim()
        return { url, models: [], error: `HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}` }
      }

      const json = await response.json().catch(() => null)
      if (!json) return { url, models: [], error: '响应不是 JSON' }

      let models = normalizeModels(json)
      if (profile.protocol === 'anthropic' && json.has_more && json.last_id) {
        let after = json.last_id
        for (let page = 0; page < 4 && after; page += 1) {
          const separator = url.includes('?') ? '&' : '?'
          const nextUrl = `${url}${separator}limit=100&after_id=${encodeURIComponent(after)}`
          const next = await fetch(nextUrl, { headers, signal: controller.signal })
          if (!next.ok) break
          const nextJson = await next.json().catch(() => null)
          if (!nextJson) break
          models = models.concat(normalizeModels(nextJson))
          if (!nextJson.has_more || !nextJson.last_id) break
          after = nextJson.last_id
        }
      }

      models = dedupeModels(models)
      return models.length
        ? { url, models, error: null }
        : { url, models: [], error: '响应里没有模型列表' }
    } catch (error) {
      const message = error.name === 'AbortError' ? '获取模型超时（20 秒）' : error.message
      return { url: primary, models: [], error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  function normalizeModels(payload) {
    const raw = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : []
    return raw
      .map((item) => {
        if (typeof item === 'string') return { id: item }
        if (!item || typeof item !== 'object') return null
        const id = item.id ?? item.name ?? item.model
        if (typeof id !== 'string' || !id) return null
        const label = item.display_name ?? item.name ?? item.id
        return { id, name: typeof label === 'string' && label !== id ? label : undefined }
      })
      .filter(Boolean)
  }

  function dedupeModels(models) {
    const seen = new Map()
    for (const model of models) {
      if (!seen.has(model.id)) seen.set(model.id, model)
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  // `.ps1` must carry a BOM and Windows scripts get CRLF, otherwise Chinese gets
  // mangled. `encoding` is the source encoding on apply; new scripts use the type
  // default. Legacy GBK files are written back as GBK, never silently as UTF-8.
  async function writeScript(target, content, type, encoding) {
    const unified = String(content ?? '').replace(/\r\n/g, '\n')
    const body = type === 'python' ? unified : unified.replace(/\n/g, '\r\n')
    const targetEncoding = encoding ?? (type === 'powershell' ? 'utf-8-bom' : 'utf-8')
    await fs.writeFile(target, encodeScript(body, targetEncoding))
  }

  // Detects UTF-8 BOM, UTF-16LE/BE BOM, strict UTF-8, then GBK.
  async function readScript(target) {
    return (await decodeScript(await fs.readFile(target))).text
  }

  // Never clobber an earlier backup: .bak, then .bak.1, .bak.2, ...
  async function backupFile(target) {
    for (let index = 0; ; index += 1) {
      const candidate = index === 0 ? `${target}.bak` : `${target}.bak.${index}`
      try {
        await fs.copyFile(target, candidate, fsConstants.COPYFILE_EXCL)
        return candidate
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
  }

  function countChangedLines(before, after) {
    const a = String(before).replace(/\r\n/g, '\n').split('\n')
    const b = String(after).replace(/\r\n/g, '\n').split('\n')
    let changed = Math.abs(a.length - b.length)
    const shared = Math.min(a.length, b.length)
    for (let index = 0; index < shared; index += 1) {
      if (a[index] !== b[index]) changed += 1
    }
    return changed
  }

  async function handleApi(req, res, url) {
    if (token && req.headers['x-sm-token'] !== token) {
      return sendJson(res, 401, { error: '缺少或错误的访问 token' })
    }

    const route = `${req.method} ${url.pathname}`

    if (route === 'GET /api/health') {
      return sendJson(res, 200, { ok: true })
    }

    if (route === 'GET /api/state') {
      return sendJson(res, 200, await buildState(url.searchParams.get('rescan') === '1'))
    }

    if (route === 'POST /api/scan') {
      return sendJson(res, 200, await buildState(true))
    }

    if (route === 'POST /api/roots') {
      const body = await readBody(req)
      const config = await store.readConfig(root)
      config.scanRoots = (Array.isArray(body.roots) ? body.roots : [])
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim())
      await store.saveConfig(root, config)
      return sendJson(res, 200, await buildState(true))
    }

    if (route === 'GET /api/browse') {
      try {
        return sendJson(res, 200, await browse(url.searchParams.get('path') || ''))
      } catch (error) {
        return sendJson(res, 400, { error: `打不开目录：${error.message}` })
      }
    }

    if (route === 'POST /api/meta') {
      const body = await readBody(req)
      if (!body.path) return sendJson(res, 400, { error: '缺少 path' })
      const libraryStore = await store.readLibrary(root)
      store.setMeta(libraryStore, body.path, { alias: body.alias, tags: body.tags })
      await store.saveLibrary(root, libraryStore)
      return sendJson(res, 200, await buildState(false))
    }

    if (route === 'POST /api/run') {
      const body = await readBody(req)
      if (!body.path) return sendJson(res, 400, { error: '缺少 path' })
      if (currentRun && currentRun.state === 'running') {
        return sendJson(res, 409, { error: '已有脚本在运行，先停止它' })
      }
      let spec
      try {
        spec = runner.buildSpec(body.path, body.params ?? '')
      } catch (error) {
        return sendJson(res, 400, { error: error.message })
      }
      currentRun = runner.startRun(spec, {
        path: body.path,
        params: body.params ?? '',
        onExit: (finished) => {
          pendingSave = pendingSave
            .then(async () => {
              const libraryStore = await store.readLibrary(root)
              store.setRun(libraryStore, finished.path, {
                exitCode: finished.exitCode,
                durationMs: finished.durationMs,
                params: finished.params,
              })
              await store.saveLibrary(root, libraryStore)
              const runs = await store.readRunHistory(root)
              runs.push({
                id: randomUUID(),
                at: new Date().toISOString(),
                path: finished.path,
                name: path.basename(finished.path),
                params: finished.params ?? '',
                exitCode: finished.exitCode,
                durationMs: finished.durationMs,
              })
              await store.saveRunHistory(root, runs.slice(-100))
            })
            .catch(() => {})
        },
      })
      return sendJson(res, 200, { runId: currentRun.id })
    }

    if (route === 'GET /api/output') {
      if (!currentRun || currentRun.id !== url.searchParams.get('runId')) {
        return sendJson(res, 404, { error: '没有这个运行' })
      }
      const after = Number(url.searchParams.get('after') ?? 0)
      return sendJson(res, 200, runner.readRun(currentRun, Number.isFinite(after) ? after : 0))
    }

    if (route === 'POST /api/stop') {
      const body = await readBody(req)
      if (!currentRun || (body.runId && body.runId !== currentRun.id)) {
        return sendJson(res, 404, { error: '没有这个运行' })
      }
      runner.stopRun(currentRun)
      return sendJson(res, 200, { ok: true })
    }

    if (route === 'POST /api/terminal') {
      const body = await readBody(req)
      if (!body.path) return sendJson(res, 400, { error: '缺少 path' })
      try {
        runner.startInTerminal(runner.buildSpec(body.path, body.params ?? ''))
      } catch (error) {
        return sendJson(res, 400, { error: error.message })
      }
      return sendJson(res, 200, { ok: true })
    }

    if (route === 'POST /api/open' || route === 'POST /api/reveal') {
      const body = await readBody(req)
      if (!body.path) return sendJson(res, 400, { error: '缺少 path' })
      try {
        if (route === 'POST /api/open') {
          spawn('rundll32.exe', ['url.dll,FileProtocolHandler', body.path], {
            detached: true,
            stdio: 'ignore',
          }).unref()
        } else {
          spawn('explorer.exe', [`/select,${body.path}`], { detached: true, stdio: 'ignore' }).unref()
        }
      } catch (error) {
        return sendJson(res, 500, { error: error.message })
      }
      return sendJson(res, 200, { ok: true })
    }

    if (route === 'GET /api/ai/state') {
      return sendJson(res, 200, await aiState())
    }

    if (route === 'POST /api/ai/profiles') {
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { error: '请求体必须是对象' })
      }
      // A missing/non-array list is a client bug, not a request to delete everything.
      if (!Array.isArray(body.profiles)) {
        return sendJson(res, 400, { error: 'profiles 必须是数组' })
      }
      const config = await store.readConfig(root)
      const existing = new Map((config.ai.profiles ?? []).map((profile) => [profile.id, profile]))
      const profiles = []

      for (const draft of body.profiles) {
        if (!draft || typeof draft.id !== 'string' || !draft.id) continue
        const protocol = String(draft.protocol ?? 'openai-chat')
        if (!isProtocol(protocol)) return sendJson(res, 400, { error: `未知协议：${protocol}` })
        const previous = existing.get(draft.id)
        let apiKey = previous?.apiKey ?? ''
        if (draft.apiKey === null) apiKey = ''
        else if (typeof draft.apiKey === 'string' && draft.apiKey) {
          if (aiSecret.isProtected(draft.apiKey)) apiKey = draft.apiKey
          else {
            try {
              apiKey = await aiSecret.protectSecret(draft.apiKey)
            } catch (error) {
              return sendJson(res, 400, { error: error.message })
            }
          }
        }
        profiles.push({
          id: draft.id,
          name: String(draft.name ?? ''),
          protocol,
          baseUrl: String(draft.baseUrl ?? ''),
          model: String(draft.model ?? ''),
          reasoningEffort: typeof draft.reasoningEffort === 'string' ? draft.reasoningEffort : '',
          headers: draft.headers ?? {},
          apiKey,
        })
      }

      config.ai.profiles = profiles
      // Saving an API profile is the legacy/API mode; the local agent is the UI default.
      config.ai.localAgent = { ...config.ai.localAgent, enabled: false }
      config.ai.activeProfileId = profiles.some((profile) => profile.id === body.activeProfileId)
        ? body.activeProfileId
        : (profiles[0]?.id ?? null)
      await store.saveConfig(root, config)
      return sendJson(res, 200, await aiState())
    }

    if (route === 'POST /api/ai/local') {
      const body = await readBody(req)
      const input = body?.local
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return sendJson(res, 400, { error: '缺少 local' })
      }
      const config = await store.readConfig(root)
      config.ai.localAgent = store.normalizeLocalAgent(input, config.ai.localAgent)
      await store.saveConfig(root, config)
      return sendJson(res, 200, await aiState())
    }

    if (route === 'POST /api/ai/local/test') {
      const body = await readBody(req)
      const config = await store.readConfig(root)
      const local = body?.local
        ? store.normalizeLocalAgent(body.local, config.ai.localAgent)
        : config.ai.localAgent
      if (!local.enabled && !body?.local) {
        return sendJson(res, 400, { error: '本地 Code Agent 未启用' })
      }
      try {
        const text = await aiLocal.runLocalOnce({
          local,
          prompt: '只回复两个字：正常',
          timeoutMs: 60_000,
        })
        return sendJson(res, 200, { text })
      } catch (error) {
        return sendJson(res, 400, { error: error.message })
      }
    }

    if (route === 'GET /api/ai/history') {
      await pendingAiHistory
      return sendJson(res, 200, { entries: await store.readAiHistory(root) })
    }

    if (route === 'POST /api/ai/history/clear') {
      await pendingAiHistory
      await store.saveAiHistory(root, [])
      return sendJson(res, 200, { ok: true })
    }

    if (route === 'POST /api/ai/models') {
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body) || !body.profile || typeof body.profile !== 'object') {
        return sendJson(res, 400, { error: '缺少 profile' })
      }
      let profile
      try {
        profile = await resolveProfile(body.profile)
        return sendJson(res, 200, await fetchModelList(profile))
      } catch (error) {
        return sendJson(res, 400, { error: error.message })
      }
    }

    if (route === 'POST /api/ai/test') {
      const body = await readBody(req)
      let profile
      try {
        profile = await resolveProfile(body.profile)
      } catch (error) {
        return sendJson(res, 400, { error: error.message })
      }
      try {
        const text = await aiJobs.runAiOnce({
          profile,
          system: '你只做连通性测试。',
          messages: [{ role: 'user', content: '只回复 OK' }],
          timeoutMs: 60_000,
        })
        return sendJson(res, 200, { text })
      } catch (error) {
        return sendJson(res, 400, { error: error.message })
      }
    }

    if (route === 'POST /api/ai/ask') {
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { error: '请求体必须是对象' })
      }
      if (startingAsk || (currentJob && currentJob.state === 'running')) {
        return sendJson(res, 409, { error: '上一条 AI 请求还在进行，先停止它' })
      }
      // Reserve the single-job slot before any await so two asks arriving together
      // cannot both pass the guard and orphan one of the upstream requests.
      startingAsk = true
      try {
        const kind = String(body.kind ?? '')
        if (!aiPrompts.AI_KINDS.includes(kind)) return sendJson(res, 400, { error: `未知用途：${kind}` })
        if (kind === 'generate' && !String(body.prompt ?? '').trim()) {
          return sendJson(res, 400, { error: '写一句需求再生成' })
        }
        if (kind === 'generate' && body.type !== undefined && !['cmd', 'powershell', 'python'].includes(body.type)) {
          return sendJson(res, 400, { error: `未知解释器：${body.type}` })
        }

        const config = await store.readConfig(root)
        const localAgent = config.ai.localAgent
        const useLocal = Boolean(localAgent?.enabled)
        const saved = useLocal
          ? null
          : (config.ai.profiles ?? []).find((profile) => profile.id === config.ai.activeProfileId)
        if (!useLocal && !saved) {
          return sendJson(res, 400, { error: '本地 Code Agent 未启用，且还没有 AI 配置：点「设置…」加一条' })
        }

        const context = {
          prompt: body.prompt,
          type: body.type ?? config.ai.lastScriptType,
          previous: body.previous,
          path: body.path,
        }

        if (kind !== 'generate') {
          if (typeof body.path !== 'string' || !body.path) return sendJson(res, 400, { error: '缺少 path' })
          // Only scanned script types may be sent to the provider.
          if (!library.scriptType(body.path)) {
            return sendJson(res, 400, { error: '只支持 .bat / .cmd / .ps1 / .py 脚本' })
          }
          let script
          try {
            script = await readScript(body.path)
          } catch (error) {
            return sendJson(res, 400, { error: `读不到脚本：${error.message}` })
          }
          context.script = script.length > 200_000 ? script.slice(0, 200_000) : script
          // Use the selected script's own type, not the generate dropdown's value.
          context.type = library.scriptType(body.path) ?? context.type

          if (kind === 'diagnose') {
            const entry = (await store.readLibrary(root))[library.pathKey(body.path)]
            context.lastExitCode = entry?.lastRun?.exitCode ?? null
            const sameScript =
              currentRun && currentRun.path && currentRun.path.toLowerCase() === String(body.path).toLowerCase()
            context.lastRunText = sameScript ? currentRun.lines.slice(-200).join('\n') : ''
          }
        }

        let prompt
        try {
          prompt = aiPrompts.buildMessages(kind, context)
        } catch (error) {
          return sendJson(res, 400, { error: error.message })
        }

        if (kind === 'generate' && ['cmd', 'powershell', 'python'].includes(context.type)) {
          config.ai.lastScriptType = context.type
          await store.saveConfig(root, config)
        }

        let job
        try {
          if (useLocal) {
            const fullPrompt = [
              '你正在被 ScriptManager 非交互式调用。不要使用工具、不要修改文件，只输出最终内容。',
              prompt.system,
              ...prompt.messages.map((message) => message.content),
            ]
              .filter(Boolean)
              .join('\n\n')
            job = aiLocal.startLocalJob({
              local: localAgent,
              prompt: fullPrompt,
              timeoutMs: localAgent.timeoutMs,
            })
          } else {
            const profile = {
              ...saved,
              apiKey: saved.apiKey ? await aiSecret.unprotectSecret(saved.apiKey) : '',
            }
            job = aiJobs.startAiJob({
              profile,
              system: prompt.system,
              messages: prompt.messages,
              timeoutMs: aiJobs.ASK_TIMEOUT_MS,
            })
          }
        } catch (error) {
          return sendJson(res, 400, { error: error.message })
        }
        job.kind = kind
        const historyMeta = {
          kind,
          prompt: kind === 'generate' ? String(body.prompt ?? '') : '',
          path: kind === 'generate' ? null : String(body.path ?? ''),
        }
        job.onFinish = () => {
          pendingAiHistory = pendingAiHistory
            .then(async () => {
              const entries = await store.readAiHistory(root)
              const text = String(job.text ?? '')
              entries.push({
                id: randomUUID(),
                at: new Date().toISOString(),
                kind,
                prompt: historyMeta.prompt,
                path: historyMeta.path,
                state: job.state,
                error: job.error ?? null,
                text: text.slice(0, 50_000),
                truncated: text.length > 50_000,
              })
              await store.saveAiHistory(root, entries.slice(-30))
            })
            .catch(() => {})
        }
        currentJob = job
        return sendJson(res, 200, { jobId: job.id })
      } finally {
        startingAsk = false
      }
    }

    if (route === 'GET /api/ai/stream') {
      if (!currentJob || currentJob.id !== url.searchParams.get('jobId')) {
        return sendJson(res, 404, { error: '没有这个请求' })
      }
      const after = Number(url.searchParams.get('after') ?? 0)
      const payload = aiJobs.readJob(currentJob, Number.isFinite(after) ? after : 0)
      // Make sure the history write is scheduled before the client sees the terminal state.
      if (payload.state !== 'running') aiJobs.notifyJobFinished(currentJob)
      return sendJson(res, 200, payload)
    }

    if (route === 'POST /api/ai/stop') {
      const body = await readBody(req)
      if (!currentJob || (body.jobId && body.jobId !== currentJob.id)) {
        return sendJson(res, 404, { error: '没有这个请求' })
      }
      aiJobs.stopJob(currentJob)
      return sendJson(res, 200, { ok: true })
    }

    if (route === 'POST /api/ai/save') {
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { error: '请求体必须是对象' })
      }
      if (typeof body.content !== 'string' || !body.content.trim()) {
        return sendJson(res, 400, { error: '缺少脚本内容 content' })
      }
      const type = String(body.type ?? 'cmd')
      const extension = { cmd: '.bat', powershell: '.ps1', python: '.py' }[type]
      if (!extension) return sendJson(res, 400, { error: `未知解释器：${type}` })

      const dir = String(body.dir ?? '').trim()
      let name = String(body.name ?? '').trim()
      if (!dir || !name) return sendJson(res, 400, { error: '目录和文件名都要填' })
      if (/[\\/:*?"<>|]/.test(name)) {
        return sendJson(res, 400, { error: '文件名不能包含 \\ / : * ? " < > |' })
      }
      const allowed = { cmd: ['.bat', '.cmd'], powershell: ['.ps1'], python: ['.py'] }[type]
      if (!allowed.some((suffix) => name.toLowerCase().endsWith(suffix))) name += extension

      const target = path.join(dir, name)
      try {
        await fs.mkdir(dir, { recursive: true })
      } catch (error) {
        return sendJson(res, 400, { error: `建不了目录：${error.message}` })
      }

      const exists = await fs
        .stat(target)
        .then(() => true)
        .catch(() => false)
      if (exists && !body.overwrite) {
        return sendJson(res, 409, { error: '同名文件已存在', code: 'exists', path: target })
      }
      let backupPath = null
      let sourceEncoding
      if (exists) {
        // Overwriting an existing script keeps its encoding (a legacy GBK .bat must
        // not silently become UTF-8); new files use the interpreter default.
        try {
          sourceEncoding = (await decodeScript(await fs.readFile(target))).encoding
        } catch (error) {
          return sendJson(res, 400, { error: `读不到原文件：${error.message}` })
        }
        backupPath = await backupFile(target)
      }

      try {
        await writeScript(target, aiPrompts.unwrapScript(body.content), type, sourceEncoding)
      } catch (error) {
        return sendJson(res, 400, { error: `写不了文件：${error.message}` })
      }

      const config = await store.readConfig(root)
      config.ai.lastScriptDir = dir
      config.ai.lastScriptType = type
      // A save outside the configured roots must still show up in the list: adopt
      // the chosen directory (case-insensitive dedupe) and persist it.
      if (!config.scanRoots.some((scanRoot) => library.pathKey(scanRoot) === library.pathKey(dir))) {
        config.scanRoots.push(dir)
      }
      await store.saveConfig(root, config)
      return sendJson(res, 200, { path: target, backupPath, state: await buildState(true) })
    }

    if (route === 'POST /api/ai/apply') {
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { error: '请求体必须是对象' })
      }
      const target = String(body.path ?? '')
      if (!target) return sendJson(res, 400, { error: '缺少 path' })
      if (typeof body.content !== 'string' || !body.content.trim()) {
        return sendJson(res, 400, { error: '缺少脚本内容 content' })
      }
      const type = library.scriptType(target)
      if (!type) return sendJson(res, 400, { error: '不支持写回这个类型的文件' })

      let original
      try {
        original = await decodeScript(await fs.readFile(target))
      } catch (error) {
        return sendJson(res, 400, { error: `读不到原文件：${error.message}` })
      }

      const content = aiPrompts.unwrapScript(body.content)
      let backupPath
      try {
        backupPath = await backupFile(target)
        // Write back in the encoding the file arrived in (GBK stays GBK, etc.).
        await writeScript(target, content, type, original.encoding)
      } catch (error) {
        return sendJson(res, 400, { error: `写回失败：${error.message}` })
      }

      return sendJson(res, 200, {
        path: target,
        backupPath,
        changedLines: countChangedLines(original.text, content),
      })
    }

    return sendJson(res, 404, { error: `未知接口 ${route}` })
  }

  async function serveStatic(res, pathname) {
    const relative = pathname === '/' ? '/index.html' : pathname
    const resolved = path.resolve(distDir, `.${relative}`)
    if (!resolved.startsWith(path.resolve(distDir))) {
      res.writeHead(403).end('forbidden')
      return
    }

    let filePath = resolved
    let content
    try {
      content = await fs.readFile(filePath)
    } catch {
      // SPA fallback: anything unknown serves index.html.
      try {
        filePath = path.join(distDir, 'index.html')
        content = await fs.readFile(filePath)
      } catch {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(MISSING_DIST_PAGE)
        return
      }
    }

    res.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(content)
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (!url.pathname.startsWith('/api/')) {
      serveStatic(res, url.pathname).catch((error) => {
        res.writeHead(500).end(String(error))
      })
      return
    }

    handleApi(req, res, url).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: error.message })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })

  const address = server.address()
  return {
    server,
    port: typeof address === 'object' && address ? address.port : port,
    token,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
