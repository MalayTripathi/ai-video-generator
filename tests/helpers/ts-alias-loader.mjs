// Node ESM loader hook, used only by tests/ledger.spec.ts's spawned child processes.
// Those processes import src/lib/credits/ledger.ts directly via Node's native TS
// type-stripping (no bundler in the loop), so the `@/*` -> `./src/*` alias that
// tsconfig.json's `paths` defines - understood by TypeScript and Next's bundler, not
// by plain Node - has to be resolved by hand here instead.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const srcRoot = path.resolve(process.cwd(), 'src')

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    let filePath = path.join(srcRoot, specifier.slice(2))
    if (existsSync(filePath + '.ts')) {
      filePath += '.ts'
    } else if (existsSync(filePath + '.tsx')) {
      filePath += '.tsx'
    } else if (existsSync(path.join(filePath, 'index.ts'))) {
      filePath = path.join(filePath, 'index.ts')
    }
    return { url: pathToFileURL(filePath).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
