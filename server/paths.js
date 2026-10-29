// Windows paths are case-insensitive; metadata and lookups key off the lowercase form.

export function pathKey(filePath) {
  return String(filePath).toLowerCase()
}
