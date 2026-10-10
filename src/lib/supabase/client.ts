// Browser client
import { createBrowserClient } from '@supabase/ssr'
import { publicEnv } from '@/lib/config/env'

export function createClient() {
  const { supabaseUrl, supabaseAnonKey } = publicEnv()
  return createBrowserClient(supabaseUrl, supabaseAnonKey)
}