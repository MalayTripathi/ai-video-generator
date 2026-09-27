import { createRequire } from 'node:module'
import path from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// The export worker's own environment. It runs outside Next, so it builds its own
// service-role client (never shipped to a browser) and makes no HTTP calls to the app.

export type WorkerDb = SupabaseClient<Database>

export const isProduction = process.env.NODE_ENV === 'production'

/**
 * The ffmpeg binary: FFMPEG_PATH when set (the Docker image sets it to the system ffmpeg),
 * else the ffmpeg-static npm binary for local development. Null when neither exists.
 */
export function ffmpegPath(): string | null {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH
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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for the export worker.')
  return createClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}
