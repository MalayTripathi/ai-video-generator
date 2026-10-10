import { existsSync } from 'node:fs'
import path from 'node:path'
import { validateAtBoot } from '@/lib/config/env'

// The export worker: a standalone Node service (worker/Dockerfile in production, `npm run
// worker` locally). This file only boots it: load .env.local when present, validate the
// environment, and only then load the worker itself. Static imports are hoisted and would
// evaluate env-reading modules before the file load, so the worker is a dynamic import.
//
// The load cannot depend on APP_ENV - APP_ENV lives in that file. A deployed host has no
// .env.local and supplies every var through its own environment, which is validated the
// same way; a stray .env.local on a host would never override a var the host already set
// (process.loadEnvFile keeps existing values).

const envFile = path.resolve(process.cwd(), '.env.local')
if (existsSync(envFile)) process.loadEnvFile(envFile)

try {
  validateAtBoot('worker')
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}

import('./main')
  .then(({ main }) => main())
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
