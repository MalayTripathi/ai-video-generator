import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Vercel Hobby runs a function for at most 300s and rejects a deploy whose route asks for
// more. Next reads segment config statically, so the value must also be a plain numeric
// literal in the route file itself - a constant or expression is not honoured.

const HOBBY_MAX_DURATION_S = 300
const APP_DIR = path.resolve(__dirname, '../src/app')
const LITERAL = /^export const maxDuration = (\d+)\s*;?\s*$/

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return routeFiles(full)
    return /^route\.(ts|tsx|js|mjs)$/.test(entry.name) ? [full] : []
  })
}

test.describe('route maxDuration guard', () => {
  test('finds the route files', () => {
    expect(routeFiles(APP_DIR).length).toBeGreaterThan(0)
  })

  for (const file of routeFiles(APP_DIR)) {
    const rel = path.relative(APP_DIR, file)
    test(`${rel} exports one literal maxDuration <= ${HOBBY_MAX_DURATION_S}`, () => {
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /\bexport\b/.test(line) && /\bmaxDuration\b/.test(line))
      expect(lines, 'exactly one maxDuration export').toHaveLength(1)
      const match = lines[0].match(LITERAL)
      expect(match, `not a numeric literal: ${lines[0].trim()}`).not.toBeNull()
      expect(Number(match![1])).toBeGreaterThan(0)
      expect(Number(match![1])).toBeLessThanOrEqual(HOBBY_MAX_DURATION_S)
    })
  }
})
