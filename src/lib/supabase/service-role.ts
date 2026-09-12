// Service-role client. Bypasses RLS entirely. For platform-initiated writes only
// (e.g. credit_ledger, which has no authenticated write policy by design - see
// CLAUDE.md). Never use this client to serve a user-supplied filter without an
// explicit user_id scope in the query; without one, a caller could read or write
// another user's rows.
import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

export class MissingServiceRoleKeyError extends Error {
  constructor() {
    super(
      'SUPABASE_SERVICE_ROLE_KEY is not set. This client must not fall back to the ' +
        'anon key or the session-scoped server client - fix the environment instead.'
    )
    this.name = 'MissingServiceRoleKeyError'
  }
}

export function createServiceRoleClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    throw new MissingServiceRoleKeyError()
  }
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
