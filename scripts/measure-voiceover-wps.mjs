#!/usr/bin/env node
// Read-only report: measured spoken words per second for each language / voice, and the
// gaps between spoken spans, from every stored voiceover's alignment (the per-shot spans
// each read's alignment produced, projects.voiceover_spans). The figures behind
// SPOKEN_WORDS_PER_SEC and SHOT_DURATION_PAD_SEC in src/lib/config/shots.ts. Free: it
// reads the database and calls no provider. Run with `node scripts/measure-voiceover-wps.mjs`.

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function env(name) {
  if (process.env[name]) return process.env[name]
  const file = await readFile(join(root, '.env.local'), 'utf8').catch(() => '')
  const line = file.split('\n').find((l) => l.startsWith(`${name}=`))
  return line?.slice(name.length + 1).trim().replace(/^"|"$/g, '') || null
}

const url = await env('NEXT_PUBLIC_SUPABASE_URL')
const key = await env('SUPABASE_SERVICE_ROLE_KEY')
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (or in .env.local).')
  process.exit(1)
}
const supabase = createClient(url, key, { auth: { persistSession: false } })

// The same rule as src/lib/shots/durations.ts: inline audio tags are not spoken words.
const spokenWords = (text) => text.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).filter(Boolean).length

const { data: projects, error } = await supabase
  .from('projects')
  .select('id, language, voice_id, voiceover_source, voiceover_spans')
  .not('voiceover_spans', 'is', null)
if (error) {
  console.error(`Could not list projects: ${error.message}`)
  process.exit(1)
}

const groups = new Map()
const gaps = []
for (const project of projects) {
  const spans = Array.isArray(project.voiceover_spans) ? project.voiceover_spans : []
  const spoken = spans.filter((s) => typeof s.startSec === 'number' && typeof s.endSec === 'number' && s.endSec > s.startSec)
  for (let i = 1; i < spoken.length; i++) gaps.push(spoken[i].startSec - spoken[i - 1].endSec)
  const words = spoken.reduce((n, s) => n + spokenWords(String(s.text ?? '')), 0)
  const seconds = spoken.reduce((n, s) => n + (s.endSec - s.startSec), 0)
  if (seconds <= 0) continue
  const key = `${project.language ?? '?'} / ${project.voiceover_source === 'uploaded' ? 'uploaded' : (project.voice_id ?? '?')}`
  const g = groups.get(key) ?? { reads: 0, words: 0, seconds: 0 }
  g.reads += 1
  g.words += words
  g.seconds += seconds
  groups.set(key, g)
}

console.log(`Voiceovers with spans: ${projects.length}`)
console.log('\nWords per second (language / voice): reads, words, spoken seconds, words per second')
for (const [key, g] of [...groups].sort()) {
  console.log(`  ${key}: ${g.reads}, ${g.words}, ${g.seconds.toFixed(1)}s, ${(g.words / g.seconds).toFixed(2)}`)
}

gaps.sort((a, b) => a - b)
const at = (q) => gaps[Math.min(gaps.length - 1, Math.floor((gaps.length - 1) * q))]
console.log(`\nGaps between spoken spans: ${gaps.length}`)
if (gaps.length > 0) {
  console.log(`  p10 ${at(0.1).toFixed(2)}s, p50 ${at(0.5).toFixed(2)}s, p90 ${at(0.9).toFixed(2)}s, max ${gaps.at(-1).toFixed(2)}s`)
}
