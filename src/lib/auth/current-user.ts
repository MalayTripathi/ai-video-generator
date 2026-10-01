import 'server-only'
import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'

/**
 * The signed-in user for this render, verified with the auth server (getUser(), never the
 * cookie alone). Request-memoized: the (app) layout and the page render in parallel and
 * share one call. cache() only memoizes inside a Server Component render, so route handlers
 * and server actions call supabase.auth.getUser() themselves - once per request already.
 */
export const getCurrentUser = cache(async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
})
