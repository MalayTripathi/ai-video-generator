#!/usr/bin/env node
// Dev-only: copies each VOICEOVER_VOICES entry's ElevenLabs preview clip into
// public/voice-samples/{lang}/{voiceId}.mp3, so auditioning a voice on the Storyboard is a
// static file and never a provider call. Free: listing voices and downloading their
// previews generates nothing. Run with `node scripts/fetch-voice-samples.mjs` after
// changing the voice list in src/lib/config/models.ts.
//
// It also checks each voice is on this account: a library voice that hasn't been added
// resolves nowhere, and generating with it would fail. Such voices are reported loudly
// (and the exit code is non-zero); their samples are still copied from the library.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  const env = await readFile(join(root, '.env.local'), 'utf8').catch(() => '')
  const line = env.split('\n').find((l) => l.startsWith('ELEVENLABS_API_KEY='))
  return line?.slice('ELEVENLABS_API_KEY='.length).trim().replace(/^"|"$/g, '') ?? null
}

// Reads the voice list straight out of models.ts, so the list has one home.
async function voiceList() {
  const source = await readFile(join(root, 'src/lib/config/models.ts'), 'utf8')
  const voices = []
  for (const m of source.matchAll(/voice\('([a-z]+)', '([A-Za-z0-9]+)', '([^']+)'/g)) {
    voices.push({ lang: m[1], id: m[2], name: m[3] })
  }
  return voices
}

async function get(path, key) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, { headers: { 'xi-api-key': key } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function main() {
  const key = await apiKey()
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set (env or .env.local)')
  const voices = await voiceList()
  const missing = []

  for (const voice of voices) {
    const own = await get(`/v1/voices/${voice.id}`, key)
    let previewUrl = own.status === 200 ? own.body?.preview_url : null
    if (own.status !== 200) {
      missing.push(voice)
      const shared = await get(
        `/v1/shared-voices?page_size=100&language=${voice.lang}&search=${encodeURIComponent(voice.name)}`,
        key
      )
      previewUrl = shared.body?.voices?.find((v) => v.voice_id === voice.id)?.preview_url ?? null
    }
    if (!previewUrl) {
      console.error(`✗ ${voice.lang}/${voice.name} (${voice.id}): no preview found`)
      process.exitCode = 1
      continue
    }
    const audio = await fetch(previewUrl)
    if (!audio.ok) {
      console.error(`✗ ${voice.lang}/${voice.name}: preview download failed (${audio.status})`)
      process.exitCode = 1
      continue
    }
    const out = join(root, 'public/voice-samples', voice.lang, `${voice.id}.mp3`)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, Buffer.from(await audio.arrayBuffer()))
    console.log(`✓ ${voice.lang}/${voice.name} -> public/voice-samples/${voice.lang}/${voice.id}.mp3`)
  }

  if (missing.length > 0) {
    console.error(
      `\n! Not on this ElevenLabs account (generation with these fails until added from the Voice Library):\n` +
        missing.map((v) => `  - ${v.lang}/${v.name} (${v.id})`).join('\n')
    )
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
