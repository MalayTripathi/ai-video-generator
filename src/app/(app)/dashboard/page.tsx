import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ProjectGrid } from './project-grid'
import { SearchButton, TopBar } from './top-bar'
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
    .select('id, title, source_text, status, current_step, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  return (
    <>
      <TopBar
        left={
          <h1 className="text-screen font-medium tracking-tight text-text-primary">
            Your projects
          </h1>
        }
        right={<SearchButton />}
      />
      <ProjectGrid projects={(projects ?? []) as Project[]} />
    </>
  )
}
