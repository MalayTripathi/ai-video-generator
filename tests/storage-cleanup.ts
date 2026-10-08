import type { SupabaseClient } from '@supabase/supabase-js'

// Storage cleanup for test identities only. Every artifact lives under
// `{userId}/{projectId}/...` in the private `artifacts` bucket, and nothing in Postgres
// cascades into Storage - deleting a project row or an auth user leaves its files behind.
// Callers pass a prefix they have already proven belongs to a test identity; this module
// never decides that itself.

const BUCKET = 'artifacts'
// Storage's list() caps a page at 1,000 entries; anything past that needs an offset.
const LIST_PAGE = 1000
const LIST_CONCURRENCY = 8
const REMOVE_BATCH = 100

type Entry = { name: string; id: string | null }

async function listPage(client: SupabaseClient, prefix: string): Promise<Entry[]> {
  const entries: Entry[] = []
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await client.storage.from(BUCKET).list(prefix, { limit: LIST_PAGE, offset })
    if (error) throw new Error(`storage list(${prefix}) failed: ${error.message}`)
    entries.push(...(data as Entry[]))
    if (data.length < LIST_PAGE) return entries
  }
}

/** Every first-level folder name under `prefix` (no recursion), paginated past 1,000. */
export async function listFolders(client: SupabaseClient, prefix: string): Promise<string[]> {
  return (await listPage(client, prefix)).filter((e) => e.id === null).map((e) => e.name)
}

/** Every object path under `prefix`, recursively, paginated past 1,000 per folder. */
export async function listObjectsUnder(client: SupabaseClient, prefix: string): Promise<string[]> {
  const files: string[] = []
  const queue = [prefix]
  const worker = async () => {
    for (let folder = queue.shift(); folder !== undefined; folder = queue.shift()) {
      for (const entry of await listPage(client, folder)) {
        const path = `${folder}/${entry.name}`
        if (entry.id === null) queue.push(path)
        else files.push(path)
      }
    }
  }
  // Workers drain the queue; one that finds it momentarily empty while another is still
  // listing exits early, so keep restarting until nothing is left.
  while (queue.length > 0) await Promise.all(Array.from({ length: LIST_CONCURRENCY }, worker))
  return files
}

/** Removes every object under `prefix` in batches. Returns how many were removed. */
export async function removeStorageUnder(client: SupabaseClient, prefix: string): Promise<number> {
  const paths = await listObjectsUnder(client, prefix)
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const { error } = await client.storage.from(BUCKET).remove(paths.slice(i, i + REMOVE_BATCH))
    if (error) throw new Error(`storage remove under ${prefix} failed: ${error.message}`)
  }
  return paths.length
}
