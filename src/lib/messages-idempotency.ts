import type { createClient } from '@/lib/supabase/server'
import type { Tables } from '@/lib/database.types'
import { isUniqueViolation } from '@/lib/shot-key'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>
type MessageRow = Tables<'messages'>

export type InsertUserMessageResult =
  | { outcome: 'inserted'; message: MessageRow }
  | { outcome: 'duplicate'; message: MessageRow }
  | { outcome: 'error'; message: string }

/**
 * Inserts a user turn with client_id as the idempotency claim: the browser mints
 * clientId when the user presses send, and a 23505 on (project_id, client_id) means
 * this exact message was already accepted - a sequential retry (turn settled, response
 * lost in transit, client resends) becomes a free no-op instead of a paid duplicate.
 * Detected by Postgres error code, never by matching a message string - see
 * isUniqueViolation. The generations mutex this sits alongside guards concurrency
 * (two tabs, a second turn while one runs), not this sequential-retry case - see
 * docs/decisions.md.
 */
export async function insertUserMessage(params: {
  supabase: SupabaseServerClient
  projectId: string
  content: string
  clientId: string
}): Promise<InsertUserMessageResult> {
  const { supabase, projectId, content, clientId } = params

  const { data: inserted, error: insertError } = await supabase
    .from('messages')
    .insert({ project_id: projectId, role: 'user', content, client_id: clientId })
    .select('*')
    .single()

  if (!insertError) {
    return { outcome: 'inserted', message: inserted }
  }

  if (!isUniqueViolation(insertError)) {
    return { outcome: 'error', message: insertError.message }
  }

  const { data: existing, error: selectError } = await supabase
    .from('messages')
    .select('*')
    .eq('project_id', projectId)
    .eq('client_id', clientId)
    // A completed agent turn persists its assistant reply carrying this same client_id
    // (see migration scope_messages_client_id_to_user_role) - scope to the row that
    // actually collided, or this would error on >1 row once a reply exists.
    .eq('role', 'user')
    .maybeSingle()

  if (selectError || !existing) {
    return { outcome: 'error', message: selectError?.message ?? 'Message row not found after unique violation' }
  }

  return { outcome: 'duplicate', message: existing }
}
