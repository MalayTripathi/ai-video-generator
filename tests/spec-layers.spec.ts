import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { API_SPECS, UI_SPECS } from './spec-layers'

// Layer: api. Keeps tests/spec-layers.ts honest: every spec runs in exactly one project,
// and an `api` spec never asks for a fixture that launches a browser.

const TESTS_DIR = __dirname
const specs = readdirSync(TESTS_DIR).filter((name) => name.endsWith('.spec.ts'))
// A destructured fixture list naming page/context/browser, including across lines.
const BROWSER_FIXTURE = /\(\s*\{[^}]*\b(page|context|browser)\b[^}]*\}/

test('every spec declares exactly one layer', () => {
  const ui = new Set<string>(UI_SPECS)
  const api = new Set<string>(API_SPECS)
  expect(specs.filter((spec) => !ui.has(spec) && !api.has(spec)), 'specs with no layer').toEqual([])
  expect(specs.filter((spec) => ui.has(spec) && api.has(spec)), 'specs in both layers').toEqual([])
  expect([...ui, ...api].filter((spec) => !specs.includes(spec)), 'listed specs that do not exist').toEqual([])
})

test('no api spec requests a browser fixture', () => {
  const offenders = API_SPECS.filter((spec) => BROWSER_FIXTURE.test(readFileSync(path.join(TESTS_DIR, spec), 'utf8')))
  expect(offenders).toEqual([])
})
