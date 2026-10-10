import 'server-only'
import { parseEnv, parseImageQualityDevCap, parseAppEnv, parseTuning, type NextEnv, type TuningEnv, type WorkerEnv } from './env'

// Server-only reads of the environment. Each accessor re-parses the live process env on
// every call (cheap, and a malformed value can never be served from a stale snapshot); the
// boot check in env.ts has already run the same parse once, so in a running server these
// never throw unless the env was changed underneath it.

/** The full app config. */
export function serverEnv(): NextEnv {
  return parseEnv(process.env, 'next').env
}

/** The export worker's config - no provider keys or continuation secret. */
export function workerEnv(): WorkerEnv {
  return parseEnv(process.env, 'worker').env
}

/** Class D tuning only, for modules shared by the app and the export worker. */
export function tuningEnv(): TuningEnv {
  return parseTuning(process.env)
}

/** The image quality cap, null on production (class C). */
export function imageQualityDevCap() {
  return parseImageQualityDevCap(process.env, parseAppEnv(process.env))
}

/**
 * The live-call guard's inputs, read at call time: the kill switch, the developer opt-ins
 * (class E) and APP_ENV. Raw strings - the guard keeps its own semantics for them.
 */
export function providerGuardEnv(): Record<string, string | undefined> {
  return {
    APP_ENV: process.env.APP_ENV,
    BLOCK_PROVIDER_CALLS: process.env.BLOCK_PROVIDER_CALLS,
    ALLOW_REAL_CLAUDE: process.env.ALLOW_REAL_CLAUDE,
    ALLOW_REAL_OPENAI_IMAGES: process.env.ALLOW_REAL_OPENAI_IMAGES,
    ALLOW_REAL_ELEVENLABS: process.env.ALLOW_REAL_ELEVENLABS,
  }
}
