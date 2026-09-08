import type { createClient } from '@/lib/supabase/server'
import type { Tables } from '@/lib/database.types'
import { isUniqueViolation } from '@/lib/shot-key'
import type { ToolName } from '@/lib/config/messages'

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

/**
 * Persists a turn's closing text reply - the only kind of row that carries `client_id`
 * (the idempotency-lookup match key on a resend, per insertUserMessage's 'duplicate'
 * path above). kind defaults to 'text' at the DB level; every caller of this helper is
 * always writing plain conversational content, never activity - see insertToolActivity
 * for that.
 */
export async function insertAssistantReply(
  supabase: SupabaseServerClient,
  projectId: string,
  clientId: string,
  content: string
): Promise<MessageRow> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ project_id: projectId, role: 'assistant', content, client_id: clientId })
    .select('*')
    .single()
  if (error || !data) {
    throw new Error(`Failed to persist assistant reply: ${error?.message ?? 'no row returned'}`)
  }
  return data
}

/**
 * Persists one tool_done/refusal row - what the agent did (or declined to do), not what
 * it said. client_id is deliberately omitted: the duplicate-resend lookup in
 * runAgentTurn does .eq('client_id', clientId).eq('role','assistant').maybeSingle(), and
 * a tool_done/refusal row carrying the same client_id as its turn's closing reply would
 * make that lookup match more than one row and throw. Turn-boundary reconstruction on
 * reload never needs client_id either - it keys off role/kind/created_at ordering (see
 * build-agent-messages.ts). See docs/decisions.md for why shot_key has no FK.
 */
export async function insertToolActivity(params: {
  supabase: SupabaseServerClient
  projectId: string
  kind: 'tool_done' | 'refusal'
  toolName: ToolName | null
  shotKey: string | null
  content: string
}): Promise<MessageRow> {
  const { supabase, projectId, kind, toolName, shotKey, content } = params
  const { data, error } = await supabase
    .from('messages')
    .insert({
      project_id: projectId,
      role: 'assistant',
      kind,
      tool_name: toolName,
      shot_key: shotKey,
      content,
    })
    .select('*')
    .single()
  if (error || !data) {
    throw new Error(`Failed to persist ${kind} activity: ${error?.message ?? 'no row returned'}`)
  }
  return data
}
