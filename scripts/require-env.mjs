// The one env reader for scripts/ (they run under plain Node, outside src/lib/config/env.ts).
// A var comes from the shell first, then .env.local. A required var that is missing or
// empty throws, naming it - a script never runs on a fallback.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENV_LOCAL = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local')

function fromEnvLocal(name) {
  let file = ''
  try {
    file = readFileSync(ENV_LOCAL, 'utf8')
  } catch {
    return undefined
  }
  const line = file.split('\n').find((l) => l.startsWith(`${name}=`))
  return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '')
}

/** The var's value, or undefined when it is unset or empty in both places. */
export function optionalEnv(name) {
  const value = process.env[name] || fromEnvLocal(name)
  return value ? value : undefined
}

/** The var's value; throws naming it when it is unset or empty. */
export function requireEnv(name) {
  const value = optionalEnv(name)
  if (!value) throw new Error(`Missing required env var ${name} (set it in the shell or .env.local)`)
  return value
}
