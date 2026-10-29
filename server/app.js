// Development entry: launched by ScriptManager.bat. Resolves the repo root and
// hands startup to start.js (the packaged exe uses the same start.js).

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from './start.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

await start({
  root,
  distDir: path.join(root, 'web', 'dist'),
  argv: process.argv.slice(2),
})
