// Shared row helpers: used by the server (API payloads) and the browser bundle
// (instant client-side filtering), so this logic exists once.

const TYPE_LABELS = { cmd: 'BAT', powershell: 'PS1', python: 'PY' }

export function typeLabel(type) {
  return TYPE_LABELS[type] ?? String(type)
}

export function filterRows(view = [], { query = '', tag = '' } = {}) {
  const needle = String(query ?? '').trim().toLowerCase()
  const wanted = String(tag ?? '').trim()
  return view.filter((row) => {
    const tags = row.tags ?? []
    const okQuery = !needle || [row.displayName, row.name, row.path, ...tags].join(' ').toLowerCase().includes(needle)
    const okTag = !wanted || tags.includes(wanted)
    return okQuery && okTag
  })
}

export function allTags(view = []) {
  const tags = new Set()
  for (const row of view) {
    for (const tag of row.tags ?? []) {
      if (tag) tags.add(tag)
    }
  }
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

export function formatLastRun(row) {
  if (!row || !row.lastRunAt) return '—'
  const seconds = row.lastDurationMs == null ? 0 : Number(row.lastDurationMs) / 1000
  return `${row.lastRunAt} · 退出码 ${row.lastExit} · ${seconds.toFixed(1)}s`
}
