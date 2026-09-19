import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Source-level guard, not a runtime check. What this closes: Task 5 made
// attemptId/recordTurnSpend (and now, Task 6, recordFixedSpend) REQUIRED params with
// no default on runAgentTurn/runShotGeneration/runCameraDerivation, so tsc already
// catches a route that DROPS them entirely. What tsc cannot catch is a route that
// KEEPS the params but wires one to a type-compatible wrong function (a same-shape
// no-op or stub) - the suite would stay green and production would silently stop
// billing. This file catches exactly that, by asserting the real identifier from
// credits/ledger.ts sits in the actual call-site deps position, not merely present
// somewhere in the file (a dead/unused import must not satisfy it).
//
// Approach considered and rejected: a runtime identity check (import the route module
// in a child process under `--conditions=react-server`, compare function references
// directly). This was verified working this session, but only after adding
// --experimental-transform-types (Node's default type-stripping can't handle real
// transitively-imported TS syntax like constructor parameter properties) plus two new
// resolver rules to the SHARED tests/helpers/ts-alias-loader.mjs (next/server and
// next/headers need explicit .js extensions; relative extensionless imports need
// resolving). Rejected per explicit direction: an experimental Node flag and extra
// rules in a loader every spec depends on is more risk than this one gate is worth.
// Do not "improve" this back to that - the source-level guard below is what lands.
//
// Known gap, stated plainly: this cannot catch a same-named local shadow of an
// imported binding (`const recordFixedSpend = stub` overriding the import). That is
// not a realistic mutation in this codebase's module style - redeclaring a top-level
// const with the same name as an import binding is a SyntaxError, not a silent shadow.

const repoRoot = path.resolve(__dirname, '..')

function read(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), 'utf8')
}

// Strips comments before matching, so a comment mentioning the real identifier's name
// can never satisfy a check that must be about actual code.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

// Locates `fnName(` and walks forward counting paren depth to isolate exactly that
// call's argument block - not a regex-based paren balance, a plain index-and-depth
// loop, so nested object literals/arrow functions inside the call don't confuse it.
function extractCallBlock(source: string, fnName: string): string {
  const marker = `${fnName}(`
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`${marker} not found`)
  let i = start + marker.length
  let depth = 1
  const blockStart = i
  while (depth > 0) {
    if (source[i] === '(') depth++
    else if (source[i] === ')') depth--
    i++
  }
  return source.slice(blockStart, i - 1)
}

function importLine(source: string, fromModule: string): string {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${fromModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`)
  const match = stripComments(source).match(re)
  return match ? match[1] : ''
}

test.describe('wiring-identity - source-level guard against a type-compatible wrong function', () => {
  test('agent/route.ts wires the real mintAttemptId/recordDynamicSpend into runAgentTurn', () => {
    const source = read('src/app/api/projects/[id]/agent/route.ts')
    const imported = importLine(source, '@/lib/credits/ledger')
    expect(imported).toMatch(/\bmintAttemptId\b/)
    expect(imported).toMatch(/\brecordDynamicSpend\b/)

    const block = stripComments(extractCallBlock(source, 'runAgentTurn'))
    expect(block).toMatch(/\battemptId:\s*mintAttemptId\(\)/)
    expect(block).toMatch(/\brecordTurnSpend:\s*recordDynamicSpend\b/)
    // The Step 3 turn-level balance gate reads the real balance, never a stand-in.
    const balanceImports = importLine(source, '@/lib/credits/balance')
    expect(balanceImports).toMatch(/\bgetBalance\b/)
    expect(block).toMatch(/(^|[,{\s])getBalance(\s*[,}]|\s*$)/)
  })

  test('shots/route.ts wires the real mintAttemptId/recordFixedSpend into runShotGeneration', () => {
    const source = read('src/app/api/projects/[id]/shots/route.ts')
    const imported = importLine(source, '@/lib/credits/ledger')
    expect(imported).toMatch(/\bmintAttemptId\b/)
    expect(imported).toMatch(/\brecordFixedSpend\b/)

    const block = stripComments(extractCallBlock(source, 'runShotGeneration'))
    expect(block).toMatch(/\battemptId:\s*mintAttemptId\(\)/)
    // Shorthand property - the imported name IS the param name here.
    expect(block).toMatch(/(^|[,{\s])recordFixedSpend(\s*[,}]|\s*$)/)
  })

  test('camera/route.ts wires the real mintAttemptId/recordFixedSpend into runCameraDerivation', () => {
    const source = read('src/app/api/projects/[id]/shots/[shotId]/camera/route.ts')
    const imported = importLine(source, '@/lib/credits/ledger')
    expect(imported).toMatch(/\bmintAttemptId\b/)
    expect(imported).toMatch(/\brecordFixedSpend\b/)

    const block = stripComments(extractCallBlock(source, 'runCameraDerivation'))
    expect(block).toMatch(/\battemptId:\s*mintAttemptId\(\)/)
    expect(block).toMatch(/(^|[,{\s])recordFixedSpend(\s*[,}]|\s*$)/)
  })

  test('elements/[elementId]/reference/generate/route.ts wires the real mintAttemptId/recordFixedSpend into runElementReferenceGeneration', () => {
    const source = read('src/app/api/projects/[id]/elements/[elementId]/reference/generate/route.ts')
    const imported = importLine(source, '@/lib/credits/ledger')
    expect(imported).toMatch(/\bmintAttemptId\b/)
    expect(imported).toMatch(/\brecordFixedSpend\b/)

    const block = stripComments(extractCallBlock(source, 'runElementReferenceGeneration'))
    expect(block).toMatch(/\battemptId:\s*mintAttemptId\(\)/)
    // Shorthand property - the imported name IS the param name here.
    expect(block).toMatch(/(^|[,{\s])recordFixedSpend(\s*[,}]|\s*$)/)
  })

  // The exception: the agent's regenerate_all_shots tool must NOT wire the real
  // recordFixedSpend - its cost is already folded into the turn's dynamic agent_turn
  // charge (Task 5), and double-wiring here would double-bill the same Claude call.
  // This asserts the opposite of the three checks above: BILLED_BY_TURN, not the real
  // function, sits in the deps position.
  test('agent/tools.ts wires BILLED_BY_TURN, not the real recordFixedSpend, into its runShotGeneration call', () => {
    const source = read('src/app/api/projects/[id]/agent/tools.ts')
    const imported = importLine(source, '@/app/api/projects/[id]/shots/logic')
    expect(imported).toMatch(/\bBILLED_BY_TURN\b/)

    const block = stripComments(extractCallBlock(source, 'runShotGeneration'))
    expect(block).toMatch(/\brecordFixedSpend:\s*BILLED_BY_TURN\b/)
    // The real writer must never appear as the value here - only as the sentinel name
    // ('recordFixedSpend' itself never occurs standalone in this block, only as the
    // param key on the left of ':').
    expect(block).not.toMatch(/:\s*recordFixedSpend\b/)
  })

  // Same exception for Step 3's two regeneration tools: their nested
  // write_image_prompts call is billed inside the turn's agent_turn charge.
  test('agent/tools-image-prompts.ts wires BILLED_BY_TURN, not the real recordFixedSpend, into its runImagePromptGeneration call', () => {
    const source = read('src/app/api/projects/[id]/agent/tools-image-prompts.ts')
    const imported = importLine(source, '@/app/api/projects/[id]/shots/logic')
    expect(imported).toMatch(/\bBILLED_BY_TURN\b/)

    const block = stripComments(extractCallBlock(source, 'runImagePromptGeneration'))
    expect(block).toMatch(/\brecordFixedSpend:\s*BILLED_BY_TURN\b/)
    expect(block).not.toMatch(/:\s*recordFixedSpend\b/)
  })
})
