import type { ReactNode } from 'react'
import { createClient } from '@/lib/supabase/server'
import { Rail } from './dashboard/rail'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return (
    <div className="flex h-screen">
      <Rail user={user ?? undefined} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
