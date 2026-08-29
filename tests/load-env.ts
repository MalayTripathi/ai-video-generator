import { readFileSync } from 'node:fs'
import path from 'node:path'

function loadEnvLocal() {
  const envPath = path.resolve(__dirname, '../.env.local')
  let contents: string
  try {
    contents = readFileSync(envPath, 'utf8')
  } catch {
    return
  }

  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

loadEnvLocal()

// Never let a value left in .env.local from a deliberate manual live run (see
// src/lib/claude.ts's assertLiveCallsAllowed) reach the test-runner process itself.
delete process.env.ALLOW_REAL_CLAUDE
