import { createRequire } from 'node:module'
import path from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { tuningEnv, workerEnv } from '@/lib/config/env.server'

// The export worker's own environment. It runs outside Next, so it builds its own
// service-role client (never shipped to a browser) and makes no HTTP calls to the app.

export type WorkerDb = SupabaseClient<Database>

// Preview and production share production rules (env.ts isProduction); only local renders small.
export { isProduction } from '@/lib/config/env'

/**
 * The ffmpeg binary: FFMPEG_PATH when set (the Docker image sets it to the system ffmpeg),
 * else the ffmpeg-static npm binary for local development. Null when neither exists.
 */
export function ffmpegPath(): string | null {
  const configured = tuningEnv().ffmpegPath
  if (configured) return configured
  try {
    const bin = createRequire(path.join(process.cwd(), 'package.json'))('ffmpeg-static') as string | null
    return bin ?? null
  } catch {
    return null
  }
}

/** Fonts for burned-in captions (the Inter the caption style names). The worker runs from the repo root. */
export const FONTS_DIR = path.resolve(process.cwd(), 'worker', 'fonts')

export function createWorkerClient(): WorkerDb {
  const { url, serviceRoleKey } = workerEnv().supabase
  return createClient<Database>(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
}
