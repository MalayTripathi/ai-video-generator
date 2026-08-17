import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ProjectGrid } from './project-grid'
import { Rail } from './rail'
import { TopBar } from './top-bar'
import type { Project } from './types'

export default async function DashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: projects } = await supabase
    .from('projects')
    .select('id, title, status, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  return (
    <div className="flex min-h-0 flex-1">
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar user={user} />
        <ProjectGrid projects={(projects ?? []) as Project[]} />
      </div>
    </div>
  )
}
