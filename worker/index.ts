import { existsSync } from 'node:fs'
import path from 'node:path'
import { claimNext, failStuck } from './claim'
import { createWorkerClient, ffmpegPath, FONTS_DIR, isProduction } from './config'
import { runJob } from './job'
import { runWorkerLoop } from './poll'

// The export worker: a standalone Node service (worker/Dockerfile in production, `npm run
// worker` locally). Wait-and-watch - it polls for a queued export, claims it atomically,
// renders it, and settles the row; the page polls the row. One job at a time. The poll
// schedule (idle backoff, stuck sweep cadence) lives in poll.ts.

const envFile = path.resolve(process.cwd(), '.env.local')
if (!isProduction && existsSync(envFile)) process.loadEnvFile(envFile)

async function main() {
  const ffmpeg = ffmpegPath()
  if (!ffmpeg) throw new Error('No ffmpeg: set FFMPEG_PATH, or install the ffmpeg-static dev dependency.')
  const db = createWorkerClient()
  const fontsDir = existsSync(FONTS_DIR) ? FONTS_DIR : null
  console.log(`[export] worker started (${isProduction ? 'production' : 'development'}), ffmpeg at ${ffmpeg}`)
  let stopping = false
  // An idle sleep can now be a minute long; a stop signal cuts it short so shutdown stays prompt.
  let wake: (() => void) | null = null
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      stopping = true
      wake?.()
    })
  await runWorkerLoop({
    claimNext: () => claimNext(db),
    failStuck: () => failStuck(db),
    runJob: (row) => runJob(db, row, { ffmpeg, fontsDir, isProduction }),
    now: Date.now,
    sleep,
    shouldStop: () => stopping,
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
