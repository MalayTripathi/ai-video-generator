import { test, expect } from '@playwright/test'
import type Anthropic from '@anthropic-ai/sdk'
import { AGENT_TOOLS } from '../src/lib/prompts/agent'
import { buildWriteShotsTool } from '../src/lib/prompts/shot-generation'
import { buildDeriveCameraTool, CAMERA_FIELD_NAMES } from '../src/lib/prompts/camera-derivation'
import { WRITE_PROMPTS_TOOL } from '../src/app/api/projects/[id]/prompts/logic'

// The Anthropic API's tool `input_schema` accepts only a subset of JSON Schema - see
// platform.claude.com/docs/en/build-with-claude/structured-outputs, "JSON Schema
// limitations" (explicitly stated to cover strict tool use). Verbatim:
//   Supported: ... Array `minItems` (only values 0 and 1 supported)
//   Not supported: ... Array constraints beyond `minItems` of 0 or 1 ... `minimum`,
//   `maximum`, `multipleOf` ... `minLength`, `maxLength`
// This is an ALLOWLIST (per the task this test was written for) rather than a denylist -
// a denylist only ever covers keywords already known to fail; a new unsupported keyword
// introduced later fails this test by name instead of surfacing as a live 400.
const ALLOWED_KEYS = new Set([
  'type',
  'properties',
  'items',
  'required',
  'enum',
  'const',
  'additionalProperties',
  'anyOf',
  'allOf',
  '$ref',
  '$def',
  'definitions',
  'default',
  'description',
  'minItems',
])

type Violation = { path: string; key: string }

// A JSON Schema object's OWN keys are vocabulary keywords (checked against the
// allowlist). But the value under `properties`/`$def`/`definitions` is a map from an
// arbitrary, caller-chosen name to a nested schema - those names are data, not keywords,
// and must never be checked against the allowlist themselves; only their nested schema
// values get walked.
function walkSchema(schema: unknown, path: string, violations: Violation[]): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return

  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!ALLOWED_KEYS.has(key)) {
      violations.push({ path: path || '(root)', key })
      continue
    }
    const childPath = path ? `${path}.${key}` : key

    if (key === 'minItems') {
      if (value !== 0 && value !== 1) {
        violations.push({ path: childPath, key: `minItems=${String(value)} (only 0 or 1 supported)` })
      }
      continue
    }
    if (key === 'properties' || key === '$def' || key === 'definitions') {
      if (value !== null && typeof value === 'object') {
        for (const [name, nested] of Object.entries(value as Record<string, unknown>)) {
          walkSchema(nested, `${childPath}.${name}`, violations)
        }
      }
      continue
    }
    if (key === 'items') {
      walkSchema(value, childPath, violations)
      continue
    }
    if (key === 'anyOf' || key === 'allOf') {
      if (Array.isArray(value)) {
        value.forEach((sub, i) => walkSchema(sub, `${childPath}[${i}]`, violations))
      }
      continue
    }
    // enum / const / required / additionalProperties / default / description / type /
    // $ref: scalars or arrays of scalars in every schema this repo defines - nothing
    // further to recurse into.
  }
}

function assertSchemaIsClean(tool: Anthropic.Tool) {
  const violations: Violation[] = []
  walkSchema(tool.input_schema, '', violations)
  expect(
    violations,
    violations.map((v) => `${tool.name}: unsupported keyword "${v.key}" at ${v.path}`).join('\n')
  ).toEqual([])
}

test.describe('tool input_schema keyword allowlist', () => {
  for (const tool of AGENT_TOOLS) {
    test(`${tool.name} uses only API-supported JSON Schema keywords`, () => {
      assertSchemaIsClean(tool)
    })
  }

  test('write_shots uses only API-supported JSON Schema keywords', () => {
    assertSchemaIsClean(buildWriteShotsTool(6))
  })

  test('derive_camera uses only API-supported JSON Schema keywords', () => {
    assertSchemaIsClean(buildDeriveCameraTool([...CAMERA_FIELD_NAMES]))
  })

  test('write_prompts uses only API-supported JSON Schema keywords', () => {
    assertSchemaIsClean(WRITE_PROMPTS_TOOL)
  })
})
