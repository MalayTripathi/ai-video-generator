#!/usr/bin/env node
// One-off: fills projects.voiceover_words for every current voiceover that settled before
// the column existed, from its stored alignment file - the same rule the voiceover workers
// run at settle (wordsFromStoredAlignment in src/lib/storyboard/motion.ts, loaded through
// jiti so the rule has one home). Free: it reads Storage and writes one column, and never
// calls a provider. Idempotent - only rows whose column is still null are touched.
// Run with `node scripts/backfill-voiceover-words.mjs`.

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
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

const jiti = createJiti(import.meta.url, { alias: { '@': join(root, 'src') } })
const { wordsFromStoredAlignment } = await jiti.import(join(root, 'src/lib/storyboard/motion.ts'))

const supabase = createClient(url, key, { auth: { persistSession: false } })
const { data: projects, error } = await supabase
  .from('projects')
  .select('id, voiceover_alignment_path')
  .not('audio_path', 'is', null)
  .not('voiceover_alignment_path', 'is', null)
  .is('voiceover_words', null)
if (error) {
  console.error(`Could not list projects: ${error.message}`)
  process.exit(1)
}

let filled = 0
let failed = 0
for (const project of projects) {
  const { data: file, error: downloadError } = await supabase.storage.from('artifacts').download(project.voiceover_alignment_path)
  const words = file && !downloadError ? wordsFromStoredAlignment(await file.text()) : null
  if (!words) {
    failed++
    console.error(`[backfill] ${project.id}: alignment unreadable (${downloadError?.message ?? 'malformed'}) - left null`)
    continue
  }
  const { error: updateError } = await supabase
    .from('projects')
    .update({ voiceover_words: words })
    .eq('id', project.id)
    .is('voiceover_words', null)
  if (updateError) {
    failed++
    console.error(`[backfill] ${project.id}: ${updateError.message}`)
    continue
  }
  filled++
}

console.log(`[backfill] ${projects.length} voiceover(s) without word boundaries: ${filled} filled, ${failed} left null.`)
process.exit(failed > 0 ? 1 : 0)
