// Service-role client. Bypasses RLS entirely. For platform-initiated writes only
// (e.g. credit_ledger, which has no authenticated write policy by design - see
// CLAUDE.md). Never use this client to serve a user-supplied filter without an
// explicit user_id scope in the query; without one, a caller could read or write
// another user's rows.
import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { serverEnv } from '@/lib/config/env.server'

export function createServiceRoleClient() {
  // serverEnv() throws naming SUPABASE_SERVICE_ROLE_KEY when it is unset - this client
  // never falls back to the anon key or the session-scoped server client.
  const { url, serviceRoleKey } = serverEnv().supabase
  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
