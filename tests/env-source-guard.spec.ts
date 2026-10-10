import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Layer: api. The environment is read in exactly one place (CLAUDE.md hard rule 19): no
// `process.env` anywhere in src/ or worker/ except src/lib/config/env.ts (the client-safe
// half) and env.server.ts (the server-only half), and none in scripts/ except
// scripts/require-env.mjs, the scripts' own fail-loudly reader.

const ROOT = join(__dirname, '..')
const SOURCE = /\.(ts|tsx|mjs|js|cjs)$/
const ALLOWED = new Set(['src/lib/config/env.ts', 'src/lib/config/env.server.ts', 'scripts/require-env.mjs'])

function files(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...files(path))
    else if (SOURCE.test(entry)) out.push(relative(ROOT, join(ROOT, path)))
  }
  return out
}

test('process.env is read only by env.ts, env.server.ts and scripts/require-env.mjs', () => {
  const offenders = ['src', 'worker', 'scripts']
    .flatMap(files)
    .filter((file) => !ALLOWED.has(file))
    .filter((file) => /\bprocess\.env\b/.test(readFileSync(join(ROOT, file), 'utf8')))
  expect(offenders).toEqual([])
})

test('env.server.ts is server-only', () => {
  expect(readFileSync(join(ROOT, 'src/lib/config/env.server.ts'), 'utf8')).toMatch(/^import 'server-only'$/m)
})
