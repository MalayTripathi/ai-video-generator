#!/usr/bin/env node
// One-off: removes data test runs left behind. Dry run by default - prints every group with
// counts and paths and deletes nothing. Scoped strictly to test identities: the fixed users
// (pw-fixed-*@reelcraft.local) and minted users (pw-test-*@reelcraft.local). A non-test
// user's rows and files are never touched, even when orphaned.
//
//   node scripts/cleanup-test-data.mjs                 dry run
//   node scripts/cleanup-test-data.mjs --apply         delete groups A-C
//   ... --apply --include-deleted-owners               also group D (owner no longer exists)
//   ... --apply --include-user=<id>                    also delete that one listed non-pool user
//
// Groups:
//   A  minted accounts that signed in (orphaned by a killed run) + their projects + files
//   B  fixed-user storage folders with no matching project row
//   C  live minted users' storage folders with no matching project row
//   D  storage prefixes whose owner no longer exists in auth (identity unprovable: opt-in)
//   kept: never-signed-in minted accounts (spare pool users), listed only
//   other: non-test accounts, listed only
//
// Listing is resumable: each folder is appended to tmp/cleanup-test-data.checkpoint.jsonl
// the moment it is fully listed, and a re-run skips it. Everything printed also goes to
// tmp/cleanup-test-data.log as it happens. A completed --apply renames the checkpoint to
// *.done, so the next run lists afresh.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { createClient } from '@supabase/supabase-js'
import { requireEnv } from './require-env.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const jiti = createJiti(import.meta.url)
const { listFolders, listObjectsUnder, removeStorageUnder } = await jiti.import(join(root, 'tests/storage-cleanup.ts'))

const TMP = join(root, 'tmp')
mkdirSync(TMP, { recursive: true })
const CHECKPOINT = join(TMP, 'cleanup-test-data.checkpoint.jsonl')
const LOG = join(TMP, 'cleanup-test-data.log')
const log = (...parts) => {
  const line = parts.join(' ')
  console.log(line)
  appendFileSync(LOG, line + '\n')
}

/** folder -> { group, files }, for every folder an earlier, interrupted run finished listing. */
const listed = new Map()
if (existsSync(CHECKPOINT)) {
  for (const line of readFileSync(CHECKPOINT, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line)
      listed.set(entry.folder, entry)
    } catch {
      // A line cut off by a kill mid-write: that folder is simply listed again.
    }
  }
}

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const INCLUDE_DELETED_OWNERS = args.includes('--include-deleted-owners')
const INCLUDE_USERS = args.filter((a) => a.startsWith('--include-user=')).map((a) => a.split('=')[1])

const admin = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
})

const FIXED = /^pw-fixed-(primary|secondary)@reelcraft\.local$/
const MINTED = /^pw-test-[0-9a-f-]{36}@reelcraft\.local$/

const users = []
for (let page = 1; ; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
  if (error) throw error
  users.push(...data.users)
  if (data.users.length < 1000) break
}
const byId = new Map(users.map((u) => [u.id, u]))
const kind = (u) => (FIXED.test(u.email ?? '') ? 'fixed' : MINTED.test(u.email ?? '') ? 'minted' : 'other')

const projects = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await admin.from('projects').select('id, user_id, title, created_at').range(from, from + 999)
  if (error) throw error
  projects.push(...data)
  if (data.length < 1000) break
}
const projectIds = new Set(projects.map((p) => p.id))

const range = (dates) => (dates.length ? `${dates.reduce((a, b) => (a < b ? a : b)).slice(0, 16)} → ${dates.reduce((a, b) => (a > b ? a : b)).slice(0, 16)}` : '-')

// A - signed-in minted accounts
const groupA = users.filter((u) => kind(u) === 'minted' && u.last_sign_in_at)
const groupAProjects = projects.filter((p) => groupA.some((u) => u.id === p.user_id))
const kept = users.filter((u) => kind(u) === 'minted' && !u.last_sign_in_at)
const others = users.filter((u) => kind(u) === 'other')

// B, C, D - storage, by top-level prefix. Folder names are listed fresh every run (a
// few calls); the expensive recursive listing of each folder is checkpointed.
const tasks = [] // { folder, group }
for (const u of groupA) tasks.push({ folder: u.id, group: 'A' })
for (const prefix of await listFolders(admin, '')) {
  const owner = byId.get(prefix)
  if (!owner) {
    tasks.push({ folder: prefix, group: 'D' })
    continue
  }
  const k = kind(owner)
  if (k === 'other') continue
  if (k === 'minted' && groupA.includes(owner)) continue // whole prefix goes with the account
  for (const folder of await listFolders(admin, prefix)) {
    if (!projectIds.has(folder)) tasks.push({ folder: `${prefix}/${folder}`, group: k === 'fixed' ? 'B' : 'C' })
  }
}

const pending = tasks.filter((t) => !listed.has(t.folder))
log(`listing ${tasks.length} folder(s): ${tasks.length - pending.length} from checkpoint, ${pending.length} to list`)
let finished = 0
await Promise.all(
  Array.from({ length: 16 }, async () => {
    for (let t = pending.shift(); t; t = pending.shift()) {
      const files = await listObjectsUnder(admin, t.folder)
      const entry = { folder: t.folder, group: t.group, files }
      appendFileSync(CHECKPOINT, JSON.stringify(entry) + '\n')
      listed.set(t.folder, entry)
      if (++finished % 100 === 0) log(`  listed ${finished} more folder(s)`)
    }
  })
)

const filesOf = (group) => tasks.filter((t) => t.group === group).flatMap((t) => listed.get(t.folder).files)
const groupAFiles = filesOf('A')
const groupB = filesOf('B')
const groupC = filesOf('C')
const groupD = filesOf('D')

const show = (paths, max = 15) => {
  for (const p of paths.slice(0, max)) log(`      ${p}`)
  if (paths.length > max) log(`      … ${paths.length - max} more`)
}
const prefixes = (paths, depth) => [...new Set(paths.map((p) => p.split('/').slice(0, depth).join('/')))]

log(`\n${APPLY ? 'APPLY' : 'DRY RUN'} - artifacts bucket + auth + projects\n`)
log(`A  minted accounts orphaned by a killed run: ${groupA.length} (created ${range(groupA.map((u) => u.created_at))})`)
for (const u of groupA) log(`      ${u.id} ${u.email} signed in ${u.last_sign_in_at.slice(0, 16)}`)
log(`   their projects: ${groupAProjects.length}`)
for (const p of groupAProjects) log(`      ${p.id} "${p.title}" ${p.created_at.slice(0, 16)}`)
log(`   their files: ${groupAFiles.length}`)
show(groupAFiles)
log(`B  fixed-user files with no project row: ${groupB.length} objects in ${prefixes(groupB, 2).length} project folders`)
show(groupB)
log(`C  minted-user files with no project row: ${groupC.length} objects in ${prefixes(groupC, 2).length} project folders`)
show(groupC)
log(`D  files whose owner no longer exists (opt-in): ${groupD.length} objects under ${prefixes(groupD, 1).length} user prefixes`)
show(groupD, 40)
log(`kept  never-signed-in minted accounts: ${kept.length} (created ${range(kept.map((u) => u.created_at))})`)
log(`other non-test accounts (never deleted unless named with --include-user):`)
for (const u of others) {
  const n = projects.filter((p) => p.user_id === u.id).length
  log(`      ${u.id} ${u.email} created ${u.created_at.slice(0, 16)} projects=${n}`)
}

if (!APPLY) {
  log('\nNothing deleted. Re-run with --apply (and any opt-in flags) after review.')
  process.exit(0)
}

async function removePaths(paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await admin.storage.from('artifacts').remove(paths.slice(i, i + 100))
    if (error) throw new Error(`remove failed: ${error.message}`)
    if ((i + 100) % 1000 === 0) log(`  removed ${i + 100} of ${paths.length}`)
  }
  return paths.length
}

async function deleteAccount(u) {
  const files = await removeStorageUnder(admin, u.id)
  const { error: pe, count } = await admin.from('projects').delete({ count: 'exact' }).eq('user_id', u.id)
  if (pe) throw pe
  const { error: ue } = await admin.auth.admin.deleteUser(u.id)
  if (ue) throw ue
  log(`deleted ${u.email}: ${count} project(s), ${files} file(s)`)
}

for (const u of groupA) await deleteAccount(u)
log(`B: removed ${await removePaths(groupB)} file(s)`)
log(`C: removed ${await removePaths(groupC)} file(s)`)
if (INCLUDE_DELETED_OWNERS) log(`D: removed ${await removePaths(groupD)} file(s)`)
for (const id of INCLUDE_USERS) {
  const u = others.find((o) => o.id === id)
  if (!u) throw new Error(`--include-user=${id} is not a listed non-test account`)
  await deleteAccount(u)
}

// Done: the listing is now stale, so the next run must not reuse it.
if (existsSync(CHECKPOINT)) renameSync(CHECKPOINT, `${CHECKPOINT}.done`)
log('apply complete')
