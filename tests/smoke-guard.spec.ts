import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { PROTECTED_SMOKE, SMOKE_SIZE } from './smoke-manifest'

// Layer: api. Keeps the @smoke set (npm run test:smoke) honest: a bounded size, and every
// protected operation in tests/smoke-manifest.ts still covered by a tagged test. Lists
// the tagged set through Playwright itself, so the tag is what counts, not a text match.

type ListedSuite = { specs?: { title: string; file: string; tags: string[] }[]; suites?: ListedSuite[] }

function listSmoke(): { file: string; title: string }[] {
  const out = execFileSync('npx', ['playwright', 'test', '--list', '--grep', '@smoke', '--reporter=json'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const report = JSON.parse(out) as { suites: ListedSuite[] }
  const found: { file: string; title: string }[] = []
  const walk = (suite: ListedSuite) => {
    for (const spec of suite.specs ?? []) {
      // The JSON reporter lists tags without their leading '@'.
      if (spec.tags.includes('smoke')) found.push({ file: path.basename(spec.file), title: spec.title })
    }
    for (const child of suite.suites ?? []) walk(child)
  }
  report.suites.forEach(walk)
  return found
}

test('the @smoke set stays bounded and covers every protected operation', { tag: '@smoke' }, () => {
  const smoke = listSmoke()
  expect(smoke.length).toBeGreaterThanOrEqual(SMOKE_SIZE.min)
  expect(smoke.length).toBeLessThanOrEqual(SMOKE_SIZE.max)

  const tagged = new Set(smoke.map((entry) => `${entry.file} :: ${entry.title}`))
  const missing = Object.entries(PROTECTED_SMOKE).flatMap(([operation, members]) =>
    members.filter((m) => !tagged.has(`${m.file} :: ${m.title}`)).map((m) => `${operation}: ${m.file} :: ${m.title}`)
  )
  expect(missing, 'protected operations without their @smoke test').toEqual([])
})
