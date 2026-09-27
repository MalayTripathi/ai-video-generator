import { existsSync } from 'node:fs'
import path from 'node:path'
import { EXPORT_POLL_MS } from '@/lib/config/export'
import { claimNext, failStuck } from './claim'
import { createWorkerClient, ffmpegPath, FONTS_DIR, isProduction } from './config'
import { runJob } from './job'

// The export worker: a standalone Node service (worker/Dockerfile in production, `npm run
// worker` locally). Wait-and-watch - it polls for a queued export, claims it atomically,
// renders it, and settles the row; the page polls the row. One job at a time.

const envFile = path.resolve(process.cwd(), '.env.local')
if (!isProduction && existsSync(envFile)) process.loadEnvFile(envFile)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const ffmpeg = ffmpegPath()
  if (!ffmpeg) throw new Error('No ffmpeg: set FFMPEG_PATH, or install the ffmpeg-static dev dependency.')
  const db = createWorkerClient()
  const fontsDir = existsSync(FONTS_DIR) ? FONTS_DIR : null
  console.log(`[export] worker started (${isProduction ? 'production' : 'development'}), ffmpeg at ${ffmpeg}`)
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => (stopping = true))
  while (!stopping) {
    try {
      const stuck = await failStuck(db)
      if (stuck.length > 0) console.warn('[export] marked stuck exports failed', stuck)
      const row = await claimNext(db)
      if (row) {
        console.log('[export] rendering', row.id)
        const result = await runJob(db, row, { ffmpeg, fontsDir, isProduction })
        console.log('[export]', result, row.id)
        continue
      }
    } catch (err) {
      console.error('[export] poll failed', err instanceof Error ? err.message : err)
    }
    await sleep(EXPORT_POLL_MS)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
