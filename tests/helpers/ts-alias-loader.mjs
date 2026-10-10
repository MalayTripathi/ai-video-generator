// Node ESM loader hook, used only by tests/ledger.spec.ts's spawned child processes.
// Those processes import src/lib/credits/ledger.ts directly via Node's native TS
// type-stripping (no bundler in the loop), so the `@/*` -> `./src/*` alias that
// tsconfig.json's `paths` defines - understood by TypeScript and Next's bundler, not
// by plain Node - has to be resolved by hand here instead.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const srcRoot = path.resolve(process.cwd(), 'src')
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'])

function withTsExtension(filePath) {
  if (existsSync(filePath + '.ts')) return filePath + '.ts'
  if (existsSync(filePath + '.tsx')) return filePath + '.tsx'
  if (existsSync(path.join(filePath, 'index.ts'))) return path.join(filePath, 'index.ts')
  return filePath
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const filePath = withTsExtension(path.join(srcRoot, specifier.slice(2)))
    return { url: pathToFileURL(filePath).href, shortCircuit: true }
  }
  // An extensionless relative import between .ts sources (`./motion`), which the bundler
  // resolves and plain Node does not.
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
    // `./env.server` is extensionless too: only a real code extension counts.
    if (!CODE_EXTENSIONS.has(path.extname(base)) && !existsSync(base)) {
      const filePath = withTsExtension(base)
      if (filePath !== base) return { url: pathToFileURL(filePath).href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
