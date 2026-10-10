import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ALLOW_FLAG, BLOCK_PROVIDER_CALLS } from '../src/lib/providers/live-call-guard'
import { RUN_GUARD_ENV } from './run-guard/guard'

// Turns env drift into a test failure: every env var read anywhere in the code must be
// listed in .env.example with a one-line purpose above it, and every var listed there must
// be read by something (CLAUDE.md hard rule 19). A source-level scan, like enums-drift.

const ROOT = join(__dirname, '..')
const SCAN_DIRS = ['src', 'scripts', 'tests']
const ROOT_FILES = ['playwright.config.ts', 'next.config.ts', 'eslint.config.mjs', 'postcss.config.mjs']
const SOURCE = /\.(ts|tsx|mjs|js|cjs)$/
const SKIP = new Set([relative(ROOT, __filename), 'src/lib/database.types.ts'])

// Provided by the platform or the test runner, never set by us.
const PLATFORM = new Set(['NODE_ENV', 'CI', 'TEST_WORKER_INDEX', 'NEXT_RUNTIME'])
const PLATFORM_PREFIXES = ['VERCEL_']
// Read by a provider SDK from the environment, not by our code.
const SDK_READ = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
// Set by our own code for a child process it spawns; never configured by a person.
const SET_BY_CODE = new Set(['PRE_ARGS', RUN_GUARD_ENV.CHILD])

// Files that read env through a computed key. Each names where its names come from; a new
// computed-key reader fails below until it is registered here.
const INDIRECT_READERS: Record<string, string[]> = {
  'src/lib/providers/live-call-guard.ts': [BLOCK_PROVIDER_CALLS, ...Object.values(ALLOW_FLAG)],
  'playwright.config.ts': Object.values(RUN_GUARD_ENV),
  // ALLOW_REAL_* prefix scan - the names are ALLOW_FLAG's, above.
  'tests/global-setup.ts': Object.values(ALLOW_FLAG),
  // Writes .env.local into process.env; reads nothing by name.
  'tests/load-env.ts': [],
  // Save and restore keys around a test (or copy env into a child); no new names.
  'tests/provider-block.spec.ts': [],
  'tests/service-role-client.spec.ts': [],
  // An env(name) helper; its names are collected by the env('X') pattern.
  'scripts/backfill-voiceover-words.mjs': [],
  'scripts/cleanup-test-data.mjs': [],
  'scripts/measure-voiceover-wps.mjs': [],
}

const NAME = '[A-Z][A-Z0-9_]*'
const READ_PATTERNS = [
  new RegExp(`process\\.env\\.(${NAME})`, 'g'),
  new RegExp(`process\\.env\\[\\s*['"\`](${NAME})['"\`]\\s*\\]`, 'g'),
  // An injected env param (live-call-guard's `env.NODE_ENV`) and the scripts' env('X').
  new RegExp(`\\benv\\.(${NAME})\\b`, 'g'),
  new RegExp(`\\benv\\(\\s*['"](${NAME})['"]\\s*\\)`, 'g'),
]
const DESTRUCTURE = /\{([^}]*)\}\s*=\s*process\.env\b/g
const COMPUTED_KEY = /\b(?:process\.)?env\[\s*(?!['"`])/

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (SOURCE.test(entry)) out.push(relative(ROOT, full))
    }
  }
  SCAN_DIRS.forEach((d) => walk(join(ROOT, d)))
  return [...out, ...ROOT_FILES].filter((f) => !SKIP.has(f))
}

function scan(): { read: Map<string, string>; unregistered: string[] } {
  const read = new Map<string, string>()
  const unregistered: string[] = []
  const note = (name: string, file: string) => {
    if (!read.has(name)) read.set(name, file)
  }
  for (const file of sourceFiles()) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    for (const pattern of READ_PATTERNS) for (const m of text.matchAll(pattern)) note(m[1], file)
    for (const m of text.matchAll(DESTRUCTURE)) {
      for (const part of m[1].split(',')) {
        const name = part.split(':')[0].replace('...', '').trim()
        if (new RegExp(`^${NAME}$`).test(name)) note(name, file)
      }
    }
    if (COMPUTED_KEY.test(text)) {
      if (file in INDIRECT_READERS) INDIRECT_READERS[file].forEach((name) => note(name, file))
      else unregistered.push(file)
    }
  }
  return { read, unregistered }
}

type ExampleVar = { name: string; line: number; documented: boolean }

// A var is listed as `NAME=value`, or `# NAME=value` when optional and unset. The line
// above its first listing must be a comment that is not itself a listing - its purpose.
function exampleVars(): ExampleVar[] {
  const lines = readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n')
  const listing = new RegExp(`^(?:#\\s*)?(${NAME})=`)
  const seen = new Set<string>()
  const vars: ExampleVar[] = []
  lines.forEach((line, i) => {
    const m = line.match(listing)
    if (!m || seen.has(m[1])) return
    seen.add(m[1])
    const above = i > 0 ? lines[i - 1] : ''
    vars.push({ name: m[1], line: i + 1, documented: above.startsWith('#') && !listing.test(above) })
  })
  return vars
}

const isPlatform = (name: string) => PLATFORM.has(name) || PLATFORM_PREFIXES.some((p) => name.startsWith(p))

test.describe('env drift: code vs .env.example', () => {
  test('every computed-key env reader is registered', () => {
    expect(scan().unregistered, 'register the file in INDIRECT_READERS with the names it reads').toEqual([])
  })

  test('every env var the code reads is listed in .env.example', () => {
    const listed = new Set(exampleVars().map((v) => v.name))
    const missing = [...scan().read.entries()]
      .filter(([name]) => !listed.has(name) && !isPlatform(name) && !SET_BY_CODE.has(name))
      .map(([name, file]) => `${name} (read in ${file})`)
    expect(missing).toEqual([])
  })

  test('every var in .env.example is read by something', () => {
    const { read } = scan()
    const unread = exampleVars()
      .map((v) => v.name)
      .filter((name) => !read.has(name) && !SDK_READ.has(name))
    expect(unread).toEqual([])
  })

  test('every var in .env.example has a one-line purpose directly above it', () => {
    const undocumented = exampleVars()
      .filter((v) => !v.documented)
      .map((v) => `${v.name} (line ${v.line})`)
    expect(undocumented).toEqual([])
  })
})
