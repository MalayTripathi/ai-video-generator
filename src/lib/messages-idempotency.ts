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
 * Persists a turn's closing reply - the only kind of row that carries `client_id` (the
 * idempotency-lookup match key on a resend, per insertUserMessage's 'duplicate' path
 * above). Always `kind: 'text'` (the DB default) - the closing reply carries no
 * turn-level judgement about what happened; a declined part of a request gets its own
 * message via insertToolActivity's `kind: 'refusal'` instead (see decline in
 * src/lib/prompts/agent.ts and its dispatch in tools.ts), independent of this row.
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
 * Persists one iteration's interstitial prose - text the model said in the SAME response
 * as a tool call, before the turn's closing reply. Without this, only the tool_done/
 * refusal rows for that iteration would survive to reload, and the turn's real narration
 * ("Let me check that shot first...") would be silently lost. Deliberately carries no
 * `client_id` (this is activity within a turn, not its closing reply - same reasoning as
 * insertToolActivity) and defaults `kind` to 'text', identical in shape to
 * regenerate_all_shots' own nested assistant-message insert (shots/logic.ts) - that
 * precedent is why build-agent-messages.ts already matches a turn's closing reply by
 * `client_id` rather than "first text row wins".
 */
export async function insertInterstitialReply(
  supabase: SupabaseServerClient,
  projectId: string,
  content: string
): Promise<MessageRow> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ project_id: projectId, role: 'assistant', content })
    .select('*')
    .single()
  if (error || !data) {
    throw new Error(`Failed to persist interstitial reply: ${error?.message ?? 'no row returned'}`)
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
