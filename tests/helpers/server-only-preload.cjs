/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS, loaded by node --require */
// Preloaded (node --require) into the Playwright runner and its workers. Specs import
// server modules (env.server.ts, models.server.ts, ...) that start with `import 'server-only'`,
// a package that throws in plain Node unless the "react-server" export condition is set.
// That condition can't be set for the suite: it also swaps React for its server build, and
// specs that import client components would break. So `server-only` alone resolves to its
// own empty module here - the same file the condition would pick. Next's bundler still fails
// a client import of a server-only module at build; this changes nothing outside tests.
const Module = require('node:module')
const path = require('node:path')

const EMPTY = path.resolve(__dirname, '../../node_modules/server-only/empty.js')
const resolveFilename = Module._resolveFilename

Module._resolveFilename = function (request, ...rest) {
  if (request === 'server-only') return EMPTY
  return resolveFilename.call(this, request, ...rest)
}
