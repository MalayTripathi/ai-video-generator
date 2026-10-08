import { spawn } from 'node:child_process'

// Runs ffmpeg as a child process: no shell, arguments as an array. Progress is read from
// `-progress pipe:1` (out_time_us), errors from stderr.

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string
  ) {
    super(message)
    this.name = 'FfmpegError'
  }
}

export function runFfmpeg(
  bin: string,
  args: string[],
  opts: { onOutTimeSec?: (sec: number) => void } = {}
): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const withProgress = opts.onOutTimeSec ? ['-progress', 'pipe:1', '-nostats'] : []
    const child = spawn(bin, ['-hide_banner', '-y', ...withProgress, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let buffer = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      // Keep the tail only; loudnorm's JSON and any error are at the end.
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (!opts.onOutTimeSec) return
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line)
        if (match) opts.onOutTimeSec(Number(match[1]) / 1e6)
      }
    })
    child.on('error', (err) => reject(new FfmpegError(`ffmpeg could not start: ${err.message}`, stderr)))
    child.on('close', (code) => {
      if (code === 0) resolve({ stderr })
      else reject(new FfmpegError(`ffmpeg exited with code ${code}`, stderr))
    })
  })
}

export type ProbeResult = { width: number | null; height: number | null; durationSec: number | null; hasAudio: boolean }

/** Reads a media file's size, duration and whether it has audio, from `ffmpeg -i`'s banner. */
export async function probe(bin: string, file: string): Promise<ProbeResult> {
  const stderr = await new Promise<string>((resolve) => {
    const child = spawn(bin, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let out = ''
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('close', () => resolve(out))
    child.on('error', () => resolve(out))
  })
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const video = /Stream #[^\n]*Video:[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(stderr)
  return {
    width: video ? Number(video[1]) : null,
    height: video ? Number(video[2]) : null,
    durationSec: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
    hasAudio: /Stream #[^\n]*Audio:/.test(stderr),
  }
}
